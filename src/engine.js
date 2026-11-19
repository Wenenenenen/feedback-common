// 战斗状态效果演算引擎（纯计算，无 DOM 依赖，可在浏览器与 Node 中运行）
// 时间单位：整数毫秒。调度方式：事件队列 + 最小堆，绝不按帧轮询。
// 同刻顺序：外部事件(seq 升序) -> DoT 跳伤(实例编号升序) -> 到期(实例编号升序)

export const LIMITS = Object.freeze({
  MAX_ACTORS: 64,
  MAX_ACTIVE_EFFECTS: 256,
  MAX_EVENTS: 5000,
  MAX_EXTERNAL_TIME: 60000,
});

// 内部任务的相位顺序：跳伤先于到期
const PHASE_TICK = 0;
const PHASE_EXPIRE = 1;

class MinHeap {
  constructor(less) {
    this.a = [];
    this.less = less;
  }
  get size() {
    return this.a.length;
  }
  top() {
    return this.a[0];
  }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(a[l], a[m])) m = l;
        if (r < n && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const taskLess = (x, y) => {
  if (x.time !== y.time) return x.time < y.time;
  if (x.phase !== y.phase) return x.phase < y.phase;
  return x.instanceId < y.instanceId;
};

function isPosInt(v) {
  return Number.isInteger(v) && v > 0;
}

// 完整结构校验，返回错误字符串数组（空数组表示通过）
export function validateConfig(cfg) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);

  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['根节点: 必须是对象 {actors, definitions, events}'];
  }
  const { actors, definitions, events } = cfg;

  // ---- 角色 ----
  if (!Array.isArray(actors)) {
    err('actors', '必须是数组');
  } else {
    if (actors.length === 0) err('actors', '至少需要 1 个角色');
    if (actors.length > LIMITS.MAX_ACTORS) err('actors', `最多 ${LIMITS.MAX_ACTORS} 个角色，当前 ${actors.length}`);
    const actorIds = new Set();
    actors.forEach((ac, i) => {
      const p = `actors[${i}]`;
      if (!ac || typeof ac !== 'object') return err(p, '必须是对象');
      if (typeof ac.id !== 'string' || ac.id.length === 0) return err(p, 'id 必须是非空字符串');
      if (actorIds.has(ac.id)) err(p, `角色 id 重复: ${ac.id}`);
      actorIds.add(ac.id);
      if (!isPosInt(ac.maxHp)) err(p, 'maxHp 必须是正整数');
      if (!Number.isInteger(ac.hp) || ac.hp < 0) err(p, 'hp 必须是非负整数');
      if (Number.isInteger(ac.maxHp) && Number.isInteger(ac.hp) && ac.hp > ac.maxHp) {
        err(p, 'hp 不能超过 maxHp');
      }
    });
  }

  // ---- 定义 ----
  const defIds = new Set();
  if (!Array.isArray(definitions)) {
    err('definitions', '必须是数组');
  } else {
    if (definitions.length === 0) err('definitions', '至少需要 1 条定义');
    definitions.forEach((d, i) => {
      const p = `definitions[${i}]`;
      if (!d || typeof d !== 'object') return err(p, '必须是对象');
      if (typeof d.id !== 'string' || d.id.length === 0) return err(p, 'id 必须是非空字符串');
      if (defIds.has(d.id)) err(p, `定义 id 重复: ${d.id}`);
      defIds.add(d.id);
      if (d.kind !== 'dot' && d.kind !== 'shield') err(p, 'kind 只能是 dot 或 shield');
      if (d.stack !== 'refresh' && d.stack !== 'independent') err(p, 'stack 只能是 refresh 或 independent');
      if (!isPosInt(d.cap)) err(p, 'cap 必须是正整数');
      if (d.stack === 'refresh' && d.cap !== 1) err(p, 'refresh 的 cap 必须为 1');
      if (!isPosInt(d.duration)) err(p, 'duration 必须是正整数');
      if (!isPosInt(d.amount)) err(p, 'amount 必须是正整数');
      if (d.kind === 'dot') {
        if (!('period' in d)) err(p, 'dot 必须包含 period');
        else if (!isPosInt(d.period)) err(p, 'period 必须是正整数');
      } else if ('period' in d) {
        err(p, 'shield 不能包含 period');
      }
    });
  }

  // ---- 外部事件 ----
  if (!Array.isArray(events)) {
    err('events', '必须是数组');
  } else {
    if (events.length > LIMITS.MAX_EVENTS) err('events', `最多 ${LIMITS.MAX_EVENTS} 条事件，当前 ${events.length}`);
    const evIds = new Set();
    const seqs = new Set();
    const actorIds = new Set((actors || []).map((a) => a.id));
    events.forEach((e, i) => {
      const p = `events[${i}]`;
      if (!e || typeof e !== 'object') return err(p, '必须是对象');
      if (typeof e.id !== 'string' || e.id.length === 0) return err(p, 'id 必须是非空字符串');
      if (evIds.has(e.id)) err(p, `事件 id 重复: ${e.id}`);
      evIds.add(e.id);
      if (!Number.isInteger(e.seq)) return err(p, 'seq 必须是整数');
      if (seqs.has(e.seq)) err(p, `seq 重复: ${e.seq}`);
      seqs.add(e.seq);
      if (!Number.isInteger(e.time) || e.time < 0 || e.time > LIMITS.MAX_EXTERNAL_TIME) {
        err(p, `time 必须是 0..${LIMITS.MAX_EXTERNAL_TIME} 之间的整数`);
      }
      if (!['apply', 'damage', 'heal', 'cleanse'].includes(e.op)) err(p, 'op 只能是 apply/damage/heal/cleanse');
      if (typeof e.target !== 'string' || !actorIds.has(e.target)) err(p, 'target 必须引用已存在的角色');
      if (e.op === 'apply' || e.op === 'cleanse') {
        if (typeof e.effect !== 'string' || !defIds.has(e.effect)) err(p, 'effect 必须引用已存在的定义');
      }
      if (e.op === 'damage' || e.op === 'heal') {
        if (!isPosInt(e.amount)) err(p, 'amount 必须是正整数');
      }
    });
  }
  return errors;
}

export function simulate(rawCfg) {
  const errors = validateConfig(rawCfg);
  if (errors.length > 0) {
    return { ok: false, errors, frames: [], logs: [], actors: [], instances: [] };
  }

  // 外部输入按 (time, seq) 排序；seq 全局唯一，顺序稳定
  const cfg = {
    actors: rawCfg.actors.map((a) => ({ ...a, dead: a.hp === 0 })),
    definitions: rawCfg.definitions.map((d) => ({ ...d })),
    events: [...rawCfg.events].sort((x, y) => x.time - y.time || x.seq - y.seq),
  };
  const defMap = new Map(cfg.definitions.map((d) => [d.id, d]));
  const actorMap = new Map(cfg.actors.map((a) => [a.id, a]));

  let nextInstanceId = 1;
  const instances = new Map(); // id -> 实例
  // 索引：actorId -> (defId -> Set<instanceId>)
  const byActorDef = new Map(cfg.actors.map((a) => [a.id, new Map()]));
  const heap = new MinHeap(taskLess);
  const logs = [];
  const frames = [];
  let logIdx = 0;
  let activeCount = 0;

  const pushLog = (entry) => {
    entry.idx = logIdx++;
    logs.push(entry);
    frames[frames.length - 1].entries.push(entry);
  };

  const indexAdd = (inst) => {
    byActorDef.get(inst.target).get(inst.defId).add(inst.id);
  };
  const indexDel = (inst) => {
    byActorDef.get(inst.target).get(inst.defId).delete(inst.id);
  };
  const groupOf = (actorId, defId) => {
    const perDef = byActorDef.get(actorId);
    let set = perDef.get(defId);
    if (!set) {
      set = new Set();
      perDef.set(defId, set);
    }
    return set;
  };

  // 撤销实例余下任务由惰性校验实现：任务出堆时检查实例是否仍存在且字段匹配
  const removeInstance = (instId, reason, extra = {}) => {
    const inst = instances.get(instId);
    if (!inst) return;
    instances.delete(instId);
    indexDel(inst);
    activeCount--;
    pushLog({
      time: currentTime,
      type: 'cleanup',
      instance: instId,
      defId: inst.defId,
      target: inst.target,
      reason, // expired | replaced | cleansed | death | exhausted
      ...extra,
    });
  };

  const killActor = (actor, root) => {
    actor.dead = true;
    actor.hp = 0;
    const owned = [];
    for (const set of byActorDef.get(actor.id).values()) {
      for (const id of set) owned.push(id);
    }
    owned.sort((x, y) => x - y);
    pushLog({ time: currentTime, type: 'death', target: actor.id, root });
    for (const id of owned) removeInstance(id, 'death', { root });
  };

  // 护盾吸收 + 扣血；root 标识伤害来源（外部事件或 DoT 实例）
  const applyDamage = (targetId, amount, root) => {
    const actor = actorMap.get(targetId);
    if (actor.dead) {
      pushLog({ time: currentTime, type: 'ignored', target: targetId, op: root.kind === 'event' ? 'damage' : 'dot-tick', root, reason: 'target-dead' });
      return;
    }
    // 按 (expires, 实例编号) 升序消耗护盾；同刻到期的护盾此刻尚未到期，仍可吸收
    const shields = [...instances.values()]
      .filter((s) => s.target === targetId && s.def && s.def.kind === 'shield')
      .sort((x, y) => x.expires - y.expires || x.id - y.id);

    let remaining = amount;
    const absorption = [];
    const exhausted = [];
    for (const sh of shields) {
      if (remaining <= 0) break;
      const take = Math.min(sh.amount, remaining);
      sh.amount -= take;
      remaining -= take;
      absorption.push({
        instance: sh.id,
        defId: sh.defId,
        amount: take,
        expires: sh.expires,
      });
      if (sh.amount === 0) exhausted.push(sh.id);
    }

    const hpBefore = actor.hp;
    actor.hp = Math.max(0, hpBefore - remaining);
    const hpLoss = hpBefore - actor.hp;
    const absorbed = amount - remaining;
    // 先落整笔伤害日志（吸收是其组成部分），再记护盾耗尽清理，保证同刻顺序可读且稳定
    pushLog({
      time: currentTime,
      type: 'damage',
      root,
      target: targetId,
      amount,
      absorption,
      absorbed,
      hpLoss,
      hpBefore,
      hpAfter: actor.hp,
      died: actor.hp === 0,
    });
    for (const shId of exhausted) removeInstance(shId, 'exhausted', { root });
    if (actor.hp === 0) killActor(actor, root);
  };

  const doTick = (inst) => {
    // 惰性校验：刷新/净化/死亡后旧实例已不存在，旧跳伤任务直接作废
    if (!instances.has(inst.id)) return;
    if (currentTime >= inst.expires) return; // 仅 tickTime < expires 才跳伤
    applyDamage(inst.target, inst.def.amount, {
      kind: 'tick',
      instance: inst.id,
      defId: inst.defId,
      sourceEvent: inst.sourceEvent,
    });
    if (!instances.has(inst.id)) return; // 跳伤可能导致死亡清理
    inst.nextTick += inst.def.period;
    if (inst.nextTick < inst.expires) {
      heap.push({ time: inst.nextTick, phase: PHASE_TICK, instanceId: inst.id });
    }
  };

  const doExpire = (instId) => {
    if (!instances.has(instId)) return;
    removeInstance(instId, 'expired');
  };

  const applyEffect = (ev) => {
    const actor = actorMap.get(ev.target);
    if (actor.dead) {
      pushLog({ time: currentTime, type: 'ignored', rootEvent: ev.id, target: ev.target, op: 'apply', reason: 'target-dead' });
      return;
    }
    const def = defMap.get(ev.effect);
    const group = groupOf(ev.target, ev.effect);
    const evictions = [];

    if (def.stack === 'refresh') {
      for (const id of group) evictions.push(id); // cap=1，至多 1 个
    } else if (group.size >= def.cap) {
      // independent 满层：删到期最早者，并列删编号最小者
      let victim = null;
      for (const id of group) {
        const cand = instances.get(id);
        if (!victim || cand.expires < victim.expires || (cand.expires === victim.expires && cand.id < victim.id)) {
          victim = cand;
        }
      }
      evictions.push(victim.id);
    }

    // 全局 256 活动上限：扣除本次叠层替换会腾出的名额后仍超上限，则明确拒绝
    if (activeCount - evictions.length >= LIMITS.MAX_ACTIVE_EFFECTS) {
      pushLog({
        time: currentTime,
        type: 'apply-rejected',
        rootEvent: ev.id,
        target: ev.target,
        defId: ev.effect,
        reason: `active-effect-limit-${LIMITS.MAX_ACTIVE_EFFECTS}`,
      });
      return;
    }

    const id = nextInstanceId++;
    const expires = currentTime + def.duration;
    const inst = {
      id,
      defId: def.id,
      def,
      target: ev.target,
      born: currentTime,
      expires,
      amount: def.amount,
      sourceEvent: ev.id,
    };
    if (def.kind === 'dot') {
      inst.nextTick = currentTime + def.period;
    }
    instances.set(id, inst);
    indexAdd(inst);
    activeCount++;

    for (const oldId of evictions) {
      removeInstance(oldId, 'replaced', { rootEvent: ev.id, replacedBy: id });
    }

    if (def.kind === 'dot') {
      if (inst.nextTick < expires) heap.push({ time: inst.nextTick, phase: PHASE_TICK, instanceId: id });
    }
    heap.push({ time: expires, phase: PHASE_EXPIRE, instanceId: id });

    pushLog({
      time: currentTime,
      type: 'apply',
      rootEvent: ev.id,
      target: ev.target,
      defId: def.id,
      instance: id,
      expires,
      firstTick: def.kind === 'dot' ? inst.nextTick : null,
    });
  };

  const doCleanse = (ev) => {
    const actor = actorMap.get(ev.target);
    if (actor.dead) {
      pushLog({ time: currentTime, type: 'ignored', rootEvent: ev.id, target: ev.target, op: 'cleanse', reason: 'target-dead' });
      return;
    }
    const group = groupOf(ev.target, ev.effect);
    const removed = [...group].sort((x, y) => x - y);
    pushLog({
      time: currentTime,
      type: 'cleanse',
      rootEvent: ev.id,
      target: ev.target,
      defId: ev.effect,
      removed,
    });
    for (const id of removed) removeInstance(id, 'cleansed', { rootEvent: ev.id });
  };

  // ---- 主循环：事件驱动，跳到下一个有事情发生的整数时刻 ----
  let eventIdx = 0;
  let currentTime = 0;
  const external = cfg.events;

  const snapshotHp = () => Object.fromEntries(cfg.actors.map((a) => [a.id, a.hp]));

  for (;;) {
    const nextExt = eventIdx < external.length ? external[eventIdx].time : null;
    const nextInt = heap.size > 0 ? heap.top().time : null;
    if (nextExt === null && nextInt === null) break;
    currentTime = nextExt === null ? nextInt : nextInt === null ? nextExt : Math.min(nextExt, nextInt);

    frames.push({ time: currentTime, entries: [], hpAfter: null });

    // 1) 该时刻全部外部事件，seq 升序（events 已按 (time, seq) 排序）
    while (eventIdx < external.length && external[eventIdx].time === currentTime) {
      const ev = external[eventIdx++];
      switch (ev.op) {
        case 'apply':
          applyEffect(ev);
          break;
        case 'damage':
          applyDamage(ev.target, ev.amount, { kind: 'event', event: ev.id });
          break;
        case 'heal': {
          const actor = actorMap.get(ev.target);
          if (actor.dead) {
            pushLog({ time: currentTime, type: 'ignored', rootEvent: ev.id, target: ev.target, op: 'heal', reason: 'target-dead' });
            break;
          }
          const hpBefore = actor.hp;
          actor.hp = Math.min(actor.maxHp, hpBefore + ev.amount);
          pushLog({
            time: currentTime,
            type: 'heal',
            rootEvent: ev.id,
            target: ev.target,
            amount: ev.amount,
            actual: actor.hp - hpBefore,
            hpBefore,
            hpAfter: actor.hp,
          });
          break;
        }
        case 'cleanse':
          doCleanse(ev);
          break;
      }
    }

    // 2)+3) 该时刻内部任务：取出同刻全部任务，按相位(跳伤->到期)、实例编号排序
    const due = [];
    while (heap.size > 0 && heap.top().time === currentTime) due.push(heap.pop());
    due.sort((a, b) => a.phase - b.phase || a.instanceId - b.instanceId);
    for (const task of due) {
      if (task.phase === PHASE_TICK) {
        const inst = instances.get(task.instanceId);
        if (inst) doTick(inst);
      } else {
        doExpire(task.instanceId);
      }
    }

    frames[frames.length - 1].hpAfter = snapshotHp();
  }

  return {
    ok: true,
    errors: [],
    frames,
    logs,
    actors: cfg.actors.map((a) => ({ id: a.id, maxHp: a.maxHp, hp: a.hp, dead: a.dead })),
    instances: [...instances.values()].map((i) => ({
      id: i.id,
      defId: i.defId,
      target: i.target,
      born: i.born,
      expires: i.expires,
      amount: i.amount,
      nextTick: i.nextTick ?? null,
      sourceEvent: i.sourceEvent,
    })),
    limits: LIMITS,
  };
}

// 导出包：配置 + 完整结算日志 + 引擎标识，重新导入后重放比对即可验证复现
export function buildExport(cfg, result) {
  return {
    format: 'status-expiry-sandbox/v1',
    engine: 'integer-event-scheduler/1.0',
    exportedAt: new Date().toISOString(),
    config: structuredClone(cfg),
    result: {
      frames: structuredClone(result.frames),
      finalActors: structuredClone(result.actors),
      finalInstances: structuredClone(result.instances),
    },
  };
}
