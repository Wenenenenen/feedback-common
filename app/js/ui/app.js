// 主控制器：文件加载、对应点交互、运行管线、预览切换、导出。
import {
  state, resetProject, loadImage, loadMatch, setReference, setThreshold,
  addPair, updatePair, deletePair, addEdge, deleteEdge,
} from './state.js';
import { buildMosaic, buildExportJson, MosaicError, MAX_SIDE } from '../mosaic.js';
import { encodePng } from '../png.js';
import { renderPreview, drawSourcePoints, hitTestPoint } from './preview.js';

const $ = (id) => document.getElementById(id);
const els = {};
// 挂起点：在一侧点击后等待在另一侧补全。{ edgeIndex, side, xy }
let pendingPoint = null;

function init() {
  for (const id of [
    'file-images', 'file-json', 'json-status', 'image-list', 'select-reference',
    'input-threshold', 'select-edge', 'btn-add-edge', 'btn-del-edge',
    'canvas-a', 'canvas-b', 'cap-a', 'cap-b', 'btn-del-point', 'point-count',
    'btn-run', 'btn-export-png', 'btn-export-json', 'mode-tabs', 'canvas-preview',
    'canvas-size', 'diagnostics', 'dialog-error', 'error-message',
  ]) els[id] = $(id);

  els['file-images'].addEventListener('change', onImages);
  els['file-json'].addEventListener('change', onJson);
  els['select-reference'].addEventListener('change', (e) => {
    setReference(Number(e.target.value));
    refreshAll();
  });
  els['input-threshold'].addEventListener('change', (e) => {
    const t = Number(e.target.value);
    if (t > 0) setThreshold(t);
    else e.target.value = state.threshold;
  });
  els['select-edge'].addEventListener('change', (e) => {
    state.selected = { edgeIndex: Number(e.target.value), pairIndex: null };
    pendingPoint = null;
    drawPointPanels();
  });
  els['btn-add-edge'].addEventListener('click', onAddEdge);
  els['btn-del-edge'].addEventListener('click', onDeleteEdge);
  els['btn-del-point'].addEventListener('click', onDeletePoint);
  els['btn-run'].addEventListener('click', () => runMosaic(false));
  els['btn-export-png'].addEventListener('click', exportPng);
  els['btn-export-json'].addEventListener('click', exportJson);
  els['mode-tabs'].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.previewMode = btn.dataset.mode;
    els['mode-tabs'].querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    drawPreview();
  });
  bindPointCanvas(els['canvas-a'], 'a');
  bindPointCanvas(els['canvas-b'], 'b');
}

// ---------- 文件加载 ----------
async function onImages(e) {
  try {
    resetProject();
    const files = Array.from(e.target.files).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length < 2 || files.length > 4) throw new Error('需要 2–4 张 PNG');
    for (const f of files) await loadImage(f);
    els['json-status'].textContent = `已加载 ${state.images.length} 张图：` +
      state.images.map((i) => `${i.name}(${i.width}x${i.height})`).join('，');
    refreshAll();
  } catch (err) {
    showError(err.message);
  }
}

async function onJson(e) {
  try {
    const file = e.target.files[0];
    if (!file) return;
    const json = JSON.parse(await file.text());
    loadMatch(json);
    els['json-status'].textContent += `；JSON 已加载（${json.edges.length} 条边）`;
    refreshAll();
  } catch (err) {
    showError('JSON 加载失败：' + err.message);
  }
}

// ---------- 刷新界面 ----------
function refreshAll() {
  refreshImageList();
  refreshReferenceSelect();
  refreshEdgeSelect();
  drawPointPanels();
  const ready = state.images.length >= 2 && state.match;
  els['btn-run'].disabled = !ready;
  els['btn-add-edge'].disabled = !state.match;
  if (state.result) drawPreview();
}

function refreshImageList() {
  els['image-list'].innerHTML = '';
  state.images.forEach((img, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${i}. ${img.name} <span class="hint">${img.width}x${img.height}</span></span>` +
      (i === state.reference ? '<span class="ref-tag">参考图</span>' : '');
    els['image-list'].appendChild(li);
  });
}

function refreshReferenceSelect() {
  const sel = els['select-reference'];
  sel.innerHTML = '';
  state.images.forEach((img, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i}. ${img.name}`;
    if (i === state.reference) opt.selected = true;
    sel.appendChild(opt);
  });
}

function refreshEdgeSelect() {
  const sel = els['select-edge'];
  sel.innerHTML = '';
  if (!state.match) return;
  state.match.edges.forEach((edge, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `边 ${edge.a}–${edge.b}（${edge.pairs.length} 点）`;
    sel.appendChild(opt);
  });
  // 保留仍然有效的当前选择，避免绘制/加点流程中把 selected 冲掉
  if (state.selected && state.selected.edgeIndex < state.match.edges.length) {
    sel.value = state.selected.edgeIndex;
  } else {
    state.selected = state.match.edges.length ? { edgeIndex: 0, pairIndex: null } : null;
  }
  els['btn-del-edge'].disabled = !state.selected;
}

function currentEdge() {
  if (!state.selected) return null;
  return state.match.edges[state.selected.edgeIndex];
}

function drawPointPanels() {
  const edge = currentEdge();
  if (!edge || !state.images[edge.a] || !state.images[edge.b]) {
    els['cap-a'].textContent = '–';
    els['cap-b'].textContent = '–';
    return;
  }
  const selIdx = state.selected.pairIndex;
  els['cap-a'].textContent = edge.a;
  els['cap-b'].textContent = edge.b;
  drawSourcePoints(els['canvas-a'], state.images[edge.a], edge.pairs.map((p) => p[0]), selIdx);
  drawSourcePoints(els['canvas-b'], state.images[edge.b], edge.pairs.map((p) => p[1]), selIdx);
  els['point-count'].textContent = `${edge.pairs.length} 对对应点（至少 4 对才能估计单应）`;
  els['btn-del-point'].disabled = selIdx == null;
}

// ---------- 点的交互（点击加点、拖动改点、选中删点） ----------
function bindPointCanvas(canvas, side) {
  let dragging = null;
  const toImageXY = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return [x, y];
  };
  canvas.addEventListener('pointerdown', (ev) => {
    const edge = currentEdge();
    if (!edge || !state.selected) return;
    const [x, y] = toImageXY(ev);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const points = edge.pairs.map((p) => p[side === 'a' ? 0 : 1]);
    const hit = hitTestPoint(points, x, y, 8);
    if (hit >= 0) {
      state.selected.pairIndex = hit;
      dragging = hit;
      pendingPoint = null;
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* 合成事件可忽略 */ }
      drawPointPanels();
    } else {
      const img = state.images[edge[side]];
      const xy = [
        Math.min(img.width - 1, Math.max(0, x)),
        Math.min(img.height - 1, Math.max(0, y)),
      ];
      if (pendingPoint && pendingPoint.edgeIndex === state.selected.edgeIndex && pendingPoint.side !== side) {
        // 补全挂起点：成对加入
        const ptA = side === 'a' ? xy : pendingPoint.xy;
        const ptB = side === 'b' ? xy : pendingPoint.xy;
        addPair(state.selected.edgeIndex, ptA, ptB);
        pendingPoint = null;
        dragging = edge.pairs.length - 1;
        try { canvas.setPointerCapture(ev.pointerId); } catch { /* 合成事件可忽略 */ }
        drawPointPanels();
      } else {
        // 记下挂起点，等待另一张图上的对应点击
        pendingPoint = { edgeIndex: state.selected.edgeIndex, side, xy };
        showPendingHint(side);
      }
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging == null || !state.selected) return;
    const edge = currentEdge();
    if (!edge || dragging >= edge.pairs.length) { dragging = null; return; }
    const [x, y] = toImageXY(ev);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const imgIdx = edge[side === 'a' ? 'a' : 'b'];
    const img = state.images[imgIdx];
    updatePair(state.selected.edgeIndex, dragging, side, [
      Math.min(img.width - 1, Math.max(0, x)),
      Math.min(img.height - 1, Math.max(0, y)),
    ]);
    drawPointPanels();
  });
  const end = () => { dragging = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function showPendingHint(side) {
  els['point-count'].textContent =
    `已在图 ${side === 'a' ? currentEdge().a : currentEdge().b} 放置挂起点，请在另一张图上点击对应位置补全该点对`;
}

function onAddEdge() {
  if (state.images.length < 2) return;
  // 默认连第 0 张与第一张尚未连接的图
  const connected = new Set();
  state.match.edges.forEach((e) => { connected.add(`${e.a}-${e.b}`); connected.add(`${e.b}-${e.a}`); });
  let a = 0, b = -1;
  for (let i = 1; i < state.images.length; i++) {
    if (!connected.has(`0-${i}`)) { b = i; break; }
  }
  if (b < 0) { showError('所有图片对之间都已有边'); return; }
  const idx = addEdge(a, b);
  state.selected = { edgeIndex: idx, pairIndex: null };
  refreshAll();
}

function onDeleteEdge() {
  if (!state.selected) return;
  deleteEdge(state.selected.edgeIndex);
  refreshAll();
}

function onDeletePoint() {
  if (!state.selected || state.selected.pairIndex == null) return;
  const { edgeIndex, pairIndex } = state.selected;
  deletePair(edgeIndex, pairIndex); // 保留边选择，仅清空 pairIndex
  pendingPoint = null;
  drawPointPanels();
}

// ---------- 运行管线 ----------
function runMosaic(quiet) {
  if (!state.match) return;
  try {
    state.resultError = null;
    const result = buildMosaic(state.images, state.match, state.threshold, state.reference);
    state.result = result;
    els['btn-export-png'].disabled = false;
    els['btn-export-json'].disabled = false;
    renderDiagnostics(result);
    drawPreview();
    if (!quiet && result.loopWarnings.length) {
      showError('拼接完成但存在闭环不一致：\n' + result.loopWarnings.join('\n'), true);
    }
  } catch (err) {
    state.result = null;
    state.resultError = err;
    els['btn-export-png'].disabled = true;
    els['btn-export-json'].disabled = true;
    els['diagnostics'].innerHTML = `<span class="diag-err">${err instanceof MosaicError ? '[' + err.code + '] ' : ''}${escapeHtml(err.message)}</span>`;
    showError(err.message);
  }
}

function drawPreview() {
  if (!state.result) return;
  const { canvas } = state.result;
  els['canvas-size'].textContent = `输出画布 ${canvas.width} × ${canvas.height}（上限 ${MAX_SIDE}），原点 (${canvas.originX}, ${canvas.originY})`;
  renderPreview(els['canvas-preview'], state.result, state.previewMode);
}

function renderDiagnostics(r) {
  const rows = [];
  rows.push(`<div class="diag-row diag-ok">✓ 连通：参考图 ${r.reference} 可达全部 ${state.images.length} 张图；生成树边 ${r.tree.treeEdges.map((e) => `${e.a}-${e.b}`).join(', ') || '（仅参考图）'}</div>`);
  for (const e of r.edgeResults) {
    rows.push(`<div class="diag-row">边 ${e.a}-${e.b}：内点 ${e.inliers.length}/${e.pairs.length}，` +
      `RANSAC 迭代 ${e.iterations} 次（退化采样 ${e.degenerateSamples}），外点索引 [${e.outliers.join(', ')}]</div>`);
  }
  if (r.loops.length) {
    for (const lp of r.loops) {
      const cls = lp.maxResidual > r.threshold ? 'diag-warn' : 'diag-ok';
      rows.push(`<div class="diag-row ${cls}">闭环 ${lp.a}-${lp.b} 参考平面对应残差：max ${lp.maxResidual.toFixed(3)}px，` +
        `mean ${lp.meanResidual.toFixed(3)}px，rms ${lp.rmsResidual.toFixed(3)}px（阈值 ${r.threshold}px）</div>`);
    }
  } else {
    rows.push('<div class="diag-row hint">无闭环边（所有边均在生成树上）。</div>');
  }
  r.loopWarnings.forEach((w) => rows.push(`<div class="diag-row diag-warn">⚠ ${escapeHtml(w)}</div>`));
  // 残差明细表
  rows.push('<table class="residuals"><tr><th>边</th><th>点#</th><th>重投影误差(px)</th><th>判定</th></tr>');
  for (const e of r.edgeResults) {
    e.residuals.forEach((rs) => {
      rows.push(`<tr><td>${e.a}-${e.b}</td><td>${rs.index}</td><td>${rs.error.toFixed(3)}</td>` +
        `<td style="color:${rs.inlier ? 'var(--ok)' : 'var(--danger)'}">${rs.inlier ? '内点' : '外点'}</td></tr>`);
    });
  }
  rows.push('</table>');
  els['diagnostics'].innerHTML = rows.join('');
}

// ---------- 导出 ----------
async function exportPng() {
  if (!state.result) return;
  const bytes = await encodePng(state.result.canvas.width, state.result.canvas.height, state.result.rgba);
  download(new Blob([bytes], { type: 'image/png' }), 'mosaic.png');
}

function exportJson() {
  if (!state.result) return;
  const payload = buildExportJson(state.result, state.images.map((i) => i.name));
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'mosaic.json');
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showError(message, warnOnly = false) {
  els['error-message'].textContent = message;
  els['dialog-error'].showModal();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
