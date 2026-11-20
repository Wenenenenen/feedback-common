/*
 * 输入动作仲裁引擎(Input Action Arbiter)
 * 纯逻辑时钟、确定性实现,不依赖任何现成输入动作库。
 *
 * 协议(见 samples/extracted/说明.md):
 *  - 事件按 (t, seq) 处理;同一 t 的全部输入处理完后,再处理到期的定时器。
 *  - 忽略重复 down(操作系统自动重复)和未按下键的 up。
 *  - 绑定状态机: armed -> candidate(候选等待) -> started(已集齐,等待就绪)
 *    -> performed(已触发,占用按键) -> ended(动作结束,占用保持至全键释放)
 *    每轮无论失败或完成,均等该绑定全键释放后重新武装(disarmed -> armed)。
 *  - 组合须在 first_down + window_ms 以内全部按下,正好截止的输入有效。
 *  - 最早 performed 时刻 = max(first_down + window_ms, complete_time + hold_ms)。
 *  - 裁决: context.priority 降序 -> keys 数量降序 -> binding.priority 降序 -> id 升序。
 *  - 获胜者 performed 一次并占用全部 keys 直至这些键都释放;共享其键的已 started
 *    候选发 canceled,未 started 候选直接淘汰(含未到期候选)。
 *  - 获胜者第一键抬起时发一次 canceled 作为动作结束,剩余键仍占用。
 *  - 切换上下文 / 修改绑定:取消所有 started 动作,清空占用与候选,保留物理键。
 *  - blur: 按键名字典序合成 up,再清空候选与占用。
 */
(function (global) {
  'use strict';

  const MAX_BINDINGS = 64;
  const MAX_EVENTS = 10000;

  function validateConfig(config) {
    const errors = [];
    if (!config || typeof config !== 'object') {
      errors.push('配置不是对象');
      return errors;
    }
    if (!Number.isFinite(config.window_ms) || config.window_ms < 0) {
      errors.push('window_ms 必须是非负毫秒数');
    }
    const ctxIds = new Set();
    const contexts = Array.isArray(config.contexts) ? config.contexts : [];
    if (!Array.isArray(config.contexts)) errors.push('contexts 必须是数组');
    contexts.forEach((c) => {
      if (!c || typeof c.id !== 'string' || !c.id) errors.push('上下文缺少 id');
      else if (ctxIds.has(c.id)) errors.push(`上下文 id 重复: ${c.id}`);
      else ctxIds.add(c.id);
      if (!Number.isFinite(c.priority)) errors.push(`上下文 ${c && c.id} 缺少数值 priority`);
    });
    const bindings = Array.isArray(config.bindings) ? config.bindings : [];
    if (!Array.isArray(config.bindings)) errors.push('bindings 必须是数组');
    if (bindings.length > MAX_BINDINGS) errors.push(`绑定数量 ${bindings.length} 超过上限 ${MAX_BINDINGS}`);
    const bIds = new Set();
    bindings.forEach((b) => {
      if (!b || typeof b.id !== 'string' || !b.id) { errors.push('绑定缺少 id'); return; }
      if (bIds.has(b.id)) errors.push(`绑定 id 重复: ${b.id}`);
      bIds.add(b.id);
      if (!ctxIds.has(b.context)) errors.push(`绑定 ${b.id} 引用了未知上下文 ${b.context}`);
      if (!Array.isArray(b.keys) || b.keys.length === 0) errors.push(`绑定 ${b.id} 的 keys 为空`);
      else if (new Set(b.keys).size !== b.keys.length) errors.push(`绑定 ${b.id} 的 keys 有重复`);
      if (!Number.isFinite(b.hold_ms) || b.hold_ms < 0) errors.push(`绑定 ${b.id} 的 hold_ms 必须 >= 0`);
      if (!Number.isFinite(b.priority)) errors.push(`绑定 ${b.id} 缺少数值 priority`);
    });
    return errors;
  }

  function normalizeEvents(events) {
    if (!Array.isArray(events)) throw new Error('events 必须是数组');
    if (events.length > MAX_EVENTS) throw new Error(`事件数量 ${events.length} 超过上限 ${MAX_EVENTS}`);
    return events.map((e, i) => {
      if (!e || !Number.isFinite(e.t) || e.t < 0) throw new Error(`事件 #${i} 的 t 非法`);
      if (!['down', 'up', 'context', 'blur'].includes(e.type)) throw new Error(`事件 #${i} 的 type 非法: ${e.type}`);
      if ((e.type === 'down' || e.type === 'up') && typeof e.key !== 'string') throw new Error(`事件 #${i} 缺少 key`);
      if (e.type === 'context' && !Array.isArray(e.active)) throw new Error(`事件 #${i} 缺少 active 数组`);
      return e;
    });
  }

  class Arbiter {
    constructor(logSink) {
      this.logSink = logSink || null;
      this.entries = [];      // 全量日志(导出用)
      this.stepEntries = [];  // 当前 step 产生的日志
      this.queue = [];        // 待处理输入事件,按 (t, seq) 排序
      this.clock = 0;
      this._nextSeq = 0;
      this.pressed = new Set();
      this.occupied = new Map(); // key -> bindingId
      this.config = null;
      this.contexts = new Map();
      this.bindings = new Map();
      this.setConfig({ window_ms: 40, contexts: [], bindings: [] });
    }

    emit(e) {
      this.entries.push(e);
      this.stepEntries.push(e);
      if (this.logSink) this.logSink(e);
    }

    /* 设置/修改配置。修改时取消所有 started 动作、清空占用与候选,保留物理键。 */
    setConfig(config, opts) {
      opts = opts || {};
      const errors = validateConfig(config);
      if (errors.length) throw new Error(errors.join(';'));
      if (this.bindings && this.bindings.size) this._abortAll(this.clock, opts.reason || '配置修改');
      this.config = {
        window_ms: config.window_ms,
        contexts: config.contexts.map((c) => ({ id: c.id, priority: c.priority, active: !!c.active })),
        bindings: config.bindings.map((b) => ({
          id: b.id, context: b.context, priority: b.priority,
          keys: b.keys.slice(), hold_ms: b.hold_ms,
        })),
      };
      this.contexts = new Map(this.config.contexts.map((c) => [c.id, c]));
      this.bindings = new Map();
      for (const def of this.config.bindings) {
        this.bindings.set(def.id, {
          def, state: 'disarmed',
          firstDown: 0, deadline: 0, completeTime: 0, readyTime: 0,
          pressedKeys: new Set(),
        });
      }
      this._checkRearm();
    }

    getConfig() {
      return {
        window_ms: this.config.window_ms,
        contexts: this.config.contexts.map((c) => ({ id: c.id, priority: c.priority, active: c.active })),
        bindings: this.config.bindings.map((b) => ({
          id: b.id, context: b.context, priority: b.priority, keys: b.keys.slice(), hold_ms: b.hold_ms,
        })),
      };
    }

    /* 批量载入事件(回放)。 */
    loadEvents(events) {
      const list = normalizeEvents(events).map((e) => Object.assign({}, e));
      list.sort((a, b) => (a.t - b.t) || ((a.seq || 0) - (b.seq || 0)));
      this.queue = list;
      this._nextSeq = list.reduce((m, e) => Math.max(m, (e.seq || 0) + 1), this._nextSeq);
    }

    /* 追加单个事件(实时键盘 / 注入 context / blur)。 */
    push(ev) {
      normalizeEvents([ev]);
      const e = Object.assign({}, ev);
      if (e.seq == null) e.seq = this._nextSeq++;
      else this._nextSeq = Math.max(this._nextSeq, e.seq + 1);
      // 按 (t, seq) 有序插入
      let i = this.queue.length;
      while (i > 0) {
        const p = this.queue[i - 1];
        if (p.t < e.t || (p.t === e.t && p.seq <= e.seq)) break;
        i--;
      }
      this.queue.splice(i, 0, e);
      return e;
    }

    nextTimerTime() {
      let m = Infinity;
      for (const b of this.bindings.values()) {
        if (b.state === 'candidate') m = Math.min(m, b.deadline);
        else if (b.state === 'started') m = Math.min(m, b.readyTime);
      }
      return m;
    }

    peekNextTime() {
      const nt = this.nextTimerTime();
      if (this.queue.length === 0) return nt;
      return Math.min(nt, this.queue[0].t);
    }

    hasWork() {
      return this.queue.length > 0 || this.nextTimerTime() !== Infinity;
    }

    /*
     * 处理下一个时间单元(一个输入事件,或一组到期定时器)。
     * 约定:同一 t 的全部输入处理完后,才处理该 t 到期的定时器。
     * 返回本步产生的日志条目。
     */
    step() {
      this.stepEntries = [];
      const nt = this.nextTimerTime();
      if (this.queue.length === 0) {
        if (nt === Infinity) return [];
        this._fireTimers(nt);
        return this.stepEntries;
      }
      const t0 = this.queue[0].t;
      if (nt < t0) {
        this._fireTimers(nt);
        return this.stepEntries;
      }
      const ev = this.queue.shift();
      this.clock = ev.t;
      this._handleEvent(ev);
      // 同一 t 没有更多输入时,处理该 t 到期的定时器
      if (this.queue.length === 0 || this.queue[0].t > ev.t) {
        let t;
        while ((t = this.nextTimerTime()) <= ev.t) this._fireTimers(t);
      }
      return this.stepEntries;
    }

    runAll() {
      while (this.hasWork()) this.step();
    }

    /* ---------------- 内部:事件处理 ---------------- */

    _handleEvent(ev) {
      switch (ev.type) {
        case 'down': this._down(ev.key, ev.t, ev.seq, false); break;
        case 'up': this._up(ev.key, ev.t, ev.seq, false); break;
        case 'context': this._context(ev.active, ev.t, ev.seq); break;
        case 'blur': this._blur(ev.t, ev.seq); break;
      }
    }

    _down(key, t, seq, synth) {
      if (this.pressed.has(key)) {
        this.emit({ kind: 'input', t, seq, type: 'down', key, synth, ignored: true, reason: '重复按下已忽略(自动重复)' });
        return;
      }
      this.pressed.add(key);
      this.emit({ kind: 'input', t, seq, type: 'down', key, synth });
      for (const b of this.bindings.values()) {
        if (!b.def.keys.includes(key)) continue;
        if (b.state === 'armed') {
          if (!this._ctxActive(b.def.context)) continue;
          b.state = 'candidate';
          b.firstDown = t;
          b.deadline = t + this.config.window_ms;
          b.pressedKeys = new Set([key]);
          this.emit({ kind: 'candidate', t, id: b.def.id, deadline: b.deadline });
          this._tryComplete(b, t);
        } else if (b.state === 'candidate') {
          b.pressedKeys.add(key);
          this._tryComplete(b, t);
        }
      }
    }

    _up(key, t, seq, synth) {
      if (!this.pressed.has(key)) {
        this.emit({ kind: 'input', t, seq, type: 'up', key, synth, ignored: true, reason: '未按下的键抬起已忽略' });
        return;
      }
      this.pressed.delete(key);
      this.emit({ kind: 'input', t, seq, type: 'up', key, synth });
      for (const b of this.bindings.values()) {
        if (!b.def.keys.includes(key)) continue;
        if (b.state === 'candidate') {
          b.pressedKeys.delete(key); // 未集齐:候选保留至截止
        } else if (b.state === 'started') {
          this._cancel(b, t, '按键提前抬起');
        } else if (b.state === 'performed') {
          this._cancel(b, t, '动作结束:首键释放');
          b.state = 'ended'; // 占用保持至全键释放
        }
      }
      this._releaseOccupations(t);
      this._checkRearm();
    }

    _context(active, t, seq) {
      this.emit({ kind: 'input', t, seq, type: 'context', active: active.slice() });
      for (const c of this.config.contexts) c.active = active.includes(c.id);
      this._abortAll(t, '上下文切换');
      this._checkRearm();
    }

    _blur(t, seq) {
      this.emit({ kind: 'input', t, seq, type: 'blur' });
      // 按键名字典序合成 up
      const keys = [...this.pressed].sort();
      for (const k of keys) this._up(k, t, this._nextSeq++, true);
      // 再清空候选与占用
      this._abortAll(t, '失焦');
      this._checkRearm();
    }

    /* ---------------- 内部:状态机 ---------------- */

    _tryComplete(b, t) {
      if (!b.def.keys.every((k) => b.pressedKeys.has(k))) return;
      b.state = 'started';
      b.completeTime = t;
      b.readyTime = Math.max(b.firstDown + this.config.window_ms, t + b.def.hold_ms);
      this.emit({ kind: 'started', t, id: b.def.id, readyTime: b.readyTime });
    }

    _cancel(b, t, reason) {
      this.emit({ kind: 'canceled', t, id: b.def.id, reason });
      b.state = 'disarmed';
    }

    _eliminate(b, t, reason) {
      this.emit({ kind: 'eliminated', t, id: b.def.id, reason });
      b.state = 'disarmed';
    }

    _releaseOccupations(t) {
      if (!this.occupied.size) return;
      const byId = new Map(); // bindingId -> keys
      for (const [key, id] of this.occupied) {
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(key);
      }
      for (const [id, keys] of byId) {
        const b = this.bindings.get(id);
        if (!b) { for (const k of keys) this.occupied.delete(k); continue; }
        if (b.def.keys.every((k) => !this.pressed.has(k))) {
          for (const k of keys) this.occupied.delete(k);
          this.emit({ kind: 'release', t, id, keys: b.def.keys.slice() });
        }
      }
    }

    _abortAll(t, reason) {
      for (const b of this.bindings.values()) {
        if (b.state === 'started' || b.state === 'performed') {
          this._cancel(b, t, reason);
        } else if (b.state === 'candidate') {
          this._eliminate(b, t, reason);
        }
        b.state = 'disarmed';
        b.pressedKeys.clear();
      }
      if (this.occupied.size) {
        const byId = new Map();
        for (const [key, id] of this.occupied) {
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push(key);
        }
        for (const [id, keys] of byId) this.emit({ kind: 'release', t, id, keys, reason });
        this.occupied.clear();
      }
    }

    _checkRearm() {
      for (const b of this.bindings.values()) {
        if (b.state !== 'disarmed' && b.state !== 'ended') continue;
        const free = b.def.keys.every((k) => !this.pressed.has(k) && !this.occupied.has(k));
        if (free) b.state = 'armed';
      }
    }

    _ctxActive(id) {
      const c = this.contexts.get(id);
      return !!(c && c.active);
    }

    /* ---------------- 内部:定时器(候选截止 + 就绪裁决) ---------------- */

    _fireTimers(T) {
      this.clock = T;
      this.emit({ kind: 'timer', t: T });
      // 1. 截止仍未集齐的候选淘汰(正好截止的输入已在输入阶段处理,有效)
      for (const b of this.bindings.values()) {
        if (b.state === 'candidate' && b.deadline <= T) {
          this._eliminate(b, T, '窗口截止未集齐');
        }
      }
      // 2. 就绪绑定裁决
      const ready = [...this.bindings.values()].filter((b) => b.state === 'started' && b.readyTime <= T);
      if (ready.length) {
        const ctxPrio = (b) => { const c = this.contexts.get(b.def.context); return c ? c.priority : 0; };
        ready.sort((a, b) =>
          (ctxPrio(b) - ctxPrio(a)) ||
          (b.def.keys.length - a.def.keys.length) ||
          (b.def.priority - a.def.priority) ||
          (a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : 0));
        const winners = [];
        for (const b of ready) {
          const blocked = winners.some((w) => w.def.keys.some((k) => b.def.keys.includes(k)));
          if (!blocked) winners.push(b); // 不同键集合的就绪绑定可同刻获胜
        }
        const winnerKeys = new Set();
        for (const w of winners) w.def.keys.forEach((k) => winnerKeys.add(k));
        for (const w of winners) {
          w.state = 'performed';
          w.performedTime = T;
          this.emit({ kind: 'performed', t: T, id: w.def.id });
          for (const k of w.def.keys) this.occupied.set(k, w.def.id);
          this.emit({ kind: 'occupy', t: T, id: w.def.id, keys: w.def.keys.slice() });
        }
        // 3. 占用淘汰:共享获胜者按键的已 started 候选发 canceled,未 started 候选直接淘汰(含未到期)
        if (winnerKeys.size) {
          const names = winners.map((w) => w.def.id).join(',');
          for (const b of this.bindings.values()) {
            if (winners.includes(b)) continue;
            if (!b.def.keys.some((k) => winnerKeys.has(k))) continue;
            if (b.state === 'started') this._cancel(b, T, `按键被占用:${names}`);
            else if (b.state === 'candidate') this._eliminate(b, T, `候选被占用淘汰:${names}`);
          }
        }
      }
      this._checkRearm();
    }

    /* ---------------- 查询 ---------------- */

    snapshot() {
      return {
        clock: this.clock,
        pressed: [...this.pressed].sort(),
        occupied: [...this.occupied.entries()].map(([key, id]) => ({ key, by: id })),
        bindings: [...this.bindings.values()].map((b) => ({
          id: b.def.id, state: b.state,
          deadline: b.state === 'candidate' ? b.deadline : null,
          readyTime: b.state === 'started' ? b.readyTime : null,
        })),
      };
    }

    actionLog() {
      return this.entries
        .filter((e) => e.kind === 'started' || e.kind === 'performed' || e.kind === 'canceled')
        .map((e) => ({ t: e.t, phase: e.kind, id: e.id, reason: e.reason }));
    }
  }

  Arbiter.MAX_BINDINGS = MAX_BINDINGS;
  Arbiter.MAX_EVENTS = MAX_EVENTS;
  Arbiter.validateConfig = validateConfig;

  if (typeof module !== 'undefined' && module.exports) module.exports = { Arbiter };
  else global.Arbiter = Arbiter;
})(typeof window !== 'undefined' ? window : globalThis);
