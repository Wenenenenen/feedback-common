// 二值细管图骨架测量核心算法模块。
// 按 samples 包内《约定.json》实现：
//  - 二值化：gray >= threshold 为前景，反色在阈值后执行
//  - 图像外补一像素背景进行距离计算与细化，完成后裁回
//  - 精确欧氏距离变换（Felzenszwalb–Huttenlocher 两遍一维变换，精确解）
//  - Zhang–Suen 细化（P2 上、P3 右上顺时针至 P9 左上，双子步同步删除）
//  - 骨架图提取：正交相连；对角仅在两正交桥像素均非骨架时相连
// 不依赖任何现成细化 / 距离变换 / 骨架转图接口。

/** 二值化：gray >= threshold 为前景；invert 在阈值之后执行。返回 Uint8Array(0/1)。 */
export function binarize(gray, width, height, threshold, invert) {
  const n = width * height;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let fg = gray[i] >= threshold ? 1 : 0;
    if (invert) fg = fg ? 0 : 1;
    bin[i] = fg;
  }
  return bin;
}

/** 外补一像素背景。返回 {data, w, h}，原图 (x,y) 位于返回值的 (x+1, y+1)。 */
export function padBackground(bin, width, height) {
  const w = width + 2, h = height + 2;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < height; y++) {
    data.set(bin.subarray(y * width, (y + 1) * width), (y + 1) * w + 1);
  }
  return { data, w, h };
}

/**
 * 精确欧氏距离变换（平方距离），Felzenszwalb–Huttenlocher 算法。
 * grid: Uint8Array，0=背景。返回 Float64Array，每像素到最近背景像素中心的平方距离。
 */
export function exactDistanceTransformSquared(grid, w, h) {
  const INF = 1e20;
  // 沿列的一维变换
  const dt1d = (f) => {
    const n = f.length;
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    return d;
  };

  const tmp = new Float64Array(w * h);
  const col = new Float64Array(h);
  // 第一遍：对每列做一维平方距离变换（源为背景点 0，前景点 INF）
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = grid[y * w + x] === 0 ? 0 : INF;
    const d = dt1d(col);
    for (let y = 0; y < h; y++) tmp[y * w + x] = d[y];
  }
  // 第二遍：对每行做一维变换
  const out = new Float64Array(w * h);
  const row = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = tmp[y * w + x];
    const d = dt1d(row);
    out.set(d, y * w);
  }
  return out;
}

/**
 * Zhang–Suen 细化。
 * 邻域编号：P2 上、P3 右上、P4 右、P5 右下、P6 下、P7 左下、P8 左、P9 左上。
 * B = 8 邻前景数；A = P2..P9,P2 环上 0->1 跳变数。
 * 两子步均要求 2<=B<=6 且 A==1；
 * 子步1：P2*P4*P6==0 且 P4*P6*P8==0；子步2：P2*P4*P8==0 且 P2*P6*P8==0。
 * 各子步同步删除，迭代至无变化。原地修改 grid（0/1）。
 */
export function zhangSuenThinning(grid, w, h) {
  const idx = (x, y) => y * w + x;
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (grid[idx(x, y)] !== 1) continue;
          const p2 = grid[idx(x, y - 1)], p3 = grid[idx(x + 1, y - 1)],
            p4 = grid[idx(x + 1, y)], p5 = grid[idx(x + 1, y + 1)],
            p6 = grid[idx(x, y + 1)], p7 = grid[idx(x - 1, y + 1)],
            p8 = grid[idx(x - 1, y)], p9 = grid[idx(x - 1, y - 1)];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          del.push(idx(x, y));
        }
      }
      if (del.length) {
        for (const i of del) grid[i] = 0;
        changed = true;
      }
    }
  }
  return grid;
}

/**
 * 骨架图提取。
 * skel: Uint8Array(0/1)，w×h（已裁回原图尺寸）。
 * dist: Float64Array 同尺寸精确欧氏距离（像素单位）。
 * spacing: 像素物理间距。
 * 返回 { nodes, edges, widthMap(Float32Array), deg, adjacency }。
 * 坐标均为 [x, y] 像素中心坐标（列, 行）。
 */
export function extractGraph(skel, w, h, dist, spacing) {
  const idx = (x, y) => y * w + x;
  const inBounds = (x, y) => x >= 0 && x < w && y >= 0 && y < h;

  // 邻接：正交相连；对角仅在两侧正交桥像素都不是骨架时相连
  const ORTHO = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const DIAG = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
  const neighborsOf = (x, y) => {
    const res = [];
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx, ny = y + dy;
      if (inBounds(nx, ny) && skel[idx(nx, ny)] === 1) res.push([nx, ny]);
    }
    for (const [dx, dy] of DIAG) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny) || skel[idx(nx, ny)] !== 1) continue;
      if (skel[idx(x + dx, y)] === 0 && skel[idx(x, y + dy)] === 0) res.push([nx, ny]);
    }
    return res;
  };

  // 度数
  const deg = new Uint8Array(w * h);
  const adjCache = new Map(); // idx -> [[x,y],...]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skel[idx(x, y)] !== 1) continue;
      const nb = neighborsOf(x, y);
      adjCache.set(idx(x, y), nb);
      deg[idx(x, y)] = nb.length;
    }
  }
  const adjOf = (x, y) => adjCache.get(idx(x, y)) || [];

  // 节点聚类：度>=3 的像素按邻接聚成一个分叉节点；度1 各为端点；度0 为孤立节点
  const nodeOfPixel = new Int32Array(w * h).fill(-1);
  const nodes = [];
  const key = (x, y) => y * w + x;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (skel[i] !== 1 || deg[i] < 3 || nodeOfPixel[i] !== -1) continue;
      // BFS 聚类
      const members = [];
      const stack = [[x, y]];
      nodeOfPixel[i] = nodes.length;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        members.push([cx, cy]);
        for (const [nx, ny] of adjOf(cx, cy)) {
          const ni = idx(nx, ny);
          if (deg[ni] >= 3 && nodeOfPixel[ni] === -1) {
            nodeOfPixel[ni] = nodes.length;
            stack.push([nx, ny]);
          }
        }
      }
      nodes.push({ type: 'branch', pixels: members });
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (skel[i] !== 1 || nodeOfPixel[i] !== -1) continue;
      if (deg[i] === 1) {
        nodeOfPixel[i] = nodes.length;
        nodes.push({ type: 'endpoint', pixels: [[x, y]] });
      } else if (deg[i] === 0) {
        nodeOfPixel[i] = nodes.length;
        nodes.push({ type: 'isolated', pixels: [[x, y]] });
      }
    }
  }

  // 纯闭环：连通分量全为度2 -> 人工节点 + 一条自环
  // 先标记已被节点覆盖的像素，再对剩余度2像素找全度2连通分量
  const visitedRing = new Uint8Array(w * h);
  const rings = []; // { nodePixel:[x,y], polyline }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (skel[i] !== 1 || deg[i] !== 2 || visitedRing[i]) continue;
      // 收集该度2像素所在连通分量（沿邻接，分量内可能含节点像素则不是纯环）
      const comp = [];
      const stack = [[x, y]];
      visitedRing[i] = 1;
      let allDeg2 = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        comp.push([cx, cy]);
        for (const [nx, ny] of adjOf(cx, cy)) {
          const ni = idx(nx, ny);
          if (deg[ni] !== 2) { allDeg2 = false; continue; }
          if (!visitedRing[ni]) { visitedRing[ni] = 1; stack.push([nx, ny]); }
        }
      }
      if (!allDeg2) continue; // 普通边内链，稍后由节点出发的遍历处理
      // 纯环：最小 (y,x) 像素为人工节点，沿邻居 (y,x) 较小方向遍历一圈
      comp.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
      const p0 = comp[0];
      const nb = adjOf(p0[0], p0[1]).slice().sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
      const first = nb[0];
      const polyline = [p0, first];
      let prev = p0, cur = first;
      while (!(cur[0] === p0[0] && cur[1] === p0[1])) {
        const nxts = adjOf(cur[0], cur[1]).filter(([nx, ny]) => !(nx === prev[0] && ny === prev[1]));
        const nxt = nxts[0];
        polyline.push(nxt);
        prev = cur; cur = nxt;
      }
      // polyline 末尾已回到 p0（重复起点闭合）
      rings.push({ nodePixel: p0, polyline });
    }
  }

  // 边提取：从各节点成员像素出发，沿度2链走到另一节点
  const usedPair = new Set(); // "i|j" 无序对（i<j）
  const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const edges = []; // { nodeA, nodeB, polyline:[[x,y]...] }

  for (let ni = 0; ni < nodes.length; ni++) {
    for (const [px, py] of nodes[ni].pixels) {
      for (const [qx, qy] of adjOf(px, py)) {
        const qi = idx(qx, qy);
        if (nodeOfPixel[qi] === ni) continue; // 分叉节点内部邻接不计边
        const pk = pairKey(idx(px, py), qi);
        if (usedPair.has(pk)) continue;
        usedPair.add(pk);
        const polyline = [[px, py], [qx, qy]];
        let prev = [px, py], cur = [qx, qy];
        let endNode = nodeOfPixel[qi];
        while (endNode === -1) {
          // cur 是度2链像素，走向另一端的唯一邻居
          const nxts = adjOf(cur[0], cur[1]).filter(([ax, ay]) => !(ax === prev[0] && ay === prev[1]));
          const nxt = nxts[0];
          usedPair.add(pairKey(idx(cur[0], cur[1]), idx(nxt[0], nxt[1])));
          polyline.push(nxt);
          prev = cur; cur = nxt;
          endNode = nodeOfPixel[idx(cur[0], cur[1])];
        }
        edges.push({ nodeA: ni, nodeB: endNode, polyline });
      }
    }
  }

  // 纯环节点与自环边
  for (const ring of rings) {
    const ni = nodes.length;
    nodeOfPixel[idx(ring.nodePixel[0], ring.nodePixel[1])] = ni;
    nodes.push({ type: 'ring', pixels: [ring.nodePixel] });
    edges.push({ nodeA: ni, nodeB: ni, polyline: ring.polyline });
  }

  // 节点排序：按成员最小 (y,x) 编号
  const order = nodes.map((_, i) => i).sort((a, b) => {
    const ma = Math.min(...nodes[a].pixels.map(([x, y]) => y * w + x));
    const mb = Math.min(...nodes[b].pixels.map(([x, y]) => y * w + x));
    return ma - mb;
  });
  const remap = new Int32Array(nodes.length);
  order.forEach((oldId, newId) => { remap[oldId] = newId; });
  const sortedNodes = order.map((oldId) => nodes[oldId]);
  for (const e of edges) { e.nodeA = remap[e.nodeA]; e.nodeB = remap[e.nodeB]; }

  // 非自环边统一方向：从小编号节点指向大编号节点
  for (const e of edges) {
    if (e.nodeA > e.nodeB) {
      const t = e.nodeA; e.nodeA = e.nodeB; e.nodeB = t;
      e.polyline.reverse();
    }
  }

  // 边排序：按端点编号及折线字典序
  const polyCmp = (a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
      if (a[i][1] !== b[i][1]) return a[i][1] - b[i][1];
    }
    return a.length - b.length;
  };
  edges.sort((a, b) =>
    (a.nodeA - b.nodeA) || (a.nodeB - b.nodeB) || polyCmp(a.polyline, b.polyline));

  // 节点输出：位置为成员像素中心均值 [x,y]
  const outNodes = sortedNodes.map((nd, i) => {
    let sx = 0, sy = 0;
    for (const [x, y] of nd.pixels) { sx += x; sy += y; }
    return {
      id: i,
      type: nd.type,
      position: [sx / nd.pixels.length, sy / nd.pixels.length],
      pixels: nd.pixels.map(([x, y]) => [x, y]),
    };
  });

  // 宽度图：骨架像素宽度 = 2 * 距离 * 间距，其余为 0
  const widthMap = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (skel[i] === 1) widthMap[i] = 2 * dist[i] * spacing;
  }

  // 边输出：折线长度与宽度统计（闭环重复终点只计一次）
  const outEdges = edges.map((e, i) => {
    const pts = e.polyline;
    // 长度：折线相邻中心欧氏距离求和乘间距
    let len = 0;
    for (let k = 1; k < pts.length; k++) {
      len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
    len *= spacing;
    // 宽度统计：折线骨架像素等权；闭环重复终点只计一次
    let statPts = pts;
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) statPts = pts.slice(0, pts.length - 1);
    }
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (const [x, y] of statPts) {
      const wv = widthMap[idx(x, y)];
      sum += wv;
      if (wv < mn) mn = wv;
      if (wv > mx) mx = wv;
    }
    const npt = statPts.length;
    return {
      id: i,
      nodes: [e.nodeA, e.nodeB],
      polyline: pts.map(([x, y]) => [x, y]),
      length: len,
      pixel_count: npt,
      width: { mean: npt ? sum / npt : 0, min: npt ? mn : 0, max: npt ? mx : 0 },
    };
  });

  return { nodes: outNodes, edges: outEdges, widthMap, deg };
}

/**
 * 完整流水线。
 * gray: Uint8Array 灰度；返回 { width, height, binary, skeleton, distSq, widthMap, nodes, edges }
 * binary/skeleton/widthMap 均为原图尺寸（补边已裁回）。
 */
export function runPipeline(gray, width, height, { threshold = 128, invert = false, spacing = 1 } = {}) {
  const bin = binarize(gray, width, height, threshold, invert);
  const padded = padBackground(bin, width, height);

  // 精确欧氏距离（在补边图上计算，裁回原图）
  const distSqPad = exactDistanceTransformSquared(padded.data, padded.w, padded.h);

  // Zhang–Suen 细化（在补边图上迭代）
  const skelPad = zhangSuenThinning(padded.data.slice(), padded.w, padded.h);

  // 裁回
  const n = width * height;
  const skel = new Uint8Array(n);
  const dist = new Float64Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      skel[y * width + x] = skelPad[(y + 1) * padded.w + (x + 1)];
      dist[y * width + x] = Math.sqrt(distSqPad[(y + 1) * padded.w + (x + 1)]);
    }
  }

  const graph = extractGraph(skel, width, height, dist, spacing);
  return {
    width, height,
    binary: bin,
    skeleton: skel,
    distance: dist,
    widthMap: graph.widthMap,
    nodes: graph.nodes,
    edges: graph.edges,
  };
}
