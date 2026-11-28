// app.js —— 页面编排：载入数据、锁定管理、求解、交互面板、导出
import { buildModel, ModelError } from './model.js';
import { solve } from './solver.js';
import { computeRetained } from './gaps.js';
import { exportSVG } from './svg.js';
import { View } from './render.js';

const $ = (id) => document.getElementById(id);

const state = {
  rawData: null,
  model: null,
  /** cid -> 锁定在上的 strand id（含初始 pins 与用户操作） */
  pinMap: new Map(),
  result: null,
  retained: new Map(),
  timings: null,
};

let view;

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function setBusy(busy) {
  $('toolbar').classList.toggle('busy', busy);
}

/** 载入并求解一份 JSON 数据。 */
async function loadData(data, sourceName) {
  setBusy(true);
  try {
    const t0 = performance.now();
    const model = buildModel(data);
    const t1 = performance.now();
    state.rawData = data;
    state.model = model;
    state.pinMap = new Map(model.pins.map((p) => [p.cid, p.above]));
    rerunSolve(t1, t0, sourceName);
    $('drop-hint').hidden = true;
  } catch (e) {
    if (e instanceof ModelError) {
      showErrors(e.issues, sourceName);
    } else {
      showErrors([`解析失败：${e.message}`], sourceName);
    }
  } finally {
    setBusy(false);
  }
}

/** 锁定状态变化后重新求解、重算缺口并刷新视图。 */
function rerunSolve(tModel, t0, sourceName) {
  const model = state.model;
  const tSolve0 = performance.now();
  const result = solve(model, state.pinMap);
  const tSolve1 = performance.now();
  const retained = computeRetained(model, result.above);
  const tGap = performance.now();

  state.result = result;
  state.retained = retained;
  state.timings = {
    total: tGap - t0,
    model: tModel - t0,
    solve: tSolve1 - tSolve0,
    gap: tGap - tSolve1,
  };

  view.setData(model, retained, result.above, new Set(state.pinMap.keys()));
  renderConflicts();
  renderStats(sourceName);
  if (result.conflictCount > 0) {
    setStatus(`发现 ${result.conflictCount} 处上下矛盾，见右侧清单`, 'warn');
  } else {
    setStatus(
      `已求解 ${model.crossings.length} 个交点，全程 ${state.timings.total.toFixed(0)} ms`,
      'ok',
    );
  }
  refreshInspector(view.selectedCid);
}

function renderStats(sourceName) {
  const m = state.model;
  const segCount = m.strands.reduce(
    (n, s) => n + (s.closed ? s.points.length : s.points.length - 1), 0,
  );
  $('stats').innerHTML = `
    <div class="stat"><span class="stat-num">${m.strands.length}</span><span class="stat-label">线条</span></div>
    <div class="stat"><span class="stat-num">${segCount}</span><span class="stat-label">线段</span></div>
    <div class="stat"><span class="stat-num">${m.crossings.length}</span><span class="stat-label">交点</span></div>
    <div class="stat"><span class="stat-num">${state.pinMap.size}</span><span class="stat-label">锁定</span></div>
    <div class="stat"><span class="stat-num ${state.result.conflictCount ? 'bad' : ''}">${state.result.conflictCount}</span><span class="stat-label">矛盾</span></div>
    <div class="stat source" title="${sourceName ?? ''}"><span class="stat-label">数据源</span><span class="stat-name">${sourceName ?? '—'}</span></div>
  `;
  $('timing').textContent =
    `建模 ${state.timings.model.toFixed(0)} ms · 求解 ${state.timings.solve.toFixed(0)} ms · ` +
    `缺口 ${state.timings.gap.toFixed(0)} ms · 合计 ${state.timings.total.toFixed(0)} ms`;
}

function showErrors(issues, sourceName) {
  const panel = $('conflict-panel');
  const list = $('conflict-list');
  list.innerHTML = '';
  panel.hidden = false;
  panel.querySelector('h2').textContent = `数据校验未通过（${sourceName ?? ''}）`;
  const ul = document.createElement('ul');
  ul.className = 'error-list';
  for (const msg of issues.slice(0, 200)) {
    const li = document.createElement('li');
    li.textContent = msg;
    ul.appendChild(li);
  }
  list.appendChild(ul);
  setStatus(`数据有 ${issues.length} 处问题，未生成纹样`, 'bad');
}

function renderConflicts() {
  const panel = $('conflict-panel');
  const list = $('conflict-list');
  list.innerHTML = '';
  const conflicts = state.result.conflicts;
  if (conflicts.length === 0) {
    panel.hidden = true;
    view.setHighlight(new Set());
    return;
  }
  panel.hidden = false;
  panel.querySelector('h2').textContent = `上下矛盾（${state.result.conflictCount}${
    state.result.conflictCount >= 200 ? '，仅列前 200' : ''
  }）`;
  conflicts.forEach((cf, i) => {
    const li = document.createElement('li');
    li.className = 'conflict-item';
    const head = document.createElement('button');
    head.className = 'conflict-head';
    const kindLabel = cf.kind === 'pin' ? '锁冲突' : cf.kind === 'selfloop' ? '自环矛盾' : '交替奇环';
    head.innerHTML = `<span class="conflict-kind k-${cf.kind}">${kindLabel}</span><span class="conflict-detail">${cf.detail}</span>`;
    head.addEventListener('click', () => {
      view.setHighlight(new Set(cf.path));
      view.selectedCid = cf.cid ?? cf.path[0];
      view.draw();
      refreshInspector(view.selectedCid);
    });
    li.appendChild(head);

    const chain = document.createElement('div');
    chain.className = 'chain';
    cf.path.forEach((cid, j) => {
      if (j > 0) chain.appendChild(document.createTextNode(' → '));
      const c = state.model.crossings[cid];
      const btn = document.createElement('button');
      btn.className = 'chain-node';
      btn.textContent = `(${c.x},${c.y})`;
      btn.addEventListener('click', () => {
        view.selectedCid = cid;
        view.draw();
        refreshInspector(cid);
      });
      chain.appendChild(btn);
    });
    li.appendChild(chain);
    list.appendChild(li);
  });
}

/** 选中交点后的追查面板。 */
function refreshInspector(cid) {
  const panel = $('inspector');
  if (cid < 0 || !state.model) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const m = state.model;
  const c = m.crossings[cid];
  const above = state.result.above[cid];
  const pinned = state.pinMap.get(cid);
  const h = m.strandById.get(c.h), v = m.strandById.get(c.v);

  const strandBlock = (sid) => {
    const st = m.strandById.get(sid);
    const isAbove = above === sid;
    const orderIdx = st.order.findIndex((o) => o.cid === cid);
    const neighbors = st.closed
      ? [st.order[(orderIdx - 1 + st.order.length) % st.order.length],
         st.order[(orderIdx + 1) % st.order.length]]
      : [st.order[orderIdx - 1], st.order[orderIdx + 1]];
    const nb = (o) => o ? `(${m.crossings[o.cid].x},${m.crossings[o.cid].y})` : '端点';
    return `
      <div class="strand-row ${isAbove ? 'is-above' : 'is-under'}">
        <div class="strand-title">
          <span class="strand-swatch" style="background:hsl(${(sid * 47) % 360},68%,52%)"></span>
          线条 ${sid} ${st.closed ? '<em>闭线</em>' : '<em>开线</em>'}
          <span class="layer-badge">${isAbove ? '在上' : '在下'}</span>
        </div>
        <div class="strand-meta">方向 ${c.h === sid ? '水平' : '竖直'} · 单侧缺口 ${st.gap} ·
          沿线第 ${orderIdx + 1}/${st.order.length} 个交点</div>
        <div class="strand-meta">相邻交点：${nb(neighbors[0])} ↔ ${nb(neighbors[1])}</div>
      </div>`;
  };

  panel.innerHTML = `
    <div class="insp-head">
      <h2>交点 (${c.x}, ${c.y})</h2>
      <button id="insp-close" class="icon-btn" title="关闭">✕</button>
    </div>
    <div class="insp-sub">编号 #${cid}（按纵坐标再横坐标排序）·
      ${pinned ? `已锁定线 ${pinned} 在上` : '未锁定'}</div>
    ${strandBlock(c.h)}
    ${strandBlock(c.v)}
    <div class="pin-controls">
      <button class="btn ${pinned === c.h ? 'primary' : ''}" data-pin="${c.h}">
        ${pinned === c.h ? '解除锁定' : `锁定线 ${c.h} 在上`}
      </button>
      <button class="btn ${pinned === c.v ? 'primary' : ''}" data-pin="${c.v}">
        ${pinned === c.v ? '解除锁定' : `锁定线 ${c.v} 在上`}
      </button>
    </div>
  `;
  $('insp-close').addEventListener('click', () => {
    view.selectedCid = -1;
    view.draw();
    panel.hidden = true;
  });
  panel.querySelectorAll('[data-pin]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = Number(btn.dataset.pin);
      if (state.pinMap.get(cid) === sid) state.pinMap.delete(cid);
      else state.pinMap.set(cid, sid);
      const t = performance.now();
      rerunSolve(t, t, state.rawData.__sourceName);
      view.selectedCid = cid;
      view.draw();
      refreshInspector(cid);
    });
  });
}

function doExport() {
  if (!state.model) return;
  const width = Number($('svg-width').value) || 1;
  const svg = exportSVG(state.model, state.retained, { strokeWidth: width });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'woven-retained.svg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // 部分预览环境拦截下载：提供文本兜底
  $('svg-out').value = svg;
  $('svg-fallback').hidden = false;
}

async function handleFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  data.__sourceName = file.name;
  await loadData(data, file.name);
}

function init() {
  const canvas = $('canvas');
  view = new View(canvas);
  view.onSelect = (cid) => {
    view.selectedCid = cid;
    view.draw();
    refreshInspector(cid);
  };
  view.onBackground = () => {
    view.selectedCid = -1;
    view.setHighlight(new Set());
    view.draw();
    $('inspector').hidden = true;
  };

  const ro = new ResizeObserver(() => { view.resize(); view.draw(); });
  ro.observe(canvas);

  $('file-input').addEventListener('change', async (e) => {
    if (e.target.files[0]) await handleFile(e.target.files[0]);
  });
  const drop = $('canvas-wrap');
  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', async (e) => {
    const f = e.dataTransfer.files[0];
    if (f) await handleFile(f);
  });

  $('btn-fit').addEventListener('click', () => view.fit());
  $('btn-markers').addEventListener('click', (e) => {
    view.showMarkers = !view.showMarkers;
    e.target.classList.toggle('active', view.showMarkers);
    view.draw();
  });
  $('btn-theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme !== 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    view.dark = dark;
    view.draw();
  });
  $('btn-export').addEventListener('click', doExport);
  $('btn-copy-svg').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('svg-out').value);
      setStatus('SVG 已复制到剪贴板', 'ok');
    } catch {
      $('svg-out').select();
      setStatus('复制受限，已选中文本可手动复制', 'warn');
    }
  });
  $('btn-clear-pins').addEventListener('click', () => {
    state.pinMap.clear();
    const t = performance.now();
    rerunSolve(t, t, state.rawData?.__sourceName);
  });

  // 自动尝试载入同目录样例
  fetch('samples/woven-crossings.json')
    .then((r) => {
      if (!r.ok) throw new Error('no sample');
      return r.json();
    })
    .then((data) => { data.__sourceName = 'woven-crossings.json'; return loadData(data, '样例 woven-crossings.json'); })
    .catch(() => setStatus('请载入 woven-crossings.json 或拖入文件', 'info'));
}

document.addEventListener('DOMContentLoaded', init);
