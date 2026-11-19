// RTS 生产队列模拟引擎 —— 固定 100ms 逻辑步、精确有理数账本。
// 规则来源：样例包 说明.txt。所有工作量/速度/倍率均为 Fraction（BigInt），
// 资源与人口为整数 BigInt，分数累计绝不经过浮点。

import { Fraction } from './fraction.js';

const MAX_BUILDINGS = 32;
const MAX_QUEUE = 8;

// ---------- 输入校验与构造 ----------

function asInt(v, name) {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`参数 ${name} 必须是整数`);
}
function asNonNegInt(v, name) {
  const x = asInt(v, name);
  if (x < 0n) throw new Error(`参数 ${name} 不能为负`);
  return x;
}
function asPosFraction(v, name) {
  const f = Fraction.from(v);
  if (!f.isPositive()) throw new Error(`参数 ${name} 必须为正有理数`);
  return f;
}

export class Engine {
  // raw: 用例 JSON（resources/catalog/commands 等）
  constructor(raw) {
    this.events = [];
    this.tick = 0;
    this.commandSeqCounter = new Map(); // tick -> 已用 seq（含预置与实时指令）

    this.resources = new Map();
    this.resourceCaps = new Map();
    for (const [k, v] of Object.entries(raw.resources ?? {})) {
      this.resources.set(k, asInt(v, `resources.${k}`));
    }
    for (const [k, v] of Object.entries(raw.resourceCaps ?? {})) {
      const cap = asNonNegInt(v, `resourceCaps.${k}`);
      this.resourceCaps.set(k, cap);
      if (!this.resources.has(k)) this.resources.set(k, 0n);
      if (this.resources.get(k) > cap) this.resources.set(k, cap);
    }
    this.usedPopulation = asNonNegInt(raw.usedPopulation ?? 0, 'usedPopulation');
    this.populationCap = asNonNegInt(raw.populationCap ?? 0, 'populationCap');
    if (this.usedPopulation > this.populationCap) {
      throw new Error('初始 usedPopulation 超过 populationCap');
    }
    this.speedMultiplier = asPosFraction(raw.speedMultiplier ?? [1, 1], 'speedMultiplier');
    this.pendingMultipliers = []; // 上一步完成的科技，本步指令阶段后乘入

    // catalog
    this.catalog = new Map();
    for (const [id, def] of Object.entries(raw.catalog ?? {})) {
      this.catalog.set(id, this.#parseItemDef(id, def));
    }

    // buildings（按 ID 升序处理，遍历顺序不依赖插入偶然性）
    const ids = Object.keys(Object.fromEntries(
      (raw.buildings ?? []).map(b => [b.id, true])
    ));
    const rawBuildings = [...(raw.buildings ?? [])];
    rawBuildings.sort((a, b) => compareId(a.id, b.id));
    if (rawBuildings.length > MAX_BUILDINGS) {
      throw new Error(`建筑数量超过上限 ${MAX_BUILDINGS}`);
    }
    if (new Set(rawBuildings.map(b => b.id)).size !== rawBuildings.length) {
      throw new Error('建筑 ID 重复');
    }
    this.buildingOrder = [];
    this.buildings = new Map();
    for (const b of rawBuildings) {
      if (typeof b.id !== 'string' || b.id === '') throw new Error('建筑 ID 非法');
      const inst = {
        id: b.id,
        speed: asPosFraction(b.speed, `building.${b.id}.speed`),
        paused: !!b.paused,
        destroyed: false,
        queue: [],
      };
      this.buildingOrder.push(b.id);
      this.buildings.set(b.id, inst);
    }

    // 初始实例：建筑 ID 升序、各队列从前到后分配 1 起递增编号；视为已付款、进度 0
    this.nextInstanceId = 1;
    this.instanceIndex = new Map();
    for (const bid of this.buildingOrder) {
      const b = this.buildings.get(bid);
      const itemIds = rawBuildings.find(x => x.id === bid).queue ?? [];
      if (itemIds.length > MAX_QUEUE) throw new Error(`建筑 ${bid} 队列超过 ${MAX_QUEUE}`);
      for (const itemId of itemIds) {
        this.#addInstance(b, itemId, /*paid*/ true);
      }
    }

    // 预置指令按 tick 归档，seq 登记
    this.commandsByTick = new Map();
    for (const c of raw.commands ?? []) {
      const t = Number(asInt(c.tick, 'command.tick'));
      if (t < 0) throw new Error('指令 tick 不能为负');
      this.#registerSeq(t, asInt(c.seq, 'command.seq'));
      if (!this.commandsByTick.has(t)) this.commandsByTick.set(t, []);
      this.commandsByTick.get(t).push({ ...c });
    }
    for (const list of this.commandsByTick.values()) {
      list.sort((a, b) => Number(a.seq - b.seq) || 0);
    }
  }

  #parseItemDef(id, def) {
    const work = asInt(def.work, `catalog.${id}.work`);
    if (work <= 0n) throw new Error(`catalog.${id}.work 必须为正整数`);
    const cost = new Map();
    for (const [r, v] of Object.entries(def.cost ?? {})) {
      cost.set(r, asNonNegInt(v, `catalog.${id}.cost.${r}`));
    }
    if (def.kind !== 'unit' && def.kind !== 'research') {
      throw new Error(`catalog.${id}.kind 非法`);
    }
    const out = { itemId: id, work, cost, kind: def.kind };
    if (def.kind === 'unit') {
      out.population = asNonNegInt(def.population, `catalog.${id}.population`);
    } else {
      out.multiplier = asPosFraction(def.multiplier, `catalog.${id}.multiplier`);
    }
    return out;
  }

  #registerSeq(tick, seq) {
    const key = `${tick}`;
    const used = this.commandSeqCounter.get(key) ?? new Set();
    if (used.has(seq.toString())) throw new Error(`tick ${tick} seq ${seq} 重复`);
    used.add(seq.toString());
    this.commandSeqCounter.set(key, used);
  }

  #nextSeq(tick) {
    const key = `${tick}`;
    const used = this.commandSeqCounter.get(key) ?? new Set();
    let s = 1n;
    while (used.has(s.toString())) s += 1n;
    used.add(s.toString());
    this.commandSeqCounter.set(key, used);
    return s;
  }

  #addInstance(b, itemId, paid) {
    const def = this.catalog.get(itemId);
    if (!def) throw new Error(`未知项目 ${itemId}`);
    if (b.queue.length >= MAX_QUEUE) throw new Error(`建筑 ${b.id} 队列已满`);
    const inst = {
      instanceId: this.nextInstanceId++,
      itemId,
      def,
      progress: Fraction.ZERO,
      workApplied: false,
      ready: false,
    };
    b.queue.push(inst);
    this.instanceIndex.set(inst.instanceId, inst);
    return inst;
  }

  // ---------- 资源/人口小工具（全部留痕） ----------

  #getResource(r) { return this.resources.get(r) ?? 0n; }

  #changeResource(r, delta, source, reason) {
    const before = this.#getResource(r);
    let after = before + delta;
    let clamped = false;
    const cap = this.resourceCaps.get(r);
    if (cap !== undefined && after > cap) { after = cap; clamped = true; }
    if (after < 0n) { after = 0n; clamped = true; }
    this.resources.set(r, after);
    this.events.push({
      tick: this.tick, source, kind: 'resource', resource: r,
      before: before.toString(), after: after.toString(),
      delta: (after - before).toString(),
      intendedDelta: delta.toString(), reason,
      clamped,
    });
    return after;
  }

  #changePopulation(delta, source, reason) {
    const before = this.usedPopulation;
    const after = before + delta;
    this.usedPopulation = after;
    this.events.push({
      tick: this.tick, source, kind: 'population',
      before: before.toString(), after: after.toString(),
      delta: delta.toString(), reason,
    });
  }

  #canAfford(cost) {
    for (const [r, v] of cost) {
      if (this.#getResource(r) < v) return false;
    }
    return true;
  }

  // ---------- 指令 ----------

  // 实时编辑（界面操作）：登记到当前 tick 的指令表，下一次 step() 的指令阶段执行。
  // 编辑只发生在 tick 边界（暂停态），tick+seq 使保存/恢复与回放完全确定。
  scheduleLive(command) {
    const t = this.tick;
    const seq = this.#nextSeq(t);
    const entry = { ...command, tick: t, seq: Number(seq) };
    if (!this.commandsByTick.has(t)) this.commandsByTick.set(t, []);
    this.commandsByTick.get(t).push(entry);
    this.commandsByTick.get(t).sort((a, b) => Number(a.seq - b.seq));
    return entry;
  }

  #executeCommand(c) {
    const source = { seq: c.seq.toString(), op: c.op };
    const reject = (reason) => {
      this.events.push({ tick: this.tick, source, kind: 'command', op: c.op, accepted: false, reason });
    };
    try {
      switch (c.op) {
        case 'enqueue': {
          const b = this.buildings.get(c.building);
          if (!b || b.destroyed) return reject('建筑不存在或已摧毁');
          const def = this.catalog.get(c.item);
          if (!def) return reject('未知项目');
          if (b.queue.length >= MAX_QUEUE) return reject('队列已满（8）');
          if (!this.#canAfford(def.cost)) return reject('资源不足');
          for (const [r, v] of def.cost) this.#changeResource(r, -v, source, 'enqueue');
          const inst = this.#addInstance(b, c.item, false);
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'enqueue', accepted: true,
            building: b.id, instance: inst.instanceId, item: c.item,
          });
          break;
        }
        case 'cancel': {
          const instId = Number(asInt(c.instance, 'instance'));
          const inst = this.instanceIndex.get(instId);
          if (!inst) return reject('实例不存在');
          const owner = this.#findOwner(instId);
          if (!owner) return reject('实例不存在');
          if (inst.ready) {
            // ready 不退，直接移除
            this.#removeInstance(owner, inst);
            this.events.push({
              tick: this.tick, source, kind: 'command', op: 'cancel', accepted: true,
              building: owner.id, instance: instId, item: inst.itemId, refunded: false,
            });
            break;
          }
          // 逐资源退款 floor(cost * (work - progress) / work)，再按仓库上限截断
          const remainingRatio = Fraction.from(inst.def.work).sub(inst.progress)
            .div(Fraction.from(inst.def.work));
          const refunds = [];
          for (const [r, cost] of inst.def.cost) {
            const exact = Fraction.from(cost).mul(remainingRatio);
            const refund = exact.floor(); // BigInt，精确向下取整
            this.#changeResource(r, refund, source, 'cancel');
            refunds.push({ resource: r, refund: refund.toString() });
          }
          this.#removeInstance(owner, inst);
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'cancel', accepted: true,
            building: owner.id, instance: instId, item: inst.itemId, refunded: true, refunds,
          });
          break;
        }
        case 'reorder': {
          const b = this.buildings.get(c.building);
          if (!b || b.destroyed) return reject('建筑不存在或已摧毁');
          if (!Array.isArray(c.order)) return reject('order 必须是实例编号数组');
          const waiting = b.queue.filter(x => !x.workApplied && !x.ready);
          const wanted = [];
          const seen = new Set();
          for (const v of c.order) {
            const id = Number(asInt(v, 'order[]'));
            const inst = this.instanceIndex.get(id);
            if (!inst || !b.queue.includes(inst)) return reject('重排包含不属于该队列的实例');
            if (inst.workApplied || inst.ready) return reject('只允许重排尚未取得工作量的非 ready 实例');
            if (seen.has(id)) return reject('重排顺序存在重复实例');
            seen.add(id);
            wanted.push(inst);
          }
          if (wanted.length !== waiting.length ||
              waiting.some(x => !seen.has(x.instanceId))) {
            return reject('重排必须是等待实例的完整新顺序');
          }
          // 固定实例（已取得工作量或 ready）位置不动，等待槽位按新顺序填入
          let wi = 0;
          b.queue = b.queue.map(x => (x.workApplied || x.ready) ? x : wanted[wi++]);
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'reorder', accepted: true,
            building: b.id,
            order: b.queue.map(x => x.instanceId),
          });
          break;
        }
        case 'pause': {
          const b = this.buildings.get(c.building);
          if (!b || b.destroyed) return reject('建筑不存在或已摧毁');
          if (typeof c.paused !== 'boolean') return reject('paused 必须是布尔值');
          b.paused = c.paused;
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'pause', accepted: true,
            building: b.id, paused: b.paused,
          });
          break;
        }
        case 'destroy': {
          const b = this.buildings.get(c.building);
          if (!b || b.destroyed) return reject('建筑不存在或已摧毁');
          const removed = b.queue.map(x => x.instanceId);
          for (const inst of b.queue) this.instanceIndex.delete(inst.instanceId);
          b.queue = [];
          b.destroyed = true;
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'destroy', accepted: true,
            building: b.id, removed,
          });
          break;
        }
        case 'grant': {
          const amount = asNonNegInt(c.amount, 'amount');
          if (typeof c.resource !== 'string' || c.resource === '') return reject('resource 非法');
          this.#changeResource(c.resource, amount, source, 'grant');
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'grant', accepted: true,
            resource: c.resource, amount: amount.toString(),
          });
          break;
        }
        case 'release': {
          const amount = asNonNegInt(c.amount, 'amount');
          if (amount > this.usedPopulation) return reject('释放人口超过已用人口');
          if (amount > 0n) this.#changePopulation(-amount, source, 'release');
          this.events.push({
            tick: this.tick, source, kind: 'command', op: 'release', accepted: true,
            amount: amount.toString(),
          });
          break;
        }
        default:
          return reject(`未知指令 ${c.op}`);
      }
    } catch (e) {
      reject(e.message);
    }
  }

  #findOwner(instanceId) {
    for (const bid of this.buildingOrder) {
      const b = this.buildings.get(bid);
      if (b.queue.some(x => x.instanceId === instanceId)) return b;
    }
    return null;
  }

  #removeInstance(b, inst) {
    const i = b.queue.indexOf(inst);
    if (i >= 0) b.queue.splice(i, 1);
    this.instanceIndex.delete(inst.instanceId);
  }

  // ---------- 单步推进 ----------

  step() {
    const tick = this.tick;

    // 1) 按 seq 执行本 tick 指令
    const cmds = this.commandsByTick.get(tick) ?? [];
    for (const c of cmds) this.#executeCommand(c);

    // 2) 应用上步完成的科技（乘入全局倍率，本步生效）
    if (this.pendingMultipliers.length) {
      const before = this.speedMultiplier;
      for (const m of this.pendingMultipliers) {
        this.speedMultiplier = this.speedMultiplier.mul(m);
      }
      this.events.push({
        tick, source: { system: true }, kind: 'speedMultiplier',
        before: before.toJSON(), after: this.speedMultiplier.toJSON(),
        applied: this.pendingMultipliers.map(m => m.toJSON()),
      });
      this.pendingMultipliers = [];
    }

    // 3) 按建筑 ID 升序处理
    for (const bid of this.buildingOrder) {
      const b = this.buildings.get(bid);
      if (b.destroyed || b.paused) continue;

      // 3a) 先尝试交付队首 ready 成品，能交付才继续
      if (b.queue.length && b.queue[0].ready) {
        if (!this.#tryDeliver(b, b.queue[0])) continue; // 人口卡住：本步结束
      }

      // 3b) 本步预算 = 建筑 speed * 全局倍率；不保留跨 tick 预算
      let budget = b.speed.mul(this.speedMultiplier);

      while (budget.isPositive() && b.queue.length) {
        const inst = b.queue[0];
        if (inst.ready) {
          // 队首 ready 且无法交付：丢弃本步剩余预算
          this.events.push({
            tick, source: { building: b.id, instance: inst.instanceId },
            kind: 'blocked', item: inst.itemId, reason: 'population',
            discardedBudget: budget.toJSON(),
          });
          break;
        }
        const remaining = Fraction.from(inst.def.work).sub(inst.progress);
        const source = { building: b.id, instance: inst.instanceId };
        let delta;
        if (budget.lt(remaining)) {
          delta = budget;
          inst.progress = inst.progress.add(delta);
          inst.workApplied = true;
          budget = Fraction.ZERO;
        } else {
          delta = remaining;
          inst.progress = Fraction.from(inst.def.work);
          inst.workApplied = true;
          budget = budget.sub(remaining);
        }
        this.events.push({
          tick, source, kind: 'work', item: inst.itemId,
          delta: delta.toJSON(),
          progressBefore: inst.progress.sub(delta).toJSON(),
          progressAfter: inst.progress.toJSON(),
          work: inst.def.work.toString(),
          budgetAfter: budget.toJSON(),
        });

        if (!inst.progress.eq(Fraction.from(inst.def.work))) break; // 未完成，预算耗尽

        // 完成
        if (inst.def.kind === 'research') {
          // research 立即移除，倍率累积到下一 tick
          this.pendingMultipliers.push(inst.def.multiplier);
          this.events.push({
            tick, source, kind: 'complete', item: inst.itemId,
            itemKind: 'research', multiplier: inst.def.multiplier.toJSON(),
            takesEffectTick: tick + 1,
          });
          this.#removeInstance(b, inst);
          // 剩余预算给下一项
        } else {
          // unit：能交付则移除并把剩余预算给下一项；超人口则保留 ready、丢弃剩余预算
          if (this.#canDeliver(inst)) {
            this.#deliver(b, inst);
            // 剩余预算继续循环
          } else {
            inst.ready = true;
            this.events.push({
              tick, source, kind: 'ready', item: inst.itemId, reason: 'population',
              usedPopulation: this.usedPopulation.toString(),
              populationCap: this.populationCap.toString(),
              discardedBudget: budget.toJSON(),
            });
            this.events.push({
              tick, source, kind: 'blocked', item: inst.itemId, reason: 'population',
              discardedBudget: budget.toJSON(),
            });
            break;
          }
        }
      }
    }

    this.tick += 1;
  }

  #canDeliver(inst) {
    return this.usedPopulation + inst.def.population <= this.populationCap;
  }

  #tryDeliver(b, inst) {
    if (this.#canDeliver(inst)) {
      this.#deliver(b, inst);
      return true;
    }
    this.events.push({
      tick: this.tick, source: { building: b.id, instance: inst.instanceId },
      kind: 'blocked', item: inst.itemId, reason: 'population',
      usedPopulation: this.usedPopulation.toString(),
      populationCap: this.populationCap.toString(),
    });
    return false;
  }

  #deliver(b, inst) {
    this.#changePopulation(inst.def.population,
      { building: b.id, instance: inst.instanceId }, 'deliver');
    this.events.push({
      tick: this.tick, source: { building: b.id, instance: inst.instanceId },
      kind: 'complete', item: inst.itemId, itemKind: 'unit',
      population: inst.def.population.toString(),
    });
    this.#removeInstance(b, inst);
  }

  runTo(tick) {
    while (this.tick < tick) this.step();
  }

  // ---------- 状态快照（保存/恢复，无损） ----------

  snapshot() {
    return JSON.stringify(serialize(this));
  }

  #serialize() {
    return {
      version: 1,
      tick: this.tick,
      resources: Object.fromEntries([...this.resources].map(([k, v]) => [k, v.toString()])),
      resourceCaps: Object.fromEntries([...this.resourceCaps].map(([k, v]) => [k, v.toString()])),
      usedPopulation: this.usedPopulation.toString(),
      populationCap: this.populationCap.toString(),
      speedMultiplier: this.speedMultiplier.toJSON(),
      pendingMultipliers: this.pendingMultipliers.map(m => m.toJSON()),
      catalog: [...this.catalog].map(([id, d]) => [id, {
        work: d.work.toString(),
        cost: Object.fromEntries([...d.cost].map(([r, v]) => [r, v.toString()])),
        kind: d.kind,
        population: d.population?.toString(),
        multiplier: d.multiplier?.toJSON(),
      }]),
      buildings: this.buildingOrder.map(bid => {
        const b = this.buildings.get(bid);
        return {
          id: b.id, speed: b.speed.toJSON(), paused: b.paused, destroyed: b.destroyed,
          queue: b.queue.map(i => ({
            instanceId: i.instanceId, itemId: i.itemId,
            progress: i.progress.toJSON(), workApplied: i.workApplied, ready: i.ready,
          })),
        };
      }),
      nextInstanceId: this.nextInstanceId,
      commandsByTick: [...this.commandsByTick.entries()].map(([t, list]) => [t, list]),
      commandSeqCounter: [...this.commandSeqCounter.entries()].map(([k, set]) => [k, [...set]]),
      events: this.events,
    };
  }

  static restore(json) {
    return restoreSnapshot(JSON.parse(json));
  }
}

function serialize(eng) {
  return {
    version: 1,
    tick: eng.tick,
    resources: Object.fromEntries([...eng.resources].map(([k, v]) => [k, v.toString()])),
    resourceCaps: Object.fromEntries([...eng.resourceCaps].map(([k, v]) => [k, v.toString()])),
    usedPopulation: eng.usedPopulation.toString(),
    populationCap: eng.populationCap.toString(),
    speedMultiplier: eng.speedMultiplier.toJSON(),
    pendingMultipliers: eng.pendingMultipliers.map(m => m.toJSON()),
    catalog: [...eng.catalog].map(([id, d]) => [id, {
      work: d.work.toString(),
      cost: Object.fromEntries([...d.cost].map(([r, v]) => [r, v.toString()])),
      kind: d.kind,
      population: d.population?.toString(),
      multiplier: d.multiplier?.toJSON(),
    }]),
    buildings: eng.buildingOrder.map(bid => {
      const b = eng.buildings.get(bid);
      return {
        id: b.id, speed: b.speed.toJSON(), paused: b.paused, destroyed: b.destroyed,
        queue: b.queue.map(i => ({
          instanceId: i.instanceId, itemId: i.itemId,
          progress: i.progress.toJSON(), workApplied: i.workApplied, ready: i.ready,
        })),
      };
    }),
    nextInstanceId: eng.nextInstanceId,
    commandsByTick: [...eng.commandsByTick.entries()].map(([t, list]) => [t, list]),
    commandSeqCounter: [...eng.commandSeqCounter.entries()].map(([k, set]) => [k, [...set]]),
    events: eng.events,
  };
}

function restoreSnapshot(s) {
  const eng = Object.create(Engine.prototype);
  eng.events = s.events;
  eng.tick = s.tick;
  eng.resources = new Map(Object.entries(s.resources).map(([k, v]) => [k, BigInt(v)]));
  eng.resourceCaps = new Map(Object.entries(s.resourceCaps).map(([k, v]) => [k, BigInt(v)]));
  eng.usedPopulation = BigInt(s.usedPopulation);
  eng.populationCap = BigInt(s.populationCap);
  eng.speedMultiplier = Fraction.from(s.speedMultiplier);
  eng.pendingMultipliers = s.pendingMultipliers.map(Fraction.from);
  eng.catalog = new Map(s.catalog.map(([id, d]) => [id, {
    itemId: id,
    work: BigInt(d.work),
    cost: new Map(Object.entries(d.cost).map(([r, v]) => [r, BigInt(v)])),
    kind: d.kind,
    population: d.population !== undefined ? BigInt(d.population) : undefined,
    multiplier: d.multiplier ? Fraction.from(d.multiplier) : undefined,
  }]));
  eng.buildingOrder = s.buildings.map(b => b.id);
  eng.buildings = new Map();
  eng.instanceIndex = new Map();
  eng.nextInstanceId = s.nextInstanceId;
  for (const bs of s.buildings) {
    const b = {
      id: bs.id, speed: Fraction.from(bs.speed), paused: bs.paused,
      destroyed: bs.destroyed, queue: [],
    };
    for (const is of bs.queue) {
      const def = eng.catalog.get(is.itemId);
      const inst = {
        instanceId: is.instanceId, itemId: is.itemId, def,
        progress: Fraction.from(is.progress),
        workApplied: is.workApplied, ready: is.ready,
      };
      b.queue.push(inst);
      eng.instanceIndex.set(inst.instanceId, inst);
    }
    eng.buildings.set(b.id, b);
  }
  eng.commandsByTick = new Map(s.commandsByTick.map(([t, list]) => [Number(t), list]));
  eng.commandSeqCounter = new Map(
    s.commandSeqCounter.map(([k, arr]) => [k, new Set(arr)])
  );
  return eng;
}

function compareId(a, b) {
  // 代码点升序，与 locale 无关
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
