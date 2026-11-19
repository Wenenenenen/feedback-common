/*
 * ECS Barrier Inspector — deterministic archetype ECS with generational handles.
 *
 * No third-party ECS. Storage is prototype (archetype) based: every prototype
 * owns contiguous columns per component field, and a slot -> (prototype, row)
 * map keeps handles valid across migrations.
 *
 * The module is a UMD-ish factory so the same file runs in Node tests and is
 * inlined into the browser page by build.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ECSEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'ecs-barrier-inspector';
  const SNAPSHOT_VERSION = 1;
  const INT32_MIN = -2147483648;
  const INT32_MAX = 2147483647;
  const MAX_ENTITIES = 10000;
  const MAX_EXTERNAL_PENDING = 20000;
  const MAX_EVENTS_IN_MEMORY = 30000;
  const EVENT_TRIM_SLACK = 4000;
  // The event trail is a debugging aid, not world state (the digest and counters
  // above are). Snapshots keep a bounded tail so a 10000-entity world stays small.
  const MAX_SNAPSHOT_EVENTS = 5000;

  /** Fixed component order. Masks are stable across save/restore. */
  const COMPONENTS = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'];
  const BIT = {};
  COMPONENTS.forEach((name, i) => { BIT[name] = 1 << i; });

  const FIELDS = {
    Position: ['x', 'y'],
    Velocity: ['x', 'y'],
    Health: ['value'],
    Poison: ['amount'],
    Frozen: [],
    Spawner: ['period', 'vx', 'vy'],
  };

  function isInt(n) { return typeof n === 'number' && Number.isInteger(n); }
  function inInt32(n) { return isInt(n) && n >= INT32_MIN && n <= INT32_MAX; }
  function clampMsg(n) { return String(n); }

  function maskOf(names) {
    let m = 0;
    for (const n of names) m |= BIT[n];
    return m;
  }
  function namesOfMask(mask) {
    const out = [];
    for (const n of COMPONENTS) if (mask & BIT[n]) out.push(n);
    return out;
  }
  function maskKey(mask) { return namesOfMask(mask).join('+') || '(空)'; }

  function emptyColumns(mask) {
    const cols = {};
    for (const n of namesOfMask(mask)) {
      cols[n] = {};
      for (const f of FIELDS[n]) cols[n][f] = [];
    }
    return cols;
  }

  function cloneValue(name, v) {
    const out = {};
    for (const f of FIELDS[name]) out[f] = v[f];
    return out;
  }

  class ValidationError extends Error {}

  function normalizeComponentValue(name, value) {
    if (!COMPONENTS.includes(name)) throw new ValidationError('未知组件: ' + name);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError('组件值非法: ' + name);
    }
    const expected = FIELDS[name];
    for (const k of Object.keys(value)) {
      if (!expected.includes(k)) throw new ValidationError('组件值非法: ' + name + '.' + k + ' 是未知字段');
    }
    const out = {};
    for (const f of expected) {
      if (!(f in value)) throw new ValidationError('组件值非法: ' + name + '.' + f + ' 缺失');
      const n = value[f];
      if (!isInt(n)) throw new ValidationError('组件值非法: ' + name + '.' + f + ' 必须为整数');
      if (!inInt32(n)) throw new ValidationError('组件值非法: ' + name + '.' + f + ' 超出 int32');
      if (name === 'Poison' && f === 'amount' && n < 0) {
        throw new ValidationError('组件值非法: Poison.amount 不能为负');
      }
      if (name === 'Spawner' && f === 'period' && n <= 0) {
        throw new ValidationError('组件值非法: Spawner.period 必须为正');
      }
      out[f] = n;
    }
    return out;
  }

  function normalizeComponents(components) {
    if (components === undefined || components === null) components = {};
    if (typeof components !== 'object' || Array.isArray(components)) {
      throw new ValidationError('组件集合非法');
    }
    const values = {};
    let mask = 0;
    for (const name of Object.keys(components)) {
      if (!COMPONENTS.includes(name)) throw new ValidationError('未知组件: ' + name);
      if (mask & BIT[name]) throw new ValidationError('组件重复: ' + name);
      values[name] = normalizeComponentValue(name, components[name]);
      mask |= BIT[name];
    }
    return { mask, values, names: namesOfMask(mask) };
  }

  // ---------------------------------------------------------------------------
  // Min-heap of free slots. Allocation must always take the smallest free slot.
  // ---------------------------------------------------------------------------
  class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(v) {
      const a = this.a; a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p] <= a[i]) break;
        const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
      }
    }
    pop() {
      const a = this.a;
      if (!a.length) return undefined;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l] < a[m]) m = l;
          if (r < a.length && a[r] < a[m]) m = r;
          if (m === i) break;
          const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
        }
      }
      return top;
    }
    peek() { return this.a.length ? this.a[0] : undefined; }
    toSortedArray() { return this.a.slice().sort((x, y) => x - y); }
    static fromArray(arr) {
      const h = new MinHeap();
      // Insert already-sorted values; heap shape is irrelevant, pops are ordered.
      for (const v of arr) h.push(v);
      return h;
    }
  }

  // ---------------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------------
  class World {
    constructor() {
      this.tick = 0;
      this.slotGen = [];        // generation per slot, kept for freed slots too
      this.alive = [];          // bool per slot
      this.slotProto = [];      // prototype mask per slot, -1 when dead
      this.slotRow = [];        // row inside prototype, -1 when dead
      this.free = new MinHeap();
      this.prototypes = new Map(); // mask -> proto, kept in creation order
      this.aliveCount = 0;

      this.externalPending = [];
      this.systemPending = [];
      this.externalSeqHistory = new Set();
      this.lastAppliedSeq = 0;
      this.internalCounter = 0;

      this.events = [];
      this.eventSeq = 0;
      this.eventsTotal = 0;
      this.eventsTruncated = 0;
      this.eventDigest = 0x811c9dc5 >>> 0;
      this.lastTickReport = null;
    }

    // ---- event log ----------------------------------------------------------
    emit(ev) {
      ev.i = this.eventSeq++;
      this.eventsTotal++;
      this.eventDigest = fnv1aStep(this.eventDigest, JSON.stringify(ev) + '|');
      this.events.push(ev);
      // Trim in chunks: splicing the front on every event is quadratic.
      if (this.events.length > MAX_EVENTS_IN_MEMORY + EVENT_TRIM_SLACK) {
        this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
      }
      return ev;
    }

    // ---- prototypes ---------------------------------------------------------
    proto(mask) {
      let p = this.prototypes.get(mask);
      if (!p) {
        p = {
          mask,
          key: maskKey(mask),
          components: namesOfMask(mask),
          slots: [],
          gens: [],
          columns: emptyColumns(mask),
        };
        this.prototypes.set(mask, p);
      }
      return p;
    }

    appendRow(mask, values, slot, generation) {
      const p = this.proto(mask);
      const row = p.slots.length;
      p.slots.push(slot);
      p.gens.push(generation);
      for (const name of p.components) {
        const v = values[name];
        const cols = p.columns[name];
        for (const f of FIELDS[name]) cols[f].push(v[f]);
      }
      this.slotProto[slot] = mask;
      this.slotRow[slot] = row;
      return row;
    }

    /** Swap-remove a row; repairs the mapping of the entity moved into its place. */
    removeRow(mask, row) {
      const p = this.prototypes.get(mask);
      if (!p) throw new Error('internal: missing prototype ' + mask);
      const last = p.slots.length - 1;
      let movedSlot = -1;
      if (row !== last) {
        movedSlot = p.slots[last];
        p.slots[row] = p.slots[last];
        p.gens[row] = p.gens[last];
        for (const name of p.components) {
          const cols = p.columns[name];
          for (const f of FIELDS[name]) cols[f][row] = cols[f][last];
        }
        this.slotRow[movedSlot] = row;
      }
      p.slots.pop();
      p.gens.pop();
      for (const name of p.components) {
        const cols = p.columns[name];
        for (const f of FIELDS[name]) cols[f].pop();
      }
      return movedSlot;
    }

    readRow(mask, row) {
      const p = this.prototypes.get(mask);
      const values = {};
      for (const name of p.components) {
        const v = {};
        const cols = p.columns[name];
        for (const f of FIELDS[name]) v[f] = cols[f][row];
        values[name] = v;
      }
      return values;
    }

    writeRow(mask, row, name, value) {
      const p = this.prototypes.get(mask);
      const cols = p.columns[name];
      for (const f of FIELDS[name]) cols[f][row] = value[f];
    }

    hasComponent(mask, name) { return (mask & BIT[name]) !== 0; }

    // ---- handles ------------------------------------------------------------
    handleError(h) {
      if (!h || typeof h !== 'object') return '句柄无效';
      const slot = h.slot, gen = h.generation;
      if (!isInt(slot) || !isInt(gen)) return '句柄无效';
      if (slot < 0) return '句柄无效';
      if (slot >= this.slotGen.length) return '实体不存在';
      if (gen !== this.slotGen[slot]) return '过期句柄';
      if (!this.alive[slot]) return '实体为空';
      return null;
    }

    locate(h) {
      const err = this.handleError(h);
      if (err) return { error: err };
      return {
        slot: h.slot,
        generation: h.generation,
        mask: this.slotProto[h.slot],
        row: this.slotRow[h.slot],
      };
    }

    allocateSlot() {
      if (this.free.size > 0) {
        const slot = this.free.pop();
        return slot;
      }
      const slot = this.slotGen.length;
      this.slotGen.push(1);
      this.alive.push(false);
      this.slotProto.push(-1);
      this.slotRow.push(-1);
      return slot;
    }

    createEntity(components, meta) {
      const norm = normalizeComponents(components);
      if (this.aliveCount >= MAX_ENTITIES) {
        throw new ValidationError('实体数量超限 10000');
      }
      const slot = this.allocateSlot();
      const gen = this.slotGen[slot];
      this.alive[slot] = true;
      this.aliveCount++;
      this.appendRow(norm.mask, norm.values, slot, gen);
      const handle = { slot, generation: gen };
      this.emit({
        tick: this.tick,
        type: 'create',
        phase: meta && meta.phase ? meta.phase : 'external',
        handle: { slot, generation: gen },
        mask: norm.mask,
        components: norm.values,
        ...(meta && meta.parent ? { parent: meta.parent, iseq: meta.iseq } : {}),
      });
      return { handle, mask: norm.mask, components: norm.values };
    }

    destroyEntity(handle, meta) {
      const loc = this.locate(handle);
      if (loc.error) throw new ValidationError(loc.error);
      this.removeRow(loc.mask, loc.row);
      this.alive[loc.slot] = false;
      this.slotProto[loc.slot] = -1;
      this.slotRow[loc.slot] = -1;
      this.slotGen[loc.slot] = this.slotGen[loc.slot] + 1;
      this.aliveCount--;
      this.free.push(loc.slot);
      this.emit({
        tick: this.tick,
        type: 'destroy',
        phase: meta && meta.phase ? meta.phase : 'external',
        handle: { slot: loc.slot, generation: this.slotGen[loc.slot] },
        fromGen: handle.generation,
        cause: meta && meta.cause ? meta.cause : 'command',
        ...(meta && meta.iseq !== undefined ? { iseq: meta.iseq } : {}),
      });
    }

    migrate(handle, targetMask, targetValues, cause, meta) {
      const loc = this.locate(handle);
      if (loc.error) throw new ValidationError(loc.error);
      const fromMask = loc.mask;
      const values = this.readRow(fromMask, loc.row);
      for (const name of Object.keys(targetValues)) values[name] = targetValues[name];
      // append first, then swap-remove from the source: row positions stay
      // deterministic and the slot mapping follows the moved rows.
      this.appendRow(targetMask, values, loc.slot, handle.generation);
      this.removeRow(fromMask, loc.row);
      this.emit({
        tick: this.tick,
        type: 'migrate',
        handle: { slot: loc.slot, generation: handle.generation },
        fromMask,
        toMask: targetMask,
        from: maskKey(fromMask),
        to: maskKey(targetMask),
        cause,
        ...(meta && meta.iseq !== undefined ? { iseq: meta.iseq } : {}),
      });
    }

    // ---- external command queue --------------------------------------------
    enqueueExternal(commands) {
      const list = Array.isArray(commands) ? commands : [commands];
      if (this.externalPending.length + list.length > MAX_EXTERNAL_PENDING) {
        throw new Error('待执行外部命令超过 20000 条上限');
      }
      for (const cmd of list) {
        if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
          throw new Error('命令必须是对象');
        }
        this.externalPending.push(cmd);
      }
      valsortPending(this.externalPending);
      return list.length;
    }

    clearExternal() { this.externalPending = []; }

    /** Optional helper: next free seq for the command editor. */
    nextSuggestedSeq() {
      let max = this.lastAppliedSeq;
      for (const c of this.externalPending) {
        if (isInt(c.seq) && c.seq > max) max = c.seq;
      }
      for (const s of this.externalSeqHistory) if (s > max) max = s;
      return max + 1;
    }

    // ---- command application ------------------------------------------------
    applyExternalCommand(cmd) {
      const ev = {
        tick: this.tick,
        type: 'cmd',
        phase: 'external',
        seq: isInt(cmd.seq) ? cmd.seq : null,
        op: typeof cmd.op === 'string' ? cmd.op : null,
        ok: false,
      };
      const fail = (reason) => {
        ev.reason = reason;
        this.emit(ev);
        return ev;
      };

      if (!isInt(cmd.seq)) return fail('seq 必须为整数');
      if (this.externalSeqHistory.has(cmd.seq)) return fail('seq 重复');
      // A seq is consumed even when the command fails: it stays globally unique.
      this.externalSeqHistory.add(cmd.seq);
      if (cmd.seq > this.lastAppliedSeq) this.lastAppliedSeq = cmd.seq;

      try {
        const result = this.applyCommandBody(cmd, 'external');
        ev.ok = true;
        if (result && result.handle) ev.handle = result.handle;
        if (result && result.created) ev.created = result.created;
        if (result && result.mask !== undefined) ev.mask = result.mask;
      } catch (err) {
        ev.reason = err instanceof ValidationError ? err.message : ('内部错误: ' + err.message);
      }
      this.emit(ev);
      return ev;
    }

    applyCommandBody(cmd, phase) {
      const op = cmd.op;
      if (op === 'create') {
        const r = this.createEntity(cmd.components, { phase });
        return { handle: r.handle, mask: r.mask };
      }
      if (op === 'destroy') {
        this.destroyEntity(cmd.handle, { phase, cause: 'command' });
        return {};
      }
      if (op === 'add') {
        const loc = this.locate(cmd.handle);
        if (loc.error) throw new ValidationError(loc.error);
        if (!COMPONENTS.includes(cmd.component)) throw new ValidationError('未知组件: ' + cmd.component);
        if (this.hasComponent(loc.mask, cmd.component)) throw new ValidationError('组件已存在: ' + cmd.component);
        const value = normalizeComponentValue(cmd.component, cmd.value);
        const targetMask = loc.mask | BIT[cmd.component];
        this.migrate(cmd.handle, targetMask, { [cmd.component]: value }, 'add');
        return { mask: targetMask };
      }
      if (op === 'remove') {
        const loc = this.locate(cmd.handle);
        if (loc.error) throw new ValidationError(loc.error);
        if (!COMPONENTS.includes(cmd.component)) throw new ValidationError('未知组件: ' + cmd.component);
        if (!this.hasComponent(loc.mask, cmd.component)) throw new ValidationError('组件不存在: ' + cmd.component);
        const targetMask = loc.mask & ~BIT[cmd.component];
        this.migrate(cmd.handle, targetMask, {}, 'remove');
        return { mask: targetMask };
      }
      if (op === 'set') {
        const loc = this.locate(cmd.handle);
        if (loc.error) throw new ValidationError(loc.error);
        if (!COMPONENTS.includes(cmd.component)) throw new ValidationError('未知组件: ' + cmd.component);
        if (!this.hasComponent(loc.mask, cmd.component)) throw new ValidationError('组件不存在: ' + cmd.component);
        const value = normalizeComponentValue(cmd.component, cmd.value);
        this.writeRow(loc.mask, loc.row, cmd.component, value);
        return {};
      }
      throw new ValidationError('未知操作: ' + String(op));
    }

    flushExternal() {
      const batch = this.externalPending;
      this.externalPending = [];
      valsortPending(batch);
      let ok = 0, failed = 0;
      for (const cmd of batch) {
        const ev = this.applyExternalCommand(cmd);
        if (ev.ok) ok++; else failed++;
      }
      return { count: batch.length, ok, failed };
    }

    // ---- queries ------------------------------------------------------------
    /**
     * Stable query: matching entities are ordered by (slot, generation).
     * include/exclude are component-name arrays; they must be disjoint.
     */
    query(include, exclude) {
      const inc = include || [];
      const exc = exclude || [];
      const incMask = maskOf(inc);
      const excMask = maskOf(exc);
      if ((incMask & excMask) !== 0) throw new Error('查询包含集与排除集不能交叠');
      const out = [];
      for (const p of this.prototypes.values()) {
        if ((p.mask & incMask) !== incMask) continue;
        if ((p.mask & excMask) !== 0) continue;
        for (let r = 0; r < p.slots.length; r++) {
          out.push({
            slot: p.slots[r],
            generation: p.gens[r],
            mask: p.mask,
            row: r,
            values: this.readRow(p.mask, r),
          });
        }
      }
      out.sort((a, b) => (a.slot - b.slot) || (a.generation - b.generation));
      return out;
    }

    queryHandles(include, exclude) {
      return this.query(include, exclude).map((e) => ({ slot: e.slot, generation: e.generation }));
    }

    // ---- systems ------------------------------------------------------------
    systemRows(include, exclude) {
      const incMask = maskOf(include);
      const excMask = maskOf(exclude);
      const out = [];
      for (const p of this.prototypes.values()) {
        if ((p.mask & incMask) !== incMask) continue;
        if ((p.mask & excMask) !== 0) continue;
        for (let r = 0; r < p.slots.length; r++) {
          out.push({ mask: p.mask, row: r, slot: p.slots[r], generation: p.gens[r] });
        }
      }
      out.sort((a, b) => (a.slot - b.slot) || (a.generation - b.generation));
      return out;
    }

    queueSystemCommand(cmd) {
      cmd.iseq = this.internalCounter++;
      this.systemPending.push(cmd);
      this.emit({
        tick: this.tick,
        type: 'queue',
        phase: 'system',
        iseq: cmd.iseq,
        op: cmd.op,
        ...(cmd.handle ? { handle: cmd.handle } : {}),
        ...(cmd.parent ? { parent: cmd.parent } : {}),
      });
      return cmd;
    }

    runIntegrate(report) {
      const rows = this.systemRows(['Position', 'Velocity'], ['Frozen']);
      for (const ent of rows) {
        const p = this.prototypes.get(ent.mask);
        const x = p.columns.Position.x[ent.row];
        const y = p.columns.Position.y[ent.row];
        const vx = p.columns.Velocity.x[ent.row];
        const vy = p.columns.Velocity.y[ent.row];
        const nx = x + vx;
        const ny = y + vy;
        const badX = !inInt32(nx), badY = !inInt32(ny);
        if (badX || badY) {
          this.emit({
            tick: this.tick, type: 'overflow', system: 'integrate',
            handle: { slot: ent.slot, generation: ent.generation },
            detail: badX
              ? ('Position.x ' + x + ' + ' + vx + ' = ' + clampMsg(nx) + ' 超出 int32')
              : ('Position.y ' + y + ' + ' + vy + ' = ' + clampMsg(ny) + ' 超出 int32'),
            skipped: true,
          });
          report.integrate.overflow++;
          continue;
        }
        if (nx !== x || ny !== y) {
          p.columns.Position.x[ent.row] = nx;
          p.columns.Position.y[ent.row] = ny;
          this.emit({
            tick: this.tick, type: 'integrate',
            handle: { slot: ent.slot, generation: ent.generation },
            from: { x, y }, to: { x: nx, y: ny },
          });
        }
        report.integrate.count++;
      }
    }

    runDamage(report) {
      const rows = this.systemRows(['Health', 'Poison'], []);
      for (const ent of rows) {
        const p = this.prototypes.get(ent.mask);
        const health = p.columns.Health.value[ent.row];
        const amount = p.columns.Poison.amount[ent.row];
        const next = health - amount;
        if (!inInt32(next)) {
          this.emit({
            tick: this.tick, type: 'overflow', system: 'damage',
            handle: { slot: ent.slot, generation: ent.generation },
            detail: 'Health.value ' + health + ' - ' + amount + ' = ' + clampMsg(next) + ' 超出 int32',
            skipped: true,
          });
          report.damage.overflow++;
          continue;
        }
        p.columns.Health.value[ent.row] = next;
        report.damage.count++;
        let queued = false;
        if (next <= 0) {
          queued = true;
          this.queueSystemCommand({
            op: 'destroy',
            handle: { slot: ent.slot, generation: ent.generation },
            cause: 'damage',
          });
          report.damage.queuedDestroy++;
        }
        this.emit({
          tick: this.tick, type: 'damage',
          handle: { slot: ent.slot, generation: ent.generation },
          from: health, amount, to: next, queuedDestroy: queued,
        });
      }
    }

    runEmit(report) {
      const rows = this.systemRows(['Spawner', 'Position'], []);
      for (const ent of rows) {
        const p = this.prototypes.get(ent.mask);
        const period = p.columns.Spawner.period[ent.row];
        if (this.tick % period !== 0) continue;
        const components = {
          Position: { x: p.columns.Position.x[ent.row], y: p.columns.Position.y[ent.row] },
          Velocity: { x: p.columns.Spawner.vx[ent.row], y: p.columns.Spawner.vy[ent.row] },
          Health: { value: 1 },
        };
        this.queueSystemCommand({
          op: 'create',
          components,
          parent: { slot: ent.slot, generation: ent.generation },
          cause: 'spawn',
        });
        report.emit.count++;
        this.emit({
          tick: this.tick, type: 'spawn',
          parent: { slot: ent.slot, generation: ent.generation },
          components,
        });
      }
    }

    flushSystem() {
      const batch = this.systemPending;
      this.systemPending = [];
      let ok = 0, failed = 0;
      for (const cmd of batch) {
        const ev = {
          tick: this.tick, type: 'syscmd', phase: 'system', iseq: cmd.iseq,
          op: cmd.op, ok: false,
        };
        try {
          if (cmd.op === 'create') {
            const r = this.createEntity(cmd.components, { phase: 'system', iseq: cmd.iseq, parent: cmd.parent });
            ev.ok = true;
            ev.handle = r.handle;
            ev.created = true;
            ev.mask = r.mask;
          } else if (cmd.op === 'destroy') {
            this.destroyEntity(cmd.handle, { phase: 'system', iseq: cmd.iseq, cause: 'damage' });
            ev.ok = true;
          } else {
            throw new ValidationError('未知系统命令: ' + cmd.op);
          }
          ok++;
        } catch (err) {
          ev.reason = err instanceof ValidationError ? err.message : ('内部错误: ' + err.message);
          failed++;
        }
        this.emit(ev);
      }
      return { count: batch.length, ok, failed };
    }

    /**
     * Advance one tick: flush external commands -> integrate -> damage -> emit ->
     * flush structural system commands -> tick++.
     */
    step() {
      const t = this.tick;
      const report = {
        tick: t,
        external: { count: 0, ok: 0, failed: 0 },
        integrate: { count: 0, overflow: 0 },
        damage: { count: 0, overflow: 0, queuedDestroy: 0 },
        emit: { count: 0 },
        structural: { count: 0, ok: 0, failed: 0 },
        spawned: [],
        destroyed: [],
        migrations: 0,
      };
      this.emit({ tick: t, type: 'tick', phase: 'start' });

      report.external = this.flushExternal();
      this.runIntegrate(report);
      this.runDamage(report);
      this.runEmit(report);
      report.structural = this.flushSystem();

      this.tick = t + 1;
      this.lastTickReport = report;
      this.emit({ tick: t, type: 'tick', phase: 'end', summary: {
        external: report.external.count,
        externalFailed: report.external.failed,
        integrate: report.integrate.count,
        damage: report.damage.count,
        spawned: report.emit.count,
        structural: report.structural.count,
        structuralFailed: report.structural.failed,
        alive: this.aliveCount,
      } });
      return report;
    }

    stepMany(n) {
      const reports = [];
      for (let i = 0; i < n; i++) reports.push(this.step());
      return reports;
    }

    // ---- inspection ---------------------------------------------------------
    entityView(handle) {
      const loc = this.locate(handle);
      if (loc.error) return { valid: false, error: loc.error, handle };
      const p = this.prototypes.get(loc.mask);
      return {
        valid: true,
        handle: { slot: loc.slot, generation: loc.generation },
        mask: loc.mask,
        key: p.key,
        components: p.components,
        row: loc.row,
        rowCount: p.slots.length,
        values: this.readRow(loc.mask, loc.row),
        slotCount: this.slotGen.length,
      };
    }

    prototypesView() {
      const out = [];
      for (const p of this.prototypes.values()) {
        out.push({
          mask: p.mask,
          key: p.key,
          components: p.components,
          count: p.slots.length,
          slots: p.slots.slice(),
          generations: p.gens.slice(),
          columns: p.columns,
        });
      }
      return out;
    }

    slotView() {
      return this.slotGen.map((gen, slot) => ({
        slot,
        generation: gen,
        alive: !!this.alive[slot],
        mask: this.slotProto[slot],
        row: this.slotRow[slot],
      }));
    }

    stats() {
      return {
        tick: this.tick,
        alive: this.aliveCount,
        maxEntities: MAX_ENTITIES,
        slots: this.slotGen.length,
        freeSlots: this.free.size,
        prototypes: this.prototypes.size,
        externalPending: this.externalPending.length,
        systemPending: this.systemPending.length,
        externalSeqHistory: this.externalSeqHistory.size,
        internalCounter: this.internalCounter,
        events: this.eventsTotal,
        eventDigest: ('00000000' + this.eventDigest.toString(16)).slice(-8),
        nextHandleSlot: this.free.size ? this.free.peek() : this.slotGen.length,
      };
    }

    // ---- snapshot -----------------------------------------------------------
    save() {
      const prototypes = [];
      for (const p of this.prototypes.values()) {
        const columns = {};
        for (const name of p.components) {
          columns[name] = {};
          for (const f of FIELDS[name]) columns[name][f] = p.columns[name][f].slice();
        }
        prototypes.push({
          mask: p.mask,
          key: p.key,
          components: p.components.slice(),
          slots: p.slots.slice(),
          generations: p.gens.slice(),
          columns,
        });
      }
      return {
        format: FORMAT,
        version: SNAPSHOT_VERSION,
        tick: this.tick,
        slotGenerations: this.slotGen.slice(),
        freeSlots: this.free.toSortedArray(),
        prototypes,
        slotProto: this.slotProto.slice(),
        slotRow: this.slotRow.slice(),
        externalPending: this.externalPending.map(cloneCommand),
        systemPending: this.systemPending.map(cloneCommand),
        externalSeqHistory: Array.from(this.externalSeqHistory).sort((a, b) => a - b),
        lastAppliedSeq: this.lastAppliedSeq,
        internalCounter: this.internalCounter,
        eventSeq: this.eventSeq,
        eventsTotal: this.eventsTotal,
        eventDigest: this.eventDigest,
        events: this.events.slice(-MAX_SNAPSHOT_EVENTS).map(cloneEvent),
        eventsTruncated: Math.max(0, this.eventsTotal - Math.min(this.events.length, MAX_SNAPSHOT_EVENTS)),
      };
    }

    static fromSnapshot(snap) {
      if (!snap || snap.format !== FORMAT) throw new Error('不是本调试台的快照');
      if (snap.version !== SNAPSHOT_VERSION) throw new Error('不支持的快照版本: ' + snap.version);
      const w = new World();
      w.tick = snap.tick;
      w.slotGen = snap.slotGenerations.slice();
      w.alive = w.slotGen.map(() => false);
      w.slotProto = w.slotGen.map(() => -1);
      w.slotRow = w.slotGen.map(() => -1);
      const freeSet = new Set();
      for (const s of snap.freeSlots) {
        if (!isInt(s) || s < 0 || s >= w.slotGen.length) throw new Error('快照空槽非法: ' + s);
        freeSet.add(s);
      }
      w.free = MinHeap.fromArray(snap.freeSlots);
      w.prototypes = new Map();
      for (const ps of snap.prototypes) {
        const p = {
          mask: ps.mask,
          key: ps.key,
          components: ps.components.slice(),
          slots: ps.slots.slice(),
          gens: ps.generations.slice(),
          columns: {},
        };
        for (const name of p.components) {
          p.columns[name] = {};
          for (const f of FIELDS[name]) p.columns[name][f] = ps.columns[name][f].slice();
        }
        w.prototypes.set(ps.mask, p);
      }
      w.slotProto = snap.slotProto.slice();
      w.slotRow = snap.slotRow.slice();
      let aliveCount = 0;
      for (let slot = 0; slot < w.slotGen.length; slot++) {
        const isFree = freeSet.has(slot);
        if (!isFree) {
          if (w.slotProto[slot] < 0) throw new Error('快照不一致: 槽 ' + slot + ' 既不在空槽集也不在原型中');
          aliveCount++;
          const p = w.prototypes.get(w.slotProto[slot]);
          if (!p) throw new Error('快照不一致: 原型缺失 ' + w.slotProto[slot]);
          const row = w.slotRow[slot];
          if (p.slots[row] !== slot || p.gens[row] !== w.slotGen[slot]) {
            throw new Error('快照不一致: 句柄映射槽 ' + slot);
          }
        }
      }
      w.aliveCount = aliveCount;
      for (const p of w.prototypes.values()) {
        for (let r = 0; r < p.slots.length; r++) w.alive[p.slots[r]] = true;
      }
      w.externalPending = snap.externalPending.map(cloneCommand);
      w.systemPending = snap.systemPending.map(cloneCommand);
      valsortPending(w.externalPending);
      w.externalSeqHistory = new Set(snap.externalSeqHistory);
      w.lastAppliedSeq = snap.lastAppliedSeq;
      w.internalCounter = snap.internalCounter;
      w.eventSeq = snap.eventSeq;
      w.eventsTotal = snap.eventsTotal !== undefined ? snap.eventsTotal : snap.eventSeq;
      w.eventDigest = snap.eventDigest >>> 0;
      w.events = (snap.events || []).map(cloneEvent);
      w.eventsTruncated = snap.eventsTruncated || 0;
      w.lastTickReport = null;
      return w;
    }

    /**
     * Identity of the whole world state including the event trace. The in-memory
     * event list is capped, so the digest (which covers every event ever emitted)
     * is what makes a resumed run comparable to an uninterrupted one.
     */
    digest() {
      const snap = this.save();
      snap.events = [];
      return fnv1a(JSON.stringify(snap));
    }
  }

  function valsortPending(arr) {
    // Sort by seq; malformed seq entries go last in their original order.
    arr.forEach((c, i) => { c.__ord = i; });
    arr.sort((a, b) => {
      const sa = isInt(a && a.seq) ? a.seq : Infinity;
      const sb = isInt(b && b.seq) ? b.seq : Infinity;
      if (sa !== sb) return sa - sb;
      return a.__ord - b.__ord;
    });
    for (const c of arr) delete c.__ord;
  }

  function cloneCommand(c) {
    return JSON.parse(JSON.stringify(c));
  }
  function cloneEvent(e) {
    return JSON.parse(JSON.stringify(e));
  }

  function fnv1aStep(h, str) {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function fnv1a(str) {
    return ('00000000' + fnv1aStep(0x811c9dc5, str).toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------------------
  // Scenario helpers (used by tests and the page's sample loaders)
  // ---------------------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The generated 20000-command pressure sample, identical to stress.json. */
  function stressCommands() {
    const cmds = [];
    for (let i = 0; i < 10000; i++) {
      cmds.push({
        seq: i + 1, op: 'create',
        components: { Position: { x: i, y: 0 }, Velocity: { x: 1, y: 0 } },
      });
    }
    for (let i = 0; i < 10000; i++) {
      cmds.push({
        seq: 10001 + i, op: 'add',
        handle: { slot: i, generation: 1 },
        component: 'Frozen', value: {},
      });
    }
    return cmds;
  }

  return {
    World,
    ValidationError,
    constants: {
      FORMAT, SNAPSHOT_VERSION, INT32_MIN, INT32_MAX, MAX_ENTITIES,
      MAX_EXTERNAL_PENDING, COMPONENTS, BIT, FIELDS,
    },
    helpers: {
      maskOf, namesOfMask, maskKey, normalizeComponents, normalizeComponentValue,
      inInt32, isInt, mulberry32, stressCommands,
    },
  };
});
