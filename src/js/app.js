// 主线程控制器：文件导入、Worker 调度、图像绘制、像素检查与导出。
// 不做任何双目计算；所有算法在 core.js（Worker 内）里。
import { decodePng, encodeGray16 } from './png.js';
import { normalizeParams, validatePair, InputError, encodeDisparity16, leftRightCheck, INVALID_COST } from './core.js';
import { lineChart, formatNumber } from './viz.js';
import { SAMPLES } from './samples.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'), notice: $('notice'),
  sample: $('sample-select'), run: $('run'),
  leftFile: $('left-file'), rightFile: $('right-file'), truthFile: $('truth-file'),
  minD: $('min-d'), maxD: $('max-d'), p1: $('p1'), p2: $('p2'),
  uniq: $('uniq'), lrthr: $('lrthr'), subpix: $('subpix'),
  exportPng: $('export-png'), exportParams: $('export-params'),
  mainCv: $('main-cv'), sideCv: $('side-cv'), marker: $('marker'), sideCap: $('side-cap'),
  viewLegend: $('view-legend'), viewScale: $('view-scale'), scaleRamp: $('scale-ramp'),
  scaleMin: $('scale-min'), scaleMax: $('scale-max'),
  pixEmpty: $('pix-empty'), pixBody: $('pix-body'), pixSub: $('pix-sub'),
  pixHead: $('pix-head'), pixChain: $('pix-chain'),
  chartCost: $('chart-cost'), chartSum: $('chart-sum'),
  chartDirs: $('chart-dirs'), dirsLegend: $('dirs-legend'),
  candTbl: $('cand-tbl'), revBody: $('rev-body'),
  kpis: $('kpis'), evalSub: $('eval-sub'), evalHint: $('eval-hint'),
  probePath: $('probe-path'), probeEnc: $('probe-enc'), probeLr: $('probe-lr'),
  showPair: $('show-pair'), themeBtn: $('theme-btn'),
};

const state = {
  left: null,    // { width, height, bitDepth, gray: Uint8Array, data: Uint16Array }
  right: null,
  truth: null,   // { width, height, data: Uint16Array }
  result: null,  // Worker 回传的 payload
  stats: null,
  evaluation: null,
  view: 'disp',
  selected: null,       // { x, y }
  explain: null,
  seq: 0,
  running: false,
  lastParams: null,
  paramsOk: true,
};

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let msgSeq = 0;

function callWorker(msg, transfer = []) {
  const id = ++msgSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

worker.onmessage = (ev) => {
  const m = ev.data || {};
  const entry = pending.get(m.id);
  if (entry) pending.delete(m.id);
  if (m.type === 'error') {
    const err = new Error(m.message);
    err.name = m.name;
    if (entry) entry.reject(err);
    else fail(m.message);
    return;
  }
  if (entry) entry.resolve(m);
};

// ---------------------------------------------------------------------------
// 状态与提示
// ---------------------------------------------------------------------------
function setStatus(kind, text) {
  els.status.className = kind || '';
  els.status.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  els.status.append(dot, document.createTextNode(text));
}

function showNotice(text, kind = '') {
  els.notice.textContent = text;
  els.notice.className = kind ? `show ${kind}` : '';
}

function clearNotice() { els.notice.className = ''; els.notice.textContent = ''; }

function fail(text) {
  state.running = false;
  setStatus('err', '出错');
  showNotice(text, 'err');
  els.run.disabled = false;
  els.run.textContent = '计算';
}

// ---------------------------------------------------------------------------
// 参数读写与校验
// ---------------------------------------------------------------------------
function readParams() {
  return {
    minDisparity: Number(els.minD.value),
    maxDisparity: Number(els.maxD.value),
    P1: Number(els.p1.value),
    P2: Number(els.p2.value),
    uniqueness: Number(els.uniq.value),
    lrThreshold: Number(els.lrthr.value),
    subpixel: els.subpix.checked,
  };
}

function paramsMismatch() {
  if (!state.result) return false;
  const a = state.result.params;
  const b = readParams();
  try {
    const nb = normalizeParams(b);
    return ['minDisparity', 'maxDisparity', 'P1', 'P2', 'uniqueness', 'lrThreshold', 'subpixel']
      .some((k) => a[k] !== nb[k]);
  } catch { return true; }
}

// ---------------------------------------------------------------------------
// 图像加载
// ---------------------------------------------------------------------------
async function decodePairFile(file, label) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const img = await decodePng(buf);
  if (img.colorType !== 0) throw new InputError(`${label} 必须是灰度 PNG（无 Alpha、非 RGB）`);
  const gray = new Uint8Array(img.width * img.height);
  if (img.bitDepth === 8) {
    for (let i = 0; i < gray.length; i++) gray[i] = img.data[i];
  } else {
    for (let i = 0; i < gray.length; i++) gray[i] = img.data[i] >> 8;
  }
  return { width: img.width, height: img.height, bitDepth: img.bitDepth, gray, data: img.data };
}

function syncPairValidity() {
  const ok = !!(state.left && state.right);
  els.run.disabled = !ok || state.running;
  if (!ok) { els.exportPng.disabled = true; els.exportParams.disabled = true; }
}

async function loadSample(name) {
  if (!name) return;
  clearNotice();
  try {
    const left = await decodeB64(SAMPLES.left, 'left.png');
    const right = await decodeB64(SAMPLES[name === 'flat' ? 'right-flat' : 'right-occlusion'], 'right.png');
    const truth = await decodeB64(SAMPLES[name === 'flat' ? 'truth-flat' : 'truth-occlusion'], 'truth.png');
    state.left = left; state.right = right; state.truth = truth;
    state.result = null; state.explain = null; state.selected = null;
    resetPixelPanel();
    setStatus('', '样例已载入');
    showNotice(`已载入样例「${name === 'flat' ? '常视差' : '遮挡'}」：左/右 ${left.width}×${left.height}，真值 ${truth.bitDepth} 位。`, 'ok');
    syncPairValidity();
    await runCompute();
  } catch (e) {
    fail(`样例载入失败：${e.message}`);
  }
}

async function decodeB64(b64, label) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const img = await decodePng(bytes);
  const gray = new Uint8Array(img.width * img.height);
  if (img.bitDepth === 8) {
    for (let i = 0; i < gray.length; i++) gray[i] = img.data[i];
  } else {
    for (let i = 0; i < gray.length; i++) gray[i] = img.data[i] >> 8;
  }
  return { width: img.width, height: img.height, bitDepth: img.bitDepth, gray, data: img.data, label };
}

// ---------------------------------------------------------------------------
// 执行计算
// ---------------------------------------------------------------------------
async function runCompute() {
  if (!state.left || !state.right || state.running) return;
  clearNotice();
  let params;
  try {
    params = normalizeParams(readParams());
    validatePair(state.left, state.right);
    if (state.truth) {
      if (state.truth.width !== state.left.width || state.truth.height !== state.left.height) {
        throw new InputError(`真值尺寸 ${state.truth.width}×${state.truth.height} 与左右图不一致`);
      }
    }
  } catch (e) {
    showNotice(e.message, 'err');
    setStatus('err', '参数或输入不合法');
    return;
  }

  state.running = true;
  els.run.disabled = true;
  els.run.textContent = '计算中…';
  els.exportPng.disabled = true;
  els.exportParams.disabled = true;
  setStatus('busy', '计算中…');
  const seq = ++state.seq;

  const truthCopy = state.truth ? state.truth.data.slice() : null;
  const msg = {
    type: 'compute',
    width: state.left.width,
    height: state.left.height,
    left: state.left.gray.slice().buffer,
    right: state.right.gray.slice().buffer,
    params,
    truth: truthCopy ? truthCopy.buffer : null,
  };
  const transfer = [msg.left, msg.right];
  if (msg.truth) transfer.push(msg.truth);

  try {
    const t0 = performance.now();
    const res = await callWorker(msg, transfer);
    if (seq !== state.seq) return; // 过期响应
    state.result = res.payload;
    state.stats = res.stats;
    state.evaluation = res.evaluation;
    state.lastParams = params;
    state.running = false;
    state.explain = null;
    els.run.disabled = false;
    els.run.textContent = '计算';
    const ms = performance.now() - t0;
    setStatus('ok', `已计算 · ${ms.toFixed(0)} ms`);
    onResult();
  } catch (e) {
    if (seq !== state.seq) return;
    state.running = false;
    els.run.disabled = false;
    els.run.textContent = '计算';
    showNotice(`计算失败：${e.message}`, 'err');
    setStatus('err', '计算失败');
  }
}

// ---------------------------------------------------------------------------
// 结果渲染
// ---------------------------------------------------------------------------
function onResult() {
  if (!state.result) return;
  const { width: W, height: H } = state.result;
  els.mainCv.width = W; els.mainCv.height = H;
  els.sideCv.width = W; els.sideCv.height = H;
  // 保持选择
  if (state.selected) {
    const { x, y } = state.selected;
    if (x >= W || y >= H) state.selected = null;
  }
  renderStats();
  renderMainView();
  renderSideView();
  renderEvaluation();
  if (state.selected) selectPixel(state.selected.x, state.selected.y, true);
  else resetPixelPanel();
  els.exportPng.disabled = false;
  els.exportParams.disabled = false;
  updateStaleHint();
}

function updateStaleHint() {
  if (paramsMismatch()) {
    showNotice('参数已改动但尚未重新计算 —— 点击“计算”应用。', '');
  } else {
    clearNotice();
  }
}

// 无效原因 → 颜色（三色类 + 文字标签，不靠颜色单独表意）
const REASONS = [
  { key: 0, label: '通过（有效）', color: 'var(--series-3)' },
  { key: 1, label: '无有效原始代价（窗口/越界）', color: 'var(--series-1)' },
  { key: 2, label: '唯一性未通过', color: 'var(--series-2)' },
  { key: 3, label: '左右一致性未通过', color: 'var(--invalid)' },
];

function dispColor(d, dmin, dmax) {
  // 单色蓝顺序色阶（浅→深）
  const t = Math.max(0, Math.min(1, (d - dmin) / Math.max(1e-9, dmax - dmin)));
  const stops = [[205, 226, 251], [134, 182, 239], [57, 135, 229], [37, 106, 191], [13, 54, 107]];
  const p = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = stops[i], b = stops[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

function renderMainView() {
  const res = state.result;
  if (!res) return;
  const { width: W, height: H } = res;
  const ctx = els.mainCv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const { minDisparity: dmin, maxDisparity: dmax } = res.params;
  const truth = state.truth;

  for (let i = 0, n = W * H; i < n; i++) {
    const x = i % W, y = (i / W) | 0;
    let r, g, b;
    const val = res.final[i];
    const valid = !Number.isNaN(val);
    switch (state.view) {
      case 'disp':
        if (valid) { [r, g, b] = dispColor(val, dmin, dmax); }
        else { r = g = b = 18; }
        break;
      case 'invalid':
        if (valid) { r = 235; g = 237; b = 233; }
        else { r = 45; g = 45; b = 42; }
        break;
      case 'reason': {
        const rgb = reasonRgb(res.reason[i]);
        r = rgb[0]; g = rgb[1]; b = rgb[2];
        break;
      }
      case 'left': {
        const v = state.left.gray[i]; r = g = b = v; break;
      }
      case 'right': {
        // 按视差把右图对齐到左图坐标：像素 (x,y) 显示右图 x−d 处。
        // 这样选中的左像素与画面像素一一对应；无效点无可对齐位置，显示为暗色。
        if (!valid) { r = 26; g = 26; b = 25; break; }
        const xr = Math.floor(x - val + 0.5);
        if (xr < 0 || xr >= W) { r = 26; g = 26; b = 25; break; }
        const v = state.right.gray[y * W + xr]; r = g = b = v; break;
      }
      case 'error': {
        if (!truth) { r = g = b = 28; break; }
        const t = truth.data[i];
        if (t === 0) { r = 33; g = 33; b = 31; break; }
        if (!valid) { r = 60; g = 66; b = 78; break; }
        const td = (t - 1) / 256;
        const e = Math.abs(val - td);
        if (e <= 1) { r = 200; g = 236; b = 214; }
        else { r = 208; g = 59; b = 59; }
        break;
      }
      default: r = g = b = 0;
    }
    const o = i * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  renderLegend();
  positionMarker();
}

function reasonRgb(reason) {
  switch (reason) {
    case 0: return [27, 175, 122];
    case 1: return [42, 120, 214];
    case 2: return [235, 104, 52];
    default: return [43, 43, 41];
  }
}

function renderLegend() {
  const res = state.result;
  const leg = els.viewLegend;
  leg.textContent = '';
  const add = (kind, color, text) => {
    const span = document.createElement('span');
    span.className = 'key';
    const sw = document.createElement('span');
    sw.className = kind;
    sw.style.background = color;
    span.append(sw, document.createTextNode(text));
    leg.appendChild(span);
  };
  if (state.view === 'disp') {
    add('sw', 'var(--invalid)', '无效（窗口不完整 / 越界 / 未通过检验）');
    els.viewScale.hidden = false;
    const { minDisparity: dmin, maxDisparity: dmax } = res.params;
    els.scaleMin.textContent = formatNumber(dmin);
    els.scaleMax.textContent = formatNumber(dmax);
    els.scaleRamp.style.background = 'linear-gradient(90deg,#cde2fb,#86b6ef,#3987e5,#256abf,#0d366b)';
    // 视差 0 与无效区分：零视差是色阶最浅端，无效是纯黑
    const zero = document.createElement('span');
    zero.className = 'key';
    zero.innerHTML = '<span class="sw" style="background:#cde2fb"></span>';
    zero.append(document.createTextNode(' 视差 0（有效，色阶最浅）'));
    leg.appendChild(zero);
  } else if (state.view === 'reason') {
    for (const r of REASONS) add('sw', r.color, r.label);
    els.viewScale.hidden = true;
  } else if (state.view === 'invalid') {
    add('sw', '#ebedea', '有效'); add('sw', '#2d2d2a', '无效');
    els.viewScale.hidden = true;
  } else if (state.view === 'right') {
    add('sw', '#1a1a19', '无可对齐位置（该点无效）');
    const note = document.createElement('span');
    note.textContent = '按视差对齐到左图坐标：像素 x 显示右图 x−d';
    leg.appendChild(note);
    els.viewScale.hidden = true;
  } else if (state.view === 'left') {
    add('sw', '#000', '灰度原图');
    els.viewScale.hidden = true;
  } else if (state.view === 'error') {
    add('sw', '#c8ecd6', '误差 ≤1px'); add('sw', '#d03b3b', '误差 >1px');
    add('sw', '#42424e', '无有效视差'); add('sw', '#21211f', '真值无效');
    els.viewScale.hidden = true;
  } else {
    els.viewScale.hidden = true;
  }
}

function renderStats() {
  els.pixSub.textContent = state.selected ? `(${state.selected.x}, ${state.selected.y})` : '点击图像';
  renderEvaluation();
}

function renderEvaluation() {
  const res = state.result;
  const ev = state.evaluation;
  const st = state.stats;
  const k = els.kpis;
  k.textContent = '';
  const add = (label, value, note, cls = '') => {
    const d = document.createElement('div');
    d.className = `kpi ${cls}`.trim();
    const a = document.createElement('div'); a.className = 'k'; a.textContent = label;
    const b = document.createElement('div'); b.className = 'v'; b.textContent = value;
    const c = document.createElement('div'); c.className = 'n'; c.textContent = note;
    d.append(a, b, c);
    k.appendChild(d);
  };
  const total = res.width * res.height;
  if (ev) {
    const covPct = (ev.coverage * 100).toFixed(2) + '%';
    const errPct = (ev.errorRate * 100).toFixed(2) + '%';
    const covPass = ev.coverage >= 0.9;
    const errPass = ev.errorRate <= 0.02;
    add('评估区有效率', covPct, `有效 ${ev.validCount} / 真值 ${ev.truthCount}`, covPass ? 'pass' : 'fail');
    add('误差 >1px 占比', errPct, `超差 ${ev.badCount} 点 · 均值 ${ev.meanAbsError.toFixed(2)}px`, errPass ? 'pass' : 'fail');
    add('全图有效点', String(st.valid), `共 ${total} 点 · 零视差 ${st.zeroDisparity}`, '');
    add('无效点', String(total - st.valid), `唯一性 ${st.reasonCounts[2]} · 一致性 ${st.reasonCounts[3]} · 无代价 ${st.reasonCounts[1]}`, '');
    els.evalSub.textContent = covPass && errPass ? '✓ 达标（有效率≥90%，误差率≤2%）' : '✗ 未达标';
    els.evalHint.textContent = `有效率 = 有效点/真值有效点；误差率 = 有效点中 |d−真值|>1px 的比例。真值未标注处另有 ${ev.falseValid} 点给出视差，不计入评估。`;
  } else {
    add('全图有效点', String(st.valid), `共 ${total} 点`);
    add('零视差（有效）', String(st.zeroDisparity), '与“无效”分开统计', '');
    add('无效点', String(st.reasonCounts[1] + st.reasonCounts[2] + st.reasonCounts[3]), '见“无效原因”视图', '');
    add('有效率', '—', '未导入真值', '');
    els.evalSub.textContent = '— 无真值';
    els.evalHint.textContent = '导入 16 位真值图后，按包内约定统计有效率与 1 像素误差率。';
  }
}

// ---------------------------------------------------------------------------
// 选择与联动
// ---------------------------------------------------------------------------
function canvasToPixel(cv, evt) {
  const rect = cv.getBoundingClientRect();
  const x = Math.floor(((evt.clientX - rect.left) / rect.width) * cv.width);
  const y = Math.floor(((evt.clientY - rect.top) / rect.height) * cv.height);
  if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return null;
  return { x, y };
}

els.mainCv.addEventListener('pointerdown', (e) => {
  const p = canvasToPixel(els.mainCv, e);
  if (p) selectPixel(p.x, p.y);
});
els.mainCv.setAttribute('tabindex', '0');
els.mainCv.addEventListener('keydown', (e) => {
  if (!state.result) return;
  const cur = state.selected || { x: (state.result.width / 2) | 0, y: (state.result.height / 2) | 0 };
  const step = e.shiftKey ? 8 : 1;
  let { x, y } = cur;
  if (e.key === 'ArrowLeft') x -= step;
  else if (e.key === 'ArrowRight') x += step;
  else if (e.key === 'ArrowUp') y -= step;
  else if (e.key === 'ArrowDown') y += step;
  else return;
  e.preventDefault();
  x = Math.max(0, Math.min(state.result.width - 1, x));
  y = Math.max(0, Math.min(state.result.height - 1, y));
  selectPixel(x, y);
});
els.sideCv.addEventListener('pointerdown', (e) => {
  // 右图为基准：右像素 (xr,y) 对应左图 x = floor(xr + d_right + .5)（不是 x − d）
  const p = canvasToPixel(els.sideCv, e);
  if (!p || !state.result) return;
  pickFromRight(p.x, p.y);
});

function positionMarker() {
  const res = state.result;
  const m = els.marker;
  const old = document.getElementById('pairline');
  if (old) old.remove();
  if (!res || !state.selected) { m.style.display = 'none'; return; }
  const { x, y } = state.selected;
  const rect = els.mainCv.getBoundingClientRect();
  const parent = els.mainCv.parentElement.getBoundingClientRect();
  const sx = rect.width / res.width, sy = rect.height / res.height;
  m.style.display = 'block';
  m.style.left = `${rect.left - parent.left + x * sx}px`;
  m.style.top = `${rect.top - parent.top + y * sy}px`;
  m.style.width = `${Math.max(1, sx)}px`;
  m.style.height = `${Math.max(1, sy)}px`;
  drawPairLine(rect);
}

function drawPairLine(mainRect) {
  if (!els.showPair.checked || !state.result || !state.selected) return;
  const res = state.result;
  const sel = state.selected;
  const stage = els.mainCv.closest('.canvas-stage');
  if (!stage) return;
  const parentRect = stage.getBoundingClientRect();
  const d = res.final[sel.y * res.width + sel.x];
  if (Number.isNaN(d)) return;
  const xr = Math.floor(sel.x - d + 0.5);
  if (xr < 0 || xr >= res.width) return;
  const sideRect = els.sideCv.getBoundingClientRect();
  if (sideRect.width === 0) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'pairline';
  svg.setAttribute('width', parentRect.width);
  svg.setAttribute('height', parentRect.height);
  svg.style.position = 'absolute';
  svg.style.left = '0px';
  svg.style.top = '0px';
  svg.style.width = `${parentRect.width}px`;
  svg.style.height = `${parentRect.height}px`;
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '3';
  const x1 = mainRect.left - parentRect.left + (sel.x + 0.5) * (mainRect.width / res.width);
  const y1 = mainRect.top - parentRect.top + (sel.y + 0.5) * (mainRect.height / res.height);
  const x2 = sideRect.left - parentRect.left + (xr + 0.5) * (sideRect.width / res.width);
  const y2 = sideRect.top - parentRect.top + (sel.y + 0.5) * (sideRect.height / res.height);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  line.setAttribute('stroke', 'var(--series-2)');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-dasharray', '4 3');
  line.setAttribute('opacity', '0.85');
  svg.appendChild(line);
  stage.appendChild(svg);
}

async function selectPixel(x, y, silent = false) {
  if (!state.result) return;
  state.selected = { x, y };
  positionMarker();
  renderSideView();
  els.pixSub.textContent = `(${x}, ${y})`;
  try {
    const res = await callWorker({ type: 'explain', x, y, reverse: false });
    if (!state.selected || state.selected.x !== x || state.selected.y !== y) return;
    state.explain = res;
    renderPixelPanel(res);
  } catch (e) {
    if (!silent) showNotice(`像素回放失败：${e.message}`, 'err');
  }
}

function renderSideView() {
  const res = state.result;
  if (!res) { els.sideCap.textContent = '右图对应区'; return; }
  const ctx = els.sideCv.getContext('2d');
  const { width: W, height: H } = res;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  // 副图始终显示右图原图：左像素 (x,y) ↔ 右图 x−d，对应关系直接可读
  const src = state.right;
  for (let i = 0; i < W * H; i++) {
    const v = src ? src.gray[i] : 0;
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
  }
  // 对应点高亮
  if (state.selected) {
    const sel = state.selected;
    const dv = res.final[sel.y * W + sel.x];
    if (!Number.isNaN(dv)) {
      const xr = Math.floor(sel.x - dv + 0.5);
      if (xr >= 0 && xr < W) {
        const o = (sel.y * W + xr) * 4;
        d[o] = 235; d[o + 1] = 104; d[o + 2] = 52;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const dv = state.selected ? res.final[state.selected.y * W + state.selected.x] : NaN;
  const xr = state.selected && !Number.isNaN(dv) ? Math.floor(state.selected.x - dv + 0.5) : null;
  els.sideCap.innerHTML = xr === null
    ? '右图对应区（该点无效，无对应）'
    : `右图对应区 · <b>x = ${xr}</b>（x − d 四舍五入）· 点右图可反查左图`;
}

// 右图点 → 左图对应点：x_left = floor(x_r + d_right + .5)
function pickFromRight(xr, y) {
  const res = state.result;
  const p = y * res.width + xr;
  const dR = res.dRev[p];
  if (Number.isNaN(dR)) {
    showNotice(`右图 (${xr}, ${y}) 在右图为基准时无效，无法反查左图对应点。`, 'err');
    return;
  }
  const xl = Math.floor(xr + dR + 0.5);
  if (xl < 0 || xl >= res.width) {
    showNotice(`右图 (${xr}, ${y}) 的 d=${dR.toFixed(3)} 反查左图 x=${xl} 越界。`, 'err');
    return;
  }
  selectPixel(xl, y);
  showNotice(`右图 (${xr}, ${y}) → 左图 x = floor(${xr} + ${dR.toFixed(3)} + .5) = ${xl}`, 'ok');
}

// ---------------------------------------------------------------------------
// 像素核对面板
// ---------------------------------------------------------------------------
function resetPixelPanel() {
  els.pixEmpty.hidden = false;
  els.pixBody.hidden = true;
  els.pixSub.textContent = '点击图像';
  els.marker.style.display = 'none';
  const pl = document.getElementById('pairline'); if (pl) pl.remove();
}

function reasonLabel(reason) {
  return ['有效', '无有效原始代价', '唯一性未通过', '左右一致性未通过'][reason] || '未知';
}

function renderPixelPanel(ex) {
  const res = state.result;
  const { x, y } = ex;
  const W = res.width;
  const p = y * W + x;
  const dmin = res.params.minDisparity;
  const di = res.d0i[p];
  els.pixEmpty.hidden = true;
  els.pixBody.hidden = false;

  els.pixHead.textContent = '';
  const mk = (tag, txt, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = txt; return e; };
  els.pixHead.append(
    mk('span', '像素 ', ''), mk('b', `(${x}, ${y})`),
    mk('span', ` 原始代价有效候选 ${countValid(res, ex.cost)}/${res.D}`, ''),
  );
  const dv = res.final[p];
  const valid = !Number.isNaN(dv);
  const badge = document.createElement('span');
  badge.className = `badge ${valid ? 'good' : 'bad'}`;
  badge.textContent = valid ? '✓ 有效' : `✗ 无效 · ${reasonLabel(res.reason[p])}`;
  els.pixHead.appendChild(badge);

  // 一致性链：d0 → +delta → 反向 → 最终
  const chain = els.pixChain;
  chain.textContent = '';
  const d0 = di >= 0 ? dmin + di : NaN;
  const rawD = di >= 0 ? dmin + di : NaN;
  const dbefore = di >= 0 ? (Number.isNaN(res.dFwd[p]) ? NaN : res.dFwd[p]) : NaN;
  const dRev = res.dRAt[p];
  const cell = (k, v, w = false) => {
    const sp = document.createElement('span');
    if (w) sp.className = 'w';
    sp.textContent = `${k} ${v}`;
    chain.appendChild(sp);
  };
  cell('d₀', Number.isNaN(rawD) ? '—' : String(rawD));
  cell('δ', Number.isNaN(res.delta[p]) ? '—' : res.delta[p].toFixed(3));
  cell('d左', Number.isNaN(dbefore) ? '—' : dbefore.toFixed(3));
  cell('d右@x−d', Number.isNaN(dRev) ? '—' : dRev.toFixed(3));
  cell('|差|', Number.isNaN(dbefore) || Number.isNaN(dRev) ? '—' : Math.abs(dbefore - dRev).toFixed(3));
  cell('阈值', String(res.params.lrThreshold));
  cell('最终', Number.isNaN(dv) ? '无效' : dv.toFixed(3), true);

  // 代价：原始代价与聚合代价分两图（量级差两个数量级，共用一轴会把原始代价压平）
  const xs = [];
  for (let k = 0; k < res.D; k++) xs.push(dmin + k);
  const dsel = Number.isNaN(dv) ? null : dv;
  const costVals = Array.from(ex.cost).map((v) => (v === INVALID_COST ? null : v));
  lineChart(els.chartCost, xs, [
    { key: 'cost', label: '原始代价 C', color: 'var(--series-1)', values: costVals },
  ], {
    height: 130, zeroBase: true, markIndex: dsel, xLabel: '候选视差 d',
    ariaLabel: `像素 (${x},${y}) 的原始 Census 代价`,
    gapMarks: costVals.map((v) => v === null),
  });
  lineChart(els.chartSum, xs, [
    { key: 'sum', label: '聚合代价 Σ L', color: 'var(--series-2)', values: Array.from(ex.sum), fill: true },
  ], {
    height: 150, zeroBase: true, markIndex: dsel, xLabel: '候选视差 d',
    ariaLabel: `像素 (${x},${y}) 的聚合代价曲线`,
  });

  // 八方向 L 曲线：每条路径的完整曲线（小多图），读出该方向在 d₀ 的贡献
  renderDirMultiples(ex, xs, di);

  // 候选数值表
  renderCandTable(ex, xs, dsel);

  // 反向一致性
  els.revBody.textContent = '';
  const rv = (k, v, w) => {
    const s = document.createElement('span');
    if (w) s.className = 'w';
    s.textContent = `${k} ${v}`;
    els.revBody.appendChild(s);
  };
  rv('反向最优 d', Number.isNaN(res.dRev[p]) ? '—' : res.dRev[p].toFixed(3));
  rv('反向原因', reasonLabel(res.reasonRev[p]));
  rv('右图取样 x', !Number.isNaN(dv) ? Math.floor(x - dv + 0.5) : '—');
  rv('读取的反向视差', Number.isNaN(res.dRAt[p]) ? '—' : res.dRAt[p].toFixed(3));
  const diff = !Number.isNaN(res.dFwd[p]) && !Number.isNaN(res.dRAt[p]) ? Math.abs(res.dFwd[p] - res.dRAt[p]) : NaN;
  rv('|d左 − d右|', Number.isNaN(diff) ? '—' : diff.toFixed(3));
  rv('结论', valid ? '通过' : '未通过', true);
}

function countValid(res, cost) {
  let n = 0;
  for (let i = 0; i < cost.length; i++) if (cost[i] !== INVALID_COST) n++;
  return n;
}

function renderLineLegend(container, series) {
  container.textContent = '';
  for (const s of series) {
    const span = document.createElement('span');
    span.className = 'key';
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.style.background = s.color;
    span.append(ln, document.createTextNode(s.label));
    container.appendChild(span);
  }
}

function renderCandTable(ex, xs, dsel) {
  const res = state.result;
  const t = els.candTbl;
  t.textContent = '';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const h of ['d', 'C 原始', 'ΣL 聚合', 'S2?', '与最优差']) {
    const th = document.createElement('th');
    th.textContent = h;
    if (h !== 'd' && h !== 'S2?') th.className = 'mono';
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  t.appendChild(thead);
  const tb = document.createElement('tbody');
  const p = state.selected.y * res.width + state.selected.x;
  const best = res.d0i[p];
  const S0 = res.S0[p];
  for (let k = 0; k < res.D; k++) {
    const tr = document.createElement('tr');
    const isBest = k === best;
    if (isBest) tr.className = 'sel';
    const cells = [
      String(xs[k]),
      ex.cost[k] === INVALID_COST ? '越界/无效' : String(ex.cost[k]),
      Number.isFinite(ex.sum[k]) ? ex.sum[k].toFixed(1) : '—',
      Math.abs(k - best) <= 1 ? '排除' : (k === best ? '最优' : ''),
      Number.isFinite(ex.sum[k]) ? (ex.sum[k] - S0).toFixed(1) : '—',
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i >= 1 && i !== 3) td.className = 'mono';
      if (isBest && i === 2) td.className = 'mono win';
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  t.appendChild(tb);
}

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------
for (const btn of document.querySelectorAll('.tabs [role=tab]')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tabs [role=tab]')) b.setAttribute('aria-selected', String(b === btn));
    state.view = btn.dataset.view;
    renderMainView();
    renderSideView();
  });
}
els.showPair.addEventListener('change', positionMarker);

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportBaseName() {
  const s = els.sample.value;
  return `disparity-${s || 'custom'}-${state.result.width}x${state.result.height}`;
}

els.exportPng.addEventListener('click', async () => {
  if (!state.result) return;
  try {
    const { width: W, height: H, params } = state.result;
    const samples = encodeDisparity16(state.result.final, W, H);
    const meta = {
      minDisparity: params.minDisparity,
      maxDisparity: params.maxDisparity,
      P1: params.P1,
      P2: params.P2,
      uniqueness: params.uniqueness,
      lrThreshold: params.lrThreshold,
      subpixel: params.subpixel,
      encoding: 'gray16: 0=invalid, else 1+floor(256*d+0.5)',
      census: '5x5, center skipped, neighbor<center => 1, 24-bit hamming, oob cost 1000000',
      aggregation: '8 directions, L(p,d)=C+min(L(d),L(d-1)+P1,L(d+1)+P1,minL+P2)-minL, S=sum',
    };
    const bytes = await encodeGray16(samples, W, H, { Parameters: JSON.stringify(meta) });
    download(new Blob([bytes], { type: 'image/png' }), `${exportBaseName()}.png`);
    setStatus('ok', '已导出 16 位 PNG');
  } catch (e) {
    showNotice(`导出失败：${e.message}`, 'err');
  }
});

els.exportParams.addEventListener('click', () => {
  if (!state.result) return;
  const { params, width: W, height: H, timings } = state.result;
  const payload = {
    width: W, height: H,
    min_disparity: params.minDisparity,
    max_disparity: params.maxDisparity,
    P1: params.P1, P2: params.P2,
    uniqueness: params.uniqueness,
    lr_threshold: params.lrThreshold,
    subpixel: params.subpixel,
    encoding: { invalid: 0, value: '1+floor(256*d+0.5)' },
    census: { window: 5, bits: 24, oob_cost: 1000000 },
    aggregation: { directions: 8, formula: 'L=C+min(Ld,Ld-1+P1,Ld+1+P1,minL+P2)-minL', sum: 'S=sum(L)' },
    evaluation: state.evaluation,
    stats: state.stats,
    timings_ms: timings,
    truth: state.truth ? { width: state.truth.width, height: state.truth.height, bit_depth: state.truth.bitDepth } : null,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${exportBaseName()}.json`);
});

// ---------------------------------------------------------------------------
// 自检（页面内跑）
// ---------------------------------------------------------------------------
function runSelfChecks() {
  // 1) 路径递推探针：3 行、单列、3 个候选，沿垂直方向
  try {
    const costs = [[4, 0, 7], [3, 8, 1], [6, 2, 5]];
    const P1 = 2, P2 = 5;
    const D = 3;
    let prev = null, out = [];
    for (let y = 0; y < 3; y++) {
      const cur = new Array(D);
      if (y === 0) cur.splice(0, D, ...costs[y]);
      else {
        const m = Math.min(...prev);
        for (let d = 0; d < D; d++) {
          let b = prev[d];
          if (d > 0) b = Math.min(b, prev[d - 1] + P1);
          if (d < D - 1) b = Math.min(b, prev[d + 1] + P1);
          b = Math.min(b, m + P2);
          cur[d] = costs[y][d] + b - m;
        }
      }
      out.push(cur); prev = cur;
    }
    const expected = [[4, 0, 7], [5, 8, 3], [8, 4, 5]];
    const ok = JSON.stringify(out) === JSON.stringify(expected);
    els.probePath.textContent = `${ok ? '✓ 通过' : '✗ 不一致'}\n输入 ${JSON.stringify(costs)}\nP1=${P1} P2=${P2}\n得 ${JSON.stringify(out)}\n期 ${JSON.stringify(expected)}`;
  } catch (e) { els.probePath.textContent = `✗ ${e.message}`; }

  // 2) 编码：0 无效，其余 1+floor(256*d+0.5)；零视差 ≠ 无效
  try {
    const fin = new Float32Array([NaN, 0, 1, 1.5, 4.32, 63]);
    const enc = encodeDisparity16(fin, 6, 1);
    const want = [0, 1, 257, 385, 1107, 16129];
    const ok = Array.from(enc).every((v, i) => v === want[i]);
    els.probeEnc.textContent = `${ok ? '✓ 通过' : '✗ 不一致'}\nd=NaN→0, d=0→1, d=1→257\nd=4.32→${enc[4]}, d=63→${enc[5]}`;
  } catch (e) { els.probeEnc.textContent = `✗ ${e.message}`; }

  // 3) 一致性符号：左像素 x 在反向视差图上的取样点是 floor(x − d + .5)；
  //    反向视差图本身以右图为基准，其 xr 处对应左图 xr + d。故意把 (x + d) 处放上
  //    一个不同的值，验证“读 x − d”通过而“读 x + d”被拒。
  try {
    const w = 32;
    const dL = new Float32Array(w).fill(4);
    dL[0] = dL[1] = dL[2] = NaN;
    const dR = new Float32Array(w).fill(4);
    const x = 20, d = 4;
    const xr = Math.floor(x - d + 0.5);   // 16
    dR[24] = 9;                            // 若误用 x+d 会读到它
    const reasons = new Uint8Array(w);
    const out = leftRightCheck(dL, dR, reasons, w, 1, 1);
    const passOk = !Number.isNaN(out.final[x]) && Math.abs(out.final[x] - d) < 1e-6;
    // 再构造只有 x+d 处有效的反向图：必须判无效
    const dRwrong = new Float32Array(w).fill(NaN);
    dRwrong[24] = 4;
    const outWrong = leftRightCheck(dL, dRwrong, reasons, w, 1, 1);
    const wrongRejected = Number.isNaN(outWrong.final[x]);
    els.probeLr.textContent = `${passOk && wrongRejected ? '✓ 通过' : '✗ 方向错误'}\n左 x=20, d=4 → 读右图 x=${xr}\n读 d右=${dR[xr]}（阈值内）→ 有效\n若误用 x+d=24 → ${wrongRejected ? '判无效' : '竟通过'}`;
  } catch (e) { els.probeLr.textContent = `✗ ${e.message}`; }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
els.run.addEventListener('click', () => runCompute());
els.sample.addEventListener('change', () => loadSample(els.sample.value));

for (const [inp, key] of [[els.leftFile, 'left'], [els.rightFile, 'right'], [els.truthFile, 'truth']]) {
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    clearNotice();
    try {
      if (key === 'truth') {
        const buf = new Uint8Array(await file.arrayBuffer());
        const img = await decodePng(buf);
        if (img.colorType !== 0) throw new InputError('真值必须是灰度 PNG');
        if (img.bitDepth !== 16) {
          throw new InputError(`真值须为 16 位 PNG（包内约定 d=(v−1)/256）；当前为 ${img.bitDepth} 位`);
        }
        state.truth = { width: img.width, height: img.height, bitDepth: img.bitDepth, data: img.data };
        showNotice(`真值已载入：${img.width}×${img.height}，${img.bitDepth} 位。`, 'ok');
        if (state.result) { await runCompute(); }
      } else {
        const img = await decodePairFile(file, key === 'left' ? '左图' : '右图');
        if (img.bitDepth !== 8) throw new InputError(`${key === 'left' ? '左图' : '右图'}须为 8 位灰度（当前 ${img.bitDepth} 位）`);
        state[key] = img;
        els.sample.value = '';
        state.result = null; state.selected = null; resetPixelPanel();
        setStatus('', `${key === 'left' ? '左图' : '右图'}已载入`);
        showNotice(`${key === 'left' ? '左图' : '右图'}已载入：${img.width}×${img.height}，8 位灰度。`, 'ok');
        syncPairValidity();
        if (state.left && state.right) await runCompute();
      }
    } catch (e) {
      showNotice(`载入失败：${e.message}`, 'err');
      setStatus('err', '载入失败');
    }
  });
}

for (const inp of [els.minD, els.maxD, els.p1, els.p2, els.uniq, els.lrthr, els.subpix]) {
  inp.addEventListener('input', updateStaleHint);
}
els.minD.addEventListener('change', () => { if (Number(els.minD.value) > Number(els.maxD.value)) els.maxD.value = els.minD.value; updateStaleHint(); });
els.maxD.addEventListener('change', () => { if (Number(els.maxD.value) < Number(els.minD.value)) els.minD.value = els.maxD.value; updateStaleHint(); });

window.addEventListener('resize', () => {
  if (state.explain) renderPixelPanel(state.explain);
  positionMarker();
});

// 主题切换
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('csgm-theme', mode); } catch {}
  els.themeBtn.textContent = mode === 'dark' ? '浅色' : '深色';
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('csgm-theme'); } catch {}
els.themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
(function initTheme() {
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(savedTheme || (prefersDark ? 'dark' : 'light'));
})();

// 启动
runSelfChecks();
setStatus('', '等待载入左右图');
syncPairValidity();

const DIR_LABELS = ['→ 水平（从左）', '← 水平（从右）', '↓ 垂直（从上）', '↑ 垂直（从下）',
  '↘ 对角（左上→右下）', '↖ 对角（右下→左上）', '↗ 对角（左下→右上）', '↙ 对角（右上→左下）'];

function renderDirMultiples(ex, xs, di) {
  const host = els.chartDirs;
  host.textContent = '';
  let last = 0;
  for (let i = 0; i < ex.dirs.length; i++) {
    const d = ex.dirs[i];
    const box = document.createElement('div');
    box.className = 'mult';
    const cap = document.createElement('div');
    cap.className = 'cap';
    const nm = document.createElement('span');
    nm.textContent = DIR_LABELS[i] || d.name;
    const vl = document.createElement('b');
    const at = di >= 0 ? d.L[di] : NaN;
    // 各方向自身的最优候选，便于在重复纹理上对比“八方向是否同意”
    let ownBest = -1, ownVal = Infinity;
    for (let k = 0; k < d.L.length; k++) {
      if (Number.isFinite(d.L[k]) && d.L[k] < ownVal) { ownVal = d.L[k]; ownBest = k; }
    }
    const ownTxt = ownBest >= 0 ? xs[ownBest] : '—';
    vl.textContent = Number.isFinite(at) ? `L₀ ${formatNumber(at)} · 峰 ${ownTxt}` : `峰 ${ownTxt}`;
    cap.append(nm, vl);
    const chart = document.createElement('div');
    chart.className = 'chart-wrap';
    box.append(cap, chart);
    host.appendChild(box);
    const vals = Array.from(d.L);
    last = Math.max(last, ...vals.filter(Number.isFinite));
    lineChart(chart, xs, [{ key: 'L', label: 'L', color: 'var(--series-1)', values: vals }], {
      height: 78, zeroBase: true, compact: true, markIndex: di >= 0 ? xs[di] : null,
      ariaLabel: `像素 (${ex.x},${ex.y}) 方向 ${DIR_LABELS[i] || d.name} 的 L 曲线`,
      compact: true,
    });
  }
  // 图例：解释各图共用的标记
  els.dirsLegend.textContent = '';
  const addKey = (cls, color, text) => {
    const sp = document.createElement('span'); sp.className = 'key';
    const sw = document.createElement('span'); sw.className = cls; sw.style.background = color;
    sp.append(sw, document.createTextNode(text));
    els.dirsLegend.appendChild(sp);
  };
  addKey('ln', 'var(--series-1)', '该方向的 L(p,d)');
  addKey('ln', 'var(--series-2)', 'd₀ 位置');
}
