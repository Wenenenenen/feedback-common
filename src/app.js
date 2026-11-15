import { importSequenceZip, importBackgroundPng } from './sequence.js';
import { exportZip } from './export.js';
import { createState, DEFAULT_PARAMS, invalidateCaches, recomputeCurrent, getBackground,
         addPolygon, deleteSelected, selectedPolygon, polygonList } from './state.js';
import { renderFrame, applyTransform, fitScale, eventToImage, hitTest } from './renderer.js';

const state = createState();
const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const viewport = $('viewport');

// ----- utilities -------------------------------------------------------------

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function setBusy(on) { $('busy').classList.toggle('hidden', !on); }

function refresh() {
  recomputeCurrent(state);
  renderFrame(canvas, ctx, state);
  applyTransform(canvas, viewport, state);
  updatePolyList();
  updateFrameLabel();
}

function updateFrameLabel() {
  const n = state.frames.length;
  $('frameLabel').textContent = n ? `${state.currentFrame + 1} / ${n}（帧号 ${state.frames[state.currentFrame].number}）` : '— / —';
  $('scrub').max = Math.max(0, n - 1);
  $('scrub').value = state.currentFrame;
}

function updateZoomLabel() {
  const base = fitScale(viewport.clientWidth, viewport.clientHeight, state.width, state.height);
  $('zoomLabel').textContent = Math.round(base * state.zoom * 100) + '%';
}

// ----- import ----------------------------------------------------------------

async function handleZipFile(file) {
  setBusy(true);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const imported = await importSequenceZip(buf);
    state.frames = imported.frames;
    state.width = imported.width;
    state.height = imported.height;
    state.currentFrame = 0;
    state.params = structuredClone(DEFAULT_PARAMS);
    state.background = null;
    state.selected = null;
    state.drawing = null;
    state.zoom = 1; state.panX = 0; state.panY = 0;
    invalidateCaches(state);
    syncParamControls();
    $('dropHint').classList.add('hidden');
    $('exportBtn').disabled = false;
    $('presetBtn').disabled = false;
    $('playBtn').disabled = false;
    $('stopBtn').disabled = false;
    $('scrub').disabled = false;
    $('infoStatus').textContent = '已导入';
    $('infoFrames').textContent = `${imported.frames.length} 帧`;
    $('infoSize').textContent = `${imported.width}×${imported.height}`;
    $('bgStatus').textContent = '';
    refresh();
    updateZoomLabel();
    toast(`已导入 ${imported.frames.length} 帧（${imported.width}×${imported.height}）`);
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    setBusy(false);
  }
}

$('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) handleZipFile(e.target.files[0]);
  e.target.value = '';
});

// drag & drop
['dragenter', 'dragover'].forEach(t => viewport.addEventListener(t, e => {
  e.preventDefault();
  viewport.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(t => viewport.addEventListener(t, e => {
  e.preventDefault();
  viewport.classList.remove('dragover');
}));
viewport.addEventListener('drop', async e => {
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.zip')) await handleZipFile(file);
  else toast('请拖入 ZIP 文件', true);
});

// ----- custom background -----------------------------------------------------

$('bgInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.frames.length) return;
  try {
    const img = await importBackgroundPng(new Uint8Array(await file.arrayBuffer()), state.width, state.height);
    state.background = { rgb: img.rgb };
    invalidateCaches(state);
    $('bgStatus').textContent = file.name;
    setView('custom');
    refresh();
    toast('背景 PNG 已加载');
  } catch (err) {
    toast(err.message, true);
  }
});

// ----- key color picking -----------------------------------------------------

let picking = false;
$('pickKeyBtn').addEventListener('click', () => {
  if (!state.frames.length) return;
  picking = !picking;
  $('pickKeyBtn').classList.toggle('active', picking);
  canvas.style.cursor = picking ? 'crosshair' : '';
});

// Average a small 3x3 neighborhood to avoid single-pixel noise.
function sampleColor(frame, x, y) {
  const { rgb, width, height } = frame;
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const px = Math.min(width - 1, Math.max(0, x + dx));
    const py = Math.min(height - 1, Math.max(0, y + dy));
    const i = (py * width + px) * 3;
    r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// ----- canvas pointer interactions ------------------------------------------

let panning = null;

canvas.addEventListener('mousedown', e => {
  if (!state.frames.length) return;
  const [ix, iy] = eventToImage(e, canvas, state);
  const cx = Math.min(state.width - 1, Math.max(0, Math.floor(ix)));
  const cy = Math.min(state.height - 1, Math.max(0, Math.floor(iy)));

  if (picking) {
    const color = sampleColor(state.frames[state.currentFrame], cx, cy);
    state.params.keyColor = color;
    $('keyColor').value = '#' + color.map(v => v.toString(16).padStart(2, '0')).join('');
    picking = false;
    $('pickKeyBtn').classList.remove('active');
    canvas.style.cursor = '';
    invalidateCaches(state);
    refresh();
    return;
  }

  if (state.tool === 'protect' || state.tool === 'remove') {
    if (!state.drawing) state.drawing = { kind: state.tool, points: [[cx, cy]] };
    else state.drawing.points.push([cx, cy]);
    renderFrame(canvas, ctx, state);
    return;
  }

  // edit tool
  const hit = hitTest(state, ix, iy, canvas);
  if (hit?.type === 'vertex') {
    state.vertexDrag = hit;
    return;
  }
  if (hit?.type === 'body') {
    state.selected = { kind: hit.kind, index: hit.index };
    updatePolyList();
    renderFrame(canvas, ctx, state);
    panning = { startX: e.clientX, startY: e.clientY, panX: state.panX, panY: state.panY, moved: false };
    return;
  }
  state.selected = null;
  updatePolyList();
  renderFrame(canvas, ctx, state);
  panning = { startX: e.clientX, startY: e.clientY, panX: state.panX, panY: state.panY, moved: false };
});

window.addEventListener('mousemove', e => {
  if (state.vertexDrag) {
    const [ix, iy] = eventToImage(e, canvas, state);
    const v = state.vertexDrag;
    const list = v.kind === 'protect' ? state.params.protectPolygons : state.params.removePolygons;
    list[v.index][v.vertex] = [
      Math.min(state.width - 1, Math.max(0, Math.round(ix))),
      Math.min(state.height - 1, Math.max(0, Math.round(iy))),
    ];
    invalidateCaches(state);
    refresh();
    return;
  }
  if (panning) {
    const dx = e.clientX - panning.startX, dy = e.clientY - panning.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) panning.moved = true;
    state.panX = panning.panX + dx;
    state.panY = panning.panY + dy;
    applyTransform(canvas, viewport, state);
  }
});

window.addEventListener('mouseup', () => {
  state.vertexDrag = null;
  panning = null;
});

canvas.addEventListener('dblclick', e => {
  if (state.drawing) finishDrawing();
  else { state.zoom = 1; state.panX = 0; state.panY = 0; applyTransform(canvas, viewport, state); updateZoomLabel(); }
});

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { state.drawing = null; renderFrame(canvas, ctx, state); }
  if (e.key === 'Enter' && state.drawing) finishDrawing();
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    deleteSelected(state);
    $('deletePolyBtn').disabled = !state.selected;
    refresh();
  }
});

function finishDrawing() {
  const d = state.drawing;
  if (!d) return;
  // Drop a trailing duplicate of the first point and degenerate shapes.
  const pts = d.points.filter((p, i) => i === 0 || p[0] !== d.points[i - 1][0] || p[1] !== d.points[i - 1][1]);
  if (pts.length >= 3) {
    state.selected = addPolygon(state, d.kind, pts);
    toast(`${d.kind === 'protect' ? '保留' : '剔除'}多边形已添加，对全部 ${state.frames.length} 帧生效`);
  } else {
    toast('多边形至少需要 3 个顶点', true);
  }
  state.drawing = null;
  $('deletePolyBtn').disabled = !state.selected;
  refresh();
}

// ----- polygon list UI -------------------------------------------------------

function updatePolyList() {
  const ul = $('polyList');
  ul.innerHTML = '';
  for (const item of polygonList(state)) {
    const li = document.createElement('li');
    const isSel = state.selected?.kind === item.kind && state.selected.index === item.index;
    if (isSel) li.classList.add('selected');
    li.innerHTML = `<span class="poly-dot ${item.kind}"></span>
      <span>${item.kind === 'protect' ? '保留' : '剔除'} #${item.index + 1}</span>
      <span class="meta">${item.points.length} 顶点</span>`;
    li.addEventListener('click', () => {
      state.tool = 'edit';
      syncToolButtons();
      state.selected = { kind: item.kind, index: item.index };
      $('deletePolyBtn').disabled = false;
      updatePolyList();
      renderFrame(canvas, ctx, state);
    });
    ul.appendChild(li);
  }
  $('deletePolyBtn').disabled = !state.selected;
}

$('deletePolyBtn').addEventListener('click', () => {
  deleteSelected(state);
  refresh();
});

// ----- tool selection --------------------------------------------------------

function syncToolButtons() {
  $('toolProtect').classList.toggle('active', state.tool === 'protect');
  $('toolRemove').classList.toggle('active', state.tool === 'remove');
  $('toolEdit').classList.toggle('active', state.tool === 'edit');
  canvas.style.cursor = state.tool === 'edit' ? 'default' : 'crosshair';
}
for (const [id, tool] of [['toolProtect', 'protect'], ['toolRemove', 'remove'], ['toolEdit', 'edit']]) {
  $(id).addEventListener('click', () => { state.tool = tool; state.drawing = null; syncToolButtons(); renderFrame(canvas, ctx, state); });
}

// ----- view modes ------------------------------------------------------------

function setView(mode) {
  document.querySelectorAll('input[name="view"]').forEach(r => { r.checked = r.value === mode; });
  if (mode === 'custom' && !state.background) {
    // No backdrop chosen yet: show the composite over black rather than failing.
    state.view = 'custom';
    toast('尚未选择背景 PNG，当前以黑底合成；选择后自动替换', true);
  } else {
    state.view = mode;
  }
  refresh();
}
document.querySelectorAll('input[name="view"]').forEach(r =>
  r.addEventListener('change', () => setView(r.value)));

$('overlayToggle').addEventListener('change', e => {
  state.showOverlay = e.target.checked;
  renderFrame(canvas, ctx, state);
});

// ----- zoom ------------------------------------------------------------------

function setZoom(z, cx, cy) {
  const old = state.zoom;
  state.zoom = Math.min(16, Math.max(0.25, z));
  if (cx !== undefined) {
    const k = state.zoom / old;
    state.panX = cx - (cx - state.panX) * k;
    state.panY = cy - (cy - state.panY) * k;
  }
  applyTransform(canvas, viewport, state);
  updateZoomLabel();
}
$('zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
$('zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
$('zoomOne').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; applyTransform(canvas, viewport, state); updateZoomLabel(); });
$('zoomFit').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; applyTransform(canvas, viewport, state); updateZoomLabel(); });

viewport.addEventListener('wheel', e => {
  if (!state.frames.length) return;
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15),
          e.clientX - rect.left - rect.width / 2,
          e.clientY - rect.top - rect.height / 2);
}, { passive: false });

new ResizeObserver(() => {
  if (state.frames.length) { applyTransform(canvas, viewport, state); updateZoomLabel(); }
}).observe(viewport);

// ----- parameter controls ----------------------------------------------------

function syncParamControls() {
  $('keyColor').value = '#' + state.params.keyColor.map(v => v.toString(16).padStart(2, '0')).join('');
  $('innerRange').value = state.params.inner;
  $('outerRange').value = state.params.outer;
  $('softRange').value = state.params.softness;
  $('despillRange').value = state.params.despillStrength;
  $('innerVal').textContent = state.params.inner.toFixed(3);
  $('outerVal').textContent = state.params.outer.toFixed(3);
  $('softVal').textContent = state.params.softness;
  $('despillVal').textContent = state.params.despillStrength.toFixed(2);
}

$('keyColor').addEventListener('input', e => {
  const hex = e.target.value;
  state.params.keyColor = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  invalidateCaches(state); refresh();
});
const bindRange = (id, key, outId, fmt) => $(id).addEventListener('input', e => {
  state.params[key] = parseFloat(e.target.value);
  $(outId).textContent = fmt(state.params[key]);
  invalidateCaches(state); refresh();
});
bindRange('innerRange', 'inner', 'innerVal', v => v.toFixed(3));
bindRange('outerRange', 'outer', 'outerVal', v => v.toFixed(3));
bindRange('softRange', 'softness', 'softVal', v => String(v));
bindRange('despillRange', 'despillStrength', 'despillVal', v => v.toFixed(2));

$('resetParams').addEventListener('click', () => {
  const keep = {
    protectPolygons: state.params.protectPolygons,
    removePolygons: state.params.removePolygons,
  };
  state.params = { ...structuredClone(DEFAULT_PARAMS), ...keep };
  syncParamControls();
  invalidateCaches(state);
  refresh();
  toast('键控参数已恢复默认（多边形保留）');
});

// ----- playback --------------------------------------------------------------
// Timestamp-driven rAF loop: frame index advances by elapsed * fps, so the
// specified frame rate is honored regardless of display refresh rate.
let rafId = null;
let lastTime = 0;
let accumulator = 0;

function stopPlayback() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  state.playing = false;
  $('playBtn').textContent = '▶ 播放';
}

$('playBtn').addEventListener('click', () => {
  if (!state.frames.length) return;
  if (state.playing) { stopPlayback(); return; }
  state.playing = true;
  $('playBtn').textContent = '⏸ 暂停';
  lastTime = performance.now();
  accumulator = 0;
  const loop = now => {
    if (!state.playing) return;
    accumulator += (now - lastTime) / 1000;
    lastTime = now;
    const period = 1 / state.fps;
    let advanced = false;
    while (accumulator >= period) {
      state.currentFrame = (state.currentFrame + 1) % state.frames.length;
      accumulator -= period;
      advanced = true;
    }
    if (advanced) refresh();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
});
$('stopBtn').addEventListener('click', () => {
  stopPlayback();
  state.currentFrame = 0;
  refresh();
});
$('fpsInput').addEventListener('change', e => {
  const v = Math.min(60, Math.max(1, parseInt(e.target.value) || 24));
  e.target.value = v;
  state.fps = v;
});
$('scrub').addEventListener('input', e => {
  state.currentFrame = parseInt(e.target.value);
  refresh();
});

// ----- preset.json -----------------------------------------------------------

$('presetBtn').addEventListener('click', () => {
  if (!state.frames.length) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = () => {
    const file = inp.files[0];
    if (!file) return;
    file.text().then(text => applyPreset(JSON.parse(text)))
      .catch(err => toast('preset 应用失败：' + (err.message || err), true));
  };
  inp.click();
});

function applyPreset(json) {
  if (json.green_linear_rgb) {
    const [r, g, b] = json.green_linear_rgb;
    const toByte = l => Math.round((l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
    state.params.keyColor = [toByte(r), toByte(g), toByte(b)];
  }
  if (typeof json.fps === 'number') {
    state.fps = json.fps;
    $('fpsInput').value = json.fps;
  }
  if (Array.isArray(json.protect_polygons)) state.params.protectPolygons = json.protect_polygons.map(normalizePoly);
  if (Array.isArray(json.remove_polygons)) state.params.removePolygons = json.remove_polygons.map(normalizePoly);
  state.selected = null;
  state.drawing = null;
  syncParamControls();
  invalidateCaches(state);
  refresh();
  toast(`preset 已应用：${state.params.protectPolygons.length} 个保留、${state.params.removePolygons.length} 个剔除多边形`);
}

function normalizePoly(poly) {
  if (!Array.isArray(poly) || poly.length < 3) throw new Error('多边形顶点数不足');
  return poly.map(([x, y]) => {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('多边形顶点坐标必须是数字');
    }
    if (x < 0 || y < 0 || x > state.width - 1 || y > state.height - 1) {
      throw new Error(`多边形顶点 (${x}, ${y}) 超出画面 ${state.width}×${state.height}`);
    }
    return [Math.round(x), Math.round(y)];
  });
}

// ----- export ----------------------------------------------------------------

$('exportBtn').addEventListener('click', async () => {
  if (!state.frames.length) return;
  setBusy(true);
  try {
    const zip = await exportZip(state.frames, state.width, state.height, state.params, getBackground(state));
    const blob = new Blob([zip], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chroma-matte-export.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`导出完成：rgba/、matte/、composite/ 各 ${state.frames.length} 帧`);
  } catch (err) {
    toast('导出失败：' + (err.message || err), true);
  } finally {
    setBusy(false);
  }
});

// ----- init ------------------------------------------------------------------

syncParamControls();
syncToolButtons();
toast('请导入序列 ZIP 开始工作');
