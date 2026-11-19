// 网页控制层：负责渲染与交互，所有模拟逻辑都在 engine.js（已通过 Node 样例验证）。
import { Engine } from './engine.js';
import { Fraction } from './fraction.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = 'rts-production-clock-save-v1';
const BUILTIN_CASES = [
  ['fraction.json', '分数工作量（2/3 速度）'],
  ['research.json', '科技加速（下一步生效）'],
  ['blocked.json', '人口卡住队首'],
  ['refund.json', '取消按比例退款'],
  ['stress.json', '32 建筑 × 8 队列压测'],
];

const state = {
  engine: null,
  raw: null,              // 当前用例原始 JSON（用于重开/导出）
  caseName: '',
  logFilter: 'all',
  ffTimer: null,
  pendingEdits: [],       // 当前 tick 已登记、尚未执行的实时指令
};

// ---------- 数字/分数展示 ----------

function frac(x) { return Fraction.from(x); }
function fShort(x) {
  const f = frac(x);
  return f.d === 1n ? f.n.toString() : `${f.n}/${f.d}`;
}
function fDec(x, digits = 4) { return frac(x).toDecimal(digits); }
function pct(progress, work) {
  const f = frac(progress).div(Fraction.from(work));
  return Math.min(100, Math.max(0, f.toNumber() * 100));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nowMs(tick) { return (tick * 100).toLocaleString('en-US') + ' ms'; }

// ---------- 载入用例 ----------

function loadCase(raw, name) {
  stopFastForward();
  state.raw = raw;
  state.caseName = name;
  state.engine = new Engine(JSON.parse(JSON.stringify(raw)));
  state.pendingEdits = [];
  state.logFilter = 'all';
  $('#caseName').textContent = name;
  renderAll();
  toast(`已载入 ${name}`);
}

async function loadBuiltin(file) {
  try {
    const res = await fetch(`cases/${file}`);
    if (!res.ok) throw new Error(res.status);
    const raw = await res.json();
    loadCase(raw, file);
  } catch (e) {
    toast(`内置用例加载失败：${e.message}`, true);
  }
}

function loadJsonText(text, name) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { toast('JSON 解析失败：' + e.message, true); return; }
  try {
    loadCase(raw, name);
  } catch (e) {
    toast('用例非法：' + e.message, true);
  }
}

// ---------- 操作 ----------

function doStep() {
  if (!state.engine) return;
  state.engine.step();
  state.pendingEdits = state.pendingEdits.filter(e => e.tick >= state.engine.tick);
  renderAll();
}

function runSteps(n) {
  if (!state.engine) return;
  for (let i = 0; i < n; i++) state.engine.step();
  state.pendingEdits = [];
  renderAll();
}

function startFastForward() {
  if (!state.engine || state.ffTimer) return;
  $('#ffBtn').classList.add('active');
  state.ffTimer = setInterval(() => {
    const eng = state.engine;
    const anyQueued = eng.buildingOrder.some(id => eng.buildings.get(id).queue.length);
    const maxScheduled = Math.max(-1, ...eng.commandsByTick.keys());
    if (!anyQueued && eng.tick > maxScheduled && eng.pendingMultipliers.length === 0) {
      stopFastForward();
      renderAll();
      return;
    }
    eng.step();
    renderAll();
  }, 120);
}
function stopFastForward() {
  if (state.ffTimer) clearInterval(state.ffTimer);
  state.ffTimer = null;
  $('#ffBtn')?.classList.remove('active');
}

function resetCase() {
  if (!state.raw) return;
  stopFastForward();
  state.engine = new Engine(JSON.parse(JSON.stringify(state.raw)));
  state.pendingEdits = [];
  renderAll();
  toast('已重置为用例初始状态');
}

// 实时编辑：登记到当前 tick，下一步指令阶段执行
function live(command, label) {
  const eng = state.engine;
  if (!eng) return;
  try {
    const entry = eng.scheduleLive(command);
    state.pendingEdits.push({ ...entry, _label: label });
    renderPending();
    toast(`${label} 已登记，将在 tick ${entry.tick}（下一步）按 seq ${entry.seq} 执行`);
  } catch (e) {
    toast('指令被拒绝：' + e.message, true);
  }
}

// ---------- 渲染 ----------

function renderAll() {
  renderHeader();
  renderResources();
  renderBuildings();
  renderPending();
  renderLog();
  renderCatalogHint();
}

function renderHeader() {
  const eng = state.engine;
  $('#tickVal').textContent = eng.tick;
  $('#msVal').textContent = nowMs(eng.tick);
  $('#multVal').textContent = fShort(eng.speedMultiplier);
  $('#popVal').textContent = `${eng.usedPopulation} / ${eng.populationCap}`;
  const popPct = eng.populationCap === 0n ? 0 :
    Number(eng.usedPopulation * 100n / eng.populationCap);
  $('#popBar').style.width = Math.min(100, popPct) + '%';
  $('#popBar').classList.toggle('warn', eng.usedPopulation >= eng.populationCap);
  $('#pendingMult').hidden = eng.pendingMultipliers.length === 0;
  if (eng.pendingMultipliers.length) {
    $('#pendingMult').textContent =
      '待生效科技 ×' + eng.pendingMultipliers.map(fShort).join(' × ') +
      `（tick ${eng.tick + 1} 起）`;
  }
}

function renderResources() {
  const eng = state.engine;
  const wrap = $('#resourceGrid');
  const names = [...new Set([...eng.resources.keys(), ...eng.resourceCaps.keys()])].sort();
  wrap.innerHTML = names.map(r => {
    const v = eng.resources.get(r) ?? 0n;
    const cap = eng.resourceCaps.get(r);
    const capText = cap === undefined ? '∞' : cap.toString();
    const p = cap === undefined || cap === 0n ? 0 : Number(v * 100n / cap);
    return `<div class="res-card">
      <div class="res-label">${esc(r)}</div>
      <div class="res-val" data-num>${v.toString()}<span class="res-cap"> / ${capText}</span></div>
      <div class="res-track"><div class="res-fill" style="width:${Math.min(100, p)}%"></div></div>
    </div>`;
  }).join('') || '<p class="muted">无资源</p>';
}

function renderBuildings() {
  const eng = state.engine;
  const wrap = $('#buildingList');
  if (!eng.buildingOrder.length) {
    wrap.innerHTML = '<p class="muted">没有建筑。用下方“新增建筑”创建。</p>';
    return;
  }
  wrap.innerHTML = eng.buildingOrder.map(bid => {
    const b = eng.buildings.get(bid);
    const rows = b.queue.map((inst, idx) => queueRow(b, inst, idx)).join('');
    return `<article class="building ${b.destroyed ? 'destroyed' : ''} ${b.paused ? 'paused' : ''}">
      <header>
        <div class="b-title">
          <span class="b-id">${esc(b.id)}</span>
          <span class="b-speed">速度 ${fShort(b.speed)} → 本步预算 ${fShort(b.speed.mul(eng.speedMultiplier))}</span>
        </div>
        <div class="b-actions">
          ${b.destroyed ? '<span class="chip danger">已摧毁</span>' : `
            <button class="btn mini" data-act="pause" data-bid="${esc(b.id)}">${b.paused ? '恢复' : '暂停'}</button>
            <button class="btn mini danger" data-act="destroy" data-bid="${esc(b.id)}">摧毁</button>`}
        </div>
      </header>
      ${b.destroyed ? '<p class="muted small">队列已清空，不退款。</p>' :
        `<ol class="queue">${rows}</ol>
         ${enqueueRow(b)}`}
    </article>`;
  }).join('');
}

function queueRow(b, inst, idx) {
  const def = inst.def;
  const isHead = idx === 0;
  const p = pct(inst.progress, def.work);
  const status = inst.ready
    ? '<span class="chip warn">ready·人口阻塞</span>'
    : inst.workApplied
      ? (isHead ? '<span class="chip">生产中</span>' : '<span class="chip muted">等待中</span>')
      : '<span class="chip muted">未开工</span>';
  const kindIcon = def.kind === 'research' ? '🔬' : '⚙️';
  const canReorder = !inst.workApplied && !inst.ready;
  return `<li class="q-item ${inst.ready ? 'ready' : ''}">
    <div class="q-head">
      <span class="q-name">#${inst.instanceId} ${kindIcon} ${esc(inst.itemId)}</span>
      ${status}
    </div>
    <div class="q-meta">
      <span data-num>进度 ${fShort(inst.progress)} / ${def.work.toString()}（${fDec(inst.progress.div(Fraction.from(def.work)).mul(100), 2)}%）</span>
      <span class="muted">${def.kind === 'unit' ? `占人口 ${def.population}` : `倍率 ×${fShort(def.multiplier)}`}</span>
    </div>
    <div class="q-track"><div class="q-fill" style="width:${p}%"></div></div>
    <div class="q-cost">${costText(def)}</div>
    <div class="q-actions">
      <button class="btn mini" data-act="cancel" data-iid="${inst.instanceId}">取消（退款）</button>
      ${canReorder ? `
        <button class="btn mini" data-act="up" data-iid="${inst.instanceId}" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn mini" data-act="down" data-iid="${inst.instanceId}"
          ${idx === b.queue.length - 1 || b.queue[idx + 1].workApplied || b.queue[idx + 1].ready ? 'disabled' : ''}>↓</button>` : ''}
    </div>
  </li>`;
}

function costText(def) {
  const parts = [...def.cost].map(([r, v]) => `${esc(r)} ${v.toString()}`);
  return '<span class="muted small">造价 ' + (parts.join('、') || '无') + '</span>';
}

function enqueueRow(b) {
  const eng = state.engine;
  const full = b.queue.length >= 8;
  const opts = [...eng.catalog.keys()].map(id =>
    `<option value="${esc(id)}">${esc(id)}</option>`).join('');
  return `<div class="enq-row">
    <select class="sel" data-enq-item="${esc(b.id)}" ${full ? 'disabled' : ''}>${opts}</select>
    <button class="btn mini primary" data-act="enqueue" data-bid="${esc(b.id)}" ${full ? 'disabled' : ''}>
      ${full ? '队列已满（8）' : '入队（立即扣款）'}
    </button>
  </div>`;
}

function renderCatalogHint() {
  const eng = state.engine;
  $('#catalogBox').innerHTML = [...eng.catalog.values()].map(d => `
    <div class="cat-line">
      <strong>${esc(d.itemId)}</strong>
      <span class="muted">${d.kind === 'unit' ? `unit·pop ${d.population}` : 'research'}</span>
      <span data-num>work ${d.work.toString()}</span>
      <span class="muted">${[...d.cost].map(([r, v]) => `${r} ${v}`).join(' ') || '无造价'}</span>
      ${d.kind === 'research' ? `<span class="muted">×${fShort(d.multiplier)}</span>` : ''}
    </div>`).join('');
}

function renderPending() {
  const box = $('#pendingBox');
  if (!state.pendingEdits.length) {
    box.innerHTML = '<p class="muted small">当前 tick 无待执行指令。编辑会在你点“单步”时于指令阶段生效。</p>';
    return;
  }
  box.innerHTML = state.pendingEdits.map(e =>
    `<div class="pend-row"><span class="chip">tick ${e.tick} · seq ${e.seq}</span> ${esc(e._label)}</div>`
  ).join('');
}

function renderLog() {
  const eng = state.engine;
  const filter = state.logFilter;
  const all = eng.events;
  const filtered = all.filter(e => {
    if (filter === 'all') return true;
    if (filter === 'work') return e.kind === 'work';
    if (filter === 'resource') return e.kind === 'resource' || e.kind === 'population';
    if (filter === 'flow') return ['complete', 'ready', 'blocked', 'speedMultiplier', 'command'].includes(e.kind);
    return true;
  }).slice(-300);
  $('#logCount').textContent = `${filtered.length} / ${all.length} 条（仅显示最近 300）`;
  $('#logBody').innerHTML = filtered.map(logRow).join('') ||
    '<p class="muted">暂无事件</p>';
  $('#logBody').scrollTop = $('#logBody').scrollHeight;
}

function logRow(e) {
  const src = e.source?.seq != null
    ? `seq ${e.source.seq}`
    : e.source?.building ? `${e.source.building}${e.source.instance ? ` #${e.source.instance}` : ''}`
    : '系统';
  let body = '';
  let cls = '';
  switch (e.kind) {
    case 'work':
      cls = 'k-work';
      body = `<b>工作</b> ${esc(e.item)} 增量 <b data-num>${fShort(e.delta)}</b>` +
        `（${fShort(e.progressBefore)} → ${fShort(e.progressAfter)}，剩余预算 ${fShort(e.budgetAfter)}）`;
      break;
    case 'resource':
      cls = 'k-res';
      body = `<b>资源</b> ${esc(e.resource)} ${e.before} → ${e.after}` +
        `（Δ ${e.delta}${e.intendedDelta !== e.delta ? `，应计 ${e.intendedDelta}` : ''}${e.clamped ? '，<span class="warn-text">触顶截断</span>' : ''}）`;
      break;
    case 'population':
      cls = 'k-pop';
      body = `<b>人口</b> ${e.before} → ${e.after}（Δ ${e.delta}，${esc(e.reason)}）`;
      break;
    case 'complete':
      cls = 'k-done';
      body = e.itemKind === 'research'
        ? `<b>科技完成</b> ${esc(e.item)}，倍率 ×${fShort(e.multiplier)} 将于 tick ${e.takesEffectTick} 生效`
        : `<b>单位交付</b> ${esc(e.item)}，占用人口 ${e.population}`;
      break;
    case 'ready':
      cls = 'k-block';
      body = `<b>成品就绪但人口不足</b> ${esc(e.item)}，保留队首并丢弃本步剩余预算 ${fShort(e.discardedBudget)}`;
      break;
    case 'blocked':
      cls = 'k-block';
      body = `<b>阻塞</b> ${esc(e.item ?? '')}：${e.reason === 'population' ? '人口上限' : esc(e.reason)}` +
        (e.discardedBudget ? `，丢弃预算 ${fShort(e.discardedBudget)}` : '');
      break;
    case 'speedMultiplier':
      cls = 'k-mult';
      body = `<b>全局倍率</b> ${fShort(e.before)} → <b>${fShort(e.after)}</b>` +
        `（应用 ${e.applied.map(fShort).join(' × ')}）`;
      break;
    case 'command': {
      cls = e.accepted === false ? 'k-rej' : 'k-cmd';
      const detail = e.accepted === false
        ? `<span class="warn-text">拒绝：${esc(e.reason)}</span>`
        : commandDetail(e);
      body = `<b>指令</b> ${esc(e.op)} ${detail}`;
      break;
    }
    default:
      body = esc(e.kind);
  }
  return `<div class="log-row ${cls}">
    <span class="log-tick" data-num>t${e.tick}</span>
    <span class="log-src">${src}</span>
    <span class="log-body">${body}</span>
  </div>`;
}

function commandDetail(e) {
  switch (e.op) {
    case 'enqueue': return `${esc(e.building)} 入队 #${e.instance}（${esc(e.item)}），已扣款`;
    case 'cancel': return e.refunded
      ? `${esc(e.building)} 取消 #${e.instance}，退款 ` +
        e.refunds.map(r => `${esc(r.resource)} ${r.refund}`).join('、')
      : `${esc(e.building)} 取消 ready 实例 #${e.instance}，不退款`;
    case 'reorder': return `${esc(e.building)} 重排为 [${e.order.join(', ')}]`;
    case 'pause': return `${esc(e.building)} ${e.paused ? '暂停' : '恢复'}`;
    case 'destroy': return `${esc(e.building)} 摧毁，移除 ${e.removed.length} 个实例，不退款`;
    case 'grant': return `发放 ${esc(e.resource)} ${e.amount}`;
    case 'release': return `释放人口 ${e.amount}`;
    default: return '';
  }
}

// ---------- 保存 / 恢复 / 导出 ----------

function saveLocal() {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      caseName: state.caseName,
      snapshot: state.engine.snapshot(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    toast('已保存到浏览器本地');
  } catch (e) { toast('保存失败：' + e.message, true); }
}

function restoreLocal() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) { toast('没有已保存的进度', true); return; }
    const payload = JSON.parse(text);
    stopFastForward();
    state.engine = Engine.restore(payload.snapshot);
    state.raw = null;
    state.caseName = payload.caseName + '（已恢复）';
    state.pendingEdits = [];
    $('#caseName').textContent = state.caseName;
    renderAll();
    toast('已恢复保存的进度');
  } catch (e) { toast('恢复失败：' + e.message, true); }
}

function exportSnapshot() {
  downloadText(
    `rts-snapshot-t${state.engine.tick}.json`,
    JSON.stringify({ caseName: state.caseName, snapshot: JSON.parse(state.engine.snapshot()) }, null, 2),
    'application/json'
  );
}

function exportSettlementLog() {
  const eng = state.engine;
  const lines = [];
  lines.push('# RTS 生产队列结算日志');
  lines.push(`# 用例: ${state.caseName}`);
  lines.push(`# 导出 tick: ${eng.tick}（${nowMs(eng.tick)}）`);
  lines.push(`# 全局倍率: ${fShort(eng.speedMultiplier)}`);
  lines.push(`# 人口: ${eng.usedPopulation}/${eng.populationCap}`);
  lines.push('# 资源: ' + [...eng.resources].map(([k, v]) => `${k}=${v}`).join(', '));
  lines.push('tick\tsource\tkind\tdetail');
  for (const e of eng.events) {
    const src = e.source?.seq != null ? `seq${e.source.seq}`
      : e.source?.building ? `${e.source.building}${e.source.instance ? '#' + e.source.instance : ''}`
      : 'system';
    lines.push(`${e.tick}\t${src}\t${e.kind}\t${JSON.stringify(e)}`);
  }
  // 账本对账汇总
  const resDelta = new Map();
  for (const e of eng.events.filter(x => x.kind === 'resource')) {
    resDelta.set(e.resource, (resDelta.get(e.resource) ?? 0n) + BigInt(e.delta));
  }
  lines.push('');
  lines.push('# 资源净变化（事件 delta 之和）:');
  for (const [r, d] of resDelta) lines.push(`#   ${r}: ${d >= 0n ? '+' : ''}${d}`);
  const popDelta = eng.events.filter(x => x.kind === 'population')
    .reduce((a, e) => a + BigInt(e.delta), 0n);
  lines.push(`# 人口净变化: ${popDelta}`);
  const totalWork = eng.events.filter(x => x.kind === 'work')
    .reduce((a, e) => a.add(Fraction.from(e.delta)), Fraction.ZERO);
  lines.push(`# 累计工作量（精确分数）: ${totalWork.toString()}`);
  downloadText(`rts-settlement-t${eng.tick}.tsv`, lines.join('\n'), 'text/tab-separated-values');
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 ' + filename);
}

// ---------- 建筑/世界编辑 ----------

function addBuilding(id, speedP, speedQ) {
  const eng = state.engine;
  if (eng.buildings.has(id)) { toast('建筑 ID 已存在', true); return false; }
  if (eng.buildingOrder.length >= 32) { toast('建筑数已达 32 上限', true); return false; }
  // 建筑属于世界结构：从当前引擎状态反向生成场景定义后重建。
  // 已产生的事件轨迹不保留，故 tick>0 时明确提示。
  if (eng.tick > 0) toast('结构变更会重建场景，已清空事件轨迹', true);
  const raw = buildRawFromEngine();
  raw.buildings.push({ id, speed: [Number(speedP), Number(speedQ)], paused: false, queue: [] });
  loadCase(raw, state.caseName || '自定义场景');
  return true;
}

// 从当前引擎状态反向生成 raw（用于结构编辑后重建），事件轨迹不保留
function buildRawFromEngine() {
  const eng = state.engine;
  return {
    resources: Object.fromEntries([...eng.resources].map(([k, v]) => [k, Number(v)])),
    resourceCaps: Object.fromEntries([...eng.resourceCaps].map(([k, v]) => [k, Number(v)])),
    usedPopulation: Number(eng.usedPopulation),
    populationCap: Number(eng.populationCap),
    speedMultiplier: eng.speedMultiplier.toJSON().map(Number),
    buildings: eng.buildingOrder.map(bid => {
      const b = eng.buildings.get(bid);
      return {
        id: b.id, speed: b.speed.toJSON().map(Number), paused: b.paused,
        queue: b.queue.map(i => i.itemId),
      };
    }),
    catalog: Object.fromEntries([...eng.catalog].map(([id, d]) => [id, {
      work: Number(d.work),
      cost: Object.fromEntries([...d.cost].map(([r, v]) => [r, Number(v)])),
      kind: d.kind,
      ...(d.kind === 'unit' ? { population: Number(d.population) } : { multiplier: d.multiplier.toJSON().map(Number) }),
    }])),
    commands: [],
  };
}

// ---------- toast ----------

let toastTimer;
function toast(msg, danger = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('danger', danger);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- 事件绑定 ----------

function bind() {
  $('#stepBtn').addEventListener('click', doStep);
  $('#ffBtn').addEventListener('click', () => state.ffTimer ? stopFastForward() : startFastForward());
  $('#run10Btn').addEventListener('click', () => runSteps(10));
  $('#run100Btn').addEventListener('click', () => runSteps(100));
  $('#resetBtn').addEventListener('click', resetCase);
  $('#saveBtn').addEventListener('click', saveLocal);
  $('#restoreBtn').addEventListener('click', restoreLocal);
  $('#exportSnapBtn').addEventListener('click', exportSnapshot);
  $('#exportLogBtn').addEventListener('click', exportSettlementLog);

  $('#caseSelect').addEventListener('change', e => {
    if (e.target.value) loadBuiltin(e.target.value);
  });
  $('#fileInput').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadJsonText(reader.result, f.name);
    reader.readAsText(f);
  });

  $('#logFilter').addEventListener('change', e => {
    state.logFilter = e.target.value;
    renderLog();
  });

  // 建筑列表事件委托
  $('#buildingList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const eng = state.engine;
    if (act === 'pause') {
      const b = eng.buildings.get(btn.dataset.bid);
      live({ op: 'pause', building: b.id, paused: !b.paused },
        `${b.id} ${b.paused ? '恢复' : '暂停'}`);
    } else if (act === 'destroy') {
      const bid = btn.dataset.bid;
      live({ op: 'destroy', building: bid }, `摧毁 ${bid}`);
    } else if (act === 'enqueue') {
      const bid = btn.dataset.bid;
      const sel = $(`select[data-enq-item="${CSS.escape(bid)}"]`);
      live({ op: 'enqueue', building: bid, item: sel.value }, `${bid} 入队 ${sel.value}`);
    } else if (act === 'cancel') {
      live({ op: 'cancel', instance: Number(btn.dataset.iid) }, `取消 #${btn.dataset.iid}`);
    } else if (act === 'up' || act === 'down') {
      const iid = Number(btn.dataset.iid);
      const owner = eng.buildingOrder.map(id => eng.buildings.get(id))
        .find(b => b.queue.some(i => i.instanceId === iid));
      const idx = owner.queue.findIndex(i => i.instanceId === iid);
      const swap = act === 'up' ? idx - 1 : idx + 1;
      const order = owner.queue.map(i => i.instanceId);
      [order[idx], order[swap]] = [order[swap], order[idx]];
      live({ op: 'reorder', building: owner.id, order },
        `${owner.id} 重排 [${order.join(',')}]`);
    }
    renderAll();
  });

  // 世界编辑：新增建筑 / grant / release
  $('#addBuildingBtn').addEventListener('click', () => {
    const id = $('#newBid').value.trim();
    const p = $('#newSpeedP').value;
    const q = $('#newSpeedQ').value || '1';
    if (!id) { toast('建筑 ID 不能为空', true); return; }
    if (!/^\d+$/.test(p) || !/^\d+$/.test(q) || BigInt(p) <= 0n || BigInt(q) <= 0n) {
      toast('速度必须是正整数 p/q', true); return;
    }
    if (addBuilding(id, p, q)) { $('#newBid').value = ''; }
  });
  $('#grantBtn').addEventListener('click', () => {
    const r = $('#grantRes').value.trim();
    const n = $('#grantAmt').value;
    if (!r || !/^\d+$/.test(n)) { toast('资源名与非负整数数量必填', true); return; }
    live({ op: 'grant', resource: r, amount: Number(n) }, `发放 ${r} ${n}`);
    renderAll();
  });
  $('#releaseBtn').addEventListener('click', () => {
    const n = $('#releaseAmt').value;
    if (!/^\d+$/.test(n)) { toast('释放数量必须是非负整数', true); return; }
    live({ op: 'release', amount: Number(n) }, `释放人口 ${n}`);
    renderAll();
  });

  // 键盘：空格单步
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); doStep(); }
  });
}

// ---------- 启动 ----------

function start() {
  bind();
  $('#caseSelect').innerHTML =
    '<option value="">选择内置用例…</option>' +
    BUILTIN_CASES.map(([f, label]) => `<option value="${f}">${esc(label)}（${f}）</option>`).join('');
  // 默认载入 fraction 用例；若 fetch 不可用则给一个最小内联场景
  loadBuiltin('fraction.json').catch(() => {
    loadCase({
      resources: { ore: 100 }, resourceCaps: { ore: 100 },
      usedPopulation: 0, populationCap: 10, speedMultiplier: [1, 1],
      buildings: [{ id: 'b', speed: [2, 3], paused: false, queue: ['u', 'u'] }],
      catalog: {
        u: { work: 1, cost: { ore: 10 }, kind: 'unit', population: 1 },
      },
      commands: [],
    }, '内联示例（fetch 不可用）');
  });
}

start();
