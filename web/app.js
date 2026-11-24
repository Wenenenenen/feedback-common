// 主线程：文件选择、导航、Canvas 渲染与叠加框、PNG 下载。
// 所有解析/重建都在 worker.js 中完成。
const $ = (id) => document.getElementById(id);

const els = {
  openBtn: $('openBtn'), exportBtn: $('exportBtn'), themeBtn: $('themeBtn'),
  dropzone: $('dropzone'), fileInput: $('fileInput'),
  stageInner: $('stageInner'), frameCanvas: $('frameCanvas'), overlayCanvas: $('overlayCanvas'),
  pillFrame: $('pillFrame'), pillState: $('pillState'),
  navCard: $('navCard'), scrub: $('scrub'), frameInput: $('frameInput'), frameTotal: $('frameTotal'),
  firstBtn: $('firstBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), lastBtn: $('lastBtn'),
  strip: $('strip'),
  fileCard: $('fileCard'), stFrames: $('stFrames'), stValid: $('stValid'), stBad: $('stBad'), stCanvas: $('stCanvas'),
  truncAlert: $('truncAlert'), truncOff: $('truncOff'), truncReason: $('truncReason'),
  frameCard: $('frameCard'),
  kvIndex: $('kvIndex'), kvSeq: $('kvSeq'), kvBase: $('kvBase'), kvKind: $('kvKind'),
  kvOffset: $('kvOffset'), kvLen: $('kvLen'), kvAnchor: $('kvAnchor'),
  overlayToggle: $('overlayToggle'), badFrameAlert: $('badFrameAlert'), badFrameText: $('badFrameText'),
  rectCard: $('rectCard'), moveList: $('moveList'), dirtyCard: $('dirtyCard'), dirtyList: $('dirtyList'),
  toast: $('toast'),
};

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let summary = null;
let currentIndex = -1;
let requestSeq = 0;
let pendingSeek = null;
let imgCtx = els.frameCanvas.getContext('2d');
let ovCtx = els.overlayCanvas.getContext('2d');

// ---- 主题（记忆在 localStorage，失败则静默） ----
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}
try { applyTheme(localStorage.getItem('cxr-theme')); } catch { /* 无存储 */ }
els.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cxr-theme', next); } catch { /* 忽略 */ }
  drawOverlay();
});

// ---- 提示条 ----
let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

// ---- 文件打开 ----
async function openFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  worker.postMessage({ type: 'open', buffer: buf }, [buf]);
  toast('正在解析…');
}
els.openBtn.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => openFile(els.fileInput.files[0]));
['dragover', 'dragenter'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('dragging'); }),
);
['dragleave', 'drop'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('dragging'); }),
);
els.dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) openFile(f);
});
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});

// ---- Worker 消息 ----
worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'opened') {
    summary = msg.summary;
    onOpened();
    return;
  }
  if (msg.type === 'open-failed') {
    els.dropzone.hidden = false;
    els.stageInner.hidden = true;
    els.navCard.hidden = true;
    els.fileCard.hidden = true;
    els.frameCard.hidden = true;
    els.rectCard.hidden = true;
    els.dirtyCard.hidden = true;
    els.exportBtn.disabled = true;
    summary = null;
    toast(`无法解析：${msg.message}${msg.offset !== null ? `（偏移 ${msg.offset}）` : ''}`);
    return;
  }
  if (msg.type === 'frame') {
    renderFrame(msg);
    return;
  }
  if (msg.type === 'png') {
    const blob = new Blob([msg.bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `frame-${String(msg.index).padStart(5, '0')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出帧 ${msg.index} 的 PNG（原始像素，无叠加）`);
    return;
  }
  if (msg.type === 'error') {
    toast(msg.message);
  }
};

function onOpened() {
  const frames = summary.frames;
  els.dropzone.hidden = true;
  els.stageInner.hidden = false;
  els.navCard.hidden = false;
  els.fileCard.hidden = false;
  els.frameCard.hidden = false;
  els.rectCard.hidden = false;
  els.dirtyCard.hidden = false;
  els.exportBtn.disabled = false;

  const validCount = frames.filter((f) => f.valid).length;
  els.stFrames.textContent = frames.length;
  els.stValid.textContent = validCount;
  els.stBad.textContent = frames.length - validCount;
  els.stCanvas.textContent = `${summary.width}×${summary.height}`;
  els.scrub.max = String(frames.length - 1);
  els.frameInput.max = String(frames.length - 1);
  els.frameTotal.textContent = `/ ${frames.length - 1}`;

  if (summary.truncated) {
    els.truncAlert.hidden = false;
    els.truncOff.textContent = `偏移 0x${summary.truncated.offset.toString(16)} (${summary.truncated.offset})`;
    els.truncReason.textContent = summary.truncated.reason;
  } else {
    els.truncAlert.hidden = true;
  }

  buildStrip();
  const firstValid = frames.findIndex((f) => f.valid);
  seek(firstValid >= 0 ? firstValid : 0);
  toast(`解析完成：${frames.length} 帧，${validCount} 帧可重建`);
}

// ---- 帧类型条带 ----
function buildStrip() {
  els.strip.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const f of summary.frames) {
    const cell = document.createElement('button');
    cell.className =
      'strip-cell' + (f.key ? ' keyframe' : '') + (!f.valid ? ' invalid' : '');
    cell.title = `帧 ${f.index}${f.key ? ' · 关键帧' : ''}${f.valid ? '' : ' · ' + (f.reason || '无效')}`;
    cell.addEventListener('click', () => seek(f.index));
    frag.appendChild(cell);
  }
  els.strip.appendChild(frag);
}

function markStrip(index) {
  [...els.strip.children].forEach((c, i) => c.classList.toggle('current', i === index));
}

// ---- 跳帧 ----
function seek(index) {
  if (!summary) return;
  const n = summary.frames.length;
  index = Math.max(0, Math.min(n - 1, index));
  currentIndex = index;
  els.scrub.value = String(index);
  els.frameInput.value = String(index);
  markStrip(index);
  updateFrameMeta(summary.frames[index]);

  const id = ++requestSeq;
  pendingSeek = id;
  if (summary.frames[index].valid) {
    worker.postMessage({ type: 'decode', index, requestId: id });
  } else {
    // 无效帧：保留上一张画面，只更新信息面板
    pendingSeek = null;
  }
}

function nearestValid(from, dir) {
  const frames = summary.frames;
  let i = from;
  while (i >= 0 && i < frames.length) {
    if (frames[i].valid) return i;
    i += dir;
  }
  return from;
}

els.scrub.addEventListener('input', () => seek(Number(els.scrub.value)));
els.frameInput.addEventListener('change', () => seek(Number(els.frameInput.value) || 0));
els.firstBtn.addEventListener('click', () => seek(nearestValid(0, 1)));
els.lastBtn.addEventListener('click', () => seek(nearestValid(summary.frames.length - 1, -1)));
els.prevBtn.addEventListener('click', () => seek(nearestValid(currentIndex - 1, -1)));
els.nextBtn.addEventListener('click', () => seek(nearestValid(currentIndex + 1, 1)));
document.addEventListener('keydown', (e) => {
  if (!summary || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') seek(nearestValid(currentIndex - 1, -1));
  if (e.key === 'ArrowRight') seek(nearestValid(currentIndex + 1, 1));
  if (e.key === 'Home') seek(nearestValid(0, 1));
  if (e.key === 'End') seek(nearestValid(summary.frames.length - 1, -1));
});

// ---- 帧元数据面板 ----
function updateFrameMeta(f) {
  els.kvIndex.textContent = String(f.index);
  els.kvSeq.textContent = f.seq === null ? '—' : String(f.seq);
  els.kvBase.textContent =
    f.base === null ? '—' : f.base === 0xffffffff ? '0xffffffff（关键帧）' : String(f.base);
  els.kvKind.textContent = f.key ? '关键帧' : '差量帧';
  els.kvOffset.textContent = `0x${f.offset.toString(16)} (${f.offset})`;
  els.kvLen.textContent = String(f.length);
  els.kvAnchor.textContent = f.anchorIndex >= 0 ? String(f.anchorIndex) : '无（链已中断）';

  els.pillFrame.textContent = `帧 ${f.index} · seq=${f.seq ?? '—'}`;
  els.pillState.className = 'pill ' + (f.valid ? (f.key ? 'key' : 'good') : 'bad');
  els.pillState.textContent = f.valid
    ? f.key ? '关键帧' : '有效差量'
    : '坏帧 / 停用';

  if (f.valid) {
    els.badFrameAlert.hidden = true;
  } else {
    els.badFrameAlert.hidden = false;
    els.badFrameText.innerHTML =
      `该帧不参与重建，差量链从偏移 <span class="mono">0x${f.offset.toString(16)}</span> 起中断。<br>` +
      `原因：${f.reason ?? '未知'}<br>后续差量停用，直到出现合法关键帧。`;
  }

  fillRectList(els.moveList, f.moves, 'move', (m) =>
    `源 (${m[0]}, ${m[1]}) ${m[2]}×${m[3]} → 目的 (${m[4]}, ${m[5]})`);
  fillRectList(els.dirtyList, f.dirty, 'dirty', (d) =>
    `(${d[0]}, ${d[1]}) ${d[2]}×${d[3]}`);
}

function fillRectList(container, rects, kind, format) {
  container.innerHTML = '';
  if (!rects || rects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rect-empty';
    empty.textContent = '无';
    container.appendChild(empty);
    return;
  }
  for (let i = 0; i < rects.length; i++) {
    const item = document.createElement('div');
    item.className = `rect-item ${kind}`;
    const title = document.createElement('div');
    title.className = 'rt';
    title.textContent = `${kind === 'move' ? '移动' : '脏块'} #${i}`;
    const val = document.createElement('div');
    val.className = 'rv mono';
    val.textContent = format(rects[i]);
    item.append(title, val);
    container.appendChild(item);
  }
}

// ---- 像素渲染 ----
function renderFrame(msg) {
  const { width, height, pixels, index } = msg;
  els.frameCanvas.width = width;
  els.frameCanvas.height = height;
  const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), width, height);
  imgCtx.putImageData(imageData, 0, 0);
  // 叠加层与画布同像素分辨率
  els.overlayCanvas.width = width;
  els.overlayCanvas.height = height;
  fitDisplaySize(width, height);
  currentIndex = index;
  updateFrameMeta(summary.frames[index]);
  drawOverlay();
}

// 等比适配：小画布整数倍放大（上限 24×，便于核对矩形），大画布缩小到容器内
function fitDisplaySize(width, height) {
  const card = $('stageCard');
  const availW = card.clientWidth - 28;
  const availH = card.clientHeight - 28;
  const shrink = Math.min(1, availW / width, availH / height);
  const grow = width < 200 || height < 200
    ? Math.min(24, Math.floor(Math.min(availW / width, availH / height)))
    : 1;
  const scale = Math.max(shrink, 1) * grow;
  const cssW = Math.max(1, Math.round(width * scale));
  const cssH = Math.max(1, Math.round(height * scale));
  els.frameCanvas.style.width = `${cssW}px`;
  els.frameCanvas.style.height = `${cssH}px`;
  els.overlayCanvas.style.width = `${cssW}px`;
  els.overlayCanvas.style.height = `${cssH}px`;
}
window.addEventListener('resize', () => {
  if (summary && currentIndex >= 0) {
    fitDisplaySize(els.frameCanvas.width, els.frameCanvas.height);
  }
});

// ---- 叠加框（独立于导出像素） ----
function drawOverlay() {
  const ov = els.overlayCanvas;
  const ctx = ovCtx;
  ctx.clearRect(0, 0, ov.width, ov.height);
  if (!summary || !els.overlayToggle.checked) return;
  const f = summary.frames[currentIndex];
  if (!f) return;
  const styles = getComputedStyle(document.documentElement);
  const moveColor = styles.getPropertyValue('--move').trim();
  const dirtyColor = styles.getPropertyValue('--dirty').trim();

  for (const m of f.moves) drawRect(ctx, ov, m[4], m[5], m[2], m[3], moveColor);
  for (const d of f.dirty) drawRect(ctx, ov, d[0], d[1], d[2], d[3], dirtyColor);
}

function drawRect(ctx, ov, x, y, w, h, color) {
  // 显示放大时把线宽换算回画布像素空间，保证屏幕上约 1.5–2px
  const displayScale = ov.width > 0
    ? Number(els.frameCanvas.style.width.replace('px', '')) / ov.width
    : 1;
  const lw = Math.max(1 / displayScale, Math.round(Math.min(ov.width, ov.height) / 480));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = lw;
  ctx.strokeRect(x + lw / 2, y + lw / 2, Math.max(0, w - lw), Math.max(0, h - lw));
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}
els.overlayToggle.addEventListener('change', drawOverlay);

// ---- 导出 ----
els.exportBtn.addEventListener('click', () => {
  if (currentIndex < 0 || !summary.frames[currentIndex]?.valid) {
    toast('当前帧不是可重建的有效帧');
    return;
  }
  worker.postMessage({ type: 'export-png', index: currentIndex });
});
