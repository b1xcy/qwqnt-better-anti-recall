import { loadRecalledPaged, type PagedRecord } from "../pagedLoader";
import { bindMedia } from "./lightbox";

document.body.innerHTML = `
  <div class="app">
    <section class="panel side">
      <header class="panel-title">会话</header>
      <aside class="scroll" id="chats"><span class="empty">加载中...</span></aside>
    </section>
    <section class="panel main">
      <header class="panel-title">撤回记录</header>
      <div class="scroll" id="messages"><span class="empty">加载中...</span></div>
    </section>
  </div>
`;

function debugLog(message: string, detail?: unknown): void {
  console.log("[Anti-Recall Viewer]", message, detail ?? "");
}

type RecalledRecord = PagedRecord;

const chatListEl = document.querySelector<HTMLElement>("#chats")!;
const messageListEl = document.querySelector<HTMLElement>("#messages")!;

const viewerApi = window.anti_recall_viewer;

debugLog("loaded", {
  hasApi: Boolean(viewerApi?.getRecalledPage),
  href: location.href,
});

bindMedia(messageListEl);

function getChatTypeLabel(msg: any): string {
  const type = Number(msg?.chatType ?? 0);
  return type === 2 ? "群" : type === 1 ? "私" : "临";
}

function getPeerName(msg: any): string {
  return msg?.peerName ?? msg?.peerUin ?? msg?.peerUid ?? "";
}

function getSenderName(msg: any): string {
  return msg?.sendMemberName ?? msg?.sendNickName ?? msg?.sendUserName ?? "";
}

function extractText(msg: any): string {
  const elements = Array.isArray(msg?.elements) ? msg.elements : [];
  return elements
    .map((element: any) => {
      if (element.textElement?.content) return element.textElement.content;
      if (element.faceElement?.faceText)
        return `[表情 ${element.faceElement.faceText}]`;
      if (element.replyElement) return "[引用回复]";
      if (element.picElement) return "[图片]";
      if (element.videoElement) return "[视频]";
      if (element.fileElement)
        return `[文件 ${element.fileElement.fileName ?? ""}]`;
      if (element.arkElement) return "[卡片消息]";
      if (element.multiForwardMsgElement) return "[转发消息]";
      if (element.markdownElement)
        return element.markdownElement.content ?? "[Markdown]";
      return "";
    })
    .join("")
    .trim();
}

function localFileUrl(filePath: string): string {
  const normalized = filePath
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_match, drive: string) => drive.toLowerCase() + ":");
  return `file:///${encodeURIComponent(normalized)
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")}`;
}

const VIDEO_EXT_RE = /\.(mp4|mov|mkv|webm|avi|flv|m4v|3gp|wmv)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * 封面路径。
 *
 * 主进程已经在 annotateForViewer 里解析好写进 thumbPathResolved 了（内存里的
 * 记录是 Map、库里读的是普通对象，形状不一，统一在主进程判掉）。这里保留对
 * 原始 thumbPath 的兜底，只为兼容还没走过新逻辑的记录。
 */
function pickThumb(video: any): string {
  const resolved = video?.thumbPathResolved;
  if (typeof resolved === "string" && resolved) return resolved;
  const raw = video?.thumbPath;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    for (const v of Object.values(raw as Record<string, unknown>))
      if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * 视频本体路径，空串表示当时没下载过。
 *
 * videoFileResolved 是主进程 stat 过的结果，空串是「查过，不存在」这个明确
 * 结论。所以只有这个字段完全缺失时才回退到 filePath —— 那是没走过新逻辑的
 * 老记录，filePath 存在与否未知。
 */
function pickVideoFile(video: any): string {
  const resolved = video?.videoFileResolved;
  if (typeof resolved === "string") return resolved;
  const filePath = video?.filePath;
  return typeof filePath === "string" && VIDEO_EXT_RE.test(filePath)
    ? filePath
    : "";
}

function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 视频封面按钮：有留存文件就能点开播，没有就只当封面看。 */
function buildVideoTile(video: any): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "media-video";

  const file = pickVideoFile(video);
  const thumb = pickThumb(video);
  if (file) button.dataset.video = localFileUrl(file);
  if (thumb) button.dataset.poster = localFileUrl(thumb);
  // 撤回后内核不会删文件，但撤回前没点开过的视频从来就没下载到本地，
  // 而撤回后又没法再向内核索取。所以这里如实说明，不给一个点了转不动的播放键。
  button.title = file ? "点击播放" : "撤回前没有下载过这个视频，无法播放";

  if (thumb) {
    const poster = document.createElement("img");
    poster.src = localFileUrl(thumb);
    poster.alt = "";
    poster.addEventListener("error", () => poster.remove());
    button.appendChild(poster);
  }

  const badge = document.createElement("span");
  badge.className = file ? "media-play" : "media-play is-missing";
  badge.textContent = file ? "▶" : "✕";
  button.appendChild(badge);

  const duration = formatDuration(Number(video?.fileTime ?? 0));
  if (duration) {
    const label = document.createElement("span");
    label.className = "media-duration";
    label.textContent = duration;
    button.appendChild(label);
  }

  return button;
}

function buildEntry(record: RecalledRecord): HTMLElement {
  const item = document.createElement("article");
  item.className = "msg";

  const sender = document.createElement("p");
  sender.className = "sender";
  sender.textContent = getSenderName(record.msg) || "未知发送者";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const content = document.createElement("p");
  content.className = "content";

  const media = document.createElement("div");
  media.className = "media";
  let mediaCount = 0;
  for (const element of Array.isArray(record.msg?.elements) ? record.msg.elements : []) {
    const pic = element?.picElement;
    if (pic) {
      const source =
        pic.sourcePath || Object.values(pic.thumbPath ?? {})[0] || "";
      if (typeof source === "string" && IMAGE_EXT_RE.test(source)) {
        const image = document.createElement("img");
        image.src = localFileUrl(source);
        image.alt = "加载失败";
        image.title = "双击查看大图";
        image.addEventListener("error", () => image.remove());
        media.appendChild(image);
        mediaCount += 1;
      }
      continue;
    }

    if (element?.videoElement) {
      media.appendChild(buildVideoTile(element.videoElement));
      mediaCount += 1;
    }
  }

  const tail = document.createElement("span");
  tail.className = "tail";
  const time = Number(record.msg?.msgTime ?? 0);
  tail.textContent = time ? new Date(time * 1000).toLocaleString() : "";

  content.textContent = extractText(record.msg) || "不支持的消息类型";
  if (mediaCount) bubble.appendChild(media);
  content.appendChild(tail);
  bubble.appendChild(content);
  item.append(sender, bubble);
  return item;
}

function renderMessages(
  records: RecalledRecord[],
  activeChat?: HTMLElement,
): void {
  chatListEl
    .querySelectorAll(".item")
    .forEach((item) => item.classList.toggle("active", item === activeChat));
  messageListEl.innerHTML = "";
  debugLog("render messages", records.length);
  for (const record of [...records].sort(
    (a, b) => Number(b.msg?.msgTime ?? 0) - Number(a.msg?.msgTime ?? 0),
  )) {
    messageListEl.appendChild(buildEntry(record));
  }
}

interface Chat {
  label: string;
  kind: string;
  records: RecalledRecord[];
}

/** 用户选中的会话，跨分页重渲染时保持不变。 */
let selectedPeer: string | null = null;

function groupByChat(records: RecalledRecord[]): Map<string, Chat> {
  const chats = new Map<string, Chat>();
  for (const record of records) {
    const peerUid = String(record.sender ?? record.msg?.peerUid ?? "unknown");
    const chat = chats.get(peerUid) ?? {
      kind: getChatTypeLabel(record.msg),
      label: getPeerName(record.msg) || "未知会话",
      records: [],
    };
    chat.records.push(record);
    chats.set(peerUid, chat);
  }
  return chats;
}

/**
 * 整体重建会话列表。
 *
 * 分页途中会被反复调用，所以要保住两样东西：用户选中的会话，以及两栏的
 * 滚动位置——否则每来一页视图就跳回顶部。
 */
function renderChatList(records: RecalledRecord[], done: boolean): void {
  const chats = groupByChat(records);
  const chatScroll = chatListEl.scrollTop;
  const msgScroll = messageListEl.scrollTop;

  chatListEl.innerHTML = "";
  chatListEl.className = "scroll";

  const ordered = [...chats.entries()].sort(
    (a, b) => b[1].records.length - a[1].records.length,
  );

  // 首页还没选过就默认选第一个，之后锁住不动。
  selectedPeer ??= ordered[0]?.[0] ?? null;

  let selectedButton: HTMLButtonElement | undefined;
  for (const [peerUid, chat] of ordered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "item";
    button.title = `${chat.label}（${peerUid}）`;
    button.innerHTML =
      '<span class="tag"></span><span class="name"></span><span class="count"></span>';
    (button.children[0] as HTMLElement).textContent = chat.kind;
    (button.children[1] as HTMLElement).textContent = chat.label;
    (button.children[2] as HTMLElement).textContent = String(chat.records.length);
    button.addEventListener("click", () => {
      selectedPeer = peerUid;
      renderMessages(chat.records, button);
    });
    chatListEl.appendChild(button);
    if (peerUid === selectedPeer) selectedButton = button;
  }

  if (!done) {
    const loading = document.createElement("span");
    loading.className = "empty";
    loading.textContent = "加载更早的记录...";
    chatListEl.appendChild(loading);
  }

  const selected = selectedPeer ? chats.get(selectedPeer) : undefined;
  if (selected) renderMessages(selected.records, selectedButton);

  chatListEl.scrollTop = chatScroll;
  messageListEl.scrollTop = msgScroll;
}

async function load(): Promise<void> {
  try {
    if (!viewerApi?.getRecalledPage) {
      throw new Error("查看器 preload API 不可用");
    }

    const all = await loadRecalledPaged(viewerApi, (records, done) => {
      debugLog("page", { count: records.length, done });
      if (records.length) renderChatList(records, done);
    });

    if (!all.length) {
      chatListEl.className = "scroll empty";
      chatListEl.textContent = "暂无数据";
      messageListEl.className = "scroll empty";
      messageListEl.textContent = "请先开启存入数据库";
    }
  } catch (error) {
    console.error("[Anti-Recall Viewer] load failed:", error);
    chatListEl.className = "scroll empty";
    chatListEl.textContent = "加载失败";
    messageListEl.className = "scroll empty";
    messageListEl.textContent = String(error instanceof Error ? error.message : error);
  }
}

void load();
