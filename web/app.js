import { decodeGrayPNG, encodeGrayPNG, buildZip, flowToRaw, validToPngBytes } from './codecs.js';
import {
  directionColors, validityColors, heatColors, paintImageData, paintGray,
  drawVectors, drawMarker, drawColorWheel,
} from './viz.js';
import { SAMPLE_B64 } from './samples-b64.js';
import { DEFAULT_PARAMS } from './flow-core.js';

const $ = (id) => document.getElementById(id);
const state = {
  imgA: null, imgB: null, // {width,height,data}
  result: null,
  view: 'direction',
  selected: null, // {x,y}
  token: 0,
  running: false,
};

// ---------------- theme ----------------
const themeBtn = $('themeBtn');
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('dmc-theme', t || ''); } catch { /* ignore */ }
}
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = cur ? cur === 'dark' : dark;
  applyTheme(isDark ? 'light' : 'dark');
  if (state.result) renderAll();
});
try { const saved = localStorage.getItem('dmc-theme'); if (saved) applyTheme(saved); } catch { /* ignore */ }

// ---------------- parameter wiring ----------------
const bindRange = (id, label, fmt = (v) => v) => {
  const el = $(id), lab = $(label);
  const sync = () => { lab.textContent = fmt(el.value); };
  el.addEventListener('input', sync); sync();
};
bindRange('pWindow', 'vWindow');
bindRange('pLevels', 'vLevels');
bindRange('pIters', 'vIters');
bindRange('pFb', 'vFb', v => Number(v).toFixed(2));
bindRange('pEigen', 'vEigen', v => Number(v).toFixed(1));

function readParams() {
  return {
    windowRadius: (Number($('pWindow').value) - 1) / 2,
    levels: Number($('pLevels').value),
    iterations: Number($('pIters').value),
    fbThreshold: Number($('pFb').value),
    eigenThreshold: Number($('pEigen').value),
    medianFilter: $('pMedian').checked,
  };
}

// ---------------- image loading ----------------
function b64ToBlob(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: 'image/png' });
}

async function loadPair(blobA, blobB, nameA, nameB) {
  let a, b;
  try {
    a = await decodeGrayPNG(blobA);
    b = await decodeGrayPNG(blobB);
  } catch (e) {
    showError('图像解码失败：' + e.message); return;
  }
  if (a.width !== b.width || a.height !== b.height) {
    showError(`尺寸不一致：A 为 ${a.width}×${a.height}，B 为 ${b.width}×${b.height}`); return;
  }
  state.imgA = a; state.imgB = b; state.result = null; state.selected = null;
  $('loadMsg').textContent = `已载入 ${nameA} 与 ${nameB}（${a.width}×${a.height} 灰度）`;
  $('runBtn').disabled = false;
  $('exportBtn').disabled = true;
  clearError();
  renderFramesOnly();
  setPill('未计算', '');
  resetStats();
  $('statusLine').textContent = '就绪，可开始计算。';
}

function showError(msg) { const e = $('errLine'); e.hidden = false; e.textContent = msg; }
function clearError() { $('errLine').hidden = true; }

$('fileA').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (state.imgB) await loadPair(f, blobOf(state.imgB), f.name, '当前 B');
  else if (state._pendingB) { const b = state._pendingB; state._pendingB = null; await loadPair(f, b, f.name, b.name); }
  else { state._pendingA = f; $('loadMsg').textContent = 'A 已选择，请再选择 B。'; }
});
$('fileB').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (state._pendingA) { const a = state._pendingA; state._pendingA = null; await loadPair(a, f, a.name, f.name); }
  else if (state.imgA) await loadPair(blobOf(state.imgA), f, '当前 A', f.name);
  else { state._pendingB = f; $('loadMsg').textContent = 'B 已选择，请再选择 A。'; }
});
// Re-wrap an already-decoded frame back into a blob so loadPair decodes uniformly.
function blobOf(img) {
  return encodeGrayPNG(img.width, img.height, img.data);
}

// sample buttons
const SAMPLE_CASES = [
  { label: '整数平移', a: 'a.png', b: 'integer-b.png' },
  { label: '亚像素平移', a: 'a.png', b: 'subpixel-b.png' },
  { label: '含遮挡', a: 'a.png', b: 'occluded-b.png' },
  { label: '分段运动', a: 'a.png', b: 'piecewise-b.png' },
  { label: '平坦无纹理', a: 'flat-a.png', b: 'flat-b.png' },
];
const sampleWrap = $('sampleBtns');
SAMPLE_CASES.forEach((c) => {
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.type = 'button'; btn.textContent = c.label;
  btn.addEventListener('click', () => loadPair(b64ToBlob(SAMPLE_B64[c.a]), b64ToBlob(SAMPLE_B64[c.b]), c.a, c.b));
  sampleWrap.appendChild(btn);
});

// ---------------- worker ----------------
let worker;
function getWorker() {
  if (worker) return worker;
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => showError('工作线程错误：' + e.message);
  return worker;
}

function setPill(text, cls) {
  const p = $('pillState'); p.textContent = text; p.className = 'pill ' + (cls || '');
}
function setProgress(frac) { $('progBar').style.width = `${Math.round(100 * frac)}%`; }

function startRun() {
  if (!state.imgA || state.running) return;
  clearError();
  state.running = true; state.token++;
  $('runBtn').disabled = true; $('cancelBtn').disabled = false;
  setPill('计算中…', '');
  $('statusLine').textContent = '启动工作线程…';
  setProgress(0);
  const direction = $('pDirection').value;
  // Transfer copies (the worker detaches its buffers; keep originals for display).
  const aCopy = new Uint8Array(state.imgA.data);
  const bCopy = new Uint8Array(state.imgB.data);
  getWorker().postMessage({
    type: 'run', token: state.token,
    a: aCopy, b: bCopy,
    width: state.imgA.width, height: state.imgA.height,
    params: readParams(), direction,
  }, [aCopy.buffer, bCopy.buffer]);
}

function cancelRun() {
  if (!state.running) return;
  state.token++; // invalidate token locally
  getWorker().postMessage({ type: 'cancel', token: state.token });
  $('statusLine').textContent = '正在取消…';
}

$('runBtn').addEventListener('click', startRun);
$('cancelBtn').addEventListener('click', cancelRun);

function onWorkerMessage(e) {
  const msg = e.data;
  if (msg.type === 'progress') {
    if (msg.token !== state.token) return;
    setProgress(msg.frac);
    const stageName = {
      'primary-estimate': '估计主方向流', 'reverse-estimate': '独立估计反向流',
      consistency: '前后向一致性核对', done: '完成',
    }[msg.stage] || msg.stage;
    $('statusLine').textContent = `${stageName} · ${Math.round(msg.frac * 100)}%`;
  } else if (msg.type === 'done') {
    if (msg.token !== state.token) return;
    finishRun(msg.result);
  } else if (msg.type === 'canceled') {
    state.running = false;
    $('runBtn').disabled = false; $('cancelBtn').disabled = true;
    setPill('已取消', 'bad');
    $('statusLine').textContent = '计算已取消，未产生结果。';
    setProgress(0);
  } else if (msg.type === 'error') {
    if (msg.token !== state.token) return;
    state.running = false;
    $('runBtn').disabled = false; $('cancelBtn').disabled = true;
    showError(msg.message); setPill('出错', 'bad');
  }
}

function finishRun(result) {
  state.running = false; state.result = result; state.selected = null;
  $('runBtn').disabled = false; $('cancelBtn').disabled = true;
  $('exportBtn').disabled = false;
  setProgress(1);
  setPill('完成', 'good');
  $('statusLine').textContent = `完成：${result.levelsUsed} 层金字塔，方向 ${result.direction === 'forward' ? 'A→B' : 'B→A'}。`;
  renderStats();
  renderAll();
}

// ---------------- stats ----------------
function medFinite(arr, valid) {
  const vals = [];
  for (let i = 0; i < arr.length; i++) if (valid[i] && Number.isFinite(arr[i])) vals.push(arr[i]);
  if (!vals.length) return NaN;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}
function resetStats() {
  ['stValid', 'stRatio', 'stMag', 'stReproj', 'stFb', 'stZero', 'stLevels', 'stSize']
    .forEach(id => $(id).textContent = '–');
}
function renderStats() {
  const r = state.result; const N = r.W * r.H;
  let nValid = 0, nZero = 0; const mags = [];
  for (let i = 0; i < N; i++) if (r.valid[i]) {
    nValid++;
    const m = Math.hypot(r.u[i], r.v[i]); mags.push(m);
    if (m < 1e-6) nZero++;
  }
  $('stValid').textContent = nValid;
  $('stRatio').textContent = (100 * nValid / N).toFixed(1) + '%';
  mags.sort((a, b) => a - b);
  $('stMag').textContent = mags.length ? mags[mags.length >> 1].toFixed(3) : '–';
  const rep = medFinite(r.reproj, r.valid);
  const fb = medFinite(r.fbErr, r.valid);
  $('stReproj').textContent = Number.isFinite(rep) ? rep.toFixed(3) : '–';
  $('stFb').textContent = Number.isFinite(fb) ? fb.toFixed(3) : '–';
  $('stZero').textContent = nZero;
  $('stLevels').textContent = r.levelsUsed;
  $('stSize').textContent = `${r.W}×${r.H}`;
}

// ---------------- rendering ----------------
const cvA = $('cvA'), cvB = $('cvB');
function fitCanvas(cv, W, H) {
  const wrap = cv.parentElement;
  const cssW = wrap.clientWidth, cssH = cssW * H / W;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssW, cssH };
}

function framePair() {
  // For backward runs the flow maps B->A, so the source frame is B and the
  // target frame is A. Captions and readouts follow the active direction.
  const r = state.result;
  if (!r || r.direction === 'forward') {
    return { first: state.imgA, second: state.imgB, srcName: 'A', tgtName: 'B' };
  }
  return { first: state.imgB, second: state.imgA, srcName: 'B', tgtName: 'A' };
}

function renderFramesOnly() {
  if (!state.imgA) return;
  const { ctx: ctxA, cssW, cssH } = fitCanvas(cvA, state.imgA.width, state.imgA.height);
  paintGray(ctxA, state.imgA.data, state.imgA.width, state.imgA.height, cssW, cssH);
  const fb = fitCanvas(cvB, state.imgB.width, state.imgB.height);
  paintGray(fb.ctx, state.imgB.data, state.imgB.width, state.imgB.height, fb.cssW, fb.cssH);
  $('capA').textContent = `(${state.imgA.width}×${state.imgA.height})`;
  $('capB').textContent = `(${state.imgB.width}×${state.imgB.height})`;
  if (state.result) paintSelectedMarkers(ctxA, fb.ctx, cssW, cssH, fb.cssW, fb.cssH);
}

function renderAll() {
  if (!state.result) { renderFramesOnly(); updateLegend(); return; }
  const r = state.result;
  const { first, second, srcName, tgtName } = framePair();
  const W = r.W, H = r.H;

  const va = fitCanvas(cvA, W, H);
  const vb = fitCanvas(cvB, W, H);
  $('capA').textContent = `(${srcName} · ${W}×${H})`;
  $('capB').textContent = `(${tgtName} · ${W}×${H})`;

  if (state.view === 'frames') {
    paintGray(va.ctx, first.data, W, H, va.cssW, va.cssH);
    paintGray(vb.ctx, second.data, W, H, vb.cssW, vb.cssH);
  } else if (state.view === 'direction') {
    const img = directionColors(r.u, r.v, r.valid, W, H);
    paintImageData(va.ctx, img, va.cssW, va.cssH);
    paintGray(vb.ctx, second.data, W, H, vb.cssW, vb.cssH);
    overlayValidContour(vb.ctx, r, vb.cssW, vb.cssH);
  } else if (state.view === 'vectors') {
    paintGray(va.ctx, first.data, W, H, va.cssW, va.cssH);
    const step = Math.max(4, Math.round(W / 24));
    drawVectors(va.ctx, r.u, r.v, r.valid, W, H, va.cssW, va.cssH, step, 1);
    paintGray(vb.ctx, second.data, W, H, vb.cssW, vb.cssH);
    overlayValidContour(vb.ctx, r, vb.cssW, vb.cssH);
  } else if (state.view === 'valid') {
    paintImageData(va.ctx, validityColors(r.valid, W, H), va.cssW, va.cssH);
    paintGray(vb.ctx, second.data, W, H, vb.cssW, vb.cssH);
    overlayValidContour(vb.ctx, r, vb.cssW, vb.cssH);
  } else if (state.view === 'reproj') {
    const { img } = heatColors(r.reproj, r.valid, W, H);
    paintImageData(va.ctx, img, va.cssW, va.cssH);
    paintGray(vb.ctx, second.data, W, H, vb.cssW, vb.cssH);
  } else if (state.view === 'fb') {
    const { img } = heatColors(r.fbErr, r.valid, W, H, r.params.fbThreshold * 2);
    paintImageData(va.ctx, img, va.cssW, va.cssH);
    paintGray(vb.ctx, second.data, W, H, vb.cssW, vb.cssH);
  }
  paintSelectedMarkers(va.ctx, vb.ctx, va.cssW, va.cssH, vb.cssW, vb.cssH);
  updateLegend();
}

// Draw the correspondence crosshairs on top of whatever layer was painted.
function paintSelectedMarkers(ctxA, ctxB, aw, ah, bw, bh) {
  const r = state.result;
  if (!r || !state.selected) return;
  const { x, y } = state.selected;
  drawMarker(ctxA, x, y, aw, ah, r.W, r.H, '#ffd34d');
  const i = y * r.W + x;
  if (r.valid[i]) {
    const qx = x + r.u[i], qy = y + r.v[i];
    drawMarker(ctxB, qx, qy, bw, bh, r.W, r.H, '#ffd34d');
  }
}

function overlayValidContour(ctx, r, cssW, cssH) {
  const W = r.W, H = r.H;
  ctx.save();
  ctx.fillStyle = 'rgba(212,73,63,0.32)';
  const sx = cssW / W, sy = cssH / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!r.valid[y * W + x]) ctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
  }
  ctx.restore();
}

function updateLegend() {
  const el = $('legend');
  const v = state.view;
  if (v === 'direction') {
    el.innerHTML = '<span class="wheel-span"><canvas id="wheelCv" width="44" height="44"></canvas>方向色轮（0°=向右，顺时针）</span>'
      + '<span><i class="swatch" style="background:#fff"></i>有效零运动</span>'
      + '<span><i class="swatch" style="background:#181b21"></i>无效对应</span>'
      + '<span>明度=幅值</span>';
    const wheel = $('wheelCv');
    if (wheel) drawColorWheel(wheel, 44);
  } else if (v === 'valid') {
    el.innerHTML = '<span><i class="swatch" style="background:#2ea063"></i>有效</span>'
      + '<span><i class="swatch" style="background:#b43c3c"></i>无效（遮挡/无纹理/越界/不一致）</span>';
  } else if (v === 'reproj' || v === 'fb') {
    el.innerHTML = '<span>蓝→绿→黄→红 表示误差由小到大</span>'
      + '<span><i class="swatch" style="background:#181b21"></i>无效（不计误差）</span>';
  } else if (v === 'vectors') {
    el.innerHTML = '<span>箭头为流向量（起点在 A 像素中心）</span>';
  } else {
    el.innerHTML = '<span>点击任一画布查看两帧对应位置</span>';
  }
}

// ---------------- click correspondence ----------------
function canvasToPixel(cv, ev) {
  const rect = cv.getBoundingClientRect();
  const r = state.result;
  const cssX = ev.clientX - rect.left, cssY = ev.clientY - rect.top;
  const x = Math.floor(cssX / rect.width * r.W);
  const y = Math.floor(cssY / rect.height * r.H);
  return { x: Math.max(0, Math.min(r.W - 1, x)), y: Math.max(0, Math.min(r.H - 1, y)) };
}

function onCanvasClick(ev) {
  if (!state.result) return;
  const { x, y } = canvasToPixel(ev.currentTarget, ev);
  state.selected = { x, y };
  renderAll();
  fillReadout();
}
cvA.addEventListener('click', onCanvasClick);
cvB.addEventListener('click', onCanvasClick);

function fillReadout() {
  const r = state.result; const { x, y } = state.selected; const i = y * r.W + x;
  const dl = $('readout');
  const valid = r.valid[i];
  const { srcName, tgtName } = framePair();
  const qx = x + r.u[i], qy = y + r.v[i];
  const rows = [
    [`${srcName} 像素（源）`, `(${x}, ${y})`],
    [`对应 ${tgtName} 位置（目标）`, valid ? `(${qx.toFixed(3)}, ${qy.toFixed(3)})` : '无效对应（无可靠位置）'],
    ['流 (u, v)', valid ? `(${r.u[i].toFixed(4)}, ${r.v[i].toFixed(4)})` : '(0, 0) — 掩膜判无效'],
    ['是否有效', valid ? '有效' : '无效（遮挡/无纹理/越界/FB 不一致）'],
    ['重投影差', Number.isFinite(r.reproj[i]) ? r.reproj[i].toFixed(4) : '不可用'],
    ['FB 误差', Number.isFinite(r.fbErr[i]) ? r.fbErr[i].toFixed(4) : '不可用'],
    ['纹理 λmin', r.eigen[i].toFixed(3)],
  ];
  dl.innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
}

// ---------------- view tabs ----------------
$('viewTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  [...$('viewTabs').children].forEach(b => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
  renderAll();
});

// ---------------- export ----------------
$('exportBtn').addEventListener('click', async () => {
  const r = state.result; if (!r) return;
  const dir = r.direction;
  const raw = flowToRaw(r.u, r.v, r.valid, r.W, r.H);
  const maskBytes = validToPngBytes(r.valid, r.W, r.H);
  const maskBlob = await encodeGrayPNG(r.W, r.H, maskBytes);
  const meta = {
    width: r.W, height: r.H,
    direction: dir === 'forward' ? 'A->B' : 'B->A',
    convention: 'flow (u,v) at pixel p maps source p to target p+(u,v); x right, y down, pixel centers',
    files: { flow: 'flow.raw', validity: 'valid.png' },
    flowRaw: { dtype: 'float32', endian: 'little', layout: 'interleaved u,v per pixel, row-major' },
    validityPng: { values: '0 or 255', meaning: '255 = valid correspondence' },
    invalidRule: 'invalid pixels write zero flow; validity is expressed only by the mask',
    params: r.params,
  };
  const zip = await buildZip([
    { name: 'flow.raw', data: raw },
    { name: 'valid.png', data: maskBlob },
    { name: 'params.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) },
  ]);
  // Sandbox viewers may block downloads; expose both a link and a data fallback.
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url; a.download = `dense-flow-${dir}-${r.W}x${r.H}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

// ---------------- resize ----------------
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => renderAll(), 120); });

// initial empty canvas state
resetStats();
updateLegend();
