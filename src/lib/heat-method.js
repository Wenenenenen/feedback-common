// 热方法测地线核心库（零依赖，浏览器 / Node 通用 ESM）
// 严格按 samples 包内《格式说明.md》的离散公式组装：
//   面质量矩阵 M、保留负 cot 的刚度矩阵 L、热方程 (M+tL)u=b、
//   单位梯度场 X、Poisson 方程 Lφ=g（源点 Dirichlet 零约束）。
// 稀疏线性求解使用本文件自带的 simplicial LDL^T 分解，不调用任何测地线/网格算子库。

export const EPS_AREA = 1e-12;
export const EPS_GRAD = 1e-12;

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
export function factorizeLDL(cols, n) {
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
export class MeshRejectError extends Error {}

/**
 * 输入 { positions: [[x,y,z]...], triangles: [[a,b,c]...] }
 * 处理顺序：面积<=1e-12 退化面排除 -> 重复面 / 一边>2 面拒绝 -> 连通分量。
 * 返回分析结果（不做任何距离计算）。
 */
export function analyzeMesh(positions, triangles, maxFaces = 10000) {
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
export class HeatSolver {
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
export function extractIsolines(result, analysis, spacing) {
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
export function compareFields(resultA, resultB, analysisA, analysisB) {
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
