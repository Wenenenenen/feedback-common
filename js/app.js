/**
 * 主应用：文件导入与校验 → 求解调度（Worker，可取消；失败回退主线程）
 * → 重建图 / 残差 / 收敛曲线 / 像素贡献探查 / 导出。
 */
import { decodePng } from './png-codec.js';
import { buildModel } from './model.js';
import { runReconstruction } from './reconstruct.js';
import { renderConvergenceChart } from './chart.js';
import {
  renderDiverging, renderSequential, drawMarker, eventToCell,
  divergingLegend, sequentialLegend, formatNum,
} from './heatmap.js';
import { exportPng, exportFloat64, exportParams, clipToUint8 } from './export.js';

const MAX_SIDE = 128;
const MIN_FRAMES = 2;
const MAX_FRAMES = 8;

const state = {
  files: new Map(),        // 文件名 → {bytes, decoded}
  frames: [],              // {file, shift:[dx,dy], mask:null|file}
  kernel: [[1]],
  W: 0, H: 0, channels: 0,
  config: null,            // 导入的 JSON 原文（用于参数导出）
  running: false,
  worker: null,
  fallbackAbort: null,
  result: null,            // {x:[Float64Array], residuals:[[Float64Array]], histories, dims, stats, summaries, weightMasks}
  probeModel: null,
  selected: { frame: 0, u: 0, v: 0, channel: 0 },
};

const $ = (id) => document.getElementById(id);

// ---------- 主题 ----------
function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.result) renderAllResults();
});

// ---------- 工具 ----------
function setStatus(kind, text) {
  const bar = $('status-bar');
  bar.className = `status ${kind}`;
  bar.textContent = text;
}
function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  return Number(v.toPrecision(6)).toString();
}

// ---------- 文件导入 ----------
async function handleFiles(fileList) {
  const incoming = Array.from(fileList);
  const jsonFiles = incoming.filter((f) => f.name.toLowerCase().endsWith('.json'));
  const pngFiles = incoming.filter((f) => f.name.toLowerCase().endsWith('.png'));
  if (incoming.length !== jsonFiles.length + pngFiles.length) {
    setStatus('error', '只接受 .png 与 .json 文件');
    return;
  }
  try {
    for (const f of pngFiles) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const decoded = await decodePng(bytes.buffer);
      if (decoded.width > MAX_SIDE || decoded.height > MAX_SIDE) {
        throw new Error(`${f.name} 单边 ${decoded.width > decoded.height ? decoded.width : decoded.height} 超过上限 ${MAX_SIDE}`);
      }
      state.files.set(f.name, { bytes, decoded });
    }
    if (jsonFiles.length > 1) throw new Error('一次最多导入一个 JSON 配置');
    if (jsonFiles.length === 1) await applyConfig(await jsonFiles[0].text(), jsonFiles[0].name);
    rebuildFrameTable();
    setStatus('ok', `已载入 ${state.files.size} 个 PNG${jsonFiles.length ? ` 与配置 ${jsonFiles[0].name}` : ''}，可在帧表中调整后开始重建`);
  } catch (err) {
    setStatus('error', `导入失败：${err.message}`);
  }
}

async function applyConfig(text, name) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error(`${name} 不是合法 JSON`);
  }
  if (!Array.isArray(cfg.frames)) throw new Error('JSON 缺少 frames 数组');
  if (cfg.frames.length < MIN_FRAMES || cfg.frames.length > MAX_FRAMES) {
    throw new Error(`frames 数量必须在 ${MIN_FRAMES}–${MAX_FRAMES} 之间（当前 ${cfg.frames.length}）`);
  }
  for (const [i, fr] of cfg.frames.entries()) {
    if (!fr.file || !Array.isArray(fr.shift) || fr.shift.length !== 2) {
      throw new Error(`第 ${i + 1} 帧缺少 file 或 shift:[dx,dy]`);
    }
    const [dx, dy] = fr.shift.map(Number);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      throw new Error(`第 ${i + 1} 帧位移分量必须是 [-4,4] 内的有限数`);
    }
  }
  if (!Array.isArray(cfg.kernel)) throw new Error('JSON 缺少 kernel');
  validateKernel(cfg.kernel);
  state.kernel = cfg.kernel.map((row) => row.slice());
  state.config = cfg;
  state.frames = cfg.frames.map((fr) => ({
    file: fr.file,
    shift: [Number(fr.shift[0]), Number(fr.shift[1])],
    mask: fr.mask || null,
  }));
  if (cfg.lambda !== undefined) $('lambda').value = cfg.lambda;
  if (cfg.tol !== undefined) $('tol').value = cfg.tol;
  if (cfg.max_iter !== undefined) $('max-iter').value = cfg.max_iter;
  syncReadouts();
  renderKernelEditor();
}

function validateKernel(k) {
  if (!Array.isArray(k) || k.length === 0 || k.some((row) => !Array.isArray(row) || row.length !== k.length)) {
    throw new Error('kernel 必须为方阵');
  }
  if (![1, 3, 5].includes(k.length)) throw new Error('kernel 边长只能是 1、3 或 5');
  let sum = 0;
  for (const row of k) {
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error('kernel 系数必须为非负有限数');
      }
      sum += v;
    }
  }
  if (Math.abs(sum - 1) > 1e-8) {
    throw new Error(`kernel 权重之和必须恰为 1（当前 ${fmt(sum)}）；缺测不得靠重归一化弥补，请修改系数`);
  }
}

function rebuildFrameTable() {
  // JSON 未指定的 PNG：按文件名顺序补入观测帧（位移 0，无掩膜）
  const referenced = new Set();
  for (const fr of state.frames) {
    referenced.add(fr.file);
    if (fr.mask) referenced.add(fr.mask);
  }
  const extras = [...state.files.keys()]
    .filter((n) => !referenced.has(n))
    .sort();
  for (const name of extras) {
    const dec = state.files.get(name).decoded;
    if (dec.channels === 1) {
      // 灰度图可能是观测也可能是掩膜：无法自动判定时一律先作为观测，用户可在表中调整
      state.frames.push({ file: name, shift: [0, 0], mask: null });
    } else if (dec.channels === 3) {
      state.frames.push({ file: name, shift: [0, 0], mask: null });
    }
  }
  state.frames = state.frames.filter((fr) => state.files.has(fr.file));
  renderFrameTable();
  renderMaskOptions();
}

function renderFrameTable() {
  const tbody = $('frame-rows');
  tbody.replaceChildren();
  state.frames.forEach((fr, idx) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = fr.file;
    tr.appendChild(tdName);

    const tdDx = document.createElement('td');
    const dx = numberInput(fr.shift[0], (v) => { fr.shift[0] = v; }, -4, 4, 0.5);
    tdDx.appendChild(dx);
    tr.appendChild(tdDx);

    const tdDy = document.createElement('td');
    const dy = numberInput(fr.shift[1], (v) => { fr.shift[1] = v; }, -4, 4, 0.5);
    tdDy.appendChild(dy);
    tr.appendChild(tdDy);

    const tdMask = document.createElement('td');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `第 ${idx + 1} 帧掩膜`);
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '无掩膜（权重=1）';
    sel.appendChild(none);
    for (const [name, entry] of state.files) {
      if (entry.decoded.channels !== 1) continue;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (fr.mask === name) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { fr.mask = sel.value || null; });
    tdMask.appendChild(sel);
    tr.appendChild(tdMask);

    const tdOp = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'btn small ghost';
    del.textContent = '移除';
    del.addEventListener('click', () => {
      state.frames.splice(idx, 1);
      renderFrameTable();
      renderMaskOptions();
    });
    tdOp.appendChild(del);
    tr.appendChild(tdOp);

    tbody.appendChild(tr);
  });
  $('frame-count').textContent = String(state.frames.length);
}

function numberInput(value, onInput, min, max, step) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value;
  inp.min = min;
  inp.max = max;
  inp.step = step;
  inp.className = 'num-input';
  inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || v < min || v > max) {
      inp.value = value;
      setStatus('error', `位移分量必须在 [${min}, ${max}] 内`);
      return;
    }
    onInput(v);
  });
  return inp;
}

function renderMaskOptions() {
  renderFrameTable();
}

// ---------- kernel 编辑器 ----------
function renderKernelEditor() {
  const k = state.kernel;
  const n = k.length;
  $('kernel-size').value = String(n);
  const grid = $('kernel-grid');
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.min = '0';
      inp.className = 'kernel-input';
      inp.value = k[j][i];
      inp.setAttribute('aria-label', `核系数 [${j}][${i}]`);
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v) || v < 0) {
          inp.value = k[j][i];
          return;
        }
        k[j][i] = v;
        updateKernelSum();
      });
      grid.appendChild(inp);
    }
  }
  updateKernelSum();
}

function updateKernelSum() {
  const sum = state.kernel.flat().reduce((a, b) => a + b, 0);
  const el = $('kernel-sum');
  el.textContent = fmt(sum);
  el.classList.toggle('bad', Math.abs(sum - 1) > 1e-8);
}

$('kernel-size').addEventListener('change', () => {
  const n = Number($('kernel-size').value);
  const k = Array.from({ length: n }, () => new Array(n).fill(0));
  k[(n - 1) / 2][(n - 1) / 2] = 1; // 默认中心 1，保证和为 1
  state.kernel = k;
  renderKernelEditor();
});
$('kernel-normalize').addEventListener('click', () => {
  const sum = state.kernel.flat().reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    setStatus('error', '核全为 0，无法归一化');
    return;
  }
  state.kernel = state.kernel.map((row) => row.map((v) => v / sum));
  renderKernelEditor();
  setStatus('ok', '已按显式操作归一化（求解本身不会自动重归一化任何采样）');
});

// ---------- 控件 ----------
function syncReadouts() {
  $('lambda-val').textContent = $('lambda').value;
  $('tol-val').textContent = $('tol').value;
  $('max-iter-val').textContent = $('max-iter').value;
}
['lambda', 'tol', 'max-iter'].forEach((id) => $(id).addEventListener('input', syncReadouts));

// ---------- 组装求解载荷 ----------
function buildPayload() {
  if (state.frames.length < MIN_FRAMES || state.frames.length > MAX_FRAMES) {
    throw new Error(`观测帧数量必须在 ${MIN_FRAMES}–${MAX_FRAMES} 之间（当前 ${state.frames.length}）`);
  }
  validateKernel(state.kernel);
  let W = 0;
  let H = 0;
  let channels = 0;
  for (const fr of state.frames) {
    const entry = state.files.get(fr.file);
    if (!entry) throw new Error(`找不到文件 ${fr.file}，请重新导入`);
    const d = entry.decoded;
    if (W === 0) {
      W = d.width; H = d.height; channels = d.channels;
    } else if (d.width !== W || d.height !== H || d.channels !== channels) {
      throw new Error(`帧 ${fr.file} 尺寸/通道与首帧不一致`);
    }
    if (fr.mask) {
      const m = state.files.get(fr.mask);
      if (!m) throw new Error(`掩膜文件 ${fr.mask} 缺失`);
      if (m.decoded.channels !== 1 || m.decoded.width !== W || m.decoded.height !== H) {
        throw new Error(`掩膜 ${fr.mask} 必须是与观测同尺寸的 8 位灰度 PNG`);
      }
    }
  }
  state.W = W; state.H = H; state.channels = channels;

  const frameBands = state.frames.map((fr) => {
    const d = state.files.get(fr.file).decoded;
    const bands = [];
    for (let ch = 0; ch < channels; ch++) {
      const v = new Float64Array(W * H);
      for (let q = 0; q < W * H; q++) v[q] = d.data[q * channels + ch] / 255;
      bands.push(v);
    }
    return bands;
  });
  const weightBands = state.frames.map((fr) => {
    if (!fr.mask) return null;
    const d = state.files.get(fr.mask).decoded;
    return Float64Array.from(d.data, (b) => b / 255);
  });

  const lambda = Number($('lambda').value);
  const tol = Number($('tol').value);
  const maxIter = Number($('max-iter').value);
  if (!(lambda >= 0 && lambda <= 1)) throw new Error('lambda 必须在 [0,1]');
  if (!(tol >= 1e-10 && tol <= 1e-2)) throw new Error('tol 必须在 [1e-10,1e-2]');
  if (!(Number.isInteger(maxIter) && maxIter >= 1 && maxIter <= 300)) {
    throw new Error('max_iter 必须为 1..300 的整数');
  }

  return {
    W, H, channels,
    kernel: state.kernel.map((r) => r.slice()),
    lambda, tol, maxIter,
    shifts: state.frames.map((fr) => fr.shift.slice()),
    weightBands, frameBands,
  };
}

// ---------- 运行 / 取消 ----------
$('run-btn').addEventListener('click', startRun);
$('cancel-btn').addEventListener('click', cancelRun);

function startRun() {
  let payload;
  try {
    payload = buildPayload();
  } catch (err) {
    setStatus('error', err.message);
    return;
  }
  state.result = null;
  state.running = true;
  $('results').classList.remove('visible');
  $('run-btn').disabled = true;
  $('cancel-btn').disabled = false;
  $('progress-log').hidden = false;
  $('progress-log').replaceChildren();
  setStatus('running', '求解中…');
  const t0 = performance.now();

  const handle = (msg) => {
    if (msg.type === 'progress') {
      if (msg.iter % 10 === 0 || msg.iter <= 3) {
        const line = document.createElement('div');
        line.className = 'progress-line';
        line.textContent = `通道${msg.channel} · 迭代 ${msg.iter} · 相对残差 ${msg.relResidual.toExponential(3)} · J=${msg.objective.toExponential(4)}`;
        $('progress-log').appendChild(line);
        $('progress-log').scrollTop = $('progress-log').scrollHeight;
      }
    } else if (msg.type === 'channelDone') {
      absorbChannel(msg, payload);
    } else if (msg.type === 'done') {
      finishRun(t0, payload, msg.dims);
    } else if (msg.type === 'error') {
      failRun(msg.message);
    }
  };

  let settled = false; // 防止 worker 报错与正常消息竞争导致重复求解

  try {
    const worker = new Worker('./js/solver-worker.js', { type: 'module' });
    state.worker = worker;
    worker.onmessage = (ev) => handle(ev.data);
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      // Worker 整体失败（如 file:// 下 module worker 被拦）→ 主线程回退
      worker.terminate();
      state.worker = null;
      runOnMainThread(payload, handle, t0);
    };
    worker.postMessage({ type: 'start', payload });
  } catch {
    if (settled) return;
    settled = true;
    runOnMainThread(payload, handle, t0);
  }
}

function runOnMainThread(payload, handle, t0) {
  setStatus('running', 'Worker 不可用，已回退到主线程求解（页面可能短暂无响应）…');
  state.fallbackAbort = { aborted: false };
  setTimeout(() => {
    try {
      const p = { ...payload, abortSignal: state.fallbackAbort };
      runReconstruction(p, (msg, transfer) => {
        // 主线程下 buffer 仍是当前 ArrayBuffer，直接交给同一处理函数
        handle(msg);
      });
    } catch (err) {
      handle({ type: 'error', message: err.message });
    }
  }, 30);
}

function cancelRun() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  if (state.fallbackAbort) state.fallbackAbort.aborted = true;
  state.running = false;
  $('run-btn').disabled = false;
  $('cancel-btn').disabled = true;
  setStatus('warn', '已取消：本次迭代结果已丢弃，可调整参数后重新运行');
}

function absorbChannel(msg, payload) {
  if (!state.result) {
    state.result = {
      x: [],
      residuals: [],
      histories: [],
      summaries: [],
      stats: [],
      dims: null,
      weightMasks: payload.weightBands,
      weightedRmse: [],
    };
  }
  state.result.x[msg.channel] = new Float64Array(msg.xBuffer);
  state.result.residuals[msg.channel] = msg.residualBuffers.map((b) => new Float64Array(b));
  state.result.histories[msg.channel] = msg.history;
  state.result.summaries[msg.channel] = {
    iterations: msg.iterations,
    stopReason: msg.stopReason,
    finalRelResidual: msg.finalRelResidual,
  };
  state.result.stats[msg.channel] = msg.stats;
  state.result.weightedRmse[msg.channel] = msg.weightedRmse;
}

function finishRun(t0, payload, dims) {
  state.running = false;
  state.worker = null;
  $('run-btn').disabled = false;
  $('cancel-btn').disabled = true;
  state.result.dims = dims;
  // 贡献探查需要一份轻量模型（仅结构，无观测值）
  state.probeModel = buildModel(
    payload.W, payload.H, payload.kernel,
    state.frames.map((fr, f) => ({ shift: fr.shift, weights: payload.weightBands[f] }))
  );
  state.selected.frame = 0;
  state.selected.channel = 0;
  const sec = ((performance.now() - t0) / 1000).toFixed(2);
  const iters = state.result.summaries.map((s) => s.iterations).join('/');
  setStatus('ok', `重建完成（${sec}s，各通道迭代 ${iters}）`);
  $('results').classList.add('visible');
  renderAllResults();
}

function failRun(message) {
  state.running = false;
  state.worker = null;
  $('run-btn').disabled = false;
  $('cancel-btn').disabled = true;
  setStatus('error', `求解失败：${message}`);
}

// ---------- 结果渲染 ----------
function renderAllResults() {
  const r = state.result;
  if (!r) return;
  const { GW, GH, channels } = r.dims;
  const dark = isDark();

  // 重建图（canvas，最近邻）
  const clipped = clipToUint8(r.x, GW, GH, channels);
  const rgba = new Uint8ClampedArray(GW * GH * 4);
  for (let n = 0; n < GW * GH; n++) {
    if (channels === 1) {
      rgba[n * 4] = rgba[n * 4 + 1] = rgba[n * 4 + 2] = clipped[n];
    } else {
      rgba[n * 4] = clipped[n * 3];
      rgba[n * 4 + 1] = clipped[n * 3 + 1];
      rgba[n * 4 + 2] = clipped[n * 3 + 2];
    }
    rgba[n * 4 + 3] = 255;
  }
  const img = new ImageData(rgba, GW, GH);
  const off = document.createElement('canvas');
  off.width = GW; off.height = GH;
  off.getContext('2d').putImageData(img, 0, 0);
  const canvas = $('recon-canvas');
  const cssW = canvas.parentElement.clientWidth - 8;
  canvas.width = GW;
  canvas.height = GH;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, GW, GH);
  ctx.drawImage(off, 0, 0);

  // 统计块
  const stat = r.stats[0];
  const chTxt = channels === 1 ? '灰度' : 'RGB';
  $('stat-grid').textContent =
    `${GW}×${GH}（2× 重建）· ${chTxt} · ${r.dims.frames} 帧`;
  $('stat-conv').textContent = r.summaries.map((s, i) =>
    `${channels === 1 ? '' : ['R', 'G', 'B'][i] + ' '}${s.iterations} 次 / ${s.stopReason}`).join('；');
  $('stat-residual').textContent = r.summaries.map((s, i) =>
    `${channels === 1 ? '' : ['R', 'G', 'B'][i] + ' '}${s.finalRelResidual.toExponential(2)}`).join('；');
  $('stat-boundary').textContent =
    `越界采样 ${stat.partialSamples} 个（零填充、未重归一化）· 零掩膜 ${stat.zeroMaskSamples} 个`;
  const clipping = r.stats.map((s) => s.belowZero + s.aboveOne);
  $('stat-clip').textContent = clipping.every((c) => c === 0)
    ? '所有网格点均在 [0,1] 内'
    : `未截断越界：低于0 共 ${r.stats.reduce((a, s) => a + s.belowZero, 0)} 点，高于1 共 ${r.stats.reduce((a, s) => a + s.aboveOne, 0)} 点（浮点导出保留原值）`;

  // 收敛曲线
  renderConvergenceChart($('conv-chart'), r.histories, Number($('tol').value), dark);

  // 帧选择器
  const frameSel = $('probe-frame');
  frameSel.replaceChildren();
  for (let f = 0; f < r.dims.frames; f++) {
    const opt = document.createElement('option');
    opt.value = String(f);
    opt.textContent = `第 ${f + 1} 帧（${state.frames[f].file}）`;
    frameSel.appendChild(opt);
  }
  frameSel.value = String(state.selected.frame);
  const chSel = $('probe-channel');
  chSel.replaceChildren();
  const names = channels === 1 ? ['灰度'] : ['R', 'G', 'B'];
  names.forEach((n, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = n;
    chSel.appendChild(opt);
  });
  chSel.value = String(state.selected.channel);

  renderResidualAndProbe();
  wireProbeInteractions();
}

function renderResidualAndProbe() {
  const r = state.result;
  const dark = isDark();
  const { W, H } = r.dims;
  const f = state.selected.frame;
  const ch = state.selected.channel;

  // 残差热力图
  const res = r.residuals[ch][f];
  const maxAbs = Math.max(...res.map((v) => Math.abs(v)), 1e-12);
  const mask = r.weightMasks[f];
  const zeroMask = mask ? Uint8Array.from(mask, (w) => (w === 0 ? 1 : 0)) : null;
  renderDiverging($('residual-canvas'), res, W, H, maxAbs, zeroMask, dark);
  drawMarker($('residual-canvas'), W, H, state.selected.u, state.selected.v);
  const lg = divergingLegend(maxAbs, dark);
  $('residual-legend-bar').style.background = `linear-gradient(90deg, ${lg.stops.join(',')})`;
  $('residual-legend-label').textContent = lg.label;
  const rmse = r.weightedRmse[ch][f];
  $('residual-rmse').textContent =
    `加权 RMSE ${formatNum(rmse)} · 最大|r| ${formatNum(maxAbs)}`;

  // 观测图（该帧原始低分辨率）
  const dec = state.files.get(state.frames[f].file).decoded;
  const obsBytes = new Uint8Array(W * H);
  for (let q = 0; q < W * H; q++) obsBytes[q] = dec.data[q * dec.channels + (dec.channels === 1 ? 0 : ch)];
  const obsOff = document.createElement('canvas');
  obsOff.width = W; obsOff.height = H;
  const octx = obsOff.getContext('2d');
  const obsImg = octx.createImageData(W, H);
  for (let q = 0; q < W * H; q++) {
    obsImg.data[q * 4] = obsImg.data[q * 4 + 1] = obsImg.data[q * 4 + 2] = obsBytes[q];
    obsImg.data[q * 4 + 3] = 255;
  }  octx.putImageData(obsImg, 0, 0);
  const oc = $('observation-canvas');
  oc.width = W; oc.height = H;
  oc.style.width = '100%';
  oc.style.height = 'auto';
  const c2 = oc.getContext('2d');
  c2.imageSmoothingEnabled = false;
  c2.drawImage(obsOff, 0, 0);
  drawMarker(oc, W, H, state.selected.u, state.selected.v);

  renderProbeContribution();
}

function renderProbeContribution() {
  const r = state.result;
  const dark = isDark();
  const { W, H, GW, GH } = r.dims;
  const f = state.selected.frame;
  const u = state.selected.u;
  const v = state.selected.v;
  const ch = state.selected.channel;

  const map = state.probeModel.pixelContribution(f, u, v);
  const coverage = state.probeModel.bilinearCoverage(f, u, v);
  const grid = new Float64Array(GW * GH);
  let total = 0;
  for (const [idx, val] of map) {
    grid[idx] = val;
    total += val;
  }
  const maxVal = Math.max(...grid, 1e-12);
  renderSequential($('contrib-canvas'), grid, GW, GH, maxVal, dark);
  const lg = sequentialLegend(maxVal, dark);
  $('contrib-legend-bar').style.background = `linear-gradient(90deg, ${lg.stops.join(',')})`;
  $('contrib-legend-label').textContent = lg.label;

  // 数值面板
  const panel = $('probe-detail');
  panel.replaceChildren();
  const head = document.createElement('div');
  head.className = 'probe-head';
  head.textContent = `帧 ${f + 1} 观测像素 (u=${u}, v=${v}) → ${GW}×${GH} 高分辨率网格（通道 ${ch}）`;
  panel.appendChild(head);

  const rows = [
    ['双线性覆盖率', `${formatNum(coverage)}${coverage < 1 - 1e-12 ? '（<1：存在越界邻项，按 0 处理且未重归一化）' : ''}`],
    ['贡献系数之和', formatNum(total)],
    ['非零贡献网格点', `${map.size} 个（含卷积扩散；图外 tap 已按 0 剔除）`],
  ];
  for (const [k, val] of rows) {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const key = document.createElement('span');
    key.className = 'kv-key';
    key.textContent = k;
    const value = document.createElement('span');
    value.className = 'kv-val';
    value.textContent = val;
    row.append(key, value);
    panel.appendChild(row);
  }

  const sub = document.createElement('div');
  sub.className = 'probe-sub';
  sub.textContent = '最大的 8 个贡献：';
  panel.appendChild(sub);
  const top = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [idx, val] of top) {
    const y = Math.floor(idx / GW);
    const x = idx - y * GW;
    const row = document.createElement('div');
    row.className = 'kv-row';
    const key = document.createElement('span');
    key.className = 'kv-key';
    key.textContent = `网格 (x=${x}, y=${y})`;
    const value = document.createElement('span');
    value.className = 'kv-val tabular';
    value.textContent = formatNum(val);
    row.append(key, value);
    panel.appendChild(row);
  }
}

function wireProbeInteractions() {
  const { W, H } = state.result.dims;
  for (const canvasId of ['residual-canvas', 'observation-canvas']) {
    const canvas = $(canvasId);
    canvas.onclick = (ev) => {
      const cell = eventToCell(canvas, W, H, ev);
      if (!cell) return;
      state.selected.u = cell.u;
      state.selected.v = cell.v;
      renderResidualAndProbe();
    };
  }
  $('probe-frame').onchange = (ev) => {
    state.selected.frame = Number(ev.target.value);
    renderResidualAndProbe();
  };
  $('probe-channel').onchange = (ev) => {
    state.selected.channel = Number(ev.target.value);
    renderResidualAndProbe();
  };
}

// ---------- 导出 ----------
$('export-png').addEventListener('click', () => {
  if (!guardResult()) return;
  const { GW, GH, channels } = state.result.dims;
  exportPng(state.result.x, GW, GH, channels, exportStem());
});
$('export-float').addEventListener('click', () => {
  if (!guardResult()) return;
  const { GW, GH, channels } = state.result.dims;
  exportFloat64(state.result.x, GW, GH, channels, exportStem());
});
$('export-params').addEventListener('click', () => {
  if (!guardResult()) return;
  const { W, H, GW, GH, channels } = state.result.dims;
  const params = {
    generated_at: new Date().toISOString(),
    observation_model: {
      low_resolution: [W, H],
      high_resolution: [GW, GH],
      upscale: 2,
      channels,
      pixel_value: 'PNG 字节 /255 的线性值，无 sRGB 转换',
      convolution: '真卷积 B[y,x]=Σ k[j,i] X[y-(j-c),x-(i-c)]，图外 X=0',
      sampling: '在 B 坐标 (2u+dx,2v+dy) 双线性取样，越界四邻项视 0，不重归一化',
      mask: 'weight=mask/255，无掩膜权重=1',
    },
    objective: '0.5 Σ w(AX-Y)² + λ/2 Σ_边(差分)² + η/2 Σ X²',
    solver: {
      method: '普通共轭梯度（无预条件），零初始化，迭代中不截断',
      eta: 1e-6,
      lambda: Number($('lambda').value),
      tol: Number($('tol').value),
      max_iter: Number($('max-iter').value),
      stop_rule: '‖r‖/max(‖b‖,1e-12) <= tol 或达到 max_iter',
      summaries: state.result.summaries,
    },
    kernel: state.kernel,
    frames: state.frames.map((fr, f) => ({
      file: fr.file,
      shift: fr.shift,
      mask: fr.mask,
      weighted_rmse: state.result.weightedRmse.map((v) => v[f]),
    })),
    float64_export: {
      endian: 'little',
      dtype: 'float64',
      layout: channels === 1 ? '行优先灰度' : '逐像素 RGB 交错（像素内 R,G,B）',
      shape: [GH, GW, channels],
    },
  };
  exportParams(params, exportStem());
});

function guardResult() {
  if (!state.result) {
    setStatus('warn', '还没有重建结果，请先运行');
    return false;
  }
  return true;
}
function exportStem() {
  return `burst-recon-${state.W}x${state.H}-${state.frames.length}f`;
}

// ---------- 拖拽与添加帧 ----------
const drop = $('drop-zone');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => {
  ev.preventDefault();
  drop.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => {
  ev.preventDefault();
  drop.classList.remove('dragover');
}));
drop.addEventListener('drop', (ev) => handleFiles(ev.dataTransfer.files));
$('file-input').addEventListener('change', (ev) => handleFiles(ev.target.files));
drop.addEventListener('click', () => $('file-input').click());
drop.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    $('file-input').click();
  }
});

$('add-frame').addEventListener('click', () => $('file-input').click());

// 主题切换
$('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  root.setAttribute('data-theme', isDark() ? 'light' : 'dark');
  if (state.result) renderAllResults();
});

// 初始化控件回显
syncReadouts();
renderKernelEditor();
renderFrameTable();
