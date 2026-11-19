// Graph construction and guided harmonic interpolation solver.
// All equations are assembled directly from the formulas in 约定.txt:
//   edges: 4-neighbor valid pixels, D = ||g_p - g_q|| (g in [0,1]),
//          drop edge if D > edge_threshold or w = exp(-D^2/(2 sigma^2)) < 1e-8;
//   unknown pixel equation: sum_q w_pq (z_p - z_q) = 0, anchors keep original z;
//   depth space z = d/1000 (m), inverse space z = 1000/d (1/m).
// No depth-completion / joint-bilateral / guided-filter library is used.

export const STATUS = {
  OUTSIDE: 0,        // 域外
  UNANCHORED: 64,    // 无锚点有效分量
  COMPLETED: 128,    // 成功补全
  ANCHOR: 255,       // 有效原始测量
};

const WEIGHT_EPS = 1e-8;
const RESIDUAL_TOLERANCE = 1e-5; // 约定要求 max|归一化局部残差| <= 1e-5

function unionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  return { find, union, parent };
}

export function buildGraph({ width, height, guide, depth, mask = null, sigma, edgeThreshold }) {
  const n = width * height;
  const domain = new Uint8Array(n);
  for (let i = 0; i < n; i++) domain[i] = mask ? (mask[i] === 255 ? 1 : 0) : 1;

  const guideCh = guide.channels;
  const g = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = i * guideCh;
    g[i * 3] = guide.samples[s] / 255;
    g[i * 3 + 1] = guide.samples[s + 1] / 255;
    g[i * 3 + 2] = guide.samples[s + 2] / 255;
  }

  const anchorMM = new Uint16Array(n); // 0 = not an anchor
  let ignoredMeasurements = 0;
  for (let i = 0; i < n; i++) {
    const d = depth.samples[i];
    if (d === 0) continue;
    if (!domain[i]) { ignoredMeasurements++; continue; }
    anchorMM[i] = d;
  }

  const uf = unionFind(n);
  // CSR adjacency over valid pixels
  const deg = new Int32Array(n);
  const edgeBufA = [], edgeBufB = [], edgeBufW = [];
  const twoSigma2 = 2 * sigma * sigma;

  const tryEdge = (p, q) => {
    if (!domain[p] || !domain[q]) return;
    const gp = p * 3, gq = q * 3;
    const dr = g[gp] - g[gq], dg = g[gp + 1] - g[gq + 1], db = g[gp + 2] - g[gq + 2];
    const D = Math.sqrt(dr * dr + dg * dg + db * db);
    if (D > edgeThreshold) return;
    const w = Math.exp(-(D * D) / twoSigma2);
    if (w < WEIGHT_EPS) return;
    edgeBufA.push(p); edgeBufB.push(q); edgeBufW.push(w);
    deg[p]++; deg[q]++;
    uf.union(p, q);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!domain[p]) continue;
      if (x + 1 < width) tryEdge(p, p + 1);
      if (y + 1 < height) tryEdge(p, p + width);
    }
  }

  // Normalize component ids to compact 0..K-1
  const compOf = new Int32Array(n).fill(-1);
  const rootToComp = new Map();
  for (let i = 0; i < n; i++) {
    if (!domain[i]) continue;
    const r = uf.find(i);
    let c = rootToComp.get(r);
    if (c === undefined) { c = rootToComp.size; rootToComp.set(r, c); }
    compOf[i] = c;
  }
  const componentCount = rootToComp.size;

  // Build CSR
  const offset = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + deg[i];
  const adj = new Int32Array(offset[n]);
  const adjW = new Float64Array(offset[n]);
  const cursor = Int32Array.from(offset);
  for (let e = 0; e < edgeBufA.length; e++) {
    const a = edgeBufA[e], b = edgeBufB[e], w = edgeBufW[e];
    adj[cursor[a]] = b; adjW[cursor[a]] = w; cursor[a]++;
    adj[cursor[b]] = a; adjW[cursor[b]] = w; cursor[b]++;
  }

  // Component pixel lists and anchored flags
  const compPixels = Array.from({ length: componentCount }, () => []);
  const compAnchorCount = new Int32Array(componentCount);
  for (let i = 0; i < n; i++) {
    if (!domain[i]) continue;
    compPixels[compOf[i]].push(i);
    if (anchorMM[i]) compAnchorCount[compOf[i]]++;
  }

  return {
    width, height, n, domain, anchorMM, compOf, componentCount,
    compPixels, compAnchorCount, offset, adj, adjW,
    edgeCount: edgeBufA.length, ignoredMeasurements, sigma, edgeThreshold,
  };
}

// Red-black Gauss-Seidel on one anchored component. Mutates z.
// Anchors are never updated; they stay fixed at their measured z.
function gaussSeidel(graph, pixels, z, maxSweeps, onYield) {
  const { width, offset, adj, adjW, anchorMM } = graph;
  const red = [], black = [];
  for (const p of pixels) {
    if (anchorMM[p]) continue;
    if ((Math.floor(p / width) + (p % width)) % 2 === 0) red.push(p); else black.push(p);
  }
  const sweep = (list) => {
    for (const p of list) {
      let num = 0, den = 0;
      for (let k = offset[p]; k < offset[p + 1]; k++) {
        num += adjW[k] * z[adj[k]];
        den += adjW[k];
      }
      z[p] = num / den;
    }
  };
  let sweeps = 0;
  let maxRes = Infinity;
  const check = () => {
    maxRes = 0;
    for (const p of pixels) {
      if (anchorMM[p]) continue;
      let num = 0, den = 0;
      for (let k = offset[p]; k < offset[p + 1]; k++) {
        num += adjW[k] * z[adj[k]];
        den += adjW[k];
      }
      const r = Math.abs(z[p] - num / den);
      if (r > maxRes) maxRes = r;
    }
    return maxRes;
  };
  return {
    async run() {
      // Check on a widening schedule; convergence uses the contractual
      // 1e-5 local-residual tolerance directly.
      let checkAt = 25;
      let nextCheck = checkAt;
      while (sweeps < maxSweeps) {
        const end = Math.min(nextCheck, maxSweeps);
        while (sweeps < end) { sweep(red); sweep(black); sweeps++; }
        if (check() <= RESIDUAL_TOLERANCE) break;
        checkAt = Math.min(500, Math.floor(checkAt * 2));
        nextCheck = sweeps + checkAt;
        if (onYield) await onYield();
      }
      check();
      return { iterations: sweeps, maxResidual: maxRes, converged: maxRes <= RESIDUAL_TOLERANCE };
    },
  };
}

// Jacobi-preconditioned conjugate gradient on the reduced unknown system
// A u = b, where A is the graph-Laplacian block of unknown pixels and b
// collects anchor contributions. Hand-written sparse linear algebra.
function pcg(graph, pixels, z, maxIters, onYield) {
  const { offset, adj, adjW, anchorMM } = graph;
  const m = pixels.length;
  const local = new Int32Array(graph.n).fill(-1);
  const unknowns = new Int32Array(m);
  let u = 0;
  for (let k = 0; k < m; k++) {
    const p = pixels[k];
    if (!anchorMM[p]) { local[p] = u; unknowns[u++] = p; }
  }
  if (u === 0) return { async run() { return { iterations: 0, maxResidual: 0, converged: true }; } };

  const diag = new Float64Array(u);
  for (let k = 0; k < u; k++) {
    const p = unknowns[k];
    let s = 0;
    for (let e = offset[p]; e < offset[p + 1]; e++) s += adjW[e];
    diag[k] = s;
  }
  const matvec = (x, y) => {
    for (let k = 0; k < u; k++) {
      const p = unknowns[k];
      let v = diag[k] * x[k];
      for (let e = offset[p]; e < offset[p + 1]; e++) {
        const lq = local[adj[e]];
        if (lq >= 0) v -= adjW[e] * x[lq];
      }
      y[k] = v;
    }
  };
  const rhs = new Float64Array(u);
  for (let k = 0; k < u; k++) {
    const p = unknowns[k];
    let s = 0;
    for (let e = offset[p]; e < offset[p + 1]; e++) {
      const q = adj[e];
      if (anchorMM[q]) s += adjW[e] * z[q];
    }
    rhs[k] = s;
  }

  const x = new Float64Array(u);
  for (let k = 0; k < u; k++) x[k] = z[unknowns[k]];
  const r = new Float64Array(u), d = new Float64Array(u);
  const MinvR = new Float64Array(u), Ad = new Float64Array(u);
  matvec(x, Ad);
  let rMr = 0;
  for (let k = 0; k < u; k++) {
    r[k] = rhs[k] - Ad[k];
    MinvR[k] = r[k] / diag[k];
    d[k] = MinvR[k];
    rMr += r[k] * MinvR[k];
  }

  let it = 0;
  // Contractual convergence is measured in the problem's own local residual,
  // not in the rMr proxy, so this is the single source of truth.
  const localResidual = () => {
    for (let k = 0; k < u; k++) z[unknowns[k]] = x[k];
    let mx = 0;
    for (let k = 0; k < u; k++) {
      const p = unknowns[k];
      let num = 0, den = 0;
      for (let e = offset[p]; e < offset[p + 1]; e++) {
        num += adjW[e] * z[adj[e]];
        den += adjW[e];
      }
      const res = Math.abs(z[p] - num / den);
      if (res > mx) mx = res;
    }
    return mx;
  };

  return {
    async run() {
      // Convergence is decided solely by the contractual local-residual
      // tolerance (1e-5 in z space). The rMr energy proxy only bounds the loop.
      // Check early, then widen the interval so O(edges) checks stay cheap
      // relative to the matvec work on large grids.
      let checkAt = 25;
      let nextCheck = checkAt;
      while (it < maxIters && rMr > 1e-30) {
        matvec(d, Ad);
        let dAd = 0;
        for (let k = 0; k < u; k++) dAd += d[k] * Ad[k];
        if (!(dAd > 0)) break;
        const alpha = rMr / dAd;
        let rMrNew = 0;
        for (let k = 0; k < u; k++) {
          x[k] += alpha * d[k];
          r[k] -= alpha * Ad[k];
          MinvR[k] = r[k] / diag[k];
          rMrNew += r[k] * MinvR[k];
        }
        const beta = rMrNew / rMr;
        for (let k = 0; k < u; k++) d[k] = MinvR[k] + beta * d[k];
        rMr = rMrNew;
        it++;

        if (it >= nextCheck || it >= maxIters) {
          const maxRes = localResidual();
          if (maxRes <= RESIDUAL_TOLERANCE) {
            return { iterations: it, maxResidual: maxRes, converged: true };
          }
          checkAt = Math.min(500, Math.floor(checkAt * 2));
          nextCheck = it + checkAt;
          if (onYield) await onYield();
        }
      }
      const maxResidual = localResidual();
      return { iterations: it, maxResidual, converged: maxResidual <= RESIDUAL_TOLERANCE };
    },
  };
}

function yieldEvery(ms, onProgress) {
  let last = Date.now();
  return async () => {
    const now = Date.now();
    if (now - last > ms) {
      await new Promise((r) => setTimeout(r, 0));
      last = Date.now();
      if (onProgress) onProgress();
    }
  };
}

// Linear-or-near-linear initial guess, chosen by anchor density.
//
// Sparse case (the normal one for depth completion): an inverse-squared-hop
// distance blend of all anchors yields a genuinely smooth, near-harmonic field
// so PCG converges in few iterations. Its per-anchor BFS cost is acceptable
// because sparse inputs have few anchors.
//
// Dense case: a single multi-source BFS assigns each pixel its nearest anchor
// (Voronoi). Hop distances are then short, so PCG itself converges quickly
// without the per-anchor cost.
function seedInitialGuess(graph, pixels, z, isAnchor) {
  const { n, offset, adj } = graph;
  const inComponent = new Uint8Array(n);
  for (const p of pixels) inComponent[p] = 1;
  const anchors = [];
  for (const p of pixels) if (isAnchor[p]) anchors.push(p);

  // Per-anchor BFS only when the total work stays within a linear budget.
  const perAnchorBudgetOk = anchors.length * pixels.length <= 8_000_000;

  if (perAnchorBudgetOk) {
    const acc = new Float64Array(n);
    const wsum = new Float64Array(n);
    for (const a of anchors) {
      const dlocal = new Int32Array(n).fill(-1);
      dlocal[a] = 0;
      const q = new Int32Array(pixels.length);
      let h = 0, t = 0; q[t++] = a;
      while (h < t) {
        const p = q[h++];
        for (let e = offset[p]; e < offset[p + 1]; e++) {
          const nx = adj[e];
          if (inComponent[nx] && dlocal[nx] === -1) { dlocal[nx] = dlocal[p] + 1; q[t++] = nx; }
        }
      }
      for (const p of pixels) {
        if (isAnchor[p] || dlocal[p] <= 0) continue;
        const w = 1 / (dlocal[p] * dlocal[p]);
        acc[p] += w * z[a];
        wsum[p] += w;
      }
    }
    for (const p of pixels) if (!isAnchor[p] && wsum[p] > 0) z[p] = acc[p] / wsum[p];
    return;
  }

  // Dense fallback: single multi-source BFS nearest-anchor (Voronoi) seed.
  const dist = new Int32Array(n).fill(-1);
  const acc = new Float64Array(n);
  const cnt = new Int32Array(n);
  const queue = new Int32Array(pixels.length);
  let head = 0, tail = 0;
  for (const a of anchors) { dist[a] = 0; acc[a] = z[a]; cnt[a] = 1; queue[tail++] = a; }
  while (head < tail) {
    const p = queue[head++];
    for (let e = offset[p]; e < offset[p + 1]; e++) {
      const q = adj[e];
      if (!inComponent[q]) continue;
      const nd = dist[p] + 1;
      if (dist[q] === -1) { dist[q] = nd; acc[q] = acc[p]; cnt[q] = cnt[p]; queue[tail++] = q; }
      else if (dist[q] === nd) { acc[q] += acc[p]; cnt[q] += cnt[p]; }
    }
  }
  for (const p of pixels) if (!isAnchor[p] && dist[p] !== -1) z[p] = acc[p] / cnt[p];
}

// Main entry. space: 'depth' | 'inverse'. solver: 'pcg' | 'gs'.
export async function solve(graph, { space = 'depth', solver = 'pcg', onProgress = null } = {}) {
  const { n, width, height, anchorMM, compPixels, compAnchorCount, componentCount, offset, adj, adjW } = graph;
  const z = new Float64Array(n); // NaN = not defined (outside / unanchored)
  z.fill(NaN);
  const isAnchor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (anchorMM[i]) {
      isAnchor[i] = 1;
      z[i] = space === 'depth' ? anchorMM[i] / 1000 : 1000 / anchorMM[i];
    }
  }

  const status = new Uint8Array(n);
  for (let i = 0; i < n; i++) status[i] = graph.domain[i] ? STATUS.UNANCHORED : STATUS.OUTSIDE;
  for (let i = 0; i < n; i++) if (isAnchor[i]) status[i] = STATUS.ANCHOR;

  const residual = new Float64Array(n); // normalized local residual in z space
  const compInfo = [];
  let completedComponents = 0;
  const yieldCtl = yieldEvery(80, onProgress);

  for (let c = 0; c < componentCount; c++) {
    const pixels = compPixels[c];
    const info = {
      id: c, size: pixels.length, anchorCount: compAnchorCount[c],
      completedCount: 0, anchored: compAnchorCount[c] > 0, solved: false,
      iterations: 0, maxAbsResidual: null, meanAbsResidual: null,
      depthMM: null,
    };
    if (!info.anchored) {
      compInfo.push(info);
      continue;
    }
    // Initial guess: inverse graph-distance weighted blend of anchor z values.
    // A multi-source BFS gives a far better starting point than a constant on
    // long chains between distant anchors, cutting CG iterations materially.
    seedInitialGuess(graph, pixels, z, isAnchor);

    const runner = solver === 'gs'
      ? gaussSeidel(graph, pixels, z, 20000, yieldCtl)
      : pcg(graph, pixels, z, 20000, yieldCtl);
    let result = await runner.run();

    // Bounded GS polish if PCG stopped just above the contractual tolerance.
    // The budget scales with component size but stays small: red-black GS on a
    // high-condition-number long chain is far slower than PCG, so an unbounded
    // polish could hang. If it still does not reach 1e-5 the component is
    // honestly reported as unsolved rather than over-smoothed.
    if (!result.converged && solver === 'pcg') {
      const polishBudget = Math.min(2000, Math.max(100, Math.round(8 * Math.sqrt(pixels.length))));
      const gs = gaussSeidel(graph, pixels, z, polishBudget, yieldCtl);
      const polished = await gs.run();
      result = {
        iterations: result.iterations,
        polishIterations: polished.iterations,
        maxResidual: polished.maxResidual,
        converged: polished.converged,
      };
    }
    info.iterations = result.iterations + (result.polishIterations || 0);
    info.pcgIterations = result.iterations;
    info.polishIterations = result.polishIterations || 0;

    if (result.converged) {
      info.solved = true;
      completedComponents++;
      let rs = 0, rmax = 0, cnt = 0;
      for (const p of pixels) {
        if (isAnchor[p]) { status[p] = STATUS.ANCHOR; continue; }
        let num = 0, den = 0;
        for (let e = offset[p]; e < offset[p + 1]; e++) { num += adjW[e] * z[adj[e]]; den += adjW[e]; }
        const r = z[p] - num / den;
        residual[p] = r;
        rs += Math.abs(r); rmax = Math.max(rmax, Math.abs(r)); cnt++;
        status[p] = STATUS.COMPLETED;
      }
      info.completedCount = cnt;
      if (cnt) { info.maxAbsResidual = rmax; info.meanAbsResidual = rs / cnt; }
    }
    compInfo.push(info);
    if (onProgress) onProgress();
  }

  // Output depth in mm
  const outMM = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    if (isAnchor[i]) { outMM[i] = anchorMM[i]; continue; }
    if (!graph.domain[i] || Number.isNaN(z[i])) { outMM[i] = 0; continue; }
    if (status[i] !== STATUS.COMPLETED) { outMM[i] = 0; continue; }
    let mm;
    if (space === 'depth') mm = Math.floor(1000 * z[i] + 0.5);
    else mm = Math.floor(1000 / z[i] + 0.5);
    outMM[i] = Math.max(1, Math.min(65535, mm));
  }

  // Per-component output depth stats
  for (const info of compInfo) {
    if (!info.solved) continue;
    let mn = Infinity, mx = 0, sum = 0, cnt = 0;
    for (const p of compPixels[info.id]) {
      const v = outMM[p];
      if (v > 0) { mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; cnt++; }
    }
    info.depthMM = cnt ? { min: mn, max: mx, mean: sum / cnt } : null;
  }

  const anchorTotal = compInfo.reduce((s, c) => s + c.anchorCount, 0);
  const unanchoredComponents = compInfo.filter((c) => !c.anchored).length;
  const completedPixels = compInfo.reduce((s, c) => s + c.completedCount, 0);
  const validPixels = graph.domain.reduce((s, v) => s + v, 0);

  return {
    space, solver, z, residual, status, outMM, isAnchor,
    components: compInfo,
    stats: {
      width, height,
      validPixels,
      outsidePixels: n - validPixels,
      anchorPixels: anchorTotal,
      completedPixels,
      componentCount,
      anchoredComponents: componentCount - unanchoredComponents,
      unanchoredComponents,
      solvedComponents: completedComponents,
      ignoredMeasurements: graph.ignoredMeasurements,
      edgeCount: graph.edgeCount,
      residualTolerance: RESIDUAL_TOLERANCE,
      allConverged: compInfo.filter((c) => c.anchored).every((c) => c.solved),
    },
  };
}

// Convert z-space residual to an approximate mm residual for display.
export function residualToMM(residualZ, z, space) {
  if (residualZ === 0 || Number.isNaN(z)) return 0;
  if (space === 'depth') return residualZ * 1000;
  // d = 1000/z, dd/ dz = -1000/z^2
  return Math.abs(-1000 / (z * z) * residualZ);
}
