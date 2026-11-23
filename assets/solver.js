/*
 * 共用提示（shared-signal）信念集规划求解器
 * 纯逻辑，无 DOM 依赖；浏览器挂到 window.SharedSignalSolver，Node 下走 module.exports。
 *
 * 语义（与 samples/shared-signal.json 的 rules 对齐）：
 *  - 信念集 mask：当前仍可能的隐藏状态集合，用 4 个 32 位字的 Uint32Array 表示（最多 128 状态）
 *  - 动作 a 在信念集 B 上合法：B 中每个状态都存在一条非空转移 (s,a,*)
 *  - 按出 a 后：先取所有可能后继的并集，再按“新提示”分组，每个提示是一个观察分支，
 *    同一提示下的后继合并为同一个新信念集
 *  - 保证过关：信念集里每个状态都是终点；否则在剩余拍数内存在一个合法动作，
 *    使其所有观察分支都能保证过关
 *  - 最优：最坏步数（各分支最大步数）最小；同分取动作 id 小者
 */
(function (global) {
  'use strict';

  const LIMITS = { maxStates: 128, maxActions: 16, maxHorizon: 12 };
  const WORDS = 4;

  /* ---------------- 掩码原语 ---------------- */

  function emptyMask() { return new Uint32Array(WORDS); }

  function setBit(m, i) { m[i >> 5] = (m[i >> 5] | (1 << (i & 31))) >>> 0; }

  function hasBit(m, i) { return (m[i >> 5] & (1 << (i & 31))) !== 0; }

  function isEmpty(m) {
    return m[0] === 0 && m[1] === 0 && m[2] === 0 && m[3] === 0;
  }

  function isSubsetOf(a, b) {
    for (let w = 0; w < WORDS; w++) {
      if ((a[w] & ~b[w]) !== 0) return false;
    }
    return true;
  }

  function maskIds(m, states) {
    const out = [];
    for (let i = 0; i < states.length; i++) if (hasBit(m, i)) out.push(states[i].id);
    return out;
  }

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

  /* ---------------- 模型构建与校验 ---------------- */

  function buildModel(raw) {
    const errors = [];
    const warnings = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['顶层必须是 JSON 对象'], warnings, model: null };
    }

    const horizon = raw.horizon;
    if (!isInt(horizon) || horizon < 1 || horizon > LIMITS.maxHorizon) {
      errors.push(`horizon 必须是 1..${LIMITS.maxHorizon} 的整数（当前：${JSON.stringify(raw.horizon)}）`);
    }

    const rawStates = Array.isArray(raw.states) ? raw.states : null;
    const rawActions = Array.isArray(raw.actions) ? raw.actions : null;
    if (!rawStates) errors.push('states 必须是数组');
    if (!rawActions) errors.push('actions 必须是数组');
    if (rawStates && rawStates.length === 0) errors.push('states 不能为空');
    if (rawStates && rawStates.length > LIMITS.maxStates) {
      errors.push(`状态数超过上限 ${LIMITS.maxStates}`);
    }
    if (rawActions && rawActions.length > LIMITS.maxActions) {
      errors.push(`动作数超过上限 ${LIMITS.maxActions}`);
    }
    if (errors.length) return { ok: false, errors, warnings, model: null };

    // 状态：id 唯一
    const states = [];
    const stateById = new Map();
    const seenStateIds = new Set();
    rawStates.forEach((s, idx) => {
      if (!s || typeof s !== 'object') { errors.push(`states[${idx}] 必须是对象`); return; }
      if (!isInt(s.id)) { errors.push(`states[${idx}].id 必须是整数`); return; }
      if (seenStateIds.has(s.id)) { errors.push(`状态 id ${s.id} 重复`); return; }
      seenStateIds.add(s.id);
      const hint = s.hint === undefined || s.hint === null ? '' : String(s.hint);
      states.push({ id: s.id, hint, goal: !!s.goal, index: states.length });
    });
    if (errors.length) return { ok: false, errors, warnings, model: null };
    states.forEach(s => stateById.set(s.id, s));

    // 动作：id 唯一，按 id 升序
    const actions = [];
    const actionById = new Map();
    const seenActionIds = new Set();
    rawActions.forEach((a, idx) => {
      if (!a || typeof a !== 'object') { errors.push(`actions[${idx}] 必须是对象`); return; }
      if (!isInt(a.id)) { errors.push(`actions[${idx}].id 必须是整数`); return; }
      if (seenActionIds.has(a.id)) { errors.push(`动作 id ${a.id} 重复`); return; }
      seenActionIds.add(a.id);
      actions.push({ id: a.id, name: String(a.name === undefined ? a.id : a.name), index: actions.length });
    });
    if (errors.length) return { ok: false, errors, warnings, model: null };
    actions.sort((x, y) => x.id - y.id);
    actions.forEach((a, i) => { a.index = i; actionById.set(a.id, a); });

    // 初始集合
    const initialMask = emptyMask();
    if (!Array.isArray(raw.initial) || raw.initial.length === 0) {
      errors.push('initial 必须是非空数组');
    } else {
      raw.initial.forEach(id => {
        const s = stateById.get(id);
        if (!s) errors.push(`initial 引用了不存在的状态 id ${id}`);
        else setBit(initialMask, s.index);
      });
    }

    // 转移表：[状态id, 动作id, [后继状态id...]]；succ[ai][si] = 后继掩码
    const succ = actions.map(() => states.map(() => emptyMask()));
    const seenRow = new Set();
    (Array.isArray(raw.transitions) ? raw.transitions : []).forEach((row, idx) => {
      if (!Array.isArray(row) || row.length !== 3) {
        errors.push(`transitions[${idx}] 必须是 [状态id, 动作id, [后继...]]`);
        return;
      }
      const [sid, aid, next] = row;
      const s = stateById.get(sid);
      const a = actionById.get(aid);
      if (!s) { errors.push(`transitions[${idx}] 引用了不存在的状态 id ${sid}`); return; }
      if (!a) { errors.push(`transitions[${idx}] 引用了不存在的动作 id ${aid}`); return; }
      if (!Array.isArray(next) || next.length === 0) {
        errors.push(`transitions[${idx}] 的后继列表必须非空`);
        return;
      }
      const key = s.id + '|' + a.id;
      if (seenRow.has(key)) warnings.push(`转移 (状态 ${s.id}, 动作 ${a.id}) 出现多次，后继已取并集`);
      seenRow.add(key);
      next.forEach(nid => {
        const ns = stateById.get(nid);
        if (!ns) errors.push(`transitions[${idx}] 的后继引用了不存在的状态 id ${nid}`);
        else setBit(succ[a.index][s.index], ns.index);
      });
    });

    if (errors.length) return { ok: false, errors, warnings, model: null };

    const goalMask = emptyMask();
    states.forEach(s => { if (s.goal) setBit(goalMask, s.index); });

    // 非阻断性提醒
    const initialHints = new Set(maskIds(initialMask, states).map(id => stateById.get(id).hint));
    if (initialHints.size > 1) warnings.push('初始集合里的状态提示不一致，玩家起始时就无法用单一共用提示解释该集合');
    states.forEach(s => {
      const hasOut = actions.some(a => !isEmpty(succ[a.index][s.index]));
      if (!hasOut && !s.goal) warnings.push(`状态 ${s.id} 没有任何出边，且不是终点`);
    });

    const model = {
      horizon,
      states,
      actions,
      stateById,
      actionById,
      initialMask,
      goalMask,
      succ,
      // 四级 Map：word0..word3(Number) -> node，全程 Smi 键、无数值装箱
      nodes: new Map(),
      rules: typeof raw.rules === 'string' ? raw.rules : ''
    };
    return { ok: true, errors, warnings, model };
  }

  /*
   * 信念集内部化：每个掩码对应一个 node，成员/动作结果/DP 值都挂在 node 上。
   * node = { mask, idx: 置位下标数组, apply: 按动作下标的结果数组, dp: 按剩余拍数的结果数组 }
   */
  function nodeOf(model, mask) {
    let map = model.nodes;
    for (let w = 0; w < WORDS - 1; w++) {
      let next = map.get(mask[w]);
      if (!next) { next = new Map(); map.set(mask[w], next); }
      map = next;
    }
    let n = map.get(mask[WORDS - 1]);
    if (n) return n;

    const idx = [];
    for (let w = 0; w < WORDS; w++) {
      let word = mask[w];
      while (word) {
        const low = word & -word;
        const i = (w << 5) + 31 - Math.clz32(low);
        if (i < model.states.length) idx.push(i);
        word ^= low;
      }
    }

    n = {
      mask: mask.slice(),
      idx,
      apply: new Array(model.actions.length),
      dp: new Array(model.horizon + 1),
      legal: null
    };
    map.set(mask[WORDS - 1], n);
    return n;
  }

  /* ---------------- 信念集运算 ---------------- */

  function legalActions(model, mask) {
    const n = nodeOf(model, mask);
    if (n.legal) return n.legal;
    const res = [];
    for (let ai = 0; ai < model.actions.length; ai++) {
      const col = model.succ[ai];
      let ok = true;
      for (const i of n.idx) {
        if (isEmpty(col[i])) { ok = false; break; }
      }
      if (ok) res.push(ai);
    }
    n.legal = res; // actions 已按 id 升序
    return res;
  }

  function applyAction(model, mask, ai) {
    const n = nodeOf(model, mask);
    const hit = n.apply[ai];
    if (hit) return hit;

    const col = model.succ[ai];
    const allMask = emptyMask();
    for (const i of n.idx) {
      const s = col[i];
      for (let w = 0; w < WORDS; w++) allMask[w] = (allMask[w] | s[w]) >>> 0;
    }

    const byHint = new Map();
    for (const i of nodeOf(model, allMask).idx) {
      const h = model.states[i].hint;
      let gm = byHint.get(h);
      if (!gm) { gm = emptyMask(); byHint.set(h, gm); }
      setBit(gm, i);
    }
    const branches = [...byHint.entries()]
      .map(([hint, m]) => ({ hint, mask: m }))
      .sort((x, y) => (x.hint < y.hint ? -1 : x.hint > y.hint ? 1 : 0));
    const out = { allMask, branches };
    n.apply[ai] = out;
    return out;
  }

  function isAllGoal(model, mask) {
    return !isEmpty(mask) && isSubsetOf(mask, model.goalMask);
  }

  /* ---------------- 核心递归：保证可达 + 最坏步数 ---------------- */

  function evaluate(model, mask, t) {
    const n = nodeOf(model, mask);
    const cached = n.dp[t];
    if (cached) return cached;

    let result;
    if (isAllGoal(model, mask)) {
      result = { win: true, cost: 0, action: -1, branches: [] };
    } else if (t <= 0) {
      result = { win: false, cost: Infinity, action: -1, branches: [], reason: '时限耗尽，候选集仍含非终点状态' };
    } else {
      let best = null;
      const acts = legalActions(model, mask);
      for (let k = 0; k < acts.length; k++) {
        const ai = acts[k];
        const applied = applyAction(model, mask, ai);
        const br = applied.branches;
        let allWin = true;
        let maxCost = 0;
        const branchEvals = new Array(br.length);
        for (let bi = 0; bi < br.length; bi++) {
          const ev = evaluate(model, br[bi].mask, t - 1);
          branchEvals[bi] = { hint: br[bi].hint, mask: br[bi].mask, ev };
          if (!ev.win) { allWin = false; break; }
          if (ev.cost > maxCost) maxCost = ev.cost;
        }
        if (allWin) {
          const cost = 1 + maxCost;
          if (!best || cost < best.cost ||
              (cost === best.cost && model.actions[ai].id < model.actions[best.action].id)) {
            best = { win: true, cost, action: ai, branches: branchEvals };
          }
        }
      }
      result = best || {
        win: false, cost: Infinity, action: -1, branches: [],
        reason: '没有合法动作能让所有提示分支都保证到达终点'
      };
    }
    n.dp[t] = result;
    return result;
  }

  /* ---------------- 动作分析（工作台用，含被淘汰原因） ---------------- */

  function analyzeActions(model, mask, t) {
    const root = evaluate(model, mask, t);
    return model.actions.map((a, ai) => {
      const missing = [];
      for (const i of nodeOf(model, mask).idx) {
        if (isEmpty(model.succ[ai][i])) missing.push(model.states[i].id);
      }
      const base = { index: ai, id: a.id, name: a.name, legal: missing.length === 0, missingStates: missing };
      if (!base.legal) {
        return {
          ...base, guaranteed: false, cost: null, chosen: false, branches: [],
          eliminatedReason: `候选状态 ${missing.slice(0, 4).join('、')}${missing.length > 4 ? ' 等' : ''} 没有该动作的转移`
        };
      }
      const applied = applyAction(model, mask, ai);
      const branches = applied.branches.map(b => {
        const ev = evaluate(model, b.mask, t - 1);
        return { hint: b.hint, mask: b.mask, belief: maskIds(b.mask, model.states), win: ev.win, cost: ev.win ? ev.cost : null };
      });
      const failing = branches.filter(b => !b.win);
      if (failing.length) {
        return {
          ...base, guaranteed: false, cost: null, chosen: false, branches,
          eliminatedReason: `观察到提示「${failing[0].hint}」后的候选集无法保证过关（剩 ${t - 1} 拍）`
        };
      }
      const cost = 1 + Math.max(...branches.map(b => b.cost));
      const chosen = root.win && root.action === ai;
      let eliminatedReason = null;
      if (!chosen && root.win && root.cost === cost) {
        eliminatedReason = `最坏 ${cost} 拍，与动作 ${model.actions[root.action].id} 同分，但动作号较大`;
      }
      return { ...base, guaranteed: true, cost, chosen, branches, eliminatedReason };
    });
  }

  /* ---------------- 策略树与导出 ---------------- */

  function policyTree(model) {
    const root = evaluate(model, model.initialMask, model.horizon);
    if (!root.win) return null;
    const build = (mask, t) => {
      const ev = evaluate(model, mask, t);
      if (ev.cost === 0) {
        return { terminal: true, allGoal: true, remaining: t, belief: maskIds(mask, model.states) };
      }
      return {
        terminal: false,
        remaining: t,
        belief: maskIds(mask, model.states),
        action: model.actions[ev.action].id,
        actionName: model.actions[ev.action].name,
        worstCaseSteps: ev.cost,
        branches: ev.branches.map(b => ({ hint: b.hint, node: build(b.mask, t - 1) }))
      };
    };
    return build(model.initialMask, model.horizon);
  }

  function exportPolicy(model) {
    const root = evaluate(model, model.initialMask, model.horizon);
    return {
      format: 'shared-signal-policy/v1',
      horizon: model.horizon,
      solvable: root.win,
      worstCaseSteps: root.win ? root.cost : null,
      states: model.states.map(s => ({ id: s.id, hint: s.hint, goal: s.goal })),
      actions: model.actions.map(a => ({ id: a.id, name: a.name })),
      initialBelief: maskIds(model.initialMask, model.states),
      tree: root.win ? policyTree(model) : null
    };
  }

  /* ---------------- 反例：点任一合法首动作，给出致命后续提示与完整对抗轨迹 ---------------- */

  function counterTrace(model, mask, t, firstAi) {
    const steps = [];
    let curMask = mask;
    let curT = t;
    let ai = firstAi;

    while (true) {
      const legal = legalActions(model, curMask);
      if (!legal.includes(ai)) {
        return { ok: false, reason: '该动作在当前候选集上不合法', steps };
      }
      const applied = applyAction(model, curMask, ai);
      const candidates = applied.branches
        .map(b => ({ b, ev: evaluate(model, b.mask, curT - 1) }))
        .filter(x => !x.ev.win);
      if (!candidates.length) {
        return { ok: false, reason: '该动作的所有提示分支都能保证过关，不构成反例', steps };
      }
      const pick = candidates[0]; // 分支按提示确定性排序，取第一个失败分支
      steps.push({
        actionId: model.actions[ai].id,
        actionName: model.actions[ai].name,
        hint: pick.b.hint,
        belief: maskIds(pick.b.mask, model.states),
        remaining: curT - 1
      });
      curMask = pick.b.mask;
      curT -= 1;

      if (isAllGoal(model, curMask)) {
        return { ok: true, steps, endReason: '候选集已全部是终点（不应发生于失败分支）' };
      }
      if (curT <= 0) {
        return { ok: true, steps, endReason: '时限耗尽，候选集仍含非终点状态' };
      }
      let next = null;
      for (const cand of legalActions(model, curMask)) {
        const ap = applyAction(model, curMask, cand);
        if (ap.branches.some(b => !evaluate(model, b.mask, curT - 1).win)) { next = cand; break; }
      }
      if (next === null) {
        return { ok: true, steps, endReason: '当前候选集上没有可继续推演的失败动作' };
      }
      ai = next;
    }
  }

  const api = {
    LIMITS, emptyMask, setBit, hasBit, maskIds, buildModel, nodeOf,
    legalActions, applyAction, isAllGoal, isEmpty, isSubsetOf,
    evaluate, analyzeActions, policyTree, exportPolicy, counterTrace
  };
  global.SharedSignalSolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
