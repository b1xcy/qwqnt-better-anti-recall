import fs from "node:fs";
import path from "node:path";

/**
 * 撤回视频的封面路径处理。
 *
 * 起因是一个我们自己造的 bug：内核给的 `videoElement.thumbPath` 是 Map，
 * 而 `JSON.stringify(new Map())` 得到的是 `{}`。所以撤回记录一落盘，封面路径
 * 就没了；重启 QQ 后聊天重建、插件从分片 JSON 取回记录去补气泡，补进去的是
 * 一个空 thumbPath，渲染层拿不到封面 → 气泡只剩占位头像。
 *
 * 实测（通过一轮临时探测确认）：
 *   - 内核撤回时**不删**任何媒体文件，封面和已下载的视频都还在原地；
 *   - 封面文件名用的是 **videoMd5**，不是 thumbMd5：
 *     `<...>/Video/<yyyy-MM>/Thumb/<videoMd5>_0.png`
 *   - 视频本体在 `<...>/Video/<yyyy-MM>/Ori/<videoMd5>.mp4`，只有用户点开过
 *     才存在（transferStatus 0 -> 4）。
 *
 * 所以修法是两层：存盘前把 Map 转成普通对象（新记录不再丢），读回时若封面
 * 路径已经丢了就用 videoMd5 反推并 stat 确认（救已经存坏的旧记录）。
 * 全程不复制任何文件——文件本来就在原地。
 */

/** QQ 缩略图目录名，与 Ori 同级。 */
const THUMB_DIR = "Thumb";

/** 内核按尺寸档位查缩略图；跟现有 picElement 的处理保持一致。 */
const THUMB_SPECS = [0, 198, 720];

/** 小于这个字节数视为占位/下载中，不当作可用文件。 */
const MIN_USEFUL_BYTES = 128;

function isUsableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > MIN_USEFUL_BYTES;
  } catch {
    return false;
  }
}

/** thumbPath 可能是 Map、普通对象或字符串，取第一个非空值。 */
function firstThumbValue(thumbPath: unknown): string {
  if (typeof thumbPath === "string") return thumbPath;
  if (thumbPath instanceof Map) {
    for (const v of thumbPath.values()) if (typeof v === "string" && v) return v;
    return "";
  }
  if (thumbPath && typeof thumbPath === "object") {
    for (const v of Object.values(thumbPath as Record<string, unknown>))
      if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * 由 filePath + videoMd5 反推封面路径。
 *
 * filePath 形如 `<root>/Video/2026-08/Ori/<videoMd5>.mp4`，封面在同级的
 * `Thumb/<videoMd5>_0.png`。filePath 是普通字符串、能活过 JSON，所以即使
 * thumbPath 已经被序列化毁掉，也还能从它推回去。
 */
function deriveThumbCandidates(video: any): string[] {
  const filePath: string =
    typeof video?.filePath === "string" ? video.filePath : "";
  if (!filePath) return [];

  const oriDir = path.dirname(filePath);
  const thumbDir = path.join(path.dirname(oriDir), THUMB_DIR);

  const seeds: string[] = [];
  // videoMd5 是实测命中的那个；thumbMd5 留作兜底（实测没命中过，但很便宜）。
  for (const key of ["videoMd5", "thumbMd5"]) {
    const v = video?.[key];
    if (typeof v === "string" && v) seeds.push(v);
  }
  // fileName 形如 <videoMd5>.mp4，去掉扩展名等价于 videoMd5。
  const fileName: string =
    typeof video?.fileName === "string" ? video.fileName : "";
  if (fileName) seeds.push(fileName.replace(/\.[a-z0-9]+$/i, ""));

  const out: string[] = [];
  for (const seed of seeds) {
    for (const name of [`${seed}_0.png`, `${seed}.png`, `${seed}_0.jpg`]) {
      const full = path.join(thumbDir, name);
      if (!out.includes(full)) out.push(full);
    }
  }
  return out;
}

/** 返回一个确实存在于磁盘上的封面绝对路径，找不到就返回空串。 */
export function resolveThumbPath(video: any): string {
  const existing = firstThumbValue(video?.thumbPath);
  if (existing && isUsableFile(existing)) return existing;
  for (const cand of deriveThumbCandidates(video)) {
    if (isUsableFile(cand)) return cand;
  }
  return "";
}

/** 视频本体是否已经落盘（用户点开看过）。 */
export function resolveVideoFile(video: any): string {
  const p = typeof video?.filePath === "string" ? video.filePath : "";
  return p && isUsableFile(p) ? p : "";
}

function eachVideoElement(msg: any): any[] {
  if (!Array.isArray(msg?.elements)) return [];
  return msg.elements.map((el: any) => el?.videoElement).filter(Boolean);
}

/**
 * 落盘前调用：返回一份 thumbPath 已换成普通对象的记录副本。
 *
 * 这是根治那个 bug 的地方——普通对象能活过 JSON.stringify。
 *
 * **必须返回副本而不是就地改**：调用点传进来的 record 就是 msgFlowCache 里的
 * 那一份，也就是内核原件。就地把 Map 换成普通对象，等于把当前正在显示的气泡
 * 的 thumbPath 给拆了。所以这里只克隆需要动的那几层（record → msg → elements
 * → videoElement），其余字段仍然共享引用，代价可以忽略。
 */
export function normalizeForStorage<T>(record: T): T {
  const msg = (record as any)?.msg;
  if (!Array.isArray(msg?.elements)) return record;
  if (!msg.elements.some((el: any) => el?.videoElement)) return record;

  const elements = msg.elements.map((el: any) => {
    const video = el?.videoElement;
    if (!video) return el;

    const resolved = resolveThumbPath(video);
    const value = resolved || firstThumbValue(video.thumbPath);
    if (!value) return el;

    const plain: Record<string, string> = {};
    for (const spec of THUMB_SPECS) plain[String(spec)] = value;
    return { ...el, videoElement: { ...video, thumbPath: plain } };
  });

  return { ...(record as any), msg: { ...msg, elements } };
}

/**
 * 补回内核期望的形态：thumbPath 是 Map。
 *
 * 用在「把撤回记录塞回灰条」那条路上——渲染层按内核的约定读这个字段，
 * 现有 picElement 的恢复逻辑也是塞一个 Map 进去。
 */
export function restoreForKernel(msg: any): void {
  for (const video of eachVideoElement(msg)) {
    const resolved = resolveThumbPath(video);
    if (!resolved) continue;
    video.thumbPath = new Map<number, string>(
      THUMB_SPECS.map((spec) => [spec, resolved]),
    );
  }
}

/**
 * 给查看器用的形态：写成普通字符串字段。
 *
 * 查看器跨 IPC 拿到的记录来源不一（内存里的是 Map、库里读的是普通对象），
 * 让它自己猜形状很容易再踩一次同样的坑，干脆在主进程里定好。
 */
export function annotateForViewer(msg: any): void {
  for (const video of eachVideoElement(msg)) {
    const thumb = resolveThumbPath(video);
    if (thumb) video.thumbPathResolved = thumb;
    // 空串也要写：查看器靠它区分「没下载」和「没查过」。
    video.videoFileResolved = resolveVideoFile(video);
  }
}
