// app.js — UI 装配:文档编辑、视图开关、点选查询、导入导出。
import { sliceByLength } from './geometry.js';
import { validateDoc, computeDoc } from './pipeline.js';
import { renderScene, exportMeshJSON, exportPNG, hitTest } from './renderer.js';

// 内置示例(与 samples/stroke-geometry-cases.zip 中 paths.json 相同)
const DEFAULT_DOC = {
  canvas: [240, 160],
  paths: [
    { id: 'dash-line', commands: [['M', 10, 20], ['L', 110, 20], ['L', 210, 20]], transform: [1, 0, 0, 1, 0, 0],
      style: { width: 10, join: 'miter', cap: 'butt', miterLimit: 4, dash: [30, 10], dashOffset: 0, color: [0, 0, 0, 0.5] } },
    { id: 'closed-seam', commands: [['M', 20, 20], ['L', 80, 20], ['L', 80, 80], ['L', 20, 80], ['Z']], transform: [1, 0, 0, 1, 0, 0],
      style: { width: 10, join: 'round', cap: 'round', miterLimit: 4, dash: [50, 20], dashOffset: 10, color: [0, 0, 0, 0.5] } },
    { id: 'cubic', commands: [['M', 10, 100], ['C', 10, 10, 190, 10, 190, 100]], transform: [1, 0, 0, 1, 0, 0],
      style: { width: 10, join: 'miter', cap: 'round', miterLimit: 4, dash: [30, 10], dashOffset: 0, color: [0, 0, 0, 0.5] } },
    { id: 'acute', commands: [['M', 20, 80], ['L', 100, 80], ['L', 30, 60]], transform: [1, 0, 0, 1, 0, 0],
      style: { width: 12, join: 'miter', cap: 'butt', miterLimit: 2, dash: [], dashOffset: 0, color: [0, 0, 0, 0.5] } },
    { id: 'repeated', commands: [['M', 10, 30], ['L', 10, 30], ['L', 90, 30]], transform: [1, 0, 0, 1, 0, 0],
      style: { width: 10, join: 'miter', cap: 'butt', miterLimit: 4, dash: [12, 4, 2], dashOffset: -5, color: [0, 0, 0, 0.5] } },
    { id: 'affine', commands: [['M', 10, 20], ['L', 110, 20]], transform: [-1.5, 0.2, 0.4, 0.75, 200, 20],
      style: { width: 10, join: 'miter', cap: 'round', miterLimit: 4, dash: [], dashOffset: 0, color: [0, 0, 0, 0.5] } },
  ],
};

const $ = (sel) => document.querySelector(sel);
const canvas = $('#view');
const ctx = canvas.getContext('2d');

const state = {
  doc: structuredClone(DEFAULT_DOC),
  computed: null,
  selected: 0,
  zoom: 3,
  view: { fill: true, wireframe: false, centerline: false, native: false },
  highlight: null,
};

function recompute() {
  state.computed = computeDoc(state.doc);
  render();
}

function render() {
  const [w, h] = state.doc.canvas;
  const dpr = window.devicePixelRatio || 1;
  const k = state.zoom * dpr;
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.style.width = `${w * state.zoom}px`;
  canvas.style.height = `${h * state.zoom}px`;
  renderScene(ctx, state.computed, state.view, k, state.highlight);
  updateStats();
}

function updateStats() {
  let tris = 0, verts = 0;
  for (const cp of state.computed.paths) {
    tris += cp.mesh.triangles.length / 3;
    verts += cp.mesh.vertexCount;
  }
  $('#stats').textContent = `三角形 ${tris} · 顶点 ${verts} · 路径 ${state.doc.paths.length}`;
}

// ---------- 路径列表 ----------
function refreshPathList() {
  const ul = $('#path-list');
  ul.innerHTML = '';
  state.doc.paths.forEach((p, i) => {
    const li = document.createElement('li');
    li.textContent = p.id ?? `path-${i}`;
    li.className = i === state.selected ? 'selected' : '';
    li.onclick = () => { state.selected = i; state.highlight = null; loadEditor(); refreshPathList(); render(); };
    ul.appendChild(li);
  });
}

// ---------- 编辑器 ----------
function loadEditor() {
  const p = state.doc.paths[state.selected];
  if (!p) return;
  $('#ed-id').value = p.id ?? '';
  $('#ed-commands').value = JSON.stringify(p.commands);
  $('#ed-transform').value = p.transform.join(', ');
  $('#ed-width').value = p.style.width;
  $('#ed-join').value = p.style.join;
  $('#ed-cap').value = p.style.cap;
  $('#ed-miter').value = p.style.miterLimit;
  $('#ed-dash').value = p.style.dash.join(', ');
  $('#ed-offset').value = p.style.dashOffset;
  $('#ed-color').value = p.style.color.join(', ');
  $('#ed-error').textContent = '';
}

function parseNumList(text, name) {
  const vals = text.split(/[,\s]+/).filter((s) => s.length > 0).map(Number);
  if (vals.some((v) => !isFinite(v))) throw new Error(`${name}: 含非数值`);
  return vals;
}

function applyEditor() {
  const err = $('#ed-error');
  try {
    const commands = JSON.parse($('#ed-commands').value);
    const transform = parseNumList($('#ed-transform').value, 'transform');
    const dashText = $('#ed-dash').value.trim();
    const dash = dashText === '' ? [] : parseNumList(dashText, 'dash');
    const color = parseNumList($('#ed-color').value, 'color');
    const candidate = {
      id: $('#ed-id').value.trim() || null,
      commands,
      transform,
      style: {
        width: Number($('#ed-width').value),
        join: $('#ed-join').value,
        cap: $('#ed-cap').value,
        miterLimit: Number($('#ed-miter').value),
        dash,
        dashOffset: Number($('#ed-offset').value || 0),
        color,
      },
    };
    const testDoc = { canvas: state.doc.canvas.slice(), paths: [candidate] };
    const errs = validateDoc(testDoc);
    if (errs.length) { err.textContent = errs.join(';'); return; }
    state.doc.paths[state.selected] = candidate;
    state.highlight = null;
    err.textContent = '';
    refreshPathList();
    recompute();
  } catch (e) {
    err.textContent = `解析失败: ${e.message}`;
  }
}

// ---------- 事件 ----------
function bindUI() {
  for (const key of ['fill', 'wireframe', 'centerline', 'native']) {
    $(`#tg-${key}`).onchange = (e) => { state.view[key] = e.target.checked; render(); };
  }
  $('#zoom').oninput = (e) => { state.zoom = Number(e.target.value); render(); };
  $('#btn-apply').onclick = applyEditor;
  $('#btn-add').onclick = () => {
    state.doc.paths.push({
      id: `path-${state.doc.paths.length}`,
      commands: [['M', 20, 20], ['L', 120, 20]],
      transform: [1, 0, 0, 1, 0, 0],
      style: { width: 8, join: 'round', cap: 'round', miterLimit: 4, dash: [], dashOffset: 0, color: [0, 0, 0, 0.5] },
    });
    state.selected = state.doc.paths.length - 1;
    refreshPathList(); loadEditor(); recompute();
  };
  $('#btn-del').onclick = () => {
    if (state.doc.paths.length <= 1) return;
    state.doc.paths.splice(state.selected, 1);
    state.selected = Math.max(0, state.selected - 1);
    state.highlight = null;
    refreshPathList(); loadEditor(); recompute();
  };
  $('#btn-import').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      const errs = validateDoc(doc);
      if (errs.length) { $('#ed-error').textContent = `导入被拒绝: ${errs.join(';')}`; return; }
      state.doc = doc;
      state.selected = 0;
      state.highlight = null;
      refreshPathList(); loadEditor(); recompute();
      $('#ed-error').textContent = '';
    } catch (ex) {
      $('#ed-error').textContent = `导入失败: ${ex.message}`;
    }
    e.target.value = '';
  };
  $('#btn-export-mesh').onclick = () => {
    const data = JSON.stringify(exportMeshJSON(state.computed));
    download(new Blob([data], { type: 'application/json' }), 'stroke-mesh.json');
  };
  $('#btn-export-png').onclick = () => {
    const a = document.createElement('a');
    a.href = exportPNG(state.computed, state.view);
    a.download = 'stroke-mesh.png';
    a.click();
  };
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / state.zoom;
    const y = (e.clientY - rect.top) / state.zoom;
    const hit = hitTest(state.computed, x, y);
    const info = $('#pick-info');
    if (!hit) {
      state.highlight = null;
      info.textContent = '未命中描边';
      render();
      return;
    }
    const sp = hit.computed.subpaths[hit.subpathIndex];
    const id = hit.computed.path.id ?? '?';
    if (hit.interval) {
      const iv = hit.interval;
      const pts = sliceByLength(sp, iv.s0, iv.s1);
      state.highlight = { computed: hit.computed, polyline: { pts } };
      const wrap = iv.s1 > sp.length + 1e-9 ? '(跨接缝)' : '';
      info.textContent = hit.inGap
        ? `${id}: 点击在间隔内 s=${hit.s.toFixed(2)},最近虚线段 [${iv.s0.toFixed(2)}, ${iv.s1.toFixed(2)}]${wrap}`
        : `${id}: s=${hit.s.toFixed(2)} ∈ 虚线段 [${iv.s0.toFixed(2)}, ${iv.s1.toFixed(2)}]${wrap} (子路径长 ${sp.length.toFixed(2)})`;
    } else {
      state.highlight = null;
      info.textContent = `${id}: s=${hit.s.toFixed(2)},无虚线区间`;
    }
    render();
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

bindUI();
refreshPathList();
loadEditor();
recompute();

// 供调试/自动化测试使用
window.__strokeStudio = { state, recompute };
