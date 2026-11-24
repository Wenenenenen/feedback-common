/* 伙伴状态图运行器 —— 确定性解释器，浏览器 / Node 通用，无依赖。
 *
 * 语义（与 samples/companion-chart.json 的 rules 及任务约定对齐）：
 * - 普通复合节点进入 initial；parallel 节点进入全部直接子节点（按 states 数组顺序）。
 * - 一个事件可让多条转移同时生效：守卫一律读取「微步步首」的变量值；
 *   候选按「源节点深度降序、编号升序」排序；退出根互为祖先（含相同）时只留先选者；
 *   胜出边按选中顺序依次执行（取旧历史 → 退出子树并记录 → 历史/默认重入 → set → emit）。
 * - exitRoot 必须包含 source（含自身）。退出时记录该子树的完整活跃配置
 *   （含退出根自身、含各并行分区的全部活跃状态/叶）。history=true 的边优先恢复
 *   「上一次退出」时记录的配置；没有旧记录时按 target 路径重入，途经 parallel
 *   的其余分区走默认值。
 * - 定时器属于「本次进入」：进入时按 after（正整数 ms）登记，离开对应状态即失效；
 *   到点发布内部同名事件。同毫秒多个定时器按登记顺序（timerSeq）处理；
 *   同毫秒定时器先于外部输入，外部输入之间按（稳定排序后的）输入顺序。
 * - 内部事件 FIFO 排空后才处理下一个顶层项（输入/定时器）。
 * - 无胜出转移的事件不计「生效微步」；同一顶层项累计超过 256 个生效微步时，
 *   回滚到该顶层项开始前的检查点、追加一条 rollback 轨迹并永久停住。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.CompanionRunner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = { states: 512, edges: 2048, inputs: 50000 };
  const MAX_EFFECTIVE_MICROSTEPS = 256;

  function clone(o) {
    if (o === undefined) return undefined;
    return typeof structuredClone === 'function'
      ? structuredClone(o)
      : JSON.parse(JSON.stringify(o));
  }
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

  const isParallelState = (s) =>
    !!s && (s.parallel === true || s.type === 'parallel' || s.kind === 'parallel');

  // ---------------- 编译与校验 ----------------
  function compile(chart) {
    if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
      throw new Error('图定义必须是 JSON 对象');
    }
    const errors = [];
    const err = (m) => errors.push(m);

    const states = Array.isArray(chart.states) ? chart.states : [];
    const edges = Array.isArray(chart.edges) ? chart.edges : [];
    const inputs = Array.isArray(chart.inputs) ? chart.inputs : [];

    if (states.length > LIMITS.states) {
      err(`状态数 ${states.length} 超过上限 ${LIMITS.states}`);
    }
    if (edges.length > LIMITS.edges) {
      err(`转移数 ${edges.length} 超过上限 ${LIMITS.edges}`);
    }
    if (inputs.length > LIMITS.inputs) {
      err(`输入事件数 ${inputs.length} 超过上限 ${LIMITS.inputs}`);
    }

    const byId = new Map();
    for (const s of states) {
      if (!s || !isInt(s.id)) { err('每个状态都需要数字 id'); continue; }
      if (byId.has(s.id)) { err(`状态 id ${s.id} 重复`); continue; }
      byId.set(s.id, s);
    }

    const root = chart.root;
    if (!byId.has(root)) err(`root ${JSON.stringify(root)} 不在 states 中`);

    const parentOf = new Map();
    const childrenOf = new Map();
    for (const id of byId.keys()) childrenOf.set(id, []);

    for (const s of byId.values()) {
      if (s.id === root) {
        if (s.parent != null) err(`根节点 ${s.id} 不应有 parent`);
        continue;
      }
      if (s.parent == null) { err(`状态 ${s.id} 缺少 parent（非根节点）`); continue; }
      if (!byId.has(s.parent)) { err(`状态 ${s.id} 的 parent ${s.parent} 不存在`); continue; }
      parentOf.set(s.id, s.parent);
      childrenOf.get(s.parent).push(s.id); // 保持 states 数组顺序 => 进入顺序确定
    }

    // 深度 + 父链环检测
    const depth = new Map();
    for (const id of byId.keys()) {
      let d = 0;
      let cur = id;
      const seen = new Set();
      while (parentOf.has(cur)) {
        if (seen.has(cur)) { err(`状态 ${id} 的父链存在环`); break; }
        seen.add(cur);
        cur = parentOf.get(cur);
        d++;
      }
      depth.set(id, d);
    }

    // 从根可达性
    for (const id of byId.keys()) {
      let cur = id;
      let ok = false;
      const seen = new Set();
      while (!seen.has(cur)) {
        if (cur === root) { ok = true; break; }
        if (!parentOf.has(cur)) break;
        seen.add(cur);
        cur = parentOf.get(cur);
      }
      if (!ok) err(`状态 ${id} 从根不可达`);
    }

    /** a 是否为 b 的祖先（不含自身）。 */
    function isAnc(a, b) {
      if (a == null || b == null || a === b) return false;
      let cur = b;
      const seen = new Set();
      while (parentOf.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = parentOf.get(cur);
        if (cur === a) return true;
      }
      return false;
    }
    /** a 与 b 是否相同或互为祖先（退出根冲突判定）。 */
    function sameTreeRoot(a, b) {
      return a === b || isAnc(a, b) || isAnc(b, a);
    }

    // 状态结构
    for (const s of byId.values()) {
      const kids = childrenOf.get(s.id);
      if (isParallelState(s)) {
        if (!kids.length) err(`parallel 状态 ${s.id} 没有子节点（至少一个并行分区）`);
        if (s.initial != null) err(`parallel 状态 ${s.id} 不应指定 initial`);
      } else if (kids.length) {
        if (!byId.has(s.initial)) {
          err(`复合状态 ${s.id} 需要指定 initial（直接子节点）`);
        } else if (parentOf.get(s.initial) !== s.id) {
          err(`状态 ${s.id} 的 initial ${s.initial} 不是其直接子节点`);
        }
      }
      if (s.timers != null) {
        if (!Array.isArray(s.timers)) {
          err(`状态 ${s.id} 的 timers 必须是数组`);
        } else {
          for (const t of s.timers) {
            if (!t || !isInt(t.after) || t.after <= 0) {
              err(`状态 ${s.id} 的定时器 after 必须是正整数`);
            }
            if (!t || typeof t.event !== 'string' || !t.event) {
              err(`状态 ${s.id} 的定时器 event 必须是非空字符串`);
            }
          }
        }
      }
    }

    // 变量初值（未声明变量在 guard 中按 0 处理）
    const varsInit = {};
    const varsSrc = chart.vars && typeof chart.vars === 'object' && !Array.isArray(chart.vars)
      ? chart.vars : {};
    for (const k of Object.keys(varsSrc)) {
      if (!isInt(varsSrc[k])) err(`变量 ${k} 的初值必须是整数`);
      else varsInit[k] = varsSrc[k];
    }

    // 转移
    const edgeIds = new Set();
    for (const e of edges) {
      if (!e || !isInt(e.id)) { err('每条转移都需要数字 id'); continue; }
      if (edgeIds.has(e.id)) { err(`转移 id ${e.id} 重复`); continue; }
      edgeIds.add(e.id);

      if (!byId.has(e.source)) err(`转移 ${e.id} 的 source ${e.source} 不存在`);
      if (!byId.has(e.exitRoot)) {
        err(`转移 ${e.id} 的 exitRoot ${e.exitRoot} 不存在`);
      } else if (byId.has(e.source) && e.exitRoot !== e.source && !isAnc(e.exitRoot, e.source)) {
        err(`转移 ${e.id} 的 exitRoot ${e.exitRoot} 必须包含 source ${e.source}`);
      }
      if (e.target != null && !byId.has(e.target)) {
        err(`转移 ${e.id} 的 target ${e.target} 不存在`);
      }
      if (typeof e.event !== 'string' || !e.event) {
        err(`转移 ${e.id} 的 event 必须是非空字符串`);
      }
      for (const tbl of ['guard', 'set']) {
        if (e[tbl] == null) continue;
        if (typeof e[tbl] !== 'object' || Array.isArray(e[tbl])) {
          err(`转移 ${e.id} 的 ${tbl} 必须是对象`);
          continue;
        }
        for (const k of Object.keys(e[tbl])) {
          if (!isInt(e[tbl][k])) err(`转移 ${e.id} 的 ${tbl}.${k} 必须是整数`);
        }
      }
      if (e.emit != null && (!Array.isArray(e.emit) || e.emit.some((x) => typeof x !== 'string' || !x))) {
        err(`转移 ${e.id} 的 emit 必须是非空字符串数组`);
      }
    }

    // 输入校验 + 稳定排序（同 ms 保持原数组顺序 = 输入顺序）
    for (const inp of inputs) {
      if (!inp || typeof inp.ms !== 'number' || !Number.isFinite(inp.ms) || inp.ms < 0) {
        err('输入事件的 ms 必须是非负有限数');
      }
      if (!inp || typeof inp.event !== 'string' || !inp.event) {
        err('输入事件的 event 必须是非空字符串');
      }
    }
    const sortedInputs = inputs.slice().sort((a, b) => a.ms - b.ms);

    // 按事件名预建「候选顺序」：源深度降序、id 升序。
    // 之后只需按 source 活跃 + guard 过滤，过滤是稳定的，顺序依然正确。
    const edgesByEvent = new Map();
    for (const e of edges) {
      if (typeof e.event !== 'string') continue;
      if (!edgesByEvent.has(e.event)) edgesByEvent.set(e.event, []);
      edgesByEvent.get(e.event).push(e);
    }
    for (const list of edgesByEvent.values()) {
      list.sort((a, b) =>
        (depth.get(b.source) ?? 0) - (depth.get(a.source) ?? 0) || a.id - b.id);
    }

    if (errors.length) throw new Error(errors.join('\n'));

    return {
      chart, root, byId, parentOf, childrenOf, depth,
      isAnc, sameTreeRoot, isParallel: isParallelState,
      edges, edgesByEvent, inputs: sortedInputs, varsInit,
    };
  }

  // ---------------- 运行器 ----------------
  class Runner {
    constructor(cc) {
      this.cc = cc;
      this.trace = [];
      this.state = {
        time: 0,
        config: [],         // 活跃状态 id，按进入顺序（JSON 安全）
        vars: clone(cc.varsInit),
        timers: [],         // {id, state, event, due}，id 为全局登记序号
        queue: [],          // 待处理内部事件名（FIFO）
        history: {},        // exitRootId -> 上次退出时记录的完整活跃配置
        nextInput: 0,       // cc.inputs 的游标
        timerSeq: 0,
        halted: false,
        haltReason: null,
        micro: 0,           // 事件投递总数（每个 trace 行 = 一个微步）
        effective: 0,       // 生效微步总数（有胜出边）
        itemEffective: 0,   // 当前顶层项（含其内部事件链）的生效微步数
        checkpoint: null,   // 当前顶层项开始前的可回滚状态
      };
      this.enterDefault(cc.root);
      this.trace.push({
        seq: 0, ms: 0, kind: 'init', event: null,
        fired: [], effective: false,
      });
    }

    /** 以同一编译结果 + 给定纯状态派生运行器（时间轴重放用），trace 独立。 */
    spawn(state) {
      const r = Object.create(Runner.prototype);
      r.cc = this.cc;
      r.state = clone(state);
      r.trace = [];
      return r;
    }

    serialize() { return clone(this.state); }
    restore(s) { this.state = clone(s); }

    hasNext() {
      const st = this.state;
      return !st.halted &&
        (st.queue.length > 0 || st.timers.length > 0 || st.nextInput < this.cc.inputs.length);
    }

    // ---- 进入 ----
    enterState(id) {
      const st = this.state;
      const s = this.cc.byId.get(id);
      st.config.push(id);
      if (s.timers) {
        // 每次进入都重新登记属于「这一次进入」的定时器
        for (const tm of s.timers) {
          st.timers.push({
            id: ++st.timerSeq,
            state: id,
            event: tm.event,
            due: st.time + tm.after,
          });
        }
      }
    }

    /** 默认进入 id 自身，并按 parallel / initial 规则进入其下方整棵默认树。 */
    enterDefault(id) {
      this.enterState(id);
      this.defaultBelow(id);
    }

    defaultBelow(id) {
      const s = this.cc.byId.get(id);
      const kids = this.cc.childrenOf.get(id);
      if (this.cc.isParallel(s)) {
        for (const c of kids) this.enterDefault(c); // 全部直接子节点（各分区）
      } else if (s.initial != null) {
        this.enterDefault(s.initial);
      }
    }

    /** 沿 root→target 的路径进入；途经 parallel 时，不在路径上的分区走默认。 */
    enterPath(node, target) {
      this.enterState(node);
      if (node === target) { this.defaultBelow(node); return; }

      const cc = this.cc;
      const s = cc.byId.get(node);
      const kids = cc.childrenOf.get(node);
      const toward = (c) => c === target || cc.isAnc(c, target);

      if (cc.isParallel(s)) {
        for (const c of kids) {
          if (toward(c)) this.enterPath(c, target);
          else this.enterDefault(c); // 其余并行分区走默认初始值
        }
      } else {
        const next = kids.find(toward);
        if (next != null) this.enterPath(next, target);
        else this.defaultBelow(node); // 兜底（正常图校验后不会走到）
      }
    }

    enterWithTarget(root, target) {
      const cc = this.cc;
      if (target != null && cc.byId.has(target) &&
          (target === root || cc.isAnc(root, target))) {
        this.enterPath(root, target);
      } else {
        this.enterDefault(root);
      }
    }

    // ---- 退出：记录完整活跃配置，并让该次进入的定时器全部失效 ----
    exitSubtree(rootId) {
      const st = this.state;
      const cc = this.cc;
      const rec = st.config.filter((id) => id === rootId || cc.isAnc(rootId, id));
      // 深度升序、id 升序：保证父先于子，历史重入时 config 顺序确定
      rec.sort((a, b) => cc.depth.get(a) - cc.depth.get(b) || a - b);
      st.history[rootId] = rec; // 退树记住全部活跃配置（含所有并行叶）
      const removed = new Set(rec);
      st.config = st.config.filter((id) => !removed.has(id));
      st.timers = st.timers.filter((t) => !removed.has(t.state)); // 离开即失效
    }

    // ---- 取下一步要投递的事件；每个 step = 一个事件微步 ----
    step() {
      const st = this.state;
      const cc = this.cc;
      if (st.halted) return null;

      let kind;
      let event;
      let extra = {};

      if (st.queue.length) {
        // 内部事件优先 FIFO 排空（不另设检查点：它们从属于当前顶层项）
        kind = 'internal';
        event = st.queue.shift();
      } else {
        // 最早到期的有效定时器；同 due 按登记序号（登记顺序）
        let ti = -1;
        for (let i = 0; i < st.timers.length; i++) {
          const t = st.timers[i];
          if (ti < 0 || t.due < st.timers[ti].due ||
              (t.due === st.timers[ti].due && t.id < st.timers[ti].id)) {
            ti = i;
          }
        }
        const inp = cc.inputs[st.nextInput];
        if (ti < 0 && !inp) return null;

        if (ti >= 0 && (!inp || st.timers[ti].due <= inp.ms)) {
          const t = st.timers.splice(ti, 1)[0];
          st.time = t.due;
          kind = 'timer';
          event = t.event;
          extra = { timerState: t.state, timerId: t.id };
        } else {
          st.time = inp.ms;
          st.nextInput++;
          kind = 'input';
          event = inp.event;
          extra = { inputIndex: st.nextInput - 1 };
        }

        // 顶层项检查点（此时该项事件已取出/游标已推进，效果尚未发生）
        st.checkpoint = clone(st);
        st.checkpoint.checkpoint = null;
        st.itemEffective = 0;
      }

      return this.microstep(kind, event, extra);
    }

    microstep(kind, event, extra) {
      const cc = this.cc;
      let st = this.state;

      // 所有守卫一律读「本微步步首」的变量快照
      const stepVars = Object.assign({}, st.vars);
      const active = new Set(st.config);

      const candidates = [];
      const preSorted = cc.edgesByEvent.get(event);
      if (preSorted) {
        for (const e of preSorted) {
          if (!active.has(e.source)) continue;
          if (e.guard) {
            let ok = true;
            for (const k of Object.keys(e.guard)) {
              const v = stepVars[k] == null ? 0 : stepVars[k];
              if (v !== e.guard[k]) { ok = false; break; }
            }
            if (!ok) continue;
          }
          candidates.push(e); // 已按源深度降序、id 升序
        }
      }

      // 退出根相同或互为祖先 => 与先选边冲突，丢弃后来者
      const winners = [];
      for (const c of candidates) {
        let conflict = false;
        for (const w of winners) {
          if (cc.sameTreeRoot(w.exitRoot, c.exitRoot)) { conflict = true; break; }
        }
        if (!conflict) winners.push(c);
      }

      st.micro++;

      if (!winners.length) {
        // 无转移的事件：不计生效微步
        const entry = Object.assign({
          seq: this.trace.length, ms: st.time, kind, event,
          fired: [], effective: false,
        }, extra);
        this.trace.push(entry);
        return entry;
      }

      st.effective++;
      st.itemEffective++;

      if (st.itemEffective > MAX_EFFECTIVE_MICROSTEPS) {
        // 回滚该顶层项（输入/定时器及其内部链）开始前的机器状态
        const ck = st.checkpoint;
        if (ck) { ck.checkpoint = null; this.state = ck; st = this.state; }
        st.halted = true;
        st.haltReason =
          `事件「${event}」的生效微步超过 ${MAX_EFFECTIVE_MICROSTEPS}，已回滚该次输入并停住`;
        const entry = Object.assign({
          seq: this.trace.length, ms: st.time, kind: 'rollback', event,
          fired: winners.map((w) => w.id), effective: false,
          reason: st.haltReason,
        }, extra);
        this.trace.push(entry); // 轨迹保留：256 个生效步 + 这条回滚记录
        return entry;
      }

      // 胜出边严格按选中顺序执行
      for (const w of winners) {
        const prior = st.history[w.exitRoot]; // 必须在本次 exit 覆盖记录前取「上一次」
        this.exitSubtree(w.exitRoot);
        if (w.history === true && prior) {
          for (const id of prior) this.enterState(id); // 完整恢复各并行分区
        } else {
          this.enterWithTarget(w.exitRoot, w.target == null ? null : w.target);
        }
        if (w.set) for (const k of Object.keys(w.set)) st.vars[k] = w.set[k];
        if (w.emit) for (const nm of w.emit) st.queue.push(nm); // FIFO 入队
      }

      const entry = Object.assign({
        seq: this.trace.length, ms: st.time, kind, event,
        fired: winners.map((w) => w.id), effective: true,
      }, extra);
      this.trace.push(entry);
      return entry;
    }

    runToEnd(cap) {
      cap = cap == null ? 2000000 : cap;
      let n = 0;
      while (this.hasNext() && n < cap) {
        if (!this.step()) break;
        n++;
      }
      return n;
    }
  }

  function create(chart) {
    return new Runner(compile(chart));
  }

  return {
    create, compile, Runner,
    LIMITS, MAX_EFFECTIVE_MICROSTEPS,
    cloneState: clone,
    isParallelState,
  };
});
