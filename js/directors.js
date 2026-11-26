// 材料纤维方向图定向 —— 纯算法核心（浏览器与 Node 共用，无 DOM 依赖）。
//
// 模型
// ----
// 每格一个轴向整数向量 d_i，只能选择 s_i∈{0,1}（0 保持、1 反转），
// 输出箭头 o_i = (-1)^{s_i} d_i。
// 四邻边 e=(i,j) 的原点积 p_e=d_i·d_j：
//   p_e>0 偏好“同翻”（s_i⊕s_j=0），p_e<0 偏好“异翻”（s_i⊕s_j=1）。
// 违反指示 r_e = s_i⊕s_j⊕t_e，其中 t_e=1[p_e<0]；
// 违反代价 w_e=|p_e|·min(conf_i,conf_j)。p_e=0 或置信度 0 => w_e=0，
// 该边不连接；空格(null)也不参与连接。
//
// 全局最优
// --------
// 最小化 Σ w_e r_e 是带符号 Ising 基态问题。格网四邻图是平面图，
// 其违反边集合 R 是平面对偶图上的 T-join（T=奇约束面/缺陷面）。
// 最小权 T-join 有两种精确求法：
//   1) T 上以对偶最短路为距离的最小权完美匹配（Edmonds 花算法，默认，
//      见 vendor/blossom.js），适合缺陷面 ≤ 数百的典型纤维场；
//   2) 通用 MILP 库（HiGHS/WASM，见 solver-highs.js）直接解奇偶 ILP，
//      适合高缺陷密度的大网格。
// 两者给出的都是全局最小值；多个最优解时任取一个。
// 锚点只消除每个连通分量的整体翻转自由度，不改变最小代价。

import blossom from './vendor/blossom.js';

export const MAX_GRID = 96;
export const FORMAT_VERSION = 'fiber-director-result/v1';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function cellId(x, y, width) {
  return y * width + x;
}
export function idXY(id, width) {
  return { x: id % width, y: Math.floor(id / width) };
}

export function heapDijkstra(adj, source) {
  const n = adj.length;
  const dist = new Float64Array(n).fill(Infinity);
  const parentV = new Int32Array(n).fill(-1);
  const parentE = new Int32Array(n).fill(-1);
  dist[source] = 0;
  const heap = [[0, source]];
  const push = (d, v) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 1) {
      const p = i >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[1];
    const last = heap.pop();
    if (heap.length > 1) {
      heap[1] = last;
      let i = 1;
      for (;;) {
        const l = i * 2, r = l + 1;
        let best = i;
        if (l < heap.length && heap[l][0] < heap[best][0]) best = l;
        if (r < heap.length && heap[r][0] < heap[best][0]) best = r;
        if (best === i) break;
        [heap[best], heap[i]] = [heap[i], heap[best]];
        i = best;
      }
    }
    return top;
  };
  heap.unshift(null);
  while (heap.length > 1) {
    const [d, u] = pop();
    if (d !== dist[u]) continue;
    for (const edge of adj[u]) {
      const nd = d + edge.w;
      if (nd < dist[edge.to]) {
        dist[edge.to] = nd;
        parentV[edge.to] = u;
        parentE[edge.to] = edge.pe;
        push(nd, edge.to);
      }
    }
  }
  return { dist, parentV, parentE };
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

export function parseDirectorJSON(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { doc: null, errors: [{ level: 'error', path: '$', message: `JSON 解析失败：${err.message}` }], warnings: [] };
  }
  return normalizeDocument(raw);
}

export function normalizeDocument(raw) {
  const errors = [];
  const warnings = [];
  const fail = (path, message) => errors.push({ level: 'error', path, message });
  const warn = (path, message) => warnings.push({ level: 'warning', path, message });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('$', '顶层必须是对象，包含 width、height、rows');
    return { doc: null, errors, warnings };
  }
  const { width, height, rows } = raw;
  if (!Number.isInteger(width) || width < 1 || width > MAX_GRID)
    fail('width', `width 必须是 1..${MAX_GRID} 的整数，收到 ${JSON.stringify(width)}`);
  if (!Number.isInteger(height) || height < 1 || height > MAX_GRID)
    fail('height', `height 必须是 1..${MAX_GRID} 的整数，收到 ${JSON.stringify(height)}`);
  if (errors.length) return { doc: null, errors, warnings };

  if (!Array.isArray(rows)) {
    fail('rows', 'rows 必须是数组（从上到下，每行一格数组）');
    return { doc: null, errors, warnings };
  }
  if (rows.length !== height)
    fail('rows', `rows 行数 ${rows.length} 与 height=${height} 不一致`);

  const cells = new Array(width * height).fill(null);
  const h = Math.min(height, rows.length);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (!Array.isArray(row)) {
      fail(`rows[${y}]`, '每一行必须是数组');
      continue;
    }
    if (row.length !== width)
      fail(`rows[${y}]`, `第 ${y} 行长度 ${row.length} 与 width=${width} 不一致`);
    const w = Math.min(width, row.length);
    for (let x = 0; x < w; x++) {
      const v = row[x];
      const path = `rows[${y}][${x}]`;
      if (v === null) continue;
      if (!Array.isArray(v) || v.length < 3) {
        fail(path, '非空格必须是 [dx, dy, 置信度] 三元组或 null');
        continue;
      }
      const [dx, dy, conf] = v;
      let bad = false;
      if (!Number.isInteger(dx) || dx < -127 || dx > 127) {
        fail(`${path}[0]`, `dx 必须是 -127..127 的整数，收到 ${JSON.stringify(dx)}`); bad = true;
      }
      if (!Number.isInteger(dy) || dy < -127 || dy > 127) {
        fail(`${path}[1]`, `dy 必须是 -127..127 的整数，收到 ${JSON.stringify(dy)}`); bad = true;
      }
      if (!Number.isInteger(conf) || conf < 0 || conf > 255) {
        fail(`${path}[2]`, `置信度必须是 0..255 的整数，收到 ${JSON.stringify(conf)}`); bad = true;
      }
      if (!bad && dx === 0 && dy === 0) {
        fail(path, '向量必须非零（轴向不能是 [0,0]）'); bad = true;
      }
      if (bad) continue;
      cells[cellId(x, y, width)] = { x, y, i: cellId(x, y, width), dx, dy, conf };
    }
  }

  const anchors = [];
  if (raw.anchors !== undefined) {
    if (!Array.isArray(raw.anchors)) {
      fail('anchors', 'anchors 必须是数组');
    } else {
      raw.anchors.forEach((a, idx) => {
        const path = `anchors[${idx}]`;
        if (!Array.isArray(a) || a.length < 3) {
          fail(path, '锚点必须是 [列, 行, 符号]');
          return;
        }
        const [x, y, sign] = a;
        const xOk = Number.isInteger(x) && x >= 0 && x < width;
        const yOk = Number.isInteger(y) && y >= 0 && y < height;
        if (!xOk) fail(`${path}[0]`, `锚点列 x 必须在 0..${width - 1}`);
        if (!yOk) fail(`${path}[1]`, `锚点行 y 必须在 0..${height - 1}`);
        if (sign !== 1 && sign !== -1)
          fail(`${path}[2]`, '锚点符号必须是 +1（保持）或 -1（翻转）');
        if (xOk && yOk && !cells[cellId(x, y, width)])
          fail(path, `锚点 (${x},${y}) 落在空格上`);
        if (xOk && yOk && cells[cellId(x, y, width)] && (sign === 1 || sign === -1))
          anchors.push({ x, y, sign, i: cellId(x, y, width), source: 'import' });
      });
    }
  }

  if (errors.length) return { doc: null, errors, warnings };
  const doc = {
    width, height, cells, anchors,
    note: typeof raw['说明'] === 'string' ? raw['说明'] : (typeof raw.note === 'string' ? raw.note : ''),
  };
  return { doc, errors, warnings };
}

// ---------------------------------------------------------------------------
// 建图
// ---------------------------------------------------------------------------

export function dotProduct(a, b) {
  return a.dx * b.dx + a.dy * b.dy;
}

// 描述任意一对相邻格为什么是/不是优化边
export function describeAdjacency(model, x1, y1, x2, y2) {
  const { width: W, height: H, cells } = model;
  const base = { x1, y1, x2, y2 };
  if (x1 < 0 || y1 < 0 || x2 < 0 || y1 >= H || y2 >= H || x1 >= W || x2 >= W)
    return { ...base, connected: false, reason: 'out-of-grid', message: '坐标越界' };
  if (Math.abs(x1 - x2) + Math.abs(y1 - y2) !== 1)
    return { ...base, connected: false, reason: 'not-4-neighbor', message: '不是四邻格（仅上下左右相连）' };
  const ca = cells[cellId(x1, y1, W)];
  const cb = cells[cellId(x2, y2, W)];
  if (!ca || !cb) return { ...base, connected: false, reason: 'space', message: '至少一端是空格（缺测孔），不连接' };
  const dot = dotProduct(ca, cb);
  const minConf = Math.min(ca.conf, cb.conf);
  const weight = Math.abs(dot) * minConf;
  const info = { ...base, dot, minConf, weight };
  if (dot === 0) return { ...info, connected: false, reason: 'zero-dot', message: '原点积为 0：无偏好且代价为 0，按零代价边不连接' };
  if (minConf === 0) return { ...info, connected: false, reason: 'zero-conf', message: '两端较小置信度为 0：代价为 0，不连接' };
  const edge = model.edges.find((ed) =>
    (ed.a === ca.i && ed.b === cb.i) || (ed.a === cb.i && ed.b === ca.i));
  return { ...info, connected: true, reason: 'edge', edge, message: '已连接的四邻边' };
}

export function buildModel(doc) {
  const W = doc.width, H = doc.height, N = W * H;
  const cells = doc.cells;
  const edges = [];
  const nodeEdges = Array.from({ length: N }, () => []);

  const addPair = (ia, ib) => {
    const a = cells[ia], b = cells[ib];
    if (!a || !b) return;
    const dot = dotProduct(a, b);
    const minConf = Math.min(a.conf, b.conf);
    const weight = Math.abs(dot) * minConf;
    if (weight <= 0) return;
    const t = dot < 0 ? 1 : 0;
    const id = edges.length;
    const edge = {
      id, a: ia, b: ib,
      ax: a.x, ay: a.y, bx: b.x, by: b.y,
      va: [a.dx, a.dy], vb: [b.dx, b.dy],
      ca: a.conf, cb: b.conf,
      dot, t,
      preference: t === 0 ? 'same-flip' : 'opposite-flip',
      preferenceText: t === 0 ? '点积为正 · 偏好同翻' : '点积为负 · 偏好异翻',
      weight,
    };
    edges.push(edge);
    nodeEdges[ia].push(id);
    nodeEdges[ib].push(id);
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!cells[cellId(x, y, W)]) continue;
      if (x + 1 < W) addPair(cellId(x, y, W), cellId(x + 1, y, W));
      if (y + 1 < H) addPair(cellId(x, y, W), cellId(x, y + 1, W));
    }
  }

  const compOfNode = new Int32Array(N).fill(-1);
  const components = [];
  for (let start = 0; start < N; start++) {
    if (!cells[start] || compOfNode[start] !== -1) continue;
    const cid = components.length;
    const nodes = [];
    const edgeIds = new Set();
    const stack = [start];
    compOfNode[start] = cid;
    while (stack.length) {
      const u = stack.pop();
      nodes.push(u);
      for (const eid of nodeEdges[u]) {
        edgeIds.add(eid);
        const e = edges[eid];
        const v = e.a === u ? e.b : e.a;
        if (compOfNode[v] === -1) { compOfNode[v] = cid; stack.push(v); }
      }
    }
    nodes.sort((ia, ib) => {
      const a = idXY(ia, W), b = idXY(ib, W);
      return a.y - b.y || a.x - b.x;
    });
    components.push({
      id: cid, key: `c${cid + 1}`,
      nodes, edgeIds: [...edgeIds],
      root: nodes[0], rootXY: idXY(nodes[0], W),
    });
  }
  components.sort((c1, c2) => c1.rootXY.y - c2.rootXY.y || c1.rootXY.x - c2.rootXY.x);
  components.forEach((c, idx) => {
    c.id = idx; c.key = `c${idx + 1}`;
    for (const n of c.nodes) compOfNode[n] = idx;
  });

  return {
    width: W, height: H, size: N,
    cells, activeIds: cells.filter(Boolean).map((c) => c.i),
    edges, nodeEdges, compOfNode, components,
    importedAnchors: doc.anchors || [],
    note: doc.note || '',
  };
}

// ---------------------------------------------------------------------------
// 平面嵌入与对偶
// ---------------------------------------------------------------------------

// 返回一个分量的面、偏好奇偶、缺陷面 T 与对偶邻接。
// dual[f] 条目 {to,w,pe}，pe 为原边全局 id；桥（对偶自环）不放入 dual。
export function buildPlanarDual(model, comp) {
  const W = model.width;
  const nodes = comp.nodes;
  const m = nodes.length;
  const loc = new Map();
  nodes.forEach((id, u) => loc.set(id, u));
  const pos = nodes.map((id) => idXY(id, W));
  const E = comp.edgeIds.map((eid) => model.edges[eid]);
  const en = E.length;

  if (en === 0) {
    return { F: 1, parity: [0], T: [], dual: [[]], faceArea2: [0], dualEdgeCount: 0, edgeFaces: [] };
  }

  const from = new Int32Array(2 * en);
  const to = new Int32Array(2 * en);
  const out = Array.from({ length: m }, () => []);
  for (let k = 0; k < en; k++) {
    const e = E[k];
    const u = loc.get(e.a), v = loc.get(e.b);
    from[2 * k] = u; to[2 * k] = v;
    from[2 * k + 1] = v; to[2 * k + 1] = u;
    out[u].push(2 * k);
    out[v].push(2 * k + 1);
  }
  const posInOut = new Int32Array(2 * en);
  for (let u = 0; u < m; u++) {
    out[u].sort((d1, d2) => {
      const p1 = pos[to[d1]], p2 = pos[to[d2]], p0 = pos[u];
      return Math.atan2(p1.y - p0.y, p1.x - p0.x) - Math.atan2(p2.y - p0.y, p2.x - p0.x);
    });
    out[u].forEach((d, idx) => { posInOut[d] = idx; });
  }
  const nextDart = new Int32Array(2 * en);
  for (let d = 0; d < 2 * en; d++) {
    const v = to[d];
    const rev = d ^ 1;
    const idx = posInOut[rev];
    const deg = out[v].length;
    nextDart[d] = out[v][(idx - 1 + deg) % deg];
  }

  const faceOfDart = new Int32Array(2 * en).fill(-1);
  const parity = [];
  const faceArea2 = [];
  for (let d0 = 0; d0 < 2 * en; d0++) {
    if (faceOfDart[d0] !== -1) continue;
    const fid = parity.length;
    parity.push(0);
    let area2 = 0;
    let d = d0;
    do {
      faceOfDart[d] = fid;
      const e = E[d >> 1];
      parity[fid] ^= e.t;
      const p = pos[from[d]], q = pos[to[d]];
      area2 += p.x * q.y - q.x * p.y;
      d = nextDart[d];
    } while (d !== d0);
    faceArea2.push(area2);
  }
  const F = parity.length;
  const dual = Array.from({ length: F }, () => []);
  const edgeFaces = E.map((e, k) => ({ pe: e.id, fA: faceOfDart[2 * k], fB: faceOfDart[2 * k + 1] }));
  let dualEdgeCount = 0;
  for (const ef of edgeFaces) {
    if (ef.fA === ef.fB) continue;
    const e = model.edges[ef.pe];
    dual[ef.fA].push({ to: ef.fB, w: e.weight, pe: ef.pe });
    dual[ef.fB].push({ to: ef.fA, w: e.weight, pe: ef.pe });
    dualEdgeCount++;
  }
  const T = [];
  for (let f = 0; f < F; f++) if (parity[f] === 1) T.push(f);
  return { F, parity, T, dual, faceArea2, dualEdgeCount, edgeFaces };
}

// 给定每分量的违反边集合，传播出全部翻向（root 不翻）
export function flipsFromViolations(model, violatedByComp) {
  const flips = new Uint8Array(model.size);
  model.components.forEach((comp, cid) => {
    const R = violatedByComp[cid] instanceof Set ? violatedByComp[cid] : new Set(violatedByComp[cid] || []);
    flips[comp.root] = 0;
    const seen = new Set([comp.root]);
    const queue = [comp.root];
    while (queue.length) {
      const u = queue.pop();
      for (const eid of model.nodeEdges[u]) {
        const e = model.edges[eid];
        const v = e.a === u ? e.b : e.a;
        if (seen.has(v)) continue;
        seen.add(v);
        const r = R.has(eid) ? 1 : 0;
        flips[v] = flips[u] ^ e.t ^ r;
        queue.push(v);
      }
    }
  });
  return flips;
}

// ---------------------------------------------------------------------------
// 精确求解引擎 1：平面对偶 + 度量完全图最小权完美匹配（Edmonds 花算法）
// ---------------------------------------------------------------------------

export function solveComponentMWPM(model, comp) {
  const pd = buildPlanarDual(model, comp);
  const { F, T, dual } = pd;
  const out = {
    faceCount: F, defectCount: T.length, dualEdges: pd.dualEdgeCount,
    matchingPairs: 0, violated: new Set(), cost: 0,
  };
  if (T.length === 0) return out;
  if (T.length % 2 !== 0) throw new Error('缺陷面数量为奇数，平面奇偶校验失败');

  const pairData = [];
  let maxD = 0;
  for (let a = 0; a < T.length; a++) {
    const { dist } = heapDijkstra(dual, T[a]);
    for (let b = a + 1; b < T.length; b++) {
      const d = dist[T[b]];
      if (!Number.isFinite(d)) throw new Error('对偶图不连通，无法完成缺陷配对');
      pairData.push({ a, b, d });
      if (d > maxD) maxD = d;
    }
  }
  const WBIG = maxD + 1;
  const blossomEdges = pairData.map((p) => [p.a, p.b, WBIG - p.d]);
  let mate = blossom(blossomEdges, false);
  if (!mate || mate.length !== T.length || mate.some((m, i) => m < 0 || mate[m] !== i))
    mate = blossom(blossomEdges, true);
  if (!mate || mate.length !== T.length || mate.some((m, i) => m < 0 || mate[m] !== i))
    throw new Error('完美匹配求解失败');

  const violated = new Set();
  let pairs = 0;
  for (let a = 0; a < T.length; a++) {
    const b = mate[a];
    if (b < 0 || b <= a) continue;
    pairs++;
    const { parentV, parentE } = heapDijkstra(dual, T[a]);
    let cur = T[b];
    while (cur !== T[a]) {
      const pe = parentE[cur];
      if (pe < 0) throw new Error('匹配路径还原失败');
      if (violated.has(pe)) violated.delete(pe);
      else violated.add(pe);
      cur = parentV[cur];
    }
  }
  let cost = 0;
  for (const eid of violated) cost += model.edges[eid].weight;
  out.matchingPairs = pairs;
  out.violated = violated;
  out.cost = cost;
  return out;
}

// 总求解：默认 MWPM；也可传入 engine='highs' 的异步结果或自定义 solver
export function solveModel(model, options = {}) {
  const violatedByComp = [];
  const compSolutions = [];
  let totalCost = 0;
  for (const comp of model.components) {
    const r = solveComponentMWPM(model, comp);
    violatedByComp.push(r.violated);
    totalCost += r.cost;
    compSolutions.push({
      component: comp.id, key: comp.key, root: comp.root,
      cost: r.cost, violated: [...r.violated].sort((a, b) => a - b),
      faceCount: r.faceCount, defectCount: r.defectCount, matchingPairs: r.matchingPairs,
    });
  }
  const flips = flipsFromViolations(model, violatedByComp);
  return { flips, totalCost, components: compSolutions, engine: 'planar-dual-mwpm' };
}

// 用外部给定的每分量违反边集合装配解（HiGHS 引擎用）
export function solutionFromViolations(model, violatedByComp, engine) {
  const compSolutions = [];
  let totalCost = 0;
  model.components.forEach((comp, cid) => {
    const set = violatedByComp[cid] instanceof Set ? violatedByComp[cid] : new Set(violatedByComp[cid] || []);
    let cost = 0;
    for (const eid of set) cost += model.edges[eid].weight;
    totalCost += cost;
    const pd = buildPlanarDual(model, comp);
    compSolutions.push({
      component: cid, key: comp.key, root: comp.root, cost,
      violated: [...set].sort((a, b) => a - b),
      faceCount: pd.F, defectCount: pd.T.length, matchingPairs: 0,
    });
  });
  return { flips: flipsFromViolations(model, violatedByComp), totalCost, components: compSolutions, engine };
}

// 估算 MWPM 规模，供 UI 选择引擎
export function estimateDefects(model) {
  let defects = 0, maxCompDefects = 0;
  for (const comp of model.components) {
    const pd = buildPlanarDual(model, comp);
    defects += pd.T.length;
    maxCompDefects = Math.max(maxCompDefects, pd.T.length);
  }
  return { defects, maxCompDefects };
}

// ---------------------------------------------------------------------------
// 暴力求解（测试 / 对拍）
// ---------------------------------------------------------------------------

export function bruteForceComponentCost(model, comp) {
  const m = comp.nodes.length;
  if (m > 22) throw new Error('暴力枚举最多支持 22 格的分量');
  let best = Infinity, bestMask = 0;
  const total = 1 << m;
  for (let mask = 0; mask < total; mask++) {
    let cost = 0;
    for (const eid of comp.edgeIds) {
      const e = model.edges[eid];
      const ia = comp.nodes.indexOf(e.a);
      const ib = comp.nodes.indexOf(e.b);
      const sa = (mask >> ia) & 1;
      const sb = (mask >> ib) & 1;
      if ((sa ^ sb ^ e.t) === 1) cost += e.weight;
      if (cost >= best && best !== Infinity) break;
    }
    if (cost < best) { best = cost; bestMask = mask; }
  }
  const flips = new Uint8Array(model.size);
  comp.nodes.forEach((id, idx) => { flips[id] = (bestMask >> idx) & 1; });
  return { cost: best, flips, mask: bestMask };
}

export function bruteForceSolve(model) {
  const flips = new Uint8Array(model.size);
  let totalCost = 0;
  for (const comp of model.components) {
    const r = bruteForceComponentCost(model, comp);
    totalCost += r.cost;
    comp.nodes.forEach((id) => { flips[id] = r.flips[id]; });
  }
  return { flips, totalCost, engine: 'brute-force' };
}

export function evaluateFlips(model, flips) {
  const violated = [];
  let totalCost = 0;
  for (const e of model.edges) {
    if ((flips[e.a] ^ flips[e.b] ^ e.t) === 1) {
      violated.push(e.id);
      totalCost += e.weight;
    }
  }
  return { violated, totalCost };
}

// ---------------------------------------------------------------------------
// 锚点
// ---------------------------------------------------------------------------

export function anchorBit(sign) {
  return sign === -1 ? 1 : 0;
}
export function anchorGauge(model, canonicalFlips, anchor) {
  return canonicalFlips[anchor.i] ^ anchorBit(anchor.sign);
}

// 每分量至多一个生效锚点；同分量多个 => 冲突记录，accepted 只含唯一锚点组
export function planAnchors(model, canonicalFlips, incoming) {
  const groups = new Map();
  for (const a of incoming) {
    const cid = model.compOfNode[a.i];
    if (cid < 0) continue;
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push(a);
  }
  const accepted = [];
  const conflicts = [];
  for (const [cid, list] of groups) {
    const comp = model.components[cid];
    if (list.length === 1) {
      accepted.push({ ...list[0], component: cid, key: comp.key });
      continue;
    }
    const gauges = list.map((a) => anchorGauge(model, canonicalFlips, a));
    const contradictory = new Set(gauges).size > 1;
    conflicts.push({
      kind: 'multiple-anchors-same-component',
      component: cid,
      componentKey: comp.key,
      root: comp.rootXY,
      contradictory,
      level: contradictory ? 'error' : 'warning',
      anchors: list.map((a, idx) => ({
        x: a.x, y: a.y, sign: a.sign, i: a.i, impliedGauge: gauges[idx],
      })),
      message: contradictory
        ? `分量 ${comp.key} 有 ${list.length} 个朝向互不一致的锚点；已保留上一次结果，未自动覆盖`
        : `分量 ${comp.key} 有 ${list.length} 个朝向一致但重复的锚点；每个分量只需指定一个朝向`,
    });
  }
  return { accepted, conflicts };
}

export function orientWithAnchors(model, canonicalFlips, acceptedAnchors) {
  const flips = new Uint8Array(canonicalFlips);
  const gaugeByComp = new Int32Array(model.components.length).fill(0);
  const effective = new Map();
  for (const a of acceptedAnchors) {
    const cid = model.compOfNode[a.i];
    const g = canonicalFlips[a.i] ^ anchorBit(a.sign);
    gaugeByComp[cid] = g;
    effective.set(cid, { ...a, component: cid });
  }
  model.components.forEach((comp, cid) => {
    if (!gaugeByComp[cid]) return;
    for (const id of comp.nodes) flips[id] = flips[id] ^ 1;
  });
  return { flips, gaugeByComp, effective };
}

// 两格间最短路与偏好奇偶（冲突定位）
export function traceBetween(model, flips, idA, idB) {
  const prevV = new Int32Array(model.size).fill(-2);
  const prevE = new Int32Array(model.size).fill(-1);
  prevV[idA] = -1;
  const q = [idA];
  while (q.length) {
    const u = q.shift();
    if (u === idB) break;
    for (const eid of model.nodeEdges[u]) {
      const e = model.edges[eid];
      const v = e.a === u ? e.b : e.a;
      if (prevV[v] !== -2) continue;
      prevV[v] = u; prevE[v] = eid; q.push(v);
    }
  }
  if (prevV[idB] === -2) return { reachable: false };
  const pathEdges = [];
  const pathCells = [];
  let cur = idB;
  pathCells.push(cur);
  let preferredParity = 0;
  while (cur !== idA) {
    const eid = prevE[cur];
    pathEdges.unshift(eid);
    preferredParity ^= model.edges[eid].t;
    cur = prevV[cur];
    pathCells.unshift(cur);
  }
  const violatedOnPath = pathEdges.filter((eid) => {
    const e = model.edges[eid];
    return (flips[e.a] ^ flips[e.b] ^ e.t) === 1;
  });
  return {
    reachable: true,
    component: model.compOfNode[idA],
    pathCells, pathEdges,
    preferredParity,
    actualParity: flips[idA] ^ flips[idB],
    anchorParity: flips[idA] ^ flips[idB],
    violatedOnPath,
    note: violatedOnPath.length
      ? `最短路径上有 ${violatedOnPath.length} 条被违反边，使两端实际朝向关系偏离纯偏好传播`
      : '最短路径上没有被违反边；两端关系完全由偏好决定',
  };
}

// ---------------------------------------------------------------------------
// 边详情
// ---------------------------------------------------------------------------

export function edgeDetail(model, flips, edgeId) {
  const e = model.edges[edgeId];
  if (!e) return null;
  const sa = flips[e.a], sb = flips[e.b];
  const violated = (sa ^ sb ^ e.t) === 1;
  const oa = orientedVector(e.va[0], e.va[1], sa);
  const ob = orientedVector(e.vb[0], e.vb[1], sb);
  return {
    ...e,
    flipA: sa, flipB: sb,
    flipAText: sa ? '反转' : '保持',
    flipBText: sb ? '反转' : '保持',
    actualRelation: sa === sb ? 'same-flip' : 'opposite-flip',
    actualRelationText: sa === sb ? '实际同翻' : '实际异翻',
    violated,
    chargedCost: violated ? e.weight : 0,
    outputDot: oa[0] * ob[0] + oa[1] * ob[1],
    orientedA: oa, orientedB: ob,
  };
}

export function orientedVector(dx, dy, flip) {
  return flip ? [-dx, -dy] : [dx, dy];
}

const OCT_GLYPHS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
export function vectorGlyph(dx, dy) {
  if (dx === 0 && dy === 0) return '·';
  let ang = Math.atan2(dy, dx) * 180 / Math.PI;
  if (ang < 0) ang += 360;
  const idx = ((Math.round(ang / 45) % 8) + 8) % 8;
  return OCT_GLYPHS[idx];
}

// ---------------------------------------------------------------------------
// 导出装配
// ---------------------------------------------------------------------------

export function buildSymbolRows(model, flips) {
  const { width: W, height: H, cells } = model;
  const glyphRows = [];
  const signRows = [];
  for (let y = 0; y < H; y++) {
    const gr = [];
    const sr = [];
    for (let x = 0; x < W; x++) {
      const c = cells[cellId(x, y, W)];
      if (!c) { gr.push('·'); sr.push(0); continue; }
      const s = flips[c.i];
      const [ox, oy] = orientedVector(c.dx, c.dy, s);
      gr.push(vectorGlyph(ox, oy));
      sr.push(s ? -1 : 1);
    }
    glyphRows.push(gr);
    signRows.push(sr);
  }
  return {
    glyphRows, signRows,
    glyphText: glyphRows.map((r) => r.join(' ')).join('\n'),
    signText: signRows.map((r) => r.map((v) => (v === 0 ? '·' : (v > 0 ? '+' : '−'))).join(' ')).join('\n'),
  };
}

export function buildExportBundle(model, solution, anchorState, conflicts) {
  const { flips } = solution;
  const symbols = buildSymbolRows(model, flips);
  const compRows = model.components.map((comp) => {
    const csol = solution.components[comp.id];
    const anchor = anchorState?.effective?.get(comp.id) || null;
    return {
      component: comp.key,
      cellCount: comp.nodes.length,
      cells: comp.nodes.map((id) => { const p = idXY(id, model.width); return [p.x, p.y]; }),
      root: [comp.rootXY.x, comp.rootXY.y],
      anchor: anchor ? [anchor.x, anchor.y, anchor.sign] : null,
      anchored: !!anchor,
      violationCost: csol.cost,
      violatedEdgeCount: csol.violated.length,
      defectFaceCount: csol.defectCount,
      faceCount: csol.faceCount,
    };
  });
  const violatedEdges = solution.components.flatMap((csol) =>
    csol.violated.map((eid) => edgeDetail(model, flips, eid))
  ).sort((a, b) => b.weight - a.weight);

  return {
    format: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { width: model.width, height: model.height, note: model.note },
    totals: {
      cells: model.size,
      activeCells: model.activeIds.length,
      spaceCells: model.size - model.activeIds.length,
      connectedEdges: model.edges.length,
      componentCount: model.components.length,
      totalViolationCost: solution.totalCost,
      violatedEdgeCount: violatedEdges.length,
    },
    rules: {
      neighborhood: 4,
      positiveDotPreference: 'same-flip',
      negativeDotPreference: 'opposite-flip',
      violationCost: 'abs(dot) * min(confidence endpoints)',
      zeroCostEdgesConnected: false,
      spaceCellsConnected: false,
      unanchoredConvention: 'component minimum (row,col) cell stays unflipped',
      globalOptimizer: solution.engine || 'planar-dual-mwpm',
    },
    anchors: {
      effective: [...(anchorState?.effective?.values() || [])].map((a) => ({
        component: a.key, x: a.x, y: a.y, sign: a.sign,
      })),
      conflicts: conflicts || [],
    },
    symbolMap: symbols,
    components: compRows,
    violatedEdges: violatedEdges.map((e) => ({
      edgeId: e.id,
      endpoints: [[e.ax, e.ay], [e.bx, e.by]],
      originalDot: e.dot,
      preference: e.preference,
      preferenceText: e.preferenceText,
      flipA: e.flipA, flipB: e.flipB,
      actualRelation: e.actualRelation,
      actualRelationText: e.actualRelationText,
      weight: e.weight,
      chargedCost: e.chargedCost,
      outputDot: e.outputDot,
    })),
  };
}

export function toCSV(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => c.label).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}
