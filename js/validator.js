/*
 * validator.js — 规则校验与规范化
 * 上限：12 个布尔量、2 种资源、32 个动作；成本/时长均为正整数。
 */
(function (global) {
  'use strict';

  const MAX_FACTS = 12;
  const MAX_RESOURCES = 2;
  const MAX_ACTIONS = 32;

  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }
  function isBool(v) {
    return typeof v === 'boolean';
  }
  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function validate(input) {
    const errors = [];
    const warnings = [];
    const push = (p, m) => errors.push(`${p}: ${m}`);

    if (!isObj(input)) return { errors: ['根节点必须是 JSON 对象'], warnings, domain: null };

    /* ---- initial ---- */
    if (!isObj(input.initial)) {
      push('initial', '必须是对象 { facts, resources }');
    }
    const initFacts = input.initial && isObj(input.initial.facts) ? input.initial.facts : null;
    if (!initFacts) push('initial.facts', '必须是布尔量映射对象');
    const initRes = input.initial && isObj(input.initial.resources) ? input.initial.resources : null;
    if (!initRes) push('initial.resources', '必须是资源映射对象');

    const factNames = initFacts ? Object.keys(initFacts) : [];
    if (factNames.length > MAX_FACTS) {
      push('initial.facts', `布尔量最多 ${MAX_FACTS} 个，当前 ${factNames.length} 个`);
    }
    factNames.forEach((n) => {
      if (!isBool(initFacts[n])) push(`initial.facts.${n}`, '必须是 true/false');
    });

    /* ---- caps ---- */
    if (!isObj(input.caps)) push('caps', '必须是资源上限映射对象');
    const caps = isObj(input.caps) ? input.caps : {};
    const resNames = Object.keys(caps);
    if (resNames.length > MAX_RESOURCES) {
      push('caps', `资源最多 ${MAX_RESOURCES} 种，当前 ${resNames.length} 种`);
    }
    resNames.forEach((n) => {
      if (!isInt(caps[n]) || caps[n] <= 0) push(`caps.${n}`, '上限必须是正整数');
    });
    if (initRes) {
      Object.keys(initRes).forEach((n) => {
        if (!(n in caps)) push(`initial.resources.${n}`, '未在 caps 中声明该资源');
        else if (!isInt(initRes[n]) || initRes[n] < 0 || initRes[n] > caps[n]) {
          push(`initial.resources.${n}`, `必须是 [0, ${caps[n]}] 内的整数`);
        }
      });
    }

    /* ---- goal ---- */
    const goal = isObj(input.goal) ? input.goal : null;
    if (!goal) push('goal', '必须是对象 { facts, min, max }');
    const gFacts = goal && isObj(goal.facts) ? goal.facts : {};
    const gMin = goal && isObj(goal.min) ? goal.min : {};
    const gMax = goal && isObj(goal.max) ? goal.max : {};
    Object.keys(gFacts).forEach((n) => {
      if (!factNames.includes(n)) push(`goal.facts.${n}`, '未在 initial.facts 中声明');
      else if (!isBool(gFacts[n])) push(`goal.facts.${n}`, '必须是 true/false');
    });
    [['goal.min', gMin, 'min'], ['goal.max', gMax, 'max']].forEach(([p, m, kind]) => {
      Object.keys(m).forEach((n) => {
        if (!resNames.includes(n)) push(`${p}.${n}`, '未在 caps 中声明该资源');
        else if (!isInt(m[n]) || m[n] < 0 || m[n] > caps[n]) {
          push(`${p}.${n}`, `必须是 [0, ${caps[n]}] 内的整数`);
        }
      });
    });

    /* ---- actions ---- */
    if (!Array.isArray(input.actions)) {
      push('actions', '必须是数组');
    }
    const rawActions = Array.isArray(input.actions) ? input.actions : [];
    if (rawActions.length > MAX_ACTIONS) {
      push('actions', `动作最多 ${MAX_ACTIONS} 个，当前 ${rawActions.length} 个`);
    }
    const seenIds = new Set();
    const actions = rawActions.map((a, i) => {
      const p = `actions[${i}]`;
      if (!isObj(a)) { push(p, '必须是对象'); return null; }
      if (typeof a.id !== 'string' || !a.id.trim()) push(`${p}.id`, '必须是非空字符串');
      else if (seenIds.has(a.id)) push(`${p}.id`, `动作 id「${a.id}」重复`);
      else seenIds.add(a.id);
      if (!isInt(a.cost) || a.cost <= 0) push(`${p}.cost`, '必须是正整数');
      if (!isInt(a.duration_ms) || a.duration_ms <= 0) push(`${p}.duration_ms`, '必须是正整数');

      const pre = isObj(a.pre) ? a.pre : {};
      if (!isObj(a.pre)) push(`${p}.pre`, '必须是布尔条件映射');
      Object.keys(pre).forEach((n) => {
        if (!factNames.includes(n)) push(`${p}.pre.${n}`, '未声明的布尔量');
        else if (!isBool(pre[n])) push(`${p}.pre.${n}`, '必须是 true/false');
      });
      [['min', a.min], ['max', a.max]].forEach(([k, v]) => {
        if (!isObj(v)) { push(`${p}.${k}`, '必须是资源条件映射'); return; }
        Object.keys(v).forEach((n) => {
          if (!resNames.includes(n)) push(`${p}.${k}.${n}`, '未声明的资源');
          else if (!isInt(v[n]) || v[n] < 0 || v[n] > caps[n]) {
            push(`${p}.${k}.${n}`, `必须是 [0, ${caps[n]}] 内的整数`);
          }
        });
      });

      const add = Array.isArray(a.add) ? a.add : null;
      const remove = Array.isArray(a.remove) ? a.remove : null;
      if (!add) push(`${p}.add`, '必须是数组');
      if (!remove) push(`${p}.remove`, '必须是数组');
      (add || []).forEach((n) => {
        if (!factNames.includes(n)) push(`${p}.add.${n}`, '未声明的布尔量');
      });
      (remove || []).forEach((n) => {
        if (!factNames.includes(n)) push(`${p}.remove.${n}`, '未声明的布尔量');
      });
      const overlap = (add || []).filter((n) => (remove || []).includes(n));
      if (overlap.length) push(`${p}`, `add 与 remove 互斥，冲突量：${overlap.join(', ')}`);

      const delta = isObj(a.delta) ? a.delta : null;
      if (!delta) push(`${p}.delta`, '必须是资源变化映射');
      if (delta) {
        Object.keys(delta).forEach((n) => {
          if (!resNames.includes(n)) push(`${p}.delta.${n}`, '未声明的资源');
          else if (!isInt(delta[n]) || delta[n] === 0) {
            push(`${p}.delta.${n}`, '必须是非零整数（0 请直接省略）');
          }
        });
      }

      return {
        id: a.id,
        cost: a.cost,
        duration_ms: a.duration_ms,
        pre: { ...pre },
        min: isObj(a.min) ? { ...a.min } : {},
        max: isObj(a.max) ? { ...a.max } : {},
        add: add ? add.slice() : [],
        remove: remove ? remove.slice() : [],
        delta: delta ? { ...delta } : {},
      };
    }).filter(Boolean);

    /* ---- budget ---- */
    let budget = 10000;
    if (input.budget !== undefined) {
      if (!isInt(input.budget) || input.budget < 0) push('budget', '必须是非负整数');
      else budget = input.budget;
    }

    /* ---- events（可选）---- */
    const events = [];
    if (input.events !== undefined) {
      if (!Array.isArray(input.events)) push('events', '必须是数组');
      else input.events.forEach((ev, i) => {
        const p = `events[${i}]`;
        if (!isObj(ev)) { push(p, '必须是对象'); return; }
        if (!isInt(ev.t) || ev.t < 0) { push(`${p}.t`, '必须是非负整数毫秒'); return; }
        const sf = isObj(ev.set_facts) ? ev.set_facts : {};
        const sr = isObj(ev.set_resources) ? ev.set_resources : {};
        if (!isObj(ev.set_facts)) push(`${p}.set_facts`, '必须是映射对象');
        if (!isObj(ev.set_resources)) push(`${p}.set_resources`, '必须是映射对象');
        Object.keys(sf).forEach((n) => {
          if (!factNames.includes(n)) push(`${p}.set_facts.${n}`, '未声明的布尔量');
          else if (!isBool(sf[n])) push(`${p}.set_facts.${n}`, '必须是 true/false');
        });
        Object.keys(sr).forEach((n) => {
          if (!resNames.includes(n)) push(`${p}.set_resources.${n}`, '未声明的资源');
          else if (!isInt(sr[n]) || sr[n] < 0 || sr[n] > caps[n]) {
            push(`${p}.set_resources.${n}`, `必须是 [0, ${caps[n]}] 内的整数`);
          }
        });
        events.push({ t: ev.t, set_facts: { ...sf }, set_resources: { ...sr } });
      });
    }

    if (errors.length) return { errors, warnings, domain: null };

    /* ---- 规范化输出 ---- */
    const facts = {};
    factNames.forEach((n) => { facts[n] = !!initFacts[n]; });
    const resources = {};
    resNames.forEach((n) => { resources[n] = initRes && n in initRes ? initRes[n] : 0; });
    const normCaps = {};
    resNames.forEach((n) => { normCaps[n] = caps[n]; });

    const domain = {
      initial: { facts, resources },
      caps: normCaps,
      goal: { facts: { ...gFacts }, min: { ...gMin }, max: { ...gMax } },
      actions,
      budget,
      events,
    };

    // 永远不可用的动作给警告（不阻断）
    domain.actions.forEach((a) => {
      const doomed = Object.keys(a.delta).some((n) => {
        const i = resNames.indexOf(n);
        const cap = caps[n];
        // 任何合法资源状态都承受不了的 delta
        return (a.delta[n] > 0 && a.delta[n] > cap) ||
               (a.delta[n] < 0 && a.min[n] !== undefined && a.min[n] + a.delta[n] < 0);
      });
      if (doomed) warnings.push(`动作「${a.id}」的资源变化在任何合法状态下都会越界，永远不可用`);
    });

    return { errors, warnings, domain };
  }

  function emptyDomain() {
    return {
      initial: { facts: { flag: false }, resources: { energy: 0 } },
      caps: { energy: 5 },
      goal: { facts: { flag: true }, min: {}, max: {} },
      actions: [
        {
          id: 'act1', cost: 1, duration_ms: 100,
          pre: {}, min: {}, max: {}, add: ['flag'], remove: [], delta: {},
        },
      ],
      budget: 10000,
      events: [],
    };
  }

  const api = { validate, emptyDomain, MAX_FACTS, MAX_RESOURCES, MAX_ACTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GOAPValidate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
