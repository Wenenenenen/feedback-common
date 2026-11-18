
// ===== 内联核心算法（与 src/lib 同源，由 build-artifact.mjs 打包）=====
// 热方法测地线核心库（零依赖，浏览器 / Node 通用 ESM）
// 严格按 samples 包内《格式说明.md》的离散公式组装：
//   面质量矩阵 M、保留负 cot 的刚度矩阵 L、热方程 (M+tL)u=b、
//   单位梯度场 X、Poisson 方程 Lφ=g（源点 Dirichlet 零约束）。
// 稀疏线性求解使用本文件自带的 simplicial LDL^T 分解，不调用任何测地线/网格算子库。

const EPS_AREA = 1e-12;
const EPS_GRAD = 1e-12;

// ---------- 小向量工具 ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => norm(sub(a, b));

// ---------- 稀疏对称矩阵（按列存 Map）与 simplicial LDL^T ----------
function newCols(n) {
  const cols = new Array(n);
  for (let i = 0; i < n; i++) cols[i] = new Map();
  return cols;
}
function addSym(cols, i, j, v) {
  if (v === 0) return;
  if (i === j) {
    cols[i].set(i, (cols[i].get(i) || 0) + v);
    return;
  }
  cols[j].set(i, (cols[j].get(i) || 0) + v);
  cols[i].set(j, (cols[i].get(j) || 0) + v);
}

/**
 * 无主元 simplicial LDL^T（A = L D L^T）。
 * 适用 SPD 矩阵（热方程 M+tL，t>0）与去掉 Dirichlet 行/列后的 SPD 主子矩阵。
 * 返回 { d, Lcols, rowLists, solve }，Lcols[k] 为 Map(row>k -> L[row][k])。
 */
function factorizeLDL(cols, n) {
  const Lcols = new Array(n);
  const rowLists = new Array(n);
  for (let i = 0; i < n; i++) rowLists[i] = [];
  const d = new Float64Array(n);
  const mark = new Int32Array(n).fill(-1);
  const x = new Float64Array(n);

  for (let j = 0; j < n; j++) {
    const pattern = [];
    for (const [p, v] of cols[j]) {
      if (p >= j) {
        mark[p] = j;
        x[p] = v;
        pattern.push(p);
      }
    }
    for (const k of rowLists[j]) {
      const lik = Lcols[k].get(j);
      x[j] -= lik * lik * d[k];
      const f = lik * d[k];
      for (const [p, lpk] of Lcols[k]) {
        if (p <= j) continue;
        if (mark[p] !== j) {
          mark[p] = j;
          x[p] = 0;
          pattern.push(p);
        }
        x[p] -= f * lpk;
      }
    }
    const dj = x[j];
    if (!(dj > 1e-300)) {
      throw new Error(`LDL^T 分解在第 ${j} 个主元处失败（d=${dj}），矩阵非正定`);
    }
    d[j] = dj;
    const col = new Map();
    for (const p of pattern) {
      if (p > j) col.set(p, x[p] / dj);
    }
    Lcols[j] = col;
    for (const p of col.keys()) rowLists[p].push(j);
  }

  function solve(b) {
    const y = new Float64Array(n);
    const phi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (const k of rowLists[i]) s -= Lcols[k].get(i) * y[k];
      y[i] = s;
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i] / d[i];
      for (const [p, lpk] of Lcols[i]) s -= lpk * phi[p];
      phi[i] = s;
    }
    return phi;
  }
  return { d, Lcols, rowLists, solve };
}

/** 对称矩阵（按列 Map 存储）乘向量，用于残差复核 */
function symMatVec(cols, n, v) {
  const r = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const vj = v[j];
    for (const [p, a] of cols[j]) r[p] += a * vj;
  }
  return r;
}
function vecNorm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

// ---------- 网格校验与拓扑分析 ----------
class MeshRejectError extends Error {}

/**
 * 输入 { positions: [[x,y,z]...], triangles: [[a,b,c]...] }
 * 处理顺序：面积<=1e-12 退化面排除 -> 重复面 / 一边>2 面拒绝 -> 连通分量。
 * 返回分析结果（不做任何距离计算）。
 */
function analyzeMesh(positions, triangles, maxFaces = 10000) {
  if (!Array.isArray(positions) || positions.length < 3) {
    throw new MeshRejectError('positions 至少需要 3 个顶点');
  }
  if (!Array.isArray(triangles) || triangles.length === 0) {
    throw new MeshRejectError('triangles 不能为空');
  }
  if (triangles.length > maxFaces) {
    throw new MeshRejectError(
      `面数 ${triangles.length} 超过上限 ${maxFaces}，请简化网格后再导入`
    );
  }
  const nV = positions.length;
  for (const t of triangles) {
    if (!Array.isArray(t) || t.length !== 3 || t.some((q) => !Number.isInteger(q) || q < 0 || q >= nV)) {
      throw new MeshRejectError('三角形顶点索引非法（须为 [0, 顶点数) 内的 3 个整数）');
    }
  }

  // 1) 退化面（含重复顶点、面积 <=1e-12）
  const excludedFaces = [];
  const validFaceIndex = []; // 原始面号 -> 有效面序号
  const faceArea = new Float64Array(triangles.length);
  const faceNormal = new Array(triangles.length);
  for (let fi = 0; fi < triangles.length; fi++) {
    const [a, b, c] = triangles[fi];
    let reason = null;
    if (a === b || b === c || c === a) reason = '重复顶点';
    const e1 = sub(positions[b], positions[a]);
    const e2 = sub(positions[c], positions[a]);
    const n = cross(e1, e2);
    const doubleArea = norm(n);
    const area = doubleArea * 0.5;
    faceArea[fi] = area;
    faceNormal[fi] = doubleArea > 0 ? scale(n, 1 / doubleArea) : [0, 0, 0];
    if (reason === null && area <= EPS_AREA) reason = `面积 ${area.toExponential(2)} ≤ 1e-12`;
    if (reason !== null) {
      excludedFaces.push({ face: fi, indices: triangles[fi].slice(), area, reason });
      faceArea[fi] = 0;
    } else {
      faceArea[fi] = area;
      validFaceIndex[fi] = validFaceIndex.length;
    }
  }
  const validFaces = triangles
    .map((t, fi) => ({ t, fi }))
    .filter(({ fi }) => faceArea[fi] > 0);

  if (validFaces.length === 0) throw new MeshRejectError('所有面均为退化面，无有效网格');

  // 2) 重复面拒绝
  const faceKey = new Map();
  for (const { t, fi } of validFaces) {
    const key = t.slice().sort((x, y) => x - y).join(',');
    if (faceKey.has(key)) {
      throw new MeshRejectError(`重复面：面 ${fi} 与面 ${faceKey.get(key)} 顶点集合相同`);
    }
    faceKey.set(key, fi);
  }

  // 3) 边 -> 邻接面（仅统计有效面）；一边 >2 面拒绝
  const edgeFaces = new Map(); // "a,b" -> [face indices]
  const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const { t, fi } of validFaces) {
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      const key = edgeKey(a, b);
      let arr = edgeFaces.get(key);
      if (!arr) edgeFaces.set(key, (arr = []));
      arr.push(fi);
    }
  }
  for (const [key, fs] of edgeFaces) {
    if (fs.length > 2) {
      throw new MeshRejectError(`非流形边 [${key}] 被 ${fs.length} 个面共享（超过 2 个），拒绝导入`);
    }
  }

  // 4) 连通分量（面之间经共享顶点连通；孤立顶点各自成单点分量）
  const v2faces = new Map();
  for (const { t, fi } of validFaces) {
    for (const v of t) {
      let arr = v2faces.get(v);
      if (!arr) v2faces.set(v, (arr = []));
      arr.push(fi);
    }
  }
  const faceComp = new Int32Array(triangles.length).fill(-1);
  const components = [];
  for (const { fi } of validFaces) {
    if (faceComp[fi] !== -1) continue;
    const cid = components.length;
    const stack = [fi];
    faceComp[fi] = cid;
    const faceList = [];
    const vertSet = new Set();
    while (stack.length) {
      const f = stack.pop();
      faceList.push(f);
      for (const v of triangles[f]) {
        vertSet.add(v);
        for (const g of v2faces.get(v) || []) {
          if (faceComp[g] === -1) {
            faceComp[g] = cid;
            stack.push(g);
          }
        }
      }
    }
    const verts = [...vertSet].sort((a, b) => a - b);
    components.push({
      id: cid,
      faces: faceList.sort((a, b) => a - b),
      verts,
      localOf: new Map(verts.map((g, li) => [g, li])),
      isolated: false,
    });
  }
  const usedVerts = new Set();
  for (const c of components) for (const v of c.verts) usedVerts.add(v);
  for (let v = 0; v < nV; v++) {
    if (!usedVerts.has(v)) {
      components.push({
        id: components.length,
        faces: [],
        verts: [v],
        localOf: new Map([[v, 0]]),
        isolated: true,
      });
    }
  }

  // 5) 边界边、钝角三角形诊断
  const boundaryEdges = [];
  for (const [key, fs] of edgeFaces) {
    if (fs.length === 1) boundaryEdges.push(key.split(',').map(Number));
  }
  const obtuseFaces = [];
  for (const { t, fi } of validFaces) {
    const [a, b, c] = t;
    // 三个顶点角的 cot：角 a 对应边 (b,c)
    const cots = [
      dot(sub(positions[b], positions[a]), sub(positions[c], positions[a])) /
        norm(cross(sub(positions[b], positions[a]), sub(positions[c], positions[a]))),
      dot(sub(positions[a], positions[b]), sub(positions[c], positions[b])) /
        norm(cross(sub(positions[a], positions[b]), sub(positions[c], positions[b]))),
      dot(sub(positions[a], positions[c]), sub(positions[b], positions[c])) /
        norm(cross(sub(positions[a], positions[c]), sub(positions[b], positions[c]))),
    ];
    if (cots.some((q) => q < 0)) {
      obtuseFaces.push({ face: fi, indices: t.slice(), minCot: Math.min(...cots) });
    }
  }

  return {
    positions,
    triangles,
    nV,
    nF: triangles.length,
    validFaces: validFaces.map(({ fi }) => fi),
    excludedFaces,
    components,
    edgeFaces,
    boundaryEdges,
    obtuseFaces,
    faceArea,
    faceNormal,
    faceComp,
  };
}

// ---------- 热方法求解器 ----------
class HeatSolver {
  /**
   * @param analysis analyzeMesh 的返回值
   */
  constructor(analysis) {
    this.a = analysis;
    this.tau = null;
    this.sourceSignature = null;
    // 每个非孤立分量一份与源点无关的网格量（M、L、几何）
    this.compData = analysis.components.map((comp) => this._buildComponent(comp));
    this._heatCache = new Map(); // compId -> { tau, factor, t }
    this._poissonCache = new Map(); // compId -> { sig, factor, freeLocal }
    this.stats = {
      heat: { hits: 0, misses: 0 },
      poisson: { hits: 0, misses: 0 },
    };
  }

  resetStats() {
    this.stats.heat.hits = this.stats.heat.misses = 0;
    this.stats.poisson.hits = this.stats.poisson.misses = 0;
  }

  _buildComponent(comp) {
    const { positions, triangles, faceArea, faceNormal, edgeFaces } = this.a;
    const n = comp.verts.length;
    if (comp.isolated) {
      return { comp, n, isolated: true };
    }
    const localOf = comp.localOf;

    // 唯一有效边 + 平均边长 + t 尺度
    const edgeSet = new Set();
    let edgeLenSum = 0;
    let edgeCount = 0;
    for (const fi of comp.faces) {
      const t = triangles[fi];
      for (let k = 0; k < 3; k++) {
        const u = t[k];
        const v = t[(k + 1) % 3];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edgeLenSum += dist(positions[u], positions[v]);
          edgeCount++;
        }
      }
    }
    const meanEdge = edgeLenSum / edgeCount;

    // 质量矩阵对角元 M_ii = 相邻面面积和 / 3
    const Mdiag = new Float64Array(n);
    // 刚度矩阵 L（正半定符号：L_ii=Σw, L_ij=-w，保留负 cot）
    const Lcols = newCols(n);

    // 每个面的单位法向、面积、三个顶点基函数梯度
    const faceInfo = comp.faces.map((fi) => {
      const t = triangles[fi];
      const [ga, gb, gc] = t.map((g) => localOf.get(g));
      const p0 = positions[t[0]];
      const p1 = positions[t[1]];
      const p2 = positions[t[2]];
      const area = faceArea[fi];
      const nrm = faceNormal[fi];
      const dA = area * 2;
      const gradBasis = [
        scale(cross(nrm, sub(p2, p1)), 1 / dA),
        scale(cross(nrm, sub(p0, p2)), 1 / dA),
        scale(cross(nrm, sub(p1, p0)), 1 / dA),
      ];
      for (const li of [ga, gb, gc]) Mdiag[li] += area / 3;
      return { fi, local: [ga, gb, gc], area, gradBasis };
    });

    // 边权 w = (cot α + cot β)/2，边界边只有一项 /2
    const cotAt = (fi, oppVert) => {
      const t = triangles[fi];
      const other = t.filter((v) => v !== oppVert);
      const e1 = sub(positions[other[0]], positions[oppVert]);
      const e2 = sub(positions[other[1]], positions[oppVert]);
      return dot(e1, e2) / norm(cross(e1, e2)); // 钝角处为负，原样保留
    };
    for (const key of edgeSet) {
      const [u, v] = key.split(',').map(Number);
      const fs = edgeFaces.get(key);
      let w = 0;
      for (const fi of fs) {
        // 面 fi 中边 (u,v) 的对角顶点；边界边只有一项 /2
        const opp = triangles[fi].find((q) => q !== u && q !== v);
        w += 0.5 * cotAt(fi, opp);
      }
      const lu = localOf.get(u);
      const lv = localOf.get(v);
      addSym(Lcols, lu, lu, w);
      addSym(Lcols, lv, lv, w);
      addSym(Lcols, lu, lv, -w);
    }

    return { comp, n, isolated: false, meanEdge, edgeCount, Mdiag, Lcols, faceInfo };
  }

  /**
   * 求解距离场。
   * @param {number[]} sourceVerts 全局源顶点索引（可多个）
   * @param {number} tau 热时间参数 [0.1, 10]
   * @returns 结果对象（含 distances、每分量残差、诊断信息）
   */
  solve(sourceVerts, tau) {
    if (!(tau >= 0.1 && tau <= 10)) {
      throw new MeshRejectError('tau 必须在 [0.1, 10] 范围内');
    }
    const sources = [...new Set(sourceVerts.map(Number))];
    for (const s of sources) {
      if (!Number.isInteger(s) || s < 0 || s >= this.a.nV) {
        throw new MeshRejectError(`源顶点索引 ${s} 非法`);
      }
    }
    const sig = sources.slice().sort((a, b) => a - b).join(',');
    const tauChanged = this.tau !== tau;
    const sourceChanged = this.sourceSignature !== sig;
    this.tau = tau;
    this.sourceSignature = sig;

    const distances = new Array(this.a.nV).fill(null);
    const rawPhi = new Array(this.a.nV).fill(null); // 钳位前的 Poisson 解（残差用）
    const compDiagnostics = [];
    const t0 = performance.now();

    for (const cd of this.compData) {
      const comp = cd.comp;
      const compSources = comp.verts.filter((v) => sources.includes(v));

      if (cd.isolated) {
        // 孤立顶点分量：被选为源 => 距离 0，否则不可达 null
        const v = comp.verts[0];
        if (compSources.length === 1) distances[v] = 0;
        compDiagnostics.push({
          component: comp.id,
          isolated: true,
          vertCount: 1,
          faceCount: 0,
          sourced: compSources.length > 0,
          solved: false,
        });
        continue;
      }

      if (compSources.length === 0) {
        // 无源分量：不求解，全部 null（不可达）
        compDiagnostics.push({
          component: comp.id,
          isolated: false,
          vertCount: cd.n,
          faceCount: comp.faces.length,
          edgeCount: cd.edgeCount,
          meanEdge: cd.meanEdge,
          t: tau * cd.meanEdge * cd.meanEdge,
          sourced: false,
          solved: false,
          reachable: false,
        });
        continue;
      }

      const n = cd.n;
      const t = tau * cd.meanEdge * cd.meanEdge;

      // --- 第一步：热方程 (M + tL) u = b ---
      let heatEntry = this._heatCache.get(comp.id);
      if (heatEntry && heatEntry.tau === tau) {
        this.stats.heat.hits++;
      } else {
        const Acols = newCols(n);
        for (let i = 0; i < n; i++) Acols[i].set(i, cd.Mdiag[i]);
        for (let j = 0; j < n; j++) {
          for (const [p, v] of cd.Lcols[j]) {
            Acols[j].set(p, (Acols[j].get(p) || 0) + t * v);
          }
        }
        heatEntry = { tau, t, factor: factorizeLDL(Acols, n), Acols };
        this._heatCache.set(comp.id, heatEntry);
        this.stats.heat.misses++;
      }
      const b = new Float64Array(n);
      for (const v of compSources) b[cd.comp.localOf.get(v)] = 1;
      const u = heatEntry.factor.solve(b);

      // 热方程残差（原始完整系统自由行）
      const Au = symMatVec(heatEntry.Acols, n, u);
      const rHeat = new Float64Array(n);
      for (let i = 0; i < n; i++) rHeat[i] = Au[i] - b[i];
      const heatRhsNorm = vecNorm(b);
      const heatResNorm = vecNorm(rHeat);

      // --- 面梯度与单位向量场 X = -grad u / |grad u| ---
      const g = new Float64Array(n); // Poisson 右端
      for (const fi of cd.faceInfo) {
        const gu = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const guk = fi.gradBasis[k];
          const uk = u[fi.local[k]];
          gu[0] += guk[0] * uk;
          gu[1] += guk[1] * uk;
          gu[2] += guk[2] * uk;
        }
        const len = norm(gu);
        const X = len > EPS_GRAD ? scale(gu, -1 / len) : [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          g[fi.local[k]] += fi.area * dot(fi.gradBasis[k], X);
        }
      }

      // --- 第二步：L φ = g，所有源顶点 Dirichlet 零约束，消元求非源 ---
      const sourceLocal = new Set(compSources.map((v) => cd.comp.localOf.get(v)));
      const freeLocal = [];
      for (let i = 0; i < n; i++) if (!sourceLocal.has(i)) freeLocal.push(i);
      let phi;
      let poissonResNorm = 0;
      let poissonRhsNorm = 0;

      if (freeLocal.length === 0) {
        // 分量所有顶点都是源点
        phi = new Float64Array(n);
      } else {
        const nf = freeLocal.length;
        const freeOfLocal = new Map(freeLocal.map((li, k) => [li, k]));
        let pEntry = this._poissonCache.get(comp.id);
        const pSig = compSources.slice().sort((a, b) => a - b).join(',');
        if (pEntry && pEntry.sig === pSig) {
          this.stats.poisson.hits++;
        } else {
          // 组装自由行/列主子矩阵 Lff
          const Lff = newCols(nf);
          for (let jj = 0; jj < nf; jj++) {
            const lj = freeLocal[jj];
            for (const [lp, v] of cd.Lcols[lj]) {
              const kp = freeOfLocal.get(lp);
              if (kp !== undefined) Lff[jj].set(kp, v);
            }
          }
          pEntry = { sig: pSig, factor: factorizeLDL(Lff, nf), Lff, nf };
          this._poissonCache.set(comp.id, pEntry);
          this.stats.poisson.misses++;
        }
        const gf = new Float64Array(nf);
        for (let k = 0; k < nf; k++) gf[k] = g[freeLocal[k]];
        const phiFree = pEntry.factor.solve(gf);

        // Poisson 残差：在钳位前的原始解、自由行上计算
        const Lp = symMatVec(pEntry.Lff, pEntry.nf, phiFree);
        const rP = new Float64Array(pEntry.nf);
        for (let i = 0; i < pEntry.nf; i++) rP[i] = Lp[i] - gf[i];
        poissonRhsNorm = vecNorm(gf);
        poissonResNorm = vecNorm(rP);

        phi = new Float64Array(n);
        for (let k = 0; k < nf; k++) phi[freeLocal[k]] = phiFree[k];
        for (const li of sourceLocal) phi[li] = 0;
      }

      // 钳位前的原始解留档
      for (let li = 0; li < n; li++) rawPhi[cd.comp.verts[li]] = phi[li];
      // 最终距离 max(φ, 0)，源点为 0
      for (let li = 0; li < n; li++) {
        distances[cd.comp.verts[li]] = Math.max(phi[li], 0);
      }
      for (const v of compSources) distances[v] = 0;

      compDiagnostics.push({
        component: comp.id,
        isolated: false,
        vertCount: n,
        faceCount: comp.faces.length,
        edgeCount: cd.edgeCount,
        meanEdge: cd.meanEdge,
        t,
        sourced: true,
        solved: true,
        reachable: true,
        sourceCount: compSources.length,
        heat: {
          residualNorm: heatResNorm,
          rhsNorm: heatRhsNorm,
          relativeResidual: heatResNorm / Math.max(heatRhsNorm, 1e-12),
        },
        poisson: {
          residualNorm: poissonResNorm,
          rhsNorm: poissonRhsNorm,
          relativeResidual: poissonResNorm / Math.max(poissonRhsNorm, 1e-12),
        },
      });
    }

    const solveMs = performance.now() - t0;
    const reachable = distances.filter((d) => d !== null);
    const maxDistance = reachable.length ? Math.max(...reachable) : 0;

    return {
      distances,
      rawPhi,
      sources,
      tau,
      tPerComponent: Object.fromEntries(
        this.compData
          .filter((cd) => !cd.isolated)
          .map((cd) => [cd.comp.id, this.tau * cd.meanEdge * cd.meanEdge])
      ),
      maxDistance,
      unreachableCount: distances.filter((d) => d === null).length,
      componentDiagnostics: compDiagnostics,
      cacheStats: JSON.parse(JSON.stringify(this.stats)),
      tauChanged,
      sourceChanged,
      solveMs,
    };
  }
}

// ---------- 等值线提取（每三角形线性距离场） ----------
/**
 * @param result HeatSolver.solve 的结果
 * @param analysis analyzeMesh 结果
 * @param spacing 等值线间距（>0）
 * @returns [{ level, face, a:[x,y,z], b:[x,y,z] }]
 * 规则：完全等值面不产生线段；整条等值边仅由面编号较小者输出。
 */
function extractIsolines(result, analysis, spacing) {
  if (!(spacing > 0)) throw new Error('等值线间距必须为正数');
  const { positions, triangles, edgeFaces } = analysis;
  const { distances, maxDistance } = result;
  if (maxDistance <= 0) return [];
  const eps = 1e-12 * Math.max(1, maxDistance);
  const segments = [];
  const interp = (pa, pb, va, vb, level) => {
    const r = (level - va) / (vb - va);
    return [pa[0] + r * (pb[0] - pa[0]), pa[1] + r * (pb[1] - pa[1]), pa[2] + r * (pb[2] - pa[2])];
  };

  for (let level = spacing; level <= maxDistance + eps; level += spacing) {
    for (let fi = 0; fi < triangles.length; fi++) {
      const t = triangles[fi];
      const vals = t.map((v) => distances[v]);
      if (vals.some((d) => d === null)) continue; // 不可达分量不参与
      const pts = positions;
      const levelVerts = [];
      for (let k = 0; k < 3; k++) if (Math.abs(vals[k] - level) <= eps) levelVerts.push(k);
      const crossings = [];
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        if ((vals[k] - level) * (vals[k2] - level) < 0) {
          crossings.push({
            edge: [t[k], t[k2]],
            pos: interp(pts[t[k]], pts[t[k2]], vals[k], vals[k2], level),
          });
        }
      }

      if (levelVerts.length === 3) continue; // 完全等值面
      if (levelVerts.length === 2) {
        // 整条等值边：仅面编号较小者输出（边界边直接输出）
        const [k1, k2] = levelVerts;
        const u = t[k1];
        const v = t[k2];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        const nb = (edgeFaces.get(key) || []).filter((f) => f !== fi);
        if (nb.length === 0 || fi < nb[0]) {
          segments.push({ level, face: fi, a: pts[u].slice(), b: pts[v].slice() });
        }
        continue;
      }
      if (levelVerts.length === 1) {
        if (crossings.length !== 1) continue;
        const k = levelVerts[0];
        segments.push({ level, face: fi, a: pts[t[k]].slice(), b: crossings[0].pos.slice() });
        continue;
      }
      // 0 个等值顶点：标准跨交，应有 2 个交点
      if (crossings.length === 2) {
        segments.push({ level, face: fi, a: crossings[0].pos.slice(), b: crossings[1].pos.slice() });
      }
    }
  }
  return segments;
}

// ---------- 两份同拓扑网格距离场对比 ----------
function compareFields(resultA, resultB, analysisA, analysisB) {
  if (analysisA.nV !== analysisB.nV) {
    throw new Error('拓扑不一致：顶点数不同');
  }
  const ta = JSON.stringify(analysisA.triangles);
  const tb = JSON.stringify(analysisB.triangles);
  if (ta !== tb) throw new Error('拓扑不一致：三角形连接关系不同');
  const da = resultA.distances;
  const db = resultB.distances;
  const diffs = new Array(da.length).fill(null);
  let maxAbs = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let count = 0;
  let mismatchedReachability = 0;
  for (let i = 0; i < da.length; i++) {
    if (da[i] === null || db[i] === null) {
      if (da[i] !== db[i]) mismatchedReachability++;
      continue;
    }
    const d = Math.abs(da[i] - db[i]);
    diffs[i] = d;
    maxAbs = Math.max(maxAbs, d);
    sumAbs += d;
    sumSq += d * d;
    count++;
  }
  return {
    sameTopology: true,
    comparedVertices: count,
    maxAbsDifference: maxAbs,
    meanAbsDifference: count ? sumAbs / count : 0,
    rmsDifference: count ? Math.sqrt(sumSq / count) : 0,
    mismatchedReachability,
    perVertexDifference: diffs,
  };
}

// Node 下的 performance 兜底
if (typeof performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1e6 };
}

// 网格导入解析：样例 JSON、Wavefront OBJ、ASCII PLY。
// 只做解析，不做几何计算；返回 { positions, triangles, sources, tau }。

class ParseError extends Error {}

function parseMeshText(text, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json') || text.trimStart().startsWith('{')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new ParseError(`JSON 解析失败：${e.message}`);
    }
    if (!Array.isArray(data.positions) || !Array.isArray(data.triangles)) {
      throw new ParseError('JSON 缺少 positions / triangles 数组');
    }
    return {
      positions: data.positions.map((p) => [Number(p[0]), Number(p[1]), Number(p[2] ?? 0)]),
      triangles: data.triangles.map((t) => t.slice()),
      sources: Array.isArray(data.sources) ? data.sources.slice() : [],
      tau: typeof data.tau === 'number' ? data.tau : 1,
    };
  }
  if (lower.endsWith('.obj') || text.includes('\nv ') || text.startsWith('v ')) {
    return parseOBJ(text);
  }
  if (lower.endsWith('.ply') || text.trimStart().startsWith('ply')) {
    return parsePLY(text);
  }
  throw new ParseError('不支持的文件格式（支持 .json / .obj / .ply）');
}

function parseOBJ(text) {
  const positions = [];
  const triangles = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0)]);
    } else if (parts[0] === 'f') {
      const idx = parts.slice(1).map((tok) => {
        const n = Number(tok.split('/')[0]);
        return n > 0 ? n - 1 : positions.length + n; // OBJ 负索引
      });
      if (idx.length < 3) continue;
      for (let k = 1; k < idx.length - 1; k++) triangles.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  if (!positions.length || !triangles.length) throw new ParseError('OBJ 中未读到顶点或面');
  return { positions, triangles, sources: [], tau: 1 };
}

function parsePLY(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new ParseError('非法 PLY 文件头');
  let i = 1;
  let fmt = '';
  let nV = 0;
  let nF = 0;
  const props = [];
  let inVertex = false;
  while (i < lines.length) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts[0] === 'format') {
      fmt = parts[1];
      if (fmt !== 'ascii') throw new ParseError('仅支持 ASCII PLY（binary PLY 请先转换）');
    } else if (parts[0] === 'element') {
      inVertex = parts[1] === 'vertex';
      if (parts[1] === 'vertex') nV = Number(parts[2]);
      if (parts[1] === 'face') nF = Number(parts[2]);
    } else if (parts[0] === 'property' && inVertex) {
      props.push(parts[parts.length - 1]);
    } else if (parts[0] === 'end_header') {
      i++;
      break;
    }
    i++;
  }
  const xIdx = props.indexOf('x');
  const yIdx = props.indexOf('y');
  const zIdx = props.indexOf('z');
  if (xIdx < 0 || yIdx < 0) throw new ParseError('PLY 顶点缺少 x/y 属性');
  const positions = [];
  for (let k = 0; k < nV; k++, i++) {
    const p = lines[i].trim().split(/\s+/).map(Number);
    positions.push([p[xIdx], p[yIdx], zIdx >= 0 ? p[zIdx] : 0]);
  }
  const triangles = [];
  for (let k = 0; k < nF; k++, i++) {
    const p = lines[i].trim().split(/\s+/).map(Number);
    const cnt = p[0];
    if (cnt < 3) continue;
    for (let q = 1; q < cnt - 1; q++) triangles.push([p[1], p[q + 1], p[q + 2]]);
  }
  return { positions, triangles, sources: [], tau: 1 };
}

// Turbo 近似配色（Google AI Blog, Mikhailov 2019），7 控制点三次样条查表。
// 输入 t∈[0,1]，输出 [r,g,b] 0-255。不可达区域用灰色，由调用方处理。
const TURBO_STOPS = [
  [48, 18, 59],
  [100, 40, 150],
  [34, 90, 225],
  [10, 175, 225],
  [40, 225, 120],
  [180, 245, 50],
  [245, 200, 30],
  [230, 110, 20],
  [170, 30, 10],
];

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function turbo(t) {
  const x = Math.min(1, Math.max(0, t)) * (TURBO_STOPS.length - 1);
  const i = Math.min(TURBO_STOPS.length - 2, Math.floor(x));
  const f = smoothstep(0, 1, x - i);
  const c0 = TURBO_STOPS[i];
  const c1 = TURBO_STOPS[i + 1];
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * f),
    Math.round(c0[1] + (c1[1] - c0[1]) * f),
    Math.round(c0[2] + (c1[2] - c0[2]) * f),
  ];
}

function turboCss(t) {
  const [r, g, b] = turbo(t);
  return `rgb(${r},${g},${b})`;
}

const UNREACHABLE_COLOR = [120, 120, 128];

/** 按距离场生成每顶点颜色（可达顶点 turbo 归一化，不可达灰） */
function fieldColors(distances, maxDistance) {
  const colors = new Float32Array(distances.length * 3);
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    let c;
    if (d === null) c = UNREACHABLE_COLOR;
    else c = turbo(maxDistance > 0 ? d / maxDistance : 0);
    colors[i * 3] = c[0] / 255;
    colors[i * 3 + 1] = c[1] / 255;
    colors[i * 3 + 2] = c[2] / 255;
  }
  return colors;
}

// 导出工具：顶点距离 JSON、等值线段 JSON、计算诊断 JSON。


function buildDistanceExport(analysis, result) {
  return {
    type: 'heat-surface-ruler/distances',
    version: 1,
    generatedAt: new Date().toISOString(),
    vertexCount: analysis.nV,
    sources: result.sources,
    tau: result.tau,
    maxDistance: result.maxDistance,
    // null 表示不可达分量上的顶点
    distances: result.distances.map((d) => (d === null ? null : Number(d.toPrecision(10)))),
  };
}

function buildIsolineExport(analysis, result, spacing) {
  const segments = extractIsolines(result, analysis, spacing);
  return {
    type: 'heat-surface-ruler/isolines',
    version: 1,
    generatedAt: new Date().toISOString(),
    spacing,
    maxDistance: result.maxDistance,
    segmentCount: segments.length,
    levels: [...new Set(segments.map((s) => s.level))].sort((a, b) => a - b),
    segments: segments.map((s) => ({
      level: Number(s.level.toPrecision(10)),
      face: s.face,
      a: s.a.map((c) => Number(c.toPrecision(10))),
      b: s.b.map((c) => Number(c.toPrecision(10))),
    })),
  };
}

function buildDiagnosticExport(analysis, result, spacing, isoSegments, extra = {}) {
  return {
    type: 'heat-surface-ruler/diagnostics',
    version: 1,
    generatedAt: new Date().toISOString(),
    ...extra,
    tau: result.tau,
    sources: result.sources,
    heatTimePerComponent: result.tPerComponent,
    mesh: {
      vertexCount: analysis.nV,
      faceCount: analysis.nF,
      validFaceCount: analysis.validFaces.length,
      boundaryEdgeCount: analysis.boundaryEdges.length,
      obtuseFaceCount: analysis.obtuseFaces.length,
      nonManifoldReject: false,
    },
    excludedFaces: analysis.excludedFaces,
    obtuseFaces: analysis.obtuseFaces,
    components: result.componentDiagnostics,
    cacheStats: result.cacheStats,
    unreachableVertexCount: result.unreachableCount,
    solveMs: result.solveMs,
    isoline: {
      spacing,
      segmentCount: isoSegments.length,
    },
  };
}


export {
  analyzeMesh, HeatSolver, extractIsolines, compareFields, MeshRejectError,
  parseMeshText, ParseError, fieldColors, turboCss,
  buildDistanceExport, buildIsolineExport, buildDiagnosticExport,
};

// ===== 界面与渲染（与 src/app.js 同源）=====
// 单文件 artifact 版应用逻辑（UMD 全局 THREE；核心算法由构建脚本内联，与 src/lib 同源）

const HM = { analyzeMesh, HeatSolver, compareFields, extractIsolines, parseMeshText, ParseError, fieldColors, turboCss, buildDistanceExport, buildIsolineExport, buildDiagnosticExport };
window.HM = HM;
const state = { analysis: null, solver: null, result: null, sources: [], tau: 1, isoSpacing: 1, meshB: null, comparison: null };

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(6, -8, 6);
const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.78));
const key = new THREE.DirectionalLight(0xffffff, 1.35);
key.position.set(5, 5, 8);
scene.add(key);

let surfaceMesh = null, unreachableMesh = null, wireMesh = null, isoGroup = null, markerGroup = null, pickPoints = null;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

function frameGeometry(analysis) {
  const box = new THREE.Box3();
  for (const p of analysis.positions) box.expandByPoint(new THREE.Vector3(...p));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  controls.target.copy(center);
  const r = Math.max(size.x, size.y, size.z);
  camera.position.copy(center).add(new THREE.Vector3(r * 0.9, -r * 1.1, r * 0.7));
  camera.near = Math.max(0.001, r / 1000);
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  controls.update();
  const scale = Math.max(r, 0.05) * 0.03;
  raycaster.params.Points.threshold = scale;
  pickPoints.material.size = scale * 0.8;
}

function buildThreeMesh(analysis) {
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(analysis.nV * 3);
  analysis.positions.forEach((p, i) => pos.set(p, i * 3));
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setIndex(analysis.validFaces.flatMap((fi) => analysis.triangles[fi]));
  geom.computeVertexNormals();
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(analysis.nV * 3).fill(0.6), 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0.05, flatShading: true,
  }));
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 })
  );
  const picks = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
    new THREE.PointsMaterial({ size: 0.18, sizeAttenuation: true, color: 0xffffff })
  );
  picks.visible = false;
  return { mesh, wire, picks };
}

function loadMeshIntoScene(analysis) {
  if (surfaceMesh) {
    scene.remove(surfaceMesh, wireMesh, pickPoints);
    surfaceMesh.geometry.dispose(); wireMesh.geometry.dispose(); pickPoints.geometry.dispose();
  }
  if (unreachableMesh) { scene.remove(unreachableMesh); unreachableMesh.geometry.dispose(); unreachableMesh = null; }
  if (isoGroup) { scene.remove(isoGroup); isoGroup = null; }
  if (markerGroup) { scene.remove(markerGroup); markerGroup = null; }
  const built = buildThreeMesh(analysis);
  surfaceMesh = built.mesh; wireMesh = built.wire; pickPoints = built.picks;
  scene.add(surfaceMesh, wireMesh, pickPoints);
  markerGroup = new THREE.Group(); scene.add(markerGroup);
  isoGroup = new THREE.Group(); scene.add(isoGroup);
  frameGeometry(analysis);
  document.getElementById('emptyHint').classList.add('hidden');
  tooltip.classList.add('hidden');
}

function rebuildUnreachableMesh() {
  if (unreachableMesh) { scene.remove(unreachableMesh); unreachableMesh.geometry.dispose(); unreachableMesh = null; }
  if (!state.result) return;
  const an = state.analysis;
  const nullFaces = an.validFaces.filter((fi) => an.triangles[fi].some((v) => state.result.distances[v] === null));
  if (!nullFaces.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', surfaceMesh.geometry.attributes.position);
  g.setIndex(nullFaces.flatMap((fi) => an.triangles[fi]));
  g.computeVertexNormals();
  unreachableMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: 0x8a8f9c, side: THREE.DoubleSide, roughness: 0.9, flatShading: true,
  }));
  scene.add(unreachableMesh);
}

function runSolve() {
  if (!state.solver || state.sources.length === 0) return;
  state.result = state.solver.solve(state.sources, state.tau);
  surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(fieldColors(state.result.distances, state.result.maxDistance), 3));
  rebuildUnreachableMesh();
  updateMarkers();
  rebuildIsolines();
  renderDiagnostics();
  enableExport(true);
  document.getElementById('legend').classList.remove('hidden');
  document.getElementById('legendMax').textContent = state.result.maxDistance.toFixed(3);
  if (state.meshB) state.meshB.result = state.meshB.solver.solve(state.sources, state.tau);
}

function updateMarkers() {
  markerGroup.clear();
  const pos = surfaceMesh.geometry.attributes.position;
  for (const v of state.sources) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.position.set(pos.getX(v), pos.getY(v), pos.getZ(v));
    markerGroup.add(m);
  }
}

function rebuildIsolines() {
  isoGroup.clear();
  if (!document.getElementById('isoToggle').checked) return;
  const segments = HM.extractIsolines(state.result, state.analysis, state.isoSpacing);
  const arr = new Float32Array(segments.length * 6);
  segments.forEach((s, i) => { arr.set(s.a, i * 6); arr.set(s.b, i * 6 + 3); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  isoGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x14161c, transparent: true, opacity: 0.9 })));
}

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.22;
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');

canvas.addEventListener('pointermove', (e) => {
  if (!surfaceMesh) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickPoints, false);
  if (hits.length) { showTooltip(e, hits[0].index); canvas.style.cursor = 'pointer'; }
  else { tooltip.classList.add('hidden'); canvas.style.cursor = 'default'; }
});
canvas.addEventListener('pointerleave', () => tooltip.classList.add('hidden'));

function showTooltip(e, v) {
  const an = state.analysis, p = an.positions[v];
  let dTxt;
  if (!state.result) dTxt = '尚未求解';
  else if (state.result.distances[v] === null) dTxt = '<span class="null">不可达（该分量无源点）</span>';
  else dTxt = `<b>${state.result.distances[v].toFixed(5)}</b>`;
  tooltip.innerHTML = `顶点 <b>#${v}</b>${state.sources.includes(v) ? ' · <b>源点</b>' : ''}<br/>坐标 (${p.map((c) => c.toFixed(3)).join(', ')})<br/>表面距离：${dTxt}`;
  tooltip.style.left = `${e.offsetX + 14}px`;
  tooltip.style.top = `${e.offsetY + 14}px`;
  tooltip.classList.remove('hidden');
}

function selectSource(v) {
  const multi = document.getElementById('multiMode').checked;
  if (multi) { if (!state.sources.includes(v)) state.sources.push(v); }
  else state.sources = [v];
  document.getElementById('sourceList').textContent = `源点：[${state.sources.join(', ')}]`;
  runSolve();
}
window.__pickIsolated = (v) => selectSource(v);

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !surfaceMesh) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickPoints, false);
  if (hits.length) selectSource(hits[0].index);
});

async function readMeshFile(file) { return HM.parseMeshText(await file.text(), file.name); }

function applyLoadedMesh(parsed, name) {
  let analysis;
  try { analysis = HM.analyzeMesh(parsed.positions, parsed.triangles); }
  catch (err) { showReject(err.message); return null; }
  state.analysis = analysis;
  state.solver = new HeatSolver(analysis);
  state.sources = parsed.sources.length ? parsed.sources.slice(0, 1) : [];
  state.tau = Math.min(10, Math.max(0.1, parsed.tau || 1));
  document.getElementById('tauSlider').value = state.tau;
  document.getElementById('tauVal').textContent = Number(state.tau).toFixed(2);
  state.result = null; state.meshB = null; state.comparison = null;
  document.getElementById('meshBInfo').textContent = '';
  document.getElementById('compareResult').innerHTML = '';
  document.getElementById('compareBtn').disabled = true;
  document.getElementById('clearCompareBtn').disabled = true;
  loadMeshIntoScene(analysis);
  renderMeshInfo(name, analysis);
  renderExcluded(analysis);
  enableExport(false);
  document.getElementById('diagBox').textContent = '网格已就绪，点击顶点选择源点后求解。';
  if (state.sources.length) {
    document.getElementById('sourceList').textContent = `源点：[${state.sources.join(', ')}]`;
    runSolve();
  } else document.getElementById('sourceList').textContent = '';
  return analysis;
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { applyLoadedMesh(await readMeshFile(file), file.name); }
  catch (err) { showReject(err instanceof HM.ParseError ? err.message : `读取失败：${err.message}`); }
  e.target.value = '';
});

document.getElementById('fileInputB').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = await readMeshFile(file);
    let analysisB;
    try { analysisB = HM.analyzeMesh(parsed.positions, parsed.triangles); }
    catch (err) { document.getElementById('meshBInfo').innerHTML = `<span class="bad">${err.message}</span>`; return; }
    if (state.analysis && (analysisB.nV !== state.analysis.nV || JSON.stringify(analysisB.triangles) !== JSON.stringify(state.analysis.triangles))) {
      document.getElementById('meshBInfo').innerHTML = '<span class="bad">与主网格拓扑不一致，无法对比</span>';
      state.meshB = null; document.getElementById('compareBtn').disabled = true; return;
    }
    const solverB = new HeatSolver(analysisB);
    const resultB = state.sources.length ? solverB.solve(state.sources, state.tau) : null;
    state.meshB = { name: file.name, analysis: analysisB, solver: solverB, result: resultB };
    document.getElementById('meshBInfo').innerHTML = `<b>${file.name}</b><br/>${analysisB.nV} 顶点 / ${analysisB.validFaces.length} 有效面`;
    document.getElementById('compareBtn').disabled = !(state.result && resultB);
    document.getElementById('clearCompareBtn').disabled = false;
  } catch (err) {
    document.getElementById('meshBInfo').innerHTML = `<span class="bad">${err.message}</span>`;
  }
  e.target.value = '';
});

document.getElementById('loadSampleBtn').addEventListener('click', () => {
  const positions = [], triangles = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) positions.push([x - 4, y - 4, 0]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = y * 9 + x;
    triangles.push([a, a + 1, a + 9], [a + 1, a + 10, a + 9]);
  }
  applyLoadedMesh({ positions, triangles, sources: [40], tau: 1 }, '内置平面样例');
});

document.getElementById('compareBtn').addEventListener('click', () => {
  if (!state.meshB || !state.result || !state.meshB.result) return;
  const cmp = HM.compareFields(state.result, state.meshB.result, state.analysis, state.meshB.analysis);
  state.comparison = cmp;
  const maxDiff = Math.max(cmp.maxAbsDifference, 1e-12);
  const colors = new Float32Array(state.analysis.nV * 3);
  for (let i = 0; i < state.analysis.nV; i++) {
    if (cmp.perVertexDifference[i] === null) colors.set([0.54, 0.56, 0.61], i * 3);
    else { const m = HM.turboCss(cmp.perVertexDifference[i] / maxDiff).match(/\d+/g).map(Number); colors.set([m[0] / 255, m[1] / 255, m[2] / 255], i * 3); }
  }
  surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  document.getElementById('compareResult').innerHTML =
    `<b>${state.meshB.name}</b> 对比：<br/>最大绝对差异：<b>${cmp.maxAbsDifference.toExponential(3)}</b><br/>平均绝对差异：${cmp.meanAbsDifference.toExponential(3)}<br/>均方根差异：${cmp.rmsDifference.toExponential(3)}<br/>可达性不一致顶点：${cmp.mismatchedReachability}<br/><small>当前着色为逐顶点差异（归一化）</small>`;
});

document.getElementById('clearCompareBtn').addEventListener('click', () => {
  state.meshB = null; state.comparison = null;
  document.getElementById('meshBInfo').textContent = '';
  document.getElementById('compareResult').innerHTML = '';
  document.getElementById('compareBtn').disabled = true;
  document.getElementById('clearCompareBtn').disabled = true;
  document.getElementById('fileInputB').value = '';
  if (state.result) surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(HM.fieldColors(state.result.distances, state.result.maxDistance), 3));
});

document.getElementById('tauSlider').addEventListener('input', (e) => {
  state.tau = Number(e.target.value);
  document.getElementById('tauVal').textContent = state.tau.toFixed(2);
  if (state.sources.length) runSolve();
});
document.getElementById('isoSlider').addEventListener('input', (e) => {
  state.isoSpacing = Number(e.target.value);
  document.getElementById('isoVal').textContent = state.isoSpacing.toFixed(2);
  if (state.result) rebuildIsolines();
});
document.getElementById('isoToggle').addEventListener('change', (e) => {
  if (isoGroup) isoGroup.visible = e.target.checked;
  if (e.target.checked && state.result) rebuildIsolines();
});
document.getElementById('meshToggle').addEventListener('change', (e) => { wireMesh.visible = e.target.checked; });
document.getElementById('clearSourcesBtn').addEventListener('click', () => {
  state.sources = [];
  document.getElementById('sourceList').textContent = '';
  markerGroup.clear();
});

// 导出：沙箱下载失效，改为模态预览 + 复制
function showExportModal(title, obj) {
  const text = JSON.stringify(obj, null, 2);
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').value = text;
  document.getElementById('modal').classList.remove('hidden');
}
document.getElementById('exportDistBtn').addEventListener('click', () =>
  showExportModal('顶点距离 JSON（可全选复制保存）', HM.buildDistanceExport(state.analysis, state.result)));
document.getElementById('exportIsoBtn').addEventListener('click', () =>
  showExportModal('等值线段 JSON（可全选复制保存）', HM.buildIsolineExport(state.analysis, state.result, state.isoSpacing)));
document.getElementById('exportDiagBtn').addEventListener('click', () => {
  const segs = HM.extractIsolines(state.result, state.analysis, state.isoSpacing);
  showExportModal('计算诊断 JSON（可全选复制保存）', HM.buildDiagnosticExport(state.analysis, state.result, state.isoSpacing, segs));
});
document.getElementById('copyBtn').addEventListener('click', async () => {
  const ta = document.getElementById('modalText');
  try { await navigator.clipboard.writeText(ta.value); document.getElementById('copyBtn').textContent = '已复制 ✓'; }
  catch { ta.select(); document.getElementById('copyBtn').textContent = '请手动 Ctrl+C 复制'; }
  setTimeout(() => { document.getElementById('copyBtn').textContent = '复制到剪贴板'; }, 1800);
});
document.getElementById('closeModal').addEventListener('click', () => document.getElementById('modal').classList.add('hidden'));

function showReject(msg) {
  const el = document.getElementById('rejectMsg');
  el.textContent = `导入被拒绝：${msg}`;
  el.classList.remove('hidden');
}
function renderMeshInfo(name, an) {
  document.getElementById('rejectMsg').classList.add('hidden');
  document.getElementById('meshInfo').innerHTML =
    `<b>${name}</b><br/>顶点 <b>${an.nV}</b> · 总面 <b>${an.nF}</b> · 有效面 <b>${an.validFaces.length}</b><br/>连通分量 <b>${an.components.length}</b>（含孤立点 ${an.components.filter((c) => c.isolated).length}）`;
}
function renderExcluded(an) {
  const box = document.getElementById('excludedBox');
  if (an.excludedFaces.length) {
    box.classList.remove('hidden');
    document.getElementById('excludedCount').textContent = an.excludedFaces.length;
    document.getElementById('excludedList').innerHTML = an.excludedFaces.map((f) => `<li>面 #${f.face} [${f.indices.join(', ')}]：${f.reason}</li>`).join('');
  } else box.classList.add('hidden');
  const ob = document.getElementById('obtuseBox');
  if (an.obtuseFaces.length || an.boundaryEdges.length) {
    ob.classList.remove('hidden');
    document.getElementById('obtuseCount').textContent = an.obtuseFaces.length;
    document.getElementById('boundaryCount').textContent = an.boundaryEdges.length;
  } else ob.classList.add('hidden');
}
function enableExport(on) {
  for (const id of ['exportDistBtn', 'exportIsoBtn', 'exportDiagBtn']) document.getElementById(id).disabled = !on;
}
function renderDiagnostics() {
  const r = state.result;
  const rows = r.componentDiagnostics.map((c) => {
    if (c.isolated) return `<tr><td>分量 ${c.component}（孤立点）</td><td>${c.sourced ? '源点→0' : 'null'}</td><td>—</td><td>—</td></tr>`;
    if (!c.sourced) return `<tr><td>分量 ${c.component}</td><td class="bad">不可达</td><td>—</td><td>—</td></tr>`;
    const cls = (x) => (x < 1e-8 ? 'good' : 'bad');
    return `<tr><td>分量 ${c.component}（${c.faceCount} 面）</td><td>已求解</td><td class="${cls(c.heat.relativeResidual)}">${c.heat.relativeResidual.toExponential(2)}</td><td class="${cls(c.poisson.relativeResidual)}">${c.poisson.relativeResidual.toExponential(2)}</td></tr>`;
  }).join('');
  document.getElementById('diagBox').innerHTML =
    `求解耗时 ${r.solveMs.toFixed(1)} ms · 不可达顶点 <b id="unreachableCount">${r.unreachableCount}</b> · 最大距离 <b>${r.maxDistance.toFixed(4)}</b><br/>` +
    `缓存：热分解 命中 ${r.cacheStats.heat.hits}/未命中 ${r.cacheStats.heat.misses}，Poisson 命中 ${r.cacheStats.poisson.hits}/未命中 ${r.cacheStats.poisson.misses}` +
    `<table><thead><tr><th>分量</th><th>状态</th><th>热方程残差</th><th>Poisson 残差</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
resize();
animate();

