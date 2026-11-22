/*
 * app.js — 排版校验网页主控制器
 * 关键点：顺播结果一次性求解并缓存；拖帧/回拖只读缓存，保证逐帧重现。
 * 编辑（权重/罚分/预留区/新数据）会使缓存失效并重新顺播求解。
 */
import {
  buildFrameContext,
  diagnoseFrame,
  REASON_TEXT,
  solveSequence,
} from './solver.js';
import { buildFrameSVG, buildPlacementJSON } from './exporter.js';

const state = {
  data: null,
  seq: null, // 顺播求解缓存
  frame: 0,
  scale: 8,
  showDepth: true,
  showHidden: true,
  showGhost: false,
  switchPenalty: 2,
  weights: [],
  activeConflict: null, // 当前点选的冲突项索引（diagnose 数组内）
  playTimer: null,
};

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 1800);
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 数据载入 ----------
function loadData(data, sourceName) {
  validate(data);
  state.data = data;
  state.weights = data.labels.map((l) => l.weight);
  state.switchPenalty = 2;
  state.frame = 0;
  state.activeConflict = null;
  $('switchPenalty').value = 2;
  $('frameSlider').max = Math.max(0, data.frames.length - 1);
  $('frameSlider').value = 0;
  rebuild();
  toast(`已载入 ${sourceName}：${data.frames.length} 帧 / ${data.labels.length} 标签`);
}

function validate(d) {
  const errs = [];
  if (!d || typeof d !== 'object') errs.push('根节点不是对象');
  if (!Array.isArray(d.size) || d.size.length !== 2) errs.push('size 必须是 [宽,高]');
  if (d.size && (d.size[0] > 256 || d.size[1] > 192)) errs.push('画面不得超过 256×192');
  if (!d.camera) errs.push('缺少 camera');
  if (!Array.isArray(d.labels) || d.labels.length > 12) errs.push('标签数不得超过 12');
  d.labels?.forEach((l, i) => {
    if (!Array.isArray(l.choices) || l.choices.length > 8) errs.push(`标签 ${l.id ?? i} 落位数不得超过 8`);
    if (!Array.isArray(l.position) || l.position.length !== 3) errs.push(`标签 ${l.id ?? i} position 非法`);
  });
  if (!Array.isArray(d.frames) || d.frames.length > 24) errs.push('帧数不得超过 24');
  const n = d.size?.[0] * d.size?.[1];
  d.frames?.forEach((f, i) => {
    if (!Array.isArray(f.depth) || f.depth.length !== n) errs.push(`帧 ${i} depth 长度应为 ${n}`);
  });
  if (errs.length) throw new Error('数据校验失败：' + errs.join('；'));
}

// ---------- 求解缓存 ----------
function rebuild() {
  const t0 = performance.now();
  state.seq = solveSequence(state.data, {
    weights: state.weights,
    switchPenalty: state.switchPenalty,
  });
  state.solveMs = performance.now() - t0;
  state.frame = Math.min(state.frame, state.seq.length - 1);
  // 整体重渲染会替换表单节点，先记录焦点与光标，渲染后恢复，避免输入被打断
  const active = document.activeElement;
  const focusKey = active
    ? {
        id: active.id || null,
        li: active.dataset ? active.dataset.li : undefined,
        k: active.dataset ? active.dataset.k : undefined,
        idx: active.dataset ? active.dataset.idx : undefined,
        selStart: active.selectionStart ?? null,
      }
    : null;
  renderLabelTable();
  renderReservedList();
  renderAll();
  restoreFocus(focusKey);
}

function restoreFocus(key) {
  if (!key) return;
  let target = null;
  if (key.id) target = document.getElementById(key.id);
  if (!target && key.li !== undefined) {
    target = document.querySelector(`#labelTable .weight-input[data-li="${key.li}"]`);
  }
  if (!target && key.idx !== undefined && key.k !== undefined) {
    target = document.querySelector(
      `#reservedList input[data-idx="${key.idx}"][data-k="${key.k}"]`
    );
  }
  if (target && typeof target.focus === 'function') {
    target.focus();
    if (key.selStart != null && target.setSelectionRange) {
      try {
        target.setSelectionRange(key.selStart, key.selStart);
      } catch {
        /* 某些 input 类型不支持选区，忽略 */
      }
    }
  }
}

// ---------- 渲染 ----------
function currentResult() {
  return state.seq[state.frame];
}

function renderAll() {
  renderStage();
  renderTransport();
  renderStatbar();
  renderConflicts();
}

function renderTransport() {
  const n = state.seq.length;
  $('frameSlider').max = n - 1;
  $('frameSlider').value = state.frame;
  $('frameNo').textContent = `帧 ${state.frame + 1}/${n}`;
  $('btnPrev').disabled = state.frame === 0;
  $('btnFirst').disabled = state.frame === 0;
  $('btnNext').disabled = state.frame === n - 1;
}

function renderStatbar() {
  const r = currentResult();
  const totalW = state.weights.reduce((s, w) => s + w, 0);
  const shown = r.assign.filter((a) => a >= 0).length;
  const hidden = r.assign.length - shown;
  const anchorHidden = r.ctx.labelInfo.filter((i) => !i.vis.visible).length;
  $('statbar').innerHTML =
    `<span>显示标签 <b>${shown}</b>/${r.assign.length}</span>` +
    `<span>求解隐藏 <b>${hidden - anchorHidden}</b></span>` +
    `<span>锚点不可见 <b>${anchorHidden}</b></span>` +
    `<span>优先分 <b>${r.score.weight}</b>/${totalW}</span>` +
    `<span>总代价 <b>${r.score.cost}</b>（基础 ${r.score.baseCost} + 换落位 ${r.score.switchCost}）</span>` +
    `<span>搜索节点 <b>${r.nodes}</b></span>` +
    `<span>全序列求解 <b>${state.solveMs.toFixed(1)}</b> ms</span>`;
}

function renderStage() {
  const r = currentResult();
  const conflicts = diagnoseFrame(r.ctx);
  const svg = buildFrameSVG(state.data, r, {
    scale: state.scale,
    showDepth: state.showDepth,
    showHidden: state.showHidden,
    conflicts,
  });
  const host = $('stage');
  host.innerHTML = svg;
  const svgEl = host.querySelector('svg');

  // 候选落位虚影
  if (state.showGhost) {
    const ghostNS = 'http://www.w3.org/2000/svg';
    r.ctx.options.forEach((opt, g) => {
      if (!opt.feasible || r.assign[opt.labelIdx] === opt.choiceIdx) return;
      const rect = document.createElementNS(ghostNS, 'rect');
      rect.setAttribute('x', opt.rect.x);
      rect.setAttribute('y', opt.rect.y);
      rect.setAttribute('width', opt.rect.w);
      rect.setAttribute('height', opt.rect.h);
      rect.setAttribute('fill', 'rgba(148,163,184,0.07)');
      rect.setAttribute('stroke', '#64748b');
      rect.setAttribute('stroke-width', '0.2');
      rect.setAttribute('stroke-dasharray', '0.7 0.5');
      svgEl.appendChild(rect);
    });
  }

  // 预留区（可拖拽）
  const NS = 'http://www.w3.org/2000/svg';
  state.data.reserved.forEach((rr, idx) => {
    const el = document.createElementNS(NS, 'rect');
    el.setAttribute('x', rr.x);
    el.setAttribute('y', rr.y);
    el.setAttribute('width', rr.w);
    el.setAttribute('height', rr.h);
    el.setAttribute('class', 'svg-reserved');
    el.setAttribute('fill', 'rgba(245,158,11,0.08)');
    el.setAttribute('stroke', '#f59e0b');
    el.setAttribute('stroke-width', '0.3');
    el.dataset.idx = idx;
    svgEl.appendChild(el);
    el.addEventListener('pointerdown', (e) => startDragReserved(e, idx, el));
  });

  // 标签框点击命中区 → 弹出该标签的落位诊断
  r.assign.forEach((ci, li) => {
    if (ci < 0) return;
    const g = r.ctx.labelRanges[li].start + ci;
    const opt = r.ctx.options[g];
    const hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', opt.rect.x);
    hit.setAttribute('y', opt.rect.y);
    hit.setAttribute('width', opt.rect.w);
    hit.setAttribute('height', opt.rect.h);
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('class', 'conflict-hit label-box');
    hit.addEventListener('click', () => showLabelDetail(li));
    svgEl.appendChild(hit);
  });

  // 冲突高亮点击
  if (state.activeConflict != null) {
    const c = conflicts[state.activeConflict];
    if (c) highlightConflict(c, svgEl);
  }
  svgEl.querySelectorAll('.conflict-hit[data-conflict]').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeConflict = Number(el.dataset.conflict);
      renderConflicts();
      renderStage();
    });
  });
}

function highlightConflict(c, svgEl) {
  const NS = 'http://www.w3.org/2000/svg';
  const rects = c.type === 'pair' ? [c.rectA, c.rectB] : c.rect ? [c.rect] : [];
  rects.forEach((r) => {
    const halo = document.createElementNS(NS, 'rect');
    halo.setAttribute('x', r.x - 0.6);
    halo.setAttribute('y', r.y - 0.6);
    halo.setAttribute('width', r.w + 1.2);
    halo.setAttribute('height', r.h + 1.2);
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', '#f0abfc');
    halo.setAttribute('stroke-width', '0.5');
    svgEl.appendChild(halo);
  });
}

function showLabelDetail(li) {
  const r = currentResult();
  const label = state.data.labels[li];
  const info = r.ctx.labelInfo[li];
  const ci = r.assign[li];
  const lines = [`标签 ${label.id}（优先分 ${state.weights[li]}，框 ${label.size.join('×')}）`];
  if (!info.vis.visible) {
    lines.push(`锚点不可见：${REASON_TEXT[info.vis.reason] || info.vis.reason}`);
  } else if (ci < 0) {
    lines.push('锚点可见，但为最优解被求解隐藏');
  } else {
    lines.push(`当前落位 #${ci}，代价 ${label.choices[ci][2]}`);
  }
  r.ctx.labelRanges[li] &&
    r.ctx.options
      .slice(r.ctx.labelRanges[li].start, r.ctx.labelRanges[li].start + r.ctx.labelRanges[li].count)
      .forEach((o, k) => {
        lines.push(
          `  落位#${k} ${o.feasible ? '可行' : '不可行(' + (REASON_TEXT[o.infeasibleReason] || o.infeasibleReason) + ')'} 代价 ${o.cost}`
        );
      });
  toast(lines.join('｜'));
}

function renderConflicts() {
  const r = currentResult();
  const items = diagnoseFrame(r.ctx);
  const host = $('conflictList');
  if (!items.length) {
    host.innerHTML = '<div class="muted small">当前帧无冲突</div>';
    return;
  }
  host.innerHTML = '';
  items.forEach((c, idx) => {
    const div = document.createElement('div');
    div.className = 'conflict-item' + (state.activeConflict === idx ? ' active' : '');
    let html = '';
    if (c.type === 'anchor-hidden') {
      const l = state.data.labels[c.labelIdx];
      html = `<span class="tag anchor-hidden">锚点</span><b>${l.id}</b> ${REASON_TEXT[c.reason]}`;
    } else if (c.type === 'infeasible') {
      const l = state.data.labels[c.labelIdx];
      html = `<span class="tag ${c.reason}">落位</span><b>${l.id}</b> 落位#${c.choiceIdx} ${REASON_TEXT[c.reason]}`;
    } else {
      const a = state.data.labels[c.labelA];
      const b = state.data.labels[c.labelB];
      html =
        `<span class="tag ${c.kind}">${c.kind === 'box-overlap' ? '框冲突' : '连线'}</span>` +
        `<b>${a.id}</b>#${c.choiceA} ↔ <b>${b.id}</b>#${c.choiceB}`;
    }
    div.innerHTML = html;
    div.addEventListener('click', () => {
      state.activeConflict = state.activeConflict === idx ? null : idx;
      renderStage();
      renderConflicts();
    });
    host.appendChild(div);
  });
}

function renderLabelTable() {
  const host = $('labelTable');
  host.innerHTML =
    '<tr><th>标签</th><th>优先分</th><th>落位数</th><th>状态</th></tr>' +
    state.data.labels
      .map((l, li) => {
        const r = currentResult();
        const ci = r.assign[li];
        const vis = r.ctx.labelInfo[li].vis.visible;
        const status = !vis ? '锚点隐藏' : ci < 0 ? '求解隐藏' : `落位#${ci}`;
        return `<tr>
          <td>${l.id}</td>
          <td><input type="number" min="0" step="1" value="${state.weights[li]}" data-li="${li}" class="weight-input"/></td>
          <td>${l.choices.length}</td>
          <td class="small">${status}</td></tr>`;
      })
      .join('');
  host.querySelectorAll('.weight-input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const li = Number(inp.dataset.li);
      const v = Math.max(0, Number(inp.value) || 0);
      inp.value = v;
      state.weights[li] = v;
      rebuild();
    });
  });
}

function renderReservedList() {
  const host = $('reservedList');
  host.innerHTML = '';
  state.data.reserved.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'reserved-row';
    row.innerHTML = `
      <input type="number" value="${r.x}" data-k="x" data-idx="${idx}" title="x" />
      <input type="number" value="${r.y}" data-k="y" data-idx="${idx}" title="y" />
      <input type="number" value="${r.w}" data-k="w" data-idx="${idx}" title="宽" />
      <input type="number" value="${r.h}" data-k="h" data-idx="${idx}" title="高" />
      <button class="icon-btn" data-del="${idx}">×</button>`;
    host.appendChild(row);
  });
  host.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.dataset.idx);
      const k = inp.dataset.k;
      state.data.reserved[idx][k] = Math.max(0, Number(inp.value) || 0);
      rebuild();
    });
  });
  host.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.reserved.splice(Number(btn.dataset.del), 1);
      rebuild();
    });
  });
}

// ---------- 预留区拖拽 ----------
function startDragReserved(e, idx, el) {
  e.preventDefault();
  const svgEl = el.ownerSVGElement;
  const rr = state.data.reserved[idx];
  const pt = toSvgPoint(svgEl, e);
  const dx = pt.x - rr.x;
  const dy = pt.y - rr.y;
  const W = state.data.size[0];
  const H = state.data.size[1];
  function move(ev) {
    const p = toSvgPoint(svgEl, ev);
    rr.x = Math.round(Math.min(Math.max(p.x - dx, 0), W - rr.w));
    rr.y = Math.round(Math.min(Math.max(p.y - dy, 0), H - rr.h));
    el.setAttribute('x', rr.x);
    el.setAttribute('y', rr.y);
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    rebuild();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function toSvgPoint(svgEl, ev) {
  const pt = svgEl.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  return pt.matrixTransform(svgEl.getScreenCTM().inverse());
}

// ---------- 播放控制 ----------
function setFrame(f) {
  state.frame = Math.min(Math.max(f, 0), state.seq.length - 1);
  state.activeConflict = null;
  renderAll();
  renderLabelTable();
}

function togglePlay() {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
    $('btnPlay').textContent = '▶';
    return;
  }
  $('btnPlay').textContent = '⏸';
  state.playTimer = setInterval(() => {
    if (state.frame >= state.seq.length - 1) {
      togglePlay();
      return;
    }
    setFrame(state.frame + 1); // 顺播推进
  }, 700);
}

// ---------- 导出 ----------
function exportSVG() {
  const r = currentResult();
  const svg = buildFrameSVG(state.data, r, {
    scale: state.scale,
    showDepth: state.showDepth,
    showHidden: state.showHidden,
    conflicts: diagnoseFrame(r.ctx),
  });
  download(`overlay-frame-${state.frame}.svg`, svg, 'image/svg+xml');
  toast('SVG 已导出');
}

function exportJSON() {
  const json = buildPlacementJSON(state.data, state.seq, {
    switchPenalty: state.switchPenalty,
    source: state.sourceName || 'depth-label-cases',
  });
  download('label-placement.json', json, 'application/json');
  toast('落位 JSON 已导出');
}

// ---------- 事件绑定 ----------
function bind() {
  $('btnSample').addEventListener('click', () => {
    state.sourceName = 'sample';
    loadData(structuredClone(window.SAMPLE_DATA), '内置样例');
  });
  $('btnLoad').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      state.sourceName = file.name;
      loadData(data, file.name);
    } catch (err) {
      toast('导入失败：' + err.message);
    }
    e.target.value = '';
  });

  $('frameSlider').addEventListener('input', (e) => setFrame(Number(e.target.value)));
  $('btnFirst').addEventListener('click', () => setFrame(0));
  $('btnPrev').addEventListener('click', () => setFrame(state.frame - 1));
  $('btnNext').addEventListener('click', () => setFrame(state.frame + 1));
  $('btnPlay').addEventListener('click', togglePlay);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') setFrame(state.frame - 1);
    if (e.key === 'ArrowRight') setFrame(state.frame + 1);
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  });

  $('chkDepth').addEventListener('change', (e) => {
    state.showDepth = e.target.checked;
    renderStage();
  });
  $('chkHidden').addEventListener('change', (e) => {
    state.showHidden = e.target.checked;
    renderStage();
  });
  $('chkGhost').addEventListener('change', (e) => {
    state.showGhost = e.target.checked;
    renderStage();
  });
  $('scaleSel').addEventListener('change', (e) => {
    state.scale = Number(e.target.value);
    renderStage();
  });
  $('switchPenalty').addEventListener('change', (e) => {
    state.switchPenalty = Math.max(0, Number(e.target.value) || 0);
    e.target.value = state.switchPenalty;
    rebuild();
  });
  $('btnAddReserved').addEventListener('click', () => {
    const W = state.data.size[0];
    const H = state.data.size[1];
    state.data.reserved.push({ x: Math.floor(W / 4), y: Math.floor(H / 4), w: 6, h: 4 });
    rebuild();
  });
  $('btnExportSVG').addEventListener('click', exportSVG);
  $('btnExportJSON').addEventListener('click', exportJSON);
}

bind();
state.sourceName = 'sample';
loadData(structuredClone(window.SAMPLE_DATA), '内置样例');
