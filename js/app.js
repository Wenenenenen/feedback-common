// 纤维方向图定向 —— 页面交互与 Canvas 渲染。
import {
  MAX_GRID, parseDirectorJSON, normalizeDocument, buildModel, solveModel, estimateDefects,
  planAnchors, orientWithAnchors, traceBetween, edgeDetail, describeAdjacency,
  buildSymbolRows, buildExportBundle, toCSV, idXY, cellId,
} from './directors.js';
import { buildSymbolSVG } from './exporters.js';
import { compColor, COLORS } from './palette.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  doc: null,
  model: null,
  canonical: null,        // {flips:Uint8Array,totalCost,components,engine,ms}
  viewFlips: null,        // 应用锚点后的翻向
  effective: new Map(),   // cid -> anchor
  anchorByComp: new Map(),
  conflicts: [],
  nextConflictId: 1,
  tool: 'inspect',
  layers: { edges: true, breaks: true, conf: true, comp: true, zero: false, coords: false },
  cam: { k: 16, ox: 0, oy: 0 },
  selCell: null,
  selEdge: null,
  adjInfo: null,
  hoverCell: null,
  hoverEdge: null,
  focusComp: null,
  pathHighlight: null,
  worker: null,
  workerReady: false,
};

const AUTO_ENGINE_DEFECT_LIMIT = 1000; // 单分量缺陷面 ≤ 此值自动精确求解；更大先询问（程序化 API 会强制）

// ---------------------------------------------------------------------------
// Toast / 下载
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, kind = '', ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
function getWorker() {
  if (state.worker !== null) return state.worker || undefined;
  try {
    const w = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const { kind, reqId } = ev.data;
      const pending = pendingSolves.get(reqId);
      if (!pending) return;
      pendingSolves.delete(reqId);
      if (kind === 'solved') pending.resolve(ev.data);
      else pending.reject(new Error(ev.data.message || 'worker error'));
    };
    w.onerror = (e) => {
      // Worker 不可用时退回主线程：拒绝所有挂起请求，runSolve 会兜底
      state.worker = false;
      for (const [id, p] of pendingSolves) { pendingSolves.delete(id); p.reject(new Error(e.message || 'worker error')); }
      toast('后台求解器不可用，已切换主线程求解', '', 2000);
    };
    state.worker = w;
    state.workerReady = true;
    return w;
  } catch {
    state.worker = false;
    return undefined;
  }
}
const pendingSolves = new Map();
let reqSeq = 1;

async function runSolve(doc, force = false) {
  const est = estimateDefects(buildModel(doc)); // 临时 build，很快；worker 内会再 build
  if (est.maxCompDefects > AUTO_ENGINE_DEFECT_LIMIT && !state.forceLargeSolve && !force) {
    return { needsLargeConfirm: true, estimate: est };
  }
  const w = getWorker();
  if (w) {
    const reqId = reqSeq++;
    try {
      const result = await new Promise((resolve, reject) => {
        pendingSolves.set(reqId, { resolve, reject });
        w.postMessage({ kind: 'solve-doc', reqId, payload: { doc } });
      });
      return result;
    } catch (err) {
      console.warn('Worker 求解失败：', err);
      // 大规模失败不再在主线程重跑一遍（可能再次耗尽内存）
      if (est.maxCompDefects > AUTO_ENGINE_DEFECT_LIMIT) throw err;
    }
  }
  // 主线程兜底（小规模）
  await new Promise((r) => setTimeout(r, 30));
  const model = buildModel(doc);
  const t0 = performance.now();
  const sol = solveModel(model);
  return {
    flips: Array.from(sol.flips), totalCost: sol.totalCost, components: sol.components,
    engine: sol.engine, ms: performance.now() - t0, estimate: estimateDefects(model),
  };
}

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------
async function loadObject(raw, sourceName = 'object', opts = {}) {
  const { doc, errors, warnings } = normalizeDocument(raw);
  const errBox = $('#import-errors');
  if (errors.length) {
    errBox.hidden = false;
    errBox.innerHTML = `<strong>导入失败（${errors.length} 个问题）：</strong><ul>` +
      errors.slice(0, 30).map((e) => `<li><code>${e.path}</code> — ${e.message}</li>`).join('') + `</ul>`;
    toast('JSON 校验失败，请查看问题列表', 'error');
    return { ok: false, errors };
  }
  errBox.hidden = true; errBox.innerHTML = '';
  if (warnings.length) console.warn('导入警告', warnings);

  state.doc = doc;
  state.model = buildModel(doc);
  state.canonical = null;   // 立即清空旧解，避免自动化/界面读到上一份代价
  state.viewFlips = null;
  state.anchorByComp = new Map();
  state.conflicts = [];
  state.selCell = null; state.selEdge = null; state.adjInfo = null;
  state.hoverCell = null; state.hoverEdge = null;
  $('#tooltip').hidden = true;
  state.focusComp = null; state.pathHighlight = null;
  if (!opts.keepForce) state.forceLargeSolve = false;

  // 初始锚点：单锚点分量直接生效；同分量多锚点 => 冲突，不自动覆盖
  const plan = planAnchors(state.model, new Uint8Array(state.model.size), doc.anchors || []);
  // 注意 planAnchors 需要 canonical flips 来算 impliedGauge；此时还没解。
  // impliedGauge 仅用于冲突内“一致/矛盾”判断，解完后会重新评估。先按原始符号暂存。
  for (const a of plan.accepted) state.anchorByComp.set(a.component, { x: a.x, y: a.y, sign: a.sign, i: a.i, source: a.source || 'import' });
  for (const c of plan.conflicts) {
    state.conflicts.push({
      id: state.nextConflictId++, cid: c.component, kind: 'import-multi',
      message: c.message, contradictory: c.contradictory,
      anchors: c.anchors.map((a) => ({ x: a.x, y: a.y, sign: a.sign, i: a.i })),
    });
  }

  $('#canvas-empty').hidden = true;
  $('#load-status').textContent = `${sourceName} · ${doc.width}×${doc.height} · ${state.model.activeIds.length} 个有效格 · ${state.model.components.length} 个分量`;
  fitCamera();
  renderAll();

  $('#stat-cost').textContent = '求解中…';
  const res = await runSolve(doc, !!opts.forceLarge);
  if (res && res.needsLargeConfirm) {
    $('#stat-cost').textContent = '待确认';
    $('#stat-engine').textContent = `缺陷面 ${res.estimate.maxCompDefects}（单分量）`;
    showLargeSolveNotice(res.estimate);
    return { ok: true, needsLargeConfirm: true };
  }
  applySolutionResult(res);
  return { ok: true, solution: getSerializableState() };
}

function applySolutionResult(res) {
  state.canonical = {
    flips: new Uint8Array(res.flips),
    totalCost: res.totalCost,
    components: res.components,
    engine: res.engine,
    ms: res.ms,
  };
  // 用真正的 canonical flips 重新评估导入冲突的“一致/矛盾”
  reevaluateConflictGauges();
  reorient();
  renderAll();
  const engText = res.engine === 'planar-dual-mwpm' ? '平面对偶+完美匹配' : res.engine;
  $('#stat-engine').textContent = `${engText} · ${res.ms.toFixed(0)} ms`;
  removeLargeSolveNotice();
}

function reevaluateConflictGauges() {
  if (!state.canonical) return;
  for (const c of state.conflicts) {
    const gauges = c.anchors.map((a) => state.canonical.flips[a.i] ^ (a.sign === -1 ? 1 : 0));
    c.contradictory = new Set(gauges).size > 1;
    c.anchors.forEach((a, i) => { a.impliedGauge = gauges[i]; });
    if (c.kind === 'import-multi') {
      c.message = c.contradictory
        ? `分量 ${compKey(c.cid)} 有 ${c.anchors.length} 个朝向互不一致的锚点；已保留默认/上一次结果，未自动覆盖`
        : `分量 ${compKey(c.cid)} 有 ${c.anchors.length} 个朝向一致但重复的锚点；每个分量只需一个锚点`;
    }
  }
}

function compKey(cid) { return state.model?.components[cid]?.key || `c${cid + 1}`; }

function reorient() {
  if (!state.canonical) { state.viewFlips = null; return; }
  const accepted = [...state.anchorByComp.entries()].map(([cid, a]) => ({ ...a, component: cid }));
  const o = orientWithAnchors(state.model, state.canonical.flips, accepted);
  state.viewFlips = o.flips;
  state.effective = o.effective;
}

function showLargeSolveNotice(est) {
  removeLargeSolveNotice();
  const box = $('.overview');
  const div = document.createElement('div');
  div.className = 'notice warn'; div.id = 'large-notice';
  div.innerHTML = `该场缺陷面很多（单分量 ${est.maxCompDefects} 个，共 ${est.defects}）。稠密精确匹配为 O(T³)，可能耗时较久并占用较多内存。常见连贯纤维场通常只有数个缺陷面。
    <div style="margin-top:7px;display:flex;gap:6px;">
      <button class="btn btn-small btn-primary" id="btn-force-solve">仍要求解全局最优</button>
    </div>`;
  box.appendChild(div);
  $('#btn-force-solve').onclick = async () => {
    state.forceLargeSolve = true;
    $('#stat-cost').textContent = '精确优化中…';
    const res = await runSolve(state.doc);
    applySolutionResult(res);
    toast('全局最优求解完成', 'success');
  };
}
function removeLargeSolveNotice() { $('#large-notice')?.remove(); }

// ---------------------------------------------------------------------------
// 锚点操作（事务性：冲突不覆盖现有结果）
// ---------------------------------------------------------------------------
function applyAnchorAt(x, y, sign) {
  if (!state.model) return { ok: false, reason: 'no-model' };
  const i = cellId(x, y, state.model.width);
  const cell = state.model.cells[i];
  if (!cell) { toast(`(${x},${y}) 是空格，不能设锚点`, 'error'); return { ok: false, reason: 'space' }; }
  const cid = state.model.compOfNode[i];
  const existing = state.anchorByComp.get(cid);

  if (!existing) {
    state.anchorByComp.set(cid, { x, y, sign, i, source: 'user' });
    // 清掉该分量可能存在的导入冲突（用户已显式指定）
    state.conflicts = state.conflicts.filter((c) => c.cid !== cid);
    reorient(); renderAll(); scheduleDraw();
    toast(`已在 ${compKey(cid)} 的 (${x},${y}) 设置 ${sign > 0 ? '保持 +1' : '翻转 −1'} 锚点`, 'success');
    return { ok: true };
  }
  if (existing.i === i) {
    existing.sign = sign; // 同格改朝向
    reorient(); renderAll(); scheduleDraw();
    return { ok: true, changed: true };
  }
  // 不同格且已有锚点 => 冲突，保留上次结果，不覆盖
  const conflict = {
    id: state.nextConflictId++, cid, kind: 'interactive',
    contradictory: true,
    message: `分量 ${compKey(cid)} 已有锚点 (${existing.x},${existing.y},${existing.sign > 0 ? '+' : '−'})；新锚点 (${x},${y},${sign > 0 ? '+' : '−'}) 与之构成同分量多锚点冲突。当前定向结果保持不变。`,
    anchors: [
      { x: existing.x, y: existing.y, sign: existing.sign, i: existing.i },
      { x, y, sign, i },
    ],
  };
  if (state.canonical) reevaluateOne(conflict);
  state.conflicts.push(conflict);
  renderConflicts(); renderAnchors();
  toast('同分量多个锚点：已定位冲突，未覆盖上次结果', 'error', 3400);
  return { ok: false, conflict };
}
function reevaluateOne(c) {
  const gauges = c.anchors.map((a) => state.canonical.flips[a.i] ^ (a.sign === -1 ? 1 : 0));
  c.anchors.forEach((a, i) => { a.impliedGauge = gauges[i]; });
  c.contradictory = new Set(gauges).size > 1;
}
function removeAnchor(cid) {
  state.anchorByComp.delete(cid);
  reorient(); renderAll(); scheduleDraw();
}
function adoptConflictAnchor(conflictId, anchorIdx) {
  const c = state.conflicts.find((x) => x.id === conflictId);
  if (!c) return;
  const a = c.anchors[anchorIdx];
  state.anchorByComp.set(c.cid, { x: a.x, y: a.y, sign: a.sign, i: a.i, source: 'user' });
  state.conflicts = state.conflicts.filter((x) => x.id !== conflictId);
  reorient(); renderAll(); scheduleDraw();
  toast(`已采用锚点 (${a.x},${a.y},${a.sign > 0 ? '+' : '−'})`, 'success');
}
function dismissConflict(conflictId) {
  state.conflicts = state.conflicts.filter((x) => x.id !== conflictId);
  renderConflicts();
}
function locateConflict(conflictId) {
  const c = state.conflicts.find((x) => x.id === conflictId);
  if (!c || c.anchors.length < 2) {
    if (c) focusOnPoint(c.anchors[0].x, c.anchors[0].y);
    return;
  }
  const [a, b] = c.anchors;
  let trace = null;
  if (state.viewFlips) {
    const tr = traceBetween(state.model, state.viewFlips, a.i, b.i);
    if (tr.reachable) {
      state.pathHighlight = { cells: new Set(tr.pathCells), edges: new Set(tr.pathEdges) };
      trace = tr;
    }
  }
  // 视野框住两个锚点
  const xs = c.anchors.map((q) => q.x), ys = c.anchors.map((q) => q.y);
  fitBounds(Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 2, Math.max(...ys) + 2);
  state.selCell = b.i;
  switchTab('inspect');
  renderAll(); scheduleDraw();
  if (trace) renderTraceDetail(c, trace); // renderAll 会重建冲突卡片，故在其后填充路径
}

// ---------------------------------------------------------------------------
// 渲染：面板
// ---------------------------------------------------------------------------
function renderAll() {
  renderOverview();
  renderAnchors();
  renderConflicts();
  renderComponents();
  renderViolated();
  renderCellDetail();
  renderEdgeDetail();
  scheduleDraw();
}
function renderOverview() {
  if (!state.model) return;
  const m = state.model;
  $('#stat-cells').textContent = `${m.activeIds.length} / ${m.size - m.activeIds.length}`;
  $('#stat-comps').textContent = m.components.length;
  $('#stat-edges').textContent = m.edges.length;
  if (state.canonical) {
    $('#stat-cost').textContent = state.canonical.totalCost.toLocaleString('zh-CN');
    const nBad = state.canonical.components.reduce((a, c) => a + c.violated.length, 0);
    $('#stat-violated').textContent = nBad;
    $('#tab-bad-count').textContent = nBad;
  }
  $('#tab-comp-count').textContent = m.components.length;
}
function renderAnchors() {
  const box = $('#anchor-list');
  if (!state.model) { box.innerHTML = ''; return; }
  const chips = [];
  for (const [cid, a] of state.anchorByComp) {
    chips.push(`<div class="anchor-chip" data-testid="anchor-chip">
      <span class="sig">${a.sign > 0 ? '+1 保持' : '−1 翻转'}</span>
      <span class="grow">${compKey(cid)} · 格 (${a.x}, ${a.y})</span>
      <button data-action="remove-anchor" data-cid="${cid}" title="移除锚点" aria-label="移除锚点">✕</button>
    </div>`);
  }
  const anchored = state.anchorByComp.size;
  chips.push(`<div class="anchor-chip default"><span class="sig">默认</span><span class="grow">其余 ${state.model.components.length - anchored} 个分量：行列最小格不翻</span></div>`);
  box.innerHTML = chips.join('');
}
function renderConflicts() {
  const box = $('#conflict-list');
  if (!state.conflicts.length) { box.innerHTML = ''; return; }
  box.innerHTML = state.conflicts.map((c) => {
    const locBtns = c.anchors.map((a, ai) =>
      `<button class="btn-mini" data-action="cf-locate-one" data-cid="${c.id}" data-ai="${ai}">定位 (${a.x},${a.y})</button>`).join('');
    const adoptBtns = c.anchors.map((a, ai) =>
      `<button class="btn-mini" data-action="cf-adopt" data-cid="${c.id}" data-ai="${ai}">采用 ${a.sign > 0 ? '+' : '−'}@(${a.x},${a.y})</button>`).join('');
    return `<div class="conflict ${c.contradictory ? 'error' : 'warning'}" data-testid="conflict-item" data-conflict-id="${c.id}">
      <div class="cf-title">${c.contradictory ? '⛔' : '⚠️'} 同分量多锚点冲突 · ${compKey(c.cid)}</div>
      <div>${c.message}</div>
      <div class="cf-anchors">${c.anchors.map((a) => `[${a.x},${a.y},${a.sign}]`).join('  vs  ')}</div>
      <div class="cf-actions">
        <button class="btn-mini" data-action="cf-locate" data-cid="${c.id}">定位冲突路径</button>
        ${locBtns}
        ${adoptBtns}
        <button class="btn-mini" data-action="cf-dismiss" data-cid="${c.id}">保留现状/关闭</button>
      </div>
      <div class="cf-trace" data-trace="${c.id}"></div>
    </div>`;
  }).join('');
}
function renderTraceDetail(c, tr) {
  const host = document.querySelector(`[data-trace="${c.id}"]`);
  if (!host) return;
  host.innerHTML = `<div class="notice info" style="margin-bottom:0">
    ${tr.note}<br/>路径 ${tr.pathCells.length} 格 / ${tr.pathEdges.length} 边；
    偏好奇偶=${tr.preferredParity}，两端实际翻向异或=${tr.actualParity}，
    路上违反边 ${tr.violatedOnPath.length} 条。
  </div>`;
}
function renderComponents() {
  const box = $('#component-list');
  if (!state.model) { box.innerHTML = ''; return; }
  box.innerHTML = state.model.components.map((comp) => {
    const csol = state.canonical?.components[comp.id];
    const anchor = state.anchorByComp.get(comp.id);
    const cost = csol ? csol.cost : '…';
    const nbad = csol ? csol.violated.length : 0;
    const sel = state.focusComp === comp.id ? 'selected' : '';
    return `<div class="entity ${sel}" data-action="focus-comp" data-cid="${comp.id}" data-testid="component-row">
      <div class="e-top">
        <span class="dotc" style="background:${compColor(comp.id)}"></span>
        <span class="e-title">${comp.key}</span>
        <span class="e-meta">${comp.nodes.length} 格 · root(${comp.rootXY.x},${comp.rootXY.y})</span>
        <span class="e-cost">${typeof cost === 'number' ? cost.toLocaleString('zh-CN') : cost}</span>
      </div>
      <div class="e-meta">
        ${anchor ? `⚓ 锚点 (${anchor.x},${anchor.y},${anchor.sign > 0 ? '+' : '−'})` : '默认 root 不翻'}
        · 断线 ${nbad} · 缺陷面 ${csol?.defectCount ?? '…'}
      </div>
    </div>`;
  }).join('');
}
function renderViolated() {
  const box = $('#violated-list');
  if (!state.model || !state.canonical) { box.innerHTML = '<p class="muted small">求解后列出。</p>'; return; }
  const rows = [];
  for (const csol of state.canonical.components) for (const eid of csol.violated) {
    const d = edgeDetail(state.model, state.viewFlips || state.canonical.flips, eid);
    rows.push(d);
  }
  rows.sort((a, b) => b.weight - a.weight);
  if (!rows.length) { box.innerHTML = '<div class="notice info">当前最优解没有被违反边（零断线）。</div>'; return; }
  box.innerHTML = rows.map((d) => `<div class="entity ${state.selEdge === d.id ? 'selected' : ''}" data-action="select-edge" data-eid="${d.id}" data-testid="violated-row">
    <div class="e-top">
      <span class="tag bad">违反</span>
      <span class="e-title">(${d.ax},${d.ay})–(${d.bx},${d.by})</span>
      <span class="e-cost">${d.chargedCost.toLocaleString('zh-CN')}</span>
    </div>
    <div class="e-meta">点积 ${d.dot} · ${d.preferenceText} · ${d.actualRelationText} · |dot|×minConf=${d.weight.toLocaleString('zh-CN')}</div>
  </div>`).join('');
}

function renderCellDetail() {
  const box = $('#cell-detail');
  if (state.selCell == null || !state.model) {
    box.innerHTML = `<h3>格检查</h3><p class="muted small">在“检查”工具下单击任意格；用锚点工具单击格可指定朝向。</p>`;
    return;
  }
  const m = state.model, i = state.selCell, c = m.cells[i];
  if (!c) { box.innerHTML = `<h3>格 (${i % m.width},${Math.floor(i / m.width)})</h3><span class="tag gray">空格 / 缺测孔</span><p class="muted small">空格不参与任何连接。</p>`; return; }
  const s = state.viewFlips ? state.viewFlips[i] : 0;
  const cid = m.compOfNode[i];
  const anchor = state.anchorByComp.get(cid);
  const isAnchor = anchor && anchor.i === i;
  const glyph = glyphOf(c.dx, c.dy, s);
  const incident = m.nodeEdges[i].map((eid) => {
    const e = m.edges[eid];
    const other = e.a === i ? { x: e.bx, y: e.by } : { x: e.ax, y: e.ay };
    const d = state.viewFlips ? edgeDetail(m, state.viewFlips, eid) : null;
    const bad = d?.violated ? 'bad' : '';
    return `<button class="edge-pill ${bad}" data-action="select-edge" data-eid="${eid}">边→(${other.x},${other.y})${bad ? ' ✕' : ''}</button>`;
  }).join('');
  box.innerHTML = `<h3>格 (${c.x}, ${c.y}) <span style="font-size:20px">${glyph}</span></h3>
    <dl class="kv">
      <dt>原始向量</dt><dd>[${c.dx}, ${c.dy}]</dd>
      <dt>置信度</dt><dd>${c.conf} / 255</dd>
      <dt>所属分量</dt><dd>${compKey(cid)}${state.focusComp === cid ? '（列表聚焦中）' : ''}</dd>
      <dt>翻向</dt><dd>${s ? '<span class="tag bad">反转 −1</span>' : '<span class="tag good">保持 +1</span>'}</dd>
      <dt>定向向量</dt><dd>${s ? `[${-c.dx}, ${-c.dy}]` : `[${c.dx}, ${c.dy}]`}</dd>
      <dt>锚点</dt><dd>${isAnchor ? `<span class="tag info">指定 ${anchor.sign > 0 ? '+1' : '−1'}</span>` : (anchor ? `本分量锚点在 (${anchor.x},${anchor.y})` : '未指定（默认 root 不翻）')}</dd>
    </dl>
    <h3 style="margin-top:10px">四邻边（点击跟踪）</h3>
    <div class="incident">${incident || '<span class="muted small">无正代价连接边（孤立格）</span>'}</div>`;
}
function glyphOf(dx, dy, flip) {
  // 轻量内联，避免循环依赖问题
  let x = flip ? -dx : dx, y = flip ? -dy : dy;
  let ang = Math.atan2(y, x) * 180 / Math.PI; if (ang < 0) ang += 360;
  const g = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  return g[((Math.round(ang / 45) % 8) + 8) % 8];
}

function renderEdgeDetail() {
  const box = $('#edge-detail');
  if (state.adjInfo) {
    const a = state.adjInfo;
    box.innerHTML = `<h3>邻格跟踪 · (${a.x1},${a.y1})–(${a.x2},${a.y2})</h3>
      <span class="tag gray">未连接</span>
      <p>${a.message}</p>
      ${a.dot !== undefined ? `<dl class="kv"><dt>原点积</dt><dd>${a.dot}</dd><dt>较小置信度</dt><dd>${a.minConf}</dd><dt>若违反代价</dt><dd>${a.weight}</dd></dl>` : ''}`;
    return;
  }
  if (state.selEdge == null || !state.model || !state.viewFlips) {
    box.innerHTML = `<h3>边跟踪</h3><p class="muted small">单击相邻格之间的边，查看原点积、偏好、两端实际翻向及代价。</p>`;
    return;
  }
  const d = edgeDetail(state.model, state.viewFlips, state.selEdge);
  if (!d) return;
  box.innerHTML = `<h3>边 #${d.id} · (${d.ax},${d.ay})–(${d.bx},${d.by})</h3>
    <p>${d.violated ? '<span class="tag bad">违反偏好 = 断线</span>' : '<span class="tag good">满足偏好</span>'}
       <span class="tag info">${d.preference === 'same-flip' ? '偏好同翻' : '偏好异翻'}</span></p>
    <dl class="kv">
      <dt>原向量 A</dt><dd>[${d.va[0]}, ${d.va[1]}]（conf ${d.ca}）</dd>
      <dt>原向量 B</dt><dd>[${d.vb[0]}, ${d.vb[1]}]（conf ${d.cb}）</dd>
      <dt>原点积</dt><dd><strong>${d.dot}</strong>（${d.dot > 0 ? '为正' : '为负'}）</dd>
      <dt>偏好</dt><dd>${d.preferenceText}</dd>
      <dt>代价权重</dt><dd>|${d.dot}| × min(${d.ca},${d.cb}) = <strong>${d.weight.toLocaleString('zh-CN')}</strong></dd>
      <dt>A 实际翻向</dt><dd>${d.flipAText}（s=${d.flipA}）</dd>
      <dt>B 实际翻向</dt><dd>${d.flipBText}（s=${d.flipB}）</dd>
      <dt>实际翻向关系</dt><dd>${d.actualRelationText}（sA⊕sB=${d.flipA ^ d.flipB}）</dd>
      <dt>定向后点积</dt><dd>${d.outputDot}</dd>
      <dt>是否违反</dt><dd>${d.violated ? '是 r=1' : '否 r=0'}</dd>
      <dt>计入代价</dt><dd><strong>${d.chargedCost.toLocaleString('zh-CN')}</strong></dd>
    </dl>`;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
const canvas = $('#view');
const ctx = canvas.getContext('2d');
const wrap = $('#canvas-wrap');
let dpr = Math.min(window.devicePixelRatio || 1, 2);

function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  scheduleDraw();
}
new ResizeObserver(resizeCanvas).observe(wrap);

function fitCamera() {
  if (!state.model) return;
  const w = wrap.clientWidth || 800, h = wrap.clientHeight || 500;
  const k = Math.max(4, Math.min((w - 56) / state.model.width, (h - 56) / state.model.height, 108));
  state.cam.k = k;
  state.cam.ox = (w - state.model.width * k) / 2;
  state.cam.oy = (h - state.model.height * k) / 2;
  $('#zoom-label').textContent = `${Math.round(k)}px/格`;
  scheduleDraw();
}
function fitBounds(minX, minY, maxX, maxY) {
  if (!state.model) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const k = Math.max(4, Math.min((w - 80) / bw, (h - 80) / bh, 80));
  state.cam.k = k;
  state.cam.ox = (w - (minX + bw / 2) * k) / 2 + (w / 2 - ((minX + maxX) / 2) * k);
  state.cam.ox = w / 2 - ((minX + maxX) / 2) * k;
  state.cam.oy = h / 2 - ((minY + maxY) / 2) * k;
  $('#zoom-label').textContent = `${Math.round(k)}px/格`;
  scheduleDraw();
}
function focusOnPoint(x, y) { fitBounds(x - 2, y - 2, x + 3, y + 3); }

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state.model) return;
  const m = state.model, k = state.cam.k, ox = state.cam.ox, oy = state.cam.oy;
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;
  const CX = (x) => ox + (x + 0.5) * k, CY = (y) => oy + (y + 0.5) * k;
  const flips = state.viewFlips || state.canonical?.flips || new Uint8Array(m.size);
  const badSet = new Set();
  if (state.canonical) for (const cs of state.canonical.components) for (const e of cs.violated) badSet.add(e);

  // 格底
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    const c = m.cells[cellId(x, y, m.width)];
    const px = X(x) + 1, py = Y(y) + 1, s = k - 2;
    if (!c) {
      ctx.fillStyle = '#eef1f6';
      roundRect(px, py, s, s, Math.min(6, k * 0.18)); ctx.fill();
      if (k > 13) {
        ctx.strokeStyle = COLORS.spaceLine; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        roundRect(px + 1, py + 1, s - 2, s - 2, 5); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle = '#cdd6e5'; ctx.beginPath();
        ctx.moveTo(px + s * .32, py + s * .32); ctx.lineTo(px + s * .68, py + s * .68);
        ctx.moveTo(px + s * .68, py + s * .32); ctx.lineTo(px + s * .32, py + s * .68); ctx.stroke();
      }
      continue;
    }
    const cid = m.compOfNode[c.i];
    if (state.layers.comp) {
      ctx.fillStyle = hexA(compColor(cid), state.focusComp != null && state.focusComp !== cid ? 0.03 : 0.09);
      roundRect(px, py, s, s, Math.min(7, k * 0.2)); ctx.fill();
    }
  }

  // 零代价未连接邻格
  if (state.layers.zero) {
    ctx.strokeStyle = 'rgba(122,134,156,.55)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    for (const ze of getZeroAdj(m)) {
      ctx.beginPath(); ctx.moveTo(CX(ze.ax), CY(ze.ay)); ctx.lineTo(CX(ze.bx), CY(ze.by)); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 普通偏好边
  if (state.layers.edges) {
    ctx.lineWidth = Math.max(1, k * 0.05);
    for (const e of m.edges) {
      if (badSet.has(e.id)) continue;
      const dim = state.focusComp != null && m.compOfNode[e.a] !== state.focusComp;
      ctx.strokeStyle = dim ? 'rgba(154,167,189,.18)' : 'rgba(120,134,160,.5)';
      ctx.beginPath(); ctx.moveTo(CX(e.ax), CY(e.ay)); ctx.lineTo(CX(e.bx), CY(e.by)); ctx.stroke();
    }
  }

  // 路径高亮
  if (state.pathHighlight) {
    ctx.strokeStyle = hexA(COLORS.violet || '#6a4ce2', .9); ctx.lineWidth = Math.max(3, k * 0.16);
    ctx.lineCap = 'round';
    for (const eid of state.pathHighlight.edges) {
      const e = m.edges[eid]; if (!e) continue;
      ctx.beginPath(); ctx.moveTo(CX(e.ax), CY(e.ay)); ctx.lineTo(CX(e.bx), CY(e.by)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // 违反边（断线）
  if (state.layers.breaks) {
    for (const eid of badSet) {
      const e = m.edges[eid];
      const x1 = CX(e.ax), y1 = CY(e.ay), x2 = CX(e.bx), y2 = CY(e.by);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const gap = Math.min(k * 0.22, 9);
      ctx.strokeStyle = COLORS.bad; ctx.lineWidth = Math.max(1.6, k * 0.1);
      ctx.setLineDash([Math.max(3, k * .12), Math.max(2, k * .08)]);
      ctx.beginPath(); ctx.moveTo(x1 + ux * 2, y1 + uy * 2); ctx.lineTo(mx - ux * gap, my - uy * gap); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2 - ux * 2, y2 - uy * 2); ctx.lineTo(mx + ux * gap, my + uy * gap); ctx.stroke();
      ctx.setLineDash([]);
      if (k > 12) {
        const r = Math.max(6, k * 0.17);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = COLORS.bad; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = COLORS.badStrong; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(mx - r * .4, my - r * .4); ctx.lineTo(mx + r * .4, my + r * .4);
        ctx.moveTo(mx + r * .4, my - r * .4); ctx.lineTo(mx - r * .4, my + r * .4);
        ctx.stroke(); ctx.lineCap = 'butt';
      } else {
        ctx.fillStyle = COLORS.bad; ctx.beginPath(); ctx.arc(mx, my, Math.max(2.5, k * .09), 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // hover / selected edge
  drawEdgeHighlight(state.hoverEdge, 'rgba(37,99,201,.35)', Math.max(6, k * .22));
  drawEdgeHighlight(state.selEdge, 'rgba(242,166,0,.55)', Math.max(7, k * .26));

  // 箭头
  const L = k * 0.3;
  for (const c of m.cells) {
    if (!c) continue;
    const dim = state.focusComp != null && m.compOfNode[c.i] !== state.focusComp;
    const s = flips[c.i];
    let vx = c.dx, vy = c.dy; if (s) { vx = -vx; vy = -vy; }
    const nrm = Math.hypot(vx, vy) || 1; const ux = vx / nrm, uy = vy / nrm;
    const x = CX(c.x), y = CY(c.y);
    const q = Math.sqrt(c.conf / 255); // 感知缩放，避免低置信样例箭头完全消失
    const alpha = dim ? 0.16 : (state.layers.conf ? 0.6 + 0.4 * q : 0.95);
    const lw = state.layers.conf ? 1.3 + 2.3 * q : 2;
    drawArrow(x, y, ux, uy, L, lw, `rgba(27,36,48,${alpha.toFixed(3)})`, k);
  }

  // 选中/hover 格框
  if (state.hoverCell != null) drawCellBox(state.hoverCell, 'rgba(37,99,201,.55)', 1.6);
  if (state.selCell != null) drawCellBox(state.selCell, COLORS.primary, 2.6);
  if (state.pathHighlight) for (const i of state.pathHighlight.cells) drawCellBox(i, '#6a4ce2', 2.2);

  // 锚点与默认 root
  m.components.forEach((comp, cid) => {
    const a = state.effective.get(cid);
    const target = a ? m.cells[a.i] : m.cells[comp.root];
    if (!target) return;
    const x = CX(target.x) + k * .34, y = CY(target.y) - k * .34;
    if (a) {
      const r = Math.max(6.5, k * .2);
      ctx.fillStyle = COLORS.anchor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (k > 11) {
        ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.max(9, r * 1.25)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(a.sign > 0 ? '+' : '−', x, y + .5);
      }
    } else if (k > 15) {
      const r = Math.max(4, k * .13);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = COLORS.root; ctx.lineWidth = 2;
      roundRect(x - r, y - r, r * 2, r * 2, 3); ctx.fill(); ctx.stroke();
    }
  });

  // 坐标
  if (state.layers.coords && k > 26) {
    ctx.fillStyle = 'rgba(70,83,106,.85)'; ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      if (x % Math.ceil(260 / k) === 0 && y % Math.ceil(260 / k) === 0)
        ctx.fillText(`${x},${y}`, X(x) + 3, Y(y) + 2);
    }
  }
}

function drawEdgeHighlight(eid, color, width) {
  if (eid == null || !state.model) return;
  const e = state.model.edges[eid]; if (!e) return;
  const k = state.cam.k, ox = state.cam.ox, oy = state.cam.oy;
  const CX = (x) => ox + (x + .5) * k, CY = (y) => oy + (y + .5) * k;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(CX(e.ax), CY(e.ay)); ctx.lineTo(CX(e.bx), CY(e.by)); ctx.stroke();
  ctx.lineCap = 'butt';
}
function drawCellBox(i, color, lw) {
  const m = state.model; if (i == null || i < 0 || i >= m.size) return;
  const { x, y } = idXY(i, m.width);
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return;
  const k = state.cam.k, ox = state.cam.ox, oy = state.cam.oy;
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  roundRect(ox + x * k + 1.5, oy + y * k + 1.5, k - 3, k - 3, Math.min(7, k * .2)); ctx.stroke();
}
function drawArrow(x, y, ux, uy, L, lw, color, k) {
  const tx = x + ux * L, ty = y + uy * L;
  const bx = x - ux * L * .7, by = y - uy * L * .7;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx - ux * L * .28, ty - uy * L * .28); ctx.stroke();
  const hs = Math.max(3, k * .13);
  const px = -uy, py = ux;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - ux * hs * 1.5 + px * hs * .75, ty - uy * hs * 1.5 + py * hs * .75);
  ctx.lineTo(tx - ux * hs * 1.5 - px * hs * .75, ty - uy * hs * 1.5 - py * hs * .75);
  ctx.closePath(); ctx.fill();
  ctx.lineCap = 'butt';
}
function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function getZeroAdj(m) {
  if (m._zeroAdj) return m._zeroAdj;
  const list = [];
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    const a = m.cells[cellId(x, y, m.width)]; if (!a) continue;
    for (const [x2, y2] of [[x + 1, y], [x, y + 1]]) {
      if (x2 >= m.width || y2 >= m.height) continue;
      const b = m.cells[cellId(x2, y2, m.width)]; if (!b) continue;
      const info = describeAdjacency(m, x, y, x2, y2);
      if (!info.connected) list.push({ ax: x, ay: y, bx: x2, by: y2 });
    }
  }
  m._zeroAdj = list; return list;
}

// ---------------------------------------------------------------------------
// 指针 / 缩放 / 平移 / 命中
// ---------------------------------------------------------------------------
function eventPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { mx: ev.clientX - r.left, my: ev.clientY - r.top };
}
function cellAt(mx, my) {
  if (!state.model) return null;
  const gx = (mx - state.cam.ox) / state.cam.k, gy = (my - state.cam.oy) / state.cam.k;
  const x = Math.floor(gx), y = Math.floor(gy);
  if (x < 0 || y < 0 || x >= state.model.width || y >= state.model.height) return null;
  return cellId(x, y, state.model.width);
}
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const x = x1 + t * dx, y = y1 + t * dy;
  return Math.hypot(px - x, py - y);
}
function edgeAt(mx, my, cellI) {
  const m = state.model; if (!m || cellI == null) return null;
  const k = state.cam.k;
  const CX = (x) => state.cam.ox + (x + .5) * k, CY = (y) => state.cam.oy + (y + .5) * k;
  let best = null, bestD = Math.max(6, k * .18);
  const cand = new Set(m.nodeEdges[cellI]);
  const { x, y } = idXY(cellI, m.width);
  for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
    if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
    const nid = cellId(nx, ny, m.width);
    if (m.cells[nid]) for (const eid of m.nodeEdges[nid]) cand.add(eid);
  }
  for (const eid of cand) {
    const e = m.edges[eid];
    const x1 = CX(e.ax), y1 = CY(e.ay), x2 = CX(e.bx), y2 = CY(e.by);
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    let t = l2 ? ((mx - x1) * dx + (my - y1) * dy) / l2 : 0;
    // 只把边的中段算作“点边”，两端格中心留给“点格”
    if (t < 0.22 || t > 0.78) continue;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy;
    const d = Math.hypot(mx - px, my - py);
    if (d < bestD) { bestD = d; best = eid; }
  }
  return best;
}

let pointer = null;
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointer = { sx: ev.clientX, sy: ev.clientY, ox: state.cam.ox, oy: state.cam.oy, moved: false, t: Date.now() };
  wrap.classList.add('panning');
});
canvas.addEventListener('pointermove', (ev) => {
  const { mx, my } = eventPos(ev);
  if (pointer) {
    const dx = ev.clientX - pointer.sx, dy = ev.clientY - pointer.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) pointer.moved = true;
    if (pointer.moved) { state.cam.ox = pointer.ox + dx; state.cam.oy = pointer.oy + dy; scheduleDraw(); return; }
  }
  if (!state.model) return;
  const ci = cellAt(mx, my);
  state.hoverCell = ci;
  const ei = edgeAt(mx, my, ci);
  state.hoverEdge = ei;
  updateTooltip(mx, my, ci, ei);
  scheduleDraw();
});
canvas.addEventListener('pointerup', (ev) => {
  wrap.classList.remove('panning');
  if (!pointer) return;
  const wasClick = !pointer.moved && Date.now() - pointer.t < 600;
  pointer = null;
  if (!wasClick || !state.model) return;
  const { mx, my } = eventPos(ev);
  const ci = cellAt(mx, my);
  if (ci == null) return;
  if (state.tool.startsWith('anchor')) {
    const sign = Number(state.tool.split(':')[1]);
    const { x, y } = idXY(ci, state.model.width);
    applyAnchorAt(x, y, sign);
    return;
  }
  // inspect：优先边
  const ei = edgeAt(mx, my, ci);
  if (ei != null) {
    state.selEdge = ei; state.adjInfo = null;
    renderEdgeDetail(); renderViolated(); scheduleDraw();
  } else {
    state.selCell = ci;
    // 若点在格边缘，给出与相邻格的“未连接原因”
    maybeAdjInfo(ci, mx, my);
    renderCellDetail(); renderEdgeDetail(); renderViolated(); scheduleDraw();
  }
});
canvas.addEventListener('pointerleave', () => {
  state.hoverCell = null; state.hoverEdge = null; $('#tooltip').hidden = true; scheduleDraw();
});
canvas.addEventListener('wheel', (ev) => {
  if (!state.model) return;
  ev.preventDefault();
  const { mx, my } = eventPos(ev);
  const factor = Math.exp(-ev.deltaY * 0.0012);
  zoomAt(mx, my, factor);
}, { passive: false });

function zoomAt(mx, my, factor) {
  const k0 = state.cam.k;
  const k1 = Math.max(3.5, Math.min(120, k0 * factor));
  const gx = (mx - state.cam.ox) / k0, gy = (my - state.cam.oy) / k0;
  state.cam.k = k1;
  state.cam.ox = mx - gx * k1; state.cam.oy = my - gy * k1;
  $('#zoom-label').textContent = `${Math.round(k1)}px/格`;
  scheduleDraw();
}
function maybeAdjInfo(ci, mx, my) {
  const m = state.model, k = state.cam.k;
  const { x, y } = idXY(ci, m.width);
  const cx = state.cam.ox + (x + .5) * k, cy = state.cam.oy + (y + .5) * k;
  const dx = mx - cx, dy = my - cy;
  let nx = x, ny = y;
  if (Math.abs(dx) > Math.abs(dy)) nx += dx > 0 ? 1 : -1;
  else ny += dy > 0 ? 1 : -1;
  if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) { state.adjInfo = null; return; }
  const info = describeAdjacency(m, x, y, nx, ny);
  state.adjInfo = info.connected ? null : info;
  if (info.connected) state.selEdge = info.edge.id;
}

function updateTooltip(mx, my, ci, ei) {
  const tt = $('#tooltip');
  if (ei != null && state.viewFlips) {
    const d = edgeDetail(state.model, state.viewFlips, ei);
    tt.hidden = false;
    tt.style.left = `${Math.min(mx + 14, wrap.clientWidth - 280)}px`;
    tt.style.top = `${my + 14}px`;
    tt.textContent =
      `边 (${d.ax},${d.ay})–(${d.bx},${d.by})\n` +
      `原点积=${d.dot}  ${d.preference === 'same-flip' ? '偏好同翻' : '偏好异翻'}\n` +
      `实际${d.actualRelation === 'same-flip' ? '同翻' : '异翻'} · ` +
      (d.violated ? `违反！代价 ${d.chargedCost}` : '满足 · 代价 0');
    return;
  }
  if (ci != null) {
    const c = state.model.cells[ci];
    tt.hidden = false;
    tt.style.left = `${Math.min(mx + 14, wrap.clientWidth - 260)}px`;
    tt.style.top = `${my + 14}px`;
    tt.textContent = c
      ? `格 (${c.x},${c.y}) [${c.dx},${c.dy}] conf=${c.conf} ${compKey(state.model.compOfNode[ci])}`
      : `格 (${Math.floor((mx - state.cam.ox) / state.cam.k)},…) 空格`;
    return;
  }
  tt.hidden = true;
}

// ---------------------------------------------------------------------------
// 全局事件绑定
// ---------------------------------------------------------------------------
$$('.seg[data-tool]').forEach((b) => b.addEventListener('click', () => {
  $$('.seg[data-tool]').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.tool = b.dataset.tool;
  wrap.className = 'canvas-wrap ' + (state.tool === 'inspect' ? 'tool-inspect' : 'tool-anchor');
  canvas.style.cursor = state.tool === 'inspect' ? 'default' : 'crosshair';
}));
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}
$('#zoom-in').onclick = () => zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1.2);
$('#zoom-out').onclick = () => zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1 / 1.2);
$('#zoom-fit').onclick = fitCamera;

for (const key of ['edges', 'breaks', 'conf', 'comp', 'zero', 'coords']) {
  const el = $(`#layer-${key}`);
  el.checked = state.layers[key];
  el.addEventListener('change', () => { state.layers[key] = el.checked; scheduleDraw(); });
}

// 事件委托：data-action
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  if (act === 'remove-anchor') removeAnchor(Number(el.dataset.cid));
  else if (act === 'cf-dismiss') dismissConflict(Number(el.dataset.cid));
  else if (act === 'cf-locate') locateConflict(Number(el.dataset.cid));
  else if (act === 'cf-locate-one') {
    const c = state.conflicts.find((x) => x.id === Number(el.dataset.cid));
    const a = c?.anchors[Number(el.dataset.ai)];
    if (a) { state.selCell = a.i; focusOnPoint(a.x, a.y); switchTab('inspect'); renderAll(); }
  }
  else if (act === 'cf-adopt') adoptConflictAnchor(Number(el.dataset.cid), Number(el.dataset.ai));
  else if (act === 'focus-comp') {
    const cid = Number(el.dataset.cid);
    state.focusComp = state.focusComp === cid ? null : cid;
    const comp = state.model.components[cid];
    if (state.focusComp === cid) fitBounds(comp.rootXY.x - 1, comp.rootXY.y - 1, comp.rootXY.x + 2, comp.rootXY.y + 2);
    renderComponents(); scheduleDraw();
  }
  else if (act === 'select-edge') {
    const eid = Number(el.dataset.eid);
    state.selEdge = eid; state.adjInfo = null;
    const e = state.model.edges[eid];
    if (e) { state.selCell = e.a; fitEdge(eid); }
    switchTab('inspect'); renderAll();
  }
});
function fitEdge(eid) {
  const e = state.model.edges[eid];
  fitBounds(Math.min(e.ax, e.bx) - 1.5, Math.min(e.ay, e.by) - 1.5, Math.max(e.ax, e.bx) + 2.5, Math.max(e.ay, e.by) + 2.5);
}

// 坐标跟踪
$('#eq-go').onclick = () => {
  const x1 = +$('#eq-ax').value, y1 = +$('#eq-ay').value, x2 = +$('#eq-bx').value, y2 = +$('#eq-by').value;
  const info = describeAdjacency(state.model, x1, y1, x2, y2);
  if (info.connected && info.edge) {
    state.selEdge = info.edge.id; state.adjInfo = null; state.selCell = info.edge.a; fitEdge(info.edge.id);
  } else {
    state.selEdge = null; state.adjInfo = info;
  }
  switchTab('inspect'); renderCellDetail(); renderEdgeDetail(); scheduleDraw();
};

// 导入按钮 / 文件 / 拖拽 / 粘贴 / 样例
$('#btn-import').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const text = await f.text();
  const parsed = parseDirectorJSON(text);
  if (parsed.doc) loadObject(parsed.doc, f.name);
  else showParseErrors(parsed.errors);
  e.target.value = '';
});
$('#btn-load-sample').onclick = () => loadSample();
$('#empty-load-sample').onclick = () => loadSample();
async function loadSample() {
  try {
    const r = await fetch('samples/fiber-directors.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    await loadObject(raw, 'samples/fiber-directors.json');
  } catch (err) {
    toast('无法通过 fetch 读取样例；若直接双击 index.html（file://），请改用本地服务器或粘贴 JSON。', 'error', 5000);
  }
}
function showParseErrors(errors) {
  const errBox = $('#import-errors');
  errBox.hidden = false;
  errBox.innerHTML = `<strong>JSON 校验失败：</strong><ul>${errors.map((e) => `<li><code>${e.path}</code> — ${e.message}</li>`).join('')}</ul>`;
  toast('JSON 校验失败', 'error');
}
$('#btn-parse-paste').onclick = () => {
  const text = $('#paste-area').value;
  const parsed = parseDirectorJSON(text);
  if (parsed.doc) loadObject(parsed.doc, 'pasted JSON');
  else showParseErrors(parsed.errors);
};
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop-hint').hidden = false; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-hint').hidden = true; });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop-hint').hidden = true;
  const f = e.dataTransfer.files?.[0]; if (!f) return;
  const parsed = parseDirectorJSON(await f.text());
  if (parsed.doc) loadObject(parsed.doc, f.name); else showParseErrors(parsed.errors);
});

// 导出菜单
$('#btn-export-menu').onclick = (ev) => {
  ev.stopPropagation();
  const menu = $('#export-menu');
  menu.hidden = !menu.hidden;
  $('#btn-export-menu').setAttribute('aria-expanded', String(!menu.hidden));
};
document.addEventListener('click', (e) => { if (!e.target.closest('.export-menu')) $('#export-menu').hidden = true; });
$$('#export-menu [data-export]').forEach((b) => b.addEventListener('click', () => {
  doExport(b.dataset.export);
  $('#export-menu').hidden = true;
}));

function currentBundle() {
  const viewSolution = {
    flips: state.viewFlips || state.canonical.flips,
    totalCost: state.canonical.totalCost,
    components: state.canonical.components,
    engine: state.canonical.engine,
  };
  return buildExportBundle(state.model, viewSolution, { effective: state.effective }, state.conflicts);
}
function doExport(kind) {
  if (!state.model || !state.canonical) { toast('请先载入并完成求解', 'error'); return; }
  const stamp = 'fiber-directors';
  if (kind === 'bundle') {
    download(`${stamp}-result.json`, JSON.stringify(currentBundle(), null, 2), 'application/json');
    toast('已导出完整结果 JSON', 'success');
  } else if (kind === 'svg') {
    const allViolated = state.canonical.components.flatMap((c) => c.violated);
    const svg = buildSymbolSVG(state.model, state.viewFlips, {
      anchors: state.effective, violatedEdges: allViolated, totalCost: state.canonical.totalCost,
    });
    download(`${stamp}-symbol-map.svg`, svg, 'image/svg+xml');
    toast('已导出符号图 SVG', 'success');
  } else if (kind === 'txt') {
    const s = buildSymbolRows(state.model, state.viewFlips);
    download(`${stamp}-symbols.txt`, s.glyphText + '\n\n正负号图：\n' + s.signText + '\n', 'text/plain;charset=utf-8');
  } else if (kind === 'signcsv') {
    const { signRows } = buildSymbolRows(state.model, state.viewFlips);
    const csv = signRows.map((r) => r.map((v) => (v === 0 ? '' : v > 0 ? '+1' : '-1')).join(',')).join('\n');
    download(`${stamp}-sign-map.csv`, csv + '\n', 'text/csv;charset=utf-8');
  } else if (kind === 'components') {
    const b = currentBundle();
    const csv = toCSV(b.components, [
      { label: 'component', get: (r) => r.component },
      { label: 'cellCount', get: (r) => r.cellCount },
      { label: 'root_xy', get: (r) => `${r.root[0]} ${r.root[1]}` },
      { label: 'anchor_xysign', get: (r) => r.anchor ? r.anchor.join(' ') : '' },
      { label: 'violationCost', get: (r) => r.violationCost },
      { label: 'violatedEdgeCount', get: (r) => r.violatedEdgeCount },
      { label: 'cells_xy', get: (r) => r.cells.map((p) => p.join(':')).join(' ') },
    ]);
    download(`${stamp}-components.csv`, csv, 'text/csv;charset=utf-8');
  } else if (kind === 'violated') {
    const b = currentBundle();
    const csv = toCSV(b.violatedEdges, [
      { label: 'edgeId', key: 'edgeId' },
      { label: 'endpointA', get: (r) => r.endpoints[0].join(':') },
      { label: 'endpointB', get: (r) => r.endpoints[1].join(':') },
      { label: 'originalDot', key: 'originalDot' },
      { label: 'preference', key: 'preference' },
      { label: 'flipA', key: 'flipA' },
      { label: 'flipB', key: 'flipB' },
      { label: 'actualRelation', key: 'actualRelation' },
      { label: 'weight', key: 'weight' },
      { label: 'chargedCost', key: 'chargedCost' },
    ]);
    download(`${stamp}-violated-edges.csv`, csv, 'text/csv;charset=utf-8');
    toast(`已导出 ${b.violatedEdges.length} 条被违反边`, 'success');
  }
}

// ---------------------------------------------------------------------------
// 对外可编程接口（便于自动评测 / 控制台）
// ---------------------------------------------------------------------------
function getSerializableState() {
  return {
    width: state.model?.width, height: state.model?.height,
    totalCost: state.canonical?.totalCost ?? null,
    flips: state.viewFlips ? Array.from(state.viewFlips) : null,
    canonicalFlips: state.canonical ? Array.from(state.canonical.flips) : null,
    components: state.canonical?.components ?? null,
    anchors: [...state.anchorByComp.values()].map((a) => ({ ...a })),
    conflicts: state.conflicts.map((c) => ({ ...c })),
    violatedEdges: state.canonical ? state.canonical.components.flatMap((c) => c.violated) : [],
  };
}

window.FiberDirector = {
  MAX_GRID,
  core: { normalizeDocument, buildModel, solveModel, edgeDetail, traceBetween, buildExportBundle },
  ready: null,
  getState: getSerializableState,
  // 程序化导入默认强制求精确全局最优（即使缺陷面很多），并等待求解完成
  async loadObject(raw) { return loadObject(raw, 'api', { forceLarge: true }); },
  async loadObjectInteractive(raw) { return loadObject(raw, 'api'); },
  async loadText(text) {
    const p = parseDirectorJSON(text);
    if (!p.doc) return { ok: false, errors: p.errors };
    return loadObject(p.doc, 'api-text', { forceLarge: true });
  },
  setTool(tool) {
    const map = { inspect: 'inspect', keep: 'anchor:1', flip: 'anchor:-1' };
    const t = map[tool] || tool;
    const btn = document.querySelector(`.seg[data-tool="${t}"]`);
    btn?.click();
  },
  setAnchor: (x, y, sign) => applyAnchorAt(x, y, sign),
  removeAnchor: (cid) => removeAnchor(cid),
  selectCell(x, y) { state.selCell = cellId(x, y, state.model.width); renderAll(); },
  selectEdgeBetween(x1, y1, x2, y2) {
    const info = describeAdjacency(state.model, x1, y1, x2, y2);
    if (info.edge) { state.selEdge = info.edge.id; state.adjInfo = null; renderAll(); return edgeDetail(state.model, state.viewFlips, info.edge.id); }
    state.adjInfo = info; renderEdgeDetail(); return info;
  },
  edgeDetail: (eid) => edgeDetail(state.model, state.viewFlips, eid),
  exportBundle: currentBundle,
  // 返回某格中心相对视口的客户端坐标（供自动化真实点击）
  cellClientXY(x, y) {
    const r = canvas.getBoundingClientRect();
    return {
      clientX: r.left + state.cam.ox + (x + .5) * state.cam.k,
      clientY: r.top + state.cam.oy + (y + .5) * state.cam.k,
    };
  },
  camera: () => ({ ...state.cam }),
  fitCamera,
};

// 启动：自动载入样例
resizeCanvas();
window.FiberDirector.ready = loadSample().catch(() => {});
