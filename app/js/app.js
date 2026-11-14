/**
 * App shell: wires UI, worker, renderers.
 *
 * Threading contract:
 *  - Parsing, welding, diagnostics and slicing all run in a Web Worker.
 *  - Plane drags are coalesced: at most one slice is in flight, and while it
 *    runs only the newest pending plane is kept. Results older than the newest
 *    issued request are discarded, so the display always converges on the
 *    latest position without a queue of stale frames.
 *  - A failed load never touches the already-loaded mesh: the worker only
 *    replaces its mesh after a fully successful parse, and this module only
 *    swaps render state on a 'loaded' message.
 */

import { OrbitCamera } from './camera.js';
import { Renderer3D, bodyColor } from './render3d.js';
import { SectionCanvas } from './render2d.js';
import { sectionToSvg, sectionToJson, download } from './export.js';
import { dRangeForBBox } from './section.js';

const state = {
  meshMeta: null,
  diagnostics: null,
  componentCount: 0,
  section: null,
  plane: { n: [0, 0, 1], d: 0 },
  sliceInFlight: false,
  pendingSlice: null,
  lastIssuedSlice: 0,
  loadToken: 0,
  sliceToken: 0,
  selfCheckToken: 0,
  samples: [],
  lastSliceMs: 0,
  lastSliceIssuedAt: 0,
  dragPlane: false,
  sliceMode: 'plane-drag',
  hoverLoopId: null,
  selectedLoopId: null,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function setupElements() {
  const ids = [
    'canvas3d', 'canvas2d', 'file-input', 'drop-zone', 'sample-list', 'model-name',
    'model-stats', 'diag-list', 'n-x', 'n-y', 'n-z', 'd-slider', 'd-number',
    'n-scale', 'plane-origin', 'metric-area', 'metric-perimeter', 'metric-loops',
    'metric-holes', 'metric-bodies', 'metric-open', 'loop-table', 'warnings',
    'section-reason', 'btn-fit3d', 'btn-fit2d', 'btn-z-up', 'btn-z-down',
    'btn-x-plane', 'btn-y-plane', 'btn-z-plane', 'btn-iso', 'btn-svg', 'btn-json',
    'btn-clear', 'slice-time', 'hover-info', 'show-grid-2d', 'show-labels-2d',
    'status', 'loading', 'loading-text', 'btn-open-sample', 'btn-toggle-3d',
    'btn-toggle-2d', 'n-normalize-hint', 'd-range-hint', 'n-scale-label',
    'loop-detail', 'body-list', 'toast', 'nav-tab-view', 'nav-tab-data',
    'pane-3d', 'pane-2d', 'data-panel', 'view-panel',
  ];
  for (const id of ids) els[id] = $(id);
}

function toast(message, kind = 'info') {
  const t = els["toast"];
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.className = 'toast'; }, kind === 'error' ? 6000 : 3200);
}

function setStatus(text, kind = '') {
  els["status"].textContent = text;
  els["status"].className = `status ${kind}`;
}

function setLoading(on, text = '载入中…') {
  els["loading"].classList.toggle('show', on);
  if (text) els['loading-text'].textContent = text;
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

let worker = null;
let workerFallback = null; // { parseStl, buildMesh, sliceMesh }

function ensureWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      console.error('worker error', e);
      setLoading(false);
      toast('计算线程异常，已切换到主线程模式', 'error');
      worker = null;
      workerFallback = true;
    };
    return worker;
  } catch (err) {
    workerFallback = true;
    return null;
  }
}

async function loadIntoWorker(arrayBuffer, name, source, token) {
  const w = ensureWorker();
  if (!w) {
    // Fallback path: do the same work synchronously on the main thread.
    const { parseStl } = await import('./stl.js');
    const { buildMesh } = await import('./mesh.js');
    const parsed = parseStl(new Uint8Array(arrayBuffer));
    const built = buildMesh(parsed, { name, source });
    return { type: 'loaded', meta: built.meta, diagnostics: built.diagnostics,
      triangleCount: built.triangleCount, componentCount: built.componentCount,
      triangles: built.renderPositions, components: built.triComponent, fallback: built };
  }
  const id = token;
  return new Promise((resolve) => {
    const handler = (event) => {
      const msg = event.data;
      if (!msg || msg.id !== id || (msg.type !== 'loaded' && msg.type !== 'error')) return;
      w.removeEventListener('message', handler);
      if (msg.type === 'error') resolve({ error: msg });
      else resolve(msg);
    };
    w.addEventListener('message', handler);
    w.postMessage({ type: 'load', id, buffer: arrayBuffer, name, source }, [arrayBuffer]);
  });
}

function requestSlice(n, d) {
  const w = ensureWorker();
  if (!w || !state.meshMeta) return;
  const id = ++state.sliceToken;
  state.lastIssuedSlice = id;
  state.pendingSlice = { id, n: n.slice(), d };
  pumpSlice();
}

function pumpSlice() {
  if (state.sliceInFlight || !state.pendingSlice) return;
  const job = state.pendingSlice;
  state.pendingSlice = null;
  state.sliceInFlight = true;
  state.lastSliceIssuedAt = performance.now();
  const w = ensureWorker();
  if (!w) {
    state.sliceInFlight = false;
    return;
  }
  const onMessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.id !== job.id) return;
    w.removeEventListener('message', onMessage);
    state.sliceInFlight = false;
    if (msg.type === 'sliced') {
      // Discard stale results; only the latest issued request may paint.
      if (job.id === state.lastIssuedSlice) {
        applySection(msg.result, performance.now() - state.lastSliceIssuedAt);
      }
    } else if (msg.type === 'error') {
      toast(`截面计算失败：${msg.message}`, 'error');
      setStatus('截面失败', 'error');
      if (els["section-reason"]) els["section-reason"].textContent = msg.message;
    }
    pumpSlice();
  };
  w.addEventListener('message', onMessage);
  w.postMessage({ type: 'slice', id: job.id, n: job.n, d: job.d });
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'error' && msg.stage === 'load') {
    setLoading(false);
    showLoadError(msg);
  }
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

async function loadFile(file) {
  if (!file) return;
  setLoading(true, `读取 ${file.name}…`);
  setStatus('解析中…');
  try {
    const buffer = await file.arrayBuffer();
    await loadBuffer(buffer, file.name, 'upload');
  } catch (err) {
    setLoading(false);
    toast(`读取失败：${err.message}`, 'error');
    setStatus('读取失败', 'error');
  }
}

async function loadBuffer(arrayBuffer, name, source, sampleLabel = null) {
  const token = ++state.loadToken;
  setLoading(true, `解析 ${name}…`);
  setStatus('解析中…');
  try {
    const res = await loadIntoWorker(arrayBuffer, name, source, token);
    if (token !== state.loadToken) return; // superseded
    if (res.error) {
      setLoading(false);
      showLoadError(res.error);
      return;
    }
    // Commit: only now is the old model replaced.
    state.meshMeta = res.meta;
    state.diagnostics = res.diagnostics;
    state.componentCount = res.componentCount;
    const meshForRender = {
      meta: res.meta,
      diagnostics: res.diagnostics,
      triangleCount: res.triangleCount,
      renderPositions: res.triangles,
      triComponent: res.components,
      componentCount: res.componentCount,
    };
    renderer3d.setMesh(meshForRender);
    camera.fit(res.meta.bbox, els["canvas3d"].clientWidth / Math.max(1, els["canvas3d"].clientHeight));
    renderer3d.draw();

    // Plane setup: default axial slice through the middle of the model.
    const bbox = res.meta.bbox;
    const mid = (bbox.min[2] + bbox.max[2]) / 2;
    setPlane([0, 0, 1], mid, { silent: true });
    configurePlaneRange([0, 0, 1]);

    renderModelInfo(res.meta, res.diagnostics, res.componentCount, sampleLabel);
    updateExportButtons();
    els['drop-zone'].classList.add('hidden');
    setLoading(false);
    setStatus('就绪', 'ok');
    state.section = null;
    renderer3d.setSection(null);
    canvas2d.setSection(null);
    canvas2d.draw();
    els["section-reason"].textContent = '拖动 d 滑块或输入数值以生成截面';
    renderMetrics(null);
    // First slice right away.
    requestSlice(state.plane.n, state.plane.d);
  } catch (err) {
    setLoading(false);
    showLoadError({ message: err.message, code: 'internal' });
  }
}

function showLoadError(msg) {
  const text = msg.message || '未知错误';
  // Deliberately keeps the previous model loaded and rendered.
  setStatus('载入失败', 'error');
  toast(`文件载入失败：${text}`, 'error');
  if (els["warnings"]) {
    const div = document.createElement('div');
    div.className = 'warning error';
    div.textContent = `载入失败：${text}`;
    els["warnings"].prepend(div);
  }
  if (state.meshMeta) {
    els["status"].textContent = '载入失败（已保留上一个模型）';
  }
}

function renderModelInfo(meta, diag, components, sampleLabel) {
  els['model-name'].textContent = meta.name;
  els['model-stats'].innerHTML = [
    `<span>${meta.format === 'ascii' ? 'ASCII STL' : '二进制 STL'}</span>`,
    `<span>${meta.triangleCount.toLocaleString()} 三角面</span>`,
    `<span>${meta.weldedVertexCount.toLocaleString()} 顶点</span>`,
    `<span>${components.toLocaleString()} 个部件</span>`,
    `<span>尺寸 ${fmtLen(meta.extent[0])} × ${fmtLen(meta.extent[1])} × ${fmtLen(meta.extent[2])} mm</span>`,
  ].join('');
  if (sampleLabel) els['model-name'].dataset.sample = sampleLabel;

  const list = els['diag-list'];
  list.innerHTML = '';
  const add = (text, kind) => {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    list.appendChild(li);
  };
  if (diag.closed) {
    add('拓扑闭合（流形、无边界边）', 'ok');
  } else {
    if (diag.openEdges > 0) add(`开口：${diag.openEdges} 条边界边`, 'warn');
    if (diag.nonManifoldEdges > 0) add(`非流形：${diag.nonManifoldEdges} 条边被 3+ 面共用`, 'warn');
    if (diag.inconsistentEdges > 0) add(`绕序不一致：${diag.inconsistentEdges} 条共享边`, 'warn');
  }
  if (diag.degenerateTriangles > 0) add(`退化三角面：${diag.degenerateTriangles}`, 'warn');
  if (diag.orientationFlipped) add('整体绕序已翻转统一', 'info');
  if (meta.warnings.length) {
    for (const wMsg of meta.warnings) add(wMsg, 'info');
  }

  els["warnings"].innerHTML = '';
  for (const wMsg of meta.warnings) {
    const div = document.createElement('div');
    div.className = 'warning';
    div.textContent = wMsg;
    els["warnings"].appendChild(div);
  }
}

function fmtLen(v) {
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toFixed(2) + ' m';
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// ---------------------------------------------------------------------------
// Plane handling
// ---------------------------------------------------------------------------

function planeScale() {
  const s = parseFloat(els['n-scale'].value);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function readPlaneInputs() {
  const nx = parseFloat(els['n-x'].value);
  const ny = parseFloat(els['n-y'].value);
  const nz = parseFloat(els['n-z'].value);
  const scale = planeScale();
  if (![nx, ny, nz].every(Number.isFinite)) return null;
  if (nx === 0 && ny === 0 && nz === 0) return null;
  return { n: [nx * scale, ny * scale, nz * scale] };
}

function configurePlaneRange(n) {
  if (!state.meshMeta) return null;
  // The slider works in true signed distance along the unit normal (mm); the
  // number input stays the raw constant d of n·p = d.
  const [lo, hi] = dRangeForBBox(state.meshMeta.bbox, n);
  const span = Math.max(hi - lo, 1e-6);
  const step = span / 4000;
  els['d-slider'].min = String(lo - span * 0.02);
  els['d-slider'].max = String(hi + span * 0.02);
  els['d-slider'].step = String(step);
  els['d-number'].step = 'any';
  els['d-range-hint'].textContent =
    `沿法线位置范围 ${lo.toFixed(3)} … ${hi.toFixed(3)} mm`;
  return [lo, hi];
}

function planeNormalLength() {
  return planeNormalLengthFrom(state.plane.n);
}

function planeNormalLengthFrom(n) {
  return Math.hypot(n[0], n[1], n[2]) || 1;
}

/** Set the plane by raw n and raw d (n·p = d). */
function setPlane(n, d, { silent = false, updateInputs = true, preserveSlider = true } = {}) {
  state.plane = { n: n.slice(), d };
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  if (updateInputs) {
    if (document.activeElement !== els['n-x']) els['n-x'].value = String(round6(n[0] / planeScale()));
    if (document.activeElement !== els['n-y']) els['n-y'].value = String(round6(n[1] / planeScale()));
    if (document.activeElement !== els['n-z']) els['n-z'].value = String(round6(n[2] / planeScale()));
    if (document.activeElement !== els['d-number']) els['d-number'].value = String(round6(d));
    if (preserveSlider && document.activeElement !== els['d-slider']) {
      els['d-slider'].value = String(d / len);
    }
  }
  if (!silent) {
    requestSlice(state.plane.n, state.plane.d);
    updatePlaneReadout();
  }
}

function updatePlaneReadout() {
  const n = state.plane.n;
  const len = planeNormalLength();
  const nu = [n[0] / len, n[1] / len, n[2] / len];
  const dNorm = state.plane.d / len;
  const o = [nu[0] * dNorm, nu[1] * dNorm, nu[2] * dNorm];
  els['plane-origin'].textContent =
    `n·p = d：n = (${n.map((x) => round6(x)).join(', ')})，d = ${round6(state.plane.d)}；` +
    `等价的单位式 n̂·p = d̂：d̂ = ${round6(dNorm)} mm；平面上一点 (${o.map((x) => round6(x)).join(', ')}) mm`;
}

function round6(x) {
  if (!Number.isFinite(x)) return '0';
  const r = Math.round(x * 1e6) / 1e6;
  return String(r);
}

// ---------------------------------------------------------------------------
// Section application and UI update
// ---------------------------------------------------------------------------

function applySection(section, wallMs) {
  state.section = section;
  state.lastSliceMs = section.elapsedMs;
  renderer3d.setSection(section);
  renderer3d.draw();
  canvas2d.setSection(section);
  canvas2d.draw();
  renderMetrics(section);
  renderLoopTable(section);
  renderBodies(section);
  updateExportButtons();
  updatePlaneReadout();
  els['slice-time'].textContent =
    `计算 ${section.elapsedMs.toFixed(1)} ms · 往返 ${wallMs.toFixed(0)} ms`;
  if (section.empty) {
    els["section-reason"].textContent = section.reason || '该平面无截面';
    els["section-reason"].className = 'section-reason';
  } else {
    // Always show which limit was measured: a glance should be enough to know
    // the plane and the section's composition.
    const m = section.measurements;
    const nu = section.plane.nUnit;
    els["section-reason"].textContent =
      `n̂=(${nu.map((x) => round6(x)).join(', ')}) · d̂=${round6(section.plane.dNormalized)} mm` +
      ` · ${m.loopCount} 环 / ${m.holeCount} 孔 / ${m.bodyCount} 部件` +
      (m.openChainCount ? ` / ${m.openChainCount} 开口` : '');
    els["section-reason"].className = m.openChainCount ? 'section-reason alert' : 'section-reason';
  }
  const warnings = [];
  if (section.warnings) warnings.push(...section.warnings);
  renderSectionWarnings(warnings);
  if (section.empty) setStatus('无截面', 'warn');
  else setStatus('就绪', 'ok');
}

function renderSectionWarnings(warnings) {
  const existing = els["warnings"].querySelectorAll('.warning.section-warning');
  existing.forEach((n) => n.remove());
  for (const wMsg of warnings) {
    const div = document.createElement('div');
    div.className = 'warning section-warning';
    div.textContent = wMsg;
    els["warnings"].appendChild(div);
  }
}

function fmtArea(mm2) {
  if (!Number.isFinite(mm2)) return '—';
  const a = Math.abs(mm2);
  if (a >= 1e6) return (mm2 / 1e6).toFixed(3) + ' m²';
  if (a >= 1e4) return (mm2 / 100).toFixed(2) + ' cm²';
  return mm2.toFixed(2) + ' mm²';
}

function fmtPerim(mm) {
  if (!Number.isFinite(mm)) return '—';
  const a = Math.abs(mm);
  if (a >= 1e4) return (mm / 1000).toFixed(3) + ' m';
  if (a >= 1000) return (mm / 10).toFixed(2) + ' cm';
  return mm.toFixed(2) + ' mm';
}

function renderMetrics(section) {
  const m = section ? section.measurements : null;
  els['metric-area'].textContent = m ? fmtArea(m.area_mm2) : '—';
  els['metric-area'].title = m ? `${m.area_mm2} mm²` : '';
  els['metric-perimeter'].textContent = m ? fmtPerim(m.perimeter_mm) : '—';
  els['metric-perimeter'].title = m ? `${m.perimeter_mm} mm` : '';
  els['metric-loops'].textContent = m ? m.loopCount : '—';
  els['metric-holes'].textContent = m ? m.holeCount : '—';
  els['metric-bodies'].textContent = m ? m.bodyCount : '—';
  els['metric-open'].textContent = m ? m.openChainCount : '—';
  els['metric-open'].classList.toggle('alert', !!(m && m.openChainCount > 0));
}

function renderLoopTable(section) {
  const body = els['loop-table'];
  body.innerHTML = '';
  if (!section || section.empty) {
    els['loop-detail'].textContent = '';
    return;
  }
  for (const loop of section.loops) {
    const tr = document.createElement('tr');
    tr.dataset.loopId = String(loop.id);
    const kindText = loop.kind === 'solid' ? '实体' : loop.kind === 'hole' ? '孔洞' : '开口';
    const area = loop.area_mm2 == null ? '—' : loop.area_mm2.toFixed(3);
    tr.innerHTML =
      `<td><span class="pill ${loop.kind}">${kindText}</span></td>` +
      `<td class="num">${loop.bodyId == null ? '—' : loop.bodyId + 1}</td>` +
      `<td class="num">${area}</td>` +
      `<td class="num">${loop.perimeter_mm.toFixed(3)}</td>` +
      `<td class="num">${loop.points2d.length}</td>`;
    tr.addEventListener('mouseenter', () => {
      state.hoverLoopId = loop.id;
      canvas2d.hoverLoop = loop.id;
      canvas2d.draw();
      updateHoverInfo(loop);
    });
    tr.addEventListener('mouseleave', () => {
      state.hoverLoopId = null;
      canvas2d.hoverLoop = null;
      canvas2d.draw();
      updateHoverInfo(null);
    });
    tr.addEventListener('click', () => selectLoop(loop.id));
    body.appendChild(tr);
  }
}

function renderBodies(section) {
  const box = els['body-list'];
  box.innerHTML = '';
  if (!section || section.empty) return;
  for (const b of section.bodies) {
    const div = document.createElement('button');
    div.className = 'body-chip';
    const col = bodyColor(b.id);
    div.style.setProperty('--chip', `rgb(${col.base.join(',')})`);
    div.innerHTML =
      `<span class="swatch"></span><span class="label">部件 ${b.id + 1}</span>` +
      `<span class="val">${fmtArea(b.area_mm2)}</span>` +
      `<span class="sub">${b.loopCount} 环 · ${b.holeCount} 孔</span>`;
    div.addEventListener('click', () => {
      // Focus the first loop of this body.
      const loop = section.loops.find((l) => l.bodyId === b.id && l.kind === 'solid');
      if (loop) selectLoop(loop.id);
    });
    box.appendChild(div);
  }
}

function selectLoop(id) {
  state.selectedLoopId = id;
  canvas2d.selectedLoop = id;
  canvas2d.draw();
  const loop = state.section && state.section.loops.find((l) => l.id === id);
  updateHoverInfo(loop);
  for (const tr of els['loop-table'].querySelectorAll('tr')) {
    tr.classList.toggle('selected', Number(tr.dataset.loopId) === id);
  }
}

function updateHoverInfo(loop) {
  const el = els['hover-info'];
  if (!loop) {
    el.innerHTML = '<span class="muted">悬停二维图或表格查看边界详情</span>';
    return;
  }
  const kindText = loop.kind === 'solid' ? '实体外环' : loop.kind === 'hole' ? '孔洞边界' : '开放边界';
  const centroid = loop.points2d.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  const cx = centroid[0] / loop.points2d.length;
  const cy = centroid[1] / loop.points2d.length;
  el.innerHTML =
    `<strong>${kindText}</strong> · 环 ${loop.id + 1}` +
    (loop.bodyId != null ? ` · 部件 ${loop.bodyId + 1}` : '') +
    (loop.kind === 'hole' && loop.ownerBodyId != null ? ` · 归属部件 ${loop.ownerBodyId + 1}` : '') +
    `<br><span class="muted">面积 ${loop.area_mm2 == null ? '未知' : loop.area_mm2.toFixed(4) + ' mm²'} · ` +
    `周长 ${loop.perimeter_mm.toFixed(4)} mm · ${loop.points2d.length} 点` +
    ` · 形心 (${cx.toFixed(2)}, ${cy.toFixed(2)}) mm</span>`;
}

// ---------------------------------------------------------------------------
// Interaction wiring
// ---------------------------------------------------------------------------

function setupInteraction() {
  const cam = camera;
  let drag = null;

  els["canvas3d"].addEventListener('pointerdown', (e) => {
    els["canvas3d"].setPointerCapture(e.pointerId);
    const mode = e.shiftKey || e.button === 1 || e.button === 2
      ? 'pan'
      : (e.altKey ? 'plane' : 'rotate');
    drag = { mode, x: e.clientX, y: e.clientY, lastY: e.clientY };
    if (mode === 'plane' && state.meshMeta) {
      // Dragging up moves the cut along +n, dragging down against it. The
      // scale is millimetres per pixel at the orbit distance, so the plane
      // tracks the pointer at roughly 1:1 for the current view.
      const focal = els["canvas3d"].clientHeight / 2 /
        Math.tan((cam.fovDeg * Math.PI) / 360);
      drag.mmPerPx = cam.distance / focal;
      drag.d0 = state.plane.d / planeNormalLength();
      drag.dragged = false;
    }
  });
  els["canvas3d"].addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.mode === 'rotate') {
      cam.rotate(dx, dy);
      renderer3d.draw();
    } else if (drag.mode === 'pan') {
      cam.pan(dx, dy, els["canvas3d"].clientHeight);
      renderer3d.draw();
    } else if (drag.mode === 'plane') {
      drag.dragged = true;
      const n = state.plane.n;
      const len = planeNormalLength();
      // Screen y grows downward; pulling up should advance along +n.
      const dNorm = drag.d0 - (e.clientY - drag.lastY) * drag.mmPerPx;
      drag.lastY = e.clientY;
      const [lo, hi] = dRangeForBBox(state.meshMeta.bbox, n);
      const pad = (hi - lo) * 0.05;
      const clamped = Math.min(Math.max(dNorm, lo - pad), hi + pad);
      setPlane(n, clamped * len, { updateInputs: true, preserveSlider: false });
      els['d-slider'].value = String(clamped);
    }
  });
  const end3d = () => { drag = null; };
  els["canvas3d"].addEventListener('pointerup', end3d);
  els["canvas3d"].addEventListener('pointercancel', end3d);
  els["canvas3d"].addEventListener('contextmenu', (e) => e.preventDefault());
  els["canvas3d"].addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.zoom(Math.exp(-e.deltaY * 0.0015));
    renderer3d.draw();
  }, { passive: false });

  // 2-D pan/zoom and hover.
  let drag2 = null;
  els["canvas2d"].addEventListener('pointerdown', (e) => {
    els["canvas2d"].setPointerCapture(e.pointerId);
    drag2 = { x: e.clientX, y: e.clientY, moved: 0 };
  });
  els["canvas2d"].addEventListener('pointermove', (e) => {
    const rect = els["canvas2d"].getBoundingClientRect();
    if (drag2) {
      const dx = e.clientX - drag2.x;
      const dy = e.clientY - drag2.y;
      drag2.x = e.clientX;
      drag2.y = e.clientY;
      drag2.moved += Math.abs(dx) + Math.abs(dy);
      if (drag2.moved > 4) {
        canvas2d.view.pan(dx, dy);
        canvas2d.draw();
      }
      return;
    }
    const loop = canvas2d.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    const nextId = loop ? loop.id : null;
    if (canvas2d.hoverLoop !== nextId) {
      canvas2d.hoverLoop = nextId;
      canvas2d.draw();
    }
    if (loop) updateHoverInfo(loop);
  });
  els["canvas2d"].addEventListener('pointerup', (e) => {
    const rect = els["canvas2d"].getBoundingClientRect();
    if (drag2 && drag2.moved <= 4) {
      const loop = canvas2d.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (loop) selectLoop(loop.id);
      else {
        state.selectedLoopId = null;
        canvas2d.selectedLoop = null;
        canvas2d.draw();
        updateHoverInfo(null);
      }
    }
    drag2 = null;
  });
  els["canvas2d"].addEventListener('pointerleave', () => {
    if (!drag2) {
      canvas2d.hoverLoop = null;
      canvas2d.draw();
    }
  });
  els["canvas2d"].addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = els["canvas2d"].getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0018);
    canvas2d.view.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top,
      canvas2d.width, canvas2d.height);
    canvas2d.draw();
  }, { passive: false });

  // Plane inputs.
  for (const id of ['n-x', 'n-y', 'n-z']) {
    els[id].addEventListener('input', onNormalInput);
  }
  els['n-scale'].addEventListener('input', onNormalInput);
  els['d-slider'].addEventListener('input', () => {
    const dist = parseFloat(els['d-slider'].value);
    const p = readPlaneInputs();
    if (!Number.isFinite(dist) || !p) return;
    const len = planeNormalLengthFrom(p.n);
    // The slider is true signed distance d̂ in mm; the raw constant is d = d̂·|n|.
    state.plane = { n: p.n, d: dist * len };
    els['d-number'].value = String(round6(dist * len));
    els['d-slider'].value = String(dist);
    requestSlice(state.plane.n, state.plane.d);
    updatePlaneReadout();
  });
  els['d-number'].addEventListener('input', () => {
    const d = parseFloat(els['d-number'].value);
    const p = readPlaneInputs();
    if (!Number.isFinite(d) || !p) return;
    const len = planeNormalLengthFrom(p.n);
    state.plane = { n: p.n, d };
    els['d-slider'].value = String(d / len);
    requestSlice(state.plane.n, state.plane.d);
    updatePlaneReadout();
  });

  els['btn-z-up'].addEventListener('click', () => setPreset([0, 0, 1], 0.5));
  els['btn-z-down'].addEventListener('click', () => setPreset([0, 0, -1], 0.5));
  els['btn-x-plane'].addEventListener('click', () => setPreset([1, 0, 0], 0.5));
  els['btn-y-plane'].addEventListener('click', () => setPreset([0, 1, 0], 0.5));
  els['btn-z-plane'].addEventListener('click', () => setPreset([0, 0, 1], 0.5));
  els['btn-iso'].addEventListener('click', () => setPreset([1, 1, 1], 0.5));

  els['btn-fit3d'].addEventListener('click', () => {
    if (!state.meshMeta) return;
    cam.fit(state.meshMeta.bbox, els["canvas3d"].clientWidth / Math.max(1, els["canvas3d"].clientHeight));
    renderer3d.draw();
  });
  els['btn-fit2d'].addEventListener('click', () => {
    canvas2d.requestFit();
    canvas2d.setSection(state.section);
    canvas2d.draw();
  });
  els['show-grid-2d'].addEventListener('change', () => {
    canvas2d.showGrid = els['show-grid-2d'].checked;
    canvas2d.draw();
  });
  els['show-labels-2d'].addEventListener('change', () => {
    canvas2d.showLabels = els['show-labels-2d'].checked;
    canvas2d.draw();
  });

  els['btn-svg'].addEventListener('click', () => {
    if (!state.section || state.section.empty) return toast('当前没有截面可导出', 'warn');
    const label = `${baseName(state.meshMeta.name)}_section`;
    const svg = sectionToSvg(state.section, { label });
    if (!svg) return toast('导出失败：截面为空', 'warn');
    download(`${label}.svg`, svg, 'image/svg+xml');
  });
  els['btn-json'].addEventListener('click', () => {
    if (!state.meshMeta) return toast('尚未载入模型', 'warn');
    if (!state.section) return toast('当前没有截面可导出', 'warn');
    const report = sectionToJson(
      state.section,
      state.meshMeta,
      { diagnostics: state.diagnostics },
    );
    download(`${baseName(state.meshMeta.name)}_section.json`, JSON.stringify(report, null, 2), 'application/json');
  });

  els['btn-clear'].addEventListener('click', () => {
    if (worker) worker.postMessage({ type: 'clear' });
    state.meshMeta = null;
    state.section = null;
    state.diagnostics = null;
    renderer3d.setMesh(null);
    renderer3d.setSection(null);
    renderer3d.draw();
    canvas2d.setSection(null);
    canvas2d.draw();
    renderMetrics(null);
    els['loop-table'].innerHTML = '';
    els['body-list'].innerHTML = '';
    els['warnings'].innerHTML = '';
    els['diag-list'].innerHTML = '';
    els['model-name'].textContent = '未载入模型';
    els['model-stats'].innerHTML = '';
    els['drop-zone'].classList.remove('hidden');
    els['section-reason'].textContent = '';
    updateExportButtons();
    setStatus('等待模型');
    els['hover-info'].innerHTML = '<span class="muted">悬停二维图或表格查看边界详情</span>';
  });

  // File input and drag/drop.
  els['file-input'].addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) {
      handleFiles([...files]);
      e.target.value = '';
    }
  });
  const zone = els['drop-zone'];
  for (const area of [document.body, zone]) {
    area.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    area.addEventListener('dragleave', (e) => {
      if (e.target === document.body || e.target === zone) zone.classList.remove('dragover');
    });
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFiles([...files]);
    });
  }
  els['btn-open-sample'].addEventListener('click', () => els['file-input'].click());

  // Sample list.
  els['sample-list'].addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-url]');
    if (!btn) return;
    const url = btn.dataset.url;
    const name = btn.dataset.name;
    setLoading(true, `载入示例 ${name}…`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      await loadBuffer(buf, name, 'sample', name);
    } catch (err) {
      setLoading(false);
      toast(`示例载入失败：${err.message}`, 'error');
    }
  });

  // Tabs.
  els['nav-tab-view'].addEventListener('click', () => setTab('view'));
  els['nav-tab-data'].addEventListener('click', () => setTab('data'));

  // Keyboard: arrow keys nudge the plane d.
  window.addEventListener('keydown', (e) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = parseFloat(els['d-slider'].step) * 20 || 0.1;
      const delta = e.key === 'ArrowUp' ? step : -step;
      const p = readPlaneInputs();
      if (!p) return;
      const len = planeNormalLengthFrom(p.n);
      setPlane(p.n, state.plane.d + delta * len);
      els['d-slider'].value = String((state.plane.d) / len);
      e.preventDefault();
    }
  });

  window.addEventListener('resize', () => {
    renderer3d.draw();
    canvas2d.draw();
  });
}

function setPreset(n, fraction) {
  if (!state.meshMeta) return;
  const [lo, hi] = configurePlaneRange(n) || [0, 0];
  const dist = lo + (hi - lo) * fraction;
  els['n-x'].value = String(n[0]);
  els['n-y'].value = String(n[1]);
  els['n-z'].value = String(n[2]);
  els['n-scale'].value = '1';
  const len = planeNormalLengthFrom(n);
  setPlane(n, dist * len, { updateInputs: true });
  els['d-slider'].value = String(dist);
}

function onNormalInput() {
  const p = readPlaneInputs();
  if (!p) {
    els['n-normalize-hint'].textContent = '法线不能为零向量';
    return;
  }
  const [lo, hi] = configurePlaneRange(p.n) || [0, 0];
  const len = planeNormalLengthFrom(p.n);
  // Preserve the geometric plane: keep the same signed distance d̂ along the
  // unit normal, which means the raw constant scales with |n|.
  const dNorm = state.plane.d / planeNormalLength();
  const clamped = Math.min(Math.max(dNorm, lo), hi);
  els['n-normalize-hint'].textContent =
    `n 可按任意长度输入，截面只用方向；当前 |n| = ${len.toFixed(3)}，等价单位法线 (${p.n.map((x) => round6(x / len)).join(', ')})`;
  setPlane(p.n, clamped * len);
  els['d-slider'].value = String(clamped);
}

function setTab(tab) {
  const view = tab === 'view';
  els['nav-tab-view'].classList.toggle('active', view);
  els['nav-tab-data'].classList.toggle('active', !view);
  els['view-panel'].classList.toggle('hidden', !view);
  els['data-panel'].classList.toggle('hidden', view);
  if (view) {
    requestAnimationFrame(() => {
      renderer3d.draw();
      canvas2d.draw();
    });
  }
}

function handleFiles(files) {
  const stl = files.find((f) => /\.stl$/i.test(f.name));
  if (!stl) {
    toast('请选择 .stl 文件', 'warn');
    return;
  }
  loadFile(stl);
}

function baseName(name) {
  return name.replace(/\.stl$/i, '') || 'model';
}

function updateExportButtons() {
  const has = !!(state.section && !state.section.empty);
  els['btn-svg'].disabled = !has;
  els['btn-json'].disabled = !has;
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

async function loadSampleList() {
  try {
    const res = await fetch('/api/samples');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.samples = data.samples || [];
  } catch {
    state.samples = [];
  }
  const list = els['sample-list'];
  list.innerHTML = '';
  if (state.samples.length === 0) {
    const p = document.createElement('div');
    p.className = 'muted small';
    p.textContent = '无示例（可直接拖入 STL）';
    list.appendChild(p);
    return;
  }
  for (const s of state.samples) {
    const btn = document.createElement('button');
    btn.className = 'sample-btn';
    btn.dataset.url = s.url;
    btn.dataset.name = s.name;
    const kb = s.size > 1024 * 1024 ? `${(s.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(s.size / 1024)} KB`;
    btn.innerHTML = `<span class="sample-name">${s.name}</span><span class="sample-size">${kb}</span>`;
    btn.title = s.expected && s.expected.length
      ? `参考值：${s.expected.map((e) => `n=${JSON.stringify(e.n)} d=${e.d}`).join(', ')}`
      : '载入此示例';
    list.appendChild(btn);
  }
  // Validate fixture reference values live against the engine.
  runSampleSelfCheck();
}

async function runSampleSelfCheck() {
  const entry = document.getElementById('self-check');
  if (!entry) return;
  entry.innerHTML = '<span class="muted small">参考值自检中…</span>';
  // Run the self-check in the worker (same code path the UI uses) so a large
  // fixture does not stall the page, and so a slow disk does not freeze it.
  const w = ensureWorker();
  if (!w) {
    entry.innerHTML = '<span class="muted small">自检需要计算线程</span>';
    return;
  }
  const jobs = [];
  for (const s of state.samples) {
    for (const exp of s.expected || []) jobs.push({ file: s.name, url: s.url, exp });
  }
  if (jobs.length === 0) {
    entry.innerHTML = '<span class="muted small">示例不含参考值</span>';
    return;
  }
  // Fetch the fixtures on the main thread (the worker has no network access
  // under module workers in every browser), then hand the bytes over.
  const jobsWithBytes = [];
  const cache = new Map();
  try {
    for (const job of jobs) {
      let buf = cache.get(job.url);
      if (!buf) {
        const res = await fetch(job.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = await res.arrayBuffer();
        cache.set(job.url, buf);
      }
      // Structured-clone a copy so one buffer can serve several reference rows.
      jobsWithBytes.push({ file: job.file, url: job.url, expect: job.exp, buffer: buf.slice(0) });
    }
  } catch (err) {
    entry.innerHTML = `<span class="muted small">自检无法读取示例：${escapeHtml(err.message)}</span>`;
    return;
  }
  const id = ++state.selfCheckToken;
  const onMessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'selfcheck' || msg.id !== id) return;
    w.removeEventListener('message', onMessage);
    const results = msg.results;
    const failed = results.filter((r) => !r.ok);
    const pass = results.length - failed.length;
    entry.innerHTML =
      `<div class="self-check-summary ${failed.length ? 'fail' : 'pass'}">` +
      `参考值自检：${pass}/${results.length} 通过</div>` +
      (failed.length
        ? `<ul class="self-check-fail">${failed
            .map((f) => `<li>${escapeHtml(f.file)} n=${escapeHtml(JSON.stringify(f.n))} d=${f.d}` +
              (f.error ? ` — ${escapeHtml(f.error)}` : `：环 ${f.got.loopCount}/${f.expect.loops} 孔 ${f.got.holeCount}/${f.expect.holes} 面积 ${f.got.area_mm2.toFixed(4)}/${f.expect.area_mm2}`) +
              '</li>')
            .join('')}</ul>`
        : '');
  };
  w.addEventListener('message', onMessage);
  w.postMessage({ type: 'selfcheck', id, jobs: jobsWithBytes });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let camera;
let renderer3d;
let canvas2d;

function boot() {
  setupElements();
  camera = new OrbitCamera();
  renderer3d = new Renderer3D(els["canvas3d"], camera);
  canvas2d = new SectionCanvas(els["canvas2d"]);
  setupInteraction();
  renderer3d.draw();
  canvas2d.draw();
  updateExportButtons();
  els['hover-info'].innerHTML = '<span class="muted">悬停二维图或表格查看边界详情</span>';
  setStatus('等待模型');
  loadSampleList();
  // Resize observer keeps canvases exact when layout changes.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      renderer3d.draw();
      canvas2d.draw();
    });
    ro.observe(els["canvas3d"]);
    ro.observe(els["canvas2d"]);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
