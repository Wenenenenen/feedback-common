// 应用状态与 UI 绑定。所有几何只经 buildSweep 计算一次，预览与导出共用结果。
import * as THREE from 'three';
import { buildSweep } from './sweep.js';
import { toOBJ, toJSON, downloadText } from './exporters.js';
import { Viewer } from './viewer.js';
import { SAMPLES } from './sample-data.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  input: structuredClone(SAMPLES[0].data),
  selected: 0,
  showFrames: true,
  showPath: true,
  showWire: false,
  compensate: true,
  caps: true,
  lastResult: null,
};

const viewer = new Viewer($('#view-canvas'));
viewer.startLoop();

// ---------- 工具 ----------
function currentModelInput() {
  // 把 UI 开关合并进数据，但不污染表格里的源数据
  return {
    ...state.input,
    caps: state.caps,
    compensate: state.compensate,
  };
}

function recompute() {
  const inp = currentModelInput();
  const r = buildSweep(inp);
  state.lastResult = r;
  viewer.showFrames = state.showFrames;
  viewer.showPath = state.showPath;
  viewer.showWire = state.showWire;
  viewer.update(r.valid ? r : null, inp);
  markProblemRows();
  renderDiagnostics(r, inp);
  renderStats(r);
  return r;
}

// ---------- 样例 ----------
function fillSampleSelect() {
  const sel = $('#sample-select');
  sel.innerHTML = '';
  SAMPLES.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = sampleLabel(s.id, s.data);
    sel.appendChild(opt);
  });
}
function sampleLabel(id, d) {
  const map = {
    helix: '螺旋开放管',
    closed: '闭合环管',
    'near-reverse': '近反向路径',
    'zero-segment': '零长段（无效）',
  };
  return `${map[id] || id} · ${d.points.length} 点 / ${d.profile.length} 边截面`;
}

$('#sample-select').addEventListener('change', (e) => {
  const s = SAMPLES[Number(e.target.value)];
  state.input = structuredClone(s.data);
  state.selected = 0;
  state.caps = !!s.data.caps;
  state.compensate = true;
  syncControlCheckboxes();
  twistInput.value = s.data.twist;
  rebuildTables();
  selectRow(0);
  recompute();
  viewer.frameView();
});

// ---------- 路径点 / 半径表格 ----------
function rebuildTables() {
  const tbody = $('#points-body');
  tbody.innerHTML = '';
  state.input.points.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.dataset.index = String(i);
    tr.innerHTML = `
      <td class="idx">${i}</td>
      <td><input data-k="0" inputmode="decimal" value="${fmt(p[0])}" aria-label="点 ${i} X"></td>
      <td><input data-k="1" inputmode="decimal" value="${fmt(p[1])}" aria-label="点 ${i} Y"></td>
      <td><input data-k="2" inputmode="decimal" value="${fmt(p[2])}" aria-label="点 ${i} Z"></td>
      <td><input class="r-input" data-k="r" inputmode="decimal" value="${fmt(state.input.radii[i])}" aria-label="点 ${i} 半径"></td>
      <td class="row-flag"></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', onCellEdit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') inp.blur();
    });
  });
  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') selectRow(Number(tr.dataset.index));
    });
  });
  renderProfileTable();
}

function fmt(x) {
  const v = Math.abs(x) < 1e-12 ? 0 : x;
  return Number(v.toFixed(6)).toString();
}

function onCellEdit(e) {
  const tr = e.target.closest('tr');
  const i = Number(tr.dataset.index);
  const k = e.target.dataset.k;
  const val = Number(e.target.value);
  if (!Number.isFinite(val)) {
    e.target.classList.add('bad');
    return;
  }
  e.target.classList.remove('bad');
  if (k === 'r') {
    if (val <= 0) { e.target.classList.add('bad'); return; }
    state.input.radii[i] = val;
  } else {
    state.input.points[i][Number(k)] = val;
  }
  markProblemRows();
  recompute();
}

function markProblemRows() {
  const r = state.lastResult;
  const jumps = new Set(r?.diagnostics.frameJumps.map((j) => j.at) ?? []);
  const zeros = new Set();
  (r?.diagnostics.zeroSegments ?? []).forEach((k) => {
    zeros.add(k);
    zeros.add((k + 1) % state.input.points.length);
  });
  $$('#points-body tr').forEach((tr) => {
    const i = Number(tr.dataset.index);
    const flag = tr.querySelector('.row-flag');
    tr.classList.toggle('jump', jumps.has(i));
    tr.classList.toggle('zero', zeros.has(i));
    flag.textContent = jumps.has(i) ? '跳变' : (zeros.has(i) ? '零段' : '');
  });
}

function selectRow(i) {
  state.selected = i;
  $$('#points-body tr').forEach((tr) =>
    tr.classList.toggle('selected', Number(tr.dataset.index) === i));
  const p = state.input.points[i];
  $('#editor-index').textContent = String(i);
  $('#edit-x').value = fmt(p[0]);
  $('#edit-y').value = fmt(p[1]);
  $('#edit-z').value = fmt(p[2]);
  $('#edit-r').value = fmt(state.input.radii[i]);
}

// 侧栏数字编辑器
['edit-x', 'edit-y', 'edit-z', 'edit-r'].forEach((id) => {
  $('#' + id).addEventListener('change', (e) => {
    const i = state.selected;
    const val = Number(e.target.value);
    if (!Number.isFinite(val)) { e.target.classList.add('bad'); return; }
    if (id === 'edit-r') {
      if (val <= 0) { e.target.classList.add('bad'); return; }
      state.input.radii[i] = val;
    } else {
      const k = { 'edit-x': 0, 'edit-y': 1, 'edit-z': 2 }[id];
      state.input.points[i][k] = val;
    }
    e.target.classList.remove('bad');
    rebuildTables();
    selectRow(i);
    recompute();
  });
});

// ---------- 增删路径点 ----------
$('#add-point').addEventListener('click', () => {
  if (state.input.points.length >= 256) { flashError('路径点最多 256 个'); return; }
  const i = state.selected;
  const n = state.input.points.length;
  const a = state.input.points[i];
  const b = state.input.points[Math.min(i + 1, n - 1)];
  const mid = a.map((x, k) => (x + b[k]) / 2);
  const rMid = (state.input.radii[i] + state.input.radii[Math.min(i + 1, n - 1)]) / 2;
  state.input.points.splice(i + 1, 0, mid);
  state.input.radii.splice(i + 1, 0, rMid);
  rebuildTables();
  selectRow(i + 1);
  recompute();
});

$('#delete-point').addEventListener('click', () => {
  if (state.input.points.length <= 2) { flashError('至少保留 2 个路径点'); return; }
  const i = state.selected;
  state.input.points.splice(i, 1);
  state.input.radii.splice(i, 1);
  rebuildTables();
  selectRow(Math.min(i, state.input.points.length - 1));
  recompute();
});

// ---------- 截面表 ----------
function renderProfileTable() {
  const tbody = $('#profile-body');
  tbody.innerHTML = '';
  state.input.profile.forEach((q, j) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="idx">${j}</td>
      <td><input data-k="0" inputmode="decimal" value="${fmt(q[0])}" aria-label="截面点 ${j} u"></td>
      <td><input data-k="1" inputmode="decimal" value="${fmt(q[1])}" aria-label="截面点 ${j} v"></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const tr = e.target.closest('tr');
      const j = Number([...tbody.children].indexOf(tr));
      const k = Number(e.target.dataset.k);
      const val = Number(e.target.value);
      if (!Number.isFinite(val)) { e.target.classList.add('bad'); return; }
      e.target.classList.remove('bad');
      state.input.profile[j][k] = val;
      recompute();
    });
  });
}

$('#add-profile').addEventListener('click', () => {
  if (state.input.profile.length >= 32) { flashError('截面最多 32 个点'); return; }
  const p = state.input.profile;
  const j = p.length - 1;
  const mid = [(p[j][0] + p[0][0]) / 2, (p[j][1] + p[0][1]) / 2];
  p.push(mid);
  renderProfileTable();
  recompute();
});
$('#delete-profile').addEventListener('click', () => {
  if (state.input.profile.length <= 3) { flashError('截面至少 3 个点'); return; }
  state.input.profile.pop();
  renderProfileTable();
  recompute();
});

// ---------- 全局开关 ----------
$('#closed-toggle').addEventListener('change', (e) => {
  state.input.closed = e.target.checked;
  // 闭合时端盖按拓扑不适用
  $('#caps-toggle').disabled = state.input.closed;
  if (state.input.closed) state.caps = false;
  else state.caps = $('#caps-toggle').checked;
  validateTwist();
  recompute();
});
$('#caps-toggle').addEventListener('change', (e) => {
  state.caps = e.target.checked;
  recompute();
});
$('#compensate-toggle').addEventListener('change', (e) => {
  state.compensate = e.target.checked;
  recompute();
});
$('#show-frames').addEventListener('change', (e) => {
  state.showFrames = e.target.checked;
  viewer.setShowFrames(state.showFrames);
  recompute();
});
$('#show-path').addEventListener('change', (e) => {
  state.showPath = e.target.checked;
  viewer.setShowPath(state.showPath);
  recompute();
});
$('#show-wire').addEventListener('change', (e) => {
  state.showWire = e.target.checked;
  viewer.setShowWire(state.showWire);
  recompute();
});

function syncControlCheckboxes() {
  $('#closed-toggle').checked = !!state.input.closed;
  $('#caps-toggle').checked = state.caps;
  $('#caps-toggle').disabled = !!state.input.closed;
  $('#compensate-toggle').checked = state.compensate;
  $('#show-frames').checked = state.showFrames;
  $('#show-path').checked = state.showPath;
  $('#show-wire').checked = state.showWire;
}

// ---------- 总扭转 ----------
const twistInput = $('#twist-input');
twistInput.addEventListener('change', () => {
  const v = Number(twistInput.value);
  if (!Number.isFinite(v)) { twistInput.classList.add('bad'); return; }
  twistInput.classList.remove('bad');
  state.input.twist = v;
  validateTwist();
  recompute();
});
$('#twist-pi').addEventListener('click', () => setTwist(Math.PI));
$('#twist-2pi').addEventListener('click', () => setTwist(2 * Math.PI));
$('#twist-zero').addEventListener('click', () => setTwist(0));
function setTwist(v) {
  twistInput.value = Number(v.toFixed(8)).toString();
  state.input.twist = v;
  validateTwist();
  recompute();
}
function validateTwist() {
  const hint = $('#twist-hint');
  if (state.input.closed) {
    const k = state.input.twist / (2 * Math.PI);
    const ok = Math.abs(k - Math.round(k)) < 1e-9 * (1 + Math.abs(k));
    hint.textContent = ok
      ? `闭合路径：${Math.round(k)} 整圈，接缝允许`
      : '闭合路径要求总扭转是 2π 的整数倍';
    hint.classList.toggle('bad', !ok);
  } else {
    hint.textContent = '开放路径按弧长线性分布到各环';
    hint.classList.remove('bad');
  }
}

// ---------- 诊断 ----------
function renderDiagnostics(r, inp) {
  const box = $('#diagnostics');
  const d = r.diagnostics;
  const parts = [];

  if (!r.valid) {
    box.innerHTML = '';
    d.errors.forEach((msg) => parts.push(diagItem('critical', '错误', msg)));
    d.zeroSegments.forEach((k) => parts.push(
      diagItem('critical', '零长段', `第 ${k} 段（点 ${k} → 点 ${(k + 1) % inp.points.length}）长度 < 1e-10`)));
    box.innerHTML = parts.join('');
    return;
  }

  // 框架跳变
  if (d.frameJumps.length) {
    d.frameJumps.forEach((j) => parts.push(diagItem(
      'warn', '框架跳变',
      `环 ${j.at}：相邻切线夹角 ${j.angleDeg.toFixed(2)}°（≥90°），已按平行移动规则翻转，无突然卷绕`)));
  } else {
    parts.push(diagItem('ok', '框架跳变', '无；相邻切线夹角均小于 90°'));
  }

  // 零长段
  if (d.zeroSegments.length) {
    d.zeroSegments.forEach((k) => parts.push(diagItem(
      'critical', '零长段', `第 ${k} 段长度低于 1e-10`)));
  } else {
    parts.push(diagItem('ok', '零长段', '无；所有连续段长度 ≥ 1e-10'));
  }

  // 退化面
  if (d.degenerateFaces.length) {
    const side = d.degenerateFaces.filter((f) => f.where === 'side').length;
    const cap = d.degenerateFaces.filter((f) => f.where === 'cap').length;
    parts.push(diagItem('warn', '退化面',
      `共 ${d.degenerateFaces.length} 个（叉积模 < 1e-12）：侧面 ${side}，端盖 ${cap}`));
  } else {
    parts.push(diagItem('ok', '退化面', '无；所有三角形叉积模 ≥ 1e-12'));
  }

  // 自交面（发夹弯导致的几何穿插）
  if (d.selfIntersectingFaces.length) {
    const rings = [...new Set(d.selfIntersectingFaces.map((f) => f.ring))].join('、');
    parts.push(diagItem('warn', '自交面',
      `${d.selfIntersectingFaces.length} 个侧面的几何法线指向管轴，位于环 ${rings} 附近；` +
      '路径在该处反向且半径大于转弯间隙，环面空间穿插，属几何自交而非绕序错误'));
  } else {
    parts.push(diagItem('ok', '自交面', '无；所有侧面几何法线均背离管轴'));
  }

  // 闭环接缝
  if (r.closed) {
    parts.push(diagItem(
      state.compensate ? 'ok' : 'warn', '闭环接缝',
      `自然扭角 ${d.seamTwistDeg.toFixed(4)}°` +
      (state.compensate ? '，已按 -h·s/L 逐环补偿，接缝标架重合' : '；补偿已关闭（诊断模式），接缝保留该扭角')));
  }

  box.innerHTML = parts.join('');
}

function diagItem(level, title, msg) {
  return `<div class="diag ${level}">
    <span class="diag-dot" aria-hidden="true"></span>
    <div><div class="diag-title">${title}</div><div class="diag-msg">${msg}</div></div>
  </div>`;
}

function renderStats(r) {
  const el = $('#stats');
  if (!r.valid) {
    el.innerHTML = '<span class="stat bad">模型无效</span>';
    return;
  }
  const totalV = r.sideVerts.length + r.capVerts.length;
  const totalT = r.sideTris.length + r.capTris.length;
  el.innerHTML = `
    <span class="stat">环 ${r.n}</span>
    <span class="stat">截面 ${r.m} 点</span>
    <span class="stat">顶点 ${totalV}</span>
    <span class="stat">三角形 ${totalT}</span>
    <span class="stat">弧长 ${r.arcLength.toFixed(4)}</span>
    ${r.closed ? `<span class="stat">接缝 ${r.diagnostics.seamTwistDeg.toFixed(3)}°</span>` : ''}`;
}

function flashError(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashError._t);
  flashError._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 导入 / 导出 ----------
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.points) || !Array.isArray(data.radii) || !Array.isArray(data.profile)) {
      throw new Error('缺少 points / radii / profile 字段');
    }
    state.input = {
      points: data.points, radii: data.radii, profile: data.profile,
      closed: !!data.closed, twist: Number(data.twist) || 0, caps: data.caps !== false,
    };
    state.selected = 0;
    state.caps = state.input.caps;
    $('#twist-input').value = state.input.twist;
    syncControlCheckboxes();
    rebuildTables();
    selectRow(0);
    validateTwist();
    recompute();
    viewer.frameView();
  } catch (err) {
    flashError(`导入失败：${err.message}`);
  } finally {
    e.target.value = '';
  }
});

function ensureValidForExport() {
  const r = state.lastResult ?? recompute();
  if (!r.valid) {
    flashError('模型存在错误，无法导出（见诊断面板）');
    return null;
  }
  return r;
}

$('#export-obj').addEventListener('click', () => {
  const r = ensureValidForExport();
  if (!r) return;
  downloadText('sweep.obj', toOBJ(r, 'parallel-transport-sweep'), 'text/plain');
});
$('#export-json').addEventListener('click', () => {
  const r = ensureValidForExport();
  if (!r) return;
  downloadText('sweep-frames.json',
    JSON.stringify(toJSON(r, currentModelInput()), null, 2), 'application/json');
});

// ---------- 视角 ----------
$('#frame-view').addEventListener('click', () => viewer.frameView());

// ---------- 主题 ----------
const themeBtn = $('#theme-toggle');
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeBtn.textContent = dark ? '浅色' : '暗色';
}
themeBtn.addEventListener('click', () => {
  const darkNow = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = darkNow ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('pts-theme', next); } catch { /* 私有模式忽略 */ }
});
try {
  const saved = localStorage.getItem('pts-theme');
  if (saved) applyTheme(saved); else applyTheme('system');
} catch { applyTheme('system'); }

// ---------- 启动 ----------
fillSampleSelect();
$('#sample-select').value = '0';
syncControlCheckboxes();
rebuildTables();
selectRow(0);
validateTwist();
recompute();
viewer.frameView();

// 暴露给控制台调试
window.__sweep = { buildSweep, state, THREE };
