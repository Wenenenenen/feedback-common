// 等值线提取核心（无 DOM 依赖，可在 Node 下测试）。
// 严格遵循 samples 包 README 的约定：
//  - 像素即网格节点标量；阈值为半整数，节点为整数因而不存在等值点落在节点上
//  - 仅四角均有效的单元参与
//  - 四交点（鞍点）按 Q=(a-t)(c-t)-(b-t)(d-t) 选连接：
//      Q>0  -> 上-右、下-左
//      Q<=0 -> 上-左、右-下
//  - 相邻单元按网格边身份共享同一个交点（边 id），不做坐标近似去重
//  - 图边/掩膜处的线保持开放，不封口

// ---- 网格边身份 ----
// 水平边 H(r,c)：节点 (r,c)-(r,c+1)，r∈[0,H-1], c∈[0,W-2]
// 垂直边 V(r,c)：节点 (r,c)-(r+1,c)，r∈[0,H-2], c∈[0,W-1]
export function edgeCounts(width, height) {
  const horiz = height * (width - 1);
  const vert = (height - 1) * width;
  return { horiz, total: horiz + vert };
}
function hId(r, c, width) {
  return r * (width - 1) + c;
}
function vId(r, c, width, height, horiz) {
  return horiz + r * width + c;
}
// 单元四条边（上、右、下、左）的边 id
function cellEdges(r, c, width, height, horiz) {
  return [
    hId(r, c, width),           // 上
    vId(r, c + 1, width, height, horiz), // 右
    hId(r + 1, c, width),       // 下
    vId(r, c, width, height, horiz),     // 左
  ];
}

// 单元四角：a 左上、b 右上、c 右下、d 左下
function cornerValues(values, width, r, c) {
  return {
    a: values[r * width + c],
    b: values[r * width + c + 1],
    c: values[(r + 1) * width + c + 1],
    d: values[(r + 1) * width + c],
  };
}

export function validateLevels(input) {
  const out = [];
  const seen = new Set();
  const raw = Array.isArray(input) ? input : String(input).split(/[\s,;]+/).filter(Boolean);
  for (const token of raw) {
    const n = Number(token);
    if (!Number.isFinite(n)) throw new Error(`阈值无法解析：${token}`);
    if (Math.abs(n - Math.round(n - 0.5) - 0.5) > 1e-9) {
      throw new Error(`阈值必须是半整数 n+0.5：${token}`);
    }
    const v = Math.round(n - 0.5) + 0.5;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  if (out.length > 32) throw new Error("阈值最多 32 个");
  return out.sort((x, y) => x - y);
}

// 边上线性插值，返回边起点到终点方向上的分数
function edgeFraction(v1, v2, t) {
  return (t - v1) / (v2 - v1);
}

function edgePoint(edge, frac, width, horiz) {
  if (edge < horiz) {
    const r = Math.floor(edge / (width - 1));
    const c = edge - r * (width - 1);
    return { x: c + frac, y: r };
  }
  const local = edge - horiz;
  const r = Math.floor(local / width);
  const c = local - r * width;
  return { x: c, y: r + frac };
}

// 单个阈值的提取。全部使用预分配类型化数组，避免百万级对象/Map 的开销。
function buildLevel(width, height, values, validCell, t, levelIndex) {
  const { horiz, total } = edgeCounts(width, height);
  const cols = width - 1;
  const rows = height - 1;
  const cellCount = cols * rows;
  const N = width * height;
  const sign = new Uint8Array(N); // 1 = 节点值 > 阈值
  for (let i = 0; i < N; i++) sign[i] = values[i] > t ? 1 : 0;

  const frac = new Float64Array(total).fill(NaN);
  // 段以邻接链表挂在边上：head[e] 为首个半边索引，半边 2k/2k+1 属于段 k
  const head = new Int32Array(total).fill(-1);
  const degree = new Int32Array(total);
  // 段数上界：每单元至多 2 段
  const maxSegs = cellCount * 2;
  const segEdge = new Int32Array(maxSegs * 2);
  const nextHalf = new Int32Array(maxSegs * 2).fill(-1);
  // 单元 -> 段（紧凑 CSR：cellHead 为该单元在 cellSegList 中的起点，-1 表示无段）
  const cellHead = new Int32Array(cellCount).fill(-1);
  const cellCount2 = new Int32Array(cellCount); // 每单元段数（0..2）
  const cellSegList = new Int32Array(maxSegs);
  let segCount = 0;

  const ensureFraction = (edge) => {
    if (!Number.isNaN(frac[edge])) return;
    let r, c, v1, v2;
    if (edge < horiz) {
      r = (edge / cols) | 0;
      c = edge - r * cols;
      v1 = values[r * width + c];
      v2 = values[r * width + c + 1];
    } else {
      const local = edge - horiz;
      r = (local / width) | 0;
      c = local - r * width;
      v1 = values[r * width + c];
      v2 = values[(r + 1) * width + c];
    }
    frac[edge] = edgeFraction(v1, v2, t);
  };

  const addSegment = (e1, e2, cellKey) => {
    const k = segCount++;
    const h1 = 2 * k, h2 = 2 * k + 1;
    segEdge[h1] = e1;
    segEdge[h2] = e2;
    // 半边链表挂到对应边
    nextHalf[h1] = head[e1];
    head[e1] = h1;
    nextHalf[h2] = head[e2];
    head[e2] = h2;
    degree[e1]++;
    degree[e2]++;
    // 记录单元归属（每单元至多 2 段）：cellHead 指向首段，第二段存在首段+1
    cellSegList[k] = cellKey;
    if (cellCount2[cellKey] === 0) cellHead[cellKey] = k;
    cellCount2[cellKey]++;
  };

  for (let r = 0; r < rows; r++) {
    const rowBase = r * width;
    const nextRowBase = (r + 1) * width;
    for (let c = 0; c < cols; c++) {
      const cellKey = r * cols + c;
      if (!validCell[cellKey]) continue;
      const i0 = rowBase + c;
      const a = values[i0];
      const b = values[i0 + 1];
      const d = values[nextRowBase + c];
      const cv = values[nextRowBase + c + 1];
      const sa = sign[i0];
      const sb = sign[i0 + 1];
      const sd = sign[nextRowBase + c];
      const sc = sign[nextRowBase + c + 1];
      if ((sa & sb & sc & sd) === 1 || (sa | sb | sc | sd) === 0) continue;

      // 四条边 id：上、右、下、左
      const eTop = r * cols + c;
      const eLeft = horiz + r * width + c;
      const eRight = horiz + r * width + c + 1;
      const eBottom = (r + 1) * cols + c;
      const edges = [eTop, eRight, eBottom, eLeft];
      const crossBits = (sa !== sb) | ((sb !== sc) << 1) | ((sc !== sd) << 2) | ((sd !== sa) << 3);

      if (crossBits === 15) {
        // 鞍点（四交点）：Q 决定连接方式
        const Q = (a - t) * (cv - t) - (b - t) * (d - t);
        if (Q > 0) {
          ensureFraction(eTop); ensureFraction(eRight);
          ensureFraction(eBottom); ensureFraction(eLeft);
          addSegment(eTop, eRight, cellKey);
          addSegment(eBottom, eLeft, cellKey);
        } else {
          ensureFraction(eTop); ensureFraction(eLeft);
          ensureFraction(eRight); ensureFraction(eBottom);
          addSegment(eTop, eLeft, cellKey);
          addSegment(eRight, eBottom, cellKey);
        }
      } else {
        // 普通单元：恰有两个交点，直接相连
        // 由 crossBits 找出置位的两条边（无循环依赖，展开更快）
        let i = -1, j = -1;
        for (let k = 0; k < 4; k++) {
          if ((crossBits >> k) & 1) { if (i === -1) i = k; else j = k; }
        }
        ensureFraction(edges[i]);
        ensureFraction(edges[j]);
        addSegment(edges[i], edges[j], cellKey);
      }
    }
  }

  // ---- 段追踪为折线 ----
  const segVisited = new Uint8Array(segCount);
  const polylines = [];

  // 把每条边上的半边链表转成直接配对：mate[half] = 同一条边上的另一个半边。
  // 内部边度数恒为 2（各属一个相邻单元），图边/掩膜边度数为 1，无配对。
  const halfTotal = segCount * 2;
  const mate = new Int32Array(halfTotal).fill(-1);
  for (let e = 0; e < total; e++) {
    if (degree[e] !== 2) continue;
    const h1 = head[e];
    const h2 = nextHalf[h1];
    mate[h1] = h2;
    mate[h2] = h1;
  }

  const otherHalf = (half) => (half & 1) === 0 ? half + 1 : half - 1;

  // 从某半边出发，沿段图行走；返回按顺序的边 id
  const walkFrom = (startHalf) => {
    const edgeSeq = [];
    let half = startHalf;
    const startEdge = segEdge[half];
    edgeSeq.push(startEdge);
    while (true) {
      const seg = half >> 1;
      segVisited[seg] = 1;
      const oh = otherHalf(half);
      const nextEdge = segEdge[oh];
      edgeSeq.push(nextEdge);
      if (degree[nextEdge] === 1) break; // 开放线终点
      const across = mate[oh];          // 同边上另一单元的半边，O(1)
      if (across === -1 || across === startHalf) break; // 闭环回到起点
      half = across;
    }
    return edgeSeq;
  };

  // 开放线：从度为 1 的边出发
  for (let e = 0; e < total; e++) {
    if (degree[e] !== 1) continue;
    const h = head[e];
    if (segVisited[h >> 1]) continue;
    polylines.push({ open: true, edgeIds: walkFrom(h) });
  }
  // 闭环：剩余未访问的段构成环
  for (let k = 0; k < segCount; k++) {
    if (segVisited[k]) continue;
    const seq = walkFrom(2 * k);
    if (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq.pop();
    polylines.push({ open: false, edgeIds: seq });
  }

  return {
    level: t,
    levelIndex,
    frac,
    segEdge: segEdge.subarray(0, segCount * 2),
    cellHead,
    cellCount: cellCount2,
    cellSegList: cellSegList.subarray(0, segCount),
    sign,
    polylines,
    width,
    height,
    horiz,
  };
}

export function buildTopology({ width, height, values, mask, levels }) {
  if (width < 2 || height < 2 || width > 1024 || height > 1024) {
    throw new Error("网格节点数每边须在 2..1024");
  }
  if (values.length !== width * height) throw new Error("标量数组长度与尺寸不符");
  const cols = width - 1;
  const rows = height - 1;
  const validCell = new Uint8Array(cols * rows).fill(1);
  if (mask) {
    if (mask.length !== width * height) throw new Error("掩膜长度与图像尺寸不符");
    validCell.fill(0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        validCell[r * cols + c] =
          mask[r * width + c] && mask[r * width + c + 1] &&
          mask[(r + 1) * width + c] && mask[(r + 1) * width + c + 1] ? 1 : 0;
      }
    }
  }
  const levelData = levels.map((t, i) =>
    buildLevel(width, height, values, validCell, t, i));
  const topo = { width, height, values, mask: mask || null, validCell, levels, levelData };
  assignParents(topo);
  return topo;
}

// 同阈值嵌套闭环：父环 = 严格包含且节点空间面积最小的闭环。
// 扫描线算法（近线性）：
//  - 每个环取最顶整数行 rowTop=floor(minY)，探针放在该行采样线 y=rowTop+0.5 上；
//  - 每条环边按其纵向跨越的整数行入桶；
//  - 逐行在采样线 y=row+0.5 求所有跨边交点并按 x 排序，交点成对表示进入/离开环；
//  - 探针 x 落入的最内层交点对所属环即直接父环。
function assignParents(topo) {
  for (const ld of topo.levelData) {
    // 稳定 id：按折线在数组中的出现顺序统一编号，开放/闭环各自计数
    let openCounter = 0;
    let closedCounter = 0;
    for (const pl of ld.polylines) {
      pl.id = pl.open
        ? `L${ld.levelIndex}-O${openCounter++}`
        : `L${ld.levelIndex}-R${closedCounter++}`;
      pl.parentId = null;
    }
    const closed = ld.polylines.filter((p) => !p.open);
    if (closed.length === 0) continue;

    // row -> 跨边 {p1,p2,ringIdx}；row -> 本行探针环索引
    const edgeBuckets = new Map();
    const probesByRow = new Map();
    const ringMeta = new Array(closed.length);

    closed.forEach((pl, idx) => {
      const pts = pl.edgeIds.map((e) => edgePoint(e, ld.frac[e], ld.width, ld.horiz));
      let s = 0;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        s += p.x * q.y - q.x * p.y;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const rowTop = Math.floor(minY);
      const ySample = rowTop + 0.5;
      // 探针 x：采样线上该环最靠左的跨边交点
      let probeX = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        if ((p1.y > ySample) !== (p2.y > ySample)) {
          const x = p1.x + (p2.x - p1.x) * (ySample - p1.y) / (p2.y - p1.y);
          if (x < probeX) probeX = x;
        }
        // 边按跨越整数行入桶（上端点所在行排除，避免共享顶点双计）
        const lo = Math.min(p1.y, p2.y);
        const hi = Math.max(p1.y, p2.y);
        const r0 = Math.floor(lo);
        const r1 = Math.floor(hi - 1e-12);
        for (let r = r0; r <= r1; r++) {
          let bucket = edgeBuckets.get(r);
          if (!bucket) { bucket = []; edgeBuckets.set(r, bucket); }
          bucket.push({ p1, p2, ringIdx: idx });
        }
      }
      ringMeta[idx] = { pl, rowTop, probeX: probeX + 1e-9, parent: null };
      let arr = probesByRow.get(rowTop);
      if (!arr) { arr = []; probesByRow.set(rowTop, arr); }
      arr.push(idx);
    });

    const rows = [...probesByRow.keys()].sort((a, b) => a - b);
    for (const row of rows) {
      const ySample = row + 0.5;
      const edges = edgeBuckets.get(row) || [];
      const crossings = [];
      for (const { p1, p2, ringIdx } of edges) {
        if ((p1.y > ySample) === (p2.y > ySample)) continue;
        const x = p1.x + (p2.x - p1.x) * (ySample - p1.y) / (p2.y - p1.y);
        crossings.push({ x, ringIdx });
      }
      crossings.sort((a, b) => a.x - b.x);
      const cn = crossings.length;
      for (const idx of probesByRow.get(row)) {
        const meta = ringMeta[idx];
        // 探针左侧交点数（二分）
        let lo = 0, hi = cn;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (crossings[mid].x < meta.probeX) lo = mid + 1; else hi = mid;
        }
        const pos = lo;
        // 交点成对：(0,1) 最外层，(2,3) 次外层……探针在第 pos 个交点右侧，
        // 包含它的最内层区间对为 (pos-2, pos-1)
        meta.parent = (pos >= 2 && pos % 2 === 0)
          ? ringMeta[crossings[pos - 1].ringIdx].pl.id
          : null;
      }
    }
    for (const meta of ringMeta) meta.pl.parentId = meta.parent;
  }
}

// ---- 物理几何：与原点/间距相关，改间距后只重算这一步 ----
export function buildGeometry(topo, origin, spacing) {
  const [ox, oy] = origin;
  const [sx, sy] = spacing;
  if (!(sx > 0) || !(sy > 0)) throw new Error("横纵间距必须大于 0");
  const toPhysical = (edge, fracVal) => {
    const p = edgePoint(edge, fracVal, topo.width, topo.levelData[0].horiz);
    return [ox + sx * p.x, oy + sy * p.y];
  };
  return {
    origin: [ox, oy],
    spacing: [sx, sy],
    levels: topo.levelData.map((ld) => ({
      level: ld.level,
      lines: ld.polylines.map((pl) => {
        const points = pl.edgeIds.map((e) => toPhysical(e, ld.frac[e]));
        let length = 0;
        for (let i = 1; i < points.length; i++) {
          length += Math.hypot(points[i][0] - points[i - 1][0],
                               points[i][1] - points[i - 1][1]);
        }
        let area = null;
        if (!pl.open) {
          let s = 0;
          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const q = points[(i + 1) % points.length];
            s += p[0] * q[1] - q[0] * p[1];
          }
          area = Math.abs(s) / 2;
          // 闭合环首段长度补上（点列未重复首点）
          length += Math.hypot(points[0][0] - points[points.length - 1][0],
                               points[0][1] - points[points.length - 1][1]);
        }
        return {
          id: pl.id,
          open: pl.open,
          parentId: pl.parentId,
          pointCount: points.length,
          points,
          length,
          area,
        };
      }),
    })),
  };
}

// ---- 单元点击查询：角点、交点、连接选择 ----
export function cellInfo(topo, levelIndex, r, c) {
  const ld = topo.levelData[levelIndex];
  const width = topo.width, height = topo.height;
  const cols = width - 1;
  if (r < 0 || c < 0 || r >= height - 1 || c >= cols) return null;
  const t = ld.level;
  const vals = cornerValues(topo.values, width, r, c);
  const signs = {
    a: ld.sign[r * width + c],
    b: ld.sign[r * width + c + 1],
    c: ld.sign[(r + 1) * width + c + 1],
    d: ld.sign[(r + 1) * width + c],
  };
  const edges = cellEdges(r, c, width, height, ld.horiz);
  const edgeNames = ["top", "right", "bottom", "left"];
  const edgeNameZh = { top: "上", right: "右", bottom: "下", left: "左" };
  const intersections = [];
  for (let k = 0; k < 4; k++) {
    const e = edges[k];
    if (!Number.isNaN(ld.frac[e])) {
      const np = edgePoint(e, ld.frac[e], width, ld.horiz);
      intersections.push({
        edge: edgeNames[k],
        edgeZh: edgeNameZh[edgeNames[k]],
        nodePoint: [np.x, np.y],
        fraction: ld.frac[e],
      });
    }
  }
  const valid = !!topo.validCell[r * cols + c];
  const bits = signs.a | (signs.b << 1) | (signs.c << 2) | (signs.d << 3);
  const isSaddle = intersections.length === 4;
  const Q = isSaddle
    ? (vals.a - t) * (vals.c - t) - (vals.b - t) * (vals.d - t)
    : null;
  const key = r * cols + c;
  const nSeg = ld.cellCount[key];
  const segIds = [];
  if (nSeg > 0) {
    const start = ld.cellHead[key];
    for (let k = 0; k < nSeg; k++) segIds.push(start + k);
  }
  const chosenPairs = segIds.map((k) => {
    const e1 = ld.segEdge[2 * k];
    const e2 = ld.segEdge[2 * k + 1];
    const nameOf = (e) => edgeNameZh[edgeNames[edges.indexOf(e)]];
    return [nameOf(e1), nameOf(e2)];
  });
  return {
    cell: [r, c],
    valid,
    level: t,
    corners: {
      a: { node: [r, c], value: vals.a, above: !!signs.a },
      b: { node: [r, c + 1], value: vals.b, above: !!signs.b },
      c: { node: [r + 1, c + 1], value: vals.c, above: !!signs.c },
      d: { node: [r + 1, c], value: vals.d, above: !!signs.d },
    },
    caseBits: bits,
    isSaddle,
    Q,
    intersections,
    chosenPairs,
    alternativePairs: isSaddle
      ? (Q > 0 ? [["上", "左"], ["右", "下"]] : [["上", "右"], ["下", "左"]])
      : null,
  };
}
