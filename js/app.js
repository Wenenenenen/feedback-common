// 焦点堆栈 · 多尺度金字塔融合
// 交互层：导入/样例、层数、视图切换、画笔锁定、导出。
// 计算在 Worker 中完成（js/worker.js）；核心算法见 js/core.js。

import { decodePng, encodePngRgb8, encodePngGray8 } from './png.js';
import { differenceMagnitude, MAX_LEVELS, MAX_IMAGES, MIN_IMAGES } from './core.js';
import { encodeProject, decodeProject, validateInputs, projectFileName, downloadBlob, base64ToBytes } from './project.js';

const $ = (id) => document.getElementById(id);

const SOURCE_PALETTE = [
  [77, 163, 255],
  [53, 208, 163],
  [255, 180, 84],
  [255, 93, 108],
  [176, 132, 255],
  [110, 220, 255],
  [255, 140, 210],
];

const state = {
  images: [],
  levels: 5,
  labels: null,
  result: null,
  requestId: 0,
  busy: false,
  view: 'result',
  weightIndex: 0,
  diffTarget: 'hard',
  diffGain: 4,
  zoom: 0, // 0 = 适应窗口
  showOverlay: true,
  brush: { label: 1, radius: 3, erase: false, painting: false, last: null },
  hover: null,
  undo: [],
  previewQueued: false,
  worker: null,
  projectName: null,
  diffStats: null,
  diffCache: null,
  levelTimer: 0,
};

const els = {};
let lastPointerId = null;

window.addEventListener('DOMContentLoaded', init);

function init() {
  els.caseSelect = $('caseSelect');
  els.loadSampleBtn = $('loadSampleBtn');
  els.projectFile = $('projectFile');
  els.imageFiles = $('imageFiles');
  els.resetBtn = $('resetBtn');
  els.levelsInput = $('levelsInput');
  els.levelsOut = $('levelsOut');
  els.viewTabs = $('viewTabs');
  els.weightIndexWrap = $('weightIndexWrap');
  els.weightIndex = $('weightIndex');
  els.diffTargetWrap = $('diffTargetWrap');
  els.diffTarget = $('diffTarget');
  els.diffGainWrap = $('diffGainWrap');
  els.diffGain = $('diffGain');
  els.diffGainOut = $('diffGainOut');
  els.zoomSelect = $('zoomSelect');
  els.overlayToggle = $('overlayToggle');
  els.warnLine = $('warnLine');
  els.statusLine = $('statusLine');
  els.statPanel = $('statPanel');
  els.diagnosticPanel = $('diagnosticPanel');
  els.viewTitle = $('viewTitle');
  els.viewHint = $('viewHint');
  els.viewerScroll = $('viewerScroll');
  els.viewCanvas = $('viewCanvas');
  els.dropHint = $('dropHint');
  els.legendPanel = $('legendPanel');
  els.probePanel = $('probePanel');
  els.brushLabel = $('brushLabel');
  els.brushSize = $('brushSize');
  els.brushSizeOut = $('brushSizeOut');
  els.eraseToggle = $('eraseToggle');
  els.undoBtn = $('undoBtn');
  els.clearLockBtn = $('clearLockBtn');
  els.lockCount = $('lockCount');
  els.exportPngBtn = $('exportPngBtn');
  els.exportLockBtn = $('exportLockBtn');
  els.exportProjectBtn = $('exportProjectBtn');
  els.thumbStrip = $('thumbStrip');
  els.brushSizeOut.textContent = String(state.brush.radius);
  els.diffGainOut.textContent = `${state.diffGain}×`;
  bindEvents();
  loadCaseList().then(() => loadSample());
}

// ---------------- 事件 ----------------

function bindEvents() {
  els.levelsInput.addEventListener('input', () => {
    const v = Number(els.levelsInput.value);
    els.levelsOut.textContent = `${v} 层`;
    if (v === state.levels) return;
    state.levels = v;
    // 拖动滑块时合并重算：Worker 不能中断，避免堆积过期请求
    clearTimeout(state.levelTimer);
    state.levelTimer = setTimeout(run, 140);
  });
  els.diffGain.addEventListener('input', () => {
    state.diffGain = Number(els.diffGain.value);
    els.diffGainOut.textContent = `${state.diffGain}×`;
    if (state.view === 'diff') {
      renderView();
      renderStatusHint();
    }
  });
  els.zoomSelect.addEventListener('change', () => {
    state.zoom = Number(els.zoomSelect.value);
    renderView();
  });
  els.overlayToggle.addEventListener('change', () => {
    state.showOverlay = els.overlayToggle.checked;
    renderView();
  });
  els.weightIndex.addEventListener('change', () => {
    state.weightIndex = Number(els.weightIndex.value);
    renderView();
    renderStatusHint();
    renderLegend();
  });
  els.diffTarget.addEventListener('change', () => {
    state.diffTarget = els.diffTarget.value;
    renderView();
    renderStatusHint();
  });
  els.viewTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    for (const b of els.viewTabs.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    syncViewControls();
    renderView();
    renderLegend();
    renderStatusHint();
  });
  els.brushSize.addEventListener('input', () => {
    state.brush.radius = Number(els.brushSize.value);
    els.brushSizeOut.textContent = String(state.brush.radius);
  });
  els.eraseToggle.addEventListener('change', () => {
    state.brush.erase = els.eraseToggle.checked;
    updateBrushHint();
  });
  els.brushLabel.addEventListener('change', () => {
    state.brush.label = Number(els.brushLabel.value);
    updateBrushHint();
  });
  els.undoBtn.addEventListener('click', undoLock);
  els.clearLockBtn.addEventListener('click', () => {
    state.labels = null;
    state.undo = [];
    applyLockNow();
  });
  els.loadSampleBtn.addEventListener('click', () => {
    const id = els.caseSelect.value || 'focus-3';
    loadSample(id);
  });
  els.caseSelect.addEventListener('change', () => loadSample(els.caseSelect.value));
  els.resetBtn.addEventListener('click', () => {
    if (!state.images.length) return;
    state.labels = null;
    state.undo = [];
    state.levels = 5;
    els.levelsInput.value = '5';
    els.levelsOut.textContent = '5 层';
    state.brush.label = 1;
    els.brushLabel.value = '1';
    run();
  });
  els.projectFile.addEventListener('change', async () => {
    const file = els.projectFile.files && els.projectFile.files[0];
    els.projectFile.value = '';
    if (!file) return;
    await importProjectFile(file);
  });
  els.imageFiles.addEventListener('change', async () => {
    const files = [...(els.imageFiles.files || [])];
    els.imageFiles.value = '';
    if (files.length) await importImageFiles(files);
  });
  els.exportPngBtn.addEventListener('click', () => exportPng());
  els.exportLockBtn.addEventListener('click', () => exportLockPng());
  els.exportProjectBtn.addEventListener('click', () => exportProjectJson());

  const canvas = els.viewCanvas;
  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasMove);
  window.addEventListener('pointerup', () => endStroke());
  window.addEventListener('resize', () => {
    if (state.zoom === 0 && state.result) renderView();
  });
  canvas.addEventListener('pointerleave', () => {
    state.hover = null;
    renderProbe();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  els.viewerScroll.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropHint.classList.add('active');
  });
  els.viewerScroll.addEventListener('dragleave', () => els.dropHint.classList.remove('active'));
  els.viewerScroll.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.dropHint.classList.remove('active');
    await handleDroppedFiles([...(e.dataTransfer.files || [])]);
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLock();
    }
  });
}

// ---------------- 样例与导入 ----------------

async function loadCaseList() {
  try {
    const res = await fetch('/api/cases');
    if (!res.ok) throw new Error('服务不可用');
    const data = await res.json();
    els.caseSelect.innerHTML = '';
    for (const c of data.cases) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      els.caseSelect.appendChild(opt);
    }
  } catch {
    els.caseSelect.innerHTML = '<option value="focus-3">focus-0/1/2 + lock.png</option>';
  }
}

async function loadSample(id) {
  try {
    setWarn('');
    setStatus('正在加载样例…');
    const res = await fetch('/api/cases');
    if (!res.ok) throw new Error('未找到样例服务，请用 npm run serve 启动');
    const data = await res.json();
    const key = id || (data.cases[0] && data.cases[0].id);
    const c = data.cases.find((x) => x.id === key) || data.cases[0];
    if (!c) throw new Error('没有可用样例');
    const images = [];
    for (const im of c.images) {
      const dec = await decodePng(base64ToBytes(im.pngBase64));
      images.push({
        name: im.name,
        width: dec.width,
        height: dec.height,
        rgb8: dec.rgb8,
        colorType: dec.colorType,
        sourcePng: base64ToBytes(im.pngBase64),
      });
    }
    let labels = null;
    if (c.lockBase64) {
      const lock = await decodePng(base64ToBytes(c.lockBase64));
      if (lock.gray8) labels = new Uint8Array(lock.gray8);
    }
    applyProject({ images, levels: c.levels, labels, name: null });
    setStatus(`已加载样例：${images.length} 张，${images[0].width}×${images[0].height}，${c.levels} 层`);
  } catch (e) {
    setStatus(`加载样例失败：${e.message}`);
    setWarn(e.message);
  }
}

async function importImageFiles(files) {
  try {
    if (files.length < MIN_IMAGES || files.length > MAX_IMAGES) {
      throw new Error(`请一次选择 ${MIN_IMAGES}..${MAX_IMAGES} 张 PNG（当前 ${files.length} 张）`);
    }
    const images = [];
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      const im = await decodePng(buf);
      if (im.colorType !== 2) throw new Error(`${f.name} 不是 8 位 RGB PNG（需真彩、无 Alpha）`);
      images.push({ name: f.name, width: im.width, height: im.height, rgb8: im.rgb8, colorType: im.colorType, sourcePng: buf });
    }
    const v = validateInputs(images);
    if (!v.ok) throw new Error(v.errors.join('；'));
    applyProject({ images, levels: state.levels, labels: null, name: null });
    setStatus(`已导入 ${images.length} 张 ${images[0].width}×${images[0].height} PNG`);
    setWarn('');
  } catch (e) {
    setStatus(`导入失败：${e.message}`);
    setWarn(e.message);
  }
}

async function importProjectFile(file) {
  try {
    const proj = await decodeProject(await file.text());
    applyProject({ images: proj.images, levels: proj.levels, labels: proj.labels, name: file.name });
    setStatus(`已导入项目「${file.name}」：${proj.images.length} 张，${proj.levels} 层${proj.labels ? '，含锁定' : ''}`);
    setWarn('');
  } catch (e) {
    setStatus(`项目导入失败：${e.message}`);
    setWarn(e.message);
  }
}

async function handleDroppedFiles(files) {
  if (!files.length) return;
  const json = files.find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
  if (json) {
    await importProjectFile(json);
    return;
  }
  const pngs = files.filter((f) => /\.png$/i.test(f.name));
  if (pngs.length) await importImageFiles(pngs);
}

function applyProject({ images, levels, labels, name }) {
  state.images = images;
  state.levels = Math.max(1, Math.min(MAX_LEVELS, levels | 0));
  state.labels = labels ? new Uint8Array(labels) : null;
  state.undo = [];
  state.projectName = name || null;
  state.weightIndex = 0;
  state.diffTarget = 'hard';
  state.brush.label = 1;
  state.brush.erase = false;
  els.eraseToggle.checked = false;
  els.levelsInput.value = String(state.levels);
  els.levelsOut.textContent = `${state.levels} 层`;
  buildWeightOptions();
  buildBrushOptions();
  buildDiffOptions();
  syncViewControls();
  run();
}

// ---------------- 计算 ----------------

function run() {
  if (!state.images.length) return;
  ensureWorker();
  const id = ++state.requestId;
  state.busy = true;
  for (const b of [els.exportPngBtn, els.exportLockBtn, els.exportProjectBtn]) b.disabled = true;
  setStatus(`正在计算 ${state.levels} 层金字塔融合…`);
  state.worker.postMessage({
    id,
    images: state.images.map((im) => ({ name: im.name, width: im.width, height: im.height, rgb8: im.rgb8 })),
    levels: state.levels,
  });
}

function ensureWorker() {
  if (state.worker) return;
  state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  state.worker.onmessage = (e) => onResult(e.data);
  state.worker.onerror = (e) => {
    state.busy = false;
    setStatus(`Worker 错误：${e.message || '模块加载失败'}`);
    setWarn('Worker 未能启动：请使用 npm run serve（不要以 file:// 直接打开页面）');
  };
}

function onResult(d) {
  if (d.id !== state.requestId) return;
  state.busy = false;
  if (!d.ok) {
    setStatus(`计算失败：${d.error}`);
    return;
  }
  state.result = d;
  for (const b of [els.exportPngBtn, els.exportLockBtn, els.exportProjectBtn]) b.disabled = false;
  setStatus(`完成：${d.width}×${d.height} · ${d.levels} 层 · ${d.elapsedMs.toFixed(1)} ms`);
  els.clearLockBtn.disabled = !state.labels;
  // 用当前标签重新生成锁定后的结果，避免重算期间画的笔画丢失
  applyLockNow(false);
  renderAll();
}

// ---------------- 视图渲染 ----------------

function renderAll() {
  if (!state.result) return;
  renderView();
  renderStats();
  renderDiagnostics();
  renderThumbs();
  renderLockCount();
  renderLegend();
  renderProbe();
  renderStatusHint();
}

function currentZoom() {
  const r = state.result;
  if (!r) return 1;
  if (state.zoom > 0) {
    // 显式倍率下仍限制画布像素数，避免超大画布拖慢浏览器
    let z = state.zoom;
    while (z > 1 && Math.max(r.width, r.height) * z > 2048) z /= 2;
    return z;
  }
  // 适应窗口：整像素倍率，保证放大后仍是清晰的方块像素（扣除 .canvas-scroll 的 10px 内边距）
  const host = els.viewerScroll;
  const availW = Math.max(1, host.clientWidth - 20);
  const availH = Math.max(1, host.clientHeight - 20);
  const fit = Math.floor(Math.min(availW / r.width, availH / r.height));
  return Math.max(1, Math.min(16, fit));
}

function renderView() {
  const r = state.result;
  if (!r) return;
  const z = currentZoom();
  switch (state.view) {
    case 'result':
      drawResult(z);
      break;
    case 'weight':
      drawWeightMap(z);
      break;
    case 'dominant':
      drawDominantMap(z);
      break;
    case 'diff':
      drawDiffMap(z);
      break;
    case 'source':
      drawSource(z);
      break;
  }
  centerCanvas();
}

// 内容小于可视区时垂直居中（水平由 CSS margin:auto 处理；显式放大超出时从 0 开始滚动）
function centerCanvas() {
  const c = els.viewCanvas;
  const host = els.viewerScroll;
  const sp = getComputedStyle(host);
  const availH = host.clientHeight - parseFloat(sp.paddingTop) - parseFloat(sp.paddingBottom);
  c.style.marginTop = c.height < availH ? `${Math.floor((availH - c.height) / 2)}px` : '0';
}

function ensureCanvasSize(w, h) {
  const c = els.viewCanvas;
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function putRgb8Scaled(ctx, rgb8, w, h, z) {
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 3, q += 4) {
    d[q] = rgb8[p];
    d[q + 1] = rgb8[p + 1];
    d[q + 2] = rgb8[p + 2];
    d[q + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w * z, h * z);
}

function drawResult(z) {
  const r = state.result;
  const out = hasLockedLabels() && r.lockedRgb8 ? r.lockedRgb8 : r.fusedRgb8;
  const ctx = ensureCanvasSize(r.width * z, r.height * z);
  ctx.clearRect(0, 0, r.width * z, r.height * z);
  putRgb8Scaled(ctx, out, r.width, r.height, z);
  if (state.showOverlay && state.labels) drawLockOutline(ctx, z);
}

function hasLockedLabels() {
  if (!state.labels) return false;
  for (let i = 0; i < state.labels.length; i++) if (state.labels[i] >= 1) return true;
  return false;
}

// 锁定高亮只描出锁定区域的外边界与来源色，不遮盖像素本身——
// 画面始终是真实结果，方便逐像素核对锁定是否正确。
function drawLockOutline(ctx, z) {
  const r = state.result;
  const w = r.width;
  const h = r.height;
  const labels = state.labels;
  if (!labels) return;
  ctx.save();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const label = labels[i];
      if (label < 1) continue;
      const edge =
        (x === 0 || labels[i - 1] !== label) ||
        (x === w - 1 || labels[i + 1] !== label) ||
        (y === 0 || labels[i - w] !== label) ||
        (y === h - 1 || labels[i + w] !== label);
      if (!edge) continue;
      const pal = SOURCE_PALETTE[(label - 1) % SOURCE_PALETTE.length];
      ctx.fillStyle = `rgb(${pal.join(',')})`;
      ctx.fillRect(x * z, y * z, z, z);
    }
  }
  ctx.restore();
}

function drawWeightMap(z) {
  const r = state.result;
  const w = r.width;
  const h = r.height;
  const idx = Math.min(state.weightIndex, r.weights.length - 1);
  const wts = r.weights[idx];
  const ctx = ensureCanvasSize(w * z, h * z);
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, q = 0; i < w * h; i++, q += 4) {
    const v = Math.max(0, Math.min(1, wts[i]));
    const g = Math.round(v * 255); // 线性映射：0 → 黑，1 → 白
    d[q] = g;
    d[q + 1] = g;
    d[q + 2] = g;
    d[q + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w * z, h * z);
}

function drawDominantMap(z) {
  const r = state.result;
  const w = r.width;
  const h = r.height;
  const ctx = ensureCanvasSize(w * z, h * z);
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, q = 0; i < w * h; i++, q += 4) {
    const pal = SOURCE_PALETTE[r.dominant[i] % SOURCE_PALETTE.length];
    d[q] = pal[0];
    d[q + 1] = pal[1];
    d[q + 2] = pal[2];
    d[q + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w * z, h * z);
}

function diffForView(target) {
  const r = state.result;
  // 差值以未锁定的自动融合结果为准：锁定像素不参与比较，
  // 否则「结果差值」会变成锁定标签的同义重复。
  // 每个结果 + 目标只算一次，拖动增益滑块不重复计算。
  if (!state.diffCache || state.diffCache.result !== r || state.diffCache.target !== target) {
    state.diffCache = { result: r, target, data: differenceMagnitude(r.fusedLinear, state.images, r.dominant, r.width, r.height, target) };
  }
  return state.diffCache.data;
}

function drawDiffMap(z) {
  const r = state.result;
  const w = r.width;
  const h = r.height;
  const target = state.diffTarget === 'hard' ? 'hard' : Number(state.diffTarget);
  const { magnitude: mag, mean, max } = diffForView(target);
  const gain = state.diffGain;
  const ctx = ensureCanvasSize(w * z, h * z);
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, q = 0; i < w * h; i++, q += 4) {
    // 以 0.02 线性差为满量程（约 5% 的可见差异），再乘增益
    const t = Math.min(1, (mag[i] / 0.02) * gain);
    d[q] = Math.round(255 * Math.min(1, Math.max(0, t * 1.7 - 0.4)));
    d[q + 1] = Math.round(255 * Math.min(1, Math.max(0, t * 1.3 - 0.05)));
    d[q + 2] = Math.round(255 * Math.min(1, t * 2.4));
    d[q + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w * z, h * z);
  state.diffStats = { mean, max, gain };
}

function drawSource(z) {
  const r = state.result;
  const idx = Math.min(state.weightIndex, state.images.length - 1);
  const im = state.images[idx];
  const ctx = ensureCanvasSize(r.width * z, r.height * z);
  ctx.clearRect(0, 0, r.width * z, r.height * z);
  putRgb8Scaled(ctx, im.rgb8, r.width, r.height, z);
}

// ---------------- 画布交互（画笔 / 探针） ----------------

function canvasPixel(e) {
  const r = state.result;
  if (!r) return null;
  const c = els.viewCanvas;
  const rect = c.getBoundingClientRect();
  const z = currentZoom();
  const sx = c.width / rect.width;
  const sy = c.height / rect.height;
  const x = Math.floor(((e.clientX - rect.left) * sx) / z);
  const y = Math.floor(((e.clientY - rect.top) * sy) / z);
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
  return { x, y };
}

function onCanvasDown(e) {
  const r = state.result;
  if (!r) return;
  if (state.view !== 'result') return;
  const p = canvasPixel(e);
  if (!p) return;
  e.preventDefault();
  try {
    els.viewCanvas.setPointerCapture(e.pointerId);
    lastPointerId = e.pointerId;
  } catch {}
  if (!state.labels) state.labels = new Uint8Array(r.width * r.height);
  state.undo.push({ before: new Uint8Array(state.labels), label: state.brush.label, erase: state.brush.erase });
  if (state.undo.length > 24) state.undo.shift();
  state.brush.erase = e.button === 2 || els.eraseToggle.checked;
  if (!state.brush.erase) state.brush.label = Number(els.brushLabel.value) || 1;
  state.brush.painting = true;
  state.brush.last = null;
  paintAt(p);
}

function onCanvasMove(e) {
  const p = canvasPixel(e);
  state.hover = p;
  renderProbe();
  if (state.brush.painting && p) paintAt(p);
}

function endStroke() {
  if (!state.brush.painting) return;
  state.brush.painting = false;
  state.brush.last = null;
  state.brush.erase = els.eraseToggle.checked;
  try {
    els.viewCanvas.releasePointerCapture(lastPointerId);
  } catch {}
  lastPointerId = null;
  // 锁定不参与金字塔计算（口径要求锁定不改自动权重），因此不必重跑融合：
  // 直接在既有自动融合结果上覆盖锁定像素，画笔即时生效。
  applyLockNow();
}

// 用当前 labels 重新生成锁定后的结果。自动权重与融合图保持不变。
function applyLockNow(render = true) {
  const r = state.result;
  if (!r) return;
  const labels = state.labels;
  const n = state.images.length;
  const count = r.width * r.height;
  let locked = 0;
  const out = new Uint8Array(r.fusedRgb8);
  if (labels) {
    for (let i = 0; i < count; i++) {
      const label = labels[i];
      if (label >= 1 && label <= n) {
        const src = state.images[label - 1].rgb8;
        out[i * 3] = src[i * 3];
        out[i * 3 + 1] = src[i * 3 + 1];
        out[i * 3 + 2] = src[i * 3 + 2];
        locked++;
      }
    }
  }
  r.lockedRgb8 = out;
  r.stats.lockedPixelCount = locked;
  els.clearLockBtn.disabled = !state.labels;
  if (render) {
    renderView();
    renderLockCount();
    renderStats();
  }
}

function paintAt(p) {
  const r = state.result;
  const labels = state.labels;
  const w = r.width;
  const h = r.height;
  const n = state.images.length;
  const radius = state.brush.radius;
  const value = state.brush.erase ? 0 : Math.max(1, Math.min(n, Number(els.brushLabel.value) || 1));
  const r2 = radius * radius + radius;
  const stamp = (cx, cy) => {
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx;
        if (x < 0 || x >= w) continue;
        labels[y * w + x] = value;
      }
    }
  };
  if (state.brush.last) {
    let x0 = state.brush.last.x;
    let y0 = state.brush.last.y;
    const x1 = p.x;
    const y1 = p.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let guard = 0; guard < 200000; guard++) {
      stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  } else {
    stamp(p.x, p.y);
  }
  state.brush.last = { x: p.x, y: p.y };
  // 锁定只覆盖最终像素、不进入金字塔计算，所以画笔期间直接基于既有自动融合图
  // 重做覆盖即可，无需重跑 Worker；每帧最多合并一次，快速涂抹也不掉帧。
  scheduleLockPreview();
  renderLockCount();
}

function scheduleLockPreview() {
  if (state.previewQueued) return;
  state.previewQueued = true;
  requestAnimationFrame(() => {
    state.previewQueued = false;
    applyLockNow();
  });
}

function undoLock() {
  const snap = state.undo.pop();
  if (!snap) return;
  state.labels = snap.before;
  state.brush.label = snap.label;
  state.brush.erase = snap.erase;
  els.eraseToggle.checked = snap.erase;
  els.brushLabel.value = String(snap.label);
  if (state.labels && !state.labels.some((v) => v >= 1)) state.labels = null;
  applyLockNow();
}

// ---------------- 侧栏渲染 ----------------

function renderStats() {
  const r = state.result;
  if (!r) return;
  const rows = [
    ['尺寸', `${r.width}×${r.height}`],
    ['输入帧', `${state.images.length}`],
    ['实际层数', `${r.levels}${r.levels !== r.requestedLevels ? `（请求 ${r.requestedLevels}，尺寸到顶）` : ''}`],
    ['层尺寸', r.sizes.map((s) => `${s.w}×${s.h}`).join(' → ')],
    ['无纹理像素', `${r.stats.lowTexturePixels}`],
    ['无效权重', `${r.stats.invalidWeightPixels}`],
    ['未限幅范围', `${r.stats.minLinear.toFixed(4)} … ${r.stats.maxLinear.toFixed(4)}`],
    ['超范围样本', `${r.stats.outOfRange}`],
    ['锁定像素', `${r.stats.lockedPixelCount}`],
    ['耗时', `${r.elapsedMs.toFixed(1)} ms`],
  ];
  els.statPanel.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

function renderDiagnostics() {
  const r = state.result;
  if (!r) return;
  const head = '<div class="diag-row head"><span>层</span><span>尺寸</span><span>权重和 min</span><span>max</span><span>兜底</span></div>';
  const body = r.stats.weightLevels
    .map(
      (l) =>
        `<div class="diag-row"><span>${l.level}</span><span>${l.width}×${l.height}</span><span>${l.minSum.toFixed(6)}</span><span>${l.maxSum.toFixed(6)}</span><span class="${l.uniformFallbacks ? 'bad' : ''}">${l.uniformFallbacks}</span></div>`,
    )
    .join('');
  els.diagnosticPanel.innerHTML = head + body;
}

function renderThumbs() {
  const strip = els.thumbStrip;
  strip.innerHTML = '';
  const r = state.result;
  if (!r) return;
  for (let i = 0; i < state.images.length; i++) {
    const im = state.images[i];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'thumb';
    cell.title = `${im.name}（#${i + 1}）`;
    const c = document.createElement('canvas');
    const tw = 72;
    const th = Math.max(1, Math.round((tw * im.height) / im.width));
    c.width = tw;
    c.height = th;
    const ctx = c.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = im.width;
    tmp.height = im.height;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(im.width, im.height);
    const d = img.data;
    for (let k = 0, p = 0, q = 0; k < im.width * im.height; k++, p += 3, q += 4) {
      d[q] = im.rgb8[p];
      d[q + 1] = im.rgb8[p + 1];
      d[q + 2] = im.rgb8[p + 2];
      d[q + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.style.background = `rgb(${SOURCE_PALETTE[i % SOURCE_PALETTE.length].join(',')})`;
    tag.textContent = String(i + 1);
    cell.append(c, tag);
    if (i === Number(els.brushLabel.value) - 1 && state.view === 'result') cell.classList.add('brush-target');
    cell.addEventListener('click', () => {
      els.brushLabel.value = String(i + 1);
      state.brush.label = i + 1;
      els.weightIndex.value = String(i);
      state.weightIndex = i;
      updateBrushHint();
      renderThumbs();
    });
    strip.appendChild(cell);
  }
}

function renderLockCount() {
  const r = state.result;
  if (!r) return;
  let n = 0;
  if (state.labels) for (let i = 0; i < state.labels.length; i++) if (state.labels[i] >= 1) n++;
  const byLabel = new Map();
  if (state.labels) {
    for (let i = 0; i < state.labels.length; i++) {
      const l = state.labels[i];
      if (l >= 1) byLabel.set(l, (byLabel.get(l) || 0) + 1);
    }
  }
  const parts = [...byLabel.entries()].sort((a, b) => a[0] - b[0]).map(([l, c]) => `#${l}: ${c}`);
  els.lockCount.textContent = n ? `${n} 个像素已锁定（${parts.join('，')}）` : '无锁定';
}

function renderLegend() {
  const n = state.images.length;
  const show = state.view === 'dominant' || state.view === 'weight' || state.view === 'source';
  els.legendPanel.hidden = !show;
  if (!show) return;
  els.legendPanel.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const sw = document.createElement('i');
    sw.style.background = `rgb(${SOURCE_PALETTE[i % SOURCE_PALETTE.length].join(',')})`;
    const lab = document.createElement('span');
    lab.textContent = `#${i + 1} ${state.images[i].name}`;
    row.append(sw, lab);
    els.legendPanel.appendChild(row);
  }
}

function renderProbe() {
  const r = state.result;
  if (!r || !state.hover) {
    els.probePanel.innerHTML = '<span class="muted">把鼠标移到图像上查看像素信息</span>';
    return;
  }
  const { x, y } = state.hover;
  const i = y * r.width + x;
  const rgb = [0, 1, 2].map((c) => (r.lockedRgb8 || r.fusedRgb8)[i * 3 + c]);
  const wlist = r.weights.map((w) => w[i].toFixed(4));
  const label = state.labels ? state.labels[i] : 0;
  const lin = r.fusedLinear.map((p) => p[i].toFixed(4)).join(', ');
  els.probePanel.innerHTML = [
    `(${x}, ${y})`,
    `rgb(${rgb.join(', ')})`,
    `线性 ${lin}`,
    `主导 #${r.dominant[i] + 1}`,
    `权重 [${wlist.join(', ')}]`,
    `锁定 ${label === 0 ? '自动' : `#${label}`}`,
  ]
    .map((s) => `<span>${s}</span>`)
    .join('');
}

const MAIN_TITLES = {
  result: '融合结果（含锁定）',
  weight: '权重图',
  dominant: '主导来源（硬选择对照）',
  diff: '结果差值',
  source: '原图',
};

function renderStatusHint() {
  const idx = Math.min(state.weightIndex, Math.max(0, state.images.length - 1));
  const name = state.images[idx] ? state.images[idx].name : '';
  let title = MAIN_TITLES[state.view] || '';
  if (state.view === 'weight') title = `权重图 W${idx + 1}（${name}）`;
  else if (state.view === 'source') title = `原图 #${idx + 1}（${name}）`;
  els.viewTitle.textContent = title;
  if (state.view === 'diff' && state.diffStats) {
    const { mean, max, gain } = state.diffStats;
    els.viewHint.textContent = `融合结果与目标的线性差 · 平均 ${mean.toFixed(5)} · 最大 ${max.toFixed(5)} · 增益 ${gain}×`;
    return;
  }
  const hints = {
    result: '在图像上拖动即可用画笔锁定；右键拖动擦除。锁定像素完全取自所选原图。',
    weight: '亮度=该帧在此像素的权重（0→黑，1→白，线性映射）；悬停查看精确数值。',
    dominant: '每个像素权重最大的帧；平局取最小索引。',
    diff: '融合结果与目标原图的线性差（逐像素最大通道绝对差）；增益仅影响显示。',
    source: '当前选定原图。',
  };
  els.viewHint.textContent = hints[state.view] || '';
}

function updateBrushHint() {
  renderThumbs();
}

// ---------------- 选项与状态 ----------------

function buildWeightOptions() {
  els.weightIndex.innerHTML = '';
  state.images.forEach((im, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `#${i + 1} ${im.name}`;
    els.weightIndex.appendChild(o);
  });
  els.weightIndex.value = String(Math.min(state.weightIndex, state.images.length - 1));
}

function buildBrushOptions() {
  els.brushLabel.innerHTML = '';
  state.images.forEach((im, i) => {
    const o = document.createElement('option');
    o.value = String(i + 1);
    o.textContent = `#${i + 1} ${im.name}`;
    els.brushLabel.appendChild(o);
  });
  els.brushLabel.value = String(state.brush.label);
}

function buildDiffOptions() {
  els.diffTarget.innerHTML = '';
  const hard = document.createElement('option');
  hard.value = 'hard';
  hard.textContent = '主导来源（硬选择）';
  els.diffTarget.appendChild(hard);
  state.images.forEach((im, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `#${i + 1} ${im.name}`;
    els.diffTarget.appendChild(o);
  });
  els.diffTarget.value = state.diffTarget === 'hard' ? 'hard' : String(state.diffTarget);
}

function syncViewControls() {
  const showWeight = state.view === 'weight' || state.view === 'source';
  els.weightIndexWrap.style.display = showWeight ? '' : 'none';
  els.diffTargetWrap.style.display = state.view === 'diff' ? '' : 'none';
  els.diffGainWrap.style.display = state.view === 'diff' ? '' : 'none';
}

function setStatus(text) {
  els.statusLine.textContent = text;
}

function setWarn(text) {
  if (!text) {
    els.warnLine.hidden = true;
    els.warnLine.textContent = '';
    return;
  }
  els.warnLine.hidden = false;
  els.warnLine.textContent = text;
}

// ---------------- 导出 ----------------

async function exportPng() {
  const r = state.result;
  if (!r) return;
  const out = hasLockedLabels() && r.lockedRgb8 ? r.lockedRgb8 : r.fusedRgb8;
  const png = await encodePngRgb8(r.width, r.height, out);
  downloadBlob(new Blob([png], { type: 'image/png' }), `focus-stack-L${r.levels}.png`);
  setStatus(`已导出合成 PNG（${r.width}×${r.height}，8 位 RGB，${r.levels} 层）`);
}

async function exportLockPng() {
  const r = state.result;
  if (!r) return;
  const labels = state.labels || new Uint8Array(r.width * r.height);
  const png = await encodePngGray8(r.width, r.height, labels);
  downloadBlob(new Blob([png], { type: 'image/png' }), `focus-stack-lock-L${r.levels}.png`);
  setStatus('已导出锁定标签 PNG（8 位灰度，0=自动，1..N=指定来源）');
}

function exportProjectJson() {
  const r = state.result;
  if (!r) return;
  const proj = encodeProject({
    images: state.images,
    levels: r.levels,
    labels: state.labels,
    width: r.width,
    height: r.height,
  });
  downloadBlob(new Blob([JSON.stringify(proj)], { type: 'application/json' }), projectFileName(r.levels));
  setStatus('已导出项目 JSON（内嵌输入 PNG、层数、锁定标签，可重新导入继续修改）');
}

// 端到端测试用的只读钩子 / 重跑入口（不参与计算）。
window.__state = state;
window.__palette = SOURCE_PALETTE;
window.__rerun = () => run();
