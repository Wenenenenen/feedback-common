// app.js — page controller: import, parameter wiring, worker lifecycle,
// display and export.

import {
  validateCaseMeta, decodeDepth, colorizeDepth, maskPreview, maskComparePreview,
  disparityPixels, pixelShift, isValidDepth, depthRange, FILL_STRATEGY,
  DEFAULTS, LIMITS, fnv1a, hex32,
} from './core.js';
import { decodePng, encodePng } from './png.js';
import { makeZip } from './zip.js';
import { geometryKey, buildParamsJson, archiveName } from './params.js';

const $ = (id) => document.getElementById(id);

const state = {
  dataset: null,       // { caseName, meta, depth, color:{width,height,rgba}, colorHash, depthHash, depthBytes, files }
  result: null,        // last render result
  requestId: 0,
  pending: false,
  fillEnabled: true,
  fillMaxGap: DEFAULTS.fillMaxGap,
  eyeDistance: DEFAULTS.eyeDistance,
  zeroPlane: DEFAULTS.zeroPlane,
  jump: DEFAULTS.jump,
  probe: null,
  maskView: 'both',
  lastGeomKey: null,
  renderStart: 0,
  error: null,
  depthMinValid: NaN,
  depthMaxValid: NaN,
};

const canvases = {
  src: { el: $('cSrc'), panel: $('panelSrc'), tag: $('tagSrc') },
  depth: { el: $('cDepth'), panel: $('panelDepth'), tag: $('tagDepth') },
  mask: { el: $('cMask'), panel: $('panelMask'), tag: $('tagMask') },
  left: { el: $('cLeft'), panel: $('panelLeft'), tag: $('tagLeft') },
  right: { el: $('cRight'), panel: $('panelRight'), tag: $('tagRight') },
  ana: { el: $('cAna'), panel: $('panelAna'), tag: $('tagAna') },
};

let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      setStatus(`渲染线程错误：${e.message}`, 'bad');
      setBusy(false);
    };
  }
  return worker;
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = bad ? 'on bad' : 'on';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, bad ? 6000 : 2600);
}

function setStatus(msg, cls = 'msg') {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = cls;
}

function setBusy(on, phase = '', frac = 0) {
  state.pending = on;
  $('btnCancel').disabled = !on;
  const bar = $('progressBar');
  if (on) {
    bar.classList.add('on');
    bar.style.width = `${Math.round(frac * 100)}%`;
    if (phase) $('statusRender').textContent = `${phase} ${(frac * 100).toFixed(0)}%`;
    $('statusRender').className = 'mono';
  } else {
    bar.classList.remove('on');
    bar.style.width = '0%';
    $('statusRender').textContent = '';
  }
  updateButtons();
}

function updateButtons() {
  const loaded = !!state.dataset;
  // A rejected import does not invalidate the case that is still on screen,
  // so export stays available for it.
  $('btnExport').disabled = !loaded || !state.result || state.pending;
  $('btnSample').disabled = false;
}

function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

// Draw RGBA bytes into a panel canvas at natural resolution.
function drawRGBA(key, rgba, width, height) {
  const cv = canvases[key].el;
  if (!rgba || !width || !height) {
    cv.width = 1; cv.height = 1;
    canvases[key].panel.classList.add('empty');
    return;
  }
  canvases[key].panel.classList.remove('empty');
  if (cv.width !== width || cv.height !== height) {
    cv.width = width;
    cv.height = height;
  }
  const ctx = cv.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
}

function drawMaskPanel() {
  const r = state.result;
  const cv = canvases.mask.el;
  if (!r) {
    drawRGBA('mask', null, 0, 0);
    return;
  }
  const { width, height } = r;
  let rgba;
  if (state.maskView === 'left') rgba = maskPreview(r.leftMask, width, height);
  else if (state.maskView === 'right') rgba = maskPreview(r.rightMask, width, height);
  else rgba = maskComparePreview(r.leftMask, r.rightMask, width, height);
  drawRGBA('mask', rgba, width, height);
}

// ---------------------------------------------------------------------------
// Parameter controls
// ---------------------------------------------------------------------------

function syncControlsFromState() {
  $('eyeRange').value = state.eyeDistance;
  $('eyeNum').value = state.eyeDistance;
  $('zpRange').value = state.zeroPlane;
  $('zpNum').value = state.zeroPlane;
  $('jumpRange').value = state.jump;
  $('jumpNum').value = state.jump;
  $('fillToggle').checked = state.fillEnabled;
  $('fillGapNum').value = state.fillMaxGap;
  $('fillStrategy').textContent = FILL_STRATEGY;
  updateDerivedText();
}

function updateDerivedText() {
  const meta = state.dataset && state.dataset.meta;
  const fx = meta ? meta.fx : 100;
  const min = state.depthMinValid;
  const atNear = Number.isFinite(min)
    ? `最近 Z=${fmt(min, 2)}m → ${fmt(disparityPixels(fx, state.eyeDistance, state.zeroPlane, min), 2)}px`
    : '—';
  const maxZ = state.depthMaxValid;
  $('dispRange').textContent = Number.isFinite(min) && Number.isFinite(maxZ)
    ? `${fmt(min, 2)}–${fmt(maxZ, 2)} m（${fmt(disparityPixels(fx, state.eyeDistance, state.zeroPlane, maxZ), 2)} … ${fmt(disparityPixels(fx, state.eyeDistance, state.zeroPlane, min), 2)} px）`
    : '—';
  $('dispFormula').textContent = atNear;
}

let renderTimer = 0;
function scheduleRender(immediate = false) {
  if (!state.dataset) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderNow(), immediate ? 0 : 70);
}

function countBothHoles(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== 0 && b[i] !== 0) n++;
  return n;
}

function bindParamControls() {
  const pairs = [
    { range: 'eyeRange', num: 'eyeNum', key: 'eyeDistance', min: 0.001, max: 2, render: true,
      validate: (v) => v > 0 },
    { range: 'zpRange', num: 'zpNum', key: 'zeroPlane', min: 0.05, max: 100, render: true,
      validate: (v) => v > 0 },
    { range: 'jumpRange', num: 'jumpNum', key: 'jump', min: 0, max: 100, render: true,
      validate: (v) => v >= 0 },
  ];
  for (const p of pairs) {
    const range = $(p.range);
    const num = $(p.num);
    const apply = (raw, fromRange) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || !p.validate(v)) {
        if (fromRange) return;
        toast('参数无效：需要有限数' + (p.key === 'jump' ? '（≥0）' : '（>0）'), true);
        return;
      }
      state[p.key] = v;
      range.value = v;
      num.value = v;
      updateDerivedText();
      scheduleRender();
    };
    range.addEventListener('input', () => apply(range.value, true));
    num.addEventListener('change', () => apply(num.value, false));
  }

  $('fillToggle').addEventListener('change', () => {
    state.fillEnabled = $('fillToggle').checked;
    applyResultToView();
    updateStatsPanel();
  });

  $('fillGapNum').addEventListener('input', () => {
    const raw = Number($('fillGapNum').value);
    if (!Number.isFinite(raw)) { $('fillGapNum').value = state.fillMaxGap; return; }
    const v = Math.max(0, Math.min(512, Math.round(raw)));
    if (v !== state.fillMaxGap) {
      state.fillMaxGap = v;
      scheduleRender();
    }
    $('fillGapNum').value = v;
  });

  for (const b of $('maskSeg').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state.maskView = b.dataset.mask;
      for (const o of $('maskSeg').querySelectorAll('button')) o.classList.toggle('on', o === b);
      drawMaskPanel();
    });
  }

  $('btnCancel').addEventListener('click', () => {
    if (!state.pending) return;
    clearTimeout(renderTimer);   // a debounced rerender must not undo the cancel
    const id = state.requestId;
    worker && worker.postMessage({ type: 'cancel', requestId: id });
    setStatus('正在取消渲染…', 'warn');
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function decodeText(buf) {
  return new TextDecoder('utf-8').decode(new Uint8Array(buf));
}

function fileBaseName(name) {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return i >= 0 ? name.slice(i + 1) : name;
}

function pickFiles(fileList) {
  const files = Array.from(fileList || []);
  const out = { json: null, png: null, depth: null, extra: [] };
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.json') && !out.json) out.json = f;
    else if ((lower.endsWith('.f32') || lower.endsWith('.bin') || lower.endsWith('.depth')) && !out.depth) out.depth = f;
    else if ((f.type === 'image/png' || lower.endsWith('.png')) && !out.png) out.png = f;
    else out.extra.push(f);
  }
  // Fall back to the JSON's own names when the user picked more than one PNG.
  return out;
}

async function readCaseFromFiles(files, sourceLabel) {
  const picked = pickFiles(files);
  if (!picked.json) throw new ImportError(['需要一个 JSON 描述文件（.json），但没有选到']);
  let rawJson;
  try {
    rawJson = JSON.parse(decodeText(await picked.json.arrayBuffer()));
  } catch (err) {
    throw new ImportError([`JSON 解析失败：${err.message}`]);
  }
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new ImportError(['JSON 顶层必须是对象']);
  }

  // Match the PNG / depth by the names declared in the JSON when the user
  // provided several candidates.
  const all = Array.from(files);
  const byName = (declared, fallback) => {
    const wanted = String(declared || '').toLowerCase();
    const hits = all.filter((f) => f.name.toLowerCase() === wanted || fileBaseName(f.name.toLowerCase()) === wanted);
    if (hits.length) return hits[0];
    return fallback;
  };
  const pngFile = byName(rawJson.color, picked.png);
  const depthFile = byName(rawJson.depth, picked.depth);
  const missing = [];
  if (!pngFile) missing.push(`颜色 PNG（JSON 中 color = ${JSON.stringify(rawJson.color)}）`);
  if (!depthFile) missing.push(`深度文件（JSON 中 depth = ${JSON.stringify(rawJson.depth)}）`);
  if (missing.length) throw new ImportError([`缺少文件：${missing.join('；')}`]);

  const pngBytes = new Uint8Array(await pngFile.arrayBuffer());
  const depthBytes = new Uint8Array(await depthFile.arrayBuffer());

  let png;
  try {
    png = await decodePng(pngBytes);
  } catch (err) {
    throw new ImportError([`颜色图片无法读取：${err.message}`]);
  }

  const check = validateCaseMeta(rawJson, { depthBytes: depthBytes.byteLength, colorDims: png });
  if (!check.ok) {
    throw new ImportError(check.errors, check.warnings);
  }
  const meta = check.meta;
  if (png.width > LIMITS.maxWidth || png.height > LIMITS.maxHeight) {
    throw new ImportError([`颜色 PNG 尺寸 ${png.width}×${png.height} 超过上限 ${LIMITS.maxWidth}×${LIMITS.maxHeight}`]);
  }

  let depth;
  try {
    depth = decodeDepth(depthBytes, meta.width, meta.height, meta.depth);
  } catch (err) {
    throw new ImportError([err.message]);
  }

  const invalid = depthRange(depth).invalid;
  const warnings = [...check.warnings];
  if (invalid > 0) warnings.push(`${invalid} 个像素的深度为 0 或非有限值，将留下空洞`);

  return {
    caseName: (picked.json.name.replace(/\.json$/i, '') || sourceLabel),
    meta,
    depth,
    color: { width: png.width, height: png.height, rgba: png.rgba },
    depthBytes: depthBytes.byteLength,
    colorBytes: pngBytes.byteLength,
    colorHash: hex32(fnv1a(pngBytes)),
    depthHash: hex32(fnv1a(depthBytes)),
    warnings,
    files: { json: picked.json.name, png: pngFile.name, depth: depthFile.name },
  };
}

class ImportError extends Error {
  constructor(messages, warnings = []) {
    super(messages.join('\n'));
    this.name = 'ImportError';
    this.messages = messages;
    this.warnings = warnings;
  }
}

async function loadCase(files, sourceLabel) {
  setStatus('正在读取并校验文件…', 'warn');
  let dataset;
  try {
    dataset = await readCaseFromFiles(files, sourceLabel);
  } catch (err) {
    const msgs = err instanceof ImportError ? err.messages : [String(err.message || err)];
    showImportError(msgs, sourceLabel);
    return false;
  }

  state.dataset = dataset;
  state.result = null;
  state.requestId++;      // drop any result still in flight from the old case
  state.lastGeomKey = null;
  state.eyeDistance = dataset.meta.eyeDistance;
  state.zeroPlane = dataset.meta.zeroPlane;
  state.jump = dataset.meta.jump;
  state.fillMaxGap = DEFAULTS.fillMaxGap;
  state.fillEnabled = true;
  state.probe = null;
  $('probePanel').classList.add('hidden');
  $('probeHint').classList.remove('hidden');

  // Depth preview + source panel are ready before the first render.
  const depthPreview = colorizeDepth(dataset.depth, dataset.meta.width, dataset.meta.height);
  state.depthMinValid = depthPreview.range.min;
  state.depthMaxValid = depthPreview.range.max;
  state.error = null;
  drawRGBA('src', dataset.color.rgba, dataset.color.width, dataset.color.height);
  drawRGBA('depth', depthPreview.rgba, dataset.meta.width, dataset.meta.height);
  for (const key of ['mask', 'left', 'right', 'ana']) drawRGBA(key, null, 0, 0);
  $('emptyTip').style.display = 'none';

  canvases.src.tag.textContent = `${dataset.files.png} · ${dataset.meta.width}×${dataset.meta.height}`;
  canvases.depth.tag.textContent = depthPreview.range.hasRange
    ? `${fmt(depthPreview.range.min, 2)}–${fmt(depthPreview.range.max, 2)} m · 紫=无效`
    : '全部无效';
  canvases.mask.tag.textContent = '';
  canvases.left.tag.textContent = '';
  canvases.right.tag.textContent = '';
  canvases.ana.tag.textContent = '红=左眼 · 青=右眼';

  syncControlsFromState();
  renderDataCard(dataset);
  updateButtons();

  $('importError').classList.add('hidden');
  setStatus(`已载入 ${dataset.caseName}`, 'good');
  if (dataset.warnings.length) $('statusData').textContent = dataset.warnings.join('；');

  const w = getWorker();
  w.postMessage({
    type: 'load',
    datasetId: `${dataset.caseName}:${dataset.depthHash}`,
    width: dataset.meta.width,
    height: dataset.meta.height,
    depth: dataset.depth.slice().buffer,
    color: dataset.color.rgba.slice().buffer,
  });
  renderNow();
  return true;
}

// A rejected import never destroys what is already on screen: the error is
// shown above the data card and the previously loaded case stays usable.
function showImportError(messages, sourceLabel) {
  state.error = messages;
  const box = $('importError');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'h';
  head.textContent = `导入被拒绝：${sourceLabel || '所选文件'}`;
  box.appendChild(head);
  for (const msg of messages) {
    const line = document.createElement('div');
    line.textContent = msg;
    box.appendChild(line);
  }
  box.classList.remove('hidden');

  if (!state.dataset) {
    const card = $('dataCard');
    card.className = 'dataCard err';
    card.innerHTML = '<div class="small">没有可用数据。</div>';
    for (const key of ['mask', 'left', 'right', 'ana']) drawRGBA(key, null, 0, 0);
    $('emptyTip').style.display = 'flex';
  }
  setStatus(`导入被拒绝：${messages[0]}`, 'bad');
  $('statusData').textContent = '';
  updateButtons();
  toast('导入被拒绝，详见左侧红色提示', true);
}

// ---------------------------------------------------------------------------
// Render lifecycle
// ---------------------------------------------------------------------------

function currentParams() {
  const m = state.dataset.meta;
  // The worker always computes the fill preview; fillEnabled only decides
  // which buffers this page displays, so toggling it never re-rasterises.
  return {
    fx: m.fx, fy: m.fy, cx: m.cx, cy: m.cy,
    eyeDistance: state.eyeDistance,
    zeroPlane: state.zeroPlane,
    jump: state.jump,
    fillMaxGap: state.fillMaxGap,
  };
}

function renderNow() {
  if (!state.dataset) return;
  const params = currentParams();
  const key = geometryKey(params);
  state.requestId++;
  state.lastGeomKey = key;
  state.renderStart = performance.now();
  setBusy(true, '准备', 0);
  setStatus(`渲染中：眼距 ${fmt(params.eyeDistance, 3)} m · Z₀ ${fmt(params.zeroPlane, 2)} m · Δ ${fmt(params.jump, 2)} m`, 'warn');
  getWorker().postMessage({ type: 'render', requestId: state.requestId, geomKey: key, params });
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'progress') {
    if (msg.requestId !== state.requestId) return;
    setBusy(true, msg.phase, Math.max(0, Math.min(1, msg.frac)));
    return;
  }

  if (msg.type === 'result') {
    if (msg.requestId !== state.requestId) return; // stale
    state.result = msg;
    const elapsed = ((performance.now() - state.renderStart) / 1000).toFixed(2);
    applyResultToView();
    updateStatsPanel();
    setBusy(false);
    setStatus(`就绪 · ${msg.triangleCount} 三角形 · ${elapsed}s`, 'good');
    updateButtons();
    if (state.probe) showProbe(state.probe.x, state.probe.y);
    return;
  }

  if (msg.type === 'cancelled') {
    if (msg.requestId !== state.requestId) return;
    setBusy(false);
    setStatus('渲染已取消（显示的是取消前最后一次完成的结果）', 'warn');
    updateButtons();
    return;
  }

  if (msg.type === 'error') {
    if (msg.requestId !== state.requestId) return;
    setBusy(false);
    setStatus(`渲染失败：${msg.message}`, 'bad');
    updateButtons();
    return;
  }
}

function applyResultToView() {
  const r = state.result;
  if (!r) return;
  const { width, height } = r;
  const fillOn = state.fillEnabled;

  drawRGBA('left', fillOn ? r.fillLeftRGBA : r.leftRGBA, width, height);
  drawRGBA('right', fillOn ? r.fillRightRGBA : r.rightRGBA, width, height);
  drawRGBA('ana', fillOn ? r.anaglyphFilled : r.anaglyph, width, height);
  drawMaskPanel();

  const holesL = r.stats.leftHoles;
  const holesR = r.stats.rightHoles;
  const both = countBothHoles(r.leftMask, r.rightMask);
  canvases.mask.tag.textContent = `左 ${holesL} / 右 ${holesR} 孔 · 双眼同孔 ${both}`;
  canvases.left.tag.textContent = `${fmt(state.eyeDistance, 3)}m 基线${fillOn ? ' · 已补洞预览' : ''}`;
  canvases.right.tag.textContent = `${fmt(state.eyeDistance, 3)}m 基线${fillOn ? ' · 已补洞预览' : ''}`;
  canvases.ana.tag.textContent = fillOn ? '红=左眼 · 青=右眼 · 补洞预览' : '红=左眼 · 青=右眼';
}

function updateStatsPanel() {
  const r = state.result;
  const box = $('statsBox');
  if (!r || !state.dataset) {
    box.innerHTML = '<div class="small">—</div>';
    return;
  }
  const s = r.stats;
  const fl = s.leftFill;
  const fr = s.rightFill;
  const rows = [
    ['三角形', `${r.triangleCount} / ${r.cellCount * 2}`],
    ['左眼覆盖 / 空洞', `${s.leftCovered} / ${s.leftHoles}`],
    ['右眼覆盖 / 空洞', `${s.rightCovered} / ${s.rightHoles}`],
    ['左眼补洞像素', fl.disabled === undefined && fl.filled !== undefined ? `${fl.filled}（${fl.filledRuns}/${fl.runs} 段）` : '—'],
    ['右眼补洞像素', fr.filled !== undefined ? `${fr.filled}（${fr.filledRuns}/${fr.runs} 段）` : '—'],
    ['无效深度像素', r.depthRange.invalid],
    ['深度范围', r.depthRange.hasRange ? `${fmt(r.depthRange.min, 3)}–${fmt(r.depthRange.max, 3)} m` : '—'],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('');

  const fillText = state.fillEnabled
    ? `本次实际填充 ${fl.filled} 像素（左）/ ${fr.filled}（右），上限 ${fl.maxGap}px。`
    : '补洞已关闭：左右眼与红青预览显示未补洞结果，导出的补洞预览仍按当前上限生成。';
  $('fillStats').innerHTML = `<span>左 ${fl.filled} / 右 ${fr.filled} px</span><span>上限 ${fl.maxGap}px${state.fillEnabled ? '' : '（未显示）'}</span>`;
  $('fillStrategy').textContent = FILL_STRATEGY;
  $('fillStrategy').title = fillText;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

// Map a click on a displayed canvas to natural image coordinates, honouring
// the object-fit: contain letterboxing.
function canvasPointToPixel(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h || !rect.width || !rect.height) return null;
  // The canvas fills its panel with object-fit: contain, so the image is
  // letterboxed inside the CSS box; invert that fit before mapping pixels.
  const scale = Math.min(rect.width / w, rect.height / h);
  const ox = rect.left + (rect.width - w * scale) / 2;
  const oy = rect.top + (rect.height - h * scale) / 2;
  const px = Math.floor((ev.clientX - ox) / scale);
  const py = Math.floor((ev.clientY - oy) / scale);
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  return { x: px, y: py };
}

function bindProbes() {
  for (const key of Object.keys(canvases)) {
    canvases[key].el.addEventListener('click', (ev) => {
      const pt = canvasPointToPixel(canvases[key].el, ev);
      if (!pt) return;
      showProbe(pt.x, pt.y);
    });
  }
  $('btnCloseProbe').addEventListener('click', () => {
    $('probePanel').classList.add('hidden');
    $('probeHint').classList.remove('hidden');
    state.probe = null;
  });
}

function showProbe(x, y) {
  if (!state.dataset) return;
  state.probe = { x, y };
  const meta = state.dataset.meta;
  const depth = state.dataset.depth;
  const i = y * meta.width + x;
  const z = depth[i];
  const valid = isValidDepth(z);
  const disp = disparityPixels(meta.fx, state.eyeDistance, state.zeroPlane, z);
  const shiftL = pixelShift(meta.fx, state.eyeDistance, state.zeroPlane, z, 'left');
  const shiftR = pixelShift(meta.fx, state.eyeDistance, state.zeroPlane, z, 'right');
  const r = state.result;
  let leftCovers = null;
  let rightCovers = null;
  if (r) {
    leftCovers = r.leftMask[i] === 0;
    rightCovers = r.rightMask[i] === 0;
  }

  const badge = (cov) => cov === null ? '<span class="badge">—</span>'
    : cov ? '<span class="badge cov">覆盖</span>' : '<span class="badge hole">空洞</span>';

  const rows = [
    ['像素 (c, r)', `(${x}, ${y})`],
    ['像素中心', `(${x + 0.5}, ${y + 0.5})`],
    ['深度 Z', valid ? `${fmt(z, 4)} m` : '0 / 非有限 → 空洞'],
    ['理论视差 d(Z)', valid ? `${fmt(disp, 3)} px` : '—'],
    ['左眼位移', valid ? `${fmt(shiftL, 3)} px` : '—'],
    ['右眼位移', valid ? `${fmt(shiftR, 3)} px` : '—'],
  ];
  const qual = [
    ['左眼该像素', badge(leftCovers)],
    ['右眼该像素', badge(rightCovers)],
  ];
  const body = $('probeBody');
  body.innerHTML =
    '<div class="kv"><span>像素 (c, r)</span><span>(' + x + ', ' + y + ')</span></div>' +
    rows.slice(2).map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') +
    '<div class="sep"></div>' +
    qual.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') +
    `<div class="note">d(Z) = fx·b·(1/Z − 1/Z₀)，fx=${fmt(meta.fx, 2)} px，b=${fmt(state.eyeDistance, 3)} m，Z₀=${fmt(state.zeroPlane, 2)} m。` +
    '正值表示比零视差面更近（交叉视差）。' +
    '</div>';
  $('probePanel').classList.remove('hidden');
  $('probeHint').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Sample list + server API
// ---------------------------------------------------------------------------

async function loadSampleList() {
  try {
    const res = await fetch('/api/cases', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = $('sampleList');
    list.innerHTML = '';
    if (!data.cases || !data.cases.length) {
      list.innerHTML = '<div class="small">没有可用样例。请手动导入。</div>';
      return;
    }
    for (const c of data.cases) {
      const row = document.createElement('div');
      row.className = 'row';
      const b = document.createElement('button');
      b.style.flex = '1';
      b.textContent = c.name;
      b.title = c.note || '';
      b.addEventListener('click', async () => {
        setStatus(`载入样例 ${c.name}…`, 'warn');
        b.disabled = true;
        try {
          const files = await fetchSampleFiles(c);
          await loadCase(files, c.name);
        } catch (err) {
          showImportError([String(err.message || err)], c.name);
        } finally {
          b.disabled = false;
        }
      });
      const tag = document.createElement('span');
      tag.className = 'small';
      tag.textContent = c.size ? `${c.size[0]}×${c.size[1]}` : '';
      row.appendChild(b);
      row.appendChild(tag);
      list.appendChild(row);
    }
  } catch (err) {
    $('sampleList').innerHTML = `<div class="small">样例列表不可用（${String(err.message || err)}）。手动导入即可。</div>`;
  }
}

async function fetchSampleFiles(c) {
  const metaRes = await fetch(`/api/case/${encodeURIComponent(c.json)}`, { cache: 'no-store' });
  if (!metaRes.ok) throw new Error(`读取 ${c.json} 失败：HTTP ${metaRes.status}`);
  const jsonBlob = await metaRes.blob();
  const meta = JSON.parse(await jsonBlob.text());

  const grab = async (name) => {
    const res = await fetch(`/api/case/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`读取 ${name} 失败：HTTP ${res.status}`);
    return res.blob();
  };

  const files = [];
  files.push(new File([jsonBlob], c.json, { type: 'application/json' }));
  const pngBlob = await grab(fileBaseName(meta.color));
  files.push(new File([pngBlob], fileBaseName(meta.color), { type: 'image/png' }));
  const depthBlob = await grab(fileBaseName(meta.depth));
  files.push(new File([depthBlob], fileBaseName(meta.depth), { type: 'application/octet-stream' }));
  return files;
}

// ---------------------------------------------------------------------------
// Import wiring
// ---------------------------------------------------------------------------

function bindImport() {
  const input = $('fileImport');
  const open = () => input.click();
  $('btnImport').addEventListener('click', open);
  $('btnImport2').addEventListener('click', open);
  $('btnSample').addEventListener('click', () => {
    const first = $('sampleList').querySelector('button');
    if (first) first.click(); else toast('没有可用样例', true);
  });
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    await loadCase(files, files.map((f) => f.name).join(' + '));
  });

  document.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  document.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer?.files || []);
    if (!files.length) return;
    await loadCase(files, files.map((f) => f.name).join(' + '));
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportArchive() {
  const r = state.result;
  const dataset = state.dataset;
  if (!r || !dataset) return;
  const { width, height } = r;

  const btn = $('btnExport');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '打包中…';
  try {
    const stamp = new Date();
    const paramsJson = buildParamsJson({ state, meta: dataset.meta, dataset, result: r });
    const encoder = new TextEncoder();

    // Anaglyph is a convenience preview of the *unfilled* eyes; the required
    // files come first so a reader sees the contract immediately.
    const anaglyphPng = await encodePng({ width, height, kind: 'rgba', data: r.anaglyph });
    const entries = [
      { name: 'left.png', data: await encodePng({ width, height, kind: 'rgba', data: r.leftRGBA }) },
      { name: 'right.png', data: await encodePng({ width, height, kind: 'rgba', data: r.rightRGBA }) },
      { name: 'left-filled.png', data: await encodePng({ width, height, kind: 'rgba', data: r.fillLeftRGBA }) },
      { name: 'right-filled.png', data: await encodePng({ width, height, kind: 'rgba', data: r.fillRightRGBA }) },
      { name: 'left-mask.png', data: await encodePng({ width, height, kind: 'gray', data: r.leftMask }) },
      { name: 'right-mask.png', data: await encodePng({ width, height, kind: 'gray', data: r.rightMask }) },
      { name: 'anaglyph.png', data: anaglyphPng },
      { name: 'params.json', data: encoder.encode(JSON.stringify(paramsJson, null, 2)) },
      {
        name: 'README.txt',
        data: encoder.encode(
          'Stereo Depth Forge export\n' +
          'left.png / right.png        unfilled eyes, straight alpha (255 covered, 0 hole)\n' +
          'left-filled.png / right-filled.png  horizontal hole-fill preview (never exported as truth)\n' +
          'left-mask.png / right-mask.png       raw hole masks, 8-bit gray, 255 = hole, 0 = covered\n' +
          'anaglyph.png               red = left, cyan = right, from the unfilled eyes\n' +
          'params.json                complete parameters and input fingerprints\n',
        ),
      },
    ];
    entries.forEach((e) => { e.date = stamp; });

    const zip = await makeZip(entries);
    const blob = new Blob([zip], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = archiveName({ caseName: dataset.caseName }, stamp);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus(`已导出 ${a.download}（${entries.length} 个文件，${(zip.length / 1024).toFixed(1)} KiB）`, 'good');
    toast('导出完成');
  } catch (err) {
    console.error(err);
    setStatus(`导出失败：${String(err.message || err)}`, 'bad');
    toast('导出失败', true);
  } finally {
    btn.textContent = prev;
    updateButtons();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderDataCard(dataset) {
  const m = dataset.meta;
  const card = $('dataCard');
  card.className = 'dataCard';
  card.innerHTML = `
    <div class="name">${escapeHtml(dataset.caseName)}</div>
    <div class="meta">${m.width}×${m.height} · fx ${fmt(m.fx, 2)} · fy ${fmt(m.fy, 2)} · cx ${fmt(m.cx, 2)} · cy ${fmt(m.cy, 2)}</div>
    <div class="meta">颜色 ${escapeHtml(dataset.files.png)}（${(dataset.colorBytes / 1024).toFixed(1)} KiB）</div>
    <div class="meta">深度 ${escapeHtml(dataset.files.depth)}（${dataset.depthBytes} B，${(dataset.depthBytes / 4) | 0} 像素）</div>
    <div class="meta mono">depth ${dataset.depthHash} · color ${dataset.colorHash}</div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function init() {
  syncControlsFromState();
  bindParamControls();
  bindProbes();
  bindImport();
  $('btnExport').addEventListener('click', exportArchive);
  updateButtons();
  updateStatsPanel();
  loadSampleList();
}

init();
