/*
 * dijkstra.js — 第一阶段：走廊（corridor）选择
 *
 * 规则：在“当前门状态 + 余量”下可通行的有向边构成临时图，
 *   1) 通行费总和最小；
 *   2) 费用并列时，连接编号序列字典序最早。
 * 做法：从终点在反向图上跑一次 Dijkstra 得到最小费用距离 d[]，
 *   再从起点沿“d[u] = fee(e) + d[v]”的边贪心选编号最小者前进，
 *   天然给出字典序最早的最短序列，且无需在堆里携带序列。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CG = Object.assign(root.CG || {}, factory());
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 费用比较容差：长路径累加存在浮点误差，用绝对+相对组合容差
  const FEE_EPS = 1e-9;
  function feeEq(a, b) {
    return Math.abs(a - b) <= FEE_EPS + 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  }

  // 最小二叉堆（存储顶点下标，按外部 dist 数组排序）。
  // 允许同一顶点多次入堆；pop 时由调用方用 visited 做惰性删除。
  class MinHeap {
    constructor(capacity) {
      // 松弛次数上界 = 边数，容量留足
      this.heap = new Int32Array(Math.max(capacity * 2, 16));
      this.size = 0;
      this.dist = null;
    }
    clear() { this.size = 0; }
    push(node, dist) {
      this.dist = dist;
      const h = this.heap;
      if (this.size >= h.length) {
        const grown = new Int32Array(h.length * 2);
        grown.set(h); this.heap = grown;
      }
      let i = this.size++;
      // 上浮
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (dist[h[p]] <= dist[node]) break;
        h[i] = h[p]; i = p;
      }
      h[i] = node;
    }
    pop() {
      const h = this.heap, dist = this.dist;
      const top = h[0];
      const last = h[--this.size];
      if (this.size > 0) {
        let i = 0;
        // 标准下沉：last 不断与较小子节点交换，直到不大于两个子节点
        for (;;) {
          const l = i * 2 + 1;
          if (l >= this.size) break;
          const r = l + 1;
          let child = l;
          if (r < this.size && dist[h[r]] < dist[h[l]]) child = r;
          if (dist[last] <= dist[h[child]]) break;
          h[i] = h[child];
          i = child;
        }
        h[i] = last;
      }
      return top;
    }
  }

  /**
   * 在反向图上计算到 target 的最小费用距离。
   * @param map      数据模型
   * @param target   目标 cell 稠密下标
   * @param passable (edgeIdx) => boolean，可通行判定
   * @param outDist  可选复用的 Float64Array
   * @returns {dist, heap, visited}
   */
  function reverseDistances(map, target, passable, outDist) {
    const n = map.cellCount;
    const dist = outDist || new Float64Array(n);
    dist.fill(Infinity);
    const visited = new Uint8Array(n);
    const heap = new MinHeap(n);
    dist[target] = 0;
    heap.push(target, dist);

    const revAdj = map.revAdj, edges = map.edges;
    while (heap.size > 0) {
      const u = heap.pop();
      if (visited[u]) continue;
      visited[u] = 1;
      const du = dist[u];
      const list = revAdj[u];
      for (let k = 0; k < list.length; k++) {
        const ei = list[k];
        if (!passable(ei)) continue;
        const e = edges[ei];
        const v = e.fromIdx; // 反向：u 是边的终点
        const nd = du + e.fee;
        if (nd + FEE_EPS < dist[v]) {
          dist[v] = nd;
          heap.push(v, dist);
        }
      }
    }
    return { dist, visited, heap };
  }

  /**
   * 按字典序最早规则从起点走出连接编号序列。
   * adj 已按 edge id 升序，故取第一条可行的最短边即可。
   * 终止性：每条最短边满足 d[u] = fee(e) + d[v]，正常 fee>0 时 d 严格递减，
   * 故步数不超过 cellCount；用 next 距离必须严格下降作为护栏，
   * 仅在存在 0 费用环等异常数据时才返回 null。
   * @returns { edgePath: edgeIdx[], cellPath: cellIdx[] } 或 null（不可达/异常环）
   */
  function lexMinWalk(map, start, dist, passable) {
    const edgePath = [];
    const cellPath = [start];
    let u = start;
    let guard = 0;
    while (dist[u] > FEE_EPS) {
      if (++guard > map.cellCount + 1) return null;
      let chosen = -1;
      const list = map.adj[u];
      for (let k = 0; k < list.length; k++) {
        const ei = list[k];
        if (!passable(ei)) continue;
        const e = map.edges[ei];
        if (feeEq(dist[u], e.fee + dist[e.toIdx])) {
          chosen = ei;
          break; // adj 已按 id 排序 → 编号最小
        }
      }
      if (chosen < 0) return null;
      const v = map.edges[chosen].toIdx;
      // 距离必须下降（fee>0）；不降说明遇到 0 费用环等异常
      if (dist[v] >= dist[u] - FEE_EPS) return null;
      edgePath.push(chosen);
      cellPath.push(v);
      u = v;
    }
    return { edgePath, cellPath };
  }

  /**
   * 不可达三级诊断：
   *   L0 拓扑（忽略门状态与余量）仍不可达
   *   L1 所有门视为开启、余量为 0 后可达 → 有关闭的门挡住
   *   L2 当前门全开但余量为 0 后可达 → 余量过大挡住
   *   L3 当前设置仍不可达
   * @param isOpen (edgeIdx)=>boolean，已合并 UI 门状态覆盖后的开启判定
   * @returns { level, blockers: edgeIdx[] } blockers 为导致不可达的关闭/余量门
   */
  function diagnose(map, start, target, passableCurrent, isDoorEdge, isOpen) {
    isOpen = isOpen || ((ei) => map.edges[ei].open);
    const anyEdge = () => true;

    const r0 = reverseDistances(map, target, anyEdge);
    if (!Number.isFinite(r0.dist[start])) {
      return { level: 0, reason: 'topology', blockers: [], dist: r0.dist };
    }
    const r1 = reverseDistances(map, target, isOpen);
    if (!Number.isFinite(r1.dist[start])) {
      const blockers = map.edges
        .filter((e) => !isOpen(e.index) && isDoorEdge(e.index))
        .map((e) => e.index);
      return { level: 1, reason: 'closed-door', blockers, dist: r1.dist };
    }
    const r2 = reverseDistances(map, target, passableCurrent);
    if (!Number.isFinite(r2.dist[start])) {
      const blockers = map.edges
        .filter((e) => isOpen(e.index) && isDoorEdge(e.index) && !passableCurrent(e.index))
        .map((e) => e.index);
      return { level: 2, reason: 'margin', blockers, dist: r2.dist };
    }
    return { level: 3, reason: 'reachable', blockers: [], dist: r2.dist };
  }

  return { MinHeap, reverseDistances, lexMinWalk, diagnose, FEE_EPS };
});
