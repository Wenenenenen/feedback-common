// 关卡脚本协程虚拟机 —— 自写解释器，不使用任何现成脚本虚拟机。
//
// 调度语义（逐条对应 README「调度语义」）：
//   1. 帧下标、指令下标从 0 起；共享槽 32 个、初值 0；算术为有符号 32 位回绕。
//   2. 每帧固定顺序：
//        a. 按 events 的输入顺序广播本帧事件；
//        b. 只有「帧首已处于 WAIT」的协程会被唤醒；同一协程对同名事件只收首条；
//        c. SLEEP 到期的协程恢复；
//        d. 上一帧 FORK 出的协程在本帧开始；
//        e. 按协程号升序运行。
//   3. 每协程每帧最多执行 256 条指令；WAIT / SLEEP 主动等待，跨帧继续。
//   4. FORK 按创建顺序分配递增编号，子协程空操作数栈、空调用栈，从目标指令开始。
//   5. 共享槽写入立刻对之后运行的协程可见。
//   6. 每个协程有独立的操作数栈（≤256）与调用栈（≤64）。
//   7. 运行时错误只结束出错的协程，记录 (帧号, 协程号, 指令号)。
//   8. 越界跳转等结构问题在导入时拒绝并给出指令号。
//   9. 指令断点停在执行前；单步只执行下一条指令。
//  10. 快照记录帧内调度位置（phase、每协程本帧已用指令数），
//      因此帧中任意指令边界导出、恢复后续跑，输出日志逐条一致。
//
// 纯 ES Module：浏览器与 Node 共用，零依赖。

export const LIMITS = Object.freeze({
  CODE: 8192,
  FIBERS: 64,
  EVENTS: 20000,
  SLOTS: 32,
  STACK: 256,
  CALL_DEPTH: 64,
  PER_FRAME: 256,
  MAX_FRAMES: 10_000_000,
  RETAINED_DONE: 256,
});

export const OP_NAMES = Object.freeze([
  'PUSH', 'LOAD', 'STORE', 'ADD', 'JNZ', 'CALL', 'RET',
  'FORK', 'SLEEP', 'WAIT', 'EMIT', 'HALT',
]);

const OP = Object.create(null);
OP_NAMES.forEach((name, i) => { OP[name] = i; });
export { OP };

const ARITY = new Int8Array(OP_NAMES.length).fill(1);
for (const name of ['ADD', 'RET', 'HALT']) ARITY[OP[name]] = 0;

export const STATUS = Object.freeze({
  NEW: 'new',
  READY: 'ready',
  WAITING: 'waiting',
  SLEEPING: 'sleeping',
  DONE: 'done',
  FAILED: 'failed',
});

const LIVE = new Set([STATUS.NEW, STATUS.READY, STATUS.WAITING, STATUS.SLEEPING]);

export class ImportError extends Error {
  constructor(message, pc = -1, kind = 'structure') {
    super(message);
    this.name = 'ImportError';
    this.pc = pc;
    this.kind = kind;
  }
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function checkInt32(v, what, pc) {
  if (!isInt(v)) throw new ImportError(`${what} 必须是整数`, pc, 'operand');
  if (v < -2147483648 || v > 2147483647) {
    throw new ImportError(`${what} ${v} 超出有符号 32 位范围`, pc, 'operand');
  }
  return v | 0;
}

// ------------------------------------------------------------------ 编译

/**
 * 校验并编译关卡脚本。结构问题与越界跳转抛 ImportError（带指令号 pc）。
 * 返回结构不与输入共享引用，可安全放进快照。
 */
export function compileProgram(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ImportError('关卡脚本必须是 JSON 对象', -1, 'root');
  }
  const rawCode = input.code;
  if (!Array.isArray(rawCode)) throw new ImportError('code 必须是数组', -1, 'root');
  if (rawCode.length === 0) throw new ImportError('code 不能为空', -1, 'root');
  if (rawCode.length > LIMITS.CODE) {
    throw new ImportError(`指令数 ${rawCode.length} 超过上限 ${LIMITS.CODE}`, LIMITS.CODE, 'limit');
  }

  let frames = null;
  if (input.frames !== undefined && input.frames !== null) {
    if (!isInt(input.frames) || input.frames < 0) throw new ImportError('frames 必须是非负整数', -1, 'root');
    if (input.frames > LIMITS.MAX_FRAMES) {
      throw new ImportError(`frames 超过上限 ${LIMITS.MAX_FRAMES}`, -1, 'limit');
    }
    frames = input.frames;
  }

  const rawEvents = input.events === undefined ? [] : input.events;
  if (!Array.isArray(rawEvents)) throw new ImportError('events 必须是数组', -1, 'root');
  if (rawEvents.length > LIMITS.EVENTS) {
    throw new ImportError(`事件数 ${rawEvents.length} 超过上限 ${LIMITS.EVENTS}`, -1, 'limit');
  }

  const n = rawCode.length;
  const ops = new Uint8Array(n);
  const arg = new Int32Array(n);
  const target = new Int32Array(n).fill(-1);
  const text = new Array(n).fill(null);
  const normCode = new Array(n);

  for (let pc = 0; pc < n; pc++) {
    const ins = rawCode[pc];
    if (!Array.isArray(ins) || ins.length === 0) {
      throw new ImportError(`指令 ${pc} 必须是非空数组`, pc, 'structure');
    }
    const name = ins[0];
    if (typeof name !== 'string' || !(name in OP)) {
      throw new ImportError(`指令 ${pc} 的名字 ${JSON.stringify(name)} 未知`, pc, 'structure');
    }
    const op = OP[name];
    ops[pc] = op;
    const want = ARITY[op];
    if (ins.length !== want + 1) {
      throw new ImportError(`指令 ${pc} ${name} 需要 ${want} 个操作数，实际 ${ins.length - 1} 个`, pc, 'operand');
    }
    switch (name) {
      case 'PUSH': {
        arg[pc] = checkInt32(ins[1], `指令 ${pc} PUSH 常量`, pc);
        normCode[pc] = [name, arg[pc]];
        break;
      }
      case 'LOAD':
      case 'STORE': {
        const slot = checkInt32(ins[1], `指令 ${pc} ${name} 槽号`, pc);
        if (slot < 0 || slot >= LIMITS.SLOTS) {
          throw new ImportError(`指令 ${pc} ${name} 槽号 ${slot} 越界（0..${LIMITS.SLOTS - 1}）`, pc, 'operand');
        }
        arg[pc] = slot;
        normCode[pc] = [name, slot];
        break;
      }
      case 'JNZ':
      case 'CALL':
      case 'FORK': {
        const t = checkInt32(ins[1], `指令 ${pc} ${name} 目标`, pc);
        if (t < 0 || t >= n) {
          throw new ImportError(`指令 ${pc} ${name} 跳转目标 ${t} 越界（有效范围 0..${n - 1}）`, pc, 'jump');
        }
        target[pc] = t;
        normCode[pc] = [name, t];
        break;
      }
      case 'SLEEP': {
        const d = checkInt32(ins[1], `指令 ${pc} SLEEP 延迟`, pc);
        if (d < 1) throw new ImportError(`指令 ${pc} SLEEP 延迟至少为 1`, pc, 'operand');
        arg[pc] = d;
        normCode[pc] = [name, d];
        break;
      }
      case 'WAIT':
      case 'EMIT': {
        const s = ins[1];
        if (typeof s !== 'string' || s.length === 0) {
          throw new ImportError(`指令 ${pc} ${name} 需要非空事件名`, pc, 'operand');
        }
        text[pc] = s;
        normCode[pc] = [name, s];
        break;
      }
      default:
        normCode[pc] = [name];
        break;
    }
  }

  // 事件：按帧分桶，桶内保持输入顺序；记录最大帧号用于死锁判定。
  const evName = new Array(rawEvents.length);
  const evValue = new Int32Array(rawEvents.length);
  const eventsByFrame = new Map();
  const normEvents = new Array(rawEvents.length);
  let maxEventFrame = -1;
  for (let i = 0; i < rawEvents.length; i++) {
    const e = rawEvents[i];
    if (!Array.isArray(e) || e.length !== 3) {
      throw new ImportError(`events[${i}] 必须是 [帧, 事件名, 值]`, -1, 'event');
    }
    const f = e[0];
    if (!isInt(f) || f < 0) throw new ImportError(`events[${i}] 的帧号必须是非负整数`, -1, 'event');
    if (f > LIMITS.MAX_FRAMES) throw new ImportError(`events[${i}] 的帧号 ${f} 超过上限 ${LIMITS.MAX_FRAMES}`, -1, 'limit');
    if (typeof e[1] !== 'string' || e[1].length === 0) {
      throw new ImportError(`events[${i}] 的事件名必须是非空字符串`, -1, 'event');
    }
    const v = checkInt32(e[2], `events[${i}] 的值`, -1);
    evName[i] = e[1];
    evValue[i] = v;
    normEvents[i] = [f, e[1], v];
    let bucket = eventsByFrame.get(f);
    if (!bucket) { bucket = []; eventsByFrame.set(f, bucket); }
    bucket.push(i);
    if (f > maxEventFrame) maxEventFrame = f;
  }

  return {
    n, ops, arg, target, text,
    frames,
    events: { name: evName, value: evValue, count: rawEvents.length },
    eventsByFrame,
    eventFrames: [...eventsByFrame.keys()].sort((a, b) => a - b),
    maxEventFrame,
    source: { frames, code: normCode, events: normEvents },
  };
}

// ------------------------------------------------------------------ 状态

export function makeFiber(id, pc, startFrame) {
  return {
    id, pc,
    status: STATUS.NEW,
    stack: [],
    calls: [],
    waitName: null,
    waitPc: -1,
    wakeFrame: 0,
    used: 0,
    startFrame,
  };
}

export function createState(prog) {
  return {
    frame: 0,
    phase: 'frame',
    slots: new Int32Array(LIMITS.SLOTS),
    fibers: [{
      id: 0, pc: 0, status: STATUS.READY, stack: [], calls: [],
      waitName: null, waitPc: -1, wakeFrame: 0, used: 0, startFrame: 0,
    }],
    outputs: [],
    faults: [],
    nextId: 1,
    finished: 0,
    retained: 0,
    liveCount: 1,
    halted: prog.frames === 0,
    stopReason: prog.frames === 0 ? 'frames' : null,
    totalInstr: 0,
  };
}

export function isLive(f) {
  return LIVE.has(f.status);
}

export function copyState(st) {
  return {
    frame: st.frame,
    phase: st.phase,
    slots: Int32Array.from(st.slots),
    fibers: st.fibers.map((f) => ({
      id: f.id, pc: f.pc, status: f.status,
      stack: f.stack.slice(), calls: f.calls.slice(),
      waitName: f.waitName, waitPc: f.waitPc, wakeFrame: f.wakeFrame,
      used: f.used, startFrame: f.startFrame,
    })),
    outputs: st.outputs.slice(),
    faults: st.faults.map((x) => ({ ...x })),
    nextId: st.nextId,
    finished: st.finished,
    retained: st.retained,
    liveCount: st.liveCount,
    halted: st.halted,
    stopReason: st.stopReason,
    totalInstr: st.totalInstr,
  };
}

export function describeInstruction(prog, pc) {
  if (pc < 0 || pc >= prog.n) return null;
  const name = OP_NAMES[prog.ops[pc]];
  switch (name) {
    case 'PUSH': return `${name} ${prog.arg[pc]}`;
    case 'LOAD':
    case 'STORE': return `${name} s${prog.arg[pc]}`;
    case 'JNZ': case 'CALL': case 'FORK': return `${name} #${prog.target[pc]}`;
    case 'SLEEP': return `${name} ${prog.arg[pc]}`;
    case 'WAIT': case 'EMIT': return `${name} ${prog.text[pc]}`;
    default: return name;
  }
}

// ------------------------------------------------------------------ 虚拟机

export class VM {
  constructor(prog, state) {
    this.prog = prog;
    this.state = state || createState(prog);
    this.cursor = 0;
    this._eventFrame = -1;
    this._eventList = null;
    this._lastFrameTrace = null;
  }

  get frame() { return this.state.frame; }
  get halted() { return this.state.halted; }
  get outputs() { return this.state.outputs; }
  get faults() { return this.state.faults; }

  _eventsFor(frame) {
    if (this._eventFrame !== frame) {
      this._eventFrame = frame;
      const idxs = this.prog.eventsByFrame.get(frame);
      this._eventList = idxs
        ? idxs.map((i) => ({ index: i, name: this.prog.events.name[i], value: this.prog.events.value[i] }))
        : [];
    }
    return this._eventList;
  }

  /** 当前帧将要广播的事件（不改变状态）。 */
  eventsThisFrame() {
    return this._eventsFor(this.state.frame).map((e) => ({ ...e }));
  }

  /**
   * 选择下一个可运行协程。按协程号升序；同协程在配额内连续执行。
   * 已结束协程跳过；本帧已用满 256 条的协程跳过。
   */
  pick() {
    const fs = this.state.fibers;
    let i = this.cursor;
    while (i < fs.length) {
      const f = fs[i];
      if (f.status === STATUS.READY && f.used < LIMITS.PER_FRAME) {
        this.cursor = i;
        return f;
      }
      i++;
    }
    this.cursor = fs.length;
    return null;
  }

  beginFrame() {
    const st = this.state;
    this.cursor = 0;
    for (const f of st.fibers) if (LIVE.has(f.status)) f.used = 0;

    const trace = { frame: st.frame, delivered: [], deliveredIndexes: [], wakes: [], starts: [] };

    // ① 帧首处于 WAIT 的协程：按事件输入顺序投递。收到即离开 WAIT，
    //    因此同名事件只有第一条会被这个协程收到。
    let byName = null;
    for (const f of st.fibers) {
      if (f.status === STATUS.WAITING) {
        if (!byName) byName = new Map();
        let list = byName.get(f.waitName);
        if (!list) { list = []; byName.set(f.waitName, list); }
        list.push(f);
      }
    }
    if (byName) {
      for (const ev of this._eventsFor(st.frame)) {
        const list = byName.get(ev.name);
        if (!list) continue;
        byName.delete(ev.name);
        trace.delivered.push({ name: ev.name, value: ev.value, fiberIds: list.map((f) => f.id) });
        trace.deliveredIndexes.push(ev.index);
        for (const f of list) this.deliver(f, ev.value);
      }
    }
    const all = this._eventsFor(st.frame);
    if (all.length) trace.events = all.map((e) => ({ name: e.name, value: e.value }));

    // ② SLEEP 到期
    for (const f of st.fibers) {
      if (f.status === STATUS.SLEEPING && f.wakeFrame <= st.frame) {
        f.status = STATUS.READY;
        f.wakeFrame = 0;
        trace.wakes.push(f.id);
      }
    }

    // ③ 上一帧 FORK 出的协程开始
    for (const f of st.fibers) {
      if (f.status === STATUS.NEW && f.startFrame <= st.frame) {
        f.status = STATUS.READY;
        f.used = 0;
        trace.starts.push(f.id);
      }
    }

    st.phase = 'run';
    this._lastFrameTrace = trace;
    return trace;
  }

  deliver(f, value) {
    if (f.stack.length >= LIMITS.STACK) {
      this.fault(f, f.waitPc >= 0 ? f.waitPc : f.pc, 'stack',
        `WAIT ${f.waitName} 收到事件时操作数栈已满（${LIMITS.STACK}）`);
      return;
    }
    f.stack.push(value | 0);
    f.status = STATUS.READY;
    f.waitName = null;
    f.waitPc = -1;
  }

  endFrame() {
    const st = this.state;
    if (st.retained > LIMITS.RETAINED_DONE) {
      let excess = st.retained - LIMITS.RETAINED_DONE;
      const kept = [];
      for (const f of st.fibers) {
        if (LIVE.has(f.status)) { kept.push(f); continue; }
        if (excess > 0) { excess--; st.retained--; continue; }
        kept.push(f);
      }
      st.fibers = kept;
    }
    st.frame++;
    st.phase = 'frame';
    this.cursor = 0;
    for (const f of st.fibers) f.used = 0;

    const limit = this.prog.frames === null ? Infinity : this.prog.frames;
    if (st.frame >= limit) {
      st.halted = true;
      st.stopReason = 'frames';
      return;
    }
    if (st.liveCount === 0) {
      st.halted = true;
      st.stopReason = 'empty';
      return;
    }

    // 下一件可能“发生的事”的帧号：可运行/新协程 = 当前帧；SLEEP 到期；最近事件。
    // 若全部协程都在 WAIT，且后续没有相关事件或唤醒，则判定死锁并在同一帧内停止；
    // 否则直接跳到该帧（中间帧无事可做，跳帧不改变任何输出）。
    let actionable = Infinity;
    for (const f of st.fibers) {
      if (f.status === STATUS.READY || f.status === STATUS.NEW) { actionable = st.frame; break; }
      if (f.status === STATUS.SLEEPING && f.wakeFrame < actionable) actionable = f.wakeFrame;
    }
    const nextEv = this._nextEventFrame(st.frame);
    if (nextEv < actionable) actionable = nextEv;
    if (actionable === Infinity) {
      st.halted = true;
      st.stopReason = 'deadlock';
      return;
    }
    if (actionable >= limit) {
      st.frame = limit;
      st.halted = true;
      st.stopReason = 'frames';
      return;
    }
    if (actionable > st.frame) st.frame = actionable;
  }

  _nextEventFrame(from) {
    const arr = this.prog.eventFrames;
    // 二分找第一个 >= from
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < from) lo = mid + 1; else hi = mid;
    }
    return lo < arr.length ? arr[lo] : Infinity;
  }

  fault(f, pc, kind, message) {
    if (LIVE.has(f.status)) this.state.liveCount--;
    f.status = STATUS.FAILED;
    this.state.faults.push({ frame: this.state.frame, fiber: f.id, pc, kind, message });
    this.state.finished++;
    this.state.retained++;
  }

  retire(f, status) {
    if (LIVE.has(f.status)) this.state.liveCount--;
    f.status = status;
    if (status === STATUS.DONE) {
      this.state.finished++;
      this.state.retained++;
    }
  }

  /** 执行给定协程的下一条指令（调用者保证 f.status === READY 且 pc 有效）。 */
  exec(f) {
    const st = this.state;
    const prog = this.prog;
    const pc = f.pc;
    if (pc < 0 || pc >= prog.n) {
      this.fault(f, pc, 'exit', `指令号 ${pc} 越过程序末尾（0..${prog.n - 1}）`);
      return;
    }
    const op = prog.ops[pc];
    const stack = f.stack;
    switch (op) {
      case 0: { // PUSH
        if (stack.length >= LIMITS.STACK) { this.fault(f, pc, 'stack', `PUSH 时操作数栈已满（${LIMITS.STACK}）`); return; }
        stack.push(prog.arg[pc]);
        f.pc = pc + 1;
        break;
      }
      case 1: { // LOAD
        if (stack.length >= LIMITS.STACK) { this.fault(f, pc, 'stack', `LOAD 时操作数栈已满（${LIMITS.STACK}）`); return; }
        stack.push(st.slots[prog.arg[pc]]);
        f.pc = pc + 1;
        break;
      }
      case 2: { // STORE
        if (stack.length < 1) { this.fault(f, pc, 'stack', 'STORE 需要 1 个操作数，栈为空'); return; }
        st.slots[prog.arg[pc]] = stack.pop() | 0;
        f.pc = pc + 1;
        break;
      }
      case 3: { // ADD
        if (stack.length < 2) { this.fault(f, pc, 'stack', `ADD 需要 2 个操作数，栈中只有 ${stack.length} 个`); return; }
        const b = stack.pop();
        const a = stack.pop();
        stack.push((a + b) | 0);
        f.pc = pc + 1;
        break;
      }
      case 4: { // JNZ
        if (stack.length < 1) { this.fault(f, pc, 'stack', 'JNZ 需要 1 个操作数，栈为空'); return; }
        f.pc = stack.pop() !== 0 ? prog.target[pc] : pc + 1;
        break;
      }
      case 5: { // CALL
        if (f.calls.length >= LIMITS.CALL_DEPTH) {
          this.fault(f, pc, 'stack', `CALL 时调用栈深度超过 ${LIMITS.CALL_DEPTH}`);
          return;
        }
        f.calls.push(pc + 1);
        f.pc = prog.target[pc];
        break;
      }
      case 6: { // RET
        if (f.calls.length === 0) {
          this.retire(f, STATUS.DONE);
          f.used++; st.totalInstr++;
          return;
        }
        f.pc = f.calls.pop();
        break;
      }
      case 7: { // FORK
        if (st.liveCount >= LIMITS.FIBERS) {
          this.fault(f, pc, 'fiber', `FORK 时并发协程已达上限 ${LIMITS.FIBERS}`);
          return;
        }
        const id = st.nextId++;
        st.fibers.push(makeFiber(id, prog.target[pc], st.frame + 1));
        st.liveCount++;
        f.pc = pc + 1;
        break;
      }
      case 8: { // SLEEP
        f.status = STATUS.SLEEPING;
        f.wakeFrame = st.frame + prog.arg[pc];
        f.pc = pc + 1;
        break;
      }
      case 9: { // WAIT
        f.status = STATUS.WAITING;
        f.waitName = prog.text[pc];
        f.waitPc = pc;
        f.pc = pc + 1;
        break;
      }
      case 10: { // EMIT
        if (stack.length < 1) { this.fault(f, pc, 'stack', 'EMIT 需要 1 个操作数，栈为空'); return; }
        st.outputs.push([st.frame, f.id, prog.text[pc], stack.pop() | 0]);
        f.pc = pc + 1;
        break;
      }
      case 11: { // HALT
        this.retire(f, STATUS.DONE);
        f.used++; st.totalInstr++;
        return;
      }
      default:
        this.fault(f, pc, 'structure', '未知指令');
        return;
    }
    f.used++;
    st.totalInstr++;
    if (f.pc >= prog.n && f.status !== STATUS.DONE && f.status !== STATUS.FAILED) {
      this.fault(f, pc, 'exit', `指令 ${pc} 执行后越过程序末尾（pc=${f.pc}）`);
    }
  }

  // ---------------------------------------------------------------- 调试接口

  /**
   * 查看下一步。frame 表示需要先做帧前处理，end 表示本帧协程已全部让出/满额。
   * @returns {{kind:'instr'|'frame'|'end'|'halted', ...}}
   */
  peek() {
    const st = this.state;
    if (st.halted) return { kind: 'halted', stopReason: st.stopReason };
    if (st.phase === 'frame') {
      const evs = this._eventsFor(st.frame);
      return { kind: 'frame', frame: st.frame, events: evs.length };
    }
    const f = this.pick();
    if (!f) return { kind: 'end', frame: st.frame };
    return {
      kind: 'instr', frame: st.frame, fiber: f.id, pc: f.pc,
      op: f.pc < this.prog.n ? OP_NAMES[this.prog.ops[f.pc]] : '??',
      text: describeInstruction(this.prog, f.pc),
    };
  }

  /**
   * 单步：只执行下一条指令。帧前处理、帧结束不计入“指令”，但会顺带完成。
   * @returns {{kind:'instr'|'halted', ...}}
   */
  stepInstruction() {
    const transitions = [];
    for (;;) {
      const st = this.state;
      if (st.halted) return { kind: 'halted', transitions, stopReason: st.stopReason };
      if (st.phase === 'frame') {
        const trace = this.beginFrame();
        transitions.push({ kind: 'frame-start', frame: trace.frame });
        continue;
      }
      const f = this.pick();
      if (!f) {
        const frame = st.frame;
        this.endFrame();
        transitions.push({ kind: 'frame-end', frame });
        continue;
      }
      const pc = f.pc;
      const fid = f.id;
      const text = describeInstruction(this.prog, pc);
      this.exec(f);
      const out = {
        kind: 'instr', frame: st.frame, fiber: fid, pc, text,
        status: f.status, transitions,
      };
      if (f.status === STATUS.FAILED) out.fault = st.faults[st.faults.length - 1];
      return out;
    }
  }

  /** 运行到本帧结束后停下（含当前帧剩余指令）。返回执行条数与过渡。 */
  stepFrame() {
    const transitions = [];
    for (;;) {
      const st = this.state;
      if (st.halted) return { kind: 'halted', executed: 0, transitions, stopReason: st.stopReason };
      if (st.phase === 'frame') {
        const trace = this.beginFrame();
        transitions.push({ kind: 'frame-start', frame: trace.frame });
      }
      const f = this.pick();
      if (!f) {
        const frame = st.frame;
        this.endFrame();
        transitions.push({ kind: 'frame-end', frame });
        return { kind: 'frame-end', executed: 0, transitions, frame };
      }
      this.exec(f);
    }
  }

  /**
   * 连续执行。遇到已设断点（执行前）停下，或达到指令上限，或程序停止。
   * ignore = {fiber, pc}：从该位置恢复的首次命中不视为断点（“继续”不应原地重停）。
   * @param {Set<number>|null} breakpoints 指令号集合
   * @param {number} maxInstructions
   * @param {{fiber:number, pc:number}|null} ignore
   */
  /**
   * 连续执行。遇到已设断点（执行前）停下，或达到指令上限，或程序停止。
   * ignore = {fiber, pc}：从该位置恢复时，**这个协程的这条指令**不再视为断点，
   * 直到它真正执行过一条指令为止（其他协程的断点照常生效）。
   * @param {Set<number>|null} breakpoints 指令号集合
   * @param {number} maxInstructions
   * @param {{fiber:number, pc:number}|null} ignore
   */
  run(breakpoints = null, maxInstructions = Infinity, ignore = null) {
    let executed = 0;
    let ignoreArmed = ignore !== null;
    for (;;) {
      const st = this.state;
      if (st.halted) return { reason: 'halted', executed, stopReason: st.stopReason };
      if (st.phase === 'frame') { this.beginFrame(); continue; }
      const f = this.pick();
      if (!f) { this.endFrame(); continue; }
      const atIgnored = ignoreArmed && ignore.fiber === f.id && ignore.pc === f.pc;
      if (breakpoints && breakpoints.size && breakpoints.has(f.pc) && !atIgnored) {
        return { reason: 'breakpoint', executed, fiber: f.id, pc: f.pc };
      }
      if (executed >= maxInstructions) {
        return { reason: 'budget', executed, fiber: f.id, pc: f.pc };
      }
      if (atIgnored) ignoreArmed = false;
      this.exec(f);
      executed++;
    }
  }

  /** 帧前处理后执行完当前帧（不检查断点），供性能基准使用。 */
  runFrame() {
    if (this.state.halted) return 'halted';
    const f0 = this.state.frame;
    if (this.state.phase === 'frame') this.beginFrame();
    while (!this.state.halted && this.state.frame === f0) {
      const f = this.pick();
      if (f) this.exec(f);
      else this.endFrame();
    }
    return this.state.halted ? 'halted' : 'frame-end';
  }

  /** 运行到停止或达到上限。 */
  runToHalt(maxInstructions = Infinity, maxFrames = Infinity) {
    const startFrame = this.state.frame;
    let executed = 0;
    while (executed < maxInstructions && !this.state.halted) {
      if (this.state.phase === 'frame') {
        if (this.state.frame - startFrame >= maxFrames) break;
        this.beginFrame();
        continue;
      }
      const f = this.pick();
      if (!f) { this.endFrame(); continue; }
      this.exec(f);
      executed++;
    }
    return executed;
  }

  clone() {
    const vm = new VM(this.prog, copyState(this.state));
    vm.cursor = this.cursor;
    return vm;
  }

  // ---------------------------------------------------------------- 快照

  snapshot() {
    const st = this.state;
    return {
      format: 'level-fiber-snapshot',
      version: 1,
      program: this.prog.source,
      state: {
        frame: st.frame,
        phase: st.phase,
        slots: Array.from(st.slots),
        fibers: st.fibers.map((f) => ({
          id: f.id, pc: f.pc, status: f.status,
          stack: f.stack.slice(), calls: f.calls.slice(),
          waitName: f.waitName, waitPc: f.waitPc, wakeFrame: f.wakeFrame,
          used: f.used, startFrame: f.startFrame,
        })),
        outputs: st.outputs.slice(),
        faults: st.faults.slice(),
        nextId: st.nextId,
        finished: st.finished,
        retained: st.retained,
        halted: st.halted,
        stopReason: st.stopReason,
        totalInstr: st.totalInstr,
      },
    };
  }

  static fromSnapshot(snap) {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
      throw new ImportError('快照必须是 JSON 对象', -1, 'snapshot');
    }
    if (snap.format !== 'level-fiber-snapshot') {
      throw new ImportError('不是关卡协程快照（format 不匹配）', -1, 'snapshot');
    }
    if (snap.version !== 1) throw new ImportError(`不支持的快照版本 ${snap.version}`, -1, 'snapshot');
    const prog = compileProgram(snap.program);
    const s = snap.state;
    if (!s || typeof s !== 'object') throw new ImportError('快照缺少 state', -1, 'snapshot');
    const bad = (msg) => { throw new ImportError(`快照 state 非法：${msg}`, -1, 'snapshot'); };
    if (!isInt(s.frame) || s.frame < 0) bad('frame');
    if (s.phase !== 'frame' && s.phase !== 'run') bad('phase');
    if (!Array.isArray(s.slots) || s.slots.length !== LIMITS.SLOTS) bad('slots 长度必须为 32');
    const slots = new Int32Array(LIMITS.SLOTS);
    for (let i = 0; i < LIMITS.SLOTS; i++) {
      if (!isInt(s.slots[i])) bad(`slots[${i}]`);
      slots[i] = s.slots[i] | 0;
    }
    if (!Array.isArray(s.fibers) || s.fibers.length === 0) bad('fibers');
    const seen = new Set();
    const fibers = s.fibers.map((f, i) => {
      if (!f || typeof f !== 'object') bad(`fibers[${i}]`);
      if (!isInt(f.id) || f.id < 0) bad(`fibers[${i}].id`);
      if (seen.has(f.id)) bad(`fibers 中协程号 ${f.id} 重复`);
      seen.add(f.id);
      const status = f.status;
      if (!LIVE.has(status) && status !== STATUS.DONE && status !== STATUS.FAILED) bad(`fibers[${i}].status`);
      if (!isInt(f.pc) || f.pc < 0 || f.pc > prog.n) bad(`fibers[${i}].pc`);
      if (status !== STATUS.DONE && status !== STATUS.FAILED && f.pc >= prog.n) bad(`fibers[${i}].pc 越过程序末尾`);
      if (!Array.isArray(f.stack) || f.stack.length > LIMITS.STACK || !f.stack.every(isInt)) bad(`fibers[${i}].stack`);
      if (!Array.isArray(f.calls) || f.calls.length > LIMITS.CALL_DEPTH || !f.calls.every(isInt)) bad(`fibers[${i}].calls`);
      if (status === STATUS.WAITING && (typeof f.waitName !== 'string' || f.waitName.length === 0)) bad(`fibers[${i}].waitName`);
      if (!isInt(f.used) || f.used < 0 || f.used > LIMITS.PER_FRAME) bad(`fibers[${i}].used`);
      if (!isInt(f.wakeFrame)) bad(`fibers[${i}].wakeFrame`);
      if (!isInt(f.waitPc)) bad(`fibers[${i}].waitPc`);
      if (!isInt(f.startFrame)) bad(`fibers[${i}].startFrame`);
      return {
        id: f.id, pc: f.pc | 0, status,
        stack: f.stack.map((v) => v | 0), calls: f.calls.map((v) => v | 0),
        waitName: f.waitName ?? null, waitPc: f.waitPc | 0, wakeFrame: f.wakeFrame | 0,
        used: f.used | 0, startFrame: f.startFrame | 0,
      };
    });
    if (!Array.isArray(s.outputs)) bad('outputs');
    const outputs = s.outputs.map((o, i) => {
      if (!Array.isArray(o) || o.length !== 4 || !isInt(o[0]) || !isInt(o[1])
        || typeof o[2] !== 'string' || !isInt(o[3])) bad(`outputs[${i}]`);
      return [o[0], o[1], o[2], o[3] | 0];
    });
    if (!Array.isArray(s.faults)) bad('faults');
    const faults = s.faults.map((x, i) => {
      if (!x || typeof x !== 'object' || !isInt(x.frame) || !isInt(x.fiber) || !isInt(x.pc)) bad(`faults[${i}]`);
      return { frame: x.frame, fiber: x.fiber, pc: x.pc, kind: String(x.kind ?? ''), message: String(x.message ?? '') };
    });
    if (!isInt(s.nextId) || s.nextId < 1) bad('nextId');
    if (!isInt(s.finished) || s.finished < 0) bad('finished');
    if (!isInt(s.retained) || s.retained < 0) bad('retained');
    if (s.retained > s.finished) bad('retained 不能大于 finished');
    if (typeof s.halted !== 'boolean') bad('halted');
    if (s.stopReason !== null && typeof s.stopReason !== 'string') bad('stopReason');
    if (!isInt(s.totalInstr) || s.totalInstr < 0) bad('totalInstr');
    let liveCount = 0;
    for (const f of fibers) if (LIVE.has(f.status)) liveCount++;
    if (liveCount > LIMITS.FIBERS) bad('存活协程数超过上限');
    let maxId = -1;
    for (const f of fibers) if (f.id > maxId) maxId = f.id;
    if (s.nextId <= maxId) bad('nextId 不大于已分配的最大协程号');
    if (s.phase === 'frame') {
      for (const f of fibers) {
        if (f.used !== 0) bad(`phase=frame 但协程 ${f.id} 的 used 非 0`);
      }
    }
    const state = {
      frame: s.frame | 0, phase: s.phase, slots, fibers,
      outputs, faults,
      nextId: s.nextId | 0, finished: s.finished | 0, retained: s.retained | 0,
      liveCount, halted: s.halted, stopReason: s.stopReason ?? null,
      totalInstr: s.totalInstr | 0,
    };
    const vm = new VM(prog, state);
    vm.cursor = 0;
    return vm;
  }
}
