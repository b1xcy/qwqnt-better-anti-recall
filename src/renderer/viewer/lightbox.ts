/**
 * 查看器窗口内的大图层。
 *
 * 本想直接调 QQNT 自带的图片查看器，但 QQ 的 renderer/preload 在 asar 里是
 * 加密的（package.json 里 isPureShell），API 名和 IPC 通道都拿不到；而且撤回
 * 消息的内核记录已经没了，即使拿到通道、若入参要 msgId 也用不上。所以这里
 * 自己实现，不依赖 QQ 的任何内部结构。
 */

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const DRAG_THRESHOLD = 4;

let overlay: HTMLElement | null = null;
let imgEl: HTMLImageElement | null = null;
let videoEl: HTMLVideoElement | null = null;
let noticeEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;

export interface MediaSource {
  kind: "image" | "video";
  /** 图片地址，或视频文件地址；视频没留存到本地时为空。 */
  url: string;
  /** 视频封面，用于文件缺失时至少还能看到一帧。 */
  poster?: string;
}

const IMAGE_HINT = "滚轮缩放 · 拖拽平移 · ← → 切换 · 双击复位 · Esc 关闭";
const VIDEO_HINT = "← → 切换 · Esc 关闭";

/** 打开时快照的媒体列表——分页重渲染不应打断正在看的大图。 */
let sources: MediaSource[] = [];
let index = 0;

let scale = 1;
let offsetX = 0;
let offsetY = 0;

let dragging = false;
let moved = false;
let startX = 0;
let startY = 0;
let startOffsetX = 0;
let startOffsetY = 0;

function applyTransform(): void {
  if (!imgEl) return;
  imgEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

function resetTransform(): void {
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  applyTransform();
}

function build(): void {
  if (overlay) return;

  overlay = document.createElement("div");
  overlay.className = "lightbox";

  const bar = document.createElement("div");
  bar.className = "lightbox-bar";
  countEl = document.createElement("span");
  countEl.className = "lightbox-count";
  hintEl = document.createElement("span");
  hintEl.className = "lightbox-hint";
  hintEl.textContent = IMAGE_HINT;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "lightbox-close";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", close);
  bar.append(countEl, hintEl, closeBtn);

  imgEl = document.createElement("img");
  imgEl.alt = "";
  imgEl.draggable = false;

  videoEl = document.createElement("video");
  videoEl.controls = true;
  videoEl.preload = "metadata";
  videoEl.hidden = true;
  // 点视频不该关掉遮罩，否则一碰进度条就整个关了。
  videoEl.addEventListener("click", (e) => e.stopPropagation());
  videoEl.addEventListener("dblclick", (e) => e.stopPropagation());
  videoEl.addEventListener("error", () => {
    if (!videoEl?.hidden)
      showNotice("这个视频无法播放，可能是 QQ 用了浏览器不支持的编码（如 H.265）。");
  });

  noticeEl = document.createElement("p");
  noticeEl.className = "lightbox-notice";
  noticeEl.hidden = true;

  prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "lightbox-nav prev";
  prevBtn.textContent = "‹";
  prevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    step(-1);
  });

  nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "lightbox-nav next";
  nextBtn.textContent = "›";
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    step(1);
  });

  overlay.append(bar, prevBtn, imgEl, videoEl, noticeEl, nextBtn);
  document.body.appendChild(overlay);

  // 每次按下都重置拖拽标记。挂在 overlay 上（事件从 img 冒泡上来），
  // 这样「直接点遮罩」也会走到，不会读到上一次拖拽留下的旧值。
  overlay.addEventListener("pointerdown", () => {
    moved = false;
  });

  // 点遮罩空白处关闭；拖拽结束的那一下不算点击。
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && !moved) close();
  });

  overlay.addEventListener("wheel", onWheel, { passive: false });
  imgEl.addEventListener("pointerdown", onPointerDown);
  imgEl.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    resetTransform();
  });
}

/** 以光标为锚点缩放：光标下的那个点保持不动。 */
function onWheel(e: WheelEvent): void {
  if (!imgEl) return;
  e.preventDefault();

  const rect = imgEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const px = e.clientX - cx;
  const py = e.clientY - cy;

  const next = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)),
  );
  const ratio = next / scale;
  offsetX = px - (px - offsetX) * ratio;
  offsetY = py - (py - offsetY) * ratio;
  scale = next;
  applyTransform();
}

function onPointerDown(e: PointerEvent): void {
  if (!imgEl || e.button !== 0) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  startOffsetX = offsetX;
  startOffsetY = offsetY;
  imgEl.classList.add("dragging");
  imgEl.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent): void => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
      moved = true;
    offsetX = startOffsetX + dx;
    offsetY = startOffsetY + dy;
    applyTransform();
  };

  const onUp = (ev: PointerEvent): void => {
    dragging = false;
    imgEl?.classList.remove("dragging");
    imgEl?.releasePointerCapture(ev.pointerId);
    imgEl?.removeEventListener("pointermove", onMove);
    imgEl?.removeEventListener("pointerup", onUp);
    imgEl?.removeEventListener("pointercancel", onUp);
    // moved 留到下次 pointerdown 再清：浏览器的 click 在 pointerup 之后才到，
    // 这里清掉的话拖拽松手那一下会被当成点击而关闭大图。
  };

  imgEl.addEventListener("pointermove", onMove);
  imgEl.addEventListener("pointerup", onUp);
  imgEl.addEventListener("pointercancel", onUp);
}

function onKeyDown(e: KeyboardEvent): void {
  if (!overlay?.classList.contains("open")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    step(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    step(1);
  }
}

function step(delta: number): void {
  show(index + delta);
}

function showNotice(text: string): void {
  if (!noticeEl) return;
  noticeEl.textContent = text;
  noticeEl.hidden = false;
}

function show(nextIndex: number): void {
  if (!imgEl || !videoEl || !countEl || !noticeEl) return;
  if (nextIndex < 0 || nextIndex >= sources.length) return;

  index = nextIndex;
  const media = sources[index];

  // 切走时一定要停掉上一个视频，否则关掉遮罩后声音还在放。
  videoEl.pause();
  videoEl.removeAttribute("src");
  noticeEl.hidden = true;

  if (media.kind === "video" && media.url) {
    imgEl.hidden = true;
    imgEl.src = "";
    videoEl.hidden = false;
    if (media.poster) videoEl.poster = media.poster;
    else videoEl.removeAttribute("poster");
    videoEl.src = media.url;
    void videoEl.play().catch(() => {
      // 自动播放被拦就算了，用户点一下 controls 就行。
    });
  } else {
    videoEl.hidden = true;
    imgEl.hidden = false;
    // 视频没留存下来时退化成看封面；连封面都没有就只剩提示。
    const fallback = media.kind === "video" ? (media.poster ?? "") : media.url;
    if (fallback) imgEl.src = fallback;
    else imgEl.removeAttribute("src");
    if (media.kind === "video")
      showNotice("撤回前没有下载过这个视频，只能看到封面。");
    resetTransform();
  }

  if (hintEl)
    hintEl.textContent = videoEl.hidden ? IMAGE_HINT : VIDEO_HINT;
  countEl.textContent = `${index + 1} / ${sources.length}`;
  if (prevBtn) prevBtn.hidden = index === 0;
  if (nextBtn) nextBtn.hidden = index === sources.length - 1;
}

export function open(list: MediaSource[], startIndex: number): void {
  if (!list.length) return;
  build();
  sources = [...list];
  overlay?.classList.add("open");
  show(Math.min(Math.max(0, startIndex), sources.length - 1));
}

export function close(): void {
  overlay?.classList.remove("open");
  if (imgEl) imgEl.src = "";
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
  }
  sources = [];
}

/** 图片和视频封面按 DOM 顺序排在一起，左右键就能在一条消息的媒体间连着翻。 */
const MEDIA_SELECTOR = ".media > img, .media > .media-video";

function readMedia(el: Element): MediaSource {
  if (el instanceof HTMLImageElement) return { kind: "image", url: el.src };
  return {
    kind: "video",
    url: el.getAttribute("data-video") ?? "",
    poster: el.getAttribute("data-poster") ?? undefined,
  };
}

function openFrom(container: HTMLElement, target: Element): void {
  const all = [...container.querySelectorAll(MEDIA_SELECTOR)];
  const at = all.indexOf(target);
  if (at === -1) return;
  open(all.map(readMedia), at);
}

/**
 * 用事件委托：分页会不断重建消息列表，逐个元素绑监听会漏掉后来的。
 *
 * 图片沿用双击（避免和选词冲突），视频封面本身是个按钮，单击就播。
 */
export function bindMedia(container: HTMLElement): void {
  container.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      ".media-video",
    );
    if (!button) return;
    e.preventDefault();
    openFrom(container, button);
  });

  container.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement | null;
    // 视频走上面的单击分支，这里别再开一次。
    if (target?.closest(".media-video")) return;
    if (!(target instanceof HTMLImageElement)) return;

    e.preventDefault();
    getSelection()?.removeAllRanges();
    openFrom(container, target);
  });

  document.addEventListener("keydown", onKeyDown);
}
