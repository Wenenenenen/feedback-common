import {
  decodePNG, encodePNG, browserInflate, browserDeflate, downloadBytes,
  validateGuide, validateDepth, validateMask,
} from './png-codec.js';
import { buildGraph, solve, residualToMM, STATUS } from './solver.js';
import {
  renderDepth, renderStatus, renderComponents, renderGuide, drawImageData, depthRange,
} from './viz.js';

const $ = (id) => document.getElementById(id);
const state = { guide: null, depth: null, mask: null, maskSize: null, graph: null, result: null, range: null, hover: null };

// Theme ---------------------------------------------------------------------
const themeToggle = $('themeToggle');
themeToggle.addEventListener('click', () => {
  const root = document.documentElement;
  const cur = root.getAttribute('data-theme');
  root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
});

// File loading --------------------------------------------------------------
function setRowOk(rowId, ok, metaText) {
  const row = $(rowId);
  row.classList.toggle('ok', !!ok);
  if (metaText !== undefined) row.querySelector('.meta').textContent = metaText;
}

async function loadImage(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  return decodePNG(buf, browserInflate);
}

function checkSameSize() {
  // Only compare pairs that have loaded; a later change re-checks everything.
  if (state.guide && state.depth &&
    (state.guide.width !== state.depth.width || state.guide.height !== state.depth.height)) {
    throw new Error('引导图与深度图尺寸不一致');
  }
  if (state.maskSize && state.depth &&
    (state.maskSize.width !== state.depth.width || state.maskSize.height !== state.depth.height)) {
    throw new Error('掩膜与深度图尺寸不一致');
  }
}

$('guideFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const img = await loadImage(file);
    validateGuide(img);
    state.guide = img;
    setRowOk('guideRow', true, `${img.width}×${img.height} · ${img.bitDepth}位 · ${img.channels}通道`);
    checkSameSize();
  } catch (err) {
    state.guide = null; setRowOk('guideRow', false, '');
    showError('引导图：' + err.message);
  }
  refreshRunEnabled();
});

$('depthFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const img = await loadImage(file);
    validateDepth(img);
    state.depth = img;
    let nonzero = 0;
    for (const v of img.samples) if (v !== 0) nonzero++;
    setRowOk('depthRow', true, `${img.width}×${img.height} · 16位 · ${nonzero} 个测量点`);
    checkSameSize();
  } catch (err) {
    state.depth = null; setRowOk('depthRow', false, '');
    showError('深度图：' + err.message);
  }
  refreshRunEnabled();
});

$('maskFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) { state.mask = null; state.maskSize = null; setRowOk('maskRow', false, ''); return; }
  try {
    const img = await loadImage(file);
    validateMask(img);
    const mask = new Uint8Array(img.width * img.height);
    for (let i = 0; i < mask.length; i++) mask[i] = img.samples[i * img.channels] === 0 ? 0 : 255;
    state.mask = mask;
    state.maskSize = { width: img.width, height: img.height };
    const valid = mask.reduce((s, v) => s + (v === 255 ? 1 : 0), 0);
    setRowOk('maskRow', true, `${img.width}×${img.height} · ${valid} 个有效像素`);
    checkSameSize();
  } catch (err) {
    state.mask = null; state.maskSize = null; setRowOk('maskRow', false, '');
    showError('掩膜：' + err.message);
  }
  refreshRunEnabled();
});

function refreshRunEnabled() {
  $('runBtn').disabled = !(state.guide && state.depth);
}

// Controls ------------------------------------------------------------------
const sigmaEl = $('sigma'), edgeEl = $('edgeThreshold');
sigmaEl.addEventListener('input', () => { $('sigmaVal').textContent = Number(sigmaEl.value).toFixed(2); });
edgeEl.addEventListener('input', () => { $('edgeVal').textContent = Number(edgeEl.value).toFixed(2); });

function showError(msg) {
  const el = $('runMsg');
  el.innerHTML = msg ? `<div class="msg err">${escapeHtml(msg)}</div>` : '';
}
function showOk(msg) {
  const el = $('runMsg');
  el.innerHTML = `<div class="msg ok">${escapeHtml(msg)}</div>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Solve ---------------------------------------------------------------------
let runSeq = 0;
$('runBtn').addEventListener('click', async () => {
  const seq = ++runSeq;
  const btn = $('runBtn');
  btn.disabled = true;
  $('progressWrap').hidden = false;
  const bar = $('progressBar');
  bar.style.width = '8%';
  showError('');
  try {
    const params = {
      sigma: Number(sigmaEl.value),
      edgeThreshold: Number(edgeEl.value),
    };
    await tick();
    const graph = buildGraph({
      width: state.depth.width, height: state.depth.height,
      guide: state.guide, depth: state.depth, mask: state.mask,
      sigma: params.sigma, edgeThreshold: params.edgeThreshold,
    });
    if (seq !== runSeq) return;
    bar.style.width = '35%';
    const space = document.querySelector('input[name="space"]:checked').value;
    const solver = $('solver').value;
    const result = await solve(graph, {
      space, solver,
      onProgress: () => { bar.style.width = Math.min(92, 35 + Math.random() * 55) + '%'; },
    });
    if (seq !== runSeq) return;
    state.graph = graph; state.result = result;
    state.range = depthRange(result.outMM);
    bar.style.width = '100%';
    renderAll();
    fillStats();
    fillCompTable();
    showOk(result.stats.allConverged
      ? `求解完成：所有锚定分量收敛，最大归一化残差 ≤ 1e-5`
      : '部分分量未在迭代上限内收敛（见统计表），未收敛点保持未解');
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    btn.disabled = false;
    setTimeout(() => { $('progressWrap').hidden = true; bar.style.width = '0'; }, 400);
  }
});
const tick = () => new Promise((r) => setTimeout(r, 0));

// Rendering -----------------------------------------------------------------
function displaySize() {
  const w = state.depth.width;
  const panel = document.querySelector('.canvas-grid').clientWidth;
  const twoCol = window.innerWidth > 720 ? 2 : 1;
  const target = Math.min(360, Math.max(120, (panel - 40) / twoCol));
  return Math.round(target);
}

function renderAll() {
  const { graph, result, range, depth } = state;
  const size = displaySize();
  const sparseMM = new Uint16Array(depth.samples);
  drawImageData($('cvSparse'), renderDepth(depth.width, depth.height, sparseMM, range), size);
  drawImageData($('cvComplete'), renderDepth(depth.width, depth.height, result.outMM, range), size);
  drawImageData($('cvStatus'), renderStatus(depth.width, depth.height, result.status), size);
  drawImageData($('cvComp'), renderComponents(depth.width, depth.height, graph, result), size);
  $('cb1min').textContent = range.vmin + ' mm';
  $('cb1max').textContent = range.vmax + ' mm';
  $('completeHint').textContent = `${result.space === 'depth' ? '深度空间' : '逆深度空间'} · 同色标`;
  ['expDepth', 'expStatus', 'expJson'].forEach((id) => { $(id).disabled = false; });
  bindCrosshair();
}

function fillStats() {
  const s = state.result.stats;
  $('stState').textContent = s.allConverged ? '全部收敛' : '部分未收敛';
  $('stState').style.color = s.allConverged ? 'var(--good)' : 'var(--warn)';
  $('stValid').innerHTML = `${s.validPixels}`;
  $('stAnchor').innerHTML = `${s.anchorPixels}`;
  $('stComp').innerHTML = `${s.componentCount} <small>锚定 ${s.anchoredComponents}</small>`;
  $('stUnanchored').innerHTML = `${s.unanchoredComponents}`;
  $('stIgnored').innerHTML = `${s.ignoredMeasurements}`;
  const maxRes = Math.max(0, ...state.result.components.map((c) => c.maxAbsResidual ?? 0));
  $('stRes').innerHTML = maxRes === 0 ? '0' : maxRes.toExponential(2);
}

function fillCompTable() {
  const tb = $('compTable').querySelector('tbody');
  tb.innerHTML = '';
  for (const c of state.result.components) {
    const tr = document.createElement('tr');
    const dm = c.depthMM;
    const statusPill = !c.anchored
      ? '<span class="pill unanchored">无锚点</span>'
      : c.solved ? '<span class="pill completed">已补全</span>' : '<span class="pill outside">未收敛</span>';
    tr.innerHTML = `
      <td>#${c.id}</td><td>${c.size}</td><td>${c.anchorCount}</td><td>${statusPill}</td>
      <td>${c.iterations ?? '–'}</td>
      <td>${c.maxAbsResidual === null ? '–' : c.maxAbsResidual.toExponential(2)}</td>
      <td>${dm ? dm.min : '–'}</td><td>${dm ? dm.mean.toFixed(1) : '–'}</td><td>${dm ? dm.max : '–'}</td>`;
    tb.appendChild(tr);
  }
}

// Cross-canvas crosshair + pixel inspector ----------------------------------
function pixelFromEvent(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * canvas.width);
  const y = Math.floor((ev.clientY - rect.top) / rect.height * canvas.height);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  return { x, y };
}

function bindCrosshair() {
  const canvases = ['cvSparse', 'cvComplete', 'cvStatus', 'cvComp'].map($);
  const crosses = ['ch0', 'ch1', 'ch2', 'ch3'].map($);
  for (let ci = 0; ci < canvases.length; ci++) {
    const canvas = canvases[ci];
    canvas.onmousemove = (ev) => {
      const px = pixelFromEvent(canvas, ev);
      if (!px) return;
      state.hover = px;
      updateCrosshairs(px);
      renderInspector(px);
    };
    canvas.onmouseleave = () => crosses.forEach((c) => { c.style.display = 'none'; });
    canvas.onclick = (ev) => {
      const px = pixelFromEvent(canvas, ev);
      if (px) { state.hover = px; updateCrosshairs(px); renderInspector(px, true); }
    };
  }
  function updateCrosshairs(px) {
    canvases.forEach((canvas, i) => {
      const rect = canvas.getBoundingClientRect();
      const wrap = canvas.parentElement.getBoundingClientRect();
      const pxW = rect.width / canvas.width, pxH = rect.height / canvas.height;
      const ch = crosses[i];
      ch.style.display = 'block';
      ch.style.left = (rect.left - wrap.left + px.x * pxW - 1) + 'px';
      ch.style.top = (rect.top - wrap.top + px.y * pxH - 1) + 'px';
      ch.style.width = pxW + 'px';
      ch.style.height = pxH + 'px';
    });
  }
}

function renderInspector(px, pinned = false) {
  const { graph, result, depth, guide } = state;
  const idx = px.y * depth.width + px.x;
  const inDomain = !!graph.domain[idx];
  const measured = depth.samples[idx];
  const status = result.status[idx];
  const compId = graph.compOf[idx];
  const z = result.z[idx];
  const resZ = result.residual[idx];
  const resMM = inDomain && status === STATUS.COMPLETED ? residualToMM(resZ, z, result.space) : null;

  const pill = ({
    [STATUS.ANCHOR]: '<span class="pill anchor">255 原始测量</span>',
    [STATUS.COMPLETED]: '<span class="pill completed">128 成功补全</span>',
    [STATUS.UNANCHORED]: '<span class="pill unanchored">64 无锚点分量</span>',
    [STATUS.OUTSIDE]: '<span class="pill outside">0 域外</span>',
  })[status] || '';

  const g = guide.samples.slice(idx * guide.channels, idx * guide.channels + 3);
  const rows = [
    ['坐标', `(${px.x}, ${px.y})`],
    ['状态', pill],
    ['连通分量', inDomain ? `#${compId}` : '—'],
    ['引导 RGB', `(${g[0]}, ${g[1]}, ${g[2]})`],
    ['原始测量', measured ? `${measured} mm` : '缺测'],
    ['输出深度', result.outMM[idx] ? `${result.outMM[idx]} mm` : '0（未解）'],
    ['z 值', Number.isNaN(z) ? '—' : `${z.toExponential(6)} ${result.space === 'depth' ? 'm' : '1/m'}`],
    ['归一化残差', resMM === null ? '—' : `${resZ.toExponential(3)} (z空间)`],
    ['残差折合', resMM === null ? '—' : `${resMM.toExponential(3)} mm`],
  ];
  $('inspector').innerHTML =
    `<div class="grid2">${rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>` +
    (pinned ? '<div style="margin-top:8px;color:var(--fg-faint);font-size:11px">已固定该像素，移动鼠标可查看其他像素</div>' : '');
}

// Exports -------------------------------------------------------------------
$('expDepth').addEventListener('click', async () => {
  const r = state.result;
  const png = await encodePNG(state.depth.width, state.depth.height, 1, 16, r.outMM, browserDeflate);
  downloadBytes(png, `depth_completed_${r.space}.png`, 'image/png');
});
$('expStatus').addEventListener('click', async () => {
  const r = state.result;
  const png = await encodePNG(state.depth.width, state.depth.height, 1, 8, r.status, browserDeflate);
  downloadBytes(png, 'depth_status.png', 'image/png');
});
$('expJson').addEventListener('click', () => {
  const r = state.result, g = state.graph;
  const payload = {
    generated_at: new Date().toISOString(),
    parameters: {
      sigma: g.sigma, edge_threshold: g.edgeThreshold,
      space: r.space, solver: r.solver,
      weight_formula: 'w=exp(-D^2/(2*sigma^2)), D=||g_p-g_q|| on [0,1], 4-neighbor',
      residual_tolerance: r.stats.residualTolerance,
    },
    input: {
      width: state.depth.width, height: state.depth.height,
      depth_unit: 'mm', missing_value: 0,
      mask_provided: !!state.mask,
    },
    global_stats: r.stats,
    components: r.components.map((c) => ({
      id: c.id,
      anchored: c.anchored,
      solved: c.solved,
      pixel_count: c.size,
      anchor_count: c.anchorCount,
      completed_count: c.completedCount,
      iterations: c.iterations,
      max_abs_normalized_residual: c.maxAbsResidual,
      mean_abs_normalized_residual: c.meanAbsResidual,
      output_depth_mm: c.depthMM,
    })),
  };
  const blob = new TextEncoder().encode(JSON.stringify(payload, null, 2));
  downloadBytes(blob, 'depth_completion_report.json', 'application/json');
});

window.addEventListener('resize', () => { if (state.result) renderAll(); });
