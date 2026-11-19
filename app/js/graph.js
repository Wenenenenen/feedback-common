// 图连通性、最大生成树与各图到参考图的单应组合。
// edges 输入项：{ a, b, pairs, inliers, H }，H 为 a->b 的归一化单应。

import { identity3, invert3, matMul, normalizeH } from './linalg.js';

class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) {
    while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; }
    return x;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    this.p[rb] = ra;
    return true;
  }
}

// 以“内点数量”为边权的最大生成树（Kruskal，内点多的边优先；同权按输入顺序，保证可复现）。
// 返回 { treeEdges, nonTreeEdges, components, connectedToRef }
export function buildSpanningTree(imageCount, edges) {
  const usable = edges
    .map((e, idx) => ({ e, idx, weight: e.inliers ? e.inliers.length : 0 }))
    .filter((x) => x.weight >= 4)
    .sort((x, y) => y.weight - x.weight || x.idx - y.idx);
  const dsu = new DSU(imageCount);
  const treeEdges = [];
  const usedIdx = new Set();
  for (const { e, idx } of usable) {
    if (dsu.union(e.a, e.b)) {
      treeEdges.push({ ...e, edgeIndex: idx });
      usedIdx.add(idx);
    }
  }
  const nonTreeEdges = edges
    .map((e, idx) => ({ ...e, edgeIndex: idx }))
    .filter((e) => !usedIdx.has(e.edgeIndex) && (e.inliers ? e.inliers.length >= 4 : false));
  // 连通分量
  const rootOf = Array.from({ length: imageCount }, (_, i) => dsu.find(i));
  const components = {};
  rootOf.forEach((r, i) => {
    (components[r] ||= []).push(i);
  });
  return {
    treeEdges,
    nonTreeEdges,
    components: Object.values(components),
  };
}

// 从参考图出发在树上 BFS，组合出每张图到参考平面的单应 H_i->ref。
// 树上边 H 为 a->b；从 ref 向两侧传播：
//   若已知 H_a->ref，则 H_b->ref = H_a->ref * H_b->a = H_a->ref * inv(H_a->b)
//   若已知 H_b->ref，则 H_a->ref = H_b->ref * H_a->b
export function composeToReference(imageCount, reference, treeEdges) {
  const adj = Array.from({ length: imageCount }, () => []);
  for (const te of treeEdges) {
    adj[te.a].push({ to: te.b, forward: true, edge: te });      // H_a->b
    adj[te.b].push({ to: te.a, forward: false, edge: te });     // H_b->a = inv
  }
  const toRef = new Array(imageCount).fill(null);
  const parentEdge = new Array(imageCount).fill(null);
  toRef[reference] = identity3();
  const queue = [reference];
  while (queue.length) {
    const u = queue.shift();
    for (const link of adj[u]) {
      if (toRef[link.to] !== null) continue;
      const H_u_ref = toRef[u];
      let H_step;
      if (link.forward) {
        // u = a, to = b：H_b->a = inv(H_a->b)，H_b->ref = H_a->ref * inv(H_a->b)
        H_step = matMul(H_u_ref, invert3(link.edge.H));
      } else {
        // u = b, to = a：H_a->ref = H_b->ref * H_a->b
        H_step = matMul(H_u_ref, link.edge.H);
      }
      toRef[link.to] = normalizeH(H_step);
      parentEdge[link.to] = link.edge;
      queue.push(link.to);
    }
  }
  return { toRef, parentEdge };
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

// 非树边（闭环）残差：把边的内点对应从两端分别映到参考平面，
// 报告参考平面上的欧氏对应残差（max/mean/rms）。
export function loopClosureResiduals(edges, toRef) {
  const reports = [];
  for (const edge of edges) {
    if (!toRef[edge.a] || !toRef[edge.b]) continue;
    const H_a_ref = toRef[edge.a];
    const H_b_ref = toRef[edge.b];
    const inlierIdx = edge.inliers || [];
    if (inlierIdx.length === 0) continue;
    let max = 0, sum = 0, sumSq = 0;
    const details = [];
    for (const i of inlierIdx) {
      const [pa, pb] = edge.pairs[i];
      const [ax, ay] = applyH(H_a_ref, pa[0], pa[1]);
      const [bx, by] = applyH(H_b_ref, pb[0], pb[1]);
      const d = Math.hypot(ax - bx, ay - by);
      max = Math.max(max, d);
      sum += d;
      sumSq += d * d;
      details.push({ pairIndex: i, residual: d });
    }
    reports.push({
      a: edge.a,
      b: edge.b,
      count: inlierIdx.length,
      maxResidual: max,
      meanResidual: sum / inlierIdx.length,
      rmsResidual: Math.sqrt(sumSq / inlierIdx.length),
      details,
    });
  }
  return reports;
}
