/*
 * simulator.js — 整数毫秒离散事件演算引擎
 *
 * 关键语义（说明.md）：
 *  - 一次只执行一个动作；效果与 cost 均在完成时原子提交，中断动作不扣资源、不留半套效果
 *  - 外部事件同一时刻按输入顺序全部处理：立即取消在途动作 → 再由新状态重规划
 *  - 事件优先于同刻完成；无事件时完成动作后检查目标并启动下一步
 *  - 外部事件不消耗动作成本；规划失败则暂停（status 记录原因）
 *  - 时间为整数毫秒；时长均为正整数，故完成与下一动作开始不同刻
 */
(function (global) {
  'use strict';

  function createEngine(domain, planner) {
    const events = (domain.events || []).map((e, i) => ({
      id: 'ev' + i, t: e.t,
      set_facts: { ...e.set_facts },
      set_resources: { ...e.set_resources },
      source: 'rule',
    }));

    const eng = {
      domain,
      t: 0,
      state: cloneState(domain.initial),
      cost: 0,
      inflight: null,          // { actionId, start, finish }
      plan: null,              // 当前一次规划的完整结果
      status: 'idle',          // idle | running | goal_reached | unsolvable | budget_exhausted
      events: events.slice(),  // 全部规则事件（含已/未触发）
      pendingEventIds: events.map((e) => e.id),
      log: [],
      completed: [],           // {actionId, at}
      canceled: [],            // {actionId, at, eventIds}
      replanCount: 0,
      _evSeq: events.length,
      planner,
    };

    reset(eng);
    return eng;
  }

  function cloneState(s) {
    return { facts: { ...s.facts }, resources: { ...s.resources } };
  }

  /* ---------------- 事件表 ---------------- */

  function pendingEvents(eng) {
    return eng.pendingEventIds
      .map((id) => eng.events.find((e) => e.id === id))
      .filter(Boolean)
      .sort((a, b) => (a.t - b.t)); // 同 t 保持输入顺序（稳定）
  }

  /** 下一时间边界：min(下一个事件, 在途完成)；没有任何边界返回 null */
  function peekBoundary(eng) {
    let b = null;
    if (eng.inflight) b = eng.inflight.finish;
    const evs = pendingEvents(eng);
    if (evs.length && (b === null || evs[0].t < b)) b = evs[0].t;
    return b;
  }

  /* ---------------- 日志 ---------------- */

  function addLog(eng, kind, t, message, extra) {
    eng.log.push(Object.assign({ seq: eng.log.length, kind, t, message }, extra || {}));
  }

  /* ---------------- 规划 ---------------- */

  function replan(eng) {
    eng.replanCount++;
    const result = eng.planner.plan(eng.domain, eng.state);
    eng.plan = result;
    if (result.status === 'solved') {
      addLog(eng, 'replan', eng.t,
        `重规划成功：${result.plan.length ? result.plan.join(' → ') || '（空计划，已在目标）' : '（空计划，已在目标）'}，总成本 ${result.cost}`,
        { plan: result.plan.slice(), cost: result.cost, expansions: result.expansions });
      if (eng.status === 'idle' || eng.status === 'running') eng.status = 'running';
    } else if (result.status === 'unsolvable') {
      eng.status = 'unsolvable';
      eng.inflight = null;
      addLog(eng, 'unsolvable', eng.t, '规划失败：完整状态空间内不存在可达目标的计划',
        { expansions: result.expansions });
    } else {
      eng.status = 'budget_exhausted';
      eng.inflight = null;
      addLog(eng, 'budget', eng.t,
        `规划中止：搜索预算 ${result.budget} 次扩展已耗尽，仍有 ${result.remainingCandidates} 个未检查候选`,
        { expansions: result.expansions, remainingCandidates: result.remainingCandidates });
    }
    return result;
  }

  function startNext(eng) {
    if (!eng.plan || eng.plan.status !== 'solved') return;
    if (eng.plan.plan.length === 0) {
      eng.status = 'goal_reached';
      addLog(eng, 'goal', eng.t, '已到达目标状态');
      return;
    }
    const id = eng.plan.plan[0];
    const action = eng.domain.actions.find((a) => a.id === id);
    eng.inflight = { actionId: id, start: eng.t, finish: eng.t + action.duration_ms };
    addLog(eng, 'start', eng.t, `开始执行「${id}」，完成时刻 ${eng.inflight.finish}，成本 ${action.cost}`,
      { actionId: id, finish: eng.inflight.finish, cost: action.cost });
  }

  /* ---------------- 事件处理 ---------------- */

  function applyEvent(eng, ev) {
    Object.keys(ev.set_facts).forEach((n) => {
      eng.state.facts[n] = ev.set_facts[n];
    });
    Object.keys(ev.set_resources).forEach((n) => {
      eng.state.resources[n] = ev.set_resources[n];
    });
    const f = Object.keys(ev.set_facts).map((k) => `${k}=${ev.set_facts[k]}`);
    const r = Object.keys(ev.set_resources).map((k) => `${k}=${ev.set_resources[k]}`);
    addLog(eng, 'event', ev.t,
      `外部事件：${[...f, ...r].join(', ') || '（无赋值）'}`,
      { eventId: ev.id, set_facts: { ...ev.set_facts }, set_resources: { ...ev.set_resources } });
  }

  // 处理某一时刻的全部事件（按输入顺序），返回被消费的事件对象列表
  function consumeEventsAt(eng, t) {
    const at = eng.pendingEventIds
      .map((id) => eng.events.find((e) => e.id === id))
      .filter((e) => e && e.t === t)
      .sort((a, b) => eng.events.indexOf(a) - eng.events.indexOf(b));
    if (!at.length) return [];

    // 先取消在途动作：无成本、无效果
    if (eng.inflight) {
      const act = eng.inflight;
      eng.canceled.push({ actionId: act.actionId, at: t, eventIds: at.map((e) => e.id) });
      addLog(eng, 'cancel', t,
        `事件打断在途动作「${act.actionId}」（已执行 ${t - act.start}/${act.finish - act.start} ms）：不扣成本、不产生效果`,
        { actionId: act.actionId });
      eng.inflight = null;
    }

    at.forEach((ev) => applyEvent(eng, ev));
    eng.pendingEventIds = eng.pendingEventIds.filter((id) => !at.some((e) => e.id === id));
    return at;
  }

  /* ---------------- 完成 ---------------- */

  function completeInflight(eng) {
    const act = eng.inflight;
    const action = eng.domain.actions.find((a) => a.id === act.actionId);
    // 原子提交：一次性应用全部布尔/资源效果并累计成本
    eng.state = eng.planner.applyActionState(eng.domain, action, eng.state);
    eng.cost += action.cost;
    eng.t = act.finish;
    eng.completed.push({ actionId: action.id, at: eng.t });
    eng.inflight = null;
    addLog(eng, 'complete', eng.t,
      `「${action.id}」完成并原子提交：成本 +${action.cost}（累计 ${eng.cost}）`,
      { actionId: action.id, cost: action.cost, totalCost: eng.cost });
  }

  /* ---------------- 单步推进 ---------------- */

  /**
   * 推进到下一时间边界并处理该时刻全部语义。
   * 返回 { advanced:boolean, boundary:number|null, events:[] }
   */
  function step(eng) {
    if (eng.status === 'goal_reached' || eng.status === 'unsolvable' ||
        eng.status === 'budget_exhausted') {
      return { advanced: false, boundary: null, events: [] };
    }

    const boundary = peekBoundary(eng);
    if (boundary === null) return { advanced: false, boundary: null, events: [] };

    const evsAtBoundary = pendingEvents(eng).filter((e) => e.t === boundary);

    if (evsAtBoundary.length) {
      // 事件优先于同刻完成：先处理事件（含取消），同刻完成推迟到下一边界
      eng.t = boundary;
      const consumed = consumeEventsAt(eng, boundary);
      if (eng.planner.isGoalState(eng.domain, eng.state)) {
        eng.status = 'goal_reached';
        eng.inflight = null;
        addLog(eng, 'goal', eng.t, '外部事件后状态已满足目标');
      } else {
        const r = replan(eng);
        if (r.status === 'solved') startNext(eng);
      }
      return { advanced: true, boundary, events: consumed };
    }

    // 无事件边界 => 动作完成
    if (eng.inflight) {
      completeInflight(eng);
      if (eng.planner.isGoalState(eng.domain, eng.state)) {
        eng.status = 'goal_reached';
        eng.inflight = null;
        addLog(eng, 'goal', eng.t, '已到达目标状态');
        return { advanced: true, boundary, events: [] };
      }
      const r = replan(eng);
      if (r.status === 'solved') startNext(eng);
      return { advanced: true, boundary, events: [] };
    }

    // 既无在途动作也无事件（理论不可达，保险处理）
    return { advanced: false, boundary: null, events: [] };
  }

  /* ---------------- 重置 / 重放 ---------------- */

  function reset(eng) {
    eng.t = 0;
    eng.state = cloneState(eng.domain.initial);
    eng.cost = 0;
    eng.inflight = null;
    eng.plan = null;
    eng.status = 'idle';
    eng.pendingEventIds = eng.events.map((e) => e.id);
    eng.log = [];
    eng.completed = [];
    eng.canceled = [];
    eng.replanCount = 0;
    addLog(eng, 'reset', 0, '演算复位到初始状态');

    if (eng.planner.isGoalState(eng.domain, eng.state)) {
      eng.status = 'goal_reached';
      addLog(eng, 'goal', 0, '初始状态已满足目标，无需规划');
      return;
    }
    const r = replan(eng);
    if (r.status === 'solved') startNext(eng);
  }

  /** 从当前时刻一次性重放到目标/失败/无边界（带硬上限防异常） */
  function runToEnd(eng, guard) {
    let n = 0;
    const max = guard || 100000;
    while (n++ < max) {
      const r = step(eng);
      if (!r.advanced) break;
    }
    return eng;
  }

  /* ---------------- 插入外部事件 ---------------- */

  /**
   * 插入事件并立即按其时刻生效：
   *  - t === 当前时刻：立即处理（取消在途 + 重规划）
   *  - t > 当前时刻：进入事件表；若早于在途完成，下一步将先触发事件
   *  - t < 当前时刻：拒绝
   */
  function injectEvent(eng, ev) {
    if (!Number.isInteger(ev.t) || ev.t < 0) return { ok: false, error: 't 必须是非负整数' };
    if (ev.t < eng.t) return { ok: false, error: `不能插入过去时刻（当前 t=${eng.t}）` };
    const set_facts = ev.set_facts || {};
    const set_resources = ev.set_resources || {};
    for (const n of Object.keys(set_facts)) {
      if (!(n in eng.state.facts)) return { ok: false, error: `未知布尔量：${n}` };
      if (typeof set_facts[n] !== 'boolean') return { ok: false, error: `${n} 必须是 true/false` };
    }
    for (const n of Object.keys(set_resources)) {
      if (!(n in eng.state.resources)) return { ok: false, error: `未知资源：${n}` };
      const v = set_resources[n];
      if (!Number.isInteger(v) || v < 0 || v > eng.domain.caps[n]) {
        return { ok: false, error: `${n} 必须是 [0, ${eng.domain.caps[n]}] 内整数` };
      }
    }
    const id = 'inject' + (eng._evSeq++);
    const rec = {
      id, t: ev.t,
      set_facts: { ...set_facts },
      set_resources: { ...set_resources },
      source: 'injected',
    };
    eng.events.push(rec);
    eng.pendingEventIds.push(id);

    if (ev.t === eng.t) {
      // 同刻立即处理，复用 step 的同刻语义（事件优先）
      const r = step(eng);
      return { ok: true, eventId: id, advanced: r.advanced };
    }
    addLog(eng, 'schedule', eng.t,
      `已登记外部事件，将在 t=${ev.t} 触发`, { eventId: id, at: ev.t });
    return { ok: true, eventId: id, advanced: false };
  }

  /** 删除尚未触发的事件（规则事件也可临时移除） */
  function removePendingEvent(eng, id) {
    const i = eng.pendingEventIds.indexOf(id);
    if (i < 0) return false;
    eng.pendingEventIds.splice(i, 1);
    return true;
  }

  /* ---------------- 快照与导出 ---------------- */

  function snapshot(eng) {
    return {
      t: eng.t,
      status: eng.status,
      cost: eng.cost,
      state: cloneState(eng.state),
      inflight: eng.inflight ? { ...eng.inflight } : null,
      plan: eng.plan ? {
        status: eng.plan.status,
        plan: eng.plan.plan.slice(),
        cost: eng.plan.cost,
        expansions: eng.plan.expansions,
        remainingCandidates: eng.plan.remainingCandidates,
      } : null,
      pendingEvents: pendingEvents(eng).map((e) => ({
        id: e.id, t: e.t, source: e.source,
        set_facts: { ...e.set_facts }, set_resources: { ...e.set_resources },
      })),
      completed: eng.completed.map((x) => ({ ...x })),
      canceled: eng.canceled.map((x) => ({ ...x })),
      replanCount: eng.replanCount,
      log: eng.log.map((l) => ({ ...l })),
    };
  }

  const api = {
    createEngine, reset, step, peekBoundary, injectEvent, removePendingEvent,
    runToEnd, snapshot, pendingEvents, cloneState,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GOAPSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
