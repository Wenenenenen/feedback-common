/* 伙伴状态图调试台 UI
 * 架构：head Runner 始终位于轨迹末端负责扩展；任意 cursor 的视图状态都从
 * 最近 64 步检查点确定性重放得到（spawn + step），因此拖动时间轴可任意往返。
 * 无框架、无依赖，可直接 file:// 打开。
 */
/* global CompanionRunner */
'use strict';

const R = window.CompanionRunner;
const CP_EVERY = 64;
const HARD_CAP = 2_000_000;
const ROW_H = 29;
const TRACE_OVERSCAN = 10;

const $ = (id) => document.getElementById(id);
const clone = (o) => R.cloneState(o);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const KIND_LABEL = {
  init: '初始化', input: '输入', timer: '定时器', internal: '内部', rollback: '回滚',
};

// ---------------- 内置图 ----------------
const SAMPLE = {
  rules: '普通复合节点进入 initial，parallel 节点进入全部直接子节点。转移的 source 活跃即可参选；exitRoot 必须包含 source，重入该子树，target 指定一条目的路径，其余分区走初始值；history=true 时优先用该退出根记录的完整活跃配置，未记录时走默认。退出根包含自身。guard 是变量整数等值表；set 是赋值表；emit 是事件名列表。timers 在进入时登记，正整数延时，到点发布内部同名事件；同毫秒多个有效定时器按登记顺序处理。无转移的事件不计生效微步。',
  root: 1,
  states: [
    { id: 1, initial: 2 },
    { id: 2, parent: 1 },
    { id: 3, parent: 1, timers: [{ after: 8, event: 'rest' }] },
  ],
  vars: { mood: 0 },
  edges: [
    { id: 1, source: 2, exitRoot: 1, target: 3, event: 'follow', set: { mood: 1 } },
    { id: 2, source: 3, exitRoot: 1, target: 2, event: 'rest', set: { mood: 0 } },
  ],
  inputs: [{ ms: 0, event: 'follow' }, { ms: 12, event: 'idle' }],
};

const DEMO = {
  name: '伙伴豆豆：跟随动作 × 表情并行 × 剧情打断',
  root: 1,
  vars: { bond: 0, mood: 0 },
  states: [
    { id: 1, parallel: true, name: '伙伴根（动作 ‖ 表情）' },
    { id: 10, parent: 1, initial: 11, name: '动作轨道' },
    { id: 11, parent: 10, name: '待机 Idle' },
    { id: 12, parent: 10, name: '跟随 Follow', timers: [{ after: 8, event: 'rest' }] },
    { id: 13, parent: 10, name: '剧情特写 Cutscene' },
    { id: 20, parent: 1, initial: 21, name: '表情轨道' },
    { id: 21, parent: 20, name: '平常 Normal' },
    { id: 22, parent: 20, name: '眨眼 Blink', timers: [{ after: 2, event: 'blinkDone' }] },
    { id: 23, parent: 20, name: '开心 Happy', timers: [{ after: 6, event: 'coolDown' }] },
  ],
  edges: [
    { id: 1, source: 11, exitRoot: 10, target: 12, event: 'follow', set: { bond: 1 }, emit: ['blink'] },
    { id: 2, source: 12, exitRoot: 10, target: 11, event: 'wait' },
    { id: 3, source: 12, exitRoot: 10, target: 13, event: 'story' },
    { id: 4, source: 11, exitRoot: 10, target: 13, event: 'story' },
    { id: 5, source: 13, exitRoot: 10, target: 11, event: 'storyEnd', history: true },
    { id: 6, source: 12, exitRoot: 10, target: 11, event: 'rest' },
    { id: 7, source: 21, exitRoot: 20, target: 22, event: 'blink' },
    { id: 8, source: 22, exitRoot: 20, target: 21, event: 'blinkDone' },
    { id: 9, source: 21, exitRoot: 20, target: 23, event: 'praise', set: { mood: 2 } },
    { id: 10, source: 23, exitRoot: 20, target: 21, event: 'coolDown', set: { mood: 0 } },
  ],
  inputs: [
    { ms: 0, event: 'follow' },
    { ms: 3, event: 'story' },
    { ms: 5, event: 'storyEnd' },
    { ms: 10, event: 'praise' },
    { ms: 12, event: 'wait' },
    { ms: 30, event: 'follow' },
  ],
};

function makeStressChart() {
  const chart = {
    name: '规模压测：50000 输入',
    root: 1,
    vars: { n: 0 },
    states: [
      { id: 1, initial: 2, name: '根' },
      { id: 2, parent: 1, name: 'A' },
      { id: 3, parent: 1, name: 'B' },
    ],
    edges: [
      { id: 1, source: 2, exitRoot: 1, target: 3, event: 'a', set: { n: 1 } },
      { id: 2, source: 3, exitRoot: 1, target: 2, event: 'a', set: { n: 2 } },
    ],
    inputs: [],
  };
  for (let i = 0; i < 50000; i++) chart.inputs.push({ ms: i, event: 'a' });
  return chart;
}

// ---------------- 会话状态 ----------------
let chartObj = null;
let head = null;          // head.state 永远等于 trace 末端状态
let cc = null;
let trace = [];
let cps = new Map();
let cursor = 0;
let viewState = null;     // cursor 对应的状态
let nodeEls = new Map();
let collapsed = new Set();
let edgeFilter = '';

let primeTimer = null;
let playTimer = null;
let playing = false;
let traceStick = true;

// ---------------- 加载 / 推演 ----------------
function loadChart(chart) {
  stopAllTimers();
  chartObj = chart;
  head = R.create(chart);           // 可能抛编译错误
  cc = head.cc;
  trace = head.trace;
  cps = new Map([[0, clone(head.state)]]);
  cursor = 0;
  viewState = clone(head.state);
  collapsed = new Set();
  edgeFilter = '';
  $('edgeFilter').value = '';
  traceStick = true;
  $('btnTraceFollow').hidden = true;

  buildEdgeList();
  buildDiagram();
  renderAll();
  schedulePrime();
}

function stopAllTimers() {
  if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
  stopPlayback();
}
function stopPlayback() {
  playing = false;
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  const b = $('btnPlay');
  if (b) { b.textContent = '▶ 播放'; b.classList.remove('playing'); }
}

function schedulePrime() {
  if (primeTimer) clearTimeout(primeTimer);
  primeTimer = setTimeout(primeChunk, 30);
}

function primeChunk() {
  primeTimer = null;
  if (playing) return;
  const t0 = performance.now();
  while (performance.now() - t0 < 50) {
    if (!head.hasNext() || head.state.micro >= HARD_CAP) break;
    const e = head.step();
    if (!e) break;
    if (e.seq % CP_EVERY === 0) cps.set(e.seq, clone(head.state));
  }
  updateTimelineBounds();
  if (head.hasNext() && head.state.micro < HARD_CAP) {
    $('primeLabel').textContent = `后台推演中… 已生成 ${trace.length - 1} 步`;
    primeTimer = setTimeout(primeChunk, 0);
  } else {
    $('primeLabel').textContent = head.state.micro >= HARD_CAP ? `达到安全上限 ${HARD_CAP}` : '';
    renderAll();
  }
}

function flushHead() {
  if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
  let guard = 0;
  while (head.hasNext() && head.state.micro < HARD_CAP && guard < HARD_CAP) {
    const e = head.step();
    if (!e) break;
    if (e.seq % CP_EVERY === 0) cps.set(e.seq, clone(head.state));
    guard++;
  }
  updateTimelineBounds();
}

/** 从最近检查点确定性重放到 seq，返回全新的纯状态。 */
function computeState(seq) {
  let cp = 0;
  for (const k of cps.keys()) if (k <= seq && k > cp) cp = k;
  if (!cps.has(cp)) cp = 0;
  const t = head.spawn(cps.get(cp));
  for (let i = cp + 1; i <= seq; i++) t.step();
  return t.state;
}

function goto(seq) {
  seq = Math.max(0, Math.min(seq, trace.length - 1));
  cursor = seq;
  viewState = computeState(seq);
  traceStick = true;
  $('btnTraceFollow').hidden = true;
  renderAll();
}

/** 前进一步：若前方已有轨迹则沿轨迹重放，否则在 head 末端执行。 */
function advanceOnce() {
  if (cursor < trace.length - 1) {
    cursor++;
    viewState = computeState(cursor);
    return trace[cursor];
  }
  if (!head.hasNext() || head.state.micro >= HARD_CAP) return null;
  const e = head.step();
  if (!e) return null;
  if (e.seq % CP_EVERY === 0) cps.set(e.seq, clone(head.state));
  cursor = e.seq;
  viewState = clone(head.state);
  updateTimelineBounds();
  return e;
}

function manualAdvance() {
  stopPlayback();
  advanceOnce();
  traceStick = true;
  $('btnTraceFollow').hidden = true;
  renderAll();
}

function nextInput() {
  stopPlayback();
  for (let i = 0; i < 1_000_000; i++) {
    const e = advanceOnce();
    if (!e) break;
    if (e.kind === 'input') break;
  }
  traceStick = true;
  $('btnTraceFollow').hidden = true;
  renderAll();
}

function togglePlay() {
  if (playing) { stopPlayback(); return; }
  if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
  playing = true;
  $('btnPlay').textContent = '⏸ 暂停';
  $('btnPlay').classList.add('playing');
  traceStick = true;
  const chunk = () => {
    playTimer = null;
    const t0 = performance.now();
    let e = null;
    while (performance.now() - t0 < 60) {
      e = advanceOnce();
      if (!e) break;
    }
    renderAll();
    const canMore = cursor < trace.length - 1 ||
      (head.hasNext() && head.state.micro < HARD_CAP);
    if (canMore && playing) {
      playTimer = setTimeout(chunk, 0);
    } else {
      stopPlayback();
      renderAll();
    }
  };
  playTimer = setTimeout(chunk, 0);
}

// ---------------- 快照 ----------------
function exportSnapshot() {
  stopPlayback();
  const btn = $('btnExport');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '正在生成完整轨迹…';
  setTimeout(() => {
    try {
      flushHead();
      // 导出游标处的状态 + 完整轨迹 + 游标，导回后可沿轨迹复核再继续
      const data = {
        kind: 'companion-statechart-snapshot',
        version: 1,
        app: 'companion-statechart-reel',
        exportedAt: new Date().toISOString(),
        chart: chartObj,
        cursor,
        state: clone(viewState),
        trace,
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `companion-snapshot-step${cursor}-t${viewState.time}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      showMsg(`已导出快照：步 ${cursor}，t=${viewState.time}ms，轨迹 ${trace.length} 行`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      renderAll();
    }
  }, 30);
}

function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') {
    return '{' + Object.keys(o).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}

function importSnapshotFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { showMsg('快照 JSON 解析失败：' + e.message, true); return; }

    // 兼容本台导出的信封，以及测试用的裸 {chart,state,trace}
    const chart = data.chart;
    const dataState = data.state;
    const dataTrace = data.trace;
    if (!chart || !dataState || !Array.isArray(dataTrace)) {
      showMsg('不是有效的快照：需要 chart / state / trace 字段', true);
      return;
    }
    showMsg('正在从头确定性重放以校验快照…', false);
    setTimeout(() => {
      try {
        loadChart(chart);
        if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }

        const targetLast = dataTrace.length - 1;
        let entriesMatch = dataTrace[0] && canonical(head.trace[0]) === canonical(dataTrace[0]);
        let firstMismatch = entriesMatch ? -1 : 0;
        for (let s = 1; s <= targetLast; s++) {
          if (!head.hasNext()) {
            if (firstMismatch < 0) firstMismatch = s;
            entriesMatch = false;
            break;
          }
          const e = head.step();
          if (e.seq % CP_EVERY === 0) cps.set(e.seq, clone(head.state));
          if (canonical(e) !== canonical(dataTrace[s])) {
            entriesMatch = false;
            if (firstMismatch < 0) firstMismatch = s;
          }
        }

        const wantedCursor = Number.isInteger(data.cursor)
          ? Math.max(0, Math.min(data.cursor, dataTrace.length - 1))
          : targetLast;
        cursor = wantedCursor;
        viewState = computeState(wantedCursor);
        const stateMatch = canonical(viewState) === canonical(dataState);

        $('chartSrc').value = JSON.stringify(chart, null, 2);
        traceStick = true;
        renderAll();

        if (entriesMatch && stateMatch) {
          showMsg(`快照已导回并通过一致性校验：步 ${wantedCursor}，t=${viewState.time}ms。` +
            `转移、变量、事件轨迹将与原运行完全一致，可继续运行。`, false);
        } else {
          showMsg(`快照已导回（步 ${wantedCursor}）。注意：重放校验未完全一致` +
            `${firstMismatch >= 0 ? `（首个差异在轨迹第 ${firstMismatch} 行）` : ''}` +
            `${stateMatch ? '' : '，游标处状态与快照不同'}` +
            `；当前展示的是同一图的确定性重放，可在此基础上继续。`, true);
        }
      } catch (e) {
        showMsg('快照中的图定义编译/重放失败：\n' + (e && e.message), true);
      }
    }, 30);
  };
  reader.readAsText(file);
}

// ---------------- 消息 ----------------
function showMsg(text, isErr) {
  const el = $('compileMsg');
  el.textContent = text;
  el.className = 'msg ' + (isErr ? 'err' : 'ok');
}

function compileFromEditor() {
  let chart;
  try { chart = JSON.parse($('chartSrc').value); }
  catch (e) { showMsg('JSON 解析失败：' + e.message, true); return; }
  try {
    loadChart(chart);
    showMsg(`编译成功：${cc.byId.size} 个状态，${cc.edges.length} 条转移，` +
      `${cc.inputs.length} 条输入。已在后台推演完整时间轴。`, false);
  } catch (e) {
    showMsg('编译失败：\n' + e.message, true);
  }
}

// ---------------- 转移列表 ----------------
function buildEdgeList() {
  const el = $('edges');
  el.innerHTML = '';
  $('edgeCount').textContent = String(cc.edges.length);
  for (const e of cc.edges) {
    const row = document.createElement('div');
    row.className = 'edge-row';
    row.dataset.eid = String(e.id);
    const search = [
      e.id, e.event, e.source, e.target, e.exitRoot,
      e.guard && JSON.stringify(e.guard), e.set && JSON.stringify(e.set),
      e.emit && e.emit.join(','), e.history ? 'history' : '',
    ].join(' ').toLowerCase();
    row.dataset.search = search;

    const bits = [];
    if (e.guard) bits.push(`guard ${esc(JSON.stringify(e.guard))}`);
    if (e.set) bits.push(`set ${esc(JSON.stringify(e.set))}`);
    if (e.emit) bits.push(`emit ${esc(JSON.stringify(e.emit))}`);
    if (e.history) bits.push('history');

    row.innerHTML =
      `<span class="eid">#${e.id}</span>` +
      `<span class="eev">${esc(e.event)}</span>` +
      `<div class="emain">` +
        `<div class="eflow">${e.source} → ${e.target != null ? e.target : '默认'}` +
          ` <span class="root-tag">exitRoot ${e.exitRoot}${e.history === true ? ' · ⟲H' : ''}</span></div>` +
        (bits.length ? `<div class="emeta">${bits.map((b) => `<span class="tag">${b}</span>`).join('')}</div>` : '') +
      `</div>`;
    el.appendChild(row);
  }
  applyEdgeFilter();
}

function applyEdgeFilter() {
  edgeFilter = ($('edgeFilter').value || '').trim().toLowerCase();
  for (const row of document.querySelectorAll('.edge-row')) {
    const hide = edgeFilter && !row.dataset.search.includes(edgeFilter);
    row.classList.toggle('dimmed', !!hide);
  }
}

function updateEdgeFired() {
  const entry = trace[cursor];
  const fired = new Set(entry && entry.fired ? entry.fired : []);
  const rejected = entry && entry.kind === 'rollback';
  for (const row of document.querySelectorAll('.edge-row')) {
    const id = Number(row.dataset.eid);
    row.classList.toggle('fired', !rejected && fired.has(id));
    row.classList.toggle('rejected', !!rejected && fired.has(id));
  }
}

function locateEdge(id) {
  if (edgeFilter) {
    $('edgeFilter').value = '';
    applyEdgeFilter();
  }
  const row = document.querySelector(`.edge-row[data-eid="${id}"]`);
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }],
      { duration: 500 },
    );
  }
}

// ---------------- 状态图 ----------------
function buildDiagram() {
  nodeEls = new Map();
  const root = $('diagram');
  root.innerHTML = '';
  root.appendChild(buildNode(cc.root, false, false));
}

function buildNode(id, asRegion, regionChild) {
  const s = cc.byId.get(id);
  const kids = cc.childrenOf.get(id) || [];
  const isPar = cc.isParallel(s);
  const hasKids = kids.length > 0;
  const isCollapsed = collapsed.has(id);

  const wrap = document.createElement('div');
  wrap.className = 'd-node' + (asRegion ? ' region' : '');
  wrap.dataset.nodeId = String(id);

  if (asRegion) {
    const lab = document.createElement('div');
    lab.className = 'region-label';
    lab.textContent = `并行分区 #${id}${s.name || s.label ? ' · ' + (s.name || s.label) : ''}`;
    wrap.appendChild(lab);
  }

  const box = document.createElement('div');
  box.className = 'node-box';

  const headEl = document.createElement('div');
  headEl.className = 'node-head';
  const caret = document.createElement('span');
  caret.className = 'caret' + (hasKids ? '' : ' leaf');
  caret.textContent = hasKids ? (isCollapsed ? '▶' : '▼') : '•';
  if (hasKids) caret.title = isCollapsed ? '展开' : '折叠';
  const idEl = document.createElement('span');
  idEl.className = 'node-id';
  idEl.textContent = `#${id}`;
  const nameEl = document.createElement('span');
  nameEl.className = 'node-name';
  const nm = s.name || s.label || '';
  nameEl.textContent = nm;
  nameEl.title = nm;
  headEl.append(caret, idEl, nameEl);
  box.appendChild(headEl);

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (isPar) {
    const b = document.createElement('span');
    b.className = 'badge parallel';
    b.textContent = '⫿ PARALLEL';
    badges.appendChild(b);
  } else if (hasKids && s.initial != null) {
    const b = document.createElement('span');
    b.className = 'badge initial';
    b.textContent = `initial → ${s.initial}`;
    badges.appendChild(b);
  }
  const timerSlot = document.createElement('span');
  timerSlot.className = 'timer-slot';
  timerSlot.style.display = 'contents';
  badges.appendChild(timerSlot);
  box.appendChild(badges);

  wrap.appendChild(box);
  nodeEls.set(id, wrap);

  if (hasKids) {
    const body = document.createElement('div');
    body.className = 'children' + (isPar ? ' parallel' : '') + (isCollapsed ? ' collapsed' : '');
    for (const c of kids) body.appendChild(buildNode(c, isPar, true));
    wrap.appendChild(body);

    caret.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      buildDiagram();
      updateDiagramState();
      drawEdgeOverlay();
    });
  }
  return wrap;
}

function updateDiagramState() {
  if (!viewState) return;
  const active = new Set(viewState.config);
  const timersByState = new Map();
  for (const t of viewState.timers) {
    if (!timersByState.has(t.state)) timersByState.set(t.state, []);
    timersByState.get(t.state).push(t);
  }

  for (const [id, wrap] of nodeEls) {
    const box = wrap.querySelector('.node-box');
    const isActive = active.has(id);
    wrap.classList.toggle('inactive', !isActive);
    box.classList.toggle('active', isActive);

    const slot = wrap.querySelector('.timer-slot');
    if (slot) {
      const ts = timersByState.get(id);
      slot.innerHTML = ts
        ? ts.map((t) => `<span class="badge timer" title="定时器 #${t.id}，到期 ${t.due}ms">` +
            `⏱ ${esc(t.event)} @${t.due}</span>`).join('')
        : '';
    }
  }

  // 当前步胜出边的源/目标高亮
  const entry = trace[cursor];
  const ids = entry && entry.fired ? entry.fired : [];
  for (const wrap of nodeEls.values()) {
    wrap.querySelector('.node-box').classList.remove('fired-src', 'rejected-src');
  }
  for (const eid of ids) {
    const e = cc.edges.find((x) => x.id === eid);
    if (!e) continue;
    const mark = (nid, cls) => {
      const w = nodeEls.get(nid);
      if (w) w.querySelector('.node-box').classList.add(cls);
    };
    const cls = entry.kind === 'rollback' ? 'rejected-src' : 'fired-src';
    mark(e.source, cls);
    if (e.target != null) mark(e.target, cls);
  }
  drawEdgeOverlay();
}

function drawEdgeOverlay() {
  const svg = $('edgeLayer');
  const canvas = $('diagramCanvas');
  if (!svg || !canvas || !cc) return;

  // 清掉旧的边/标签（保留 defs）
  svg.querySelectorAll('.edge-path, .edge-label-g').forEach((n) => n.remove());

  const W = Math.max(canvas.scrollWidth, canvas.clientWidth);
  const H = Math.max(canvas.scrollHeight, canvas.clientHeight);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.width = W + 'px';
  svg.style.height = H + 'px';

  const entry = trace[cursor];
  if (!entry || !entry.fired || !entry.fired.length) return;
  const rejected = entry.kind === 'rollback';
  const marker = rejected ? 'url(#arrowDanger)' : 'url(#arrowFired)';

  const cr = canvas.getBoundingClientRect();
  const rectOf = (id) => {
    const w = nodeEls.get(id);
    if (!w) return null;
    const r = w.querySelector('.node-box').getBoundingClientRect();
    return { x: r.left - cr.left, y: r.top - cr.top, cx: r.left - cr.left + r.width / 2,
      cy: r.top - cr.top + r.height / 2, w: r.width, h: r.height };
  };
  const borderPoint = (r, tx, ty) => {
    const dx = tx - r.cx, dy = ty - r.cy;
    const sx = dx === 0 ? Infinity : (r.w / 2) / Math.abs(dx);
    const sy = dy === 0 ? Infinity : (r.h / 2) / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: r.cx + dx * s, y: r.cy + dy * s };
  };

  for (const eid of entry.fired) {
    const e = cc.edges.find((x) => x.id === eid);
    if (!e) continue;
    const a = rectOf(e.source);
    const b = e.target != null ? rectOf(e.target) : null;
    if (!a) continue;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge-path' + (rejected ? ' rejected' : '') + (!b || e.target === e.source ? ' self' : ''));
    path.setAttribute('marker-end', marker);

    let d;
    let midX, midY;
    if (!b || e.target === e.source) {
      // 自环 / 无 target：在节点右上角画一个回环
      const x0 = a.x + a.w * 0.72, y0 = a.y;
      d = `M ${x0} ${y0} C ${x0 + 46} ${y0 - 34}, ${x0 + 52} ${y0 + 30}, ${a.x + a.w * 0.98} ${a.y + a.h / 2}`;
      midX = x0 + 40; midY = y0 - 6;
    } else {
      const p1 = borderPoint(a, b.cx, b.cy);
      const p2 = borderPoint(b, a.cx, a.cy);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = Math.min(34, len * 0.12);
      const cx = mx + (-dy / len) * bend;
      const cy = my + (dx / len) * bend;
      d = `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`;
      midX = 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x;
      midY = 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y;
    }
    path.setAttribute('d', d);
    svg.appendChild(path);

    let lx = midX, ly = midY;
    try {
      const mp = path.getPointAtLength(path.getTotalLength() / 2);
      lx = mp.x; ly = mp.y;
    } catch { /* 用估算中点 */ }

    const text = `#${eid} ${e.event}`;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'edge-label-g');
    const tw = text.length * 6.5 + 14;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'edge-label-bg' + (rejected ? ' rejected' : ''));
    rect.setAttribute('x', lx - tw / 2);
    rect.setAttribute('y', ly - 10);
    rect.setAttribute('width', tw);
    rect.setAttribute('height', 19);
    rect.setAttribute('rx', 6);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('class', 'edge-label');
    t.setAttribute('x', lx);
    t.setAttribute('y', ly + 3.5);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = text;
    g.append(rect, t);
    svg.appendChild(g);
  }
}

// ---------------- 右侧面板 ----------------
function renderVars() {
  const el = $('vars');
  const keys = Object.keys(viewState.vars);
  if (!keys.length) { el.innerHTML = '<tr><td class="empty">（无整数变量）</td></tr>'; return; }
  el.innerHTML = keys.map((k) =>
    `<tr data-k="${esc(k)}"><td>${esc(k)}</td><td>${esc(viewState.vars[k])}</td></tr>`).join('');
}

function renderTimers() {
  const el = $('timers');
  const ts = viewState.timers.slice().sort((a, b) => a.due - b.due || a.id - b.id);
  if (!ts.length) { el.innerHTML = '<div class="empty">（无挂起定时器）</div>'; return; }
  el.innerHTML = ts.map((t) =>
    `<div class="item" title="登记序号 #${t.id}，属于状态 ${t.state} 的本次进入">` +
    `#${t.id} 状态${t.state} · ${esc(t.event)}<br>到期 t=${t.due} · 剩 ${Math.max(0, t.due - viewState.time)}ms</div>`).join('');
}

function renderQueue() {
  const el = $('queue');
  if (!viewState.queue.length) { el.innerHTML = '<div class="empty">（空）</div>'; return; }
  el.innerHTML = viewState.queue.map((ev, i) =>
    `<span class="chip" title="队列位置 ${i + 1}">${esc(ev)}</span>`).join('');
}

function renderHistory() {
  const el = $('history');
  const keys = Object.keys(viewState.history);
  if (!keys.length) { el.innerHTML = '<span class="empty">（尚无退出记录；发生带 exitRoot 的退出后，这里会记住完整活跃配置）</span>'; return; }
  el.innerHTML = keys.map((k) =>
    `<span class="hist-chip" title="exitRoot ${esc(k)} 上次退出时记录的完整活跃配置">` +
    `H[<b>${esc(k)}</b>] → {${viewState.history[k].join(',')}}</span>`).join('');
}

function renderNarration() {
  const el = $('narration');
  const t = trace[cursor];
  if (!t) { el.innerHTML = ''; return; }

  if (t.kind === 'init') {
    el.innerHTML = `<span class="n-ev kind-init">init</span> ` +
      `<span class="n-muted">进入根节点的默认配置，初始活跃状态：</span> ` +
      `<code>[${viewState.config.join(', ')}]</code>`;
    return;
  }

  const kindCls = `kind-${t.kind}`;
  const kindName = KIND_LABEL[t.kind] || t.kind;
  const where = [];
  if (t.inputIndex != null) where.push(`输入序列 #${t.inputIndex}`);
  if (t.timerId != null) where.push(`定时器 #${t.timerId}（状态 ${t.timerState}）`);

  let html = `<span class="n-ev ${kindCls}">${kindName} · ${esc(t.event)}</span>` +
    ` <span class="n-muted">@ ${t.ms}ms${where.length ? ' · ' + where.join('，') : ''}</span>`;

  if (t.kind === 'rollback') {
    html += `<div class="n-warn">⛔ ${esc(t.reason || viewState.haltReason || '超过 256 个生效微步')}</div>`;
    if (t.fired.length) html += `<div class="n-muted">触发达限的候选边（未执行，已随回滚撤销）：` +
      t.fired.map((id) => `<span class="n-edge" data-eid="${id}">#${id}</span>`).join('') + `</div>`;
    el.innerHTML = html;
    bindNarrationChips(el);
    return;
  }

  if (!t.fired.length) {
    html += `<div class="n-muted">没有 source 活跃且守卫通过的转移 —— 不计生效微步。</div>`;
  } else {
    html += `<div>${t.fired.length} 条胜出边按选中顺序执行：` +
      t.fired.map((id) => `<span class="n-edge" data-eid="${id}">#${id}</span>`).join('') + `</div>`;
    const details = [];
    for (const id of t.fired) {
      const e = cc.edges.find((x) => x.id === id);
      if (!e) continue;
      if (e.set) details.push(`#${id} set ${esc(JSON.stringify(e.set))}`);
      if (e.emit) details.push(`#${id} emit ${esc(JSON.stringify(e.emit))}`);
    }
    if (details.length) html += `<div class="n-muted">${details.join(' ｜ ')}</div>`;
  }
  el.innerHTML = html;
  bindNarrationChips(el);
}

function bindNarrationChips(el) {
  el.querySelectorAll('.n-edge[data-eid]').forEach((c) => {
    c.addEventListener('click', () => locateEdge(Number(c.dataset.eid)));
  });
}

// ---------------- 轨迹虚拟列表 ----------------
function traceRowHtml(t, isCurrent) {
  const fired = t.fired && t.fired.length
    ? `<span class="fired">边[${t.fired.join(',')}]</span>`
    : '<span class="noop">—</span>';
  const detail = t.event != null ? `${esc(t.event)} ${fired}` : fired;
  return `<div class="tr kind-${t.kind}${isCurrent ? ' current' : ''}" data-seq="${t.seq}">` +
    `<span class="seq">${t.seq}</span>` +
    `<span class="ms">${t.ms}ms</span>` +
    `<span class="kind-tag">${KIND_LABEL[t.kind] || t.kind}</span>` +
    `<span class="tdetail">${detail}</span>` +
  `</div>`;
}

function paintTraceRows() {
  const scroll = $('trace');
  const pad = $('tracePad');
  const win = $('traceWindow');
  if (!scroll || !trace.length) return;
  const N = trace.length;
  pad.style.height = (N * ROW_H) + 'px';

  const top = scroll.scrollTop;
  const vh = scroll.clientHeight || 400;
  let start = Math.max(0, Math.floor(top / ROW_H) - TRACE_OVERSCAN);
  const count = Math.ceil(vh / ROW_H) + TRACE_OVERSCAN * 2;
  const end = Math.min(N, start + count);
  start = Math.max(0, end - count);

  let html = '';
  for (let i = start; i < end; i++) html += traceRowHtml(trace[i], i === cursor);
  win.innerHTML = html;
  win.style.transform = `translateY(${start * ROW_H}px)`;
}

function followCursorInTrace() {
  if (!traceStick) return;
  const scroll = $('trace');
  const target = cursor * ROW_H - scroll.clientHeight / 2 + ROW_H / 2;
  scroll.scrollTop = Math.max(0, target);
  paintTraceRows();
}

// ---------------- 状态条 / 时间轴 ----------------
function updateTimelineBounds() {
  const tl = $('timeline');
  tl.max = String(trace.length - 1);
  if (document.activeElement !== tl) tl.value = String(cursor);
  $('traceCount').textContent = String(trace.length);
}

function renderChrome() {
  const st = viewState;
  $('pillTime').textContent = String(st.time);
  $('pillMicro').textContent = String(st.micro);
  $('pillEff').textContent = String(st.effective);
  $('pillInput').textContent = `${st.nextInput}/${cc.inputs.length}`;
  $('pillActive').textContent = String(st.config.length);

  const atTip = cursor >= trace.length - 1;
  let label, cls;
  if (st.halted) { label = '已停住'; cls = 'halt'; }
  else if (!atTip) { label = `回看 #${cursor}`; cls = 'done'; }
  else if (head.hasNext()) { label = '可继续'; cls = ''; }
  else { label = '已结束'; cls = 'done'; }
  const ps = $('pillStatus');
  ps.textContent = label;
  ps.className = 'pill status-pill ' + cls;

  const banner = $('haltBanner');
  if (st.halted) { banner.hidden = false; $('haltText').textContent = st.haltReason || '运行已停住'; }
  else banner.hidden = true;

  $('timelineLabel').textContent =
    `步 ${cursor} / ${trace.length - 1} · t=${st.time}ms` +
    (trace[cursor] && trace[cursor].event != null
      ? ` · ${KIND_LABEL[trace[cursor].kind] || trace[cursor].kind}:${trace[cursor].event}` : '');

  const done = !st.halted && atTip && !head.hasNext();
  $('status').innerHTML =
    `逻辑时间 <b>${st.time}ms</b> · 微步 <b>${st.micro}</b>（生效 <b>${st.effective}</b>）` +
    ` · 外部输入 <b>${st.nextInput}/${cc.inputs.length}</b>` +
    ` · 活跃状态 <b>${st.config.length}</b> 个` +
    (st.halted ? ` · <span class="halt">⛔ ${esc(st.haltReason || '已停住')}</span>`
      : done ? ' · <b>已运行到结束</b>'
      : !atTip ? ` · 正在回看历史步（当前末端 ${trace.length - 1}）`
      : ' · 运行中/可继续');

  $('btnPrev').disabled = cursor <= 0;
  $('btnReset').disabled = cursor <= 0;
}

function renderAll() {
  if (!head || !viewState) return;
  updateTimelineBounds();
  renderChrome();
  renderVars();
  renderTimers();
  renderQueue();
  renderHistory();
  renderNarration();
  updateEdgeFired();
  updateDiagramState();
  paintTraceRows();
  followCursorInTrace();
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('btnCompile').addEventListener('click', compileFromEditor);
  $('btnSample').addEventListener('click', () => {
    $('chartSrc').value = JSON.stringify(SAMPLE, null, 2);
    compileFromEditor();
  });
  $('btnDemo').addEventListener('click', () => {
    $('chartSrc').value = JSON.stringify(DEMO, null, 2);
    compileFromEditor();
  });
  $('btnStress').addEventListener('click', () => {
    const c = makeStressChart();
    $('chartSrc').value = JSON.stringify(c); // 紧凑单行，避免 25 万行编辑器
    loadChart(c);
    showMsg('已载入 50000 输入压测图：后台分块推演，时间轴很快可拖满。', false);
  });

  $('btnOpenChart').addEventListener('click', () => $('fileChart').click());
  $('fileChart').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('chartSrc').value = reader.result;
      compileFromEditor();
    };
    reader.readAsText(f);
    ev.target.value = '';
  });

  $('edgeFilter').addEventListener('input', applyEdgeFilter);

  $('btnReset').addEventListener('click', () => { stopPlayback(); goto(0); schedulePrime(); });
  $('btnPrev').addEventListener('click', () => { stopPlayback(); goto(cursor - 1); });
  $('btnStep').addEventListener('click', manualAdvance);
  $('btnNextInput').addEventListener('click', nextInput);
  $('btnPlay').addEventListener('click', togglePlay);

  $('timeline').addEventListener('input', (ev) => {
    stopPlayback();
    goto(Number(ev.target.value));
  });

  $('btnExport').addEventListener('click', exportSnapshot);
  $('btnImport').addEventListener('click', () => $('fileSnap').click());
  $('fileSnap').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (f) importSnapshotFile(f);
    ev.target.value = '';
  });

  $('btnExpandAll').addEventListener('click', () => {
    collapsed.clear();
    buildDiagram(); renderAll();
  });
  $('btnCollapseInactive').addEventListener('click', () => {
    const active = new Set(viewState.config);
    collapsed = new Set([...cc.byId.keys()].filter((id) => {
      const kids = cc.childrenOf.get(id);
      return kids && kids.length && !active.has(id);
    }));
    buildDiagram(); renderAll();
  });

  // 轨迹：点击行跳转 + 虚拟滚动
  $('trace').addEventListener('click', (ev) => {
    const row = ev.target.closest('.tr');
    if (row) { stopPlayback(); goto(Number(row.dataset.seq)); }
  });
  $('trace').addEventListener('scroll', paintTraceRows);
  const leaveStick = () => {
    traceStick = false;
    $('btnTraceFollow').hidden = false;
  };
  $('trace').addEventListener('wheel', leaveStick, { passive: true });
  $('trace').addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('.tr')) leaveStick();
  });
  $('btnTraceFollow').addEventListener('click', () => {
    traceStick = true;
    $('btnTraceFollow').hidden = true;
    followCursorInTrace();
  });

  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { paintTraceRows(); drawEdgeOverlay(); }, 120);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawEdgeOverlay());

  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select' || ev.target.isContentEditable) return;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); manualAdvance(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stopPlayback(); goto(cursor - 1); }
    else if (ev.key === 'Home') { ev.preventDefault(); stopPlayback(); goto(0); }
  });
}

// ---------------- 启动 ----------------
bindEvents();
$('chartSrc').value = JSON.stringify(DEMO, null, 2);
try {
  loadChart(DEMO);
  showMsg('已载入「伙伴并行剧场」。也可切换到基础示例，或打开 samples/companion-chart.json。', false);
} catch (e) {
  showMsg('初始图加载失败：\n' + e.message, true);
}
