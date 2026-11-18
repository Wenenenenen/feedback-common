/*
 * segment.js — 标记引导测地距离分割（多源 Dijkstra，纯手写，无任何图分割/区域生长库）
 * UMD：浏览器挂 window.MGSSegment，Node 走 module.exports。
 *
 * 约定（samples/extracted/约定.json）：
 *  - 种子代价 0；边代价 = step * (256 + |gray(p)-gray(q)|)
 *    正交 step=10，对角 step=14，全部整数运算。
 *  - 八邻域对角边仅在两个正交相邻像素都位于有效掩膜内时可通行（防穿角）。
 *  - 标签 1..32，不要求连续；同标签多种子，标签成本 = 其任一种子的最短路。
 *  - 唯一最低成本标签获归属；不同标签最低成本相等 → 分界 0。
 *  - 分界只影响最终输出，不阻断路径：每个像素保留两个最优“不同标签”状态参与传播。
 *  - 允许路径经过其他标签的种子；种子自身代价 0，恒归自己。
 *  - 有效掩膜内无可达种子的像素 = 未到达；掩膜外 = 排除。
 * 结果与种子输入顺序无关。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MGSSegment = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ORTHO_STEP = 10;
  const DIAG_STEP = 14;
  const GRAY_BASE = 256;
  const INF = Infinity;

  // 4 邻域：右、左、下、上；8 邻域追加 4 个对角
  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  /**
   * 最小二叉堆。条目为 [index, distance, label]，按 distance 排序。
   * 不做 decrease-key：允许重复条目，弹出时与像素当前状态比对丢弃陈旧条目。
   */
  function MinHeap() {
    this.a = [];
  }
  MinHeap.prototype.push = function (idx, d, lab) {
    const a = this.a;
    let i = a.length;
    a.push([idx, d, lab]);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][1] <= d) break;
      const t = a[parent]; a[parent] = a[i]; a[i] = t;
      i = parent;
    }
  };
  MinHeap.prototype.pop = function () {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && a[l][1] < a[m][1]) m = l;
        if (r < n && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  };
  MinHeap.prototype.size = function () { return this.a.length; };

  /**
   * 校验并规范化种子。
   * 返回 { seeds, duplicates }；重复的同坐标同标签种子去重；
   * 同坐标不同标签直接抛错（冲突标签拒绝）。
   */
  function normalizeSeeds(seeds, width, height, mask) {
    const seen = new Map(); // idx -> label
    const out = [];
    const duplicates = [];
    const usedLabels = new Set();
    for (let k = 0; k < seeds.length; k++) {
      const s = seeds[k];
      const label = Number(s.label), x = Number(s.x), y = Number(s.y);
      if (!Number.isInteger(label) || label < 1 || label > 32) {
        throw new Error("种子标签必须是 1..32 的整数（第 " + (k + 1) + " 个种子）");
      }
      if (!Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error("种子坐标越界：label=" + label + " (" + x + "," + y + ")");
      }
      const idx = y * width + x;
      if (mask && !mask[idx]) {
        throw new Error("种子落在有效掩膜之外：label=" + label + " (" + x + "," + y + ")");
      }
      const prev = seen.get(idx);
      if (prev === undefined) {
        seen.set(idx, label);
        out.push({ label, x, y, idx });
      } else if (prev === label) {
        duplicates.push({ label, x, y });
      } else {
        throw new Error("冲突标签拒绝：像素 (" + x + "," + y +
          ") 同时被标签 " + prev + " 和 " + label + " 标记");
      }
      usedLabels.add(label);
    }
    if (!out.length) throw new Error("至少需要一个有效种子");
    return { seeds: out, duplicates, labels: Array.from(usedLabels).sort((a, b) => a - b) };
  }

  /**
   * 主入口。
   * @param gray   Uint8Array/Uint8ClampedArray，长度 w*h
   * @param width  宽（<=512）
   * @param height 高（<=512）
   * @param opts   { mask: Uint8Array|null(255=有效), connectivity: 4|8, seeds: [{label,x,y}] }
   * @returns {
   *   width,height,connectivity,
   *   labels:  Uint16Array  归属标签；0 表示分界/未到达/排除（由 tie/unreached/excluded 区分）
   *   cost:    Float64Array 每个像素的最低标签成本；未到达=Infinity
   *   tie:     Uint8Array   1=分界像素
   *   reached: Uint8Array   1=有效掩膜内可达
   *   excluded:Uint8Array   1=掩膜外
   *   labelsUsed: number[]
   *   duplicates, seedCount
   * }
   */
  function segment(gray, width, height, opts) {
    if (width > 512 || height > 512) {
      throw new Error("单边最多 512 像素");
    }
    const connectivity = opts.connectivity === 8 ? 8 : 4;
    const mask = opts.mask || null;
    const n = width * height;
    const norm = normalizeSeeds(opts.seeds || [], width, height, mask);
    const labelsUsed = norm.labels;
    const K = labelsUsed.length; // 不同标签数（<=32）
    // 标签号 → 紧凑下标 0..K-1
    const labelIndex = new Map();
    labelsUsed.forEach((lab, i) => labelIndex.set(lab, i));

    // 每个像素为每个到达过它的标签保留一个最优距离。
    // 必须保留全部不同标签（而非仅前两名）：三个及以上标签并列最优时，
    // 任一方都不能被挤掉，否则等代价分界会漏判。
    // dist[i*K+k] = 标签 k 到像素 i 的最短路；Infinity 表示未到达。
    const dist = new Float64Array(n * K).fill(INF);
    const present = new Uint32Array(n); // 位图：标签 k 是否到达过该像素
    const bestDist = new Float64Array(n).fill(INF);
    const bestLabel = new Uint16Array(n);  // 取得最低成本的标签号
    const tieCount = new Uint16Array(n);   // 达到最低成本的不同标签数

    const heap = new MinHeap();
    for (const s of norm.seeds) {
      const k = labelIndex.get(s.label);
      const slot = s.idx * K + k;
      if (dist[slot] === 0) continue; // 同标签种子已在该像素初始化（去重后理论上不会发生）
      dist[slot] = 0;
      present[s.idx] |= (1 << k);
      if (bestDist[s.idx] === INF) {
        bestDist[s.idx] = 0;
        bestLabel[s.idx] = s.label;
        tieCount[s.idx] = 1;
      } else if (bestDist[s.idx] === 0) {
        // 该像素已有其它标签种子（冲突在 normalizeSeeds 已拒绝，这里仅防御）
        tieCount[s.idx]++;
      }
      heap.push(s.idx, 0, s.label);
    }

    // 即时计算邻居（4/8 个方向，代价低，省去每像素小数组的内存与分配）
    while (heap.size()) {
      const [idx, d, lab] = heap.pop();
      const k = labelIndex.get(lab);
      // 丢弃陈旧条目：该标签在此像素的当前最优距离已不是弹出值
      if (dist[idx * K + k] !== d) continue;

      const gp = gray[idx];
      const px = idx % width, py = (idx / width) | 0;
      for (let e = 0; e < (connectivity === 8 ? 8 : 4); e++) {
        const dirs = e < 4 ? ORTHO[e] : DIAG[e - 4];
        const step = e < 4 ? ORTHO_STEP : DIAG_STEP;
        const nx = px + dirs[0], ny = py + dirs[1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nidx = ny * width + nx;
        if (mask && !mask[nidx]) continue;
        if (e >= 4 && mask &&
          (!mask[py * width + nx] || !mask[ny * width + px])) continue;

        const nd = d + step * (GRAY_BASE + Math.abs(gp - gray[nidx]));
        const slot = nidx * K + k;
        const known = dist[slot];
        if (nd >= known) continue; // 该标签已有更优/等优路径
        dist[slot] = nd;
        const isNew = !(present[nidx] & (1 << k));
        present[nidx] |= (1 << k);

        if (isNew) {
          if (nd < bestDist[nidx]) {
            bestDist[nidx] = nd;
            bestLabel[nidx] = lab;
            tieCount[nidx] = 1;
          } else if (nd === bestDist[nidx]) {
            tieCount[nidx]++;
          }
        } else {
          // 该标签以更短距离刷新：重算最低成本与并列数
          if (nd < bestDist[nidx]) {
            bestDist[nidx] = nd;
            bestLabel[nidx] = lab;
          }
          let cnt = 0;
          const base = nidx * K;
          const bd = bestDist[nidx];
          for (let j = 0; j < K; j++) if (dist[base + j] === bd) cnt++;
          tieCount[nidx] = cnt;
        }
        heap.push(nidx, nd, lab);
      }
    }

    // 汇总输出
    const labels = new Uint16Array(n);
    const tie = new Uint8Array(n);
    const reached = new Uint8Array(n);
    const excluded = new Uint8Array(n);
    for (let idx = 0; idx < n; idx++) {
      if (mask && !mask[idx]) {
        excluded[idx] = 1;
        continue;
      }
      if (!present[idx]) continue; // 无任何标签到达 → 未到达
      reached[idx] = 1;
      if (tieCount[idx] >= 2) {
        tie[idx] = 1; // 两个及以上不同标签最低成本相等 → 分界，标签保持 0
      } else {
        labels[idx] = bestLabel[idx];
      }
    }

    return {
      width, height, connectivity,
      labels, cost: bestDist, tie, reached, excluded,
      labelsUsed: norm.labels,
      duplicates: norm.duplicates,
      seedCount: norm.seeds.length
    };
  }

  /**
   * 逐标签统计：非 0 归属像素的面积、灰度均值、左闭右开包围盒。
   * 另返回全局 counts（tie/unreached/excluded）与每个标签的种子列表。
   */
  function buildStats(result, gray, seeds) {
    const { width, height, labels, tie, reached, excluded } = result;
    const acc = new Map();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const lab = labels[idx];
        if (!lab) continue;
        let a = acc.get(lab);
        if (!a) {
          a = { label: lab, area: 0, graySum: 0, minX: x, minY: y, maxX: x, maxY: y };
          acc.set(lab, a);
        }
        a.area++;
        a.graySum += gray[idx];
        if (x < a.minX) a.minX = x;
        if (x > a.maxX) a.maxX = x;
        if (y < a.minY) a.minY = y;
        if (y > a.maxY) a.maxY = y;
      }
    }
    const perLabel = Array.from(acc.values())
      .sort((p, q) => p.label - q.label)
      .map((a) => ({
        label: a.label,
        area: a.area,
        meanGray: Number((a.graySum / a.area).toFixed(4)),
        bbox: [a.minX, a.minY, a.maxX + 1, a.maxY + 1] // 左闭右开 [x0,y0,x1,y1)
      }));
    let tieCount = 0, unreachedCount = 0, excludedCount = 0, reachedCount = 0;
    for (let i = 0; i < width * height; i++) {
      if (tie[i]) tieCount++;
      if (reached[i]) reachedCount++;
      if (excluded[i]) excludedCount++;
      if (!reached[i] && !excluded[i]) unreachedCount++;
    }
    const seedsByLabel = {};
    for (const lab of result.labelsUsed) seedsByLabel[lab] = [];
    for (const s of seeds) seedsByLabel[s.label].push({ x: s.x, y: s.y });
    return {
      width, height,
      connectivity: result.connectivity,
      perLabel,
      counts: {
        reached: reachedCount,
        tie: tieCount,
        unreached: unreachedCount,
        excluded: excludedCount,
        total: width * height
      },
      seedsByLabel
    };
  }

  return {
    segment,
    buildStats,
    normalizeSeeds,
    constants: { ORTHO_STEP, DIAG_STEP, GRAY_BASE }
  };
});
