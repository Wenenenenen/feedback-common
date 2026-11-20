// 应用层：配置编辑、任务调度（改约束先取消旧任务）、画布渲染、候选查看、轨迹回放、导入导出。
import { Solver, STATUS, DIRS, validateConfig } from './solver.js?v=5';

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  [STATUS.READY]: ['未运行', 'ready'],
  [STATUS.RUNNING]: ['运行中', 'running'],
  [STATUS.PAUSED]: ['已暂停', 'paused'],
  [STATUS.SOLVED]: ['已求解', 'solved'],
  [STATUS.UNSOLVABLE]: ['证明无解', 'unsolvable'],
  [STATUS.BUDGET_EXHAUSTED]: ['预算耗尽', 'budget'],
  [STATUS.CANCELLED]: ['任务已取消', 'cancelled'],
};

const SPEED_EVENTS = [1, 10, 200, 5000]; // 每帧泵出的事件数

const app = {
  config: defaultConfig(),
  solver: null,
  token: { cancelled: false },
  paused: false,
  rafId: 0,
  selectedCell: null,
  pinMode: 'draw',
  importedTrace: null,          // 导入轨迹（用于回放/复算校验）
  replayCheckpoints: new Map(), // traceIndex -> Solver 快照
  followTail: true,
  viewIndex: -1,                // 回放查看位置；-1 表示跟随实时
};

function defaultConfig() {
  return {
    width: 4,
    height: 4,
    wrap_x: true,
    wrap_y: true,
    seed: 7,
    budget: 100000,
    tiles: [
      { id: 'a', weight: 1, edges: ['0', '0', '1', '1'], color: '#e4a85d' },
      { id: 'b', weight: 1, edges: ['1', '1', '0', '0'], color: '#5287bd' },
    ],
    pins: [{ x: 0, y: 0, allowed: ['a'] }],
  };
}

// ---------- 消息提示 ----------
function flash(text, kind = 'info', ms = 4000) {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg show ${kind}`;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { el.className = 'msg'; }, ms);
}

// ---------- 表单与配置 ----------
function syncForm() {
  $('cfg-width').value = app.config.width;
  $('cfg-height').value = app.config.height;
  $('cfg-seed').value = app.config.seed;
  $('cfg-budget').value = app.config.budget;
  $('cfg-wrap-x').checked = app.config.wrap_x;
  $('cfg-wrap-y').checked = app.config.wrap_y;
  renderTileEditor();
  renderPinAllowedSelect();
  renderPinsList();
}

function readForm() {
  return {
    width: Number($('cfg-width').value),
    height: Number($('cfg-height').value),
    wrap_x: $('cfg-wrap-x').checked,
    wrap_y: $('cfg-wrap-y').checked,
    seed: Number($('cfg-seed').value),
    budget: Number($('cfg-budget').value),
    tiles: app.config.tiles.map((t) => ({ ...t, edges: [...t.edges] })),
    pins: app.config.pins.map((p) => ({ x: p.x, y: p.y, allowed: [...p.allowed] })),
  };
}

function renderTileEditor() {
  const host = $('tile-editor');
  host.innerHTML = '';
  app.config.tiles.forEach((t, idx) => {
    const row = document.createElement('div');
    row.className = 'tile-row';
    row.innerHTML = `
      <input type="color" value="${t.color}" data-k="color" title="颜色">
      <input class="tid" value="${escapeHtml(t.id)}" data-k="id" style="width:74px" title="id">
      <input type="number" min="1" step="1" value="${t.weight}" data-k="weight" style="width:62px" title="权重">
      <span class="edges">
        <input value="${escapeHtml(t.edges[0])}" data-e="0" title="北边标签" style="width:42px">
        <input value="${escapeHtml(t.edges[1])}" data-e="1" title="东边标签" style="width:42px">
        <input value="${escapeHtml(t.edges[2])}" data-e="2" title="南边标签" style="width:42px">
        <input value="${escapeHtml(t.edges[3])}" data-e="3" title="西边标签" style="width:42px">
      </span>
      <button data-act="del" class="danger">删</button>`;
    row.querySelector('input[type=color]').addEventListener('change', (e) => {
      t.color = e.target.value; invalidateTask('拼块颜色已修改'); renderLegend();
    });
    row.querySelector('[data-k=id]').addEventListener('change', (e) => {
      const old = t.id;
      const v = e.target.value.trim();
      if (!v || app.config.tiles.some((o) => o !== t && o.id === v)) { flash('拼块 id 不能为空且不可重复', 'error'); e.target.value = old; return; }
      t.id = v;
      for (const p of app.config.pins) p.allowed = p.allowed.map((a) => (a === old ? v : a));
      invalidateTask('拼块 id 已修改'); renderPinAllowedSelect(); renderPinsList();
    });
    row.querySelector('[data-k=weight]').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (!(v > 0)) { flash('权重须为正数', 'error'); e.target.value = t.weight; return; }
      t.weight = v; invalidateTask('拼块权重已修改');
    });
    row.querySelectorAll('[data-e]').forEach((inp) => {
      inp.addEventListener('change', () => {
        t.edges[Number(inp.dataset.e)] = inp.value;
        invalidateTask('邻边标签已修改');
      });
    });
    row.querySelector('[data-act=del]').addEventListener('click', () => {
      if (app.config.tiles.length <= 1) { flash('至少保留一种拼块', 'error'); return; }
      app.config.tiles.splice(idx, 1);
      app.config.pins = app.config.pins
        .map((p) => ({ ...p, allowed: p.allowed.filter((a) => a !== t.id) }))
        .filter((p) => p.allowed.length > 0);
      invalidateTask('拼块已删除');
      renderTileEditor(); renderPinAllowedSelect(); renderPinsList();
    });
    host.appendChild(row);
  });
}

function renderPinAllowedSelect() {
  const sel = $('pin-allowed');
  sel.innerHTML = '';
  for (const t of app.config.tiles) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.id}（w=${t.weight}）`;
    opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderPinsList() {
  const host = $('pins-list');
  host.innerHTML = '';
  if (app.config.pins.length === 0) {
    host.innerHTML = '<span class="muted">暂无固定地块</span>';
    return;
  }
  app.config.pins.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pin-row';
    row.innerHTML = `<span>(${p.x},${p.y}) → {${p.allowed.join(', ')}}</span>`;
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = '删';
    btn.addEventListener('click', () => {
      app.config.pins.splice(i, 1);
      invalidateTask('固定地块已删除');
      renderPinsList(); draw();
    });
    row.appendChild(btn);
    host.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 任务生命周期：改约束必须先取消旧任务 ----------
function invalidateTask(reason) {
  app.replayCheckpoints.clear();
  app.importedTrace = null;
  app.viewIndex = -1;
  if (app.solver && (app.solver.status === STATUS.RUNNING || app.solver.status === STATUS.PAUSED)) {
    app.token.cancelled = true;
    cancelAnimationFrame(app.rafId);
    app.solver.cancel();
    // 保留已取消的实例用于状态展示（徽章显示“任务已取消”），下次运行时由 startSolver 替换
    flash(`约束已变更（${reason}），旧任务已取消，请重新运行`, 'info', 5000);
  } else {
    app.solver = null; // 无活动任务：直接清空
  }
  refreshControls(); draw(); renderTracePanel(); renderCellInfo();
}

function startSolver() {
  let cfg;
  try {
    cfg = validateConfig(readForm());
  } catch (err) {
    flash(`配置无效：${err.message}`, 'error', 6000);
    return null;
  }
  invalidateSilently();
  app.solver = new Solver(cfg);
  app.token = { cancelled: false };
  app.replayCheckpoints.clear();
  app.viewIndex = -1;
  return app.solver;
}

function invalidateSilently() {
  app.token.cancelled = true;
  app.paused = false;
  cancelAnimationFrame(app.rafId);
}

function runLoop() {
  const s = app.solver;
  if (!s) return;
  if (app.paused || app.token.cancelled) {
    if (s.status === STATUS.RUNNING) s.status = STATUS.PAUSED;
    refreshControls();
    return;
  }
  const perFrame = SPEED_EVENTS[Number($('run-speed').value)] ?? 200;
  const r = s.run(app.token, perFrame);
  const idx = s.trace.length;
  if (!app.replayCheckpoints.has(idx) && idx % 2000 === 0) app.replayCheckpoints.set(idx, s.clone());
  refreshControls(); draw(); renderTracePanel(); renderCellInfo();
  if (r.done) {
    onTerminal(s);
    return;
  }
  if (r.reason === 'cancelled') return;
  app.rafId = requestAnimationFrame(runLoop);
}

function onTerminal(s) {
  const map = {
    [STATUS.SOLVED]: ['求解完成：所有格子单值且全部邻边合法', 'ok'],
    [STATUS.UNSOLVABLE]: ['已证明无解：搜索穷尽（初始传播矛盾或全部分支闭合），不是运气问题', 'error'],
    [STATUS.BUDGET_EXHAUSTED]: [`预算耗尽：已用 ${s.trialsUsed} 次试选仍未得出结论；加大预算后可继续区分`, 'info'],
  };
  const [text, kind] = map[s.status] ?? ['任务结束', 'info'];
  flash(text, kind, 8000);
  refreshControls(); draw(); renderTracePanel(); renderCellInfo();
}

// ---------- 控制按钮 ----------
$('btn-run').addEventListener('click', () => {
  // 已有暂停的任务：继续而非重开
  if (app.solver && app.solver.status === STATUS.PAUSED) {
    app.paused = false;
    app.token = { cancelled: false };
    refreshControls();
    app.rafId = requestAnimationFrame(runLoop);
    return;
  }
  const s = startSolver();
  if (!s) return;
  app.paused = false;
  refreshControls();
  app.rafId = requestAnimationFrame(runLoop);
});

$('btn-pause').addEventListener('click', () => {
  // 下一帧入口检测到 paused 即停止并落 PAUSED 状态
  app.paused = true;
  refreshControls();
});

$('btn-step').addEventListener('click', () => {
  if (!app.solver || [STATUS.SOLVED, STATUS.UNSOLVABLE, STATUS.BUDGET_EXHAUSTED, STATUS.CANCELLED].includes(app.solver.status)) {
    const s = startSolver();
    if (!s) return;
  }
  cancelAnimationFrame(app.rafId);
  app.paused = true;
  app.token.cancelled = true;
  const ev = app.solver.step();
  app.viewIndex = -1;
  refreshControls(); draw(); renderTracePanel(); renderCellInfo();
  if (ev && ['solved', 'unsolvable', 'budget_exhausted'].includes(ev.type)) onTerminal(app.solver);
});

$('btn-stop').addEventListener('click', () => {
  if (!app.solver) return;
  app.paused = false;
  app.token.cancelled = true;
  cancelAnimationFrame(app.rafId);
  app.solver.cancel();
  flash('任务已取消；修改约束后可重新运行', 'info');
  refreshControls(); draw(); renderTracePanel();
});

function refreshControls() {
  const s = app.solver;
  const badge = $('status-badge');
  const [text, cls] = s ? STATUS_TEXT[s.status] : STATUS_TEXT[STATUS.READY];
  badge.textContent = text;
  badge.className = `badge ${cls}`;
  const active = s && (s.status === STATUS.RUNNING || s.status === STATUS.PAUSED);
  $('btn-pause').disabled = !(s && s.status === STATUS.RUNNING);
  $('btn-step').disabled = !!(s && [STATUS.SOLVED, STATUS.UNSOLVABLE, STATUS.BUDGET_EXHAUSTED, STATUS.CANCELLED].includes(s.status));
  $('btn-stop').disabled = !active;
  $('btn-verify-replay').disabled = !app.importedTrace;
  $('stat-trials').textContent = s ? s.trialsUsed : 0;
  $('stat-budget').textContent = s ? s.budget : readFormBudgetSafe();
  $('stat-events').textContent = s ? s.trace.length : 0;
  $('stat-depth').textContent = s ? s._stack.length : 0;
  $('stat-unfixed').textContent = s ? countUnfixed(s) : 0;
  const max = s ? s.trace.length : 0;
  const scrub = $('trace-scrub');
  scrub.max = max;
  if (app.viewIndex < 0) scrub.value = max;
  else scrub.value = Math.min(app.viewIndex, max);
  $('trace-pos').textContent = `${scrub.value}/${max}`;
}

function readFormBudgetSafe() {
  const v = Number($('cfg-budget').value);
  return Number.isFinite(v) ? v : 0;
}

function countUnfixed(s) {
  let n = 0;
  for (let c = 0; c < s.N; c++) if (Solver.popcount(s.domains[c]) > 1) n++;
  return n;
}

// ---------- 画布 ----------
const canvas = $('board');
const ctx = canvas.getContext('2d');

function cellMetrics() {
  const cfg = readForm();
  const maxW = Math.min(760, window.innerWidth - 700);
  const size = Math.max(160, maxW);
  const cell = Math.floor(size / Math.max(cfg.width, cfg.height));
  return { cell, w: cell * cfg.width, h: cell * cfg.height };
}

function draw() {
  const cfg = readForm();
  const { cell, w, h } = cellMetrics();
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = '#10161f';
  ctx.fillRect(0, 0, w, h);

  const s = viewSolver();

  for (let y = 0; y < cfg.height; y++) {
    for (let x = 0; x < cfg.width; x++) {
      const c = y * cfg.width + x;
      const px = x * cell, py = y * cell;
      const pin = app.config.pins.find((p) => p.x === x && p.y === y);
      ctx.fillStyle = '#18202c';
      ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);

      if (s) {
        const mask = s.domains[c];
        const cnt = Solver.popcount(mask);
        if (cnt === 1) {
          const idx = Solver.bits(mask).next().value;
          ctx.fillStyle = s.tiles[idx].color;
          ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
          if (cell >= 26) {
            ctx.fillStyle = 'rgba(0,0,0,.72)';
            ctx.font = `${Math.min(12, cell / 3.2)}px ui-monospace, monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(s.tiles[idx].id, px + cell / 2, py + cell / 2 + 4);
          }
        } else if (cnt > 1) {
          // 多候选：画候选色点
          const idxs = [...Solver.bits(mask)];
          const r = Math.max(2, cell / 10);
          idxs.forEach((ti, k) => {
            const a = (k / idxs.length) * Math.PI * 2;
            ctx.fillStyle = s.tiles[ti].color;
            ctx.beginPath();
            ctx.arc(px + cell / 2 + Math.cos(a) * cell * 0.28, py + cell / 2 + Math.sin(a) * cell * 0.28, r, 0, Math.PI * 2);
            ctx.fill();
          });
        } else {
          // 空域：红色叉
          ctx.strokeStyle = '#d36a6a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + cell - 4, py + cell - 4);
          ctx.moveTo(px + cell - 4, py + 4); ctx.lineTo(px + 4, py + cell - 4);
          ctx.stroke();
        }
      }

      if (pin) {
        ctx.strokeStyle = '#ffd479';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2.5, py + 2.5, cell - 5, cell - 5);
      }
      if (app.selectedCell === c) {
        ctx.strokeStyle = '#7db8ff';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(px + 1.5, py + 1.5, cell - 3, cell - 3);
      }
      ctx.strokeStyle = '#2b3748';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + .5, py + .5, cell, cell);
    }
  }

  // 周期边界标记
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = cfg.wrap_x ? '#5e97d0' : '#3a4657';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1);
  ctx.moveTo(0, 1); ctx.lineTo(w, 1);
  ctx.stroke();
  ctx.strokeStyle = cfg.wrap_y ? '#5e97d0' : '#3a4657';
  ctx.beginPath();
  ctx.moveTo(1, 0); ctx.lineTo(1, h);
  ctx.moveTo(w - 1, 0); ctx.lineTo(w - 1, h);
  ctx.stroke();
  ctx.setLineDash([]);
}

function renderLegend() {
  const host = $('legend');
  host.innerHTML = '';
  for (const t of app.config.tiles) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span class="sw" style="background:${t.color}"></span>${escapeHtml(t.id)}`;
    host.appendChild(chip);
  }
}

canvas.addEventListener('click', (e) => {
  const cfg = readForm();
  const { cell } = cellMetrics();
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / (rect.width / cfg.width));
  const y = Math.floor((e.clientY - rect.top) / (rect.height / cfg.height));
  if (x < 0 || y < 0 || x >= cfg.width || y >= cfg.height) return;
  const c = y * cfg.width + x;
  app.selectedCell = c;
  if (app.pinMode === 'draw') {
    const allowed = [...$('pin-allowed').selectedOptions].map((o) => o.value);
    if (allowed.length === 0) { flash('请先在左侧选择 pin 允许的拼块', 'error'); draw(); return; }
    const existing = app.config.pins.find((p) => p.x === x && p.y === y);
    if (existing) existing.allowed = [...new Set(allowed)];
    else app.config.pins.push({ x, y, allowed: [...new Set(allowed)] });
    invalidateTask('新增/修改固定地块');
    renderPinsList();
  }
  draw(); renderCellInfo();
});

document.querySelectorAll('input[name=pin-mode]').forEach((r) => {
  r.addEventListener('change', () => { app.pinMode = r.value; });
});

$('btn-clear-pins').addEventListener('click', () => {
  if (app.config.pins.length === 0) return;
  app.config.pins = [];
  invalidateTask('清空固定地块');
  renderPinsList();
});

// ---------- 候选与删除原因 ----------
function viewSolver() {
  if (app.viewIndex < 0 || !app.solver) return app.solver;
  return solverAt(app.viewIndex);
}

function solverAt(index) {
  if (!app.solver) return null;
  const target = Math.max(0, Math.min(index, app.solver.trace.length));
  // 找 ≤ target 的最近检查点
  let base = 0;
  const keys = [...app.replayCheckpoints.keys()].sort((a, b) => a - b);
  for (const k of keys) if (k <= target) base = k;
  let s;
  if (app.replayCheckpoints.has(base)) {
    s = app.replayCheckpoints.get(base).clone();
  } else {
    s = new Solver(app.solver.exportConfig());
  }
  let guard = 0;
  while (s.trace.length < target) {
    if (s._pump() === null) break;
    if (++guard > 5_000_000) break;
  }
  return s;
}

function renderCellInfo() {
  const head = $('cell-head');
  const host = $('candidates');
  const reasons = $('reasons');
  host.innerHTML = '';
  reasons.innerHTML = '';
  const s = viewSolver();
  if (app.selectedCell === null) { head.textContent = '点击画布上的格子（查看候选模式）'; return; }
  if (!s) { head.textContent = '运行后可查看候选'; return; }
  const x = app.selectedCell % s.width;
  const y = Math.floor(app.selectedCell / s.width);
  const mask = s.domains[app.selectedCell];
  const ids = s.maskToIds(mask);
  head.textContent = `格 (${x},${y}) · 候选 ${ids.length} 种`;
  if (ids.length === 0) {
    head.textContent += ' · 域已清空（矛盾）';
  }
  const picked = ids.length === 1 ? ids[0] : null;
  for (const id of ids) {
    const t = s.tiles[s.idToIndex.get(id)];
    const div = document.createElement('div');
    div.className = 'cand-item' + (picked === id ? ' picked' : '');
    div.innerHTML = `<span><span class="sw" style="display:inline-block;width:10px;height:10px;background:${t.color};border-radius:2px;margin-right:5px"></span>${escapeHtml(id)}</span><span class="w">w=${t.weight} 边[${t.edges.join(',')}]</span>`;
    host.appendChild(div);
  }

  // 导致删除的邻格：从轨迹中收集本格的 removal 事件
  const idx = app.viewIndex < 0 ? s.trace.length : app.viewIndex;
  const related = s.trace.slice(0, idx).filter((e) => e.type === 'removal' && e.cell === app.selectedCell);
  if (related.length === 0) {
    reasons.innerHTML = '<div class="muted small">该格暂无候选被删除。</div>';
    return;
  }
  reasons.innerHTML = '<div class="muted small" style="margin-bottom:4px">候选删除原因（tile · 邻格方向 · 当时邻格候选）：</div>';
  for (const e of related.slice(-12)) {
    const div = document.createElement('div');
    div.className = 'cand-item';
    div.innerHTML = `<span class="t-removal">✕ ${escapeHtml(e.tile)}</span>
      <span class="muted">${e.dirLabel}邻格(${e.neighborX},${e.neighborY}) 当时候选: {${e.neighborCandidates.map(escapeHtml).join(', ')}}</span>`;
    reasons.appendChild(div);
  }
}

// ---------- 轨迹面板 ----------
const TRACE_RENDER_LIMIT = 400;

function formatEvent(e, i) {
  const pos = e.cell !== undefined ? `(${e.x},${e.y})` : '';
  switch (e.type) {
    case 'pin': return `pin ${pos} → {${e.allowed.join(',')}}`;
    case 'select': return `select ${pos} H=${e.entropy === null ? '-' : e.entropy.toFixed(4)} 顺序[${e.trialOrder.join(',')}]`;
    case 'trial': return `trial #${e.trialsUsed} ${pos} ← ${e.tile}（第${e.trialIndex + 1}试选）`;
    case 'removal': return `removal ${pos} ✕${e.tile} 因${e.dirLabel}邻格(${e.neighborX},${e.neighborY})候选{${e.neighborCandidates.join(',')}} 余[${e.remaining.join(',')}]`;
    case 'contradiction': return `contradiction ${pos} ${e.reason}${e.detail ? ' ' + e.detail : ''}`;
    case 'backtrack': return `backtrack ${pos} ${e.exhausted ? '分支穷尽，恢复父域' : '恢复分支前域，试下一候选'}（rng 不回退）`;
    case 'solved': return `✓ solved（试选 ${e.trialsUsed}/${e.budget}）`;
    case 'unsolvable': return `✗ unsolvable（搜索穷尽，试选 ${e.trialsUsed}）`;
    case 'budget_exhausted': return `⏱ budget_exhausted（${e.trialsUsed}/${e.budget}）`;
    case 'cancelled': return `■ cancelled`;
    default: return JSON.stringify(e);
  }
}

function renderTracePanel() {
  const log = $('trace-log');
  const s = app.solver;
  if (!s) { log.innerHTML = '<span class="muted small">运行后显示轨迹</span>'; refreshControls(); return; }
  const total = s.trace.length;
  const view = app.viewIndex < 0 ? total : Math.min(app.viewIndex, total);
  const start = Math.max(0, view - TRACE_RENDER_LIMIT);
  const frag = document.createDocumentFragment();
  for (let i = start; i < view; i++) {
    const e = s.trace[i];
    const line = document.createElement('div');
    line.className = `trace-line t-${e.type}` + (i === view - 1 ? ' current' : '');
    line.textContent = `#${i} ${formatEvent(e, i)}`;
    line.addEventListener('click', () => { app.viewIndex = i + 1; $('trace-scrub').value = i + 1; refreshControls(); draw(); renderCellInfo(); renderTracePanel(); });
    frag.appendChild(line);
  }
  log.innerHTML = '';
  log.appendChild(frag);
  if ($('follow-tail').checked && app.viewIndex < 0) log.scrollTop = log.scrollHeight;
  refreshControls();
}

$('trace-scrub').addEventListener('input', () => {
  const s = app.solver;
  if (!s) return;
  app.viewIndex = Number($('trace-scrub').value);
  draw(); renderCellInfo(); renderTracePanel();
});
$('btn-trace-prev').addEventListener('click', () => {
  if (!app.solver) return;
  app.viewIndex = Math.max(0, (app.viewIndex < 0 ? app.solver.trace.length : app.viewIndex) - 1);
  draw(); renderCellInfo(); renderTracePanel();
});
$('btn-trace-next').addEventListener('click', () => {
  if (!app.solver) return;
  const cur = app.viewIndex < 0 ? app.solver.trace.length : app.viewIndex;
  app.viewIndex = Math.min(app.solver.trace.length, cur + 1);
  if (app.viewIndex >= app.solver.trace.length) app.viewIndex = -1;
  draw(); renderCellInfo(); renderTracePanel();
});
$('follow-tail').addEventListener('change', (e) => { app.followTail = e.target.checked; });

// ---------- 导出 ----------
function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function requireFinishedSolver() {
  const s = app.solver;
  if (!s) { flash('请先运行求解', 'error'); return null; }
  return s;
}

$('btn-export-config').addEventListener('click', () => {
  try {
    const cfg = validateConfig(readForm());
    const payload = {
      format: 'wfc-tile-foundry-config', version: 1,
      width: cfg.width, height: cfg.height, wrap_x: cfg.wrapX, wrap_y: cfg.wrapY,
      seed: cfg.seed, budget: cfg.budget,
      tiles: cfg.tiles, pins: cfg.pins,
    };
    download('wfc-config.json', JSON.stringify(payload, null, 2));
  } catch (err) { flash(`配置无效：${err.message}`, 'error'); }
});

$('btn-export-trace').addEventListener('click', () => {
  const s = requireFinishedSolver();
  if (!s) return;
  download('wfc-trace.json', JSON.stringify(s.exportTrace(), null, 2));
});

$('btn-export-map').addEventListener('click', () => {
  const s = requireFinishedSolver();
  if (!s || s.status !== STATUS.SOLVED) { flash('只有已求解的地图可导出', 'error'); return; }
  const payload = {
    format: 'wfc-tile-foundry-map', version: 1,
    status: s.status, width: s.width, height: s.height,
    grid: s.getGrid(),
    config: s.exportConfig(),
  };
  download('wfc-map.json', JSON.stringify(payload, null, 2));
});

$('btn-export-png').addEventListener('click', () => {
  const s = requireFinishedSolver();
  if (!s || s.status !== STATUS.SOLVED) { flash('只有已求解的地图可导出', 'error'); return; }
  const cell = 32;
  const cnv = document.createElement('canvas');
  cnv.width = s.width * cell;
  cnv.height = s.height * cell;
  const g = cnv.getContext('2d');
  const grid = s.getGrid();
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const t = s.tiles[s.idToIndex.get(grid[y][x])];
      g.fillStyle = t.color;
      g.fillRect(x * cell, y * cell, cell, cell);
      g.fillStyle = 'rgba(0,0,0,.7)';
      g.font = '11px monospace';
      g.textAlign = 'center';
      g.fillText(t.id, x * cell + cell / 2, y * cell + cell / 2 + 4);
    }
  }
  const a = document.createElement('a');
  a.href = cnv.toDataURL('image/png');
  a.download = 'wfc-map.png';
  a.click();
});

// ---------- 导入 ----------
$('btn-import-config').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) { flash('JSON 解析失败', 'error'); return; }
  if (data.format === 'wfc-tile-foundry-trace' && data.config) {
    loadConfigIntoForm(data.config);
    app.importedTrace = data;
    flash('已导入求解轨迹，可回放或复算校验', 'ok');
    const s = startSolver();
    if (s) { app.rafId = requestAnimationFrame(runLoop); }
  } else if (data.format === 'wfc-tile-foundry-config' || data.tiles) {
    const cfg = data.format === 'wfc-tile-foundry-config' ? data : data;
    loadConfigIntoForm(cfg);
    app.importedTrace = null;
    flash('配置已导入，点击运行复现结果', 'ok');
  } else {
    flash('无法识别的文件格式', 'error');
  }
  e.target.value = '';
});

function loadConfigIntoForm(cfg) {
  invalidateSilently();
  app.config = {
    width: cfg.width,
    height: cfg.height,
    wrap_x: !!cfg.wrap_x,
    wrap_y: !!cfg.wrap_y,
    seed: cfg.seed,
    budget: cfg.budget,
    tiles: cfg.tiles.map((t) => ({ ...t, edges: [...t.edges] })),
    pins: (cfg.pins ?? []).map((p) => ({ x: p.x, y: p.y, allowed: [...p.allowed] })),
  };
  app.solver = null;
  app.selectedCell = null;
  syncForm();
  refreshControls(); draw(); renderLegend(); renderTracePanel(); renderCellInfo();
}

$('btn-verify-replay').addEventListener('click', () => {
  if (!app.importedTrace) return;
  const s = new Solver(app.importedTrace.config);
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  const mine = s.exportTrace();
  const sameTrace = JSON.stringify(mine.trace) === JSON.stringify(app.importedTrace.trace);
  const sameStatus = mine.status === app.importedTrace.status;
  const sameRng = mine.rngFinalState === app.importedTrace.rngFinalState;
  if (sameTrace && sameStatus && sameRng) {
    flash(`复算一致：${mine.trace.length} 个事件、状态 ${mine.status}、RNG 终态相同，轨迹可复现`, 'ok', 8000);
  } else {
    flash(`复算不一致！轨迹${sameTrace ? '' : '不同'} 状态${sameStatus ? '' : '不同'} RNG${sameRng ? '' : '不同'}`, 'error', 8000);
  }
});

// ---------- 样例加载 ----------
async function loadSample(name) {
  try {
    const r = await fetch(`sample-data/${name}.json`);
    if (!r.ok) throw new Error(r.status);
    const cfg = await r.json();
    loadConfigIntoForm(cfg);
    app.importedTrace = null;
    flash(`已加载样例 ${name}，点击运行`, 'ok');
  } catch {
    flash('样例加载失败：请通过本地服务器打开页面（见 README）', 'error', 6000);
  }
}
$('btn-sample-even').addEventListener('click', () => loadSample('checker-even'));
$('btn-sample-odd').addEventListener('click', () => loadSample('checker-odd'));
$('btn-sample-backtrack').addEventListener('click', () => loadSample('backtrack'));

// ---------- 拼块增删 / 表单约束变更 ----------
$('btn-add-tile').addEventListener('click', () => {
  if (app.config.tiles.length >= 24) { flash('最多 24 种拼块', 'error'); return; }
  let n = app.config.tiles.length;
  let id = `t${n + 1}`;
  while (app.config.tiles.some((t) => t.id === id)) id = `t${++n + 1}`;
  app.config.tiles.push({ id, weight: 1, edges: ['e', 'e', 'e', 'e'], color: randomColor() });
  invalidateTask('新增拼块');
  renderTileEditor(); renderPinAllowedSelect(); renderLegend();
});

function randomColor() {
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h},45%,58%)`;
}

// 尺寸/边界/种子/预算：尺寸与边界属于约束变更
['cfg-width', 'cfg-height', 'cfg-wrap-x', 'cfg-wrap-y'].forEach((id) => {
  $(id).addEventListener('change', () => {
    const w = Number($('cfg-width').value);
    const h = Number($('cfg-height').value);
    // 越界 pin 直接清掉
    app.config.pins = app.config.pins.filter((p) => p.x < w && p.y < h);
    app.config = { ...app.config, width: w, height: h, wrap_x: $('cfg-wrap-x').checked, wrap_y: $('cfg-wrap-y').checked };
    app.selectedCell = null;
    invalidateTask('地图尺寸或周期边界已修改');
    renderPinsList();
  });
});
['cfg-seed', 'cfg-budget'].forEach((id) => {
  $(id).addEventListener('change', () => {
    app.config.seed = Number($('cfg-seed').value);
    app.config.budget = Number($('cfg-budget').value);
    // 种子/预算不改变约束：若当前无活动任务，仅刷新；有活动任务则下次运行生效
    refreshControls();
  });
});

window.addEventListener('resize', () => { draw(); });

// ---------- 初始化 ----------
window.__wfc = app; // 调试钩子
// 正规配置入口：同步内部 config 与表单，并取消旧任务
app.setConfig = function (cfg) {
  invalidateSilently();
  app.config = {
    width: cfg.width,
    height: cfg.height,
    wrap_x: !!cfg.wrap_x,
    wrap_y: !!cfg.wrap_y,
    seed: cfg.seed,
    budget: cfg.budget,
    tiles: cfg.tiles.map((t) => ({ ...t, edges: [...t.edges] })),
    pins: (cfg.pins ?? []).map((p) => ({ x: p.x, y: p.y, allowed: [...p.allowed] })),
  };
  app.solver = null;
  app.selectedCell = null;
  syncForm();
  refreshControls(); draw(); renderLegend(); renderTracePanel(); renderCellInfo();
};
syncForm();
refreshControls();
renderLegend();
draw();
renderTracePanel();
renderCellInfo();
