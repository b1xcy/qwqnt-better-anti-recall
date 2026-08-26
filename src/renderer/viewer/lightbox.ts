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
let countEl: HTMLElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;

/** 打开时快照的图片地址列表——分页重渲染不应打断正在看的大图。 */
let sources: string[] = [];
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
  const hint = document.createElement("span");
  hint.className = "lightbox-hint";
  hint.textContent = "滚轮缩放 · 拖拽平移 · ← → 切图 · 双击复位 · Esc 关闭";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "lightbox-close";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", close);
  bar.append(countEl, hint, closeBtn);

  imgEl = document.createElement("img");
  imgEl.alt = "";
  imgEl.draggable = false;

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

  overlay.append(bar, prevBtn, imgEl, nextBtn);
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

function show(nextIndex: number): void {
  if (!imgEl || !countEl) return;
  if (nextIndex < 0 || nextIndex >= sources.length) return;

  index = nextIndex;
  imgEl.src = sources[index];
  resetTransform();
  countEl.textContent = `${index + 1} / ${sources.length}`;
  if (prevBtn) prevBtn.hidden = index === 0;
  if (nextBtn) nextBtn.hidden = index === sources.length - 1;
}

export function open(list: string[], startIndex: number): void {
  if (!list.length) return;
  build();
  sources = [...list];
  overlay?.classList.add("open");
  show(Math.min(Math.max(0, startIndex), sources.length - 1));
}

export function close(): void {
  overlay?.classList.remove("open");
  if (imgEl) imgEl.src = "";
  sources = [];
}

/**
 * 用事件委托绑双击：分页会不断重建消息列表，逐个 img 绑监听会漏掉后来的。
 */
export function bindDoubleClick(container: HTMLElement): void {
  container.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLImageElement)) return;

    e.preventDefault();
    getSelection()?.removeAllRanges();

    const all = [...container.querySelectorAll<HTMLImageElement>(".images img")];
    const at = all.indexOf(target);
    if (at === -1) return;
    open(
      all.map((x) => x.src),
      at,
    );
  });

  document.addEventListener("keydown", onKeyDown);
}
