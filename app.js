'use strict';
/* 输入动作仲裁调试器 UI 逻辑。引擎见 arbiter.js。 */

/* 预置样例(来自 samples/input-action-arbiter-cases.zip,CC0-1.0) */
const PRESETS = {
  combo: {
    config: {
      window_ms: 40,
      contexts: [
        { id: 'game', priority: 1, active: true },
        { id: 'menu', priority: 10, active: false },
      ],
      bindings: [
        { id: 'single', context: 'game', priority: 0, keys: ['K'], hold_ms: 0 },
        { id: 'dash', context: 'game', priority: 0, keys: ['K', 'Shift'], hold_ms: 0 },
        { id: 'menu-ok', context: 'menu', priority: 0, keys: ['K'], hold_ms: 0 },
      ],
    },
    events: [
      { t: 0, seq: 0, type: 'down', key: 'K' },
      { t: 20, seq: 1, type: 'down', key: 'Shift' },
      { t: 30, seq: 2, type: 'down', key: 'K' },
      { t: 70, seq: 3, type: 'up', key: 'Shift' },
      { t: 80, seq: 4, type: 'up', key: 'K' },
    ],
  },
  hold: {
    config: {
      window_ms: 40,
      contexts: [{ id: 'game', priority: 1, active: true }],
      bindings: [{ id: 'charge', context: 'game', priority: 0, keys: ['Q'], hold_ms: 100 }],
    },
    events: [
      { t: 10, seq: 0, type: 'down', key: 'Q' },
      { t: 110, seq: 1, type: 'up', key: 'Q' },
    ],
  },
  ctxblur: {
    config: {
      window_ms: 40,
      contexts: [
        { id: 'game', priority: 1, active: true },
        { id: 'menu', priority: 10, active: false },
      ],
      bindings: [
        { id: 'single', context: 'game', priority: 0, keys: ['K'], hold_ms: 0 },
        { id: 'dash', context: 'game', priority: 0, keys: ['K', 'Shift'], hold_ms: 0 },
        { id: 'menu-ok', context: 'menu', priority: 0, keys: ['K'], hold_ms: 0 },
      ],
    },
    events: [
      { t: 0, seq: 0, type: 'down', key: 'K' },
      { t: 45, seq: 1, type: 'context', active: ['game', 'menu'] },
      { t: 60, seq: 2, type: 'up', key: 'K' },
      { t: 70, seq: 3, type: 'down', key: 'K' },
      { t: 120, seq: 4, type: 'blur' },
    ],
  },
};

const $ = (s) => document.querySelector(s);
const STREAM_DOM_CAP = 3000;

let engine = new Arbiter();
let mode = 'live';
let replayEvents = [];
let recordedEvents = [];
let streamRows = 0;
let liveBase = null;
let liveTimer = null;
let replayTimer = null;
let playing = false;
let replayLoaded = false;

/* ---------------- 通用渲染 ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtKeys(keys) {
  return keys.length ? keys.map(esc).join(' ') : '—';
}

function entryTags(e) {
  switch (e.kind) {
    case 'started': return `<span class="tag started">started ${esc(e.id)}</span><span class="mono-dim">就绪@${e.readyTime}</span> `;
    case 'performed': return `<span class="tag performed">performed ${esc(e.id)}</span> `;
    case 'canceled': return `<span class="tag canceled">canceled ${esc(e.id)}</span><span class="mono-dim">${esc(e.reason || '')}</span> `;
    case 'eliminated': return `<span class="tag eliminated">淘汰 ${esc(e.id)}</span><span class="mono-dim">${esc(e.reason || '')}</span> `;
    case 'candidate': return `<span class="tag candidate">候选 ${esc(e.id)}</span><span class="mono-dim">截止@${e.deadline}</span> `;
    case 'occupy': return `<span class="tag occupy">占用 ${esc(e.id)}</span><span class="mono-dim">${fmtKeys(e.keys)}</span> `;
    case 'release': return `<span class="tag release">解除占用 ${esc(e.id)}</span> `;
    case 'input': return e.ignored ? `<span class="tag ignored">忽略</span><span class="mono-dim">${esc(e.reason || '')}</span> ` : '';
    default: return '';
  }
}

function describeInput(entries) {
  const inp = entries.find((e) => e.kind === 'input');
  const timer = entries.find((e) => e.kind === 'timer');
  if (inp) {
    if (inp.type === 'down') return `▼ down ${esc(inp.key)}${inp.synth ? ' (合成)' : ''}`;
    if (inp.type === 'up') return `▲ up ${esc(inp.key)}${inp.synth ? ' (合成)' : ''}`;
    if (inp.type === 'context') return `上下文 → [${inp.active.map(esc).join(', ')}]`;
    if (inp.type === 'blur') return '⚠ blur 失焦';
  }
  if (timer) return '⏱ 定时器到期';
  return '';
}

function appendStreamRow(entries) {
  if (!entries.length) return;
  const snap = engine.snapshot();
  const t = entries[0].t;
  const isTimer = entries.some((e) => e.kind === 'timer') && !entries.some((e) => e.kind === 'input');
  const candidates = snap.bindings
    .filter((b) => b.state === 'candidate' || b.state === 'started')
    .map((b) => b.state === 'candidate'
      ? `<span class="tag candidate">${esc(b.id)} 截止@${b.deadline}</span>`
      : `<span class="tag started">${esc(b.id)} 就绪@${b.readyTime}</span>`)
    .join('') || '<span class="mono-dim">—</span>';
  const occupied = snap.occupied.length
    ? snap.occupied.map((o) => `<span class="tag occupy">${esc(o.key)}←${esc(o.by)}</span>`).join('')
    : '<span class="mono-dim">—</span>';
  const results = entries.filter((e) => e.kind !== 'timer' && !(e.kind === 'input' && !e.ignored))
    .map(entryTags).join('') || '<span class="mono-dim">—</span>';
  const hasAction = entries.some((e) => ['started', 'performed', 'canceled', 'eliminated'].includes(e.kind));
  const tr = document.createElement('tr');
  if (isTimer) tr.className = 'timer-row';
  if (!hasAction) tr.dataset.pureInput = '1';
  tr.innerHTML = `<td>${t}</td><td>${esc(describeInput(entries))}</td>` +
    `<td>${fmtKeys(snap.pressed)}</td><td>${candidates}</td><td>${occupied}</td><td>${results}</td>`;
  const body = $('#stream-body');
  body.appendChild(tr);
  streamRows++;
  while (body.rows.length > STREAM_DOM_CAP) body.deleteRow(0);
  $('#stream-count').textContent = `${streamRows} 行` + (streamRows > STREAM_DOM_CAP ? `(页面仅保留最近 ${STREAM_DOM_CAP} 行,完整日志可导出)` : '');
  applyStreamFilter();
  if ($('#filter-autoscroll').checked) {
    const wrap = document.querySelector('.stream-wrap');
    wrap.scrollTop = wrap.scrollHeight;
  }
}

function applyStreamFilter() {
  const hide = $('#filter-hide-input').checked;
  for (const tr of $('#stream-body').rows) {
    tr.style.display = (hide && tr.dataset.pureInput) ? 'none' : '';
  }
}

function renderActionLog(entries) {
  const box = $('#actionlog');
  for (const e of entries) {
    if (!['started', 'performed', 'canceled'].includes(e.kind)) continue;
    const div = document.createElement('div');
    div.innerHTML = `<span class="mono-dim">t=${e.t}</span> ${entryTags(e)}`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function renderStates() {
  const snap = engine.snapshot();
  $('#binding-states').innerHTML = snap.bindings.map((b) => {
    let extra = '';
    if (b.state === 'candidate') extra = ` 截止@${b.deadline}`;
    else if (b.state === 'started') extra = ` 就绪@${b.readyTime}`;
    return `<span class="chip ${b.state}">${esc(b.id)}: ${b.state}${extra}</span>`;
  }).join('') || '<span class="mono-dim">无绑定</span>';
  const pressed = snap.pressed.map((k) => `<span class="key">${esc(k)}</span>`).join('');
  const occupied = snap.occupied.map((o) => `<span class="key occupied">${esc(o.key)}←${esc(o.by)}</span>`).join('');
  $('#live-pressed').innerHTML = pressed;
  $('#live-occupied').innerHTML = occupied;
  $('#live-clock').textContent = snap.clock;
  $('#replay-clock').textContent = snap.clock;
  updateReplayProgress();
}

function driveStep() {
  const entries = engine.step();
  appendStreamRow(entries);
  renderActionLog(entries);
  renderStates();
}

/* ---------------- 配置面板 ---------------- */

function collectConfigFromUI() {
  const contexts = [...$('#cfg-contexts tbody').rows].map((r) => ({
    id: r.cells[0].querySelector('input').value.trim(),
    priority: Number(r.cells[1].querySelector('input').value),
    active: r.cells[2].querySelector('input').checked,
  })).filter((c) => c.id);
  const bindings = [...$('#cfg-bindings tbody').rows].map((r) => ({
    id: r.cells[0].querySelector('input').value.trim(),
    context: r.cells[1].querySelector('select').value,
    priority: Number(r.cells[2].querySelector('input').value),
    keys: r.cells[3].querySelector('input').value.split(',').map((s) => s.trim()).filter(Boolean),
    hold_ms: Number(r.cells[4].querySelector('input').value),
  })).filter((b) => b.id);
  return { window_ms: Number($('#cfg-window').value), contexts, bindings };
}

function renderConfigUI(config) {
  $('#cfg-window').value = config.window_ms;
  const ctxBody = $('#cfg-contexts tbody');
  ctxBody.innerHTML = '';
  for (const c of config.contexts) addContextRow(c);
  renderBindings(config);
  updateCfgCount(config);
}

function updateCfgCount(config) {
  $('#cfg-count').textContent = `${config.bindings.length}/${Arbiter.MAX_BINDINGS} 绑定`;
}

function addContextRow(c) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="text" value="${esc(c.id)}"></td>` +
    `<td><input type="number" value="${c.priority}" style="width:60px"></td>` +
    `<td><input type="checkbox" ${c.active ? 'checked' : ''}></td>`;
  // 激活切换 = 注入 context 事件(协议事件,非配置修改);id/优先级改动需点“应用配置”
  tr.cells[2].querySelector('input').addEventListener('change', () => {
    const cfg = collectConfigFromUI();
    const active = cfg.contexts.filter((x) => x.active).map((x) => x.id);
    injectEvent({ type: 'context', active });
  });
  tr.cells[0].querySelector('input').addEventListener('change', renderBindingsFromUI);
  $('#cfg-contexts tbody').appendChild(tr);
}

function renderBindingsFromUI() {
  renderBindings(collectConfigFromUI());
}

function renderBindings(config) {
  const body = $('#cfg-bindings tbody');
  body.innerHTML = '';
  for (const b of config.bindings) {
    const tr = document.createElement('tr');
    const opts = config.contexts.map((c) =>
      `<option value="${esc(c.id)}" ${c.id === b.context ? 'selected' : ''}>${esc(c.id)}</option>`).join('');
    tr.innerHTML = `<td><input type="text" value="${esc(b.id)}"></td>` +
      `<td><select>${opts}</select></td>` +
      `<td><input type="number" value="${b.priority}" style="width:50px"></td>` +
      `<td><input type="text" value="${b.keys.map(esc).join(',')}" placeholder="K,Shift"></td>` +
      `<td><input type="number" min="0" value="${b.hold_ms}" style="width:60px"></td>` +
      `<td><button title="删除">✕</button></td>`;
    tr.cells[5].querySelector('button').addEventListener('click', () => { tr.remove(); });
    body.appendChild(tr);
  }
  updateCfgCount(config);
}

function applyConfig(reason) {
  const msg = $('#cfg-msg');
  msg.className = 'msg';
  try {
    const cfg = collectConfigFromUI();
    const n0 = engine.entries.length;
    engine.setConfig(cfg, { reason: reason || '配置修改' });
    const entries = engine.entries.slice(n0);
    if (entries.length) {
      appendStreamRow(entries);
      renderActionLog(entries);
    }
    renderStates();
    scheduleLiveTimer(); // 候选/就绪定时器可能已随配置失效
    msg.textContent = '配置已应用';
    msg.classList.add('ok');
  } catch (err) {
    msg.textContent = String(err.message || err);
  }
}

/* ---------------- 模式切换 ---------------- */

function setMode(m) {
  mode = m;
  $('#tab-live').classList.toggle('active', m === 'live');
  $('#tab-replay').classList.toggle('active', m === 'replay');
  $('#panel-live').classList.toggle('hidden', m !== 'live');
  $('#panel-replay').classList.toggle('hidden', m !== 'replay');
  pauseReplay();
  cancelLiveTimer();
  if (m === 'replay' && !replayLoaded) loadReplay(replayEvents);
}

/* ---------------- 实时键盘 ---------------- */

function normKey(e) {
  if (e.key === ' ') return 'Space';
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key; // Shift / Control / Alt / Meta / ArrowUp / Enter ...
}

function liveNow() {
  if (liveBase === null) liveBase = performance.now();
  return Math.round(performance.now() - liveBase);
}

function injectEvent(ev) {
  // 实时模式打逻辑时间戳;回放模式插到当前时钟位置
  if (mode === 'live') {
    ev.t = liveNow();
    const stored = engine.push(ev);
    recordedEvents.push(Object.assign({}, stored));
    // 只处理到本事件所在的同一 t 为止(同刻输入一起处理,再处理到期定时器)
    while (engine.queue.length && engine.queue[0].t <= stored.t) driveStep();
    scheduleLiveTimer();
  } else {
    ev.t = engine.clock;
    const stored = engine.push(ev);
    if (!playing) {
      while (engine.queue.length && engine.queue[0].t <= stored.t) driveStep();
    }
  }
  renderStates();
}

function cancelLiveTimer() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
}

function scheduleLiveTimer() {
  cancelLiveTimer();
  const nt = engine.nextTimerTime();
  if (nt === Infinity || liveBase === null) return;
  const delay = Math.max(0, liveBase + nt - performance.now());
  liveTimer = setTimeout(() => {
    liveTimer = null;
    driveStep(); // 队列空时 step 处理到期定时器组
    scheduleLiveTimer();
  }, delay);
}

function liveReset() {
  pauseReplay();
  cancelLiveTimer();
  const cfg = engine.getConfig();
  engine = new Arbiter();
  engine.setConfig(cfg);
  liveBase = null;
  recordedEvents = [];
  replayLoaded = false;
  clearLogs();
  renderStates();
}

/* ---------------- 日志回放 ---------------- */

function loadReplay(events) {
  pauseReplay();
  const cfg = engine.getConfig();
  engine = new Arbiter();
  engine.setConfig(cfg);
  engine.loadEvents(events);
  replayEvents = engine.queue.slice();
  replayLoaded = true;
  clearLogs();
  renderStates();
  updateReplayInfo();
}

function updateReplayInfo() {
  const maxT = replayEvents.length ? replayEvents[replayEvents.length - 1].t : 0;
  $('#replay-info').textContent = replayEvents.length
    ? `已载入 ${replayEvents.length} 条事件,时长 ${maxT} ms`
    : '未载入事件(导入含 events 的 JSON 或选择预置样例)';
  updateReplayProgress();
}

function updateReplayProgress() {
  const maxT = replayEvents.length ? replayEvents[replayEvents.length - 1].t : 0;
  const pct = maxT > 0 ? Math.min(100, (engine.clock / maxT) * 100) : (engine.hasWork() ? 0 : 100);
  $('#replay-progress').style.width = pct + '%';
}

function replayTick() {
  replayTimer = null;
  if (!playing) return;
  if (!engine.hasWork()) { pauseReplay(); return; }
  driveStep();
  scheduleReplayTick();
}

function scheduleReplayTick() {
  if (!playing) return;
  if (!engine.hasWork()) { pauseReplay(); return; }
  const speed = Number($('#replay-speed').value);
  const nt = engine.peekNextTime();
  const delay = Math.max(0, nt - engine.clock) / speed;
  replayTimer = setTimeout(replayTick, delay);
}

function playReplay() {
  if (playing || !engine.hasWork()) return;
  playing = true;
  $('#btn-play').textContent = '⏸ 暂停';
  scheduleReplayTick();
}

function pauseReplay() {
  playing = false;
  if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
  $('#btn-play').textContent = '▶ 播放';
}

function replayReset() {
  loadReplay(replayEvents);
}

/* ---------------- 导入 / 导出 ---------------- */

function download(name, obj) {
  const text = JSON.stringify(obj, null, 2);
  // 始终展示可复制文本(在沙箱/查看器中 <a download> 可能无效)
  $('#export-label').textContent = name;
  $('#export-output').value = text;
  $('#panel-export').classList.remove('hidden');
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { /* 沙箱环境忽略下载失败,使用复制 */ }
}

function doImport(text) {
  const msg = $('#import-msg');
  msg.className = 'msg';
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('不是 JSON 对象');
    let applied = [];
    if (data.config) {
      const errors = Arbiter.validateConfig(data.config);
      if (errors.length) throw new Error(errors.join(';'));
      const n0 = engine.entries.length;
      engine.setConfig(data.config, { reason: '导入配置' });
      const entries = engine.entries.slice(n0);
      if (entries.length) { appendStreamRow(entries); renderActionLog(entries); }
      renderConfigUI(engine.getConfig());
      applied.push('配置');
    }
    if (data.events) {
      engine.loadEvents(data.events); // 校验容量与格式
      replayEvents = engine.queue.slice();
      replayLoaded = true;
      setMode('replay');
      updateReplayInfo();
      applied.push(`事件 ${data.events.length} 条`);
    }
    if (!applied.length) throw new Error('JSON 中既没有 config 也没有 events');
    renderStates();
    msg.textContent = `已导入:${applied.join(' + ')}`;
    msg.classList.add('ok');
  } catch (err) {
    msg.textContent = String(err.message || err);
  }
}

function clearLogs() {
  $('#stream-body').innerHTML = '';
  $('#actionlog').innerHTML = '';
  streamRows = 0;
  $('#stream-count').textContent = '';
}

/* ---------------- 事件绑定 ---------------- */

function init() {
  // 预置默认配置(事件不预载,切到回放页再载入,避免污染实时模式)
  engine.setConfig(PRESETS.combo.config);
  replayEvents = PRESETS.combo.events.slice();
  renderConfigUI(engine.getConfig());
  renderStates();
  updateReplayInfo();

  $('#tab-live').addEventListener('click', () => setMode('live'));
  $('#tab-replay').addEventListener('click', () => setMode('replay'));

  $('#preset').addEventListener('change', (e) => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    pauseReplay();
    engine = new Arbiter();
    engine.setConfig(p.config);
    replayEvents = p.events.slice();
    replayLoaded = false;
    recordedEvents = [];
    liveBase = null;
    clearLogs();
    renderConfigUI(engine.getConfig());
    renderStates();
    updateReplayInfo();
    setMode('replay');
    e.target.value = '';
  });

  $('#btn-add-context').addEventListener('click', () => {
    addContextRow({ id: 'ctx' + ($('#cfg-contexts tbody').rows.length + 1), priority: 0, active: false });
    renderBindingsFromUI();
  });
  $('#btn-add-binding').addEventListener('click', () => {
    const cfg = collectConfigFromUI();
    cfg.bindings.push({ id: 'action' + (cfg.bindings.length + 1), context: cfg.contexts[0] ? cfg.contexts[0].id : '', priority: 0, keys: [], hold_ms: 0 });
    renderBindings(cfg);
  });
  $('#btn-apply-config').addEventListener('click', () => applyConfig());

  // 实时键盘捕获
  const capture = $('#capture');
  capture.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { capture.blur(); return; }
    e.preventDefault();
    if (e.repeat) return; // 操作系统自动重复不重复触发
    injectEvent({ type: 'down', key: normKey(e) });
  });
  capture.addEventListener('keyup', (e) => {
    e.preventDefault();
    injectEvent({ type: 'up', key: normKey(e) });
  });
  capture.addEventListener('focus', () => capture.classList.add('armed'));
  capture.addEventListener('blur', () => {
    capture.classList.remove('armed');
    // 捕获框失焦(如点击页面其他按钮、Esc 退出)同样释放按住状态
    if (mode === 'live' && engine.snapshot().pressed.length) injectEvent({ type: 'blur' });
  });

  // 失焦释放状态(弹出菜单 / 切窗口)
  window.addEventListener('blur', () => {
    if (mode === 'live' && (engine.snapshot().pressed.length || liveBase !== null)) {
      injectEvent({ type: 'blur' });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'live' && engine.snapshot().pressed.length) {
      injectEvent({ type: 'blur' });
    }
  });

  $('#btn-live-reset').addEventListener('click', liveReset);

  // 回放控制
  $('#btn-play').addEventListener('click', () => (playing ? pauseReplay() : playReplay()));
  $('#btn-step').addEventListener('click', () => {
    pauseReplay();
    if (mode !== 'replay') setMode('replay');
    if (engine.hasWork()) driveStep();
  });
  $('#btn-replay-reset').addEventListener('click', replayReset);
  $('#replay-speed').addEventListener('change', () => {
    if (playing) { clearTimeout(replayTimer); replayTimer = null; scheduleReplayTick(); }
  });

  // 导入导出
  $('#btn-import').addEventListener('click', () => $('#paste-import').focus());
  $('#btn-do-import').addEventListener('click', () => doImport($('#paste-import').value));
  $('#file-import').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => doImport(String(r.result));
    r.readAsText(f);
    e.target.value = '';
  });
  $('#btn-export-config').addEventListener('click', () => download('input-config.json', engine.getConfig()));
  $('#btn-export-actions').addEventListener('click', () => download('action-log.json', {
    window_ms: engine.getConfig().window_ms,
    actions: engine.actionLog(),
  }));
  $('#btn-export-events').addEventListener('click', () => {
    const events = mode === 'live' ? recordedEvents : replayEvents;
    download('input-events.json', { events });
  });

  $('#filter-hide-input').addEventListener('change', applyStreamFilter);
  $('#btn-close-export').addEventListener('click', () => $('#panel-export').classList.add('hidden'));
  $('#btn-copy-export').addEventListener('click', () => {
    const ta = $('#export-output');
    const fallback = () => { ta.select(); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(() => {
        $('#export-label').textContent += ' ✓ 已复制';
      }).catch(fallback);
    } else fallback();
  });
}

init();
