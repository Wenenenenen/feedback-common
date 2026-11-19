// 演算台应用层：编辑 -> 校验 -> 引擎演算 -> 逐帧回放
import { simulate, validateConfig, buildExport, LIMITS } from './engine.js';

// ---------- 默认装载：黄金用例 1（刷新撤销旧任务），让首屏即处于真实工作状态 ----------
const SAMPLE = {
  actors: [{ id: 'a', maxHp: 100, hp: 100 }, { id: 'b', maxHp: 60, hp: 60 }],
  definitions: [
    { id: 'poison', kind: 'dot', stack: 'refresh', cap: 1, duration: 20, period: 10, amount: 3 },
    { id: 'burn', kind: 'dot', stack: 'independent', cap: 3, duration: 30, period: 8, amount: 2 },
    { id: 'ward', kind: 'shield', stack: 'independent', cap: 2, duration: 20, amount: 5 },
  ],
  events: [
    { id: 'e1', seq: 1, time: 0, op: 'apply', target: 'a', effect: 'poison' },
    { id: 'e2', seq: 2, time: 2, op: 'apply', target: 'a', effect: 'ward' },
    { id: 'e3', seq: 3, time: 5, op: 'damage', target: 'a', amount: 9 },
    { id: 'e4', seq: 4, time: 10, op: 'apply', target: 'a', effect: 'poison' },
    { id: 'e5', seq: 5, time: 12, op: 'apply', target: 'b', effect: 'burn' },
    { id: 'e6', seq: 6, time: 18, op: 'heal', target: 'a', amount: 50 },
    { id: 'e7', seq: 7, time: 24, op: 'cleanse', target: 'b', effect: 'burn' },
  ],
};

const ALL_FILTERS = ['damage', 'heal', 'apply', 'cleanup', 'cleanse', 'death', 'ignored', 'apply-rejected'];
const FILTER_LABEL = {
  damage: '伤害/跳伤', heal: '治疗', apply: '施加', cleanup: '清理',
  cleanse: '净化', death: '死亡', ignored: '忽略', 'apply-rejected': '拒绝',
};

const state = {
  config: structuredClone(SAMPLE),
  result: null,
  errors: [],
  cursor: 0,          // 当前帧下标（-1 表示起点 t=0 之前）
  playing: false,
  playTimer: null,
  speed: 1,
  filters: new Set(ALL_FILTERS),
  selectedLog: -1,
  stateCache: [],     // 每帧结束时的角色/效果增量状态
  visible: { list: [], virtualCount: 0, curT: -1 },
  filteredLogs: [],   // 通过当前过滤器的全量日志
  actorCacheCursor: -99,
  actorCacheHtml: '',
  staticStats: { logs: 0, dmg: 0, reject: 0 },
  resetLogScroll: true,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 演算 + 逐帧状态缓存 ----------
function recompute() {
  stopPlay();
  state.errors = validateConfig(state.config);
  const panel = $('validation-panel');
  if (state.errors.length) {
    panel.hidden = false;
    $('validation-errors').textContent = state.errors.join('\n');
    state.result = null;
  } else {
    panel.hidden = true;
    state.result = simulate(state.config);
    buildStateCache();
  }
  state.cursor = state.result && state.result.frames.length ? 0 : -1;
  state.selectedLog = -1;
  state.actorCacheCursor = -99;
  state.filteredLogs = computeFilteredLogs();
  state.resetLogScroll = true;
  const allLogs = state.result ? state.result.logs : [];
  state.staticStats = {
    logs: allLogs.length,
    dmg: allLogs.filter((l) => l.type === 'damage').length,
    reject: allLogs.filter((l) => l.type === 'ignored' || l.type === 'apply-rejected').length,
  };
  buildTimeline();
  renderLogFilterBar();
  renderAll();
}

// 按日志顺序逐帧重放，得到每个帧结束瞬间的完整角色/效果快照
function buildStateCache() {
  const cache = [];
  const actors = new Map(state.config.actors.map((a) => [a.id, {
    id: a.id, maxHp: a.maxHp, hp: a.hp, dead: a.hp === 0, effects: new Map(),
  }]));
  const instMap = new Map(); // instanceId -> 活动实例视图

  const applyLog = (l) => {
    switch (l.type) {
      case 'apply': {
        const def = state.config.definitions.find((d) => d.id === l.defId);
        instMap.set(l.instance, {
          id: l.instance, defId: l.defId, kind: def.kind, target: l.target,
          born: l.time, expires: l.expires, amount: def.amount,
          nextTick: l.firstTick, sourceEvent: l.rootEvent,
        });
        actors.get(l.target).effects.set(l.instance, instMap.get(l.instance));
        break;
      }
      case 'damage':
        for (const ab of l.absorption) {
          const v = instMap.get(ab.instance);
          if (v) v.amount -= ab.amount;
        }
        actors.get(l.target).hp = l.hpAfter;
        if (l.died) actors.get(l.target).dead = true;
        break;
      case 'heal':
        actors.get(l.target).hp = l.hpAfter;
        break;
      case 'cleanup':
        instMap.delete(l.instance);
        actors.get(l.target).effects.delete(l.instance);
        break;
      case 'death':
        actors.get(l.target).dead = true;
        actors.get(l.target).hp = 0;
        break;
      // cleanse / ignored / apply-rejected 不直接改状态（净化的删除走后续 cleanup 条目）
    }
  };

  for (const f of state.result.frames) {
    for (const l of f.entries) applyLog(l);
    cache.push({
      time: f.time,
      actors: [...actors.values()].map((a) => ({ ...a, effects: [...a.effects.values()] })),
    });
  }
  state.stateCache = cache;
}

// 当前光标下的快照（cursor=-1 返回初始状态）
function currentSnapshot() {
  if (!state.result) return null;
  if (state.cursor < 0) {
    return {
      time: 0,
      actors: state.config.actors.map((a) => ({
        id: a.id, maxHp: a.maxHp, hp: a.hp, dead: a.hp === 0, effects: [],
      })),
    };
  }
  return state.stateCache[state.cursor];
}

// 精确跳转：取 time <= ms 的最后一帧（同刻事件全部结算后的状态）
function jumpTo(ms) {
  stopPlay();
  if (!state.result || !state.result.frames.length) { state.cursor = -1; renderAll(); return; }
  let lo = 0, hi = state.result.frames.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.result.frames[mid].time <= ms) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  state.cursor = ans;
  renderAll();
}

// ---------- 播放 ----------
function startPlay() {
  if (!state.result || !state.result.frames.length) return;
  if (state.cursor >= state.result.frames.length - 1) state.cursor = -1;
  state.playing = true;
  $('btn-play').textContent = '⏸';
  const tick = () => {
    if (!state.playing) return;
    if (state.cursor >= state.result.frames.length - 1) { stopPlay(); return; }
    state.cursor++;
    renderAll();
    state.playTimer = setTimeout(tick, Math.max(20, 350 / state.speed));
  };
  tick();
}
function stopPlay() {
  state.playing = false;
  if (state.playTimer) clearTimeout(state.playTimer);
  state.playTimer = null;
  $('btn-play').textContent = '▶';
}

// ---------- 渲染 ----------
function renderAll() {
  renderTransport();
  renderTimeline();
  renderActors();
  renderLogRows();
  renderPills();
}

function renderPills() {
  const snap = currentSnapshot();
  const active = snap ? snap.actors.reduce((n, a) => n + a.effects.length, 0) : 0;
  $('pill-active').innerHTML = `活动效果 <b>${active}</b>/256`;
  $('pill-frames').innerHTML = `帧 <b>${state.result ? state.result.frames.length : 0}</b>`;
  $('st-logs').textContent = state.staticStats.logs;
  $('st-dmg').textContent = state.staticStats.dmg;
  $('st-reject').textContent = state.staticStats.reject;
}

function renderTransport() {
  const snap = currentSnapshot();
  $('clock').textContent = snap ? snap.time : 0;
  const maxT = state.result && state.result.frames.length ? state.result.frames[state.result.frames.length - 1].time : 0;
  $('tl-max').textContent = maxT + ' ms';
}

// 时间轴刻度只在演算结果变化时构建一次（节点数=帧数，可达数千）
function buildTimeline() {
  const track = $('track');
  track.innerHTML = '';
  if (!state.result) return;
  const maxT = Math.max(1, state.result.frames[state.result.frames.length - 1]?.time ?? 1);
  const colors = { damage: 'var(--dmg)', heal: 'var(--heal)', apply: 'var(--accent)', cleanup: 'var(--clean)', cleanse: 'var(--clean)', death: 'var(--dead)', ignored: 'var(--warn)', 'apply-rejected': 'var(--dmg)' };
  const frag = document.createDocumentFragment();
  for (const f of state.result.frames) {
    const types = new Set(f.entries.map((e) => e.type));
    for (const t of types) {
      const m = document.createElement('div');
      m.className = 'tickmark';
      m.style.left = (f.time / maxT * 100) + '%';
      m.style.background = colors[t] || 'var(--fg3)';
      m.title = `t=${f.time}ms · ${[...types].join('/')}`;
      frag.appendChild(m);
    }
  }
  track.appendChild(frag);
}

function renderTimeline() {
  if (!state.result) { $('track').innerHTML = ''; return; }
  const maxT = Math.max(1, state.result.frames[state.result.frames.length - 1].time);
  const snap = currentSnapshot();
  const t = snap ? snap.time : 0;
  $('playhead').style.left = t / maxT * 100 + '%';
}

function renderActors() {
  const snap = currentSnapshot();
  const host = $('actors');
  if (!snap) { host.innerHTML = '<div class="tag">配置未通过校验</div>'; return; }
  $('actor-hint').textContent = `t = ${snap.time} ms 快照`;
  // 同一光标快照不变，缓存渲染结果，避免步进播放时反复构建 64 个角色节点
  if (state.actorCacheCursor === state.cursor && state.actorCacheHtml) {
    host.innerHTML = state.actorCacheHtml;
    return;
  }
  const html = snap.actors.map((a) => {
    const shield = a.effects.filter((e) => e.kind === 'shield').reduce((s, e) => s + e.amount, 0);
    const total = a.maxHp + shield;
    const hpPct = (a.hp / total * 100).toFixed(1);
    const shPct = (shield / total * 100).toFixed(1);
    const chips = a.effects.map((e) =>
      `<span class="eff-chip ${e.kind}">#${e.id} ${esc(e.defId)} ` +
      (e.kind === 'shield'
        ? `<b>${e.amount}</b> 盾 · 至${e.expires}`
        : `下跳${e.nextTick ?? '—'} · 至${e.expires}`) +
      `</span>`).join('');
    return `<div class="actor ${a.dead ? 'dead' : ''}">
      <div class="row1">
        <span class="name">${esc(a.id)}</span>
        ${a.dead ? '<span class="tag dead">已死亡</span>' : ''}
        <span class="tag mono">${a.effects.length} 效果</span>
      </div>
      <div class="hpbar">
        <div class="hp" style="width:${hpPct}%"></div>
        <div class="sh" style="width:${shPct}%"></div>
      </div>
      <div class="hptxt">HP ${a.hp}/${a.maxHp}${shield ? ` · 护盾 ${shield}` : ''}</div>
      <div>${chips || '<span class="tag">无活动效果</span>'}</div>
    </div>`;
  }).join('');
  state.actorCacheCursor = state.cursor;
  state.actorCacheHtml = html;
  host.innerHTML = html;
}

const BADGE = {
  damage: ['b-damage', '伤害'], heal: ['b-heal', '治疗'], apply: ['b-apply', '施加'],
  cleanup: ['b-cleanup', '清理'], cleanse: ['b-cleanseself', '净化'], death: ['b-death', '死亡'],
  ignored: ['b-ignored', '忽略'], 'apply-rejected': ['b-rejected', '拒绝'],
};

function sourceText(l) {
  if (l.root && l.root.kind === 'event') return `事件 ${esc(l.root.event)}`;
  if (l.root && l.root.kind === 'tick') return `跳伤 #${l.root.instance} (${esc(l.root.defId)})`;
  if (l.rootEvent) return `事件 ${esc(l.rootEvent)}`;
  if (l.instance) return `实例 #${l.instance}`;
  return '—';
}

// 过滤后的全量日志，仅在过滤器集合或演算结果变化时重算（renderLogFilterBar / recompute 触发）
function computeFilteredLogs() {
  if (!state.result) return [];
  const out = [];
  for (const l of state.result.logs) if (state.filters.has(l.type)) out.push(l);
  return out;
}

// 当前光标下的可见日志：在共享的过滤数组上用二分求截止下标，零复制
function computeVisibleLogs() {
  if (!state.result) return { view: state.filteredLogs, cutoff: 0, virtualCount: 0, curT: -1 };
  const snap = currentSnapshot();
  const curT = snap ? snap.time : -1;
  const all = state.result.logs;
  let loA = 0, hiA = all.length;
  while (loA < hiA) {
    const mid = (loA + hiA) >> 1;
    if (all[mid].time <= curT) loA = mid + 1; else hiA = mid;
  }
  const filtered = state.filteredLogs;
  let lo = 0, hi = filtered.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (filtered[mid].time <= curT) lo = mid + 1; else hi = mid;
  }
  return { view: filtered, cutoff: lo, virtualCount: all.length - loA, curT };
}

const ROW_PX = 33;       // 单行估算高度（含边框）
const ROW_OVERSCAN = 12; // 视口上下额外渲染行数

function renderLogFilterBar() {
  const fh = $('logfilters');
  fh.innerHTML = ALL_FILTERS.map((f) =>
    `<span class="chipf ${state.filters.has(f) ? 'on' : ''}" data-f="${f}">${FILTER_LABEL[f]}</span>`).join('');
  fh.querySelectorAll('.chipf').forEach((el) => el.onclick = () => {
    const f = el.dataset.f;
    state.filters.has(f) ? state.filters.delete(f) : state.filters.add(f);
    state.filteredLogs = computeFilteredLogs();
    state.resetLogScroll = true;
    renderLogFilterBar();
    renderLogRows();
  });
}

function rowHtml(l) {
  const [cls, label] = BADGE[l.type] || ['', l.type];
  const abs = (l.absorption || []).map((a) => `#${a.instance} −${a.amount}`).join('，');
  const hpChange = l.type === 'damage' ? `−${l.hpLoss} → ${l.hpAfter}`
    : l.type === 'heal' ? `+${l.actual} → ${l.hpAfter}` : '';
  const amount = l.amount ?? (l.type === 'cleanup' ? '' : '');
  return `<tr data-idx="${l.idx}" class="${state.selectedLog === l.idx ? 'sel' : ''}">
    <td class="num">${l.time}</td>
    <td><span class="badge ${cls}">${label}</span></td>
    <td class="num">${esc(l.target ?? '')}</td>
    <td>${sourceText(l)}</td>
    <td class="num">${amount}</td>
    <td class="abs">${esc(abs)}</td>
    <td class="num">${hpChange}</td>
    <td>${l.reason ? esc(reasonZh(l.reason)) : ''}${l.removed ? ' [' + l.removed.map((i) => '#' + i).join(',') + ']' : ''}</td>
  </tr>`;
}

// 日志表事件委托只绑定一次
let logDelegationBound = false;
function bindLogDelegation() {
  if (logDelegationBound) return;
  logDelegationBound = true;
  $('logbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-idx]');
    if (!tr) return;
    state.selectedLog = Number(tr.dataset.idx);
    renderLogRows();
  });
  $('logwrap').addEventListener('scroll', () => { if (state._draw) state._draw(); }, { passive: true });
}

function renderLogRows() {
  const wrap = $('logwrap');
  const body = $('logbody');
  bindLogDelegation();
  if (!state.result) { body.innerHTML = ''; $('log-note').textContent = ''; return; }
  state.visible = computeVisibleLogs();
  const { view, cutoff, virtualCount, curT } = state.visible;
  let lastRange = '';

  state._draw = () => {
    const scrollTop = wrap.scrollTop;
    const viewH = wrap.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / ROW_PX) - ROW_OVERSCAN);
    const end = Math.min(cutoff, Math.ceil((scrollTop + viewH) / ROW_PX) + ROW_OVERSCAN);
    const rangeKey = start + ':' + end + ':' + cutoff + ':' + state.selectedLog;
    if (rangeKey === lastRange) return; // 窗口与选择均未变，跳过 DOM 重建
    lastRange = rangeKey;
    const html = [];
    if (start > 0) html.push(`<tr class="spacer"><td colspan="8" style="height:${start * ROW_PX}px;padding:0;border:0"></td></tr>`);
    for (let k = start; k < end; k++) html.push(rowHtml(view[k]));
    const bottomPad = (cutoff - end) * ROW_PX;
    if (bottomPad > 0) html.push(`<tr class="spacer"><td colspan="8" style="height:${bottomPad}px;padding:0;border:0"></td></tr>`);
    body.innerHTML = html.join('');
    if (state.selectedLog >= 0) showLogDetail(state.selectedLog);
  };

  if (state.resetLogScroll) { wrap.scrollTop = 0; state.resetLogScroll = false; }
  state._draw();

  $('log-note').textContent = virtualCount
    ? `当前只显示 t ≤ ${curT}ms 的已结算日志；未来还有 ${virtualCount} 条（不会提前生效）。可见 ${cutoff} 条（虚拟滚动）。`
    : `全部日志均已结算，共 ${cutoff} 条（虚拟滚动）。`;
}

// 兼容旧调用名
function renderLogTable() {
  renderLogFilterBar();
  renderLogRows();
}

function reasonZh(r) {
  return { expired: '到期', replaced: '叠层替换', cleansed: '净化', death: '死亡清理', exhausted: '护盾耗尽' }[r] || r;
}

function showLogDetail(idx) {
  const l = state.result.logs[idx];
  if (!l) return;
  document.querySelectorAll('tr.detail-row').forEach((n) => n.remove());
  const tr = document.querySelector(`tr[data-idx="${idx}"]`);
  if (!tr) return; // 该行不在当前虚拟窗口内
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.innerHTML = `<td colspan="8" class="detail">${esc(JSON.stringify(l, null, 2))}</td>`;
  tr.after(detail);
}

// ---------- 编辑器 ----------
function renderEditors() {
  // 定义表
  $('def-table').querySelector('tbody').innerHTML = state.config.definitions.map((d, i) => `
    <tr>
      <td><input data-k="def" data-i="${i}" data-f="id" value="${esc(d.id)}"></td>
      <td><select data-k="def" data-i="${i}" data-f="kind">
        <option ${d.kind === 'dot' ? 'selected' : ''}>dot</option>
        <option ${d.kind === 'shield' ? 'selected' : ''}>shield</option></select></td>
      <td><select data-k="def" data-i="${i}" data-f="stack">
        <option ${d.stack === 'refresh' ? 'selected' : ''}>refresh</option>
        <option ${d.stack === 'independent' ? 'selected' : ''}>independent</option></select></td>
      <td><input type="number" min="1" data-k="def" data-i="${i}" data-f="cap" value="${d.cap}"></td>
      <td><input type="number" min="1" data-k="def" data-i="${i}" data-f="duration" value="${d.duration}"></td>
      <td><input type="number" min="1" data-k="def" data-i="${i}" data-f="period" value="${d.period ?? ''}" placeholder="dot 专用"></td>
      <td><input type="number" min="1" data-k="def" data-i="${i}" data-f="amount" value="${d.amount}"></td>
      <td><button class="del" data-del-def="${i}">删</button></td>
    </tr>`).join('');

  // 角色表
  $('actor-table').querySelector('tbody').innerHTML = state.config.actors.map((a, i) => `
    <tr>
      <td><input data-k="actor" data-i="${i}" data-f="id" value="${esc(a.id)}"></td>
      <td><input type="number" min="1" data-k="actor" data-i="${i}" data-f="maxHp" value="${a.maxHp}"></td>
      <td><input type="number" min="0" data-k="actor" data-i="${i}" data-f="hp" value="${a.hp}"></td>
      <td><button class="del" data-del-actor="${i}">删</button></td>
    </tr>`).join('');

  // 事件表
  const sorted = [...state.config.events].sort((a, b) => a.time - b.time || a.seq - b.seq);
  $('ev-count').textContent = `${state.config.events.length} / ${LIMITS.MAX_EVENTS}`;
  $('event-table').querySelector('tbody').innerHTML = sorted.map((e) => {
    const i = state.config.events.indexOf(e);
    return `<tr>
      <td class="mono">${esc(e.id)}</td><td class="num">${e.seq}</td><td class="num">${e.time}</td>
      <td>${e.op}</td><td class="mono">${esc(e.target)}</td>
      <td class="mono">${esc(e.effect ?? '—')}</td><td class="num">${e.amount ?? '—'}</td>
      <td><button class="del" data-del-event="${i}">删</button></td>`;
  }).join('');

  // 表单下拉
  $('ev-target').innerHTML = state.config.actors.map((a) => `<option>${esc(a.id)}</option>`).join('');
  $('ev-effect').innerHTML = state.config.definitions.map((d) => `<option>${esc(d.id)}</option>`).join('');
  bindEditorEvents();
}

function bindEditorEvents() {
  document.querySelectorAll('input[data-k],select[data-k]').forEach((el) => {
    el.onchange = () => {
      const { k, i, f } = el.dataset;
      const idx = Number(i);
      let v = el.value;
      if (['cap', 'duration', 'period', 'amount', 'maxHp', 'hp'].includes(f)) v = v === '' ? undefined : Number(v);
      if (k === 'def') {
        if (f === 'period' && (v === undefined || Number.isNaN(v))) delete state.config.definitions[idx][f];
        else state.config.definitions[idx][f] = v;
      } else {
        state.config.actors[idx][f] = v;
      }
      renderEditors();
      recompute();
    };
  });
  document.querySelectorAll('[data-del-def]').forEach((b) => b.onclick = () => {
    state.config.definitions.splice(Number(b.dataset.delDef), 1); renderEditors(); recompute();
  });
  document.querySelectorAll('[data-del-actor]').forEach((b) => b.onclick = () => {
    state.config.actors.splice(Number(b.dataset.delActor), 1); renderEditors(); recompute();
  });
  document.querySelectorAll('[data-del-event]').forEach((b) => b.onclick = () => {
    state.config.events.splice(Number(b.dataset.delEvent), 1); renderEditors(); recompute();
  });
}

// ---------- 弹窗 / 导入导出 ----------
function openModal(title, text, { readonly = false, action = '确定', onAction } = {}) {
  $('modal-title').textContent = title;
  $('modal-text').value = text;
  $('modal-text').readOnly = readonly;
  $('modal-action').textContent = action;
  $('modal-back').hidden = false;
  $('modal-action').onclick = () => {
    if (onAction && onAction($('modal-text').value) === false) return;
    $('modal-back').hidden = true;
  };
  $('modal-cancel').onclick = () => { $('modal-back').hidden = true; };
  $('modal-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('modal-text').value); toast('已复制到剪贴板'); }
    catch { $('modal-text').select(); toast('剪贴板不可用，已全选文本'); }
  };
}

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function exportBundle() {
  if (!state.result) { toast('配置未通过校验，无法导出', true); return; }
  const bundle = buildExport(state.config, state.result);
  openModal('导出结算包（配置 + 完整日志，重新导入可复现）', JSON.stringify(bundle, null, 2), { readonly: true, action: '关闭' });
}

function importBundle(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { toast('JSON 解析失败: ' + e.message, true); return false; }
  const cfg = parsed.config ?? parsed; // 兼容裸配置与导出包
  const errs = validateConfig(cfg);
  if (errs.length) { toast('导入配置校验失败', true); openModal('校验失败（共 ' + errs.length + ' 项）', errs.join('\n'), { readonly: true, action: '关闭' }); return false; }
  state.config = cfg;
  recompute();
  renderEditors();
  // 若带历史结果，重放比对验证复现性
  if (parsed.result?.frames) {
    const same = JSON.stringify(state.result.frames) === JSON.stringify(parsed.result.frames);
    toast(same ? '导入成功，重放结果与导出日志完全一致' : '导入成功，但重放结果与导出日志存在差异', !same);
  } else {
    toast('导入成功，已重新演算');
  }
  return true;
}

// ---------- 事件绑定 ----------
function bind() {
  $('btn-play').onclick = () => (state.playing ? stopPlay() : startPlay());
  $('btn-first').onclick = () => { stopPlay(); state.cursor = -1; renderAll(); };
  $('btn-last').onclick = () => {
    stopPlay();
    if (state.result) state.cursor = state.result.frames.length - 1;
    renderAll();
  };
  $('btn-prev').onclick = () => { stopPlay(); state.cursor = Math.max(-1, state.cursor - 1); renderAll(); };
  $('btn-next').onclick = () => {
    stopPlay();
    if (state.result) state.cursor = Math.min(state.result.frames.length - 1, state.cursor + 1);
    renderAll();
  };
  $('btn-jump').onclick = () => {
    const v = Number($('jump-ms').value);
    if (Number.isInteger(v) && v >= 0) jumpTo(v);
    else toast('请输入非负整数毫秒', true);
  };
  $('jump-ms').onkeydown = (e) => { if (e.key === 'Enter') $('btn-jump').click(); };
  $('speed').onchange = (e) => { state.speed = Number(e.target.value); };
  $('track').onclick = (e) => {
    if (!state.result?.frames.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const maxT = state.result.frames[state.result.frames.length - 1].time;
    jumpTo(Math.round((e.clientX - rect.left) / rect.width * maxT));
  };

  $('btn-add-def').onclick = () => {
    const id = 'def' + (state.config.definitions.length + 1);
    state.config.definitions.push({ id, kind: 'dot', stack: 'independent', cap: 3, duration: 10, period: 5, amount: 1 });
    renderEditors(); recompute();
  };
  $('btn-add-actor').onclick = () => {
    if (state.config.actors.length >= LIMITS.MAX_ACTORS) return toast('最多 64 个角色', true);
    const id = 'a' + (state.config.actors.length + 1);
    state.config.actors.push({ id, maxHp: 100, hp: 100 });
    renderEditors(); recompute();
  };
  $('btn-add-event').onclick = () => {
    if (state.config.events.length >= LIMITS.MAX_EVENTS) return toast('最多 5000 条事件', true);
    const op = $('ev-op').value;
    const seq = state.config.events.reduce((m, e) => Math.max(m, e.seq), -1) + 1;
    const id = 'u' + (state.config.events.length + 1);
    const ev = { id, seq, time: Number($('ev-time').value) || 0, op, target: $('ev-target').value };
    if (op === 'apply' || op === 'cleanse') ev.effect = $('ev-effect').value;
    if (op === 'damage' || op === 'heal') {
      const amt = Number($('ev-amount').value);
      if (!Number.isInteger(amt) || amt <= 0) return toast('damage/heal 需要正整数 amount', true);
      ev.amount = amt;
    }
    state.config.events.push(ev);
    renderEditors(); recompute();
  };

  $('btn-export').onclick = exportBundle;
  $('btn-import').onclick = () => {
    const file = document.createElement('input');
    file.type = 'file'; file.accept = '.json,application/json';
    file.onchange = () => {
      const reader = new FileReader();
      reader.onload = () => importBundle(String(reader.result));
      reader.readAsText(file.files[0]);
    };
    file.click();
  };
  $('btn-samples').onclick = () => openModal(
    '载入内置样例（替换当前配置）',
    JSON.stringify(SAMPLE, null, 2),
    { action: '载入并演算', onAction: (t) => importBundle(t) },
  );
  $('btn-theme').onclick = () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  };
}

// ---------- 启动 ----------
bind();
renderEditors();
recompute();
window.__testState = state; // 仅供自动化测试只读访问
window.__testHooks = { renderActors, renderLogRows, renderTimeline, renderPills, currentSnapshot, recompute };
