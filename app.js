/* app.js — 局部频谱修复 UI 逻辑 */
'use strict';
/* global SpectralDSP */
const DSP = SpectralDSP;

/* ---------------- 状态 ---------------- */
const state = {
  audio: null,          // decodeWav 结果 + fileName
  boxes: [],            // {id,start,end,low,high,attenDb,channels,enabled}
  selectedId: null,
  nextId: 1,
  view: { t0: 0, t1: 1, f0: 0, f1: 24000 },
  history: [], histIdx: -1,
  processedInts: null,  // 每声道 Int32Array（有选框时）
  dirty: false,         // 选框已改、处理结果过期
  procToken: 0,
  pendingProject: null, // 等待匹配源音频的工程
  spec: null,           // {data:Uint8Array, cols, bins, hop, fftN}
  specToken: 0,
  playing: null,        // {src, ctx, startCtxTime, kind}
};

const $ = id => document.getElementById(id);
const els = {
  fileInfo: $('fileInfo'), statusText: $('statusText'),
  progressWrap: $('progressWrap'), progressBar: $('progressBar'),
  wave: $('waveCanvas'), spec: $('specCanvas'), emptyTip: $('emptyTip'),
  boxList: $('boxList'), editor: $('editor'),
};

const MAX_SECONDS = 60;

/* ---------------- 工具 ---------------- */
function fmtTime(s) { return s.toFixed(3) + 's'; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function activeBoxes() { return state.boxes.filter(b => b.enabled && b.attenDb > 0); }

function setStatus(msg, isWarn) {
  els.statusText.textContent = msg || '';
  els.statusText.style.color = isWarn ? 'var(--accent2)' : 'var(--dim)';
}

/* ---------------- 撤销 / 重做 ---------------- */
function snapshot() { return JSON.stringify(state.boxes); }
function commit() {
  state.history = state.history.slice(0, state.histIdx + 1);
  state.history.push(snapshot());
  if (state.history.length > 100) state.history.shift();
  state.histIdx = state.history.length - 1;
  updateUndoButtons();
}
function restore(snap) {
  state.boxes = JSON.parse(snap);
  state.nextId = Math.max(0, ...state.boxes.map(b => b.id)) + 1;
  if (state.selectedId && !state.boxes.some(b => b.id === state.selectedId)) selectBox(null);
  refreshBoxUI();
  scheduleProcess();
  requestRender();
}
function undo() { if (state.histIdx > 0) { state.histIdx--; restore(state.history[state.histIdx]); } updateUndoButtons(); }
function redo() { if (state.histIdx < state.history.length - 1) { state.histIdx++; restore(state.history[state.histIdx]); } updateUndoButtons(); }
function updateUndoButtons() {
  $('btnUndo').disabled = state.histIdx <= 0;
  $('btnRedo').disabled = state.histIdx >= state.history.length - 1;
}

/* ---------------- 导入 WAV ---------------- */
$('btnImport').onclick = () => $('fileWav').click();
$('fileWav').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const d = DSP.decodeWav(buf);
    if (d.sampleRate !== 44100 && d.sampleRate !== 48000)
      throw new Error(`采样率 ${d.sampleRate}Hz 不受支持（仅 44.1/48kHz）`);
    if (d.frames / d.sampleRate > MAX_SECONDS)
      throw new Error(`时长 ${(d.frames / d.sampleRate).toFixed(1)}s 超过 60 秒上限`);
    loadAudio(d, file.name);
  } catch (err) {
    alert('导入失败：' + err.message);
  }
};

function loadAudio(d, fileName) {
  stopPlayback();
  state.audio = Object.assign({ fileName }, d);
  state.boxes = [];
  state.selectedId = null;
  state.history = []; state.histIdx = -1;
  state.processedInts = null;
  state.dirty = false;
  state.view = { t0: 0, t1: d.frames / d.sampleRate, f0: 0, f1: d.sampleRate / 2 };
  commit();
  els.fileInfo.innerHTML =
    `<b>${fileName}</b> · ${d.sampleRate}Hz · ${d.channels === 1 ? '单声道' : '双声道'} · ` +
    `${d.bitsPerSample}bit · ${fmtTime(d.frames / d.sampleRate)} · ${d.frames} 帧`;
  els.emptyTip.style.display = 'none';
  $('btnExport').disabled = false;
  $('btnSaveProj').disabled = false;
  $('btnPlayOrig').disabled = false;
  updateProcButton();
  buildSpectrogram();
  refreshBoxUI();
  requestRender();
  setStatus('正在生成频谱图…');
  // 如有等待中的工程且匹配，恢复选框
  if (state.pendingProject) {
    const p = state.pendingProject;
    if (projectMatches(p, d)) {
      state.boxes = p.boxes.map(b => Object.assign({}, b));
      state.nextId = Math.max(0, ...state.boxes.map(b => b.id)) + 1;
      commit(); refreshBoxUI(); scheduleProcess();
      setStatus(`已从工程恢复 ${state.boxes.length} 个选框`);
    } else {
      setStatus('工程与当前音频不匹配，未恢复选框', true);
    }
    state.pendingProject = null;
  }
}

/* ---------------- 频谱图计算（分块异步） ---------------- */
async function buildSpectrogram() {
  const a = state.audio;
  const tok = ++state.specToken;
  const N = 2048;
  const hop = Math.max(256, Math.ceil(a.frames / 6000));
  const cols = Math.max(1, Math.ceil((a.frames - N) / hop) + 1);
  const bins = N / 2 + 1;
  const data = new Uint8Array(cols * bins);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const mag = new Float64Array(bins);
  for (let col = 0; col < cols; col++) {
    if (tok !== state.specToken) return; // 已更换音频
    const off = col * hop;
    mag.fill(0);
    for (let c = 0; c < a.channels; c++) {
      const src = a.floats[c];
      for (let i = 0; i < N; i++) { const s = off + i < a.frames ? src[off + i] : 0; re[i] = s * win[i]; im[i] = 0; }
      DSP.fft(re, im, false);
      for (let b = 0; b < bins; b++) {
        const m = Math.hypot(re[b], im[b]);
        if (m > mag[b]) mag[b] = m;
      }
    }
    for (let b = 0; b < bins; b++) {
      const db = 20 * Math.log10(mag[b] / N + 1e-9);
      const v = clamp((db + 85) * 255 / 85, 0, 255) / 255;
      data[col * bins + b] = Math.round(255 * Math.pow(v, 0.7)); // 伽马提亮弱信号
    }
    if (col % 400 === 399) {
      state.spec = { data, cols, bins, hop, fftN: N, partial: col + 1 };
      requestRender();
      await new Promise(r => setTimeout(r, 0));
    }
  }
  state.spec = { data, cols, bins, hop, fftN: N, partial: cols };
  setStatus('');
  requestRender();
}

/* ---------------- 渲染 ---------------- */
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

// 颜色映射：黑→深蓝→青→黄→白
function specColor(v) {
  if (v < 64) return [0, 0, v * 2];
  if (v < 128) return [0, (v - 64) * 3, 128 + (v - 64) * 2];
  if (v < 192) return [(v - 128) * 4, 192 + (v - 128), 255 - (v - 128) * 2];
  return [255, 255, 128 + (v - 192) / 2];
}

const t2x = (t, w) => (t - state.view.t0) / (state.view.t1 - state.view.t0) * w;
const x2t = (x, w) => state.view.t0 + x / w * (state.view.t1 - state.view.t0);
const f2y = (f, h) => (1 - (f - state.view.f0) / (state.view.f1 - state.view.f0)) * h;
const y2f = (y, h) => state.view.f1 - y / h * (state.view.f1 - state.view.f0);

function render() {
  renderWave();
  renderSpec();
}

function renderWave() {
  const { ctx, w, h } = setupCanvas(els.wave);
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, w, h);
  const a = state.audio;
  if (!a) return;
  const { t0, t1 } = state.view;
  // 选框时间范围底色
  for (const b of state.boxes) {
    ctx.fillStyle = b.enabled ? 'rgba(79,156,249,0.12)' : 'rgba(120,120,120,0.08)';
    const x0 = t2x(b.start, w), x1 = t2x(b.end, w);
    ctx.fillRect(x0, 0, x1 - x0, h);
  }
  const i0 = Math.max(0, Math.floor(t0 * a.sampleRate));
  const i1 = Math.min(a.frames, Math.ceil(t1 * a.sampleRate));
  const half = h / 2;
  ctx.strokeStyle = '#6fb3ff';
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const s0 = Math.floor(i0 + (i1 - i0) * x / w);
    const s1 = Math.max(s0 + 1, Math.floor(i0 + (i1 - i0) * (x + 1) / w));
    let mn = 1, mx = -1;
    for (let c = 0; c < a.channels; c++) {
      const src = a.floats[c];
      for (let i = s0; i < s1; i++) { const v = src[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    ctx.moveTo(x + 0.5, half - mx * half * 0.92);
    ctx.lineTo(x + 0.5, half - mn * half * 0.92 + 1);
  }
  ctx.stroke();
  drawTimeAxis(ctx, w, h);
  drawPlayhead(ctx, w, h);
}

function drawTimeAxis(ctx, w, h) {
  const { t0, t1 } = state.view;
  const span = t1 - t0;
  const step = niceStep(span / 8);
  ctx.fillStyle = 'rgba(138,147,165,0.9)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = t2x(t, w);
    ctx.fillText(t.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0), x, h - 4);
    ctx.fillRect(x, h - 16, 1, 4);
  }
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

function renderSpec() {
  const { ctx, w, h } = setupCanvas(els.spec);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const a = state.audio, sp = state.spec;
  if (!a) return;
  if (sp) {
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const binHz = a.sampleRate / sp.fftN;
    const colScale = sp.hop / a.sampleRate; // 秒/列
    const lut = new Uint8Array(256 * 3);
    for (let v = 0; v < 256; v++) { const [r, g, b] = specColor(v); lut[v * 3] = r; lut[v * 3 + 1] = g; lut[v * 3 + 2] = b; }
    const colsAvail = sp.partial;
    for (let x = 0; x < w; x++) {
      const t = x2t(x, w);
      let col = Math.floor(t / colScale);
      col = clamp(col, 0, colsAvail - 1);
      const rowBase = col * sp.bins;
      for (let y = 0; y < h; y++) {
        const f = y2f(y, h);
        const b = clamp(Math.round(f / binHz), 0, sp.bins - 1);
        const v = sp.data[rowBase + b] * 3;
        const o = (y * w + x) * 4;
        px[o] = lut[v]; px[o + 1] = lut[v + 1]; px[o + 2] = lut[v + 2]; px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  drawFreqAxis(ctx, w, h);
  drawBoxes(ctx, w, h);
  drawPlayhead(ctx, w, h);
}

function drawFreqAxis(ctx, w, h) {
  const { f0, f1 } = state.view;
  const step = niceStep((f1 - f0) / 6);
  ctx.fillStyle = 'rgba(200,208,220,0.85)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  for (let f = Math.ceil(f0 / step) * step; f <= f1; f += step) {
    const y = f2y(f, h);
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(Math.round(f)), 3, y - 2);
  }
}

function drawBoxes(ctx, w, h) {
  for (const b of state.boxes) {
    const x0 = t2x(b.start, w), x1 = t2x(b.end, w);
    const y0 = f2y(b.high, h), y1 = f2y(b.low, h);
    const sel = b.id === state.selectedId;
    const alpha = b.enabled ? 1 : 0.35;
    ctx.strokeStyle = sel ? `rgba(249,164,79,${alpha})` : `rgba(79,156,249,${alpha})`;
    ctx.fillStyle = sel ? `rgba(249,164,79,${0.13 * alpha})` : `rgba(79,156,249,${0.13 * alpha})`;
    ctx.lineWidth = sel ? 2 : 1.2;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (sel) { // 手柄
      ctx.fillStyle = '#f9a44f';
      for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]])
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
    }
    ctx.fillStyle = `rgba(216,222,233,${alpha})`;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`#${b.id} ${b.attenDb}dB${b.enabled ? '' : ' (停)'}`, x0 + 3, y0 + 11);
  }
}

function drawPlayhead(ctx, w, h) {
  const p = state.playing;
  if (!p) return;
  const t = p.ctx.currentTime - p.startCtxTime + p.offset;
  const dur = state.audio ? state.audio.frames / state.audio.sampleRate : 0;
  if (t > dur) return;
  const x = t2x(t, w);
  ctx.strokeStyle = '#58c98b';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

window.addEventListener('resize', requestRender);

/* ---------------- 视图缩放 / 平移 ---------------- */
els.spec.addEventListener('wheel', e => {
  if (!state.audio) return;
  e.preventDefault();
  const r = els.spec.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const v = state.view;
  const dur = state.audio.frames / state.audio.sampleRate;
  const nyq = state.audio.sampleRate / 2;
  if (e.altKey) { // 频率缩放
    const f = y2f(y, r.height);
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    let span = clamp((v.f1 - v.f0) * k, 20, nyq);
    let f0 = f - (f - v.f0) * k, f1 = f0 + span;
    if (f0 < 0) { f0 = 0; f1 = span; }
    if (f1 > nyq) { f1 = nyq; f0 = nyq - span; }
    v.f0 = Math.max(0, f0); v.f1 = Math.min(nyq, f1);
  } else if (e.shiftKey) { // 时间平移
    const dt = (v.t1 - v.t0) * 0.15 * (e.deltaY > 0 ? 1 : -1);
    panTime(dt, dur);
  } else { // 时间缩放
    const t = x2t(x, r.width);
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    let span = clamp((v.t1 - v.t0) * k, 0.005, dur);
    let t0 = t - (t - v.t0) * k, t1 = t0 + span;
    if (t0 < 0) { t0 = 0; t1 = span; }
    if (t1 > dur) { t1 = dur; t0 = dur - span; }
    v.t0 = Math.max(0, t0); v.t1 = Math.min(dur, t1);
  }
  requestRender();
}, { passive: false });

function panTime(dt, dur) {
  const v = state.view;
  const span = v.t1 - v.t0;
  v.t0 = clamp(v.t0 + dt, 0, Math.max(0, dur - span));
  v.t1 = v.t0 + span;
}

/* ---------------- 选框鼠标交互 ---------------- */
const HANDLE_PX = 6;
let drag = null; // {mode:'create'|'move'|'resize-*', boxId, anchor...}

function hitTest(x, y, w, h) {
  // 优先选中框的手柄，其次框体（后画的优先）
  const ordered = [...state.boxes].sort((a, b) => (a.id === state.selectedId ? 1 : 0) - (b.id === state.selectedId ? 1 : 0));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const b = ordered[i];
    const x0 = t2x(b.start, w), x1 = t2x(b.end, w);
    const y0 = f2y(b.high, h), y1 = f2y(b.low, h);
    if (b.id === state.selectedId) {
      // 角手柄取最近者（薄框上下角可能都在容差内）；边手柄要求框足够厚
      let best = null, bestD = HANDLE_PX;
      for (const [m, cx, cy] of [['nw', x0, y0], ['ne', x1, y0], ['sw', x0, y1], ['se', x1, y1]]) {
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best) return { box: b, mode: 'resize-' + best };
      const thick = (x1 - x0) >= 3 * HANDLE_PX && (y1 - y0) >= 3 * HANDLE_PX;
      if (thick) {
        if (Math.abs(x - x0) < HANDLE_PX && y > y0 && y < y1) return { box: b, mode: 'resize-w' };
        if (Math.abs(x - x1) < HANDLE_PX && y > y0 && y < y1) return { box: b, mode: 'resize-e' };
        if (Math.abs(y - y0) < HANDLE_PX && x > x0 && x < x1) return { box: b, mode: 'resize-n' };
        if (Math.abs(y - y1) < HANDLE_PX && x > x0 && x < x1) return { box: b, mode: 'resize-s' };
      }
    }
    if (x > x0 && x < x1 && y > y0 && y < y1) return { box: b, mode: 'move' };
  }
  return null;
}

els.spec.addEventListener('mousedown', e => {
  if (!state.audio || e.button !== 0) return;
  const r = els.spec.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = hitTest(x, y, r.width, r.height);
  if (hit) {
    selectBox(hit.box.id);
    drag = {
      mode: hit.mode, boxId: hit.box.id, moved: false,
      startX: x, startY: y,
      orig: Object.assign({}, hit.box),
    };
  } else {
    const nyq = state.audio.sampleRate / 2;
    const b = {
      id: state.nextId++,
      start: x2t(x, r.width), end: x2t(x, r.width),
      low: clamp(y2f(y, r.height), 0, nyq), high: clamp(y2f(y, r.height), 0, nyq),
      attenDb: 24,
      channels: state.audio.channels === 2 ? [0, 1] : [0],
      enabled: true,
    };
    state.boxes.push(b);
    selectBox(b.id);
    drag = { mode: 'create', boxId: b.id, moved: false, anchorT: b.start, anchorF: b.low };
  }
  requestRender();
});

window.addEventListener('mousemove', e => {
  if (!drag || !state.audio) return;
  const r = els.spec.getBoundingClientRect();
  const x = clamp(e.clientX - r.left, 0, r.width);
  const y = clamp(e.clientY - r.top, 0, r.height);
  const t = clamp(x2t(x, r.width), 0, state.audio.frames / state.audio.sampleRate);
  const f = clamp(y2f(y, r.height), 0, state.audio.sampleRate / 2);
  const b = state.boxes.find(bb => bb.id === drag.boxId);
  if (!b) { drag = null; return; }
  drag.moved = true;
  const dur = state.audio.frames / state.audio.sampleRate;
  const nyq = state.audio.sampleRate / 2;
  if (drag.mode === 'create') {
    b.start = Math.min(drag.anchorT, t); b.end = Math.max(drag.anchorT, t);
    b.low = Math.min(drag.anchorF, f); b.high = Math.max(drag.anchorF, f);
  } else if (drag.mode === 'move') {
    const dt = t - x2t(drag.startX, r.width);
    const df = f - y2f(drag.startY, r.height);
    const o = drag.orig;
    const tw = o.end - o.start, fh = o.high - o.low;
    b.start = clamp(o.start + dt, 0, dur - tw); b.end = b.start + tw;
    b.low = clamp(o.low + df, 0, nyq - fh); b.high = b.low + fh;
  } else {
    const dir = drag.mode.slice(7); // 'resize-'.length === 7 → 'n','s','e','w','ne',...
    if (dir.includes('e')) b.end = clamp(Math.max(t, b.start + 0.001), 0, dur);
    if (dir.includes('w')) b.start = clamp(Math.min(t, b.end - 0.001), 0, dur);
    if (dir.includes('n')) b.high = clamp(Math.max(f, b.low + 1), 0, nyq);
    if (dir.includes('s')) b.low = clamp(Math.min(f, b.high - 1), 0, nyq);
  }
  refreshEditor();
  requestRender();
});

window.addEventListener('mouseup', () => {
  if (!drag) return;
  const b = state.boxes.find(bb => bb.id === drag.boxId);
  if (drag.mode === 'create' && b) {
    if (!drag.moved) {
      // 单击未拖拽：视为误触，移除刚创建的框
      state.boxes = state.boxes.filter(bb => bb.id !== b.id);
      selectBox(null);
    } else {
      // 过小的框给一个可用的最小尺寸
      const dur = state.audio.frames / state.audio.sampleRate;
      const nyq = state.audio.sampleRate / 2;
      if (b.end - b.start < 0.005) b.end = Math.min(dur, b.start + 0.05);
      if (b.high - b.low < 5) { b.low = Math.max(0, b.low - 100); b.high = Math.min(nyq, b.high + 100); }
    }
  }
  if (drag.moved || drag.mode === 'create') {
    commit();
    scheduleProcess();
  }
  drag = null;
  refreshBoxUI();
  requestRender();
});

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) deleteBox(state.selectedId);
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
});

/* ---------------- 选框列表 / 编辑器 ---------------- */
function selectBox(id) {
  state.selectedId = id;
  refreshBoxUI();
}

function refreshBoxUI() {
  // 列表
  els.boxList.innerHTML = '';
  for (const b of state.boxes) {
    const div = document.createElement('div');
    div.className = 'boxItem' + (b.id === state.selectedId ? ' selected' : '');
    div.innerHTML = `<b>#${b.id}</b> ${b.start.toFixed(2)}–${b.end.toFixed(2)}s · ` +
      `${Math.round(b.low)}–${Math.round(b.high)}Hz · ${b.attenDb}dB ` +
      `<span class="${b.enabled ? '' : 'off'}">${b.enabled ? '● 启用' : '○ 停用'}</span>`;
    div.onclick = () => { selectBox(b.id); requestRender(); };
    els.boxList.appendChild(div);
  }
  refreshEditor();
}

function refreshEditor() {
  const b = state.boxes.find(bb => bb.id === state.selectedId);
  els.editor.style.display = b ? '' : 'none';
  if (!b) return;
  $('edEnabled').checked = b.enabled;
  $('edStart').value = b.start.toFixed(3);
  $('edEnd').value = b.end.toFixed(3);
  $('edLow').value = Math.round(b.low);
  $('edHigh').value = Math.round(b.high);
  $('edAtten').value = b.attenDb;
  $('edAttenNum').value = b.attenDb;
  // 声道
  const wrap = $('edChans');
  wrap.innerHTML = '';
  const nCh = state.audio ? state.audio.channels : 1;
  for (let c = 0; c < nCh; c++) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = b.channels.includes(c);
    cb.onchange = () => {
      const cur = new Set(b.channels);
      if (cb.checked) cur.add(c); else cur.delete(c);
      if (cur.size === 0) { cb.checked = true; return; } // 至少一个声道
      b.channels = [...cur].sort();
      commit(); scheduleProcess(); requestRender();
    };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(nCh === 2 ? (c === 0 ? '左' : '右') : '声道'));
    wrap.appendChild(lab);
  }
  $('chanRow').style.display = nCh > 1 ? '' : 'none';
}

function editField(apply) {
  const b = state.boxes.find(bb => bb.id === state.selectedId);
  if (!b || !state.audio) return;
  apply(b);
  const dur = state.audio.frames / state.audio.sampleRate;
  const nyq = state.audio.sampleRate / 2;
  b.start = clamp(b.start, 0, dur); b.end = clamp(b.end, 0, dur);
  if (b.end < b.start) [b.start, b.end] = [b.end, b.start];
  b.low = clamp(b.low, 0, nyq); b.high = clamp(b.high, 0, nyq);
  if (b.high < b.low) [b.low, b.high] = [b.high, b.low];
  b.attenDb = clamp(b.attenDb, 0, 60);
  requestRender();
}
function editCommit() { commit(); scheduleProcess(); refreshBoxUI(); }

$('edEnabled').onchange = e => { editField(b => b.enabled = e.target.checked); editCommit(); };
$('edStart').onchange = e => { editField(b => b.start = parseFloat(e.target.value) || 0); editCommit(); };
$('edEnd').onchange = e => { editField(b => b.end = parseFloat(e.target.value) || 0); editCommit(); };
$('edLow').onchange = e => { editField(b => b.low = parseFloat(e.target.value) || 0); editCommit(); };
$('edHigh').onchange = e => { editField(b => b.high = parseFloat(e.target.value) || 0); editCommit(); };
$('edAtten').oninput = e => { editField(b => b.attenDb = parseFloat(e.target.value)); $('edAttenNum').value = e.target.value; scheduleProcess(); };
$('edAtten').onchange = () => editCommit();
$('edAttenNum').onchange = e => { editField(b => b.attenDb = parseFloat(e.target.value) || 0); editCommit(); };
$('btnDelBox').onclick = () => { if (state.selectedId) deleteBox(state.selectedId); };

function deleteBox(id) {
  state.boxes = state.boxes.filter(b => b.id !== id);
  if (state.selectedId === id) selectBox(null);
  commit(); scheduleProcess(); refreshBoxUI(); requestRender();
}

/* ---------------- 处理 ---------------- */
let procTimer = null;
function scheduleProcess() {
  state.dirty = true;
  updateProcButton();
  clearTimeout(procTimer);
  procTimer = setTimeout(runProcess, 600);
}

async function runProcess() {
  const a = state.audio;
  if (!a) return;
  const tok = ++state.procToken;
  if (!activeBoxes().length) {
    state.processedInts = null;
    state.dirty = false;
    updateProcButton();
    setStatus('无启用的选框，导出即为原音');
    return;
  }
  els.progressWrap.style.display = '';
  setStatus('处理中…');
  const proc = DSP.createProcessor(a.floats, a.sampleRate, state.boxes);
  while (!proc.done) {
    if (tok !== state.procToken) return; // 被取消
    const doneFrames = proc.step(48);
    els.progressBar.style.width = `${Math.round(100 * doneFrames / proc.totalFrames)}%`;
    await new Promise(r => setTimeout(r, 0));
  }
  if (tok !== state.procToken) return;
  const floats = proc.result();
  state.processedInts = floats.map(f => DSP.floatsToInts(f, a.bitsPerSample));
  state.dirty = false;
  els.progressWrap.style.display = 'none';
  setStatus('处理完成，可对照试听或导出');
  updateProcButton();
}

function updateProcButton() {
  const has = !!state.processedInts && !state.dirty;
  $('btnPlayProc').disabled = !has;
}

/* ---------------- 播放 ---------------- */
function getAudioCtx() {
  if (!state.actx) state.actx = new (window.AudioContext || window.webkitAudioContext)();
  return state.actx;
}

function play(kind) {
  const a = state.audio;
  if (!a) return;
  stopPlayback();
  const ctx = getAudioCtx();
  const buf = ctx.createBuffer(a.channels, a.frames, a.sampleRate);
  for (let c = 0; c < a.channels; c++) {
    const out = buf.getChannelData(c);
    if (kind === 'proc' && state.processedInts) {
      const scale = 1 / (1 << (a.bitsPerSample - 1));
      const ints = state.processedInts[c];
      for (let i = 0; i < a.frames; i++) out[i] = ints[i] * scale;
    } else {
      out.set(a.floats[c]);
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const offset = clamp(state.view.t0, 0, a.frames / a.sampleRate);
  src.start(0, offset);
  state.playing = { src, ctx, startCtxTime: ctx.currentTime, offset, kind };
  src.onended = () => { state.playing = null; $('btnStop').disabled = true; };
  $('btnStop').disabled = false;
  animatePlayhead();
}

function animatePlayhead() {
  if (!state.playing) return;
  requestRender();
  requestAnimationFrame(animatePlayhead);
}

function stopPlayback() {
  if (state.playing) {
    try { state.playing.src.stop(); } catch (_) { /* 已停止 */ }
    state.playing = null;
  }
  $('btnStop').disabled = true;
  requestRender();
}

$('btnPlayOrig').onclick = () => play('orig');
$('btnPlayProc').onclick = () => play('proc');
$('btnStop').onclick = stopPlayback;

/* ---------------- 工程保存 / 载入 ---------------- */
$('btnSaveProj').onclick = () => {
  const a = state.audio;
  if (!a) return;
  const proj = {
    app: 'spectral-patch-repair', version: 1,
    audio: {
      name: a.fileName, sampleRate: a.sampleRate, channels: a.channels,
      frames: a.frames, bitsPerSample: a.bitsPerSample,
    },
    boxes: state.boxes,
  };
  const blob = new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' });
  downloadBlob(blob, a.fileName.replace(/\.wav$/i, '') + '.repair.json');
};

function projectMatches(p, d) {
  return p && p.audio && d &&
    p.audio.sampleRate === d.sampleRate &&
    p.audio.channels === d.channels &&
    p.audio.frames === d.frames;
}

$('btnLoadProj').onclick = () => $('fileProj').click();
$('fileProj').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    if (p.app !== 'spectral-patch-repair' || !Array.isArray(p.boxes)) throw new Error('不是本工具保存的工程文件');
    // 兼容字段补全
    p.boxes.forEach((b, i) => {
      b.id = b.id || i + 1;
      b.enabled = b.enabled !== false;
      b.attenDb = clamp(b.attenDb ?? 24, 0, 60);
      if (!Array.isArray(b.channels) || !b.channels.length) b.channels = [0];
    });
    if (state.audio && projectMatches(p, state.audio)) {
      state.boxes = p.boxes.map(b => Object.assign({}, b));
      state.nextId = Math.max(0, ...state.boxes.map(b => b.id)) + 1;
      commit(); refreshBoxUI(); scheduleProcess(); requestRender();
      setStatus(`已载入工程：${state.boxes.length} 个选框`);
    } else {
      state.pendingProject = p;
      setStatus(`工程已读取（源音频：${p.audio.name}），请导入同一音频以恢复选框`, true);
    }
  } catch (err) {
    alert('载入工程失败：' + err.message);
  }
};

/* ---------------- 导出 ---------------- */
$('btnExport').onclick = async () => {
  const a = state.audio;
  if (!a) return;
  if (state.dirty) {
    setStatus('正在等待处理完成…');
    clearTimeout(procTimer);
    await runProcess();
  }
  const ints = activeBoxes().length && state.processedInts ? state.processedInts : a.ints;
  const buf = DSP.encodeWav({ sampleRate: a.sampleRate, bitsPerSample: a.bitsPerSample, channelInts: ints });
  const name = a.fileName.replace(/\.wav$/i, '') + '.repaired.wav';
  downloadBlob(new Blob([buf], { type: 'audio/wav' }), name);
  setStatus(`已导出 ${name}（${a.sampleRate}Hz · ${a.channels}声道 · ${a.bitsPerSample}bit · ${a.frames}帧）`);
};

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url; aEl.download = name;
  aEl.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
