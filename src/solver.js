// solver.js —— 上下关系求解
// 变量：每个交点 c 取 bit(c) ∈ {0,1}，表示 c.a（编号较小线）是否在上。
// 同一条线沿路相邻两个交点必须一上一下：
//   bit(u) XOR bit(v) = w
//   w = 0：两交点的“小号线在上”状态相同；w = 1：相反。
// 这是带边权的二值异或方程组，等价于二染色；奇环/锁冲突即矛盾。

/** 并查集（仅整数根，路径压缩 + 按秩合并）。 */
class DSU {
  constructor(n) {
    this.p = Int32Array.from({ length: n }, (_, i) => i);
    this.r = new Int8Array(n);
  }
  find(x) {
    const p = this.p;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  union(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a === b) return;
    if (this.r[a] < this.r[b]) [a, b] = [b, a];
    this.p[b] = a;
    if (this.r[a] === this.r[b]) this.r[a]++;
  }
}

/**
 * @param {ReturnType<typeof import('./model.js').buildModel>} model
 * @param {Map<number, number>} pinMap  cid -> 锁定在上的 strand id
 * @returns {{
 *   values: Int8Array, above: Int32Array, conflictCount: number,
 *   conflicts: Array<{kind:string, cid?:number, path:number[], detail:string}>,
 * }}
 */
export function solve(model, pinMap) {
  const { crossings, strands, strandById } = model;
  const n = crossings.length;

  // ---- 1. 构建约束图（CSR）。边来自每条线行进顺序中的相邻交点，闭线首尾相连 ----
  const src = [], dst = [], wgt = [];
  for (const st of strands) {
    const m = st.order.length;
    if (m < 2) {
      // 0 或 1 个交点的线没有交替约束；闭线只有 1 个交点时自环 w=1 必矛盾
      if (m === 1 && st.closed) {
        const c = st.order[0].cid;
        src.push(c); dst.push(c); wgt.push(1);
      }
      continue;
    }
    const pairs = st.closed ? m : m - 1;
    for (let i = 0; i < pairs; i++) {
      const u = st.order[i].cid;
      const v = st.order[(i + 1) % m].cid;
      // 交替条件：线 s 在相邻交点的“自身在上”状态相反。
      // t(c)=1 当 s 是 c 的大号线；s 在上 ⇔ bit(c)===t(c)。
      // 异或展开得：bit(u) XOR bit(v) = 1 XOR t(u) XOR t(v)。
      const tu = st.id === crossings[u].b ? 1 : 0;
      const tv = st.id === crossings[v].b ? 1 : 0;
      const w = 1 ^ tu ^ tv;
      src.push(u); dst.push(v); wgt.push(w);
    }
  }

  const degree = new Int32Array(n);
  for (let i = 0; i < src.length; i++) {
    degree[src[i]]++;
    if (dst[i] !== src[i]) degree[dst[i]]++;
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + degree[i];
  const adjTo = new Int32Array(src.length * 2);
  const adjW = new Int8Array(src.length * 2);
  const cursor = Int32Array.from(start);
  for (let i = 0; i < src.length; i++) {
    const u = src[i], v = dst[i], w = wgt[i];
    let p = cursor[u]++;
    adjTo[p] = v; adjW[p] = w;
    if (u !== v) {
      p = cursor[v]++;
      adjTo[p] = u; adjW[p] = w;
    }
  }

  // ---- 2. DSU 求连通分量，并为每个分量挑选种子 ----
  const dsu = new DSU(n);
  for (let i = 0; i < src.length; i++) dsu.union(src[i], dst[i]);

  // 种子优先取锁点；无锁分量取 (y,x) 次序最早的交点（cid 即按 y,x 编号，天然最小）
  const seed = new Map();
  for (let cid = 0; cid < n; cid++) {
    const r = dsu.find(cid);
    if (!seed.has(r)) seed.set(r, cid);
  }
  for (const [cid] of pinMap) {
    seed.set(dsu.find(cid), cid);
  }

  // ---- 3. BFS 带符号二值传播 ----
  const values = new Int8Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n).fill(-1);
  /** @type {Array<{kind:string, cid?:number, path:number[], detail:string}>} */
  const conflicts = [];
  const MAX_CONFLICTS = 200;

  const pinValue = (cid) => {
    const c = crossings[cid];
    return pinMap.get(cid) === c.a ? 0 : 1; // 0=小号线在上，1=大号线在上
  };

  const lca = (u, v) => {
    while (depth[u] > depth[v]) u = parent[u];
    while (depth[v] > depth[u]) v = parent[v];
    while (u !== v) { u = parent[u]; v = parent[v]; }
    return u;
  };
  /** 还原 u 到根（含两端）的 cid 路径。 */
  const pathToRoot = (u, root) => {
    const path = [];
    for (let x = u; ; x = parent[x]) {
      path.push(x);
      if (x === root) break;
    }
    return path;
  };
  const recordCycle = (u, v, w) => {
    if (conflicts.length >= MAX_CONFLICTS) return;
    const g = lca(u, v);
    const pu = pathToRoot(u, g);                 // u ... g（含 g）
    const pv = pathToRoot(v, g).reverse();       // g ... v（含 g）
    // 两段在 g 处相接，去掉 pv 端重复的 g；u===g 或 v===g 时同样成立
    const path = [...pu, ...pv.slice(1)];
    conflicts.push({
      kind: 'cycle',
      cid: u,
      path,
      detail:
        `交替约束闭环长度为奇数：沿该链走一圈，交点 ${pointLabel(crossings[u])} ` +
        `的上层要求与自身相反（闭合边 XOR=${w}）。链上共 ${path.length} 个交点。`,
    });
  };

  for (const [, seedCid] of seed) {
    if (values[seedCid] !== -1) continue;
    const root = dsu.find(seedCid);
    const pinned = pinMap.has(seedCid);
    values[seedCid] = pinned ? pinValue(seedCid) : 0;
    depth[seedCid] = 0;
    let cycleRecorded = false; // 同一分量的奇环只报一条代表链
    const queue = [seedCid];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      for (let p = start[u]; p < start[u + 1]; p++) {
        const v = adjTo[p], w = adjW[p];
        const expect = values[u] ^ w;
        if (v === u) {
          // 自环（闭线仅一个交点且要求交替）
          if (w === 1 && !cycleRecorded && conflicts.length < MAX_CONFLICTS) {
            cycleRecorded = true;
            conflicts.push({
              kind: 'selfloop', cid: u, path: [u],
              detail: `闭线 ${soleStrand(model, u)} 只经过一个交点 ${pointLabel(crossings[u])}，` +
                '首尾相邻要求该点同时在上与在下，无法交替。',
            });
          }
          continue;
        }
        if (values[v] === -1) {
          values[v] = expect;
          parent[v] = u;
          depth[v] = depth[u] + 1;
          queue.push(v);
        } else if (values[v] !== expect && !cycleRecorded &&
                   conflicts.length < MAX_CONFLICTS) {
          cycleRecorded = true;
          recordCycle(u, v, w);
        }
      }
    }
    // 分量内锁点与传播结果不一致（或两个锁点互相打架）
    for (const cid of pinMap.keys()) {
      if (dsu.find(cid) !== root || values[cid] === -1) continue;
      if (values[cid] !== pinValue(cid)) {
        if (conflicts.length < MAX_CONFLICTS) {
          const g = lca(cid, seedCid);
          const p1 = pathToRoot(cid, g);
          const p2 = pathToRoot(seedCid, g).reverse();
          conflicts.push({
            kind: 'pin',
            cid,
            path: [...p1, ...p2.slice(1)],
            detail: `锁定 ${pointLabel(crossings[cid])} 上层为线 ${pinMap.get(cid)}，` +
              `但沿交替链传播要求上层为线 ${values[cid] === 0 ? crossings[cid].a : crossings[cid].b}。`,
          });
        }
      }
    }
  }

  // ---- 4. 无约束的孤立交点（两条线都只经过它）同样适用默认规则 ----
  for (let cid = 0; cid < n; cid++) {
    if (values[cid] === -1) values[cid] = 0;
  }

  const above = new Int32Array(n);
  for (let cid = 0; cid < n; cid++) {
    above[cid] = values[cid] === 0 ? crossings[cid].a : crossings[cid].b;
  }

  return { values, above, conflictCount: conflicts.length, conflicts };
}

function soleStrand(model, cid) {
  const c = model.crossings[cid];
  for (const sid of [c.h, c.v]) {
    const st = model.strandById.get(sid);
    if (st.closed && st.order.length === 1) return sid;
  }
  return `${c.h}/${c.v}`;
}

const pointLabel = (c) => `(${c.x},${c.y})`;
