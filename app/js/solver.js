// solver.js — 配音候选组合的分层动态规划求解器
// 纯函数、无 DOM 依赖，可直接在 Node 中测试。
//
// 候选字段: { id, take, src, dst, len, cost }
//   id   全局唯一编号(字典序平局判定用)
//   take 源轨编号(零起)
//   src  源起帧
//   dst  目标起帧
//   len  长度(帧)
//   cost 候选本身代价(非负)
// 句子字段: { slot: [起, 止)(半开), candidates: [] }
//
// 约束:
//   1. 候选整体落在目标半开槽内: dst >= slot[0] 且 dst+len <= slot[1]
//   2. 相邻句子音频之间至少留 gap 帧静音: dst[k] >= dst[k-1]+len[k-1]+gap
//   3. 相邻选中同一源轨时, 源区间不得重叠或倒退: src[k] >= src[k-1]+len[k-1]
//      (首尾相接允许; 不同源轨无此约束)
//   4. 切轨(相邻源轨变化)次数 <= changes
// 目标: 最小化 总候选代价 + switchCost * 切轨次数
// 平局: 先比切轨次数, 再比候选编号序列的字典序
//
// 字典序的实现: 每个 DP 层幸存状态对应一条互不相同的编号前缀,
// 按 (前驱前缀排名, 当前编号) 排序给出层内排名, 于是序列比较变成整数比较。

const INF = Number.POSITIVE_INFINITY;

/**
 * @param {{gap:number, switchCost:number, changes:number, cues:Array}} instance
 * @param {{locks?:Map<number,number>, budget?:number}} [options]
 *   locks: 句子序号 -> 被锁定的候选全局编号
 * @returns 成功 {ok:true, ids:number[], chosen:object[], totalCost, switches,
 *                 layers:number, states:number, solveMs}
 *          失败 {ok:false, failedCue:number, reason:string}
 */
export function solve(instance, options = {}) {
  const t0 = nowMs();
  const { gap, switchCost } = instance;
  const budget = Math.max(0, Math.min(12, options.budget ?? instance.changes ?? 12));
  const locks = options.locks ?? new Map();
  const B = budget + 1;

  // ---- 1. 每个句子先按槽位与锁定过滤候选 ----
  const layers = [];
  for (let k = 0; k < instance.cues.length; k++) {
    const cue = instance.cues[k];
    const slotS = cue.slot[0];
    const slotE = cue.slot[1];
    const lockId = locks.has(k) ? locks.get(k) : null;
    const cands = [];
    for (const c of cue.candidates) {
      if (lockId !== null && c.id !== lockId) continue;
      if (c.dst < slotS || c.dst + c.len > slotE) continue;
      cands.push(c);
    }
    if (cands.length === 0) {
      return {
        ok: false,
        failedCue: k,
        reason: lockId !== null ? 'locked-candidate-unavailable' : 'no-candidate-fits-slot',
        solveMs: elapsed(t0),
      };
    }
    cands.sort((a, b) => a.id - b.id);
    layers.push(cands);
  }

  const n = layers.length;
  if (n === 0) {
    return { ok: true, ids: [], chosen: [], totalCost: 0, switches: 0, layers: 0, states: 0, solveMs: 0 };
  }

  // ---- 2. 第 0 层: 切轨数只能为 0 ----
  let m = layers[0].length;
  let prevCost = new Float64Array(m * B);
  let prevRank = new Int32Array(m * B);
  prevCost.fill(INF);
  prevRank.fill(-1);
  for (let j = 0; j < m; j++) prevCost[j * B] = layers[0][j].cost;

  const history = new Array(n); // 每层记录回溯网格
  history[0] = { m, back: null };

  let survivors = [];
  for (let s = 0; s < m * B; s++) if (prevCost[s] !== INF) survivors.push(s);
  // 第 0 层排名即按编号排序
  survivors.sort((a, b) => layers[0][(a / B) | 0].id - layers[0][(b / B) | 0].id);
  for (let r = 0; r < survivors.length; r++) prevRank[survivors[r]] = r;

  let totalStates = survivors.length;

  // ---- 3. 逐层推进 ----
  for (let k = 1; k < n; k++) {
    const prevLayer = layers[k - 1];
    const curLayer = layers[k];
    const mp = prevLayer.length;
    m = curLayer.length;

    // 边界合法性矩阵 allow[j * mp + i]: 当前候选 j 能否接在前候选 i 之后
    const allow = new Uint8Array(m * mp);
    for (let j = 0; j < m; j++) {
      const cj = curLayer[j];
      const row = j * mp;
      for (let i = 0; i < mp; i++) {
        const pi = prevLayer[i];
        if (cj.dst < pi.dst + pi.len + gap) continue;
        if (cj.take === pi.take && cj.src < pi.src + pi.len) continue;
        allow[row + i] = 1;
      }
    }

    const curCost = new Float64Array(m * B);
    const curPredRank = new Int32Array(m * B);
    const curBack = new Int32Array(m * B);
    curCost.fill(INF);
    curPredRank.fill(0x7fffffff);
    curBack.fill(-1);

    const cMax = Math.min(budget, k); // 第 k 层至多 k 次切轨
    for (let j = 0; j < m; j++) {
      const cj = curLayer[j];
      const baseJ = j * B;
      const row = j * mp;
      for (let i = 0; i < mp; i++) {
        if (!allow[row + i]) continue;
        const pi = prevLayer[i];
        const diff = cj.take !== pi.take ? 1 : 0;
        const add = cj.cost + diff * switchCost;
        const baseI = i * B;
        for (let c = diff; c <= cMax; c++) {
          const ps = baseI + (c - diff);
          const pv = prevCost[ps];
          if (pv === INF) continue;
          const nc = pv + add;
          const cs = baseJ + c;
          // 同状态内切轨数天然相等, 同代价时比前缀排名(等价于完整编号序列字典序)
          if (nc < curCost[cs] || (nc === curCost[cs] && prevRank[ps] < curPredRank[cs])) {
            curCost[cs] = nc;
            curPredRank[cs] = prevRank[ps];
            curBack[cs] = ps;
          }
        }
      }
    }

    const curSurvivors = [];
    for (let s = 0; s < m * B; s++) if (curCost[s] !== INF) curSurvivors.push(s);
    if (curSurvivors.length === 0) {
      return { ok: false, failedCue: k, reason: 'no-legal-prefix', solveMs: elapsed(t0) };
    }

    // 按 (前驱排名, 当前编号) 排序赋予本层排名
    curSurvivors.sort((a, b) => {
      const d = curPredRank[a] - curPredRank[b];
      if (d !== 0) return d;
      return curLayer[(a / B) | 0].id - curLayer[(b / B) | 0].id;
    });
    const curRank = new Int32Array(m * B);
    curRank.fill(-1);
    for (let r = 0; r < curSurvivors.length; r++) curRank[curSurvivors[r]] = r;

    history[k] = { m, back: curBack };
    prevCost = curCost;
    prevRank = curRank;
    survivors = curSurvivors;
    totalStates += survivors.length;
  }

  // ---- 4. 终选: 总代价 -> 切轨数 -> 排名(编号序列字典序) ----
  let bestS = survivors[0];
  for (let r = 1; r < survivors.length; r++) {
    const s = survivors[r];
    if (
      prevCost[s] < prevCost[bestS] ||
      (prevCost[s] === prevCost[bestS] &&
        ((s % B) < (bestS % B) || ((s % B) === (bestS % B) && prevRank[s] < prevRank[bestS])))
    ) {
      bestS = s;
    }
  }

  // ---- 5. 回溯 ----
  const chosen = new Array(n);
  const ids = new Array(n);
  let s = bestS;
  for (let k = n - 1; k >= 0; k--) {
    const j = (s / B) | 0;
    chosen[k] = layers[k][j];
    ids[k] = layers[k][j].id;
    if (k > 0) s = history[k].back[s];
  }

  return {
    ok: true,
    ids,
    chosen,
    totalCost: prevCost[bestS],
    switches: bestS % B,
    layers: n,
    states: totalStates,
    solveMs: elapsed(t0),
  };
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
function elapsed(t0) {
  return nowMs() - t0;
}
