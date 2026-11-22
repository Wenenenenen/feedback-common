// 关卡协程调试台 —— 主控制器
//
// 分工：
//   vm.js  纯解释器（调度、单步、断点、快照），浏览器与 Node 共用
//   app.js 视图与交互：虚拟列表、断点、快照自检、性能基准、导出/导入
import {
  compileProgram, VM, ImportError, LIMITS, STATUS, describeInstruction,
} from './vm.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 状态

const ui = {
  prog: null,
  vm: null,
  breakpoints: new Set(),
  cursor: null,           // 上一次断点/单步停下位置 { fiber, pc }
  selectedFiber: 0,
  lastFrame: 0,
  lastOutputLen: 0,
  lastSlots: null,
  running: false,
  pauseRequested: false,
  rafHandle: 0,
  autoScroll: true,
  eventAll: true,
  eventVisible: [],
  _continueIgnore: null,
};

const FIBER_COLORS = [
  '#4cc2ff', '#7ee787', '#ffb454', '#ff8bd0', '#b392f0', '#5fd7d7',
  '#f7d154', '#ff9d6b', '#9aa7ff', '#7be0a7', '#e39bff', '#6bd0ff',
];

function fiberColor(id) {
  return FIBER_COLORS[id % FIBER_COLORS.length];
}

// ------------------------------------------------------------------ 工具

function toast(text, ms = 1900) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function showDialog(title, bodyHtml) {
  $('msgTitle').textContent = title;
  $('msgBody').innerHTML = bodyHtml;
  const dlg = $('msgDialog');
  if (!dlg.open) dlg.showModal();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatInt(n) {
  return Number(n).toLocaleString('en-US');
}

// ------------------------------------------------------------------ 虚拟列表

/**
 * 极简虚拟列表：只渲染视口内的行。
 * render(rowIndex, el) 负责填充单个行元素。
 */
class VirtualList {
  constructor(container, rowH, render) {
    this.container = container;
    this.rowH = rowH;
    this.render = render;
    this.count = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'vspacer';
    this.win = document.createElement('div');
    this.win.className = 'vwin';
    this.spacer.appendChild(this.win);
    container.replaceChildren(this.spacer);
    this.rows = [];
    this.overscan = 6;
    container.addEventListener('scroll', () => this.paint(), { passive: true });
    this._ro = new ResizeObserver(() => this.paint());
    this._ro.observe(container);
  }

  setCount(n) {
    if (n === this.count) return;
    this.count = n;
    this.spacer.style.height = `${n * this.rowH}px`;
    const view = Math.ceil(this.container.clientHeight / this.rowH);
    const need = Math.max(0, Math.min(n, view + this.overscan * 2));
    if (this.win.childElementCount > need) {
      while (this.win.childElementCount > need) this.win.lastElementChild.remove();
      this.rows = Array.from(this.win.children);
    } else {
      while (this.win.childElementCount < need) {
        const el = document.createElement('div');
        this.win.appendChild(el);
        this.rows.push(el);
      }
    }
    this.paint();
  }

  paint() {
    const top = this.container.scrollTop;
    const h = this.container.clientHeight;
    const first = Math.max(0, Math.floor(top / this.rowH) - this.overscan);
    const visible = Math.ceil(h / this.rowH) + this.overscan * 2;
    const last = Math.min(this.count, first + visible);
    if (last - first > this.rows.length) this.setCount(this.count);
    this.win.style.transform = `translateY(${first * this.rowH}px)`;
    for (let i = first; i < last; i++) {
      const el = this.rows[i - first];
      if (!el) break;
      if (el._index !== i || el._dirty) {
        el._index = i;
        el._dirty = false;
        this.render(i, el);
      }
    }
    // 隐藏多余行，避免旧内容残留在视口外
    for (let i = last - first; i < this.rows.length; i++) {
      this.rows[i].style.display = 'none';
    }
    for (let i = 0; i < last - first; i++) {
      if (this.rows[i]) this.rows[i].style.display = '';
    }
  }

  markDirty() {
    for (const el of this.rows) el._dirty = true;
    this.paint();
  }

  scrollToIndex(index) {
    const top = index * this.rowH;
    const h = this.container.clientHeight;
    const cur = this.container.scrollTop;
    if (top < cur + this.rowH) this.container.scrollTop = Math.max(0, top - this.rowH * 2);
    else if (top + this.rowH > cur + h - this.rowH) this.container.scrollTop = top - h + this.rowH * 3;
  }

  isVisible(index) {
    const top = this.container.scrollTop;
    const h = this.container.clientHeight;
    const y = index * this.rowH;
    return y >= top && y + this.rowH <= top + h;
  }
}

// ------------------------------------------------------------------ 代码视图

const codeList = new VirtualList($('codeList'), 24, renderCodeRow);
const logList = new VirtualList($('logList'), 22, renderLogRow);
const eventList = new VirtualList($('eventList'), 22, renderEventRow);

// 事件面板可见行：由帧过滤决定。ui.eventVisible 是源的索引数组。
function rebuildEventView() {
  const vm = ui.vm;
  if (!vm) { ui.eventVisible = []; eventList.setCount(0); return; }
  const prog = ui.prog;
  const cur = vm.frame;
  const vis = [];
  for (let i = 0; i < prog.source.events.length; i++) {
    const f = prog.source.events[i][0];
    if (!ui.eventAll && (f < cur - 2 || f > cur + 5)) continue;
    vis.push(i);
  }
  ui.eventVisible = vis;
  eventList.setCount(vis.length);
  eventList.markDirty();
}

function renderEventRow(i, el) {
  const srcIdx = ui.eventVisible?.[i];
  if (srcIdx == null) { el.textContent = ''; return; }
  const [f, name, value] = ui.prog.source.events[srcIdx];
  const cur = ui.vm.frame;
  const delivered = lastFrameTrace()?.deliveredIndexes?.includes(srcIdx);
  const cls = f === cur ? 'now' : f < cur ? '' : 'future';
  el.className = `event-row ${cls}${delivered ? ' delivered' : ''}`;
  el.innerHTML = `<span class="ef">f${f}</span>`
    + `<span class="en">${escapeHtml(name)}</span><span class="ev">${value}</span>`;
}

function renderCodeRow(i, el) {
  const prog = ui.prog;
  if (!prog || i >= prog.n) { el.textContent = ''; return; }
  const ins = prog.source.code[i];
  const name = ins[0];
  const hasBp = ui.breakpoints.has(i);
  el.className = 'code-row' + (hasBp ? ' has-bp' : '');

  const vm = ui.vm;
  const st = vm ? vm.state : null;
  let current = null;
  let faultHere = false;
  if (st) {
    for (const f of st.fibers) {
      if (f.status === STATUS.READY && f.pc === i) { current = f; break; }
    }
    for (const fault of st.faults) {
      if (fault.pc === i) { faultHere = true; break; }
    }
  }
  if (current) el.classList.add('current');
  if (faultHere) el.classList.add('at-fault');

  let opHtml;
  if (name === 'WAIT' || name === 'EMIT') {
    opHtml = `<span class="mnemonic">${name}</span> <span class="name">${escapeHtml(ins[1])}</span>`;
  } else if (name === 'JNZ' || name === 'CALL' || name === 'FORK') {
    opHtml = `<span class="mnemonic">${name}</span> <span class="operand">#${ins[1]}</span>`;
  } else if (name === 'LOAD' || name === 'STORE') {
    opHtml = `<span class="mnemonic">${name}</span> <span class="operand">s${ins[1]}</span>`;
  } else if (ins.length > 1) {
    opHtml = `<span class="mnemonic">${name}</span> <span class="operand">${ins[1]}</span>`;
  } else {
    opHtml = `<span class="mnemonic">${name}</span>`;
  }

  let marks = '';
  if (st) {
    for (const f of st.fibers) {
      if ((f.status === STATUS.READY || f.status === STATUS.WAITING || f.status === STATUS.SLEEPING) && f.pc === i) {
        marks += `<span class="fiber-mark" style="--fc:${fiberColor(f.id)}" title="协程 ${f.id}"></span>`;
      }
    }
  }

  el.innerHTML = `<span class="bp" data-pc="${i}"></span>`
    + `<span class="pc">${i}</span>`
    + `<span class="op">${opHtml}</span>`
    + `<span class="marks">${marks}</span>`;
}

function renderLogRow(i, el) {
  const outputs = ui.vm ? ui.vm.outputs : [];
  if (i >= outputs.length) { el.textContent = ''; return; }
  const [f, fid, name, value] = outputs[i];
  el.className = 'log-row';
  el.innerHTML = `<span class="lf">f${f}</span>`
    + `<span class="lfib" style="--fc:${fiberColor(fid)}">c${fid}</span>`
    + `<span class="ln">${escapeHtml(name)}</span>`
    + `<span class="lv">${value}</span>`;
}

// ------------------------------------------------------------------ 渲染

function renderAll({ frameChanged = false } = {}) {
  const vm = ui.vm;
  const hasProg = !!ui.prog;

  $('codeEmpty').hidden = hasProg;
  codeList.container.hidden = !hasProg;
  if (hasProg) {
    codeList.setCount(ui.prog.n);
    codeList.markDirty();
    $('codeMeta').textContent = `${ui.prog.n} 条 · ${ui.prog.events.count} 事件`;
    // 滚动到当前指令
    const cur = currentInstruction();
    if (cur != null && !codeList.isVisible(cur)) codeList.scrollToIndex(cur);
  } else {
    $('codeMeta').textContent = '—';
  }

  renderFibers();
  renderSlots({ frameChanged });
  renderEvents();
  renderFaults();
  renderLog({ frameChanged });
  renderStatus();
  updateButtons();
}

function currentInstruction() {
  const vm = ui.vm;
  if (!vm || vm.halted) return null;
  const peek = vm.peek();
  if (peek.kind === 'instr') return peek.pc;
  return null;
}

let fiberDomKey = '';

function renderFibers() {
  const vm = ui.vm;
  const box = $('fibersList');
  if (!vm) { box.innerHTML = '<div class="log-empty">尚未载入</div>'; $('fiberMeta').textContent = '—'; return; }
  const st = vm.state;
  const fibers = st.fibers;
  $('fiberMeta').textContent = `${st.liveCount} 存活 / 共 ${st.nextId} · 已完成 ${st.finished}`;
  if (fibers.length === 0) { box.innerHTML = '<div class="log-empty">无协程</div>'; return; }

  const rows = [];
  for (const f of fibers) {
    const color = fiberColor(f.id);
    let stLabel = f.status;
    let extra = '';
    if (f.status === STATUS.WAITING) extra = `等 ${f.waitName}`;
    else if (f.status === STATUS.SLEEPING) extra = `唤醒于 f${f.wakeFrame}`;
    else if (f.status === STATUS.NEW) extra = `f${f.startFrame} 开始`;
    else if (f.status === STATUS.READY) extra = `本帧 ${f.used}/${LIMITS.PER_FRAME}`;
    else if (f.status === STATUS.FAILED) extra = st.faults.filter((x) => x.fiber === f.id).slice(-1)[0]?.message || '';
    const stClass = f.status;
    const sel = ui.selectedFiber === f.id ? ' selected' : '';
    const pcLabel = f.status === STATUS.DONE || f.status === STATUS.FAILED ? '—' : `#${f.pc}`;
    rows.push(`<div class="fiber-row${sel}" data-fid="${f.id}" style="--fc:${color}">`
      + `<span class="fid"><span class="fiber-dot"></span>${f.id}</span>`
      + `<span class="pc">${pcLabel}</span>`
      + `<span class="st ${stClass}">${stLabelLabel(stLabel)}</span>`
      + `<span class="depth" title="操作数栈/调用栈">${f.stack.length}/${f.calls.length}</span>`
      + `<span class="depth" title="本帧已用指令">${f.used}</span>`
      + `<span class="extra" title="${escapeHtml(extra)}">${escapeHtml(extra)}</span>`
      + '</div>');
  }
  box.innerHTML = rows.join('');
  renderFiberDetail();
}

function renderFiberDetail() {
  const box = $('fiberDetail');
  const vm = ui.vm;
  if (!vm || ui.selectedFiber === null) { box.hidden = true; return; }
  const f = vm.state.fibers.find((x) => x.id === ui.selectedFiber);
  if (!f) { box.hidden = true; return; }
  box.hidden = false;
  const color = fiberColor(f.id);
  const pcText = f.status === STATUS.DONE || f.status === STATUS.FAILED
    ? '—' : `#${f.pc} ${describeInstruction(vm.prog, f.pc) || ''}`;
  const stackItems = f.stack.map((v) => `<span class="sv">${v}</span>`).join('')
    || '<span class="sv dim">空</span>';
  const callItems = f.calls.map((v) => `<span class="sv">#${v}</span>`).join('')
    || '<span class="sv dim">空</span>';
  let extra = '';
  if (f.status === STATUS.WAITING) extra = `等待事件 <b>${escapeHtml(f.waitName)}</b>（WAIT 在指令 ${f.waitPc}）`;
  else if (f.status === STATUS.SLEEPING) extra = `休眠到帧 <b>${f.wakeFrame}</b>`;
  else if (f.status === STATUS.NEW) extra = `帧 <b>${f.startFrame}</b> 开始`;
  else if (f.status === STATUS.READY) extra = `本帧已用 <b>${f.used}</b> / ${LIMITS.PER_FRAME} 条`;
  else if (f.status === STATUS.FAILED) {
    const fault = [...vm.faults].reverse().find((x) => x.fiber === f.id);
    extra = fault ? `帧 ${fault.frame} 指令 ${fault.pc}：${escapeHtml(fault.message)}` : '已出错';
  } else if (f.status === STATUS.DONE) extra = '已结束';
  box.innerHTML = `<div class="fd-head"><span class="fiber-dot" style="--fc:${color}"></span>`
    + `<b>协程 ${f.id}</b><span>· ${stLabelLabel(f.status)}</span><span style="flex:1"></span>`
    + `<button class="ghost" id="fdClose" style="padding:1px 7px;font-size:11px">收起</button></div>`
    + `<div class="fd-grid">`
    + `<span class="fd-k">PC</span><span class="fd-v">${pcText}</span>`
    + `<span class="fd-k">状态</span><span class="fd-v">${extra}</span>`
    + `<span class="fd-k">操作数栈 (${f.stack.length}/${LIMITS.STACK})</span>`
    + `<span class="fd-v"><span class="stack-line">${stackItems}</span></span>`
    + `<span class="fd-k">调用栈 (${f.calls.length}/${LIMITS.CALL_DEPTH})</span>`
    + `<span class="fd-v"><span class="stack-line">${callItems}</span></span>`
    + '</div>';
  $('fdClose').addEventListener('click', () => { ui.selectedFiber = null; renderFibers(); });
}

function stLabelLabel(st) {
  return ({ ready: '可运行', waiting: '等待', sleeping: '休眠', new: '待开始', done: '结束', failed: '错误' })[st] || st;
}

function renderSlots({ frameChanged } = {}) {
  const vm = ui.vm;
  const box = $('slots');
  if (!vm) {
    box.innerHTML = '';
    return;
  }
  const slots = vm.state.slots;
  const prev = ui.lastSlots;
  let html = '';
  for (let i = 0; i < LIMITS.SLOTS; i++) {
    const v = slots[i];
    const changed = prev && prev[i] !== v;
    html += `<div class="slot${changed ? ' changed' : ''}${v === 0 ? ' zero' : ''}" data-slot="${i}">`
      + `<span class="k">s${i}</span><span class="v">${v}</span></div>`;
  }
  box.innerHTML = html;
  ui.lastSlots = Int32Array.from(slots);
}

function renderEvents() {
  const vm = ui.vm;
  if (!vm) { $('eventMeta').textContent = '0'; eventList.setCount(0); return; }
  rebuildEventView();
  $('eventMeta').textContent = `${ui.prog.source.events.length} 条`
    + (ui.eventAll ? '' : ` · 显示 ${ui.eventVisible.length}`);
}

function lastFrameTrace() {
  return ui.vm?._lastFrameTrace || null;
}

function renderFaults() {
  const vm = ui.vm;
  const box = $('faultList');
  if (!vm) { box.innerHTML = '<div class="fault-empty">—</div>'; $('faultMeta').textContent = '0'; return; }
  const faults = vm.faults;
  $('faultMeta').textContent = `${faults.length}`;
  if (!faults.length) { box.innerHTML = '<div class="fault-empty">无运行错误</div>'; return; }
  box.innerHTML = faults.slice(-200).map((x) => {
    const label = x.kind === 'stack' ? '栈' : x.kind === 'fiber' ? '协程数' : x.kind === 'exit' ? '越界' : x.kind;
    return `<div class="fault-row"><span class="where">帧 ${x.frame} · 协程 ${x.fiber} · 指令 ${x.pc}</span>`
      + `<span class="msg">[${label}] ${escapeHtml(x.message)}</span></div>`;
  }).join('');
}

function renderLog({ frameChanged } = {}) {
  const vm = ui.vm;
  const outputs = vm ? vm.outputs : [];
  $('logEmpty').hidden = outputs.length > 0;
  $('logMeta').textContent = `${formatInt(outputs.length)} 条`;
  logList.setCount(outputs.length);
  logList.markDirty();
  if (ui.autoScroll && outputs.length !== ui.lastOutputLen) {
    logList.container.scrollTop = logList.container.scrollHeight;
  }
  ui.lastOutputLen = outputs.length;
}

function renderStatus() {
  const vm = ui.vm;
  if (!vm) {
    $('statusFrame').textContent = '0';
    $('statusPhase').textContent = '—';
    $('statusInstr').textContent = '0';
    $('statusCore').textContent = '就绪';
    return;
  }
  const st = vm.state;
  $('statusFrame').textContent = String(st.frame);
  const phase = st.phase === 'frame' ? '帧首（待广播）' : '帧中';
  $('statusPhase').textContent = phase;
  $('statusInstr').textContent = formatInt(st.totalInstr);
  let core;
  if (st.halted) {
    core = ({
      empty: '已结束', frames: '帧数用尽', deadlock: '死锁停止',
    })[st.stopReason] || '已停止';
  } else if (ui.pauseRequested) core = '已暂停';
  else if (ui.running) core = '运行中';
  else core = '已暂停';
  $('statusCore').textContent = core;
}

function updateButtons() {
  const vm = ui.vm;
  const active = !!vm && !vm.halted;
  $('btnRun').disabled = !vm || vm.halted || ui.running;
  $('btnPause').disabled = !ui.running;
  $('btnContinue').disabled = !vm || vm.halted || ui.running;
  $('btnStep').disabled = !vm || vm.halted || ui.running;
  $('btnFrame').disabled = !vm || vm.halted || ui.running;
  $('btnReset').disabled = !vm;
  $('btnSnapExport').disabled = !vm;
  $('btnSnapImport')?.toggleAttribute('disabled');
}

// ------------------------------------------------------------------ 载入 / 复位

function setProgram(obj, { fromSnapshot = false, vm = null, title = '' } = {}) {
  const prog = fromSnapshot ? vm.prog : compileProgram(obj);
  ui.prog = prog;
  ui.vm = vm || new VM(prog);
  ui.breakpoints = new Set();
  ui.cursor = null;
  ui.selectedFiber = 0;
  ui.lastSlots = null;
  ui.lastOutputLen = 0;
  ui.running = false;
  ui.pauseRequested = false;
  stopLoop();
  if (title) toast(`已载入 ${title}`);
  renderAll({ frameChanged: true });
  // 首帧广播在“运行/单步”时执行，这里保持 phase=frame 以便逐帧观察
  const cur = ui.vm.peek();
  if (cur.kind === 'instr') codeList.scrollToIndex(cur.pc);
}

function loadFromObject(obj, label) {
  try {
    const prog = compileProgram(obj);
    setProgram(obj, { title: label || '关卡脚本' });
    // 若 title 里带用例说明，显示在代码面板
    return true;
  } catch (e) {
    showImportError(e);
    return false;
  }
}

function showImportError(e) {
  if (e instanceof ImportError) {
    const where = e.pc >= 0 ? `指令 ${e.pc}` : '全局';
    showDialog('导入被拒绝', `<div class="err-box">`
      + `<div class="err-title">关卡脚本未通过校验</div>`
      + `<div class="err-loc">位置：<code>${where}</code> · 类别：<code>${escapeHtml(e.kind)}</code></div>`
      + `<div style="margin-top:8px">${escapeHtml(e.message)}</div>`
      + '</div>');
  } else {
    showDialog('导入失败', `<div class="err-box"><div class="err-title">无法解析 JSON</div>`
      + `<div>${escapeHtml(e.message || String(e))}</div></div>`);
  }
}

// ------------------------------------------------------------------ 执行控制

function stopLoop() {
  if (ui.rafHandle) cancelAnimationFrame(ui.rafHandle);
  ui.rafHandle = 0;
}

function ensureRunningLoop() {
  if (ui.rafHandle) return;
  const tick = () => {
    ui.rafHandle = 0;
    if (!ui.running) return;
    if (ui.vm.halted) { finishRun('已结束'); return; }
    if (ui.pauseRequested) { ui.pauseRequested = false; ui.running = false; renderAll(); return; }

    const t0 = performance.now();
    // 每帧最多运行这么多条指令，保持界面响应；剩余用下一帧继续
    const budget = 200000;
    const beforeInstr = ui.vm.state.totalInstr;
    const ignore = ui._continueIgnore || null;
    ui._continueIgnore = null;
    const r = ui.vm.run(ui.breakpoints, budget, ignore);
    const progressed = ui.vm.state.totalInstr - beforeInstr;
    void t0;
    if (r.reason === 'breakpoint') {
      ui.running = false;
      ui.cursor = { fiber: r.fiber, pc: r.pc };
      ui.lastFrame = ui.vm.frame;
      renderAll({ frameChanged: true });
      toast(`断点：帧 ${ui.vm.frame} · 协程 ${r.fiber} · 指令 ${r.pc}`);
      return;
    }
    renderAll({ frameChanged: ui.vm.frame !== ui.lastFrame });
    ui.lastFrame = ui.vm.frame;
    if (r.reason === 'halted') { finishRun(); return; }
    if (progressed === 0) {
      // 没有推进（例如长时间全等待），让出一次事件循环
      setTimeout(() => { if (ui.running) ensureRunningLoop(); }, 8);
      return;
    }
    ui.rafHandle = requestAnimationFrame(tick);
  };
  ui.rafHandle = requestAnimationFrame(tick);
}

function finishRun(reason) {
  ui.running = false;
  ui.pauseRequested = false;
  stopLoop();
  renderAll({ frameChanged: true });
  const vm = ui.vm;
  if (!vm) return;
  const label = ({
    empty: '全部协程已结束',
    frames: '到达 frames 上限',
    deadlock: '死锁停止（无后续事件）',
  })[vm.state.stopReason] || (reason || '已停止');
  $('statusCore').textContent = label;
}

/** 若当前正停在某个断点位置，返回该位置供 run() 忽略一次，避免“运行/继续”原地重停。 */
function breakpointStopIgnore() {
  const vm = ui.vm;
  if (!vm || vm.halted) return null;
  const peek = vm.peek();
  if (peek.kind !== 'instr') return null;
  if (!ui.breakpoints.has(peek.pc)) return null;
  return { fiber: peek.fiber, pc: peek.pc };
}

function doRun() {
  if (!ui.vm || ui.vm.halted || ui.running) return;
  ui.running = true;
  ui.pauseRequested = false;
  ui._continueIgnore = breakpointStopIgnore();
  updateButtons();
  renderStatus();
  ensureRunningLoop();
}

function doPause() {
  if (!ui.running) return;
  ui.pauseRequested = true;
}

function doContinue() {
  if (!ui.vm || ui.vm.halted) return;
  ui.running = true;
  ui.pauseRequested = false;
  ui.cursor = null;
  ui._continueIgnore = breakpointStopIgnore();
  updateButtons();
  renderStatus();
  ensureRunningLoop();
}

function doStep() {
  if (!ui.vm || ui.vm.halted) return;
  const vm = ui.vm;
  ui._continueIgnore = null;
  const res = vm.stepInstruction();
  ui.cursor = res.kind === 'instr' ? { fiber: res.fiber, pc: res.pc } : null;
  renderAll({ frameChanged: vm.frame !== ui.lastFrame });
  ui.lastFrame = vm.frame;
  if (vm.halted) finishRun();
}

function doFrame() {
  if (!ui.vm || ui.vm.halted) return;
  const vm = ui.vm;
  const r = vm.stepFrame();
  renderAll({ frameChanged: true });
  ui.lastFrame = vm.frame;
  if (r.kind === 'halted' || vm.halted) finishRun();
}

function doReset() {
  if (!ui.prog) return;
  ui.vm = new VM(ui.prog);
  ui.cursor = null;
  ui.selectedFiber = 0;
  ui.lastSlots = null;
  ui.lastOutputLen = 0;
  ui.running = false;
  ui.pauseRequested = false;
  stopLoop();
  renderAll({ frameChanged: true });
  toast('已复位到 frame 0');
}

// ------------------------------------------------------------------ 断点

$('codeList').addEventListener('click', (ev) => {
  const bp = ev.target.closest('.bp');
  if (!bp) return;
  const pc = Number(bp.dataset.pc);
  if (ui.breakpoints.has(pc)) ui.breakpoints.delete(pc);
  else ui.breakpoints.add(pc);
  codeList.markDirty();
});

// ------------------------------------------------------------------ 快照

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSnapshot() {
  if (!ui.vm) return;
  const snap = ui.vm.snapshot();
  const text = JSON.stringify(snap);
  download(`fiber-snapshot-f${snap.state.frame}.json`, text);
  toast(`已导出快照：帧 ${snap.state.frame} · 阶段 ${snap.state.phase}`);
}

function importSnapshot(text) {
  let snap;
  try {
    snap = JSON.parse(text);
  } catch (e) {
    showDialog('快照载入失败', `<div class="err-box"><div>不是合法 JSON：${escapeHtml(e.message)}</div></div>`);
    return;
  }
  try {
    const vm = VM.fromSnapshot(snap);
    setProgram(null, { fromSnapshot: true, vm });
    toast(`已恢复快照：帧 ${vm.frame} · ${vm.state.phase === 'frame' ? '帧首' : '帧中'}`);
  } catch (e) {
    if (e instanceof ImportError) {
      showDialog('快照载入失败', `<div class="err-box"><div class="err-title">快照不合法</div>`
        + `<div class="err-loc">${e.pc >= 0 ? `位置：指令 ${e.pc}` : ''}</div>`
        + `<div style="margin-top:8px">${escapeHtml(e.message)}</div></div>`);
    } else {
      showDialog('快照载入失败', `<div class="err-box"><div>${escapeHtml(e.message || String(e))}</div></div>`);
    }
  }
}

// ------------------------------------------------------------------ 快照自检

/**
 * 在当前程序的若干指令切点导出快照、恢复后续跑，比较输出日志是否逐条相同。
 * 切点包含帧首、帧中、跨帧等位置。
 */
function runSelfCheck() {
  if (!ui.vm) { toast('请先载入关卡脚本'); return; }
  const prog = ui.prog;

  // 参考运行：完整执行
  const ref = new VM(prog);
  const refRun = ref.run();
  const refOut = JSON.stringify(ref.outputs);
  const refFaults = JSON.stringify(ref.faults.map((f) => [f.frame, f.fiber, f.pc, f.kind]));
  const refSlots = JSON.stringify(Array.from(ref.state.slots));
  const total = refRun.executed;

  // 选择切点：总指令数内均匀取样，并额外包含当前帧位置
  const cuts = new Set([0, total]);
  if (total <= 600) {
    for (let i = 0; i <= total; i++) cuts.add(i);
  } else {
    const step = Math.max(1, Math.floor(total / 300));
    for (let i = 0; i <= total; i += step) cuts.add(i);
  }
  // 当前 vm 所在位置
  cuts.add(total - countRemaining(prog));

  const rows = [];
  let mismatches = 0;
  let checked = 0;
  const sorted = [...cuts].sort((a, b) => a - b);
  for (const cut of sorted) {
    if (cut < 0 || cut > total) continue;
    const a = new VM(prog);
    a.run(null, cut);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    let b;
    try {
      b = VM.fromSnapshot(snap);
      b.run();
    } catch (e) {
      mismatches++;
      rows.push({ cut, ok: false, why: `恢复失败：${e.message}` });
      continue;
    }
    const okOut = JSON.stringify(b.outputs) === refOut;
    const okFaults = JSON.stringify(b.faults.map((f) => [f.frame, f.fiber, f.pc, f.kind])) === refFaults;
    const okSlots = JSON.stringify(Array.from(b.state.slots)) === refSlots;
    checked++;
    const ok = okOut && okFaults && okSlots;
    if (!ok) mismatches++;
    if (!ok || cut === sorted[0] || cut === sorted[sorted.length - 1]) {
      rows.push({
        cut, ok,
        why: ok ? '一致' : `输出${okOut ? '' : '✗'} 错误${okFaults ? '' : '✗'} 槽${okSlots ? '' : '✗'}`,
        frame: snap.state.frame, phase: snap.state.phase,
      });
    }
  }

  const sampleRows = rows.slice(0, 24).map((r) => `<tr>`
    + `<td>${r.cut}</td><td>${r.frame ?? '—'}</td><td>${r.phase === 'frame' ? '帧首' : r.phase === 'run' ? '帧中' : '—'}</td>`
    + `<td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ 一致' : '✗ ' + escapeHtml(r.why)}</td></tr>`).join('');

  showDialog('快照续跑自检', `
    <p class="hint" style="margin-top:0">在 ${sorted.length} 个指令切点导出快照 → 恢复 → 续跑，
    逐一比较输出日志、运行错误与共享槽。切点覆盖帧首、帧中与跨帧边界。</p>
    <div class="bench-grid" style="margin:12px 0 14px">
      <span class="k">参考执行</span><span class="v">${formatInt(total)} 条指令 · ${formatInt(ref.outputs.length)} 条输出 · 停止原因 ${escapeHtml(ref.state.stopReason || '—')}</span>
      <span class="k">检查切点</span><span class="v">${checked} / ${sorted.length}</span>
      <span class="k">不一致</span><span class="v" style="color:${mismatches ? 'var(--danger)' : 'var(--accent-2)'}">${mismatches}</span>
    </div>
    <table class="check-table">
      <thead><tr><th>切点（已执行指令）</th><th>帧</th><th>阶段</th><th>续跑结果</th></tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>
    <div class="bench-verdict ${mismatches ? 'fail' : 'pass'}">
      ${mismatches ? `存在 ${mismatches} 个切点续跑不一致` : '全部切点续跑输出逐条相同'}
    </div>
  `);
}

function countRemaining(prog) {
  // 粗略估计：完整再跑一遍到停止，返回与当前已执行数的差
  const probe = new VM(prog);
  const r = probe.run();
  return r.executed - ui.vm.state.totalInstr;
}

// ------------------------------------------------------------------ 对照 Python

/**
 * 把当前脚本交给服务端 Python 独立实现重算，对照浏览器内 JS 的完整运行结果。
 * 无服务（静态托管）时给出提示。
 */
async function runCrossCheck() {
  if (!ui.prog) { toast('请先载入关卡脚本'); return; }
  const program = ui.prog.source;
  let resp;
  try {
    resp = await fetch('/api/reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program }),
    });
  } catch {
    showDialog('对照 Python', '<p class="hint" style="margin:0">需要本地服务（<code>./scripts/start.sh</code>）才能调用 Python 参考实现。</p>');
    return;
  }
  if (!resp.ok) {
    showDialog('对照 Python', `<div class="err-box"><div>服务返回 ${resp.status}</div></div>`);
    return;
  }
  const data = await resp.json();
  if (!data.ok) {
    showDialog('对照 Python', `<div class="err-box"><div class="err-title">Python 拒绝该脚本</div>`
      + `<div class="err-loc">位置：${data.importError?.pc >= 0 ? `指令 ${data.importError.pc}` : '全局'}</div>`
      + `<div style="margin-top:6px">${escapeHtml(data.importError?.error || data.error || '')}</div></div>`);
    return;
  }
  const py = data.result;

  // JS 侧重跑一次（不改动当前调试状态）
  const js = new VM(ui.prog);
  js.run();
  const jsOut = JSON.stringify(js.outputs);
  const pyOut = JSON.stringify(py.outputs);
  const jsSlots = JSON.stringify(Array.from(js.state.slots));
  const pySlots = JSON.stringify(py.slots);
  const jsFaults = JSON.stringify(js.faults.map((f) => [f.frame, f.fiber, f.pc, f.kind]));
  const pyFaults = JSON.stringify(py.faults.map((f) => [f.frame, f.fiber, f.pc, f.kind]));

  const rows = [
    ['输出日志', js.outputs.length, py.outputs.length, jsOut === pyOut],
    ['共享槽', 32, 32, jsSlots === pySlots],
    ['运行错误', js.faults.length, py.faults.length, jsFaults === pyFaults],
    ['最终帧号', js.frame, py.finalFrame, js.frame === py.finalFrame],
    ['停止原因', stopLabel(js.state.stopReason), stopLabel(py.stopReason), js.state.stopReason === py.stopReason],
    ['指令总数', js.state.totalInstr, py.totalInstr, js.state.totalInstr === py.totalInstr],
  ];
  const allOk = rows.every((r) => r[3]);
  showDialog('对照 Python 参考实现', `
    <p class="hint" style="margin-top:0">同一份脚本分别由浏览器内 JS 解释器与 <code>src/py/lfv_ref.py</code>
    独立实现完整执行，逐项比较。</p>
    <table class="check-table">
      <thead><tr><th>项目</th><th>JS</th><th>Python</th><th>结果</th></tr></thead>
      <tbody>${rows.map(([k, a, b, ok]) => `<tr><td>${k}</td><td>${typeof a === 'number' ? formatInt(a) : a}</td>`
        + `<td>${typeof b === 'number' ? formatInt(b) : b}</td>`
        + `<td class="${ok ? 'ok' : 'bad'}">${ok ? '✓ 一致' : '✗ 不同'}</td></tr>`).join('')}</tbody>
    </table>
    <div class="bench-verdict ${allOk ? 'pass' : 'fail'}">${allOk ? '两份实现逐项一致' : '存在不一致，请检查'}</div>
  `);
}

function stopLabel(reason) {
  return ({
    empty: '协程全部结束', frames: '帧数用尽', deadlock: '死锁',
  })[reason] || (reason == null ? '—' : String(reason));
}

// ------------------------------------------------------------------ 性能基准

function runBenchmark() {
  // 单协程 ≥100 万条指令 + 快照导出，要求 8 秒内完成。
  // 两档：① 纯计算（每帧 256 条配额，跨帧推进）；② 每条循环都 EMIT（日志压力）。
  const N = 125000;
  const compute = [
    ['PUSH', 1], ['LOAD', 0], ['ADD'], ['STORE', 0],
    ['PUSH', -N], ['LOAD', 0], ['ADD'], ['JNZ', 0],
    ['LOAD', 0], ['EMIT', 'done'], ['HALT'],
  ];
  const M = 125000; // 每轮 8 条，250k EMIT 左右
  const emitting = [
    ['PUSH', 1], ['EMIT', 'tick'], ['PUSH', 1], ['LOAD', 0], ['ADD'], ['STORE', 0],
    ['PUSH', -M], ['LOAD', 0], ['ADD'], ['JNZ', 0],
    ['LOAD', 0], ['EMIT', 'done'], ['HALT'],
  ];

  const measure = (code) => {
    const prog = compileProgram({ code });
    const vm = new VM(prog);
    const t0 = performance.now();
    vm.run();
    const t1 = performance.now();
    const snap = vm.snapshot();
    const json = JSON.stringify(snap);
    const t2 = performance.now();
    return {
      instr: vm.state.totalInstr, outputs: vm.outputs.length, bytes: json.length,
      frames: vm.frame, slot0: vm.state.slots[0], stop: vm.state.stopReason,
      execMs: t1 - t0, snapMs: t2 - t1, totalMs: t2 - t0,
    };
  };

  const a = measure(compute);
  const b = measure(emitting);
  const pass = a.totalMs < 8000 && a.instr >= 1000000 && b.totalMs < 8000 && b.instr >= 1000000;

  const row = (label, r) => `<span class="k">${label}</span><span class="v">`
    + `${formatInt(r.instr)} 条指令 · ${r.frames} 帧 · ${formatInt(r.outputs)} 条日志 · `
    + `快照 ${(r.bytes / 1024).toFixed(0)} KB · 合计 ${r.totalMs.toFixed(1)} ms</span>`;

  showDialog('性能基准', `
    <p class="hint" style="margin-top:0">单协程连续执行 ≥100 万条指令（每帧 256 条配额，跨帧推进），
    随后导出并序列化快照。目标：4 核 8 GB 环境 8 秒内完成。</p>
    <div class="bench-grid" style="margin:12px 0 16px">
      ${row('纯计算', a)}
      ${row('带 25 万次 EMIT', b)}
      <span class="k">纯计算明细</span><span class="v">执行 ${a.execMs.toFixed(1)} ms · 快照 ${a.snapMs.toFixed(1)} ms · 槽 0=${a.slot0}</span>
      <span class="k">带日志明细</span><span class="v">执行 ${b.execMs.toFixed(1)} ms · 快照 ${b.snapMs.toFixed(1)} ms · 槽 0=${b.slot0}</span>
    </div>
    <div class="bench-verdict ${pass ? 'pass' : 'fail'}">
      ${pass ? `通过：两档均 ≥100 万条指令且合计 < 8000 ms（最慢 ${Math.max(a.totalMs, b.totalMs).toFixed(0)} ms）`
        : `未达标：最慢合计 ${Math.max(a.totalMs, b.totalMs).toFixed(0)} ms`}
    </div>
  `);
}

// ------------------------------------------------------------------ 导入 / 样例

async function loadSampleList() {
  const sel = $('sampleSelect');
  try {
    const r = await fetch('/api/samples');
    if (!r.ok) throw new Error('no api');
    const data = await r.json();
    const groups = { samples: '样例', cases: '用例', 'cases/invalid': '应被拒绝' };
    const byGroup = new Map();
    for (const item of data.samples) {
      if (!byGroup.has(item.group)) byGroup.set(item.group, []);
      byGroup.get(item.group).push(item);
    }
    for (const [group, items] of byGroup) {
      const og = document.createElement('optgroup');
      og.label = groups[group] || group;
      for (const item of items) {
        const opt = document.createElement('option');
        opt.value = item.path;
        opt.textContent = item.title;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  } catch {
    // 静态托管时没有 API：回退到只提供题目自带样例
    const og = document.createElement('optgroup');
    og.label = '样例';
    const opt = document.createElement('option');
    opt.value = '../samples/level-fibers.json';
    opt.textContent = '题目样例 level-fibers.json';
    og.appendChild(opt);
    sel.appendChild(og);
  }
}

async function onSampleChange() {
  const path = $('sampleSelect').value;
  if (!path) return;
  try {
    const r = await fetch(`/samples/${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const obj = await r.json();
    const ok = loadFromObject(obj, obj._title || path);
    if (!ok) return;
    // 无效用例：立即显示拒绝
    if (obj._title && obj.expect) {
      /* 上面 loadFromObject 已捕获并弹窗 */
    }
  } catch (e) {
    toast(`载入失败：${e.message}`);
  }
}

function onFileSelected(file, kind = 'program') {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    if (kind === 'snapshot') { importSnapshot(text); return; }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      showDialog('导入失败', `<div class="err-box"><div class="err-title">不是合法 JSON</div>`
        + `<div>${escapeHtml(e.message)}</div></div>`);
      return;
    }
    // 自动识别快照
    if (obj && obj.format === 'level-fiber-snapshot') { importSnapshot(text); return; }
    loadFromObject(obj, file.name);
  };
  reader.readAsText(file);
}

// ------------------------------------------------------------------ 事件绑定

$('btnRun').addEventListener('click', doRun);
$('btnPause').addEventListener('click', doPause);
$('btnContinue').addEventListener('click', doContinue);
$('btnStep').addEventListener('click', doStep);
$('btnFrame').addEventListener('click', doFrame);
$('btnReset').addEventListener('click', doReset);
$('btnSnapExport').addEventListener('click', exportSnapshot);
$('exportLogBtn').addEventListener('click', () => {
  if (!ui.vm) return;
  download('fiber-output-log.json', JSON.stringify(ui.vm.outputs, null, 0));
});
$('snapBtn').addEventListener('click', () => $('snapInput').click());
$('snapInput').addEventListener('change', (e) => {
  onFileSelected(e.target.files[0], 'snapshot');
  e.target.value = '';
});
$('importBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  onFileSelected(e.target.files[0], 'program');
  e.target.value = '';
});
$('sampleSelect').addEventListener('change', onSampleChange);
$('selfCheckBtn').addEventListener('click', runSelfCheck);
$('crossCheckBtn').addEventListener('click', runCrossCheck);
$('benchBtn').addEventListener('click', runBenchmark);
$('eventAll').addEventListener('change', (e) => { ui.eventAll = e.target.checked; renderEvents(); });
$('autoScroll').addEventListener('change', (e) => { ui.autoScroll = e.target.checked; });

document.querySelectorAll('dialog [data-close]').forEach((b) => {
  b.addEventListener('click', () => $('msgDialog').close());
});

// 协程行选择：单击选中并显示栈详情；用详情里的“收起”隐藏
$('fibersList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.fiber-row');
  if (!row) return;
  ui.selectedFiber = Number(row.dataset.fid);
  renderFibers();
});

// 键盘快捷键
window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, select, textarea')) return;
  if (ev.key === 'F5') { ev.preventDefault(); doRun(); }
  else if (ev.key === 'F6') { ev.preventDefault(); doPause(); }
  else if (ev.key === 'F8') { ev.preventDefault(); doContinue(); }
  else if (ev.key === 'F10') { ev.preventDefault(); doStep(); }
  else if (ev.key === 'F11') { ev.preventDefault(); doFrame(); }
});

// 拖放导入
let dragDepth = 0;
window.addEventListener('dragenter', (ev) => {
  if (!ev.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (ev) => {
  if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault();
});
window.addEventListener('drop', (ev) => {
  if (!ev.dataTransfer?.files?.length) return;
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  onFileSelected(ev.dataTransfer.files[0]);
});

// 视口变化时重绘列表
window.addEventListener('resize', () => {
  codeList.markDirty();
  logList.markDirty();
  renderAll();
});

// ------------------------------------------------------------------ 启动

async function boot() {
  await loadSampleList();
  // 默认载入题目自带样例
  try {
    const r = await fetch('/samples/level-fibers.json');
    if (r.ok) {
      const obj = await r.json();
      loadFromObject(obj, 'level-fibers.json');
    }
  } catch { /* 无服务时留空 */ }
  renderAll({ frameChanged: true });
}

boot();
