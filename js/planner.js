/*
 * planner.js — 资源 GOAP 最优规划器（自研，无第三方依赖）
 *
 * 语义依据样例包 说明.md：
 *  - 状态 = 至多 12 个布尔量（位掩码）+ 至多 2 种有上限整数资源
 *  - 动作可用：所有 pre 成立、min/max 资源条件成立、delta 后全部资源仍在 [0, cap] 内（不夹取）
 *  - add/remove 效果与 delta 同时生效
 *  - 一致代价搜索（Dijkstra）：总 cost 最小；同 cost 取动作 id 序列字典序最小
 *  - 每弹出一个「尚未扩展且持有最优路径」的状态计一次扩展，budget 限制该计数
 *  - 弹出后先判目标再决定是否扩展；预算耗尽但仍有未检查候选 => budget_exhausted；
 *    队列为空 => unsolvable；两者严格区分
 */
(function (global) {
  'use strict';

  /* ---------------- 基础结构 ---------------- */

  // 事实名/资源名统一按字典序排列，保证状态键与编码稳定
  function buildIndex(domain) {
    const factNames = Object.keys(domain.initial.facts).slice().sort();
    const resNames = Object.keys(domain.caps).slice().sort();
    const factIdx = {};
    factNames.forEach((n, i) => { factIdx[n] = i; });
    return { factNames, factIdx, resNames };
  }

  function encodeState(domain, idx, state) {
    let bits = 0;
    idx.factNames.forEach((name, i) => {
      if (state.facts && state.facts[name]) bits |= 1 << i;
    });
    const res = idx.resNames.map((name) => {
      const v = state.resources ? state.resources[name] : 0;
      return Number.isFinite(v) ? v : 0;
    });
    return { bits, res };
  }

  function decodeState(idx, bits, res) {
    const facts = {};
    idx.factNames.forEach((name, i) => {
      facts[name] = (bits & (1 << i)) !== 0;
    });
    const resources = {};
    idx.resNames.forEach((name, i) => {
      resources[name] = res[i];
    });
    return { facts, resources };
  }

  function stateKey(bits, res) {
    return bits + '|' + res.join('|');
  }

  /* ---------------- 条件与效果 ---------------- */

  function factPreHolds(bits, pre, factIdx) {
    for (const name of Object.keys(pre)) {
      const i = factIdx[name];
      if (i === undefined) return false;
      const have = (bits & (1 << i)) !== 0;
      if (have !== !!pre[name]) return false;
    }
    return true;
  }

  function resourceCondHolds(res, cond, resIdx, kind) {
    for (const name of Object.keys(cond || {})) {
      const i = resIdx[name];
      if (i === undefined) return false;
      const bound = cond[name];
      if (kind === 'min' && res[i] < bound) return false;
      if (kind === 'max' && res[i] > bound) return false;
    }
    return true;
  }

  function applicable(action, bits, res, factIdx, resIdx, caps) {
    if (!factPreHolds(bits, action.pre || {}, factIdx)) return false;
    if (!resourceCondHolds(res, action.min, resIdx, 'min')) return false;
    if (!resourceCondHolds(res, action.max, resIdx, 'max')) return false;
    const delta = action.delta || {};
    for (const name of Object.keys(delta)) {
      const i = resIdx[name];
      if (i === undefined) return false;
      const nv = res[i] + delta[name];
      // 越界即不可用，不做夹取
      if (nv < 0 || nv > caps[i]) return false;
    }
    return true;
  }

  function applyAction(action, bits, res, factIdx, resIdx) {
    let nb = bits;
    (action.add || []).forEach((name) => {
      const i = factIdx[name];
      if (i !== undefined) nb |= 1 << i;
    });
    (action.remove || []).forEach((name) => {
      const i = factIdx[name];
      if (i !== undefined) nb &= ~(1 << i);
    });
    const nr = res.slice();
    const delta = action.delta || {};
    for (const name of Object.keys(delta)) {
      const i = resIdx[name];
      if (i >= 0) nr[i] += delta[name];
    }
    return { bits: nb, res: nr };
  }

  function isGoal(bits, res, goal, factIdx, resIdx) {
    const gf = goal.facts || {};
    for (const name of Object.keys(gf)) {
      const i = factIdx[name];
      if (i === undefined) return false;
      const have = (bits & (1 << i)) !== 0;
      if (have !== !!gf[name]) return false;
    }
    if (!resourceCondHolds(res, goal.min, resIdx, 'min')) return false;
    if (!resourceCondHolds(res, goal.max, resIdx, 'max')) return false;
    return true;
  }

  /* ---------------- 字典序 ---------------- */

  // 动作 id 数组的标准字典序：逐元素字符串比较，短前缀更小
  function lexLess(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return a.length < b.length;
  }

  /* ---------------- 二叉最小堆 ---------------- */

  class Heap {
    constructor(cmp) {
      this.a = [];
      this.cmp = cmp; // <0 表示 x 优先于 y
    }
    get size() {
      return this.a.length;
    }
    push(x) {
      const a = this.a;
      a.push(x);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.cmp(a[i], a[p]) < 0) {
          const tmp = a[i]; a[i] = a[p]; a[p] = tmp;
          i = p;
        } else break;
      }
    }
    pop() {
      const a = this.a;
      if (a.length === 0) return undefined;
      const top = a[0];
      const last = a.pop();
      if (a.length > 0) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
          if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
          if (m === i) break;
          const tmp = a[i]; a[i] = a[m]; a[m] = tmp;
          i = m;
        }
      }
      return top;
    }
    peek() {
      return this.a[0];
    }
  }

  function nodeCmp(x, y) {
    if (x.g !== y.g) return x.g - y.g;
    // 同成本：动作序列字典序小者优先，保证决胜稳定
    if (lexLess(x.path, y.path)) return -1;
    if (lexLess(y.path, x.path)) return 1;
    return 0;
  }

  /* ---------------- 主搜索 ---------------- */

  /**
   * @param domain 规则（经 validator 规范化）
   * @param startState 外部形态 { facts:{}, resources:{} }
   * @param budgetOverride 可选，覆盖 domain.budget
   * @returns {
   *   status: 'solved' | 'unsolvable' | 'budget_exhausted',
   *   plan: string[], cost: number, expansions: number, budget: number,
   *   statesReached: number, remainingCandidates: number,
   *   steps: [{actionId, costAfter, durationAfter, stateBefore, stateAfter}],
   *   startState
   * }
   */
  function plan(domain, startState, budgetOverride) {
    const idx = buildIndex(domain);
    const resIdx = {};
    idx.resNames.forEach((n, i) => { resIdx[n] = i; });
    const caps = idx.resNames.map((n) => domain.caps[n]);
    const budget = Number.isInteger(budgetOverride) ? budgetOverride : domain.budget;
    // 动作按 id 排序仅为展开顺序稳定；真正的决胜由堆比较器保证
    const actions = domain.actions.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = encodeState(domain, idx, startState);
    const startKey = stateKey(start.bits, start.res);

    const heap = new Heap(nodeCmp);
    // best[key] = 该状态当前最优路径 { g, path }
    const best = new Map();
    best.set(startKey, { g: 0, path: [] });
    heap.push({ g: 0, path: [], bits: start.bits, res: start.res, key: startKey });

    let expansions = 0;

    const makeResult = (status, node) => {
      const steps = [];
      if (node) {
        let bits = start.bits;
        let res = start.res;
        let cumCost = 0;
        let cumDur = 0;
        node.path.forEach((id) => {
          const action = actions.find((x) => x.id === id);
          const before = decodeState(idx, bits, res);
          const next = applyAction(action, bits, res, idx.factIdx, resIdx);
          bits = next.bits; res = next.res;
          cumCost += action.cost;
          cumDur += action.duration_ms;
          steps.push({
            actionId: id,
            costAfter: cumCost,
            durationAfter: cumDur,
            stateBefore: before,
            stateAfter: decodeState(idx, bits, res),
          });
        });
      }
      return {
        status,
        plan: node ? node.path.slice() : [],
        cost: node ? node.g : null,
        expansions,
        budget,
        statesReached: best.size,
        remainingCandidates: countLive(heap, best),
        steps,
        startState: decodeState(idx, start.bits, start.res),
      };
    };

    while (heap.size > 0) {
      // 丢弃过期条目：已被更优路径取代、或该状态已扩展过
      let node = heap.pop();
      while (node && isStale(node, best)) node = heap.pop();
      if (!node) break;
      // 弹出一个持有最优路径的未扩展状态 => 计一次扩展
      expansions++;

      // 弹出后先检查目标
      if (isGoal(node.bits, node.res, domain.goal, idx.factIdx, resIdx)) {
        return makeResult('solved', node);
      }

      for (const action of actions) {
        if (!applicable(action, node.bits, node.res, idx.factIdx, resIdx, caps)) continue;
        const next = applyAction(action, node.bits, node.res, idx.factIdx, resIdx);
        const ng = node.g + action.cost;
        const npath = node.path.concat(action.id);
        const nkey = stateKey(next.bits, next.res);
        const cur = best.get(nkey);
        if (!cur || ng < cur.g || (ng === cur.g && lexLess(npath, cur.path))) {
          best.set(nkey, { g: ng, path: npath });
          heap.push({ g: ng, path: npath, bits: next.bits, res: next.res, key: nkey });
        }
      }

      // 本次扩展完成后再决定是否继续：预算用尽时，堆中仍有未检查候选 => 预算耗尽；
      // 堆已空 => 完整状态空间搜索完毕仍未达目标 => 无解
      if (expansions >= budget) {
        return heap.size > 0 ? makeResult('budget_exhausted', null)
                             : makeResult('unsolvable', null);
      }
    }

    return makeResult('unsolvable', null);
  }

  function isStale(node, best) {
    const cur = best.get(node.key);
    if (!cur) return true;
    if (cur.g !== node.g) return true;
    // 同状态同成本但路径不同：保留字典序最小的那条，其余视为过期
    return cur.path.length !== node.path.length || cur.path.some((v, i) => v !== node.path[i]);
  }

  function countLive(heap, best) {
    let n = 0;
    for (const node of heap.a) {
      if (!isStale(node, best)) n++;
    }
    return n;
  }

  /* ---------------- 外部形态（state 对象）便捷 API，供模拟器使用 ---------------- */

  function applyActionState(domain, action, state) {
    const idx = buildIndex(domain);
    const resIdx = {};
    idx.resNames.forEach((n, i) => { resIdx[n] = i; });
    const enc = encodeState(domain, idx, state);
    const out = applyAction(action, enc.bits, enc.res, idx.factIdx, resIdx);
    return decodeState(idx, out.bits, out.res);
  }

  function isGoalState(domain, state, goalOverride) {
    const idx = buildIndex(domain);
    const resIdx = {};
    idx.resNames.forEach((n, i) => { resIdx[n] = i; });
    const enc = encodeState(domain, idx, state);
    return isGoal(enc.bits, enc.res, goalOverride || domain.goal, idx.factIdx, resIdx);
  }

  const api = {
    plan,
    encodeState,
    decodeState,
    buildIndex,
    applicable,
    applyAction,
    applyActionState,
    isGoal,
    isGoalState,
    lexLess,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GOAP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
