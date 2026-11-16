/*
 * 主线程：导入、烘焙调度、旋转、预览、读数、导出。
 *
 * 关键约束：
 *   - 一次只有一份「当前结果」；任何失败（PFM 解析、烘焙、JSON 导入）
 *     都在写入 state.result 之前抛出，因此已有结果不会被覆盖。
 *   - 显示（曝光/色调映射）只影响 canvas；系数始终来自线性积分。
 *   - 旋转角烘焙进系数：state.result.radiance 为未旋转的积分结果，
 *     旋转后的系数按需计算并缓存，导出时写同一份值。
 */

import {
  BASIS_LABELS, BASIS_LONG_LABELS, BASIS_AXIS_HINTS,
  COEFFICIENT_COUNT, CHANNEL_NAMES, KIND_LABELS,
  KIND_UNITS, MAX_WIDTH, MAX_HEIGHT,
} from './constants.js';
import { parsePfm, PfmError } from './pfm.js';
import {
  convolve, rotateY, evaluate, luminance,
  l1Direction, directionAngles,
} from './sh.js';
import {
  buildCoefficientJson, parseCoefficientJson, coefficientFileName,
  CoefficientJsonError,
} from './coefficients.js';
import { renderEquirect, paintCanvas } from './preview.js';
import { NormalSphereView } from './sphere-view.js';
import { expectedChecks } from './conformance.js';
import { TONE_MODES, displayRgb } from './tonemap.js';

const $ = (id) => document.getElementById(id);

/** 应用状态。 */
const state = {
  source: null, // {fileName, meta, values, width, height, stats, warnings}
  result: null, // {radiance, rowContrib, rowSolidAngles, totalSolidAngle, naiveMean, weightedMean, width, height, rotationDegBakedIn}
  rotationDeg: 0, // 当前烘焙角
  display: { exposure: 1, mode: 'reinhard' },
  previewRotated: true,
  selectedNormal: { x: 1, y: 0, z: 0 },
  kind: 'irradiance',
  rowBand: 0,
  sampleMeta: null,
  expected: null,
  job: null, // {id, worker, cancelled}
  resultStale: false,
  bakeTimer: null,
  importedKindInfo: null,
};

const worker = new Worker(new URL('./bake-worker.js', import.meta.url), { type: 'module' });
const sphere = new NormalSphereView($('sphere-canvas'), {
  onSelect: (dir) => {
    state.selectedNormal = dir;
    updateReadout();
  },
  onHover: () => {},
});
// 供端到端测试使用（只读：投影与视图状态）
window.__ishbSphere = sphere;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ───────────────────────── 状态与提示 ───────────────────────── */

function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  const dot = $('status-dot');
  dot.classList.remove('busy', 'ok', 'error');
  if (kind) dot.classList.add(kind);
}

function setProgress(fraction) {
  const bar = $('bake-progress');
  if (fraction === null) {
    bar.hidden = true;
    bar.value = 0;
    return;
  }
  bar.hidden = false;
  bar.value = clamp(fraction, 0, 1);
}

function showError(id, message) {
  const box = $(id);
  if (!message) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function showOk(id, message) {
  const box = $(id);
  if (!message) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function renderWarnings(id, warnings) {
  const list = $(id);
  list.innerHTML = '';
  for (const w of warnings || []) {
    const li = document.createElement('li');
    li.textContent = w;
    list.appendChild(li);
  }
}

let toastTimer = null;
function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/* ───────────────────────── 系数缓存 ───────────────────────── */

let rotatedCache = { key: '', radiance: null, irradiance: null };

function currentRadiance() {
  if (!state.result) return null;
  const key = `${state.result.token}|${state.rotationDeg}`;
  if (rotatedCache.key === key && rotatedCache.radiance) return rotatedCache.radiance;
  const rotated = state.rotationDeg === 0
    ? Float64Array.from(state.result.radiance)
    : rotateY(state.result.radiance, state.rotationDeg);
  rotatedCache = { key, radiance: rotated, irradiance: null };
  return rotated;
}

function currentIrradiance() {
  if (!state.result) return null;
  const key = `${state.result.token}|${state.rotationDeg}`;
  if (rotatedCache.key !== key || !rotatedCache.irradiance) {
    const r = currentRadiance();
    rotatedCache = { key, radiance: r, irradiance: convolve(r) };
  }
  return rotatedCache.irradiance;
}

function currentCoefficients(kind) {
  return kind === 'radiance' ? currentRadiance() : currentIrradiance();
}

/* ───────────────────────── 导入 PFM ───────────────────────── */

async function readFileBytes(file) {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

function formatOptions() {
  return {
    byteOrder: $('opt-endian').value,
    rowOrder: $('opt-roworder').value,
    scaleMode: $('opt-scale').value,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
  };
}

function describePfmError(err) {
  if (err instanceof PfmError) return err.message;
  return err?.message || String(err);
}

/** 载入字节并解析；解析通过后才替换 state.source。 */
async function loadPfmBytes(bytes, fileName) {
  showError('import-error', '');
  cancelBake();
  setStatus(`正在解析 ${fileName}…`);

  let parsed;
  try {
    parsed = parsePfm(bytes, formatOptions());
  } catch (err) {
    setStatus(`${fileName} 解析失败`, 'error');
    showError('import-error', describePfmError(err));
    // 不触碰 state.source / state.result
    return false;
  }

  state.source = {
    fileName,
    values: parsed.values,
    width: parsed.width,
    height: parsed.height,
    meta: parsed,
    warnings: parsed.warnings,
  };
  // 关键：解析成功后也不清空 state.result —— 新烘焙成功前，已有结果必须保留。
  // 若旧结果仍在，标记为「已过期」，面板上说明它来自哪个环境。
  state.resultStale = Boolean(state.result);
  renderImageMeta(parsed, fileName);
  renderWarnings('image-warnings', parsed.warnings);
  $('equirect-empty').hidden = true;
  paintEquirectPreview();
  setStatus(`已解析 ${fileName}，开始烘焙…`);
  await startBake();
  return true;
}

async function loadPfmFile(file) {
  if (!file) return;
  let bytes;
  try {
    bytes = await readFileBytes(file);
  } catch (err) {
    setStatus('读取文件失败', 'error');
    showError('import-error', `无法读取文件：${err.message}`);
    return;
  }
  await loadPfmBytes(bytes, file.name);
}

function renderImageMeta(parsed, fileName) {
  const grid = $('image-meta');
  grid.hidden = false;
  const rows = [
    ['文件', fileName],
    ['尺寸', `${parsed.width} × ${parsed.height}`],
    ['字节序', parsed.endian === 'little' ? '小端 (LE)' : '大端 (BE)'],
    ['尺度因子', String(parsed.scale)],
    ['读出倍数', `×${parsed.factor}`],
    ['行序', parsed.rowOrder === 'bottom' ? '底行优先' : '顶行优先'],
    ['辐亮度范围', `${fmt(parsed.stats.min)} … ${fmt(parsed.stats.max)}`],
    ['数据字节', `${parsed.bytesUsed} / ${parsed.byteLength}`],
  ];
  grid.innerHTML = '';
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    div.append(dt, dd);
    grid.appendChild(div);
  }
}

/* ───────────────────────── 烘焙（Worker + 取消） ───────────────────────── */

let jobCounter = 0;

function cancelBake() {
  if (state.job && !state.job.finished) {
    state.job.cancelled = true;
    worker.postMessage({ type: 'cancel', jobId: state.job.id });
  }
}

async function startBake() {
  if (!state.source) return;
  cancelBake();
  const jobId = ++jobCounter;
  const job = { id: jobId, finished: false, cancelled: false };
  state.job = job;

  const { values, width, height } = state.source;
  $('cancel-bake').hidden = false;
  $('cancel-bake').disabled = false;
  setStatus(`烘焙中… 0 / ${height} 行`, 'busy');
  setProgress(0);

  const copy = new Float32Array(values); // 转移副本，保留原件用于旋转预览
  const started = performance.now();
  const finished = await new Promise((resolve) => {
    const onMessage = (event) => {
      const msg = event.data;
      if (!msg || msg.jobId !== jobId) return;
      if (msg.type === 'progress') {
        setProgress(msg.fraction);
        setStatus(`烘焙中… ${msg.row + 1} / ${height} 行`, 'busy');
        return;
      }
      worker.removeEventListener('message', onMessage);
      resolve(msg);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'bake', jobId, values: copy, width, height }, [copy.buffer]);
  });

  job.finished = true;
  // 另一份导入已经发起了新任务：旧任务的回包必须忽略，不能改状态或覆盖结果。
  if (state.job !== job) return;
  $('cancel-bake').hidden = true;
  setProgress(null);

  if (finished.type === 'cancelled' || job.cancelled) {
    setStatus(state.result
      ? '烘焙已取消；保留上一次的结果（当前系数未变）'
      : '烘焙已取消；尚无可用结果', '');
    updateStaleNote();
    return;
  }
  if (finished.type === 'error') {
    setStatus('烘焙失败；上一次的结果保留', 'error');
    showError('import-error', `${finished.message}${state.result ? '\n已有结果未被覆盖。' : ''}`);
    updateStaleNote();
    return;
  }
  if (finished.type !== 'done') return;

  const r = finished.result;
  state.result = {
    token: `${Date.now()}-${jobId}`,
    radiance: r.radiance,
    rowContrib: r.rowContrib,
    rowSolidAngles: r.rowSolidAngles,
    rowMeanLuminance: r.rowMeanLuminance,
    totalSolidAngle: r.totalSolidAngle,
    naiveMean: r.naiveMean,
    weightedMean: r.weightedMean,
    width: r.width,
    height: r.height,
    rotationDegBakedIn: 0,
    sourceName: state.source.fileName,
  };
  rotatedCache = { key: '', radiance: null, irradiance: null };
  state.resultStale = false;
  const ms = performance.now() - started;
  setStatus(`烘焙完成 · ${height} 行 · ${ms.toFixed(0)} ms`, 'ok');
  refreshDerived();
  runConformance();
}

/* ───────────────────────── 派生视图刷新 ───────────────────────── */

function updateStaleNote() {
  const note = $('coeff-stale');
  if (!note) return;
  if (!state.resultStale || !state.result) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = `⚠ 下面的系数来自上一次成功的 ${state.result.imported ? '导入' : '烘焙'}`
    + `（${state.result.sourceName || '未知来源'}）；`
    + '本次导入尚未生成新系数，导出仍会使用这份旧结果。';
}

function refreshDerived() {
  updateStaleNote();
  updateCoefficientTable();
  updateRowTable();
  updateMeanTable();
  updateRotationMeta();
  updateSphere();
  updateReadout();
  updateButtons();
  paintEquirectPreview();
  if (state.previewRotated) paintEquirectPreview();
}

function updateButtons() {
  const has = Boolean(state.result);
  for (const id of ['export-radiance', 'export-irradiance', 'export-both',
    'copy-radiance', 'copy-irradiance']) {
    $(id).disabled = !has;
  }
}

function fmt(v, digits = 6) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(3);
  const d = a >= 1000 ? Math.min(2, digits) : Math.min(digits, 6);
  return v.toFixed(d).replace(/\.?0+$/, '') || '0';
}

function updateCoefficientTable() {
  const body = $('coeff-body');
  body.innerHTML = '';
  const c = currentRadiance();
  const e = currentIrradiance();
  if (!c || !e) {
    $('coeff-summary').textContent = '—';
    return;
  }
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    const tr = document.createElement('tr');
    const cells = [
      { text: BASIS_LABELS[i], cls: 'basis-name' },
      { text: `${BASIS_LONG_LABELS[i]} · ${BASIS_AXIS_HINTS[i]}`, cls: 'basis-hint' },
      ...[0, 1, 2].map((k) => ({ text: fmt(c[i * 3 + k]), cls: 'num' })),
      ...[0, 1, 2].map((k) => ({ text: fmt(e[i * 3 + k]), cls: 'num' })),
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.cls) td.className = cell.cls;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  const kindLabel = KIND_LABELS[state.kind];
  const bright = l1Direction(c);
  $('coeff-summary').textContent = bright
    ? `当前系数（旋转 ${fmt(state.rotationDeg, 3)}°）的 l=1 亮部方向 ≈ `
      + `(${fmt(bright.x, 3)}, ${fmt(bright.y, 3)}, ${fmt(bright.z, 3)}) · 球面板显示 ${kindLabel}`
    : `当前系数几乎各向同性（无 l=1）· 旋转 ${fmt(state.rotationDeg, 3)}° · 球面板显示 ${kindLabel}`;
}

function updateRowTable() {
  const body = $('row-body');
  body.innerHTML = '';
  if (!state.result) {
    $('row-total-omega').textContent = '—';
    return;
  }
  const { rowSolidAngles, height, rowContrib: contrib, rowMeanLuminance } = state.result;
  if (!contrib || !rowSolidAngles || state.result.imported) {
    $('row-body').innerHTML = '<tr><td colspan="9" class="hint">当前结果来自 JSON 导入，没有逐行数据。</td></tr>';
    for (const id of ['row-total-omega', 'row-total-r', 'row-total-g', 'row-total-b', 'row-total-mean']) {
      $(id).textContent = '—';
    }
    return;
  }
  const band = state.rowBand;
  const omegaSum = state.result.totalSolidAngle || 4 * Math.PI;
  let maxOmega = 0;
  for (let r = 0; r < height; r++) maxOmega = Math.max(maxOmega, rowSolidAngles[r]);
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  const frag = document.createDocumentFragment();

  for (let r = 0; r < height; r++) {
    const base = (r * COEFFICIENT_COUNT + band) * 3;
    const cr = contrib[base];
    const cg = contrib[base + 1];
    const cb = contrib[base + 2];
    totalR += cr;
    totalG += cg;
    totalB += cb;

    const theta = (Math.PI * (r + 0.5)) / height;
    const rowMean = rowMeanLuminance ? rowMeanLuminance[r] : 0;
    const share = rowSolidAngles[r] / omegaSum;
    const barRatio = maxOmega > 0 ? rowSolidAngles[r] / maxOmega : 0;

    const tr = document.createElement('tr');
    tr.append(
      cell(String(r)), cell(formatAngle(theta)), cell(fmt(rowSolidAngles[r], 6)),
      barCell(barRatio), cell(formatShare(share)), cell(fmt(rowMean)),
      cell(fmt(cr)), cell(fmt(cg)), cell(fmt(cb)),
    );
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  $('row-total-omega').textContent = `${fmt(omegaSum, 9)}`;
  $('row-total-r').textContent = fmt(totalR);
  $('row-total-g').textContent = fmt(totalG);
  $('row-total-b').textContent = fmt(totalB);
  const weightedSum = state.result.weightedMean;
  $('row-total-mean').textContent = weightedSum ? fmt(luminance(weightedSum)) : '—';
}

function formatShare(share) {
  const pct = share * 100;
  if (pct === 0) return '0%';
  if (pct < 0.01) return `${pct.toExponential(2)}%`;
  return `${pct.toFixed(3)}%`;
}

function cell(text, cls = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function formatAngle(thetaRad) {
  return ((thetaRad * 180) / Math.PI).toFixed(2);
}

function barCell(ratio, cls = '') {
  const td = document.createElement('td');
  td.className = `bar-col ${cls}`.trim();
  const track = document.createElement('div');
  track.className = 'bar-track';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  // 以赤道行的立体角为满格：极区行几乎看不到，正好说明权重差异
  fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  track.appendChild(fill);
  td.appendChild(track);
  return td;
}

function updateMeanTable() {
  const body = $('mean-body');
  body.innerHTML = '';
  if (!state.result) return;
  const { naiveMean, weightedMean } = state.result;
  for (let k = 0; k < 3; k++) {
    const tr = document.createElement('tr');
    const a = naiveMean[k];
    const b = weightedMean[k];
    const dev = b === 0 ? (a === 0 ? 0 : Infinity) : (a - b) / Math.abs(b);
    tr.append(
      cell(CHANNEL_NAMES[k]),
      cell(fmt(a), 'num'),
      cell(fmt(b), 'num'),
      cell(Number.isFinite(dev) ? `${(dev * 100).toFixed(2)}%` : '—', 'num'),
    );
    body.appendChild(tr);
  }
}

function updateRotationMeta() {
  const wrap = $('rotation-meta');
  const c = currentRadiance();
  if (!state.result) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const before = l1Direction(state.result.radiance);
  const after = l1Direction(c);
  $('rot-bright-before').textContent = dirText(before);
  $('rot-bright-after').textContent = dirText(after);
}

function dirText(dir) {
  if (!dir) return '各向同性（无 l=1 分量）';
  const angles = directionAngles(dir.x, dir.y, dir.z);
  return `(${fmt(dir.x, 3)}, ${fmt(dir.y, 3)}, ${fmt(dir.z, 3)}) · θ ${angles.theta.toFixed(1)}° φ ${angles.phi.toFixed(1)}°`;
}

/* ───────────────────────── 预览绘制 ───────────────────────── */

let equirectImage = null;

function paintEquirectPreview() {
  if (!state.source) return;
  const rotation = state.previewRotated ? state.rotationDeg : 0;
  equirectImage = renderEquirect(
    state.source.values, state.source.width, state.source.height,
    { exposure: state.display.exposure, mode: state.display.mode, rotationDeg: rotation },
  );
  paintCanvas($('equirect-canvas'), equirectImage);
  const tone = TONE_MODES.find((m) => m.id === state.display.mode);
  $('preview-caption').textContent =
    `${state.source.width}×${state.source.height} · 曝光 ×${state.display.exposure.toFixed(2)}`
    + ` · ${tone?.label || state.display.mode}`
    + ` · ${rotation ? `预览已按 ${fmt(rotation, 3)}° 旋转` : '未旋转'}`
    + '（仅显示）';
}

/* ───────────────────────── 法线球与读数 ───────────────────────── */

function updateSphere() {
  // 球面与等距柱状预览使用同一显示映射（只影响像素，读数仍是线性值）
  sphere.setDisplay({ exposure: state.display.exposure, mode: state.display.mode });
  const coeffs = state.kind === 'radiance' ? currentRadiance() : currentIrradiance();
  sphere.setCoefficients(coeffs);
  sphere.setSelected(state.selectedNormal);
  sphere.draw();
}

function updateReadout() {
  const dir = state.selectedNormal;
  const coeffs = currentCoefficients(state.kind);
  $('ro-kind-label').textContent = state.kind === 'radiance' ? '辐亮度 C(n)' : '辐照度 E(n)';
  $('ro-unit').textContent = KIND_UNITS[state.kind];
  $('kind-irradiance').classList.toggle('active', state.kind === 'irradiance');
  $('kind-radiance').classList.toggle('active', state.kind === 'radiance');

  if (!coeffs) {
    $('ro-dir').textContent = '—';
    $('ro-angles').textContent = '—';
    $('ro-value').textContent = '—';
    $('ro-lum').textContent = '—';
    $('ro-swatch').style.background = 'var(--surface-3)';
    return;
  }
  const rgb = new Float64Array(3);
  evaluate(coeffs, dir.x, dir.y, dir.z, rgb);
  const { theta, phi } = directionAngles(dir.x, dir.y, dir.z);
  $('ro-dir').textContent = `(${fmt(dir.x, 3)}, ${fmt(dir.y, 3)}, ${fmt(dir.z, 3)})`;
  $('ro-angles').textContent = `θ ${theta.toFixed(1)}° · φ ${phi.toFixed(1)}°`;
  $('ro-value').textContent = `(${fmt(rgb[0])}, ${fmt(rgb[1])}, ${fmt(rgb[2])})`;
  $('ro-lum').textContent = fmt(luminance(rgb));
  // 预览色：用同一显示映射，但明确标注是显示值
  const shown = displayRgb([rgb[0], rgb[1], rgb[2]], state.display.exposure, state.display.mode, [0, 0, 0]);
  $('ro-swatch').style.background = `rgb(${shown[0]}, ${shown[1]}, ${shown[2]})`;
  $('ro-swatch').title = '显示映射后的颜色（曝光/色调映射不影响数值）';
}

/* ───────────────────────── 旋转 ───────────────────────── */

function normalizeAngle(deg) {
  let a = Number(deg);
  if (!Number.isFinite(a)) a = 0;
  a = ((a % 360) + 360) % 360;
  if (a > 180) a -= 360;
  return a;
}

function setRotation(deg, { fromSlider = false, fromNumber = false } = {}) {
  const raw = clamp(Number.isFinite(deg) ? deg : 0, -360, 360);
  // 系数以 360° 为周期：规范化到 (−180°, 180°]，等价角度得到逐位相同的结果。
  const angle = normalizeAngle(raw);
  const changed = angle !== state.rotationDeg;
  state.rotationDeg = angle;
  if (!fromNumber) $('rotation-number').value = String(round3(angle));
  if (!fromSlider) $('rotation-range').value = String(round3(angle));
  if (!changed) return;
  rotatedCache = { key: '', radiance: null, irradiance: null };
  refreshDerived();
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/* ───────────────────────── 系数 JSON 导入 ───────────────────────── */

function describeCoeffError(err) {
  if (err instanceof CoefficientJsonError) return err.message;
  return err?.message || String(err);
}

async function importCoefficientText(text, label) {
  showError('coeff-error', '');
  showOk('coeff-ok', '');
  renderWarnings('coeff-warnings', []);
  let parsed;
  try {
    parsed = parseCoefficientJson(text);
  } catch (err) {
    showError('coeff-error', describeCoeffError(err));
    return false;
  }

  cancelBake();
  // 以导入的辐亮度系数作为新结果（无源图，行级数据清空）
  state.result = {
    token: `import-${Date.now()}`,
    radiance: parsed.radiance,
    rowContrib: null,
    rowSolidAngles: null,
    totalSolidAngle: 4 * Math.PI,
    naiveMean: new Float64Array(3),
    weightedMean: new Float64Array(3),
    width: state.source?.width || 0,
    height: state.source?.height || 0,
    sourceName: label,
    imported: true,
  };
  state.rotationDeg = 0; // 文件中的角度已烘焙，界面从 0° 起
  state.resultStale = false;
  rotatedCache = { key: '', radiance: null, irradiance: null };
  $('rotation-number').value = '0';
  $('rotation-range').value = '0';

  const kindLabel = KIND_LABELS[parsed.kind];
  showOk('coeff-ok',
    `已导入 ${kindLabel}（${KIND_UNITS[parsed.kind]}）· 文件记录的烘焙角 ${fmt(parsed.rotationDeg, 3)}° `
    + '· 界面按 0° 起，不会再次旋转。');
  renderWarnings('coeff-warnings', parsed.warnings);

  const meta = $('import-meta');
  meta.hidden = false;
  meta.innerHTML = '';
  const rows = [
    ['来源', label],
    ['kind', `${parsed.kind}（${KIND_LABELS[parsed.kind]}）`],
    ['单位', parsed.units],
    ['已烘焙旋转', `${fmt(parsed.rotationDeg, 3)}°`],
    ['C₀（R/G/B）', [0, 1, 2].map((k) => fmt(parsed.radiance[k])).join(' / ')],
    ['E₀（R/G/B）', [0, 1, 2].map((k) => fmt(parsed.irradiance[k])).join(' / ')],
  ];
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    div.append(dt, dd);
    meta.appendChild(div);
  }

  setStatus(`已导入系数：${label}`, 'ok');
  resetConformance();
  refreshDerived();
  return true;
}

/* ───────────────────────── 导出 ───────────────────────── */

function provenance() {
  if (state.result?.imported) {
    return {
      type: 'imported',
      source: state.result.sourceName,
      note: '由本地 JSON 导入后再导出；数值未再旋转。',
    };
  }
  const meta = state.source?.meta;
  if (!meta) return null;
  return {
    type: 'baked-from-pfm',
    file: state.source.fileName,
    width: meta.width,
    height: meta.height,
    endian: meta.endian,
    scaleFactor: meta.scale,
    factorApplied: meta.factor,
    rowOrder: meta.rowOrder,
    sourceMin: meta.stats.min,
    sourceMax: meta.stats.max,
    displayOnly: { exposure: state.display.exposure, toneMap: state.display.mode },
    note: '显示用曝光/色调映射未参与系数计算。',
  };
}

function buildExport(kind) {
  const coeffs = currentCoefficients(kind);
  if (!coeffs) return null;
  const json = buildCoefficientJson({
    kind,
    coefficients: coeffs,
    rotationDeg: state.rotationDeg,
    provenance: provenance(),
  });
  const text = `${JSON.stringify(json, null, 2)}\n`;
  return {
    text,
    json,
    fileName: coefficientFileName(kind, state.rotationDeg),
  };
}

function downloadText(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 退路：临时 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function exportKind(kind) {
  const built = buildExport(kind);
  if (!built) {
    toast('没有可导出的系数：请先载入环境图或导入系数。');
    return null;
  }
  downloadText(built.fileName, built.text);
  showOk('export-ok',
    `已导出 ${KIND_LABELS[kind]}（${KIND_UNITS[kind]}）→ ${built.fileName}`
    + ` · 旋转 ${fmt(state.rotationDeg, 3)}° 已烘焙。`);
  return built;
}

/* ───────────────────────── 参考值核对 ───────────────────────── */

function resetConformance() {
  const list = $('conformance-list');
  list.innerHTML = '<li class="muted">尚未载入样例。</li>';
}

function clearConformance() {
  $('conformance-list').innerHTML = '<li class="muted">当前不是样例载入，未做核对。</li>';
}

function pushCheck(list, name, pass, detail = '') {
  const li = document.createElement('li');
  const mark = document.createElement('span');
  mark.className = `mark ${pass ? 'pass' : 'fail'}`;
  mark.textContent = pass ? 'PASS' : 'FAIL';
  const label = document.createElement('span');
  label.textContent = name;
  li.append(mark, label);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = detail;
    li.appendChild(d);
  }
  list.appendChild(li);
}

async function runConformance() {
  if (!state.sampleMeta?.id || !state.result) return;
  const list = $('conformance-list');
  await ensureExpected();
  const checks = expectedChecks(state.expected, state.sampleMeta.id, state.result);
  if (!checks || checks.length === 0) {
    clearConformance();
    return;
  }
  list.innerHTML = '';
  for (const c of checks) pushCheck(list, c.name, c.pass, c.detail);
}

/* ───────────────────────── 样例 ───────────────────────── */

async function loadSampleList() {
  const select = $('sample-select');
  select.innerHTML = '<option value="">（样例加载中…）</option>';
  let manifest;
  try {
    const res = await fetch('/api/samples', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    select.innerHTML = '<option value="">样例不可用（可直接导入文件）</option>';
    return;
  }
  if (!manifest.available || !manifest.cases?.length) {
    select.innerHTML = '<option value="">未找到样例包</option>';
    return;
  }
  select.innerHTML = '';
  for (const c of manifest.cases) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.title;
    const meta = c.meta;
    opt.dataset.path = c.path;
    opt.dataset.title = c.title;
    opt.dataset.description = c.description;
    if (meta) {
      opt.dataset.meta = `${meta.width}×${meta.height} ${meta.endian} scale ${meta.scale}${
        meta.truncated ? ' · 截断' : ''}`;
    }
    select.appendChild(opt);
  }
  state.sampleManifest = manifest;
}

async function loadSelectedSample() {
  const select = $('sample-select');
  const opt = select.selectedOptions[0];
  if (!opt || !opt.dataset.path) return;
  const path = opt.dataset.path;
  cancelBake();
  showError('import-error', '');
  setStatus(`正在获取样例 ${opt.textContent}…`);
  let bytes;
  try {
    const res = await fetch(`/api/sample?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    setStatus('样例获取失败', 'error');
    showError('import-error', `无法获取样例：${err.message}`);
    return;
  }
  state.sampleMeta = { id: opt.value, title: opt.textContent, path };
  const ok = await loadPfmBytes(bytes, path);
  if (!ok) state.sampleMeta = null;
  await ensureExpected();
  if (ok) await runConformance();
}

let expectedPromise = null;
async function ensureExpected() {
  if (state.expected) return state.expected;
  if (expectedPromise) return expectedPromise;
  expectedPromise = (async () => {
    try {
      const res = await fetch('/api/expected', { cache: 'no-store' });
      if (res.ok) state.expected = await res.json();
    } catch {
      state.expected = null;
    }
    return state.expected;
  })();
  return expectedPromise;
}

/**
 * 期望值模块（延迟创建）：
 * 这里把 expected.json 的绝对值与当前结果比较。样例的 expected.json
 * 只给常量与线性公式，因此逐项核对它们能覆盖的断言。
 */
/* ───────────────────────── 事件绑定 ───────────────────────── */

function bindEvents() {
  // 文件与拖放
  const drop = $('drop-zone');
  drop.addEventListener('click', () => $('file-input').click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('file-input').click();
    }
  });
  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await loadPfmFile(file);
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    });
  }
  drop.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) await loadPfmFile(file);
  });

  // 样例
  $('load-sample').addEventListener('click', loadSelectedSample);
  $('sample-select').addEventListener('change', () => {
    const opt = $('sample-select').selectedOptions[0];
    if (opt?.dataset.description) $('preview-caption').textContent = opt.dataset.description;
  });

  // 取消
  $('cancel-bake').addEventListener('click', () => {
    if (!state.job || state.job.finished) return;
    state.job.cancelled = true;
    worker.postMessage({ type: 'cancel', jobId: state.job.id });
    setStatus('正在取消烘焙…', 'busy');
    $('cancel-bake').disabled = true;
  });

  // 格式覆盖：重新解析当前文件不现实（没有保留字节），提示重新导入
  for (const id of ['opt-endian', 'opt-roworder', 'opt-scale']) {
    $(id).addEventListener('change', () => {
      $('override-hint').textContent = state.source
        ? '已更改格式覆盖；请重新导入同一文件以生效。'
        : '覆盖后需重新载入文件才生效。';
    });
  }

  // 显示
  $('exposure-range').addEventListener('input', (e) => {
    const stops = Number(e.target.value);
    state.display.exposure = Math.pow(2, stops);
    $('exposure-out').textContent = `×${state.display.exposure.toFixed(2)}`;
    paintEquirectPreview();
    updateSphere();
    updateReadout();
  });
  const toneSelect = $('tone-mode');
  for (const mode of TONE_MODES) {
    const opt = document.createElement('option');
    opt.value = mode.id;
    opt.textContent = `${mode.label} — ${mode.hint}`;
    toneSelect.appendChild(opt);
  }
  toneSelect.value = state.display.mode;
  toneSelect.addEventListener('change', (e) => {
    state.display.mode = e.target.value;
    paintEquirectPreview();
    updateSphere();
    updateReadout();
  });
  $('exposure-range').value = String(Math.log2(state.display.exposure));
  $('exposure-out').textContent = `×${state.display.exposure.toFixed(2)}`;
  $('display-note').textContent =
    '球面板与预览使用同一显示映射；右栏读数始终是线性值。';

  $('preview-rotated').addEventListener('change', (e) => {
    state.previewRotated = e.target.checked;
    paintEquirectPreview();
  });

  // 旋转
  const numberInput = $('rotation-number');
  const rangeInput = $('rotation-range');
  numberInput.addEventListener('input', () => {
    const v = Number(numberInput.value);
    if (Number.isFinite(v)) setRotation(clamp(v, -360, 360), { fromNumber: true });
  });
  rangeInput.addEventListener('input', () => {
    setRotation(Number(rangeInput.value), { fromSlider: true });
  });
  for (const btn of document.querySelectorAll('[data-angle]')) {
    btn.addEventListener('click', () => setRotation(Number(btn.dataset.angle)));
  }

  // 系数导入
  $('coeff-pick').addEventListener('click', () => $('coeff-input').click());
  $('coeff-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (err) {
      showError('coeff-error', `无法读取文件：${err.message}`);
      return;
    }
    await importCoefficientText(text, file.name);
  });
  $('coeff-paste-toggle').addEventListener('click', () => {
    const ta = $('coeff-paste');
    ta.hidden = !ta.hidden;
    $('coeff-paste-actions').hidden = ta.hidden;
    if (!ta.hidden) ta.focus();
  });
  $('coeff-import-paste').addEventListener('click', async () => {
    await importCoefficientText($('coeff-paste').value, '粘贴内容');
  });

  // 导出
  $('export-radiance').addEventListener('click', () => {
    const built = exportKind('radiance');
    if (built) toast(`已下载 ${built.fileName}`);
  });
  $('export-irradiance').addEventListener('click', () => {
    const built = exportKind('irradiance');
    if (built) toast(`已下载 ${built.fileName}`);
  });
  $('export-both').addEventListener('click', () => {
    const r = exportKind('radiance');
    const e = exportKind('irradiance');
    if (r && e) toast('已下载两份 JSON');
  });
  $('copy-radiance').addEventListener('click', async () => {
    const built = buildExport('radiance');
    if (!built) return toast('没有可复制的辐亮度系数。');
    toast(await copyText(built.text) ? '辐亮度 JSON 已复制' : '复制失败：浏览器拒绝访问剪贴板');
  });
  $('copy-irradiance').addEventListener('click', async () => {
    const built = buildExport('irradiance');
    if (!built) return toast('没有可复制的辐照度系数。');
    toast(await copyText(built.text) ? '辐照度 JSON 已复制' : '复制失败：浏览器拒绝访问剪贴板');
  });

  // 法线球
  $('kind-irradiance').addEventListener('click', () => {
    state.kind = 'irradiance';
    updateSphere();
    updateReadout();
    updateCoefficientTable();
  });
  $('kind-radiance').addEventListener('click', () => {
    state.kind = 'radiance';
    updateSphere();
    updateReadout();
    updateCoefficientTable();
  });

  // 行表
  const bandSelect = $('row-band-select');
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${BASIS_LABELS[i]}（${BASIS_LONG_LABELS[i]}）`;
    bandSelect.appendChild(opt);
  }
  bandSelect.addEventListener('change', (e) => {
    state.rowBand = Number(e.target.value);
    updateRowTable();
  });
  $('row-only-nonzero').addEventListener('change', updateRowTable);

  // 窗口尺寸变化：重画
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.source) paintCanvas($('equirect-canvas'), equirectImage);
      sphere.draw();
    }, 120);
  });
}

/* ───────────────────────── 启动 ───────────────────────── */

function boot() {
  bindEvents();
  sphere.setDisplay({ exposure: 1, mode: state.display.mode });
  updateButtons();
  updateReadout();
  sphere.draw();
  ensureExpected().then(() => {
    if (state.sampleMeta && state.result) runConformance();
  });
  loadSampleList();
}

boot();
