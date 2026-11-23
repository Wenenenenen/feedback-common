// app.js — 联调台 UI 控制器（引擎为纯 ES 模块，本文件只做编排与渲染）
import {
  Simulator, EVT, parsePacket, HEADER_SIZE, CRC_SIZE, validateAction,
} from './engine.js';

const $ = id => document.getElementById(id);
const state = {
  sim: null,
  kind: 'generated',
  customFrames: null,
  params: { seats: 2, capacity: 2048, totalTicks: 20000, seed: 20261124 },
  viewTick: 0,
  selectedShard: null, // {seat, frameTick, index}
  theme: null,
};

/* ---------------- 主题 ---------------- */
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('ssc-theme'); } catch { /* 忽略 */ }
  state.theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme();
}
function applyTheme() {
  if (state.theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}
$('btn-theme').addEventListener('click', () => {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  try { localStorage.setItem('ssc-theme', state.theme); } catch { /* 忽略 */ }
  render();
});

/* ---------------- 场景构建 ---------------- */
function buildSim(schedule = []) {
  if (state.kind === 'sample' || state.kind === 'import') {
    return new Simulator({
      customFrames: state.customFrames,
      seats: state.params.seats,
      totalTicks: state.customFrames.length,
      schedule,
    });
  }
  return new Simulator({ ...state.params, schedule });
}

function loadGenerated() {
  state.kind = 'generated';
  state.customFrames = null;
  state.params = { seats: 2, capacity: 2048, totalTicks: 20000, seed: 20261124 };
  state.sim = buildSim([]);
  state.viewTick = 0;
  setupScrubber();
  render();
}

async function loadSample() {
  state.kind = 'sample';
  const res = await fetch('samples/spectator-channel.json');
  const data = await res.json();
  state.customFrames = data.frames;
  state.params = { ...state.params, seats: data.seats.length, totalTicks: data.frames.length };
  state.sim = buildSim(data.network || []);
  state.viewTick = 0;
  setupScrubber();
  render();
}

function loadImported(data) {
  state.kind = 'import';
  const sc = data.scenario || {};
  if (sc.kind === 'scripted') {
    state.customFrames = sc.frames;
    state.params = { seats: sc.seats, totalTicks: sc.frames.length, capacity: 0, seed: 0 };
  } else {
    state.customFrames = null;
    state.params = {
      seats: sc.seats ?? 2, capacity: sc.capacity ?? 2048,
      totalTicks: sc.totalTicks ?? 20000, seed: sc.seed ?? 20261124,
    };
  }
  state.sim = buildSim(data.network || []);
  state.viewTick = 0;
  setupScrubber();
  render();
  toast(`已导入 ${data.network?.length ?? 0} 条安排，提交指纹复现中…`);
}

/* ---------------- 时间轴 / 步进 ---------------- */
function setupScrubber() {
  const T = state.sim.world.totalTicks;
  $('scrub').max = T;
  $('scrub').value = state.viewTick;
  $('tick-readout').textContent = `tick ${state.viewTick} / ${T}`;
}

function seek(tick) {
  const T = state.sim.world.totalTicks;
  state.viewTick = Math.max(0, Math.min(tick, T));
  state.sim.seek(state.viewTick);
  $('scrub').value = state.viewTick;
  $('tick-readout').textContent = `tick ${state.viewTick} / ${T}`;
  render();
}

$('scrub').addEventListener('input', e => seek(Number(e.target.value)));
$('btn-next').addEventListener('click', () => seek(state.viewTick + 1));
$('btn-prev').addEventListener('click', () => seek(state.viewTick - 1));
$('btn-step').addEventListener('click', () => seek(state.viewTick + 1));
$('btn-reset').addEventListener('click', () => { state.sim = buildSim(state.sim.schedule); seek(0); });
$('btn-run').addEventListener('click', () => {
  toast('正在跑到末尾…');
  setTimeout(() => { seek(state.sim.world.totalTicks); toast('已跑到末尾'); }, 30);
});

/* ---------------- 网络安排 ---------------- */
$('af-type').addEventListener('change', () => {
  const t = $('af-type').value;
  const label = $('af-extra-label');
  const extra = $('af-extra');
  if (t === 'delay') { label.textContent = '延迟到 tick（to）'; extra.placeholder = 'to'; }
  else if (t === 'ack-delay') { label.textContent = '延后天数（ticks）'; extra.placeholder = 'ticks'; }
  else if (t === 'duplicate') { label.textContent = '副本到达 tick（at2，留空=同 tick）'; extra.placeholder = 'at2'; }
  else if (t === 'corrupt') { label.textContent = '损坏次数（times，留空=1）'; extra.placeholder = 'times'; }
  else { label.textContent = '附加参数'; extra.placeholder = '—'; }
});

$('action-form').addEventListener('submit', e => {
  e.preventDefault();
  const type = $('af-type').value;
  const action = { type, at: Number($('af-at').value), seat: Number($('af-seat').value) };
  const tickVal = $('af-tick').value;
  const idxVal = $('af-index').value;
  const extraVal = $('af-extra').value;
  if (type !== 'ack-delay') action.tick = Number(tickVal);
  else action.ticks = Number(extraVal) || 1;
  if (idxVal !== '') action.index = Number(idxVal);
  if (type === 'delay') action.to = Number(extraVal);
  if (type === 'duplicate' && extraVal !== '') action.at2 = Number(extraVal);
  if (type === 'corrupt' && extraVal !== '') action.times = Number(extraVal);
  const err = validateAction(action);
  if (err) { toast(err, true); return; }
  state.sim.schedule.push(action);
  state.sim.schedule.sort((a, b) => a.at - b.at);
  state.sim = buildSim(state.sim.schedule);
  seek(Math.min(state.viewTick, state.sim.world.totalTicks));
  renderActions();
  toast('已添加安排并重建模拟');
});

function removeAction(i) {
  state.sim.schedule.splice(i, 1);
  state.sim = buildSim(state.sim.schedule);
  seek(Math.min(state.viewTick, state.sim.world.totalTicks));
  renderActions();
}

function renderActions() {
  const sched = state.sim.schedule;
  $('action-count').textContent = `${sched.length} 条`;
  $('action-empty').hidden = sched.length > 0;
  const tbody = $('action-rows');
  tbody.innerHTML = '';
  sched.forEach((a, i) => {
    const tr = document.createElement('tr');
    const target = a.type === 'ack-delay'
      ? `延后 ${a.ticks}×${a.count ?? 1}`
      : `帧 ${a.tick}${a.index !== undefined ? '#' + a.index : ''}${a.to ? ` →${a.to}` : ''}${a.at2 ? ` 副本@${a.at2}` : ''}`;
    tr.innerHTML = `<td class="mono">${a.at}</td><td class="mono">${a.seat}</td>
      <td><span class="tag-pill tag-${a.type}">${a.type}</span></td>
      <td class="mono" style="font-size:11px">${target}</td>
      <td><button class="row-btn" title="删除">✕</button></td>`;
    tr.querySelector('.row-btn').addEventListener('click', () => removeAction(i));
    tbody.appendChild(tr);
  });
}

/* ---------------- 导出 / 导入 ---------------- */
$('btn-export').addEventListener('click', () => {
  const data = state.sim.exportSchedule();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spectator-network-t${state.viewTick}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('安排已导出（重导将复现同一提交序列）');
});

$('scenario-select').addEventListener('change', async e => {
  if (e.target.value === 'sample') await loadSample();
  else if (e.target.value === 'generated') loadGenerated();
  else $('import-file').click();
});
$('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.network || !data.scenario) throw new Error('缺少 network / scenario 字段');
    loadImported(data);
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
  e.target.value = '';
  $('scenario-select').value = state.kind === 'sample' ? 'sample' : state.kind === 'import' ? 'import' : 'generated';
});

/* ---------------- 屏幕渲染 ---------------- */
const SEAT_COLORS = ['#5fb3d4', '#d9a441'];

function buildSeatPanels() {
  const grid = $('seats-grid');
  grid.innerHTML = '';
  for (let si = 0; si < state.params.seats; si++) {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.id = `seat-panel-${si}`;
    panel.innerHTML = `
      <div class="panel-head">
        <h2>旁观席 ${si + 1}</h2>
        <span class="spacer"></span>
        <span class="badge" id="seat-kind-${si}">—</span>
        <span class="badge ok" id="seat-commit-${si}">未提交</span>
      </div>
      <div class="panel-body">
        <div class="screen-wrap">
          <div class="canvas-box"><canvas id="canvas-${si}" width="560" height="560"></canvas></div>
          <div class="screen-meta">
            <div class="row"><span class="k">屏幕实体</span><span class="v" id="m-count-${si}">0</span></div>
            <div class="row"><span class="k">最新提交</span><span class="v" id="m-tick-${si}">—</span></div>
            <div class="row"><span class="k">当前基线</span><span class="v" id="m-base-${si}">—</span></div>
            <div class="row"><span class="k">待组装帧</span><span class="v" id="m-pend-${si}">0</span></div>
            <div class="row"><span class="k">恢复状态</span><span class="v" id="m-resync-${si}">—</span></div>
          </div>
        </div>
        <div class="ring-row" id="ring-${si}"></div>
      </div>`;
    grid.appendChild(panel);
  }
}

function drawScreen(si) {
  const canvas = $(`canvas-${si}`);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  ctx.clearRect(0, 0, W, W);
  const rc = state.sim.receivers[si];
  const snap = rc.ring.at(-1)?.snapshot;
  const color = SEAT_COLORS[si];
  if (snap) {
    const n = snap.ids.length;
    for (let i = 0; i < n; i++) {
      const px = (snap.xs[i] / 1000) * (W - 12) + 6;
      const py = (snap.ys[i] / 1000) * (W - 12) + 6;
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  // 无半帧提示：若有未就绪 pending，画遮罩文字
  if (rc.pending.size > 0 && !rc.ring.length) {
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = '#e6ebf2';
    ctx.font = '20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('等待首个完整快照…', W / 2, W / 2);
  }
}

function renderSeat(si) {
  const sim = state.sim;
  const rc = sim.receivers[si];
  const t = state.viewTick;
  const desc = t >= 1 ? sim.descriptors[si][t - 1] : null;
  const kindBadge = $(`seat-kind-${si}`);
  if (desc) {
    kindBadge.textContent = desc.base === 0 ? `全量 base=0 · ${desc.total} 片` : `增量 base=${desc.base} · ${desc.total} 片`;
    kindBadge.className = 'badge ' + (desc.base === 0 ? 'full' : 'delta');
  } else { kindBadge.textContent = '本 tick 无发送'; kindBadge.className = 'badge'; }
  const commitBadge = $(`seat-commit-${si}`);
  commitBadge.textContent = rc.lastCommitted ? `已提交 tick ${rc.lastCommitted}` : '未提交';
  commitBadge.className = 'badge ' + (rc.lastCommitted ? 'ok' : 'warn');
  const snap = rc.ring.at(-1)?.snapshot;
  $(`m-count-${si}`).textContent = snap ? snap.ids.length : 0;
  $(`m-tick-${si}`).textContent = rc.lastCommitted || '—';
  $(`m-base-${si}`).textContent = desc ? (desc.base || '全量') : '—';
  $(`m-pend-${si}`).textContent = rc.pending.size;
  $(`m-resync-${si}`).textContent = rc.resyncRequested ? '请求全量恢复' : '正常';
  // 保留环
  const ring = $(`ring-${si}`);
  ring.innerHTML = '';
  rc.ring.forEach(s => {
    const chip = document.createElement('span');
    chip.className = 'ring-chip' + (s.tick === rc.lastCommitted ? ' head' : '') + (desc && s.tick === desc.base ? ' base' : '');
    chip.textContent = `t${s.tick}·${s.snapshot.ids.length}`;
    chip.title = `快照 tick ${s.tick}，${s.snapshot.ids.length} 个实体`;
    ring.appendChild(chip);
  });
  drawScreen(si);
}

/* ---------------- 时间轴条带 ---------------- */
function renderStrip() {
  const sim = state.sim;
  const T = sim.world.totalTicks;
  const strip = $('strip');
  strip.innerHTML = '';
  for (let si = 0; si < state.params.seats; si++) {
    const label = document.createElement('div');
    label.className = 'seat-label';
    label.textContent = `席${si + 1}`;
    const track = document.createElement('div');
    track.className = 'strip-track';
    const cells = document.createElement('div');
    cells.className = 'strip-cells';
    // 单元宽度：帧很多时按比例抽样绘制，最多 ~240 个格
    const maxCells = Math.min(T, 240);
    const bucket = Math.ceil(T / maxCells);
    for (let b = 0; b < maxCells; b++) {
      const lo = b * bucket + 1, hi = Math.min((b + 1) * bucket, T);
      let committed = false, full = false, voided = false, fault = false;
      for (let tk = lo; tk <= hi; tk++) {
        const d = sim.descriptors[si][tk - 1];
        if (!d) continue;
        if (d.committed) committed = true;
        if (d.base === 0) full = true;
        if (d.voided) voided = true;
        if (d.statuses.some(x => x & 6)) fault = true; // drop/corrupt 位
      }
      const cell = document.createElement('div');
      cell.className = 'cell' + (voided ? ' voided' : committed ? (full ? ' full' : 'committed') : fault ? ' fault' : '');
      cell.title = `tick ${lo}–${hi}`;
      cell.addEventListener('click', () => seek(lo));
      cells.appendChild(cell);
    }
    // 保留窗口
    const rc = sim.receivers[si];
    if (rc.ring.length) {
      const first = rc.ring[0].tick, last = rc.ring.at(-1).tick;
      const win = document.createElement('div');
      win.className = 'strip-win';
      win.style.left = `${((first - 1) / T) * 100}%`;
      win.style.width = `${((last - first + 1) / T) * 100}%`;
      track.appendChild(win);
    }
    const cursor = document.createElement('div');
    cursor.className = 'strip-cursor';
    cursor.style.left = `${(state.viewTick / T) * 100}%`;
    track.append(cells, cursor);
    strip.append(label, track);
  }
  $('hash-badge').textContent = `提交指纹 ${sim.commitHash()}`;
}

/* ---------------- 包内容 ---------------- */
$('packet-seat').addEventListener('change', () => { state.selectedShard = null; renderPackets(); });

function renderPackets() {
  const si = Number($('packet-seat').value);
  const t = state.viewTick;
  const list = $('packet-list');
  list.innerHTML = '';
  const sim = state.sim;
  const frame = t >= 1 ? sim.archivedPackets(si, t) : null;
  const desc = t >= 1 ? sim.descriptors[si][t - 1] : null;
  if (!frame || !desc) {
    $('packet-empty').hidden = false;
    $('packet-detail').hidden = true;
    return;
  }
  $('packet-empty').hidden = true;
  frame.forEach((pkt, index) => {
    const parsed = parsePacket(pkt.bytes);
    const card = document.createElement('div');
    card.className = 'packet-card' + (state.selectedShard?.index === index ? ' selected' : '');
    const status = desc.statuses[index] || 0;
    const flags = [];
    if (status & 2) flags.push(['bad', '丢失']);
    if (status & 4) flags.push(['warn', '损坏']);
    if (status & 8) flags.push(['', '重复']);
    if (status & 32) flags.push(['', '延迟']);
    if (status & 1) flags.push(['ok', '已交付']);
    card.innerHTML = `
      <div class="top">
        <strong class="mono">#${index}/${desc.total}</strong>
        <span class="badge ${desc.base === 0 ? 'full' : 'delta'}">${desc.base === 0 ? '全量' : 'base ' + desc.base}</span>
        ${flags.map(([c, x]) => `<span class="badge ${c}">${x}</span>`).join('')}
        <span class="spacer" style="flex:1"></span>
        <span class="mono" style="color:var(--fg-faint);font-size:11px">${pkt.bytes.length}B · 投递 t${pkt.deliverAt < 0 ? '✕' : pkt.deliverAt}</span>
      </div>
      <div class="hex">${parsed.ok ? `${parsed.records.length} 条记录` : 'CRC/格式拒收：' + parsed.reason}</div>`;
    card.addEventListener('click', () => { state.selectedShard = { seat: si, frameTick: t, index }; renderPackets(); });
    list.appendChild(card);
  });
  renderPacketDetail(si, t, desc);
}

function renderPacketDetail(si, t, desc) {
  const box = $('packet-detail');
  if (!state.selectedShard || state.selectedShard.frameTick !== t || state.selectedShard.seat !== si) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const frame = state.sim.archivedPackets(si, t);
  const pkt = frame[state.selectedShard.index];
  const parsed = parsePacket(pkt.bytes);
  const body = $('packet-detail-body');
  if (!parsed.ok) {
    body.innerHTML = `片头 tick=${t} base=${desc.base} index=${state.selectedShard.index} total=${desc.total}<br>拒收原因：<span style="color:var(--bad)">${parsed.reason}</span>`;
    return;
  }
  const head = `tick=${parsed.tick} base=${parsed.base} index=${parsed.index} total=${parsed.total}，载荷 ${pkt.bytes.length - HEADER_SIZE - CRC_SIZE}B，CRC 合法`;
  const recs = parsed.records.slice(0, 12).map(r =>
    r.tag === 0
      ? `DEL id=${r.id} gen=${r.gen}`
      : `UPD id=${r.id} gen=${r.gen} (${r.x},${r.y})`).join('<br>');
  const more = parsed.records.length > 12 ? `<br>… 其余 ${parsed.records.length - 12} 条` : '';
  body.innerHTML = `${head}<br><br>${recs}${more}`;
}

/* ---------------- 事件日志 / 提交理由 ---------------- */
$('event-seat').addEventListener('change', renderEvents);
const EV_CLASS = {
  [EVT.PARSE_FAIL]: 'ev-bad', [EVT.SHARD_CONFLICT]: 'ev-bad', [EVT.STALE_DROP]: 'ev-warn',
  [EVT.DROP]: 'ev-bad', [EVT.CORRUPT]: 'ev-warn', [EVT.BASELINE_MISSING]: 'ev-bad',
  [EVT.COMMIT_FULL]: 'ev-good', [EVT.COMMIT_DELTA]: 'ev-good', [EVT.COMMIT_FULL_RESYNC]: 'ev-good',
  [EVT.DEDUP]: 'ev-warn', [EVT.DUPLICATE]: 'ev-warn', [EVT.DELAY]: 'ev-info', [EVT.ACK_DELAYED]: 'ev-info',
};
const EV_LABEL = {
  [EVT.SEND_FULL]: '发全量', [EVT.SEND_DELTA]: '发增量', [EVT.DROP]: '丢失', [EVT.CORRUPT]: '损坏',
  [EVT.DUPLICATE]: '安排重复', [EVT.DELAY]: '延迟', [EVT.ACK_DELAYED]: '确认延后', [EVT.ACK_SENT]: '发确认',
  [EVT.ACK_RECV]: '确认到达', [EVT.PARSE_FAIL]: '校验拒收', [EVT.STALE_DROP]: '旧帧丢弃',
  [EVT.DEDUP]: '重复去重', [EVT.SHARD_CONFLICT]: '同号冲突作废', [EVT.BASELINE_MISSING]: '缺基线',
  [EVT.RESYNC_SENT]: '请求全量恢复', [EVT.ASSEMBLED_WAITING]: '收齐待序',
  [EVT.COMMIT_FULL]: '提交全量', [EVT.COMMIT_DELTA]: '提交增量', [EVT.COMMIT_FULL_RESYNC]: '提交恢复全量',
};

function renderEvents() {
  const filter = Number($('event-seat').value);
  const log = $('event-log');
  log.innerHTML = '';
  const evs = state.sim.events
    .filter(e => filter === -1 || e.seat === filter + 1)
    .filter(e => e.tick <= state.viewTick)
    .slice(-60);
  if (!evs.length) {
    log.innerHTML = '<div class="empty-note">当前 tick 之前没有事件。</div>';
  }
  for (const e of evs) {
    const line = document.createElement('div');
    line.className = 'event-line ' + (EV_CLASS[e.code] || 'ev-info');
    const detail = [];
    if (e.base !== undefined) detail.push(`base=${e.base}`);
    if (e.shard !== undefined) detail.push(`片#${e.shard}`);
    if (e.ackTick !== undefined) detail.push(`ack t${e.ackTick}`);
    if (e.detail) detail.push(e.detail);
    line.innerHTML = `<span class="et">t${e.tick} 席${e.seat}</span>
      <span class="ec">${EV_LABEL[e.code] || e.code}</span>
      <span class="ed">${detail.join(' · ')}</span>`;
    log.appendChild(line);
  }
  log.scrollTop = log.scrollHeight;
  renderCommitReason();
}

function renderCommitReason() {
  const t = state.viewTick;
  const parts = [];
  for (let si = 0; si < state.params.seats; si++) {
    const rc = state.sim.receivers[si];
    const d = t >= 1 ? state.sim.descriptors[si][t - 1] : null;
    let reason;
    if (!d) reason = '本 tick 无发送。';
    else if (d.voided) reason = `帧作废：<code>${d.reason || '同号片内容冲突'}</code>，已请求全量恢复，不显示半帧。`;
    else if (!d.committed) reason = d.base === 0
      ? '全量帧已发，等待分片收齐后原子提交为新基线。'
      : `增量帧引用基线 <code>t${d.base}</code>，收齐且校验通过才提交；旧帧不覆盖新帧。`;
    else reason = d.base === 0
      ? '全量帧分片全部收齐、CRC 合法、id 唯一，<code>原子提交</code>为完整投影。'
      : `增量帧在基线 <code>t${d.base}</code> 拷贝上应用删除/更新，代数校验通过后<code>原子提交</code>。`;
    parts.push(`<div style="margin-bottom:6px"><strong>席${si + 1}：</strong>${reason}</div>`);
  }
  $('commit-reason-body').innerHTML = parts.join('');
}

/* ---------------- 总渲染 ---------------- */
function render() {
  renderActions();
  for (let si = 0; si < state.params.seats; si++) renderSeat(si);
  renderStrip();
  renderPackets();
  renderEvents();
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

/* ---------------- 启动 ---------------- */
initTheme();
buildSeatPanels();
loadGenerated();
