// 展厅多面镜反射视束核对 —— 界面逻辑
import { Engine } from './engine.js';
import { History } from './state.js';
import { SAMPLES } from './samples.js';

const $ = (id) => document.getElementById(id);
const els = {};
const engine = new Engine();
let history = null;
let selectedMirrorId = null;
let picked = null; // {i,j}
let lastError = null;

const SAMPLE_LABELS = {
  case1_single_mirror: '样例 1 · 单面斜镜',
  case2_periscope_relay: '样例 2 · 潜望中转',
  case3_occluded_mirror: '样例 3 · 镜面遮挡',
};

function init() {
  [
    'sampleSelect', 'importFile', 'importText', 'btnImport', 'btnImportApply',
    'btnUndo', 'btnRedo', 'btnExport', 'exportArea', 'btnCopyExport', 'btnCloseExport',
    'errorBanner', 'errorList', 'btnDismissError',
    'canvas', 'crosshair', 'emptyHint',
    'statCand', 'statSel', 'statScore', 'statTime', 'statMode',
    'kInput', 'bounceInput',
    'beamTree', 'mirrorList', 'editor', 'editorTitle', 'noMirrorHint',
    'mEnabled', 'mId', 'mRefl0', 'mRefl1', 'mRefl2', 'vertexTable',
    'tracePanel', 'traceEmpty',
  ].forEach((id) => { els[id] = $(id); });

  els.sampleSelect.addEventListener('change', () => loadSample(els.sampleSelect.value));
  els.btnUndo.addEventListener('click', () => stepHistory('undo'));
  els.btnRedo.addEventListener('click', () => stepHistory('redo'));
  els.kInput.addEventListener('change', commitParam('beamBudgetK', els.kInput, 1, 32, true));
  els.bounceInput.addEventListener('change', commitParam('maxBounceDepth', els.bounceInput, 0, 4, true));
  els.canvas.addEventListener('click', onCanvasClick);
  els.btnExport.addEventListener('click', openExport);
  els.btnCopyExport.addEventListener('click', copyExport);
  els.btnCloseExport.addEventListener('click', () => { $('exportModal').hidden = true; });
  els.btnDismissError.addEventListener('click', clearError);
  els.btnImport.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', onImportFile);
  els.btnImportApply.addEventListener('click', applyImportText);
  window.addEventListener('keydown', onKey);

  loadSample('case1_single_mirror');
}

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); stepHistory(e.shiftKey ? 'redo' : 'undo');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault(); stepHistory('redo');
  }
}

function loadSample(name) {
  const scene = JSON.parse(JSON.stringify(SAMPLES[name]));
  const r = engine.load(scene);
  if (!r.ok) { showError(r.errors); return; }
  history = new History(engine.scene);
  selectedMirrorId = engine.model.mirrors[0]?.id ?? null;
  picked = null;
  refreshAll();
}

// 仅在编辑成功时入栈；失败保留原场景并显示编号+原因
function commitScene(nextScene, editMeta = {}) {
  const r = engine.applyEdit(nextScene, editMeta);
  if (!r.ok) { showError(r.errors); return false; }
  history.push(engine.scene);
  refreshAll();
  return true;
}

function stepHistory(kind) {
  const scene = kind === 'undo' ? history.undo() : history.redo();
  if (!scene) return;
  const r = engine.applyEdit(JSON.parse(JSON.stringify(scene)), {});
  if (!r.ok) { showError(r.errors); return; }
  picked = null;
  refreshAll();
}

function commitParam(key, input, lo, hi, intg) {
  return () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) { input.value = engine.scene[key]; return; }
    v = intg ? Math.round(v) : v;
    if (v < lo || v > hi) { input.value = engine.scene[key]; return; }
    if (v === engine.scene[key]) return;
    const next = JSON.parse(JSON.stringify(history.current));
    next[key] = v;
    commitScene(next);
  };
}

// ---------- 镜面编辑 ----------
function currentMirror() {
  return engine.scene.mirrors.find((m) => m.id === selectedMirrorId) || null;
}

function editMirror(mutator) {
  const next = JSON.parse(JSON.stringify(history.current));
  const m = next.mirrors.find((x) => x.id === selectedMirrorId);
  if (!m) return;
  mutator(m);
  commitScene(next, { changedMirrorId: selectedMirrorId });
}

function onToggleMirror() {
  editMirror((m) => { m.enabled = els.mEnabled.checked; });
}
function onReflChannel(idx, input) {
  editMirror((m) => { m.reflectance[idx] = Number(input.value); });
}
function onVertex(vi, axis, input) {
  editMirror((m) => { m.vertices[vi][axis] = Number(input.value); });
}

// ---------- 渲染刷新 ----------
function refreshAll() {
  clearError();
  drawCanvas();
  renderStats();
  renderBeamTree();
  renderMirrorList();
  renderEditor();
  renderTrace();
  els.btnUndo.disabled = !history?.canUndo;
  els.btnRedo.disabled = !history?.canRedo;
  els.kInput.value = engine.scene.beamBudgetK;
  els.bounceInput.value = engine.scene.maxBounceDepth;
}

function drawCanvas() {
  const { width, height } = engine.model;
  const canvas = els.canvas;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(engine.result.image), width, height);
  ctx.putImageData(img, 0, 0);
  if (picked) {
    const s = 1;
    ctx.strokeStyle = '#38e1ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(picked.i - 2 * s + 0.5, picked.j - 2 * s + 0.5, 5 * s, 5 * s);
  }
  els.emptyHint.hidden = true;
  $('canvasSize').textContent = `${width} × ${height} 画布 · 点击采样中心 (i+0.5, j+0.5)`;
}

function renderStats() {
  const t = engine.lastTiming;
  els.statCand.textContent = String(t.candidateCount);
  els.statSel.textContent = String(t.selectedCount);
  els.statScore.textContent = engine.totalScore.toLocaleString('en-US');
  els.statTime.textContent = `${t.totalMs.toFixed(1)} ms`;
  const overflow = t.candidateCount > engine.model.K;
  els.statMode.textContent = overflow
    ? `超配额：DP 精确选 ${engine.model.K} 条内最优`
    : '未超配额：候选全部激活';
  els.statMode.classList.toggle('warn', overflow);
}

function renderBeamTree() {
  const beams = engine.tree.all.slice(1).sort((a, b) => {
    const pa = a.path.join('>'), pb = b.path.join('>');
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  if (!beams.length) {
    els.beamTree.innerHTML = '<p class="muted">当前场景没有非空反射视束。</p>';
    return;
  }
  const rows = beams.map((b) => {
    const active = engine.activeSet.has(b);
    const indent = (b.depth - 1) * 14;
    return `
      <div class="beam-row ${active ? 'active' : 'inactive'}" style="--indent:${indent}px">
        <span class="beam-path">${'└─'.repeat(b.depth - 1)}[${b.path.join(' → ')}]</span>
        <span class="beam-meta">d=${b.depth} · 屏幕面积 ${b.screenArea.toFixed(1)}px² · 得分 <b>${b.score.toLocaleString('en-US')}</b></span>
        <span class="beam-state">${active ? '激活' : '剪枝'}</span>
      </div>`;
  }).join('');
  els.beamTree.innerHTML = rows;
}

function renderMirrorList() {
  els.mirrorList.innerHTML = engine.model.mirrors.map((m) => `
    <button class="mirror-chip ${m.id === selectedMirrorId ? 'sel' : ''} ${m.enabled ? '' : 'off'}"
      data-id="${m.id}">${m.id}${m.enabled ? '' : '（停用）'}</button>
  `).join('');
  els.mirrorList.querySelectorAll('.mirror-chip').forEach((btn) => {
    btn.addEventListener('click', () => { selectedMirrorId = btn.dataset.id; renderEditor(); renderMirrorList(); });
  });
}

function renderEditor() {
  const m = currentMirror();
  if (!m) { els.editor.hidden = true; els.noMirrorHint.hidden = false; return; }
  els.editor.hidden = false; els.noMirrorHint.hidden = true;
  els.editorTitle.textContent = `镜面 ${m.id}`;
  els.mId.textContent = m.id;
  els.mEnabled.checked = m.enabled !== false;
  els.mEnabled.onchange = onToggleMirror;
  [els.mRefl0, els.mRefl1, els.mRefl2].forEach((inp, idx) => {
    inp.value = m.reflectance[idx];
    inp.onchange = () => onReflChannel(idx, inp);
  });
  els.vertexTable.innerHTML = m.vertices.map((v, vi) => `
    <tr>
      <td>v${vi}</td>
      ${['x', 'y', 'z'].map((axis, ai) => `
        <td><input type="number" step="0.01" value="${v[ai]}" data-v="${vi}" data-axis="${ai}"></td>`).join('')}
    </tr>`).join('');
  els.vertexTable.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => onVertex(Number(inp.dataset.v), Number(inp.dataset.axis), inp));
  });
}

// ---------- 像素拾取与展开光路 ----------
function onCanvasClick(e) {
  const rect = els.canvas.getBoundingClientRect();
  const i = Math.floor((e.clientX - rect.left) / rect.width * engine.model.width);
  const j = Math.floor((e.clientY - rect.top) / rect.height * engine.model.height);
  if (i < 0 || j < 0 || i >= engine.model.width || j >= engine.model.height) return;
  picked = { i, j };
  drawCanvas();
  renderTrace();
}

function renderTrace() {
  if (!picked) {
    els.traceEmpty.hidden = false;
    els.tracePanel.innerHTML = '';
    return;
  }
  els.traceEmpty.hidden = true;
  const info = engine.pickPixel(picked.i, picked.j);
  if (!info || !info.trace.length) {
    els.tracePanel.innerHTML = `<p class="muted">像素 (${picked.i}, ${picked.j}) 未命中任何几何或镜面，输出黑色。</p>`;
    return;
  }
  const rows = info.trace.map((step, k) => {
    if (step.kind === 'mirror') {
      return `
        <div class="trace-step mirror">
          <div class="trace-head"><span class="idx">${k + 1}</span> 镜面反射 <code>${step.mirrorId}</code></div>
          <div class="trace-body">
            层数 d=${step.depth} · 展开前向深度 z=${step.z.toFixed(4)}<br>
            路径 [${step.path.join(' → ')}]<br>
            累计反射率 R=(${step.reflectance.map((x) => x.toFixed(3)).join(', ')})
          </div>
        </div>`;
    }
    return `
      <div class="trace-step tri">
        <div class="trace-head"><span class="idx">${k + 1}</span> 命中三角形 <code>#${step.triangleId}</code></div>
        <div class="trace-body">
          层数 d=${step.depth} · 展开前向深度 z=${step.z.toFixed(4)}<br>
          路径 [${step.path.join(' → ')}]<br>
          累计反射率 R=(${step.reflectance.map((x) => x.toFixed(3)).join(', ')})
        </div>
      </div>`;
  }).join('<div class="trace-arrow">↓</div>');
  els.tracePanel.innerHTML = `
    <p class="trace-title">像素 (${picked.i}, ${picked.j}) 的展开光路（${info.trace.length} 段）</p>${rows}`;
}

// ---------- 导入 / 导出 / 错误 ----------
function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { els.importText.value = String(reader.result); };
  reader.readAsText(file);
  e.target.value = '';
}

function applyImportText() {
  let scene;
  try { scene = JSON.parse(els.importText.value); }
  catch (err) { showError([{ kind: 'scene', id: null, reason: `JSON 解析失败：${err.message}` }]); return; }
  const r = engine.applyEdit(scene, {});
  if (!r.ok) { showError(r.errors); return; }
  history = new History(engine.scene);
  selectedMirrorId = engine.model.mirrors[0]?.id ?? null;
  picked = null;
  refreshAll();
}

function openExport() {
  const data = engine.exportJSON();
  els.exportArea.value = JSON.stringify(data, null, 2);
  $('exportModal').hidden = false;
}

async function copyExport() {
  const text = els.exportArea.value;
  try {
    await navigator.clipboard.writeText(text);
    els.btnCopyExport.textContent = '已复制';
    setTimeout(() => { els.btnCopyExport.textContent = '复制 JSON'; }, 1200);
  } catch {
    els.exportArea.select();
  }
}

function showError(errors) {
  lastError = errors;
  els.errorBanner.hidden = false;
  els.errorList.innerHTML = errors.map((e) =>
    `<li><span class="tag">${e.kind}${e.id !== null && e.id !== undefined ? `:${e.id}` : ''}</span> ${e.reason}</li>`).join('');
}
function clearError() {
  lastError = null;
  els.errorBanner.hidden = true;
}

init();
