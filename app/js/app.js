// app.js — UI wiring for the voxel ray workbench.
//
// Responsibilities here: file import (JSON + RAW), the sample picker, the
// camera interaction, the render queue/replacement policy, the click probe
// and PNG/settings export.  All ray arithmetic lives in core.js; Big data
// never touches the DOM thread during rendering because a worker does it.

import {
  validateMeta, buildVolume, renderImage, renderRows, computeCamera, presetView,
  orbitView, rayAt, matchPreset, traceRay, normalizeTransferFunction,
  evalTransfer, linearToSrgb, linearToSrgbHex, srgbHexToLinear,
  clamp,
  DEFAULT_TF, DEFAULT_WINDOW, DEFAULT_REF_MM, STEP_MIN, STEP_MAX,
  IMAGE_MIN, IMAGE_MAX, VIEW_LABELS,
} from './core.js';
import { encodePng } from './png.js';
import { makeSettings, parseSettings, describeSettings } from './settings.js';

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
const state = {
  volume: null,
  sourceName: '',
  view: presetView('+z'),
  mode: 'composite',
  step: 1,
  tf: DEFAULT_TF.map((s) => ({ value: s.value, rgb: s.rgb.slice(), alpha: s.alpha })),
  refMm: DEFAULT_REF_MM,
  window: DEFAULT_WINDOW.slice(),
  imageSize: 512,
  probe: null,
  rendering: false,
  lastJobId: 0,
  lastRenderMs: 0,
  samples: [],
};

// Render job management.  Every parameter change bumps `state.jobSeq`; when a
// result comes back it is shown only if its id equals the newest issued id.
let jobSeq = 0;
let shownSeq = 0;
let worker = null;
let workerReady = false;
let renderScheduled = false;

// --------------------------------------------------------------------------
// Toast / status
// --------------------------------------------------------------------------
let toastTimer = null;
function toast(text, bad = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), bad ? 5200 : 2600);
}

function setStatus(parts) {
  const msg = $('statusMsg');
  msg.textContent = parts.message;
  msg.className = 'msg ' + (parts.tone || '');
  $('statusData').textContent = parts.data || '';
  $('statusRender').textContent = parts.render || '';
  $('statusError').textContent = parts.error || '';
}

function setStatusError(text) {
  $('statusError').textContent = text;
  if (text) setTimeout(() => {
    if ($('statusError').textContent === text) $('statusError').textContent = '';
  }, 9000);
}

// --------------------------------------------------------------------------
// Import
// --------------------------------------------------------------------------
async function readFileAsBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/** Try to pair a JSON with a RAW byte buffer and validate it. */
function prepareCase(metaJson, rawBytes, names) {
  const check = validateMeta(metaJson, rawBytes ? rawBytes.byteLength : null);
  if (!check.ok) {
    return { ok: false, errors: check.errors, warnings: check.warnings, meta: null, volume: null };
  }
  if (!rawBytes) {
    return { ok: false, errors: [`还缺少 RAW 文件「${check.meta.raw || '(未在 JSON 中声明)'}」`], warnings: check.warnings, meta: check.meta, volume: null, awaitingRaw: true };
  }
  try {
    const volume = buildVolume(rawBytes, check.meta, names.friendly, names.raw);
    return { ok: true, errors: [], warnings: check.warnings, meta: check.meta, volume };
  } catch (err) {
    return { ok: false, errors: [String((err && err.message) || err)], warnings: check.warnings, meta: check.meta, volume: null };
  }
}

function adoptVolume(volume, displayName) {
  state.volume = volume;
  state.sourceName = displayName;
  state.probe = null;
  closeProbe();
  // Default window spans zero (or the data minimum) up to the data maximum,
  // so MIP starts with usable contrast for any value range.
  const lo = volume.valueMin;
  const hi = volume.valueMax;
  state.window = [Math.min(0, lo), Math.max(hi, lo + 1)];
  // Default transfer function follows the data range.  When the data is
  // constant (lo === hi) the stops are placed around that single value so the
  // volume is still visible instead of fully transparent.
  if (hi > lo) {
    const mid = lo + (hi - lo) * 0.5;
    state.tf = [
      { value: lo, rgb: [0, 0, 0], alpha: 0 },
      { value: mid, rgb: [1, 0.45, 0.1], alpha: 0.08 },
      { value: hi, rgb: [1, 1, 1], alpha: 0.35 },
    ];
  } else {
    state.tf = [
      { value: lo - 1, rgb: [0, 0, 0], alpha: 0 },
      { value: lo, rgb: [1, 0.45, 0.1], alpha: 0.1 },
      { value: lo + 1, rgb: [1, 1, 1], alpha: 0.4 },
    ];
  }
  $('viewSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view.preset));
  renderDataCard();
  renderTfEditor();
  syncControlsFromState();
  if (worker) postWorkerInit(); // replace the worker's volume; stale jobs are dropped
  else bootWorker();
  updateAvailable();
  requestRender();
  updateStatus();
}

function showImportError(title, errors, warnings) {
  const lines = [title, ...errors];
  toast(lines.join('\n'), true);
  const whenDataKept = Boolean(state.volume) && /保留当前可用数据/.test(title);
  if (whenDataKept) {
    // Keep the loaded data set's name and summary; only add the error text.
    setStatusError(`${title}：${errors[0] || ''}`);
  } else {
    setStatus({
      message: `${title}：${errors[0] || ''}`,
      tone: 'bad',
      data: warnings && warnings.length ? warnings[0] : '',
    });
  }
  renderDataCard(errors, warnings);
}

async function handleImport(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const jsons = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
  const raws = files.filter((f) => f.name.toLowerCase().endsWith('.raw'));
  if (jsons.length === 0) {
    showImportError('导入失败', ['请同时选择描述该 RAW 的 JSON 文件', '（JSON 说明尺寸、间距、位深与字节序）']);
    return;
  }
  // Only the first JSON is used; match its RAW by name when there are several.
  const metaFile = jsons[0];
  let metaJson;
  try {
    metaJson = JSON.parse((await metaFile.text()).replace(/^\uFEFF/, ''));
  } catch (err) {
    showImportError('JSON 解析失败', [`${metaFile.name}: ${(err && err.message) || err}`]);
    return;
  }
  const check = validateMeta(metaJson, null);
  let rawBytes = null;
  let rawName = '';
  if (check.ok) {
    const want = check.meta.raw;
    let chosen = want ? raws.find((f) => f.name === want) : null;
    if (!chosen && raws.length === 1) chosen = raws[0];
    if (chosen) {
      rawBytes = await readFileAsBytes(chosen);
      rawName = chosen.name;
    }
  } else if (raws.length === 1) {
    rawBytes = await readFileAsBytes(raws[0]);
    rawName = raws[0].name;
  }

  const prepared = prepareCase(metaJson, rawBytes, { friendly: metaFile.name, raw: rawName });
  if (!prepared.ok) {
    if (state.volume) {
      // A rejected file never replaces what is already on screen.
      showImportError('导入未生效（保留当前可用数据）', prepared.errors, prepared.warnings);
    } else {
      showImportError('导入失败', prepared.errors, prepared.warnings);
    }
    return;
  }
  if (prepared.warnings.length) toast(prepared.warnings.join('\n'));
  adoptVolume(prepared.volume, metaFile.name);
  toast(`已载入 ${metaFile.name}${rawName ? ' + ' + rawName : ''}`);
}

// --------------------------------------------------------------------------
// Sample picker
// --------------------------------------------------------------------------
async function loadSampleList() {
  try {
    const res = await fetch('/api/cases', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.samples = json.samples || [];
    renderSampleList();
  } catch {
    // Standalone file:// use has no server; the direct import path still works.
    $('sampleList').innerHTML = '<div class="small">未连接本地服务，可直接导入文件。</div>';
  }
}

function renderSampleList() {
  const host = $('sampleList');
  $('btnSample').disabled = state.samples.length === 0;
  if (state.samples.length === 0) {
    host.innerHTML = '<div class="small">没有可用样例。</div>';
    return;
  }
  host.innerHTML = state.samples.map((s, i) => {
    const dims = Array.isArray(s.meta.dimensions) ? s.meta.dimensions.join('×') : '?';
    const sp = Array.isArray(s.meta.spacing) ? s.meta.spacing.join(' / ') : '?';
    const bad = s.invalid
      ? `<br><span class="small" style="color:var(--danger)">${escapeHtml(s.invalid)}</span>`
      : '';
    return `<button class="sampleBtn" data-idx="${i}" style="display:block;width:100%;text-align:left;margin-bottom:4px;padding:4px 8px;">
      <span class="mono">${escapeHtml(s.name)}</span><br>
      <span class="small">${dims} · 间距 ${sp} mm · ${escapeHtml(String(s.meta.voxelType || '?'))}</span>${bad}
    </button>`;
  }).join('');
  host.querySelectorAll('.sampleBtn').forEach((btn) => {
    btn.addEventListener('click', () => loadSample(Number(btn.dataset.idx)));
  });
}

async function loadSample(idx) {
  const sample = state.samples[idx];
  if (!sample) return;
  try {
    const metaRes = await fetch(sample.url, { cache: 'no-store' });
    if (!metaRes.ok) throw new Error(`JSON 获取失败 HTTP ${metaRes.status}`);
    const meta = JSON.parse((await metaRes.text()).replace(/^\uFEFF/, ''));
    let rawBytes = null;
    let rawName = '';
    if (sample.rawUrl) {
      const rawRes = await fetch(sample.rawUrl, { cache: 'no-store' });
      if (!rawRes.ok && rawRes.status !== 404) throw new Error(`RAW 获取失败 HTTP ${rawRes.status}`);
      if (rawRes.ok) {
        rawBytes = new Uint8Array(await rawRes.arrayBuffer());
        rawName = sample.rawName || '';
      }
    }
    const prepared = prepareCase(meta, rawBytes, { friendly: sample.name, raw: rawName });
    if (!prepared.ok) {
      const isBadLength = prepared.errors.some((e) => /长度不符/.test(e));
      // Invalid-length sample intentionally demonstrates the error while
      // keeping the previously loaded (usable) volume on screen.
      if (isBadLength && state.volume) {
        showImportError('样例数据未替换（保留当前可用数据）', prepared.errors, prepared.warnings);
        return;
      }
      showImportError('样例载入失败', prepared.errors, prepared.warnings);
      return;
    }
    if (prepared.warnings.length) toast(prepared.warnings.join('\n'));
    adoptVolume(prepared.volume, sample.name);
    toast(`已载入样例 ${sample.name}`);
  } catch (err) {
    showImportError('样例载入失败', [String((err && err.message) || err)]);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------------------
// Data card
// --------------------------------------------------------------------------
function renderDataCard(errors, warnings) {
  const card = $('dataCard');
  const v = state.volume;
  if (!v) {
    if (errors) {
      card.innerHTML = `<div class="name" style="color:var(--danger)">${escapeHtml(errors[0] || '错误')}</div>` +
        (warnings && warnings.length ? `<div class="meta">${escapeHtml(warnings[0])}</div>` : '');
    } else {
      card.innerHTML = '<div class="small">尚未加载数据。</div>';
    }
    return;
  }
  // Data is loaded: keep its summary and append any import error under it, so
  // a rejected file never hides the data that is still on screen.
  const errorHtml = errors && errors.length
    ? `<div class="meta" style="color:var(--danger); margin-top:4px">${escapeHtml(errors[0])}</div>`
    : '';
  card.innerHTML = `<div class="name">${escapeHtml(state.sourceName)}</div>
    <div class="meta">尺寸 ${v.dims.join(' × ')} · 间距 ${v.spacing.map((s) => s.toFixed(2)).join(' / ')} mm</div>
    <div class="meta">物理包围盒 ${v.ext.map((e) => e.toFixed(1)).join(' × ')} mm</div>
    <div class="meta">${v.dataType} · 值域 ${v.valueMin} – ${v.valueMax} · ${v.voxelCount} 体素</div>${errorHtml}`;
}

// --------------------------------------------------------------------------
// Worker boot + render scheduling
// --------------------------------------------------------------------------
function bootWorker() {
  if (worker || !state.volume) return;
  try {
    worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (ev) => {
      worker = null;
      toast(`渲染线程出错，改用主线程：${ev.message || ''}`, true);
      workerFailed();
    };
  } catch (err) {
    worker = null;
    toast('浏览器不支持 Worker，改用主线程渲染', true);
    workerFailed();
    return;
  }
  postWorkerInit();
}

function workerFailed() {
  worker = null;
  requestRender();
}

function postWorkerInit() {
  if (!worker || !state.volume) return;
  const v = state.volume;
  const copy = new Uint16Array(v.values.length);
  copy.set(v.values);
  worker.postMessage({
    type: 'init',
    dims: v.dims, spacing: v.spacing, ext: v.ext, invSpacing: v.invSpacing,
    values: copy, valueMin: v.valueMin, valueMax: v.valueMax,
    dataType: v.dataType, meta: v.meta,
  }, [copy.buffer]);
  workerReady = true;
}

function requestRender() {
  if (!state.volume) return;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    issueRender();
  });
}

function issueRender() {
  if (!state.volume) return;
  const jobId = ++jobSeq;
  state.rendering = true;
  updateStatus();

  const payload = {
    type: 'render',
    jobId,
    view: { dir: state.view.dir, up: state.view.up, zoom: state.view.zoom, pan: state.view.pan },
    width: state.imageSize,
    height: state.imageSize,
    mode: state.mode,
    step: state.step,
    tf: state.tf,
    refMm: state.refMm,
    window: state.window,
  };

  if (worker && workerReady) {
    worker.postMessage(payload);
    return;
  }
  // Fallback: render on the main thread in small bands so the page still
  // responds (coarser but functional when workers are unavailable).
  renderMainThread(payload);
}

function renderMainThread(payload) {
  const camera = computeCamera(state.volume, payload.view, payload.width, payload.height);
  const target = new Uint8ClampedArray(payload.width * payload.height * 4);
  const band = Math.max(4, Math.floor(payload.height / 16));
  const stops = normalizeTransferFunction(payload.tf).tf;
  let row = 0;
  const started = performance.now();
  const tick = () => {
    if (payload.jobId !== jobSeq) return; // superseded
    const stop = Math.min(payload.height, row + band);
    renderRows(state.volume, camera, payload.width, payload.height, row, stop, {
      mode: payload.mode, step: payload.step, tf: stops, refMm: payload.refMm, window: payload.window,
    }, target);
    row = stop;
    setProgress(row / payload.height);
    if (row < payload.height) setTimeout(tick, 0);
    else doneFrame(target.buffer, payload.width, payload.height, payload.jobId, performance.now() - started);
  };
  tick();
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (!msg) return;
  switch (msg.type) {
    case 'progress':
      if (msg.jobId === jobSeq) setProgress(msg.fraction);
      break;
    case 'done':
      doneFrame(msg.buffer, msg.width, msg.height, msg.jobId, msg.elapsedMs);
      break;
    case 'error':
      state.rendering = false;
      updateStatus();
      toast(`渲染失败：${msg.message}`, true);
      break;
    case 'probe-result':
      handleProbeResult(msg);
      break;
    default:
      break;
  }
}

function handleProbeResult(msg) {
  if (!pendingProbe || msg.requestId !== pendingProbe.id) return;
  const hit = pendingProbe.hit;
  pendingProbe = null;
  if (!msg.trace) {
    toast(`点选失败：${msg.error || '未知错误'}`, true);
    return;
  }
  showProbe(msg.trace, hit);
}

function setProgress(f) {
  const bar = $('progressBar');
  bar.classList.add('on');
  bar.style.width = `${clamp(f, 0, 1) * 100}%`;
}

function doneFrame(buffer, width, height, jobId, elapsedMs) {
  if (jobId !== jobSeq) return; // a newer request is already in flight
  shownSeq = jobId;
  const img = new Uint8ClampedArray(buffer);
  paintFrame(img, width, height);
  state.rendering = false;
  state.lastRenderMs = elapsedMs || 0;
  setProgress(0);
  $('progressBar').classList.remove('on');
  // The probe panel is refreshed by whichever control changed (its handler
  // calls reprobe); refreshing again here would just queue duplicate probes.
  updateStatus();
}

// --------------------------------------------------------------------------
// Canvas painting
// --------------------------------------------------------------------------
const canvas = $('viewCanvas');
const ctx = canvas.getContext('2d');
let frameImageData = null;
let currentFrame = null; // {img, width, height}
let frameCanvas = null;  // offscreen canvas reused for putImageData

function paintFrame(img, width, height) {
  currentFrame = { img, width, height };
  fitCanvasNoRepaint();
  const side = canvas._drawSide || Math.min(canvas.width, canvas.height);
  const ox = canvas._offsetX || 0;
  const oy = canvas._offsetY || 0;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // checkerboard behind the transparent parts, so alpha is legible
  drawChecker(ox, oy, side);
  if (!frameCanvas) frameCanvas = document.createElement('canvas');
  if (frameCanvas.width !== width || frameCanvas.height !== height ||
      !frameImageData || frameImageData.width !== width || frameImageData.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameImageData = frameCanvas.getContext('2d').createImageData(width, height);
  }
  frameImageData.data.set(img);
  const fctx = frameCanvas.getContext('2d');
  fctx.putImageData(frameImageData, 0, 0);
  // nearest-neighbour scaling keeps single-pixel transients visible
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frameCanvas, ox, oy, side, side);
  drawAxisHint();
  $('emptyTip').style.display = 'none';
}

function fitCanvasNoRepaint() {
  const host = $('canvasHost');
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(host.clientWidth * scale));
  const h = Math.max(1, Math.floor(host.clientHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const side = Math.min(w, h);
  canvas._drawSide = side;
  canvas._offsetX = Math.floor((w - side) / 2);
  canvas._offsetY = Math.floor((h - side) / 2);
}

let checkerPattern = null;
function drawChecker(x, y, side) {
  if (!checkerPattern) {
    const c = document.createElement('canvas');
    c.width = 24; c.height = 24;
    const g = c.getContext('2d');
    g.fillStyle = '#171a20'; g.fillRect(0, 0, 24, 24);
    g.fillStyle = '#1f232b'; g.fillRect(0, 0, 12, 12); g.fillRect(12, 12, 12, 12);
    checkerPattern = ctx.createPattern(c, 'repeat');
  }
  ctx.fillStyle = checkerPattern;
  ctx.fillRect(x, y, side, side);
}

function drawAxisHint() {
  const v = state.view;
  const preset = matchPreset(v);
  const dirTxt = v.dir.map((d) => d.toFixed(2)).join(', ');
  $('axisHint').textContent = `${preset ? VIEW_LABELS[preset] + ' · ' : '斜视 · '}射线方向 (${dirTxt})`;
}

// --------------------------------------------------------------------------
// Mouse interaction
// --------------------------------------------------------------------------
let drag = null;

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.volume) return;
  canvas.setPointerCapture(ev.pointerId);
  const panMode = ev.button === 2 || ev.shiftKey;
  drag = {
    mode: panMode ? 'pan' : 'orbit',
    x: ev.clientX, y: ev.clientY,
    startX: ev.clientX, startY: ev.clientY,
    moved: false,
    panStart: state.view.pan.slice(),
  };
});
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('pointermove', (ev) => {
  if (!drag || !state.volume) return;
  const dx = ev.clientX - drag.x;
  const dy = ev.clientY - drag.y;
  if (Math.abs(ev.clientX - drag.startX) + Math.abs(ev.clientY - drag.startY) > 3) drag.moved = true;
  if (!drag.moved) return;
  if (drag.mode === 'orbit') {
    state.view = orbitView(state.view, -dx * 0.35, -dy * 0.35);
    updatePresetButtons();
    requestRender();
  } else {
    // pan in mm: screen pixels → mm through the fitted draw size
    const cam = computeCamera(state.volume, state.view, 1, 1);
    const side = canvas._drawSide || 512;
    const pxPerMm = side / (2 * cam.halfW);
    state.view = {
      ...state.view,
      pan: [drag.panStart[0] - dx / pxPerMm, drag.panStart[1] + dy / pxPerMm],
      preset: null,
    };
    updatePresetButtons();
    requestRender();
  }
  // Dragging changes where the selected pixel's ray points; refresh the
  // probe once the gesture settles rather than on every move event.
  scheduleProbeRefresh();
  drag.x = ev.clientX;
  drag.y = ev.clientY;
});

let probeRefreshTimer = null;
function scheduleProbeRefresh() {
  if (!state.probe) return;
  clearTimeout(probeRefreshTimer);
  probeRefreshTimer = setTimeout(() => {
    if (state.probe && !drag) reprobe();
  }, 140);
}

canvas.addEventListener('pointerup', (ev) => {
  const wasDrag = drag;
  drag = null;
  if (!wasDrag) return;
  if (wasDrag.moved) return;
  if (!state.volume) return;
  probeAtEvent(ev);
});

canvas.addEventListener('pointercancel', () => { drag = null; });

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (!state.volume) return;
  const factor = Math.exp(-ev.deltaY * 0.0012);
  const zoom = clamp((state.view.zoom || 1) * factor, 0.05, 50);
  state.view = { ...state.view, zoom };
  $('zoomRange').value = Math.log2(zoom);
  requestRender();
}, { passive: false });

// --------------------------------------------------------------------------
// Probe
// --------------------------------------------------------------------------
let pendingProbe = null; // {id, hit}
let probeSeq = 0;

function probeFromHit(fx, fy) {
  if (!state.volume) return;
  const cam = computeCamera(state.volume, state.view, state.imageSize, state.imageSize);
  const ray = rayAt(cam, fx, fy);
  const requestId = ++probeSeq;
  state.probe = { fx, fy, requestId };
  if (worker) {
    pendingProbe = { id: requestId, hit: { fx, fy } };
    worker.postMessage({
      type: 'probe', requestId,
      ray: { origin: ray.origin, dir: ray.dir },
      mode: state.mode, step: state.step, tf: state.tf, refMm: state.refMm, window: state.window,
    });
  } else {
    try {
      const tf = normalizeTransferFunction(state.tf).tf;
      const trace = traceRay(state.volume, ray.origin, ray.dir, {
        mode: state.mode, step: state.step, tf, refMm: state.refMm, window: state.window,
      });
      showProbe(trace, { fx, fy });
    } catch (err) {
      toast(`点选失败：${(err && err.message) || err}`, true);
    }
  }
}

function probeAtEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const side = canvas._drawSide || Math.min(canvas.width, canvas.height);
  const ox = canvas._offsetX || 0;
  const oy = canvas._offsetY || 0;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const fx = ((ev.clientX - rect.left) * scale - ox) / side;
  const fy = ((ev.clientY - rect.top) * scale - oy) / side;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
    closeProbe();
    return;
  }
  probeFromHit(fx, fy);
}

function reprobe() {
  if (!state.probe) return;
  probeFromHit(state.probe.fx, state.probe.fy);
}

function showProbe(trace, hit) {
  const panel = $('probePanel');
  panel.classList.remove('hidden');
  const body = $('probeBody');
  if (!trace.hit) {
    body.innerHTML = `<div class="kv"><span>像素</span><span>${(hit.fx * state.imageSize).toFixed(0)}, ${(hit.fy * state.imageSize).toFixed(0)}</span></div>
      <div class="err">该像素射线未进入包围盒（透明背景）。</div>`;
    return;
  }
  const fmt = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '—');
  const f3 = (p) => `(${p.map((c) => fmt(c, 2)).join(', ')})`;
  let html = `<div class="kv"><span>像素</span><span>${(hit.fx * state.imageSize).toFixed(0)}, ${(hit.fy * state.imageSize).toFixed(0)} · ${state.imageSize}²</span></div>
    <div class="kv"><span>模式 / 步长</span><span>${state.mode === 'mip' ? 'MIP' : '合成'} · ${state.step} mm</span></div>
    <div class="sep"></div>
    <div class="kv"><span>进入点</span><span>${f3(trace.entry)}</span></div>
    <div class="kv"><span>离开点</span><span>${f3(trace.exit)}</span></div>
    <div class="kv"><span>区间长度</span><span>${fmt(trace.lengthMm)} mm</span></div>
    <div class="kv"><span>分段</span><span>${trace.segmentCount} 段${trace.segmentCount > 1 ? `（末段 ${fmt(trace.lastSegmentMm)}）` : ''}</span></div>`;
  if (trace.mode === 'mip') {
    const g = trace.final.gray8;
    html += `<div class="sep"></div>
      <div class="kv"><span>最大值</span><span>${fmt(trace.maxValue, 1)}</span></div>
      <div class="kv"><span>窗映射灰度</span><span>${g} / 255</span></div>
      <div class="kv color"><span>最终颜色</span><span><span class="swatch"><span class="swatchFill" style="background:rgba(${g},${g},${g},1)"></span></span><span class="rgba">rgb(${g}, ${g}, ${g})</span></span></div>`;
  } else {
    const c = trace.final.rgba8;
    const lin = trace.final.linear.map((v) => fmt(v, 4)).join(', ');
    html += `<div class="sep"></div>
      <div class="kv"><span>合成 alpha</span><span>${fmt(trace.final.alpha, 6)}</span></div>
      <div class="kv"><span>线性 RGB</span><span>${lin}</span></div>
      <div class="kv color"><span>最终颜色</span><span><span class="swatch"><span class="swatchFill" style="background:rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})"></span></span><span class="rgba">rgba(${c.join(', ')})</span></span></div>`;
  }
  const rows = trace.samples;
  html += `<div class="sep"></div><div class="small">采样（${rows.length} 个，中点位置）</div><div class="samples"><table>
    <tr><th>#</th><th>值</th><th>长度</th><th>α段</th><th>x</th><th>y</th><th>z</th></tr>`;
  const maxIdx = trace.mode === 'mip' ? trace.final.valueSample : -1;
  for (const s of rows) {
    const mark = (trace.mode === 'mip' && s.index === maxIdx) ? ' class="mark"' : '';
    const alphaSeg = trace.mode === 'composite' ? fmt(s.alphaSeg, 4) : '—';
    html += `<tr${mark}><td>${s.index}</td><td>${fmt(s.value, 1)}</td><td>${fmt(s.lengthMm, 2)}</td><td>${alphaSeg}</td>
      <td>${fmt(s.pos[0], 1)}</td><td>${fmt(s.pos[1], 1)}</td><td>${fmt(s.pos[2], 1)}</td></tr>`;
  }
  html += '</table></div>';
  body.innerHTML = html;
}

function closeProbe() {
  state.probe = null;
  pendingProbe = null;
  $('probePanel').classList.add('hidden');
}

// --------------------------------------------------------------------------
// Controls
// --------------------------------------------------------------------------
function syncControlsFromState() {
  $('stepRange').value = state.step;
  $('stepNum').value = state.step;
  $('winLo').value = state.window[0];
  $('winHi').value = state.window[1];
  $('refMm').value = state.refMm;
  $('sizeSel').value = String(state.imageSize);
  $('zoomRange').value = Math.log2(state.view.zoom || 1);
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  updatePresetButtons();
  updateWindowVisibility();
}

function updateWindowVisibility() {
  $('windowRow').style.opacity = state.mode === 'mip' ? '1' : '0.45';
}

function updatePresetButtons() {
  const preset = matchPreset(state.view);
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', preset !== null && b.dataset.view === preset));
  drawAxisHint();
}

function updateAvailable() {
  const has = Boolean(state.volume);
  for (const id of ['btnPng', 'btnSettings', 'btnLoadSettings', 'btnClearProbe']) $(id).disabled = !has;
  $('emptyTip').style.display = has ? 'none' : 'flex';
  $('btnImport2').textContent = '选择 JSON + RAW…';
}

function updateStatus() {
  if (!state.volume) {
    setStatus({ message: '请导入 RAW + JSON，或载入样例' });
    return;
  }
  const v = state.volume;
  const renderingTxt = state.rendering ? '渲染中…（仍可操作）' : `已渲染 ${state.lastRenderMs ? state.lastRenderMs.toFixed(0) + ' ms' : ''}`;
  setStatus({
    message: state.sourceName,
    data: `${v.dims.join('×')} · 间距 ${v.spacing.join('/')} mm · ${v.dataType}`,
    render: `${state.mode === 'mip' ? 'MIP' : '合成'} · 步长 ${state.step} mm · ${state.imageSize}² · ${renderingTxt}`,
  });
}

// --- step
function bindStep() {
  const apply = (value, from) => {
    let s = Number(value);
    if (!Number.isFinite(s)) return;
    s = clamp(s, STEP_MIN, STEP_MAX);
    state.step = s;
    if (from !== 'range') $('stepRange').value = s;
    if (from !== 'num') $('stepNum').value = s;
    requestRender();
    updateStatus();
    if (state.probe) reprobe();
  };
  $('stepRange').addEventListener('input', (e) => apply(e.target.value, 'range'));
  $('stepNum').addEventListener('input', (e) => apply(e.target.value, 'num'));
}

// --- zoom slider
$('zoomRange').addEventListener('input', (e) => {
  const zoom = clamp(Math.pow(2, Number(e.target.value)), 0.05, 50);
  state.view = { ...state.view, zoom };
  requestRender();
  scheduleProbeRefresh();
});

// --- modes
document.querySelectorAll('#modeSeg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b === btn));
    updateWindowVisibility();
    requestRender();
    updateStatus();
    if (state.probe) reprobe();
  });
});

// --- presets
document.querySelectorAll('#viewSeg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.view = presetView(btn.dataset.view);
    updatePresetButtons();
    $('zoomRange').value = 0;
    requestRender();
    if (state.probe) reprobe();
  });
});

$('btnResetPan').addEventListener('click', () => {
  state.view = { ...state.view, pan: [0, 0], zoom: 1 };
  $('zoomRange').value = 0;
  requestRender();
  if (state.probe) reprobe();
});

// --- window
function bindWindowInputs() {
  const apply = () => {
    const lo = Number($('winLo').value);
    const hi = Number($('winHi').value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    state.window = [lo, hi];
    requestRender();
    if (state.probe) reprobe();
  };
  $('winLo').addEventListener('change', apply);
  $('winHi').addEventListener('change', apply);
  $('winLo').addEventListener('input', apply);
  $('winHi').addEventListener('input', apply);
}

// --- reference thickness
$('refMm').addEventListener('change', (e) => {
  const r = Number(e.target.value);
  if (!(r > 0)) { e.target.value = state.refMm; return; }
  state.refMm = r;
  requestRender();
  renderTfEditor();
  if (state.probe) reprobe();
});

// --- image size
$('sizeSel').addEventListener('change', (e) => {
  const n = clamp(Math.round(Number(e.target.value)), IMAGE_MIN, IMAGE_MAX);
  state.imageSize = n;
  requestRender();
  updateStatus();
  if (state.probe) reprobe();
});

// --------------------------------------------------------------------------
// Transfer-function editor
// --------------------------------------------------------------------------
function renderTfEditor() {
  const host = $('tfEditor');
  const v = state.volume;
  const lo = v ? v.valueMin : 0;
  const hi = v ? v.valueMax : 4095;
  host.innerHTML = '';
  state.tf.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'tfRow';
    row.innerHTML = `
      <input type="number" class="tfVal" value="${stop.value}" step="1">
      <input type="color" class="tfColor" value="${linearToSrgbHex(stop.rgb)}">
      <input type="range" class="tfAlpha" min="0" max="1" step="0.001" value="${stop.alpha}">
      <span class="alphaVal">${stop.alpha.toFixed(3)}</span>
      <button class="del" title="删除">✕</button>`;
    const valEl = row.querySelector('.tfVal');
    const colorEl = row.querySelector('.tfColor');
    const alphaEl = row.querySelector('.tfAlpha');
    const alphaVal = row.querySelector('.alphaVal');
    const delEl = row.querySelector('.del');

    valEl.addEventListener('change', () => {
      let value = Number(valEl.value);
      if (!Number.isFinite(value)) { valEl.value = stop.value; return; }
      value = clamp(value, Math.min(lo, hi) - 5, Math.max(lo, hi) + 5);
      stop.value = value;
      valEl.value = value;
      tfChanged();
    });
    colorEl.addEventListener('input', () => {
      stop.rgb = srgbHexToLinear(colorEl.value);
      tfChanged();
    });
    alphaEl.addEventListener('input', () => {
      stop.alpha = Number(alphaEl.value);
      alphaVal.textContent = stop.alpha.toFixed(3);
      tfChanged();
    });
    delEl.addEventListener('click', () => {
      if (state.tf.length <= 1) { toast('至少保留一个控制点', true); return; }
      state.tf.splice(i, 1);
      renderTfEditor();
      tfChanged();
    });
    host.appendChild(row);
  });
  drawTfPreview();
}

let tfChangeTimer = null;
function tfChanged() {
  state.tf.sort((a, b) => a.value - b.value);
  drawTfPreview();
  // The editor re-renders on a timer so typing in a number box does not lose
  // focus mid-edit; the render itself is coalesced by requestRender anyway.
  clearTimeout(tfChangeTimer);
  tfChangeTimer = setTimeout(() => {
    requestRender();
    if (state.probe) reprobe();
  }, 16);
}

function drawTfPreview() {
  // Two stacked bands: the colour ramp on top, the per-mm alpha curve below,
  // both over the transfer function's value span.
  const c = $('tfPreview');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(64, Math.floor(c.clientWidth * dpr));
  const h = Math.max(24, Math.floor(36 * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const tf = normalizeTransferFunction(state.tf).tf;
  const lo = tf[0].value;
  const hi = tf[tf.length - 1].value;
  const span = hi - lo || 1;
  const colorH = Math.round(h * 0.62);
  const alphaTop = colorH;
  const alphaH = h - colorH;

  const img = g.createImageData(w, colorH);
  const alphas = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const value = lo + (x / Math.max(1, w - 1)) * span;
    const te = evalTransfer(tf, value);
    alphas[x] = te.alpha;
    const r = Math.round(linearToSrgb(te.rgb[0]) * 255);
    const gg = Math.round(linearToSrgb(te.rgb[1]) * 255);
    const b = Math.round(linearToSrgb(te.rgb[2]) * 255);
    for (let y = 0; y < colorH; y++) {
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // alpha curve: value on x, per-mm opacity on y (0 at the bottom, 1 at top)
  g.fillStyle = '#12151a';
  g.fillRect(0, alphaTop, w, alphaH);
  g.strokeStyle = 'rgba(140,150,170,0.35)';
  g.lineWidth = Math.max(1, dpr * 0.5);
  g.beginPath();
  g.moveTo(0, alphaTop + alphaH - 0.5);
  g.lineTo(w, alphaTop + alphaH - 0.5);
  g.stroke();
  g.strokeStyle = '#5b9df9';
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const y = alphaTop + alphaH - clamp(alphas[x], 0, 1) * (alphaH - 2) - 1;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

$('btnAddStop').addEventListener('click', () => {
  const lo = state.volume ? state.volume.valueMin : 0;
  const hi = state.volume ? state.volume.valueMax : 4095;
  const mid = (lo + hi) / 2;
  state.tf.push({ value: Math.round(mid), rgb: [0.7, 0.7, 1], alpha: 0.2 });
  state.tf.sort((a, b) => a.value - b.value);
  renderTfEditor();
  tfChanged();
});

$('btnResetTf').addEventListener('click', () => {
  state.tf = DEFAULT_TF.map((s) => ({ value: s.value, rgb: s.rgb.slice(), alpha: s.alpha }));
  renderTfEditor();
  tfChanged();
});

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------
function currentFrameImage() {
  if (!currentFrame) {
    // Render synchronously if the user exports before the first frame lands.
    if (!state.volume) return null;
    const camera = computeCamera(state.volume, state.view, state.imageSize, state.imageSize);
    const img = renderImage({
      volume: state.volume, camera, width: state.imageSize, height: state.imageSize,
      mode: state.mode, step: state.step, tf: normalizeTransferFunction(state.tf).tf,
      refMm: state.refMm, window: state.window,
    });
    return { img, width: state.imageSize, height: state.imageSize };
  }
  return currentFrame;
}

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName() {
  return (state.sourceName || 'volume').replace(/\.json$/i, '').replace(/[^\w.\-]+/g, '_').slice(0, 40) || 'volume';
}

$('btnPng').addEventListener('click', () => {
  const frame = currentFrameImage();
  if (!frame) return;
  try {
    const png = encodePng(frame.width, frame.height, new Uint8Array(frame.img.buffer, frame.img.byteOffset, frame.img.byteLength));
    downloadBytes(png, `${baseName()}_${state.mode}_step${state.step}mm.png`, 'image/png');
    toast(`已导出 PNG：${frame.width}×${frame.height}，直通 alpha + sRGB`);
  } catch (err) {
    toast(`PNG 导出失败：${(err && err.message) || err}`, true);
  }
});

$('btnSettings').addEventListener('click', () => {
  if (!state.volume) return;
  const settings = makeSettings({
    volume: state.volume, view: state.view, mode: state.mode, step: state.step,
    tf: normalizeTransferFunction(state.tf).tf, window: state.window,
    imageSize: state.imageSize, refMm: state.refMm, sourceName: state.sourceName,
  });
  downloadBytes(new TextEncoder().encode(JSON.stringify(settings, null, 2)), `${baseName()}_settings.json`, 'application/json');
  toast(`已导出设置：${describeSettings(settings)}`);
});

$('btnLoadSettings').addEventListener('click', () => $('fileSettings').click());
$('fileSettings').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let input;
  try {
    input = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
  } catch (err) {
    toast(`设置 JSON 解析失败：${(err && err.message) || err}`, true);
    return;
  }
  const parsed = parseSettings(input, state.volume);
  if (!parsed.ok) {
    toast(`设置载入失败：\n${parsed.errors.join('\n')}`, true);
    return;
  }
  if (!state.volume) {
    toast('设置已读取，但尚未加载数据；请先导入对应 RAW + JSON', true);
    return;
  }
  const s = parsed.settings;
  state.view = s.view;
  state.mode = s.mode;
  state.step = s.step;
  state.tf = s.transferFunction;
  state.window = s.window;
  state.imageSize = Array.isArray(s.imageSize) ? s.imageSize[0] : s.imageSize;
  state.refMm = s.opacityReferenceMm;
  syncControlsFromState();
  renderTfEditor();
  requestRender();
  updateStatus();
  toast(`已恢复设置：${describeSettings({ ...s, transferFunction: s.transferFunction })}\n${parsed.warnings.join('\n')}`.trim());
});

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------
$('btnImport').addEventListener('click', () => $('fileData').click());
$('btnImport2').addEventListener('click', () => $('fileData').click());
$('fileData').addEventListener('change', async (e) => {
  // Copy the FileList before clearing the input: the live list empties when
  // the input's value is reset, which would silently drop the selection.
  const files = e.target.files ? Array.from(e.target.files) : [];
  e.target.value = '';
  await handleImport(files);
});
$('btnSample').addEventListener('click', showSamplePicker);
function showSamplePicker() {
  const list = $('sampleList');
  list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (state.samples.length === 0) loadSampleList();
}
$('btnClearProbe').addEventListener('click', closeProbe);
$('btnCloseProbe').addEventListener('click', closeProbe);

// Drag & drop anywhere on the page.
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    await handleImport(e.dataTransfer.files);
  }
});

// Keyboard presets: 1..6 map to the six axes, Esc closes the probe.
window.addEventListener('keydown', (ev) => {
  if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const map = { 1: '+x', 2: '-x', 3: '+y', 4: '-y', 5: '+z', 6: '-z' };
  if (map[ev.key]) {
    state.view = presetView(map[ev.key]);
    updatePresetButtons();
    $('zoomRange').value = 0;
    requestRender();
  } else if (ev.key === 'Escape') {
    closeProbe();
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fitCanvasNoRepaint();
    if (currentFrame) paintFrame(currentFrame.img, currentFrame.width, currentFrame.height);
  }, 60);
});

// --------------------------------------------------------------------------
// Test hook
// --------------------------------------------------------------------------
// A small read-only surface so the browser tests can address exact pixels and
// read the frame the page is showing.  Nothing here mutates app state.
window.__workbench = {
  get volume() { return state.volume; },
  get state() {
    return {
      mode: state.mode, step: state.step, window: state.window.slice(),
      imageSize: state.imageSize, refMm: state.refMm,
      view: { dir: state.view.dir.slice(), up: state.view.up.slice(), zoom: state.view.zoom, pan: state.view.pan.slice() },
      tf: state.tf.map((s) => ({ value: s.value, rgb: s.rgb.slice(), alpha: s.alpha })),
      rendering: state.rendering, lastRenderMs: state.lastRenderMs,
      workerPath: worker && workerReady ? 'worker' : 'main',
      jobSeq, shownSeq,
    };
  },
  get frame() {
    return currentFrame ? { img: currentFrame.img.slice(), width: currentFrame.width, height: currentFrame.height } : null;
  },
  /** Client coordinates of the centre of frame pixel (px, py). */
  pixelToClient(px, py) {
    const rect = canvas.getBoundingClientRect();
    const side = canvas._drawSide || Math.min(canvas.width, canvas.height);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const fx = (px + 0.5) / (currentFrame ? currentFrame.width : state.imageSize);
    const fy = (py + 0.5) / (currentFrame ? currentFrame.height : state.imageSize);
    return {
      x: rect.left + ((canvas._offsetX || 0) + fx * side) / scale,
      y: rect.top + ((canvas._offsetY || 0) + fy * side) / scale,
    };
  },
  /** Frame pixel under a client point, or null when outside the drawing. */
  clientToPixel(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const side = canvas._drawSide || Math.min(canvas.width, canvas.height);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const fx = ((clientX - rect.left) * scale - (canvas._offsetX || 0)) / side;
    const fy = ((clientY - rect.top) * scale - (canvas._offsetY || 0)) / side;
    if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
    return { fx, fy };
  },
  /** World point → frame pixel (continuous coordinates in [0, 1]). */
  projectWorld(p) {
    if (!state.volume) return null;
    const cam = computeCamera(state.volume, state.view, state.imageSize, state.imageSize);
    const d = [p[0] - cam.center[0], p[1] - cam.center[1], p[2] - cam.center[2]];
    const u = d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2];
    const v = d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2];
    return [(u / cam.halfW + 1) / 2, (1 - v / cam.halfH) / 2];
  },
  /** Trace the ray at a continuous frame coordinate with current settings. */
  traceAt(fx, fy) {
    if (!state.volume) return null;
    const cam = computeCamera(state.volume, state.view, state.imageSize, state.imageSize);
    const ray = rayAt(cam, fx, fy);
    return traceRay(state.volume, ray.origin, ray.dir, {
      mode: state.mode, step: state.step, tf: normalizeTransferFunction(state.tf).tf,
      refMm: state.refMm, window: state.window,
    });
  },
};

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
loadSampleList();
bindStep();
bindWindowInputs();
syncControlsFromState();
updateAvailable();
renderTfEditor(); // show the default ramp before any data is loaded
fitCanvasNoRepaint();
