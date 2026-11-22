/**
 * 页面逻辑：场景载入、参数联动、双视图渲染、像素探查、导出。
 */
import {
  parseCaseSet,
  buildScene,
  integratePixel,
  renderInstant,
  exposureWindow,
  linearToSrgb,
  ValidationError,
} from './shutter.js';
import { integrateFrame } from './integrate.js';
import { packLinear, makePreviewPng, downloadBytes } from './export.js';

const SAMPLE_URL = 'samples/shutter-integral-cases.json';

const state = {
  set: null,          // { background, cases }
  caseIndex: 0,
  caseObj: null,      // 规范化 case
  scene: null,        // buildScene 结果
  params: { start: 0, duration: 1, scanDelay: 0, scanDir: 'down', weight: 'uniform' },
  time: 0.5,
  integrated: null,   // { data: Float64Array, weights: Float64Array, W, H }
  instant: null,      // Float64Array
  probe: null,        // { px, py }
  showOutline: true,
  playing: false,
  playRAF: 0,
  renderToken: 0,
  running: false,
};

const $ = (id) => document.getElementById(id);
const els = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** sRGB 编码后的线性颜色 → CSS 色串（用于图例/色块，展示上接近感知）。 */
function colorCss(rgb) {
  const enc = rgb.map((v) => Math.round(linearToSrgb(v) * 255));
  return `rgb(${enc[0]}, ${enc[1]}, ${enc[2]})`;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  cacheEls();
  bindStaticControls();
  try {
    const res = await fetch(SAMPLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    applyCaseSet(parseCaseSet(text), { keepCaseId: null });
  } catch (e) {
    showError(e);
  }
}

function cacheEls() {
  for (const id of [
    'caseSelect', 'importBtn', 'fileInput', 'resetBtn', 'errorBanner', 'errorList',
    'startRange', 'startOut', 'durationRange', 'durationOut', 'scanDelayRange', 'scanDelayOut',
    'scanSvg', 'caseSummary', 'cardLegend', 'runState', 'runDot', 'runText', 'progressFill',
    'tReadout', 'timeRange', 'playBtn', 'outlineBtn', 'instantCanvas', 'integratedCanvas',
    'instantChips', 'integratedChips', 'windowInfo', 'probeCard', 'probeMeta', 'probeBody',
    'precisionSelect', 'dlLinear', 'dlWeights', 'dlPng', 'dlJson', 'exportHint',
    'instantWrap', 'integratedWrap', 'dropOverlay',
  ]) els[id] = $(id);
}

function bindStaticControls() {
  els.startRange.addEventListener('input', () => {
    state.params.start = Number(els.startRange.value);
    els.startOut.textContent = fmt(state.params.start, 3);
    onParamsChanged();
  });
  els.durationRange.addEventListener('input', () => {
    state.params.duration = Number(els.durationRange.value);
    els.durationOut.textContent = fmt(state.params.duration, 3);
    onParamsChanged();
  });
  els.scanDelayRange.addEventListener('input', () => {
    state.params.scanDelay = Number(els.scanDelayRange.value);
    els.scanDelayOut.textContent = fmt(state.params.scanDelay, 3);
    onParamsChanged();
  });

  document.querySelectorAll('[data-scan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.params.scanDir = btn.dataset.scan;
      syncSegmented('[data-scan]', 'scan', state.params.scanDir);
      onParamsChanged();
    });
  });
  document.querySelectorAll('[data-weight]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.params.weight = btn.dataset.weight;
      syncSegmented('[data-weight]', 'weight', state.params.weight);
      onParamsChanged();
    });
  });

  els.timeRange.addEventListener('input', () => {
    state.time = Number(els.timeRange.value);
    els.tReadout.textContent = fmt(state.time, 3);
    drawInstant();
    updateReadouts();
  });
  els.playBtn.addEventListener('click', togglePlay);
  els.outlineBtn.addEventListener('click', () => {
    state.showOutline = !state.showOutline;
    els.outlineBtn.setAttribute('aria-pressed', String(state.showOutline));
    els.outlineBtn.classList.toggle('active', state.showOutline);
    drawInstant();
  });

  els.instantCanvas.addEventListener('click', (e) => onCanvasClick(e));
  els.integratedCanvas.addEventListener('click', (e) => onCanvasClick(e));

  els.caseSelect.addEventListener('change', () => {
    state.caseIndex = Number(els.caseSelect.value);
    loadCase();
  });
  els.importBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) importFile(f);
    els.fileInput.value = '';
  });
  els.resetBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(SAMPLE_URL);
      const text = await res.text();
      applyCaseSet(parseCaseSet(text), { keepCaseId: state.caseObj ? state.caseObj.id : null });
    } catch (e) {
      showError(e);
    }
  });

  els.dlLinear.addEventListener('click', () => {
    if (!state.integrated) return;
    const f32 = els.precisionSelect.value === 'f32';
    const bytes = packLinear(state.integrated.data, state.integrated.W, state.integrated.H, f32);
    downloadBytes(bytes, `${safeName(state.caseObj.id)}-linear-rgb-${state.integrated.W}x${state.integrated.H}.${f32 ? 'f32' : 'f64'}.bin`);
  });
  els.dlWeights.addEventListener('click', () => {
    if (!state.integrated) return;
    const f32 = els.precisionSelect.value === 'f32';
    const { weights, W, H } = state.integrated;
    const buf = new ArrayBuffer(W * H * (f32 ? 4 : 8));
    const dv = new DataView(buf);
    for (let i = 0; i < W * H; i++) {
      if (f32) dv.setFloat32(i * 4, weights[i], true);
      else dv.setFloat64(i * 8, weights[i], true);
    }
    downloadBytes(new Uint8Array(buf), `${safeName(state.caseObj.id)}-weights-${W}x${H}.${f32 ? 'f32' : 'f64'}.bin`);
  });
  els.dlPng.addEventListener('click', async () => {
    if (!state.integrated) return;
    const { data, W, H } = state.integrated;
    const png = await makePreviewPng(data, W, H, true);
    downloadBytes(png, `${safeName(state.caseObj.id)}-preview-${W}x${H}.png`, 'image/png');
  });
  els.dlJson.addEventListener('click', () => {
    const payload = {
      case: state.caseObj.id,
      size: [state.scene.W, state.scene.H],
      params: state.params,
      semantics: {
        coverage: 'pixel center, continuous time, boundaries are measure zero',
        depthTie: 'smaller card id wins',
        background: state.scene.background,
        note: 'segments are clipped to the exposure window intersected with [0,1]',
      },
      output: {
        linearRgb: `rgb interleaved row-major, ${els.precisionSelect.value === 'f32' ? 'float32' : 'float64'} little-endian, length ${state.scene.W * state.scene.H * 3}`,
        weights: `per-pixel integrated weight, length ${state.scene.W * state.scene.H}`,
      },
      cards: state.scene.cards.map((c, i) => ({ index: i, id: c.id, rgb: c.rgb, depth: [c.d0, c.d1] })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    downloadBytes(bytes, `${safeName(state.caseObj.id)}-params.json`, 'application/json');
  });

  // 拖放导入
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropOverlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) importFile(f);
  });

  // 主题变化时重绘（系列色来自 CSS 变量）
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      drawScanChart();
      drawInstant();
      renderProbe();
    });
  }
}

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

function syncSegmented(sel, attr, value) {
  document.querySelectorAll(sel).forEach((b) => {
    const on = b.dataset[attr] === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function safeName(s) {
  return String(s || 'scene').replace(/[^A-Za-z0-9._-]+/g, '_');
}

// ---------------------------------------------------------------------------
// 场景载入
// ---------------------------------------------------------------------------

function applyCaseSet(set, { keepCaseId }) {
  state.set = set;
  els.errorBanner.hidden = true;

  // 填 case 下拉
  els.caseSelect.innerHTML = '';
  set.cases.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = c.id;
    els.caseSelect.appendChild(o);
  });
  let idx = 0;
  if (keepCaseId != null) {
    const found = set.cases.findIndex((c) => c.id === keepCaseId);
    if (found >= 0) idx = found;
  }
  state.caseIndex = idx;
  els.caseSelect.value = String(idx);
  loadCase();
}

function loadCase() {
  state.caseObj = state.set.cases[state.caseIndex];
  state.scene = buildScene(state.caseObj);
  state.integrated = null;
  state.probe = null;
  state.instantBuf = null;
  state.instantMask = null;

  // 参数范围与场景时间轴自适应（窗口可超出 [0,1]，允许部分曝光）
  syncParameterControls();
  buildSummary();
  buildLegend();
  drawScanChart();
  resizeCanvases();
  drawInstant();
  clearIntegratedCanvas();
  renderProbe();
  recomputeIntegral();
  updateReadouts();
}

function clearIntegratedCanvas() {
  const cv = els.integratedCanvas;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  els.integratedChips.innerHTML = '<span class="chip">计算中</span>';
}

function syncParameterControls() {
  els.startRange.value = String(state.params.start);
  els.startOut.textContent = fmt(state.params.start, 3);
  els.durationRange.value = String(state.params.duration);
  els.durationOut.textContent = fmt(state.params.duration, 3);
  els.scanDelayRange.value = String(state.params.scanDelay);
  els.scanDelayOut.textContent = fmt(state.params.scanDelay, 3);
  els.timeRange.value = String(state.time);
  els.tReadout.textContent = fmt(state.time, 3);
  syncSegmented('[data-scan]', 'scan', state.params.scanDir);
  syncSegmented('[data-weight]', 'weight', state.params.weight);
}

function buildSummary() {
  const s = state.scene;
  const triCount = s.triangles.length;
  const rows = [
    ['图像尺寸', `${s.W} × ${s.H}`],
    ['色片', String(s.cards.length)],
    ['三角形', `${triCount} / 64`],
    ['像素中心', `${s.W * s.H}`],
  ];
  els.caseSummary.innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');
}

function buildLegend() {
  const s = state.scene;
  els.cardLegend.innerHTML = '';
  s.cards.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = colorCss(c.rgb);
    const id = document.createElement('span');
    id.className = 'lg-id';
    id.textContent = String(c.id);
    const dep = document.createElement('span');
    dep.className = 'lg-dep';
    dep.textContent = c.d0 === c.d1 ? `d=${fmt(c.d0, 2)}` : `d ${fmt(c.d0, 2)}→${fmt(c.d1, 2)}`;
    row.append(sw, id, dep);
    els.cardLegend.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// 参数变化 & 计算调度
// ---------------------------------------------------------------------------

function onParamsChanged() {
  drawScanChart();
  updateReadouts();
  recomputeIntegral();
}

function updateReadouts() {
  if (!state.scene) return;
  const rowWindows = [];
  for (let py = 0; py < state.scene.H; py++) {
    rowWindows.push(exposureWindow(py, state.scene.H, state.params));
  }
  const lo = Math.min(...rowWindows.map((w) => w[0]));
  const hi = Math.max(...rowWindows.map((w) => w[1]));
  els.windowInfo.textContent = `窗口 ${fmt(lo, 3)} → ${fmt(hi, 3)}`;
  const clipped = lo < 0 || hi > 1;
  els.windowInfo.title = clipped ? '窗口超出 [0,1]，超出部分不累积曝光' : '';
  els.windowInfo.style.color = clipped ? 'var(--warn)' : '';
  if (state.probe) renderProbeMeta();
}

function recomputeIntegral() {
  if (!state.caseObj) return;
  const token = ++state.renderToken;
  const prev = state.activeReq;
  if (prev) prev.cancel();

  setRun('busy', '计算中…');
  els.progressFill.style.width = '0%';

  const req = integrateFrame(state.caseObj, state.params, (done, total) => {
    if (token !== state.renderToken) return;
    els.progressFill.style.width = `${(done / total) * 100}%`;
  });
  state.activeReq = req;

  req.promise
    .then((res) => {
      if (token !== state.renderToken) return;
      state.integrated = res;
      els.progressFill.style.width = '100%';
      setRun('ok', '完成');
      drawIntegrated();
      if (state.probe) renderProbe();
    })
    .catch((e) => {
      if (token !== state.renderToken) return;
      setRun('err', '计算失败');
      showError(e);
    })
    .finally(() => {
      if (state.activeReq === req) state.activeReq = null;
    });
}

function setRun(kind, text) {
  els.runDot.className = `dot ${kind}`;
  els.runText.textContent = text;
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

function pixelScale(W, H) {
  const maxW = els.instantWrap.clientWidth - 22 || 420;
  const target = Math.max(28, Math.min(48, Math.floor(maxW / W)));
  return Math.max(4, Math.min(target, Math.floor(360 / H)));
}

function resizeCanvases() {
  if (!state.scene) return;
  const { W, H } = state.scene;
  const scale = pixelScale(W, H);
  for (const c of [els.instantCanvas, els.integratedCanvas]) {
    c.width = W * scale;
    c.height = H * scale;
    c.style.width = `${W * scale}px`;
    c.style.height = `${H * scale}px`;
  }
  state.scale = scale;
}

function drawInstant() {
  if (!state.scene) return;
  const { W, H } = state.scene;
  const scale = state.scale;
  const cv = els.instantCanvas;
  const ctx = cv.getContext('2d');

  // 复用缓冲，播放时不产生垃圾
  const need = W * H * 3;
  if (!state.instantBuf || state.instantBuf.length !== need) state.instantBuf = new Float64Array(need);
  if (!state.instantMask || state.instantMask.length !== W * H) state.instantMask = new Uint8Array(W * H);
  const data = renderInstant(state.scene, state.time, state.instantBuf, state.instantMask);
  state.instant = data;
  const mask = state.instantMask;

  const img = ctx.createImageData(W, H);
  const bgLin = state.scene.background;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) {
      // 背景：真实背景色上叠一层极淡棋盘，既不丢失背景颜色，又能与纯黑色片区分
      const v = (((i % W) + ((i / W) | 0)) & 1) ? 0.88 : 1.0;
      img.data[i * 4] = Math.round(linearToSrgb(bgLin[0]) * 255 * v);
      img.data[i * 4 + 1] = Math.round(linearToSrgb(bgLin[1]) * 255 * v);
      img.data[i * 4 + 2] = Math.round(linearToSrgb(bgLin[2]) * 255 * v);
      // 纯黑背景单独提亮，保证棋盘可见
      if (img.data[i * 4] + img.data[i * 4 + 1] + img.data[i * 4 + 2] < 24) {
        const g = v > 0.95 ? 34 : 24;
        img.data[i * 4] = g;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = g;
      }
    } else {
      const o = i * 3;
      img.data[i * 4] = Math.round(linearToSrgb(data[o]) * 255);
      img.data[i * 4 + 1] = Math.round(linearToSrgb(data[o + 1]) * 255);
      img.data[i * 4 + 2] = Math.round(linearToSrgb(data[o + 2]) * 255);
    }
    img.data[i * 4 + 3] = 255;
  }
  if (!state.smallCanvas || state.smallCanvas.width !== W || state.smallCanvas.height !== H) {
    state.smallCanvas = document.createElement('canvas');
    state.smallCanvas.width = W;
    state.smallCanvas.height = H;
  }
  state.smallCanvas.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(state.smallCanvas, 0, 0, cv.width, cv.height);

  if (state.showOutline) drawTriOutlines(ctx, scale);

  drawInstantChips();
  if (state.probe) drawProbeMarkers();
}

function drawTriOutlines(ctx, scale) {
  const t = state.time;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  for (const tri of state.scene.triangles) {
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const X = (tri.p0x[i] + (tri.p1x[i] - tri.p0x[i]) * t) * scale;
      const Y = (tri.p0y[i] + (tri.p1y[i] - tri.p0y[i]) * t) * scale;
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function drawInstantChips() {
  const t = state.time;
  const visible = new Set();
  const mask = state.instantMask;
  const data = state.instant;
  if (mask && data) {
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const o = i * 3;
      const key = `${data[o].toFixed(4)},${data[o + 1].toFixed(4)},${data[o + 2].toFixed(4)}`;
      visible.add(key);
    }
  }
  const names = [];
  for (const key of visible) {
    const [r, g, b] = key.split(',').map(Number);
    const card = state.scene.cards.find((c) => Math.abs(c.rgb[0] - r) < 5e-5 && Math.abs(c.rgb[1] - g) < 5e-5 && Math.abs(c.rgb[2] - b) < 5e-5);
    if (card) names.push(String(card.id));
  }
  const chips = [`t=${fmt(t, 3)}`];
  if (names.length === 0) chips.push('无覆盖');
  else if (names.length <= 4) chips.push(...names);
  else chips.push(`${names.length} 个色片可见`);
  els.instantChips.innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
}

function drawIntegrated() {
  if (!state.integrated || !state.scene) {
    const ctx = els.integratedCanvas.getContext('2d');
    ctx.clearRect(0, 0, els.integratedCanvas.width, els.integratedCanvas.height);
    return;
  }
  const { data, W, H } = state.integrated;
  const cv = els.integratedCanvas;
  const ctx = cv.getContext('2d');
  const scale = state.scale;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 3;
    img.data[i * 4] = Math.round(linearToSrgb(data[o]) * 255);
    img.data[i * 4 + 1] = Math.round(linearToSrgb(data[o + 1]) * 255);
    img.data[i * 4 + 2] = Math.round(linearToSrgb(data[o + 2]) * 255);
    img.data[i * 4 + 3] = 255;
  }
  const small = document.createElement('canvas');
  small.width = W; small.height = H;
  small.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(small, 0, 0, cv.width, cv.height);

  // chips：平均亮度与最大单像素色
  let sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < W * H; i++) {
    sr += data[i * 3]; sg += data[i * 3 + 1]; sb += data[i * 3 + 2];
  }
  const n = W * H;
  els.integratedChips.innerHTML = [
    `R̄ ${fmt(sr / n, 3)}`,
    `Ḡ ${fmt(sg / n, 3)}`,
    `B̄ ${fmt(sb / n, 3)}`,
  ].map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');

  if (state.probe) drawProbeMarkers();
}

function drawProbeMarkers() {
  if (!state.probe) return;
  const { px, py } = state.probe;
  const scale = state.scale;
  for (const [cv, color] of [[els.instantCanvas, '#ffffff'], [els.integratedCanvas, '#ffffff']]) {
    const ctx = cv.getContext('2d');
    const x = px * scale;
    const y = py * scale;
    const s = scale;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, scale * 0.09);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeRect(x - 0.5, y - 0.5, s + 1, s + 1);
    ctx.lineWidth = Math.max(1, scale * 0.06);
    ctx.strokeStyle = color;
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 像素点击 & 探查
// ---------------------------------------------------------------------------

function onCanvasClick(e) {
  if (!state.scene) return;
  const cv = e.currentTarget;
  const rect = cv.getBoundingClientRect();
  const sx = cv.width / rect.width;
  const sy = cv.height / rect.height;
  const cx = (e.clientX - rect.left) * sx;
  const cy = (e.clientY - rect.top) * sy;
  const px = Math.floor(cx / state.scale);
  const py = Math.floor(cy / state.scale);
  if (px < 0 || py < 0 || px >= state.scene.W || py >= state.scene.H) return;
  state.probe = { px, py };
  renderProbe();
  drawInstant();
  if (state.integrated) drawIntegrated();
}

function renderProbeMeta() {
  if (!state.probe || !state.scene) {
    els.probeMeta.textContent = '尚未选择像素';
    return;
  }
  const { px, py } = state.probe;
  const w = exposureWindow(py, state.scene.H, state.params);
  els.probeMeta.textContent = `像素 (${px}, ${py}) · 中心 (${fmt(px + 0.5, 1)}, ${fmt(py + 0.5, 1)}) · 窗口 ${fmt(w[0], 3)}→${fmt(w[1], 3)}`;
}

function renderProbe() {
  renderProbeMeta();
  if (!state.probe || !state.scene) {
    els.probeMeta.textContent = '尚未选择像素';
    els.probeBody.innerHTML = '<p class="empty">在左侧“瞬时画面”或右侧“曝光积分”中点击一个像素，查看它在该行曝光窗口内的前景、背景分段与各段贡献。</p>';
    return;
  }
  const { px, py } = state.probe;
  const r = integratePixel(state.scene, px, py, state.params, true);

  const rows = r.segments.map((s) => {
    const color = s.card >= 0 ? state.scene.cards[s.card].rgb : state.scene.background;
    const name = s.card >= 0 ? String(s.id) : '背景';
    const kind = s.card >= 0 ? '色片' : '背景';
    return `
      <tr>
        <td class="sw-cell"><span class="sw" style="background:${colorCss(color)}"></span></td>
        <td class="id-cell">${escapeHtml(name)}</td>
        <td>${kind}</td>
        <td>${fmt(s.t0, 4)}</td>
        <td>${fmt(s.t1, 4)}</td>
        <td>${fmt(s.weight, 4)}</td>
        <td>${(s.share * 100).toFixed(1)}%</td>
        <td>
          <div class="bar"><i style="width:${(s.share * 100).toFixed(1)}%;background:${colorCss(color)}"></i></div>
        </td>
        <td>${s.contribution.map((v) => fmt(v, 3)).join(', ')}</td>
      </tr>`;
  }).join('');

  const totalShare = r.segments.reduce((a, s) => a + s.share, 0);
  const sumStr = r.sum.map((v) => fmt(v, 4)).join(', ');
  const rgbStr = r.rgb.map((v) => fmt(v, 4)).join(', ');

  els.probeBody.innerHTML = `
    <div class="probe-grid">
      <div>
        <div class="pixel-readout">
          <span><span class="k">有效权重</span> <span class="v">${fmt(r.totalWeight, 4)}</span></span>
          <span><span class="k">窗口∩[0,1]</span> <span class="v">[${fmt(r.clipped[0], 3)}, ${fmt(r.clipped[1], 3)}]</span></span>
          <span><span class="k">分段</span> <span class="v">${r.segments.length}</span></span>
        </div>
        <div class="swatch-big">
          <div class="color-block" style="background:${colorCss(r.rgb)}"></div>
          <div class="vals">
            <b>归一化线性 RGB</b><br />
            ${rgbStr}<br />
            <span style="color:var(--text-muted)">加权积分 ${sumStr} ÷ ${fmt(r.totalWeight, 4)}</span>
          </div>
        </div>
        <table class="seg-table">
          <thead>
            <tr><th></th><th>来源</th><th>类型</th><th>起</th><th>止</th><th>权重</th><th>占比</th><th></th><th>贡献 RGB</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="9" style="color:var(--text-muted)">该像素在窗口内无有效曝光</td></tr>'}</tbody>
          <tfoot>
            <tr><td></td><td>合计</td><td></td><td></td><td></td><td>${fmt(r.totalWeight, 4)}</td><td>${(totalShare * 100).toFixed(1)}%</td><td></td><td></td></tr>
          </tfoot>
        </table>
      </div>
      <div class="timeline-card">
        <h3>窗口内时间分段</h3>
        <p class="hint">色块为该段的可见来源；上轨为权重函数，下轨为可见颜色，竖线为覆盖/遮挡事件时刻。</p>
        <svg id="timelineSvg" class="timeline-svg" role="img" aria-label="像素曝光时间分段"></svg>
      </div>
    </div>`;
  drawTimeline(r);
}

// ---------------------------------------------------------------------------
// 时间轴（像素分段）
// ---------------------------------------------------------------------------

function drawTimeline(r) {
  const svg = document.getElementById('timelineSvg');
  if (!svg) return;
  const NS = 'http://www.w3.org/2000/svg';
  const width = Math.max(260, svg.parentElement.clientWidth - 4);
  const H = 150;
  const padL = 34, padR = 8, padT = 10;
  const plotW = width - padL - padR;
  const ws = r.window[0], we = r.window[1];
  const span = we - ws || 1;
  const tToX = (t) => padL + ((t - ws) / span) * plotW;

  svg.setAttribute('viewBox', `0 0 ${width} ${H}`);
  svg.innerHTML = '';
  const g = document.createElementNS(NS, 'g');
  svg.appendChild(g);

  const muted = cssVar('--text-muted');
  const border = cssVar('--border');

  // 权重曲线轨（y: 10..52）
  const weightTop = padT;
  const weightH = 34;
  const weightY = (w) => weightTop + weightH * (1 - w);

  // 背景格
  const axis = document.createElementNS(NS, 'line');
  axis.setAttribute('x1', padL - 6);
  axis.setAttribute('x2', padL + plotW);
  axis.setAttribute('y1', weightTop + weightH);
  axis.setAttribute('y2', weightTop + weightH);
  axis.setAttribute('stroke', border);
  axis.setAttribute('stroke-width', '1');
  g.appendChild(axis);

  // 权重曲线：均匀=常数1，三角形=峰在中心
  const pts = [];
  const N = 80;
  const peak = (ws + we) / 2;
  const half = (we - ws) / 2;
  for (let i = 0; i <= N; i++) {
    const t = ws + (we - ws) * (i / N);
    let w;
    if (state.params.weight === 'uniform') w = 1;
    else w = half > 0 ? Math.max(0, 1 - Math.abs(t - peak) / half) : 0;
    pts.push(`${tToX(t)},${weightY(w)}`);
  }
  const path = document.createElementNS(NS, 'polyline');
  path.setAttribute('points', pts.join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', cssVar('--series-1'));
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  g.appendChild(path);

  // [0,1] 之外的裁剪区（灰覆盖）
  if (ws < 0 || we > 1) {
    const clipRanges = [];
    if (ws < 0) clipRanges.push([ws, Math.min(we, 0)]);
    if (we > 1) clipRanges.push([Math.max(ws, 1), we]);
    for (const [a, b] of clipRanges) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', tToX(a));
      rect.setAttribute('width', Math.max(0, tToX(b) - tToX(a)));
      rect.setAttribute('y', weightTop);
      rect.setAttribute('height', weightH);
      rect.setAttribute('fill', cssVar('--surface-3'));
      rect.setAttribute('opacity', '0.85');
      g.appendChild(rect);
    }
  }

  // 色带轨（y: 62..98）
  const bandTop = weightTop + weightH + 14;
  const bandH = 34;
  for (const s of r.segments) {
    const color = s.card >= 0 ? state.scene.cards[s.card].rgb : state.scene.background;
    const x0 = tToX(s.t0);
    const x1 = tToX(s.t1);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', x0 + 0.4);
    rect.setAttribute('width', Math.max(0.5, x1 - x0 - 0.8));
    rect.setAttribute('y', bandTop);
    rect.setAttribute('height', bandH);
    rect.setAttribute('fill', colorCss(color));
    rect.setAttribute('stroke', cssVar('--border-strong'));
    rect.setAttribute('stroke-width', s.card >= 0 ? '0' : '1');
    g.appendChild(rect);

    if (x1 - x0 > 44) {
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', (x0 + x1) / 2);
      label.setAttribute('y', bandTop + bandH / 2 + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '10');
      label.setAttribute('font-family', 'var(--mono)');
      label.setAttribute('fill', luminance(color) > 0.5 ? '#111' : '#fff');
      label.textContent = s.card >= 0 ? String(s.id) : 'bg';
      g.appendChild(label);
    }

    // 事件竖线
    for (const tt of [s.t0, s.t1]) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', tToX(tt));
      line.setAttribute('x2', tToX(tt));
      line.setAttribute('y1', weightTop);
      line.setAttribute('y2', bandTop + bandH);
      line.setAttribute('stroke', muted);
      line.setAttribute('stroke-width', '0.75');
      line.setAttribute('stroke-dasharray', '2 2');
      line.setAttribute('opacity', '0.6');
      g.appendChild(line);
    }
  }

  // 轴刻度
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const t = ws + (we - ws) * (i / ticks);
    const x = tToX(t);
    const tick = document.createElementNS(NS, 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('x2', x);
    tick.setAttribute('y1', bandTop + bandH);
    tick.setAttribute('y2', bandTop + bandH + 3);
    tick.setAttribute('stroke', border);
    g.appendChild(tick);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', bandTop + bandH + 14);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '9.5');
    label.setAttribute('fill', muted);
    label.setAttribute('font-family', 'var(--mono)');
    label.textContent = fmt(t, 2);
    g.appendChild(label);
  }

  const yLabelW = document.createElementNS(NS, 'text');
  yLabelW.setAttribute('x', padL - 6);
  yLabelW.setAttribute('y', weightTop + weightH / 2);
  yLabelW.setAttribute('text-anchor', 'end');
  yLabelW.setAttribute('dominant-baseline', 'middle');
  yLabelW.setAttribute('font-size', '9.5');
  yLabelW.setAttribute('fill', muted);
  yLabelW.textContent = '权重';
  g.appendChild(yLabelW);

  const yLabelC = document.createElementNS(NS, 'text');
  yLabelC.setAttribute('x', padL - 6);
  yLabelC.setAttribute('y', bandTop + bandH / 2);
  yLabelC.setAttribute('text-anchor', 'end');
  yLabelC.setAttribute('dominant-baseline', 'middle');
  yLabelC.setAttribute('font-size', '9.5');
  yLabelC.setAttribute('fill', muted);
  yLabelC.textContent = '来源';
  g.appendChild(yLabelC);
}

function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

// ---------------------------------------------------------------------------
// 扫描窗口迷你图
// ---------------------------------------------------------------------------

function drawScanChart() {
  const svg = els.scanSvg;
  if (!svg || !state.scene) return;
  const NS = 'http://www.w3.org/2000/svg';
  const width = 280;
  const rowCount = state.scene.H;
  const padL = 26, padR = 8, padT = 8, padB = 16;
  const heights = Math.max(60, Math.min(120, rowCount * 9));
  const H = padT + heights + padB;
  svg.setAttribute('viewBox', `0 0 ${width} ${H}`);
  svg.innerHTML = '';

  // 时间范围：包含所有窗口，并至少覆盖 [0,1]
  const windows = [];
  for (let py = 0; py < rowCount; py++) windows.push(exposureWindow(py, rowCount, state.params));
  let tMin = Math.min(0, ...windows.map((w) => w[0]));
  let tMax = Math.max(1, ...windows.map((w) => w[1]));
  if (tMax - tMin < 1e-9) tMax = tMin + 1;
  const plotW = width - padL - padR;
  const tToX = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const rowH = heights / rowCount;

  const muted = cssVar('--text-muted');
  const border = cssVar('--border');

  // [0,1] 参考带
  const ref = document.createElementNS(NS, 'rect');
  ref.setAttribute('x', tToX(0));
  ref.setAttribute('width', Math.max(0, tToX(1) - tToX(0)));
  ref.setAttribute('y', padT);
  ref.setAttribute('height', heights);
  ref.setAttribute('fill', cssVar('--surface-2'));
  svg.appendChild(ref);

  const series1 = cssVar('--series-1');
  for (let py = 0; py < rowCount; py++) {
    const w = windows[py];
    const x0 = tToX(w[0]);
    const x1 = tToX(w[1]);
    const y = padT + py * rowH;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', x0);
    rect.setAttribute('width', Math.max(1, x1 - x0));
    rect.setAttribute('y', y + 0.5);
    rect.setAttribute('height', Math.max(1.5, rowH - 1.5));
    rect.setAttribute('fill', series1);
    rect.setAttribute('opacity', '0.82');
    rect.setAttribute('rx', '1.5');
    svg.appendChild(rect);
  }

  // 轴
  const axisY = padT + heights;
  const axis = document.createElementNS(NS, 'line');
  axis.setAttribute('x1', padL);
  axis.setAttribute('x2', width - padR);
  axis.setAttribute('y1', axisY);
  axis.setAttribute('y2', axisY);
  axis.setAttribute('stroke', border);
  svg.appendChild(axis);

  // 轴刻度：去重且避免标签重叠
  const tickSet = [...new Set([tMin, 0, 1, tMax])]
    .filter((t) => t >= tMin - 1e-9 && t <= tMax + 1e-9)
    .sort((a, b) => a - b);
  const placed = [];
  for (const t of tickSet) {
    const x = tToX(t);
    if (placed.some((px) => Math.abs(px - x) < 26)) continue;
    placed.push(x);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', axisY + 11);
    label.setAttribute('text-anchor', t === tMin ? 'start' : t === tMax ? 'end' : 'middle');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', muted);
    label.setAttribute('font-family', 'var(--mono)');
    label.textContent = fmt(t, 2);
    svg.appendChild(label);
  }

  const topLabel = document.createElementNS(NS, 'text');
  topLabel.setAttribute('x', padL - 6);
  topLabel.setAttribute('y', padT + 4);
  topLabel.setAttribute('text-anchor', 'end');
  topLabel.setAttribute('font-size', '9');
  topLabel.setAttribute('fill', muted);
  topLabel.setAttribute('font-family', 'var(--mono)');
  topLabel.textContent = state.params.scanDir === 'down' ? '顶行' : '底行';
  svg.appendChild(topLabel);

  const botLabel = document.createElementNS(NS, 'text');
  botLabel.setAttribute('x', padL - 6);
  botLabel.setAttribute('y', axisY - 2);
  botLabel.setAttribute('text-anchor', 'end');
  botLabel.setAttribute('font-size', '9');
  botLabel.setAttribute('fill', muted);
  botLabel.setAttribute('font-family', 'var(--mono)');
  botLabel.textContent = state.params.scanDir === 'down' ? '底行' : '顶行';
  svg.appendChild(botLabel);
}

// ---------------------------------------------------------------------------
// 导入 / 错误
// ---------------------------------------------------------------------------

async function importFile(file) {
  try {
    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ValidationError([`不是合法 JSON：${e.message}`]);
    }
    // 支持两种形态：{ background, cases:[...] } 或 单个 case { size, cards }
    const parsed = parseImportShape(raw);
    applyCaseSet(parsed, { keepCaseId: null });
  } catch (e) {
    showError(e);
  }
}

function parseImportShape(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.cases)) {
    return parseCaseSet(raw);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.cards)) {
    return parseCaseSet({ background: raw.background, cases: [raw] });
  }
  throw new ValidationError(['JSON 顶层应为 { background?, cases: [...] } 或单个 { size, cards } 场景']);
}

function showError(e) {
  const msgList = e instanceof ValidationError ? e.messages : [String(e && e.message ? e.message : e)];
  els.errorList.innerHTML = msgList.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
  els.errorBanner.hidden = false;
  els.errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

function togglePlay() {
  state.playing = !state.playing;
  els.playBtn.textContent = state.playing ? '❚❚' : '▶';
  if (state.playing) {
    let last = performance.now();
    const step = (now) => {
      if (!state.playing) return;
      const dt = (now - last) / 1000;
      last = now;
      state.time = (state.time + dt * 0.35) % 1;
      els.timeRange.value = String(state.time);
      els.tReadout.textContent = fmt(state.time, 3);
      drawInstant();
      state.playRAF = requestAnimationFrame(step);
    };
    state.playRAF = requestAnimationFrame(step);
  } else {
    cancelAnimationFrame(state.playRAF);
  }
}

// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  if (!state.scene) return;
  resizeCanvases();
  drawInstant();
  if (state.integrated) drawIntegrated();
  if (state.probe) {
    const r = integratePixel(state.scene, state.probe.px, state.probe.py, state.params, true);
    drawTimeline(r);
  }
});

boot();
