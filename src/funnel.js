/*
 * funnel.js — 第二阶段：同层走廊内的最短折线（漏斗/拉线算法）
 *
 * 输入：一串同层格 C0..Ck、起点 S（在 C0 内）、终点 T（在 Ck 内），
 *       以及按序穿越的门户 P1..Pk（每个为线段或单点，不能穿墙）。
 * 输出：从 S 到 T、依次穿过每个门户且不离开走廊的最短折线。
 *
 * 门户端点按“行进方向左/右”统一排序：
 * 对有向边 u->v，共边线方向 d 的左侧是 u 内部（多边形 CCW），
 * 用质心叉积判定，反向行走时交换左右。
 *
 * 参照实现 funnelViaVisibility 用可视性图 + Dijkstra 独立验证长度。
 */
(function (root, factory) {
  {
    const G = (typeof module !== 'undefined' && module.exports) ? require('./geometry') : root.CG;
    if (typeof module !== 'undefined' && module.exports) module.exports = factory(G);
    else root.CG = Object.assign(root.CG || {}, factory(G));
  }
})(typeof self !== 'undefined' ? self : globalThis, function (G) {
  'use strict';

  const EPS = 1e-12;

  // 三角形有向面积的 2 倍（v 在 ab 的左侧为正）
  function triArea2(a, b, v) {
    return (b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0]);
  }

  function eqPt(a, b) {
    return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
  }

  /**
   * 门户左右定向。
   * @param polyU    出发格多边形（CCW）
   * @param centerU  出发格质心
   * @param portal   [p, q] 原始两点（p==q 表示单点门）
   * @param forward  行走方向是否与有向边 u->v 一致
   */
  function orientPortal(polyU, centerU, portal, forward) {
    const [p, q] = portal;
    if (eqPt(p, q)) return { left: p, right: p, point: true };
    const dx = q[0] - p[0], dy = q[1] - p[1];
    // 质心相对有向边 p->q 的叉积：>0 质心在边的左侧
    const side = dx * (centerU[1] - p[1]) - dy * (centerU[0] - p[0]);
    let left, right;
    if (side > 0) { left = q; right = p; } else { left = p; right = q; }
    if (!forward) { const t = left; left = right; right = t; }
    return { left, right, point: false };
  }

  // 有向角（弧度，[-π,π]）：从 apex 指向 p 的方向角
  function ang(apex, p) {
    return Math.atan2(p[1] - apex[1], p[0] - apex[0]);
  }

  // 角度归一化到 [base-π, base+π)，用于跨越 ±π 分支时比较
  function norm(a, base) {
    while (a - base > Math.PI) a -= 2 * Math.PI;
    while (a - base < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /**
   * 漏斗主算法（贪心 + 全量角度区间，数学严格、无索引状态）。
   * 思路：从当前 apex 出发，逐门户累积可行方向角区间 [lo,hi]：
   *   - 门户角度区间与当前可行区间有交 → 收紧，继续；
   *   - 无交（点门户落在区间外同理）→ 当前 lo/hi 对应的边界点成为新 apex，
   *     从新 apex 的下一个门户重新累积。
   * 每个门户的左右端点角都相对【当前 apex】实时计算，绕 ±π 用 norm 归一。
   * 复杂度 O(k²)（每次收口重扫后缀），k 为同层走廊格数，2 万规模仍为毫秒级。
   */
  function funnelPath(start, target, portals) {
    const leftPts = [start], rightPts = [start], isPoint = [false];
    for (const p of portals) {
      leftPts.push(p.left); rightPts.push(p.right); isPoint.push(!!p.point);
    }
    leftPts.push(target); rightPts.push(target); isPoint.push(true);
    const n = leftPts.length;

    const pts = [start];
    let apexPt = start;   // 当前 apex 的实际坐标（可能是某门户的左或右端点）
    let scanFrom = 1;     // 下一道要处理的门户索引（leftPts 下标）

    while (scanFrom < n) {
      const apex = apexPt;
      // 用第一道门户初始化可行区间；所有角度统一相对 base 归一，避免跨 ±π 错乱
      let j = scanFrom;
      const base = ang(apex, rightPts[j]);
      let a0 = norm(ang(apex, rightPts[j]), base);
      let a1 = norm(ang(apex, leftPts[j]), base);
      let lo, hi, loB, hiB; // loB/hiB = {idx, pt}
      if (a0 <= a1) {
        lo = a0; hi = a1;
        loB = { idx: j, pt: rightPts[j] }; hiB = { idx: j, pt: leftPts[j] };
      } else {
        lo = a1; hi = a0;
        loB = { idx: j, pt: leftPts[j] }; hiB = { idx: j, pt: rightPts[j] };
      }
      let closed = false;

      for (j = scanFrom + 1; j < n; j++) {
        // 统一相对 base 归一，保证两角在同一 2π 周期
        const ar = norm(ang(apex, rightPts[j]), base);
        const al = norm(ang(apex, leftPts[j]), base);
        const rlo = Math.min(ar, al), rhi = Math.max(ar, al);
        const loCand = ar <= al ? { idx: j, pt: rightPts[j] } : { idx: j, pt: leftPts[j] };
        const hiCand = ar <= al ? { idx: j, pt: leftPts[j] } : { idx: j, pt: rightPts[j] };

        const newLo = Math.max(lo, rlo);
        const newHi = Math.min(hi, rhi);
        if (newLo > newHi + EPS) {
          // 无交：在顶到对侧的当前边界点收口。
          // 新门户下界 rlo 顶到当前上界 hi → 左边界点 hiB 挡住；否则右边界点 loB 挡住。
          const bend = rlo >= hi - EPS ? hiB : loB;
          pts.push(bend.pt);
          apexPt = bend.pt;     // 记住实际端点坐标
          scanFrom = bend.idx + 1; // 从该门户的下一道重新扫描
          closed = true;
          break;
        }
        if (newLo > lo + EPS) { lo = newLo; loB = loCand; }
        if (newHi < hi - EPS) { hi = newHi; hiB = hiCand; }
      }

      if (!closed) break;
    }

    if (!eqPt(pts[pts.length - 1], target)) pts.push(target);
    return simplifyCollinear(pts);
  }

  // 去除三点共线的中间点（长度不变，端点保持不动）
  function simplifyCollinear(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      if (Math.abs(triArea2(pts[i - 1], pts[i], pts[i + 1])) > EPS) out.push(pts[i]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * 独立参照：门户稠密采样 + 分层 DP。
   * 最短折线的折点可能落在门户线段内部，故沿每个门户均匀采样 samples 个点，
   * 层 0 = 起点，层 k+1 = 门户 k 的采样点，末层 = 终点；
   * 转移要求两端点同属某凸格（凸性 ⇒ 线段整体在格内），随 samples 增大收敛到真值。
   * 与漏斗算法完全独立，仅用于测试互验（比较时留 1e-4 量级的采样误差）。
   */
  function funnelViaVisibility(start, target, portals, cells, geometry, samples) {
    const geo = geometry || G;
    const n = samples || 120;
    const layers = [[start]];
    for (const p of portals) {
      const layer = [];
      if (eqPt(p.left, p.right)) layer.push(p.left);
      else for (let i = 0; i <= n; i++) layer.push(geo.lerp(p.left, p.right, i / n));
      layers.push(layer);
    }
    layers.push([target]);

    const dp = layers.map((layer) => new Array(layer.length).fill(Infinity));
    const prev = layers.map((layer) => new Array(layer.length).fill(null));
    dp[0][0] = 0;

    for (let j = 1; j < layers.length; j++) {
      for (let b = 0; b < layers[j].length; b++) {
        const v = layers[j][b];
        for (let i = 0; i < j; i++) {
          for (let a = 0; a < layers[i].length; a++) {
            if (!Number.isFinite(dp[i][a])) continue;
            const u = layers[i][a];
            const inside = cells.some((c) =>
              geo.pointInConvex(u, c.poly, 1e-9) && geo.pointInConvex(v, c.poly, 1e-9));
            if (!inside) continue;
            const nd = dp[i][a] + geo.dist(u, v);
            if (nd < dp[j][b]) {
              dp[j][b] = nd;
              prev[j][b] = [i, a];
            }
          }
        }
      }
    }

    const lastLayer = layers.length - 1;
    const path = [];
    let cur = [lastLayer, 0];
    while (cur) {
      path.push(layers[cur[0]][cur[1]]);
      cur = prev[cur[0]][cur[1]];
    }
    path.reverse();
    return { length: dp[lastLayer][0], path };
  }

  return { orientPortal, funnelPath, simplifyCollinear, funnelViaVisibility, triArea2, eqPt };
});
