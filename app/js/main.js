// 主线程：状态管理、Worker 调度（取消 / 旧任务不覆盖新结果）、视图渲染、
// 组检查器、导入导出。

import { SAMPLES } from './samples.js';
import { decodePNG } from '../../lib/png.js';
import {
  validateParams,
  inspectGroup,
  psnr,
  DEFAULT_PARAMS,
  runDenoise,
  LIMITS,
} from '../../lib/engine.js';
import { referenceCenters, mirrorIndex } from '../../lib/layout.js';
import { dct2, idct2, groupTransform } from '../../lib/transform.js';
import {
  buildPilotPNG,
  buildFinalPNG,
  buildFloatNpy,
  buildReport,
  buildZip,
  downloadBytes,
  downloadText,
  timestampSlug,
} from './export.js';
import {
  drawGrayToCanvas,
  drawWeightToCanvas,
  drawGroupLayout,
  drawMatrixHeatmap,
  drawSelectionOutline,
  groupScale,
} from './render.js';

const $ = (id) => document.getElementById(id);

const state = {
  image: { width: 0, height: 0, data: null },
  imageSource: null,
  reference: null,
  referenceSource: null,
  result: null,
  resultParamsKey: null,
  stale: false,
  selected: null,
  inspect: null,
  inspectStage: 1,
  inspectMode: 'dct',
  inspectMember: 0,
  weightStage: 2,
  jobId: 0,
  jobPending: false,
  jobStartedAt: 0,
};

let worker = null;
let workerFailed = false;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, isError ? 6500 : 3200);
}

function setStatus(kind, text) {
  $('statusDot').className = `status-dot ${kind}`;
  $('statusText').textContent = text;
}

function paramsFromUI() {
  return {
    patch: Number($('patch').value),
    capacity: Number($('capacity').value),
    stride: Number($('stride').value),
    radius: Number($('radius').value),
    sigma: Number($('sigma').value),
    threshold: Number($('threshold').value),
  };
}

function applyParamsToUI(p) {
  $('patch').value = String(p.patch);
  $('capacity').value = String(p.capacity);
  fillStrideOptions(Number(p.patch), p.stride);
  $('radius').value = String(p.radius);
  $('sigma').value = String(p.sigma);
  $('threshold').value = String(p.threshold);
  $('radiusVal').textContent = String(p.radius);
  $('sigmaVal').textContent = formatNumber(p.sigma, 1);
  $('thresholdVal').textContent = formatNumber(p.threshold, 1);
}

function fillStrideOptions(patch, selected) {
  const sel = $('stride');
  const prev = selected ?? (Number(sel.value) || 2);
  sel.innerHTML = '';
  for (let s = 2; s <= patch; s++) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = String(s);
    sel.appendChild(opt);
  }
  sel.value = String(prev <= patch && prev >= 2 ? prev : 2);
}

function paramsKey(p) {
  return [p.patch, p.radius, p.stride, p.capacity, p.sigma, p.threshold].join('|');
}

function formatNumber(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  if (Object.is(v, -0)) return '0';
  const text = Number.isInteger(v) ? String(v) : v.toFixed(digits);
  return text === '-0' ? '0' : text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 图像载入
// ---------------------------------------------------------------------------

async function loadImageBytes(bytes, name, { reference = false } = {}) {
  let decoded;
  try {
    decoded = await decodePNG(bytes);
  } catch (err) {
    toast(`无法读取 PNG：${err.message}`, true);
    return null;
  }
  if (decoded.width > 256 || decoded.height > 256) {
    toast(`图像 ${decoded.width}×${decoded.height} 超出上限 256×256，未载入。`, true);
    return null;
  }
  if (reference) {
    if (state.image.data && (decoded.width !== state.image.width || decoded.height !== state.image.height)) {
      toast(`参考图尺寸 ${decoded.width}×${decoded.height} 与当前图像 ${state.image.width}×${state.image.height} 不一致，未载入。`, true);
      return null;
    }
    state.reference = { width: decoded.width, height: decoded.height, data: decoded.data };
    state.referenceSource = name;
  } else {
    state.image = { width: decoded.width, height: decoded.height, data: decoded.data };
    state.imageSource = name;
    state.result = null;
    state.selected = null;
    state.inspect = null;
    state.stale = false;
    if (state.reference && (state.reference.width !== decoded.width || state.reference.height !== decoded.height)) {
      state.reference = null;
      state.referenceSource = null;
    }
  }
  renderAll();
  return decoded;
}

async function loadSample(id) {
  const sample = SAMPLES[id];
  if (!sample) return;
  const bytes = bytesFromBase64(sample.pngBase64);
  await loadImageBytes(bytes, `样例：${sample.label}`);
  state.reference = null;
  state.referenceSource = null;
  if (id === 'noisy') {
    const clean = SAMPLES.clean;
    if (clean) {
      const decoded = await decodePNG(bytesFromBase64(clean.pngBase64));
      state.reference = { width: decoded.width, height: decoded.height, data: decoded.data };
      state.referenceSource = '样例：干净参考';
    }
  }
  renderAll();
  run();
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function ensureWorker() {
  if (worker) return worker;
  let created = null;
  try {
    if (typeof self.__GTD_WORKER_SOURCE === 'string') {
      // 打包版（file:// 直接打开）：Worker 源码内联，用 Blob URL 构造。
      const url = URL.createObjectURL(new Blob([self.__GTD_WORKER_SOURCE], { type: 'text/javascript' }));
      created = new Worker(url);
    } else {
      created = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    }
  } catch (err) {
    workerFailed = true;
    return null;
  }
  worker = created;
  worker.onmessage = onWorkerMessage;
  worker.onerror = (event) => {
    workerFailed = true;
    worker = null;
    setStatus('error', 'Worker 不可用，已切换到主线程计算');
    toast(`Worker 出错：${event.message || '未知错误'}，已切换到主线程。`, true);
    if (state.jobPending) runOnMainThread(state.jobId, state.pendingParams || paramsFromUI());
  };
  return worker;
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (!msg) return;
  if (msg.jobId !== state.jobId) return; // 旧任务结果一律丢弃
  if (msg.type === 'progress') {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    $('progressBar').style.width = `${pct}%`;
    const label = msg.phase === 'pilot' ? '阶段 1 · 硬阈值初估' : '阶段 2 · 维纳重建';
    setStatus('running', `${label} ${msg.done}/${msg.total}（${pct}%）`);
    return;
  }
  if (msg.type === 'canceled') {
    state.jobPending = false;
    setStatus('canceled', '已取消，保留上一次完成的结果');
    $('cancelBtn').disabled = true;
    $('progressBar').style.width = '0%';
    return;
  }
  if (msg.type === 'error') {
    state.jobPending = false;
    setStatus('error', `计算失败：${msg.message}`);
    $('cancelBtn').disabled = true;
    toast(`计算失败：${msg.message}`, true);
    return;
  }
  if (msg.type === 'done') {
    state.jobPending = false;
    state.result = {
      width: msg.width,
      height: msg.height,
      params: msg.params,
      original: msg.original,
      pilot: msg.pilot,
      final: msg.final,
      weight1: msg.weight1,
      weight2: msg.weight2,
      groups: msg.groups,
      timing: msg.timing,
      zeroNoise: msg.zeroNoise,
      canceled: false,
    };
    state.resultParamsKey = paramsKey(msg.params);
    state.stale = state.resultParamsKey !== paramsKey(paramsFromUI());
    $('cancelBtn').disabled = true;
    $('exportBtn').disabled = false;
    $('progressBar').style.width = '100%';
    setStatus('done', `完成 · ${formatMs(msg.timing.totalMs)}（初估 ${formatMs(msg.timing.stage1Ms)} / 维纳 ${formatMs(msg.timing.stage2Ms)}）`);
    if (state.selected) {
      // 旧结果的检查器不能沿用到新参数上
      loadInspection(state.selected.y, state.selected.x);
    } else {
      renderInspector();
    }
    renderAll();
    updateStaleNote();
    return;
  }
}

function run() {
  if (!state.image.data) return;
  let params;
  try {
    params = validateParams(paramsFromUI());
  } catch (err) {
    toast(err.message, true);
    return;
  }
  state.jobId += 1;
  const jobId = state.jobId;
  state.jobPending = true;
  state.pendingParams = params;
  state.jobStartedAt = performance.now();
  $('runBtn').disabled = true;
  $('cancelBtn').disabled = false;
  $('progressBar').style.width = '0%';
  setStatus('running', '已排队…');
  updateStaleNote();

  const w = ensureWorker();
  if (w) {
    // 复制一份像素，避免主线程后续操作影响正在计算的任务
    const pixels = new Float64Array(state.image.width * state.image.height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = state.image.data[i];
    w.postMessage(
      { type: 'run', jobId, width: state.image.width, height: state.image.height, data: pixels, params },
      [pixels.buffer],
    );
  } else {
    runOnMainThread(jobId, params);
  }
}

async function runOnMainThread(jobId, params) {
  const pixels = state.image.data;
  const image = { width: state.image.width, height: state.image.height, data: pixels };
  try {
    const result = await runDenoise({ ...image, data: Float64Array.from(pixels) }, params, {
      shouldCancel: () => jobId !== state.jobId,
      onProgress: (p) => onWorkerMessage({ data: { type: 'progress', jobId, ...p } }),
      yieldNow: () => new Promise((r) => setTimeout(r, 0)),
    });
    if (jobId !== state.jobId) return;
    if (result.canceled) onWorkerMessage({ data: { type: 'canceled', jobId } });
    else onWorkerMessage({ data: { type: 'done', jobId, ...result } });
  } catch (err) {
    onWorkerMessage({ data: { type: 'error', jobId, message: err.message } });
  }
}

function cancel() {
  if (!state.jobPending) return;
  state.jobId += 1; // 让迟到的旧结果失效
  state.jobPending = false;
  if (worker) worker.postMessage({ type: 'cancel' });
  $('cancelBtn').disabled = true;
  $('runBtn').disabled = false;
  $('progressBar').style.width = '0%';
  setStatus('canceled', '已取消，保留上一次完成的结果');
  updateStaleNote();
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderAll() {
  renderViews();
  renderMetrics();
  renderInspector();
  updateStaleNote();
}

function viewBoxOf(canvas) {
  return canvas.closest('.view-box') || canvas.parentElement;
}

function fitCanvas(canvas) {
  // 按视图可用宽度等比例放大（最近邻），小图也能看清，大图不溢出。
  const box = viewBoxOf(canvas);
  if (!canvas.width || !canvas.height) return;
  const avail = Math.max(80, box.clientWidth - 24);
  const maxDim = Math.max(canvas.width, canvas.height);
  const scale = Math.max(1, Math.floor(avail / maxDim));
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  // 同尺寸的叠加层按显示像素绘制，线条不会被放大成色块
  const overlay = box.querySelector('canvas.overlay');
  if (overlay) {
    overlay.width = w;
    overlay.height = h;
  }
}

function setViewImage(id, values, width, height) {
  const canvas = $(`canvas${id}`);
  const box = viewBoxOf(canvas);
  if (!values) {
    canvas.width = 0;
    canvas.height = 0;
    box.classList.remove('has-image');
    return;
  }
  drawGrayToCanvas(canvas, values, width, height);
  box.classList.add('has-image');
  fitCanvas(canvas);
}

function drawSelectionOverlays() {
  const res = state.result;
  const overlays = ['Original', 'Pilot', 'Final', 'Weight'].map((id) => $(`overlay${id}`));
  for (const overlay of overlays) {
    if (overlay.getContext) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }
  if (!res || res.canceled || !state.selected) return;
  const p = res.params.patch;
  const half = p >> 1;
  const views = ['Original', 'Pilot', 'Final'];
  for (const id of views) {
    const base = $(`canvas${id}`);
    const overlay = $(`overlay${id}`);
    if (!base.width || !overlay.width) continue;
    const scale = overlay.width / base.width;
    const x = (state.selected.x - half) * scale;
    const y = (state.selected.y - half) * scale;
    const size = p * scale;
    drawSelectionOutline(overlay, x, y, size);
  }
}

function setViewMeta(id, text) {
  $(`meta${id}`).textContent = text;
}

function renderViews() {
  const img = state.image;
  const res = state.result;
  setViewImage('Original', img.data, img.width, img.height);
  if (img.data) {
    setViewMeta('Original', `${img.width}×${img.height} · 8 位灰度`);
  }
  const r = res && !res.canceled ? res : null;
  setViewImage('Pilot', r && r.pilot, r && r.width, r && r.height);
  setViewImage('Final', r && r.final, r && r.width, r && r.height);
  if (r) {
    setViewMeta('Pilot', `硬阈值 ${formatNumber(r.params.threshold * r.params.sigma, 1)} · ${formatMs(r.timing.stage1Ms)}`);
    setViewMeta('Final', r.zeroNoise ? 'σ = 0 · 原样返回' : `维纳重建 · ${formatMs(r.timing.stage2Ms)}`);
  } else {
    setViewMeta('Pilot', '—');
    setViewMeta('Final', '—');
  }

  const wCanvas = $('canvasWeight');
  const wBox = viewBoxOf(wCanvas);
  if (r) {
    const stage = state.weightStage;
    const weights = stage === 1 ? r.weight1 : r.weight2;
    const stats = (stage === 1 ? r.groups.stage1 : r.groups.stage2).weightStats;
    if (weights && weights.length) {
      wCanvas.width = r.width;
      wCanvas.height = r.height;
      drawWeightToCanvas(wCanvas, weights, r.width, r.height, stats, { uniform: r.zeroNoise });
      wBox.classList.add('has-image');
      fitCanvas(wCanvas);
      setViewMeta(
        'Weight',
        r.zeroNoise
          ? 'σ = 0 · 未聚合，权重恒为 1'
          : `阶段 ${stage} · 中位 ${formatNumber(stats.median)} · p02–p98 ${formatNumber(stats.p02)}–${formatNumber(stats.p98)}`,
      );
      $('weightRamp').hidden = !!r.zeroNoise;
    }
  } else {
    wBox.classList.remove('has-image');
    setViewMeta('Weight', '—');
    $('weightRamp').hidden = true;
  }
  drawSelectionOverlays();
}

function renderMetrics() {
  const img = state.image;
  const res = state.result;
  $('mImage').textContent = img.data ? `${img.width}×${img.height}` : '—';
  if (!res || res.canceled) {
    for (const id of ['mRefs', 'mGroup', 'mCand', 'mT1', 'mT2', 'mPsnr', 'mZero']) $(id).textContent = '—';
    return;
  }
  const s1 = res.groups.stage1;
  const s2 = res.groups.stage2;
  const p = res.params;
  const refY = referenceCenters(res.height, p.stride).length;
  const refX = referenceCenters(res.width, p.stride).length;
  $('mRefs').textContent = res.zeroNoise ? '—（σ=0）' : `${refY} × ${refX} = ${refY * refX}`;
  $('mGroup').textContent = res.zeroNoise ? '—' : `${formatNumber(s1.meanGroupSize, 2)} / ${formatNumber(s2.meanGroupSize, 2)}`;
  $('mCand').textContent = res.zeroNoise ? '—' : `${formatNumber(s1.meanCandidates, 1)} / ${formatNumber(s2.meanCandidates, 1)}`;
  $('mT1').textContent = formatMs(res.timing.stage1Ms);
  $('mT2').textContent = formatMs(res.timing.stage2Ms);
  $('mZero').textContent = res.zeroNoise ? '0' : `${s1.zeroWeightPixels} / ${s2.zeroWeightPixels}`;
  if (state.reference && state.reference.width === res.width && state.reference.height === res.height) {
    const pIn = psnr(state.reference.data, res.original, res.width, res.height);
    const p1 = psnr(state.reference.data, res.pilot, res.width, res.height);
    const p2 = psnr(state.reference.data, res.final, res.width, res.height);
    $('mPsnr').innerHTML = `输入 ${formatNumber(pIn, 2)} · 初估 ${formatNumber(p1, 2)} · 最终 <b>${formatNumber(p2, 2)}</b> dB`;
  } else {
    $('mPsnr').textContent = '—（未载入参考图）';
  }
}

function updateStaleNote() {
  const note = $('staleNote');
  const currentKey = paramsKey(paramsFromUI());
  const stale = !!(state.result && state.resultParamsKey !== currentKey);
  note.hidden = !(stale || state.stale);
  $('runBtn').disabled = state.jobPending;
}

// ---------------------------------------------------------------------------
// 组检查器
// ---------------------------------------------------------------------------

function addCanvasPick(canvas) {
  canvas.addEventListener('click', (event) => {
    if (!state.image.data) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);
    if (x < 0 || y < 0 || x >= state.image.width || y >= state.image.height) return;
    selectPatch(y, x);
  });
}

function selectPatch(y, x) {
  state.selected = { y, x };
  state.inspectMember = 0;
  renderViews();
  if (!state.result || state.result.canceled) {
    renderInspector();
    return;
  }
  loadInspection(y, x);
}

function loadInspection(y, x) {
  if (!state.result || state.result.canceled) return;
  try {
    state.inspect = inspectGroup(state.result, y, x);
  } catch (err) {
    state.inspect = null;
    toast(`检查失败：${err.message}`, true);
  }
  renderInspector();
}

function renderInspector() {
  const host = $('inspector');
  const body = host.querySelector('.inspector-body');
  const summary = $('inspectSummary');
  const inited = !!(state.result && !state.result.canceled && state.selected);
  body.classList.toggle('empty', !inited);
  const ins = state.inspect;
  const p = state.result?.params?.patch || Number($('patch').value);

  if (!inited) {
    $('inspectHint').textContent = state.result ? '在任一视图上点选参考图块。' : '运行完成后可点选图块。';
    summary.innerHTML = '';
    $('inspectCoord').textContent = '—';
    $('memberTable').querySelector('tbody').innerHTML = '';
    $('matrixTitle').textContent = '—';
    $('matrixInfo').textContent = '';
    $('matrixNote').textContent = '';
    $('numericGrid').innerHTML = '';
    $('matrixLegend').textContent = '—';
    const c = $('groupCanvas');
    c.width = 0;
    c.height = 0;
    if (ins) return;
    $('matrixCanvas').width = 0;
    $('matrixCanvas').height = 0;
    return;
  }

  const stageKey = state.inspectStage === 1 ? 'stage1' : 'stage2';
  const stage = ins ? ins[stageKey] : null;
  const currentStage = stage;
  const refY = state.selected.y;
  const refX = state.selected.x;
  const isRefCenter =
    referenceCenters(state.result.height, state.result.params.stride).includes(refY) &&
    referenceCenters(state.result.width, state.result.params.stride).includes(refX);
  $('inspectHint').textContent = ins?.zeroNoise
    ? 'σ = 0：两阶段都直接返回原图，没有组变换。'
    : `图块中心 (x=${refX}, y=${refY}) · p=${p}` +
      (isRefCenter ? ' · 参与聚合的参考中心' : ' · 非参考中心，仅作预览（不参与聚合）');
  $('inspectCoord').textContent = `(${refX}, ${refY})`;

  let summaryHtml = '';
  if (ins?.zeroNoise) {
    summaryHtml = '<span>σ = 0 · 两阶段均原样返回，无组统计</span>';
  } else if (stage) {
    summaryHtml += `<span>组员 <b>${stage.m}</b></span>`;
    summaryHtml += `<span>候选 <b>${stage.candidateCount}</b></span>`;
    if (state.inspectStage === 1) {
      summaryHtml += `<span>保留 <b>${stage.retainedCount}</b> / ${stage.m * p * p}</span>`;
      summaryHtml += `<span>组权重 <b>${formatNumber(stage.groupWeight, 4)}</b></span>`;
    } else {
      summaryHtml += `<span>Σgain² <b>${formatNumber(stage.sumGainSq, 2)}</b></span>`;
      summaryHtml += `<span>组权重 <b>${formatNumber(stage.groupWeight, 4)}</b></span>`;
    }
  }
  summary.innerHTML = summaryHtml;

  renderGroupCanvas(refY, refX);
  renderMemberTable(ins, stageKey);

  // 模式可用性：gain 只存在于阶段 2
  const gainBtn = $('modeTabs').querySelector('[data-mode="gain"]');
  const modeDisabled = state.inspectStage !== 2;
  gainBtn.disabled = modeDisabled;
  if (modeDisabled && state.inspectMode === 'gain') {
    state.inspectMode = 'group';
    setActiveTab($('modeTabs'), 'mode', 'group');
  }

  const maxMember = currentStage ? Math.max(0, currentStage.m - 1) : 0;
  if (state.inspectMember > maxMember) state.inspectMember = 0;
  renderMatrix(stage, p);
}

function renderGroupCanvas(refY, refX) {
  const canvas = $('groupCanvas');
  const res = state.result;
  if (!res) return;
  // 构造缩略图：把最终图（有则）画到离屏 canvas
  const thumb = document.createElement('canvas');
  const scale = groupScale(res.width, res.height);
  thumb.width = res.width * scale;
  thumb.height = res.height * scale;
  const tctx = thumb.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  const img = tctx.createImageData(thumb.width, thumb.height);
  for (let y = 0; y < thumb.height; y++) {
    for (let x = 0; x < thumb.width; x++) {
      const v = Math.round(res.original[(Math.floor(y / scale)) * res.width + Math.floor(x / scale)]);
      const i = (y * thumb.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  tctx.putImageData(img, 0, 0);
  const stage = state.inspect ? (state.inspectStage === 1 ? state.inspect.stage1 : state.inspect.stage2) : null;
  drawGroupLayout(canvas, {
    thumbnail: thumb,
    members: stage ? stage.members : [],
    refY,
    refX,
  }, res.width, res.height, res.params.patch, {
    scale,
    activeIndex: state.inspectMember,
  });

  $('groupLegend').innerHTML =
    '<span><i style="background:#3987e5"></i>参考</span>' +
    '<span><i style="background:#1baf7a"></i>组员 #0</span>' +
    '<span><i style="background:#eb6834"></i>其余组员</span>';
}

function renderMemberTable(ins, stageKey = 'stage1') {
  const tbody = $('memberTable').querySelector('tbody');
  const note = $('memberNote');
  tbody.innerHTML = '';
  if (!ins) {
    if (note) note.textContent = '';
    return;
  }
  // 表格始终跟随当前阶段：组员索引与下方系数矩阵一一对应。
  const here = stageKey === 'stage1' ? ins.stage1 : ins.stage2;
  const other = stageKey === 'stage1' ? ins.stage2 : ins.stage1;
  const otherMap = new Map(other.members.map((m) => [`${m.y},${m.x}`, m.distance]));
  const headStage = document.querySelector('#memberTable thead tr');
  if (headStage) {
    headStage.innerHTML =
      `<th>#</th><th>y</th><th>x</th><th>d<sub>${stageKey === 'stage1' ? '1' : '2'}</sub></th>` +
      `<th>d<sub>${stageKey === 'stage1' ? '2' : '1'}</sub></th>`;
  }
  for (let i = 0; i < here.members.length; i++) {
    const a = here.members[i];
    const tr = document.createElement('tr');
    if (i === state.inspectMember) tr.className = 'active';
    const otherD = otherMap.get(`${a.y},${a.x}`);
    tr.innerHTML = `<td>${i}</td><td>${a.y}</td><td>${a.x}</td><td>${formatNumber(a.distance, 2)}</td><td>${otherD === undefined ? '—' : formatNumber(otherD, 2)}</td>`;
    tr.addEventListener('click', () => {
      state.inspectMember = i;
      renderInspector();
    });
    tbody.appendChild(tr);
  }
  if (note) {
    const differs = here.members.length !== other.members.length ||
      here.members.some((m, i) => !other.members[i] || other.members[i].y !== m.y || other.members[i].x !== m.x);
    note.textContent = differs
      ? `当前表格为${stageKey === 'stage1' ? '初估' : '维纳'}阶段的组；另一阶段匹配结果不同，表中 “—” 表示该位置未进入另一阶段的组。`
      : '';
  }
}

function matrixFor(stage, mode) {
  if (!stage || !stage.matrices.length) return null;
  const idx = Math.min(state.inspectMember, stage.matrices.length - 1);
  const mat = stage.matrices[idx];
  if (mode === 'dct') return { m: mat.dct, keep: null, kind: 'signed', label: '空间 DCT 系数' };
  if (mode === 'group') return { m: mat.groupCoef, keep: mat.keep, kind: 'signed', label: '组域系数（Walsh-Hadamard 后）' };
  if (mode === 'gain') {
    if (!mat.gain) return null;
    return { m: mat.gain, keep: null, kind: 'gain', label: '维纳增益 gain' };
  }
  if (mode === 'output') return { m: mat.outputCoef, keep: null, kind: 'signed', label: '输出系数' };
  return null;
}

function renderMatrix(stage, p) {
  const canvas = $('matrixCanvas');
  const grid = $('numericGrid');
  const spec = state.inspect ? matrixFor(stage, state.inspectMode) : null;
  if (!spec) {
    canvas.width = 0;
    canvas.height = 0;
    grid.innerHTML = '';
    $('matrixTitle').textContent = '—';
    $('matrixInfo').textContent = '';
    $('matrixLegend').textContent = '—';
    $('matrixNote').textContent = '';
    return;
  }
  const idx = Math.min(state.inspectMember, (stage?.matrices.length || 1) - 1);
  const heat = drawMatrixHeatmap(canvas, spec.m, p, {
    mode: spec.kind,
    keep: state.inspectMode === 'group' ? spec.keep : null,
  });
  canvas.style.width = '';
  $('matrixTitle').textContent = `组员 #${idx} · ${spec.label}`;

  const absVals = spec.m.map((v) => Math.abs(v));
  const maxAbs = Math.max(...absVals);
  $('matrixInfo').textContent = `|max| = ${formatNumber(maxAbs, 2)}`;

  // 数值网格：p×p
  grid.style.gridTemplateColumns = `repeat(${p}, minmax(0, 1fr))`;
  grid.innerHTML = '';
  const digits = spec.kind === 'gain' ? 3 : 1;
  for (let k = 0; k < p * p; k++) {
    const span = document.createElement('span');
    const v = spec.m[k];
    span.textContent = formatNumber(v, digits);
    if (state.inspectMode === 'group' && spec.keep && !spec.keep[k]) span.classList.add('zero');
    if (k === 0) span.classList.add('dc');
    grid.appendChild(span);
  }

  if (spec.kind === 'gain') {
    $('matrixLegend').textContent = `增益 0 → ${formatNumber(heat.maxAbs, 3)}（单色阶，浅 = 抑制，深 = 保留；已按本组最大增益归一化）`;
    $('matrixNote').textContent =
      'gain = pilot² / (pilot² + σ²)，逐组域系数计算；单色阶按本组最大增益归一化，小增益组内部差异仍然可见。' +
      (state.inspectMember === 0 ? ' 组索引 0（参考图块）的 DC 增益通常接近 1。' : '');
  } else if (state.inspectMode === 'group') {
    $('matrixLegend').textContent = '有符号系数（蓝正 / 红负）· 斜线划掉 = 被硬阈值置 0';
    $('matrixNote').textContent =
      state.inspectStage === 1
        ? `组索引 0 的 (0,0) 全局 DC 无条件保留；其余 |系数| < ${formatNumber(state.result.params.threshold * state.result.params.sigma, 2)} 置 0。斜线格为剔除。`
        : '维纳阶段的组域系数全部参与 gain 加权，不做硬阈值。';
  } else {
    $('matrixLegend').textContent = '有符号系数（蓝正 / 红负，按 |max| 归一化）';
    $('matrixNote').textContent = '行 l、列 k 为二维空间频率；左上角 (0,0) 为 DC。';
  }
}

function setActiveTab(container, attr, value) {
  for (const btn of container.querySelectorAll('button')) {
    const on = btn.dataset[attr] === value;
    btn.classList.toggle('active', on);
    if (btn.getAttribute('role') === 'tab') btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

async function doExport(kind) {
  const res = state.result;
  if (!res || res.canceled) {
    toast('还没有可导出的结果。', true);
    return;
  }
  const base = `group-denoise-${timestampSlug()}`;
  const refCentersY = referenceCenters(res.height, res.params.stride);
  const refCentersX = referenceCenters(res.width, res.params.stride);
  const extra = {
    sourceName: state.imageSource,
    referenceCentersY: refCentersY,
    referenceCentersX: refCentersX,
    referenceGroupCount: refCentersY.length * refCentersX.length,
    metrics: state.reference && state.reference.width === res.width && state.reference.height === res.height
      ? {
          reference: state.referenceSource,
          psnrInput: psnr(state.reference.data, res.original, res.width, res.height),
          psnrPilot: psnr(state.reference.data, res.pilot, res.width, res.height),
          psnrFinal: psnr(state.reference.data, res.final, res.width, res.height),
        }
      : null,
  };
  try {
    if (kind === 'pilot') {
      downloadBytes(`${base}-pilot.png`, await buildPilotPNG(res), 'image/png');
      toast('已导出初估 PNG');
    } else if (kind === 'final') {
      downloadBytes(`${base}-final.png`, await buildFinalPNG(res), 'image/png');
      toast('已导出最终 PNG');
    } else if (kind === 'float') {
      downloadBytes(`${base}-float.npy`, buildFloatNpy(res));
      toast('已导出浮点结果 .npy');
    } else if (kind === 'report') {
      downloadText(`${base}-report.json`, JSON.stringify(buildReport(res, extra), null, 2));
      toast('已导出参数报告');
    } else if (kind === 'zip') {
      const [pilotPng, finalPng] = await Promise.all([buildPilotPNG(res), buildFinalPNG(res)]);
      const report = new TextEncoder().encode(JSON.stringify(buildReport(res, extra), null, 2));
      const readme = new TextEncoder().encode(
        [
          '相似图块协同去噪结果包',
          '',
          `图像：${res.width}×${res.height} 8 位灰度`,
          `参数：p=${res.params.patch} r=${res.params.radius} s=${res.params.stride} K=${res.params.capacity} σ=${res.params.sigma} 阈值倍数=${res.params.threshold}`,
          '',
          'pilot.png         初估阶段（硬阈值）截到 0–255 并四舍五入',
          'final.png         最终阶段（维纳）截到 0–255 并四舍五入',
          'float-result.npy  numpy 数组 shape=(4,H,W) dtype=<f8>：pilot、final、weight1、weight2',
          'report.json       参数、组统计、权重分布、耗时与评估指标',
          '',
          `耗时：${formatMs(res.timing.totalMs)}（初估 ${formatMs(res.timing.stage1Ms)}，维纳 ${formatMs(res.timing.stage2Ms)}）`,
        ].join('\n'),
      );
      const zip = buildZip([
        { name: 'pilot.png', data: pilotPng },
        { name: 'final.png', data: finalPng },
        { name: 'float-result.npy', data: buildFloatNpy(res) },
        { name: 'report.json', data: report },
        { name: 'README.txt', data: readme },
      ]);
      downloadBytes(`${base}.zip`, zip, 'application/zip');
      toast('已导出结果包 .zip');
    }
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// 自检（样例 primitives.json）
// ---------------------------------------------------------------------------

async function runSelfTest() {
  const out = $('selfTestOut');
  out.hidden = false;
  out.textContent = '运行中…';
  try {
    const lines = [];
    let ok = true;
    const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

    const dctIn = [1, 2, 3, 4];
    const dctWant = [5, -1, -2, 0];
    const dctGot = Array.from(dct2(Float64Array.from(dctIn), 2));
    const dctOk = dctGot.every((v, i) => near(v, dctWant[i], 1e-9));
    ok &&= dctOk;
    lines.push(`DCT-II 2×2: ${dctOk ? 'PASS' : 'FAIL'}  got [${dctGot.map((v) => v.toFixed(6)).join(', ')}]`);

    const rt = Array.from(idct2(dct2(Float64Array.from(dctIn), 2), 2));
    const rtOk = rt.every((v, i) => near(v, dctIn[i], 1e-9));
    ok &&= rtOk;
    lines.push(`DCT 逆变换往返: ${rtOk ? 'PASS' : 'FAIL'}`);

    const w = Array.from(groupTransform(Float64Array.from([1, 3]), 2, 1));
    const wOk = near(w[0], 2.82842712474619, 1e-12) && near(w[1], -1.414213562373095, 1e-12);
    ok &&= wOk;
    lines.push(`Hadamard [1,3] → [${w.map((v) => v.toFixed(12)).join(', ')}]: ${wOk ? 'PASS' : 'FAIL'}`);

    const mirrorGot = [-1, 0, 1, 2, 3, 4].map((v) => mirrorIndex(v, 4));
    const mirrorOk = mirrorGot.join(',') === '1,0,1,2,3,2';
    ok &&= mirrorOk;
    lines.push(`镜像（不重复端点）: ${mirrorOk ? 'PASS' : 'FAIL'}  ${mirrorGot.join(',')}`);

    const centersOk = referenceCenters(9, 2).join(',') === '0,2,4,6,8' && referenceCenters(10, 4).join(',') === '0,4,8,9';
    ok &&= centersOk;
    lines.push(`参考中心布局: ${centersOk ? 'PASS' : 'FAIL'}`);

    if (state.result && !state.result.canceled && state.result.zeroNoise) {
      lines.push('σ=0 原样返回: 当前结果即 σ=0，两阶段等于输入。');
    }

    lines.push('', ok ? '全部通过。' : '存在失败项。');
    out.textContent = lines.join('\n');
    toast(ok ? '规则自检通过' : '规则自检有失败项', !ok);
  } catch (err) {
    out.textContent = `自检失败：${err.message}`;
    toast(`自检失败：${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bind() {
  $('sampleSelect').addEventListener('change', (e) => loadSample(e.target.value));
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = await readFileBytes(file);
    await loadImageBytes(bytes, file.name);
    state.reference = null;
    state.referenceSource = null;
    renderAll();
    run();
    e.target.value = '';
  });
  $('referenceBtn').addEventListener('click', () => $('referenceFile').click());
  $('referenceFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadImageBytes(await readFileBytes(file), file.name, { reference: true });
    renderAll();
    e.target.value = '';
  });

  const paramIds = ['patch', 'capacity', 'stride', 'radius', 'sigma', 'threshold'];
  for (const id of paramIds) {
    $(id).addEventListener('input', () => {
      $('radiusVal').textContent = $('radius').value;
      $('sigmaVal').textContent = formatNumber(Number($('sigma').value), 1);
      $('thresholdVal').textContent = formatNumber(Number($('threshold').value), 1);
      updateStaleNote();
    });
    $(id).addEventListener('change', () => {
      if (id === 'patch') fillStrideOptions(Number($('patch').value));
      updateStaleNote();
      run();
    });
  }

  $('runBtn').addEventListener('click', () => run());
  $('cancelBtn').addEventListener('click', cancel);
  $('weightStage').addEventListener('change', (e) => {
    state.weightStage = Number(e.target.value);
    renderViews();
  });
  $('selfTest').addEventListener('click', runSelfTest);

  for (const id of ['Original', 'Pilot', 'Final', 'Weight']) {
    addCanvasPick($(`canvas${id}`));
  }

  $('stageTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-stage]');
    if (!btn) return;
    state.inspectStage = Number(btn.dataset.stage);
    setActiveTab($('stageTabs'), 'stage', btn.dataset.stage);
    renderInspector();
  });
  $('modeTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.disabled) return;
    state.inspectMode = btn.dataset.mode;
    setActiveTab($('modeTabs'), 'mode', btn.dataset.mode);
    renderInspector();
  });

  $('exportBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('exportMenu');
    menu.hidden = !menu.hidden;
  });
  $('exportMenu').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-export]');
    if (!btn) return;
    $('exportMenu').hidden = true;
    doExport(btn.dataset.export);
  });
  document.addEventListener('click', () => {
    $('exportMenu').hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('exportMenu').hidden = true;
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const id of ['Original', 'Pilot', 'Final', 'Weight']) fitCanvas($(`canvas${id}`));
      if (state.selected) renderGroupCanvas(state.selected.y, state.selected.x);
    }, 120);
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function applyLimits() {
  const radius = $('radius');
  radius.min = String(LIMITS.radiusRange[0]);
  radius.max = String(LIMITS.radiusRange[1]);
  const sigma = $('sigma');
  sigma.min = String(LIMITS.sigmaRange[0]);
  sigma.max = String(LIMITS.sigmaRange[1]);
  const threshold = $('threshold');
  threshold.min = String(LIMITS.thresholdRange[0]);
  threshold.max = String(LIMITS.thresholdRange[1]);
}

async function boot() {
  applyLimits();
  bind();
  fillStrideOptions(4);
  applyParamsToUI(DEFAULT_PARAMS);
  await loadSample('noisy');
  const initial = new URLSearchParams(location.search);
  if (initial.get('sample') && SAMPLES[initial.get('sample')]) {
    await loadSample(initial.get('sample'));
  }
}

boot().catch((err) => {
  setStatus('error', `启动失败：${err.message}`);
  toast(`启动失败：${err.message}`, true);
});

// 暴露少量测试钩子（只读 / 受控操作）
window.__GTD = {
  getState: () => ({
    image: state.image && { width: state.image.width, height: state.image.height },
    resultParams: state.result?.params || null,
    resultParamsKey: state.resultParamsKey,
    jobId: state.jobId,
    jobPending: state.jobPending,
    stale: state.stale,
    selected: state.selected,
    inspectStage: state.inspectStage,
    inspectMode: state.inspectMode,
    inspectMember: state.inspectMember,
    weightStage: state.weightStage,
    timing: state.result?.timing || null,
    groups: state.result?.groups || null,
    zeroNoise: state.result?.zeroNoise ?? null,
    finalSample: state.result?.final ? Array.from(state.result.final.slice(0, 16)) : null,
    pilotSample: state.result?.pilot ? Array.from(state.result.pilot.slice(0, 16)) : null,
    weight2Sample: state.result?.weight2 ? Array.from(state.result.weight2.slice(0, 16)) : null,
    weightStats2: state.result?.groups?.stage2?.weightStats || null,
    inspect: state.inspect
      ? {
          refY: state.inspect.refY,
          refX: state.inspect.refX,
          m1: state.inspect.stage1.m,
          m2: state.inspect.stage2.m,
          retained: state.inspect.stage1.retainedCount,
          w1: state.inspect.stage1.groupWeight,
          w2: state.inspect.stage2.groupWeight,
          members: state.inspect.stage1.members,
          memberGain0: state.inspect.stage2.matrices[state.inspectMember]?.gain || null,
          matrixDct: state.inspect.stage1.matrices[state.inspectMember]?.dct || null,
        }
      : null,
  }),
  selectPatch: (y, x) => selectPatch(y, x),
  setStage: (s) => {
    state.inspectStage = s;
    setActiveTab($('stageTabs'), 'stage', String(s));
    renderInspector();
  },
  setMode: (m) => {
    state.inspectMode = m;
    setActiveTab($('modeTabs'), 'mode', m);
    renderInspector();
  },
  setMember: (i) => {
    state.inspectMember = i;
    renderInspector();
  },
  loadSample,
  importBase64: async (b64, name) => {
    await loadImageBytes(bytesFromBase64(b64), name || 'imported.png');
    state.reference = null;
    state.referenceSource = null;
    renderAll();
    run();
  },
  run: () => run(),
  cancel: () => cancel(),
  exportKind: (kind) => doExport(kind),
  runSelfTest,
};
