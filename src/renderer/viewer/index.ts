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

type RecalledRecord = { id: string; sender?: string; msg: any };

const chatListEl = document.querySelector<HTMLElement>("#chats")!;
const messageListEl = document.querySelector<HTMLElement>("#messages")!;

const viewerApi = window.anti_recall_viewer;

debugLog("loaded", {
  hasApi: Boolean(viewerApi?.getRecalledMessages),
  href: location.href,
});

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

function localImageUrl(filePath: string): string {
  const normalized = filePath
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_match, drive: string) => drive.toLowerCase() + ":");
  return `file:///${encodeURIComponent(normalized)
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")}`;
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

  const images = document.createElement("div");
  images.className = "images";
  let imageCount = 0;
  for (const element of Array.isArray(record.msg?.elements) ? record.msg.elements : []) {
    const pic = element?.picElement;
    const source =
      pic?.sourcePath || Object.values(pic?.thumbPath ?? {})[0] || "";
    if (
      typeof source === "string" &&
      /\.(png|jpe?g|gif|webp|bmp)$/i.test(source)
    ) {
      const image = document.createElement("img");
      image.src = localImageUrl(source);
      image.alt = "加载失败";
      image.addEventListener("error", () => image.remove());
      images.appendChild(image);
      imageCount += 1;
    }
  }

  const tail = document.createElement("span");
  tail.className = "tail";
  const time = Number(record.msg?.msgTime ?? 0);
  tail.textContent = time ? new Date(time * 1000).toLocaleString() : "";

  content.textContent = extractText(record.msg) || "不支持的消息类型";
  if (imageCount) bubble.appendChild(images);
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

async function load(): Promise<void> {
  try {
    if (!viewerApi?.getRecalledMessages) {
      throw new Error("查看器 preload API 不可用");
    }

    const records = await viewerApi.getRecalledMessages();
    debugLog("records received", {
      count: records.length,
      sample: records[0],
    });

    if (!records.length) {
      chatListEl.className = "scroll empty";
      chatListEl.textContent = "暂无数据";
      messageListEl.className = "scroll empty";
      messageListEl.textContent = "请先开启存入数据库";
      return;
    }

    const chats = new Map<string, { label: string; kind: string; records: RecalledRecord[] }>();
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

    chatListEl.innerHTML = "";
    chatListEl.className = "scroll";
    let firstButton: HTMLButtonElement | undefined;
    for (const [peerUid, chat] of [...chats.entries()].sort((a, b) => b[1].records.length - a[1].records.length)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "item";
      button.title = `${chat.label}（${peerUid}）`;
      button.innerHTML = '<span class="tag"></span><span class="name"></span><span class="count"></span>';
      (button.children[0] as HTMLElement).textContent = chat.kind;
      (button.children[1] as HTMLElement).textContent = chat.label;
      (button.children[2] as HTMLElement).textContent = String(chat.records.length);
      button.addEventListener("click", () =>
        renderMessages(chat.records, button),
      );
      chatListEl.appendChild(button);
      firstButton ??= button;
    }
    renderMessages([...chats.values()][0].records, firstButton);
  } catch (error) {
    console.error("[Anti-Recall Viewer] load failed:", error);
    chatListEl.className = "scroll empty";
    chatListEl.textContent = "加载失败";
    messageListEl.className = "scroll empty";
    messageListEl.textContent = String(error instanceof Error ? error.message : error);
  }
}

void load();
