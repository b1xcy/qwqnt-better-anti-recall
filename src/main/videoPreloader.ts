import fs from "node:fs";
import crypto from "node:crypto";
import type { BrowserWindow } from "electron";

/**
 * 视频预下载：新视频消息到达时替用户提前触发内核下载，
 * 让文件在撤回发生前就完整落盘（内核撤回时不删媒体文件，见 videoMedia.ts）。
 *
 * 调用通道：session 级 '-ipc-message' → Electron 路由
 *   → ipcMain.emit("RM_IPCFROM_RENDERER<n>", event, callbackId, env)
 *   env = [ {type:"request", callbackId:UUID, eventName:"ntApi", peerId:1},
 *           {cmdName:"nodeIKernelMsgService/downloadRichMedia",
 *            cmdType:"invoke", payload:[{getReq}, null]} ]
 *
 * 派发不新建事件对象——借用最近一次真实调用的事件（持续刷新，始终新鲜）。
 * 应答会带着我们的 callbackId 回到 AIO 窗口，AIO 不认识就忽略，无副作用。
 *
 * 注意：wc 级 '-ipc-message' 是 Electron 的 webFrame 应答路由，信封形状不同，
 * 直接调用会抛 Spread 错误——必须挂在 session 级（wc 级没有时兜底）。
 */

export interface VideoPreloadOptions {
  debugLog: (...args: unknown[]) => void;
  /** 运行时开关（读配置，实时生效） */
  isEnabled: () => boolean;
  /** 单文件大小上限（字节），超过不预下载 */
  maxBytes: () => number;
}

interface VideoTask {
  msgId: string;
  chatType: number;
  peerUid: string;
  elementId: string;
  filePath: string;
  fileSize: number;
}

interface DispatcherRef {
  fn: (...args: unknown[]) => unknown;
  ev: unknown;
  ch: string;
  at: number;
}

const ATTEMPT_DELAY_MS = 4000; // 视频到达后先等 4s（与内核自己的缩略图下载错开）
const MIN_INTERVAL_MS = 3000;  // 队列串行节奏，避免突发
const EVENT_MAX_AGE_MS = 15000; // 借用的事件太旧就不再用
const FILE_MIN_BYTES = 128;

export function createVideoPreloader(opts: VideoPreloadOptions) {
  const { debugLog } = opts;
  const queue: VideoTask[] = [];
  const queued = new Set<string>();
  const failed = new Set<string>();
  let dispatcher: DispatcherRef | null = null;
  let lastDispatchAt = 0;

  /** 在 session（或 wc 兜底）级 '-ipc-message' 上挂捕获器，持续刷新可用的事件+通道 */
  function attach(window: BrowserWindow): void {
    try {
      const wc = window.webContents;
      const levels: Array<{ ev: Record<string, unknown>; tag: string }> = [];
      if (wc.session?._events && (wc.session._events as any)["-ipc-message"])
        levels.push({ ev: wc.session._events as any, tag: "session" });
      if (wc._events && (wc._events as any)["-ipc-message"])
        levels.push({ ev: wc._events as any, tag: "wc" });
      for (const level of levels) {
        const key = "__antiRecallPreloadHook";
        if ((level.ev as any)[key]) continue;
        const orig = (level.ev as any)["-ipc-message"];
        const wrapped = function (this: unknown, ...args: unknown[]) {
          try {
            // args 形状（Electron 路由）：(event, channel, argsArray)
            const ch = args[1];
            if (typeof ch === "string" && ch.startsWith("RM_IPCFROM_RENDERER")) {
              const inner = args[2];
              if (dispatcher === null || dispatcher.fn !== orig) {
                dispatcher = { fn: orig, ev: args[0], ch, at: Date.now() };
              } else {
                dispatcher.ev = args[0];
                dispatcher.ch = ch;
                dispatcher.at = Date.now();
              }
            }
          } catch (e) {}
          return orig.apply(this, args);
        };
        (level.ev as any)[key] = true;
        (level.ev as any)["-ipc-message"] = wrapped;
        debugLog("[VideoPreload] dispatcher hook installed on", level.tag, "window", window.id);
      }
    } catch (e) {
      debugLog("[VideoPreload] attach err:", e);
    }
  }

  function dispatch(task: VideoTask): void {
    if (!dispatcher) return;
    if (Date.now() - dispatcher.at > EVENT_MAX_AGE_MS) return; // 事件太旧，等下一次真实流量刷新
    const getReq = {
      fileModelId: "0",
      downSourceType: 0,
      triggerType: 0,
      msgId: task.msgId,
      chatType: task.chatType,
      peerUid: task.peerUid,
      elementId: task.elementId,
      thumbSize: 0,
      downloadType: 1,
      filePath: task.filePath,
    };
    const envelope = [
      {
        type: "request",
        callbackId: crypto.randomUUID(),
        eventName: "ntApi",
        peerId: 1,
      },
      {
        cmdName: "nodeIKernelMsgService/downloadRichMedia",
        cmdType: "invoke",
        payload: [{ getReq }, null],
      },
    ];
    (dispatcher.fn as any).call(null, dispatcher.ev, dispatcher.ch, envelope);
    lastDispatchAt = Date.now();
  }

  function processQueue(): void {
    if (!opts.isEnabled()) return;
    if (queue.length === 0) return;
    if (!dispatcher || Date.now() - dispatcher.at > EVENT_MAX_AGE_MS) return;
    if (Date.now() - lastDispatchAt < MIN_INTERVAL_MS) return;

    const task = queue.shift();
    if (!task) return;
    try {
      // 到点再查一次磁盘：可能内核已经自己下好了
      let skip = false;
      try {
        const st = fs.existsSync(task.filePath) ? fs.statSync(task.filePath) : null;
        if (st && st.isFile() && st.size > FILE_MIN_BYTES) {
          debugLog("[VideoPreload] skip (already on disk):", task.msgId, st.size);
          skip = true;
        }
      } catch (e) {}
      if (!skip) {
        dispatch(task);
        debugLog(
          "[VideoPreload] dispatched:",
          task.msgId,
          task.fileSize + "B",
          task.filePath,
        );
      }
    } catch (e) {
      failed.add(task.msgId);
      debugLog("[VideoPreload] dispatch err:", task.msgId, e);
    }
  }

  function handleMsg(msg: any): void {
    try {
      if (!opts.isEnabled()) return;
      if (!msg || !Array.isArray(msg.elements)) return;
      const el = msg.elements.find((e: any) => e && e.videoElement);
      if (!el) return;
      const v = el.videoElement;
      const msgId = String(msg.msgId);
      if (queued.has(msgId) || failed.has(msgId)) return;

      // maxBytes() 为 0 表示不限制大小
      const max = opts.maxBytes();
      const fileSize = Number(v.fileSize || 0);
      if (max > 0 && fileSize > max) {
        debugLog(
          "[VideoPreload] skip (over threshold):",
          msgId,
          fileSize,
          ">",
          max,
        );
        failed.add(msgId);
        return;
      }
      const filePath = typeof v.filePath === "string" ? v.filePath : "";
      if (!filePath) {
        debugLog("[VideoPreload] skip (no filePath):", msgId);
        failed.add(msgId);
        return;
      }

      queued.add(msgId);
      queue.push({
        msgId,
        chatType: Number(msg.chatType || 0),
        peerUid: String(msg.peerUid || ""),
        elementId: String(el.elementId || ""),
        filePath,
        fileSize,
      });
      debugLog("[VideoPreload] queued:", msgId, fileSize + "B");
    } catch (e) {
      debugLog("[VideoPreload] handleMsg err:", e);
    }
  }

  const worker = setInterval(function () {
    try {
      processQueue();
      // 队列保留最近 500 条的去重标记，防无限增长
      if (queued.size > 500) {
        for (const id of queued) {
          queued.delete(id);
          if (queued.size <= 400) break;
        }
      }
      if (failed.size > 500) failed.clear();
    } catch (e) {}
  }, 1000);

  function dispose(): void {
    clearInterval(worker);
  }

  return { attach, handleMsg, dispose };
}

export type VideoPreloader = ReturnType<typeof createVideoPreloader>;
