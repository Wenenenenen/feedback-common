/*
 * 笼体加载、校验与逐单元仿射变换。
 * 所有几何判定使用 BigInt 精确谓词；矩阵数值计算仅用于变形结果（导出容差 1e-6）。
 */
(function (global) {
  'use strict';
  const E = global.TCExact;
  const X = global.TCIntersect;
  const { bi, i3, orient3d, signBi } = E;

  const MAX_COORD = 1000000;
  const EPS6 = 1e-6;

  function intPoint(v) {
    if (!Array.isArray(v) || v.length !== 3 ||
        typeof v[0] !== 'number' || !Number.isInteger(v[0]) ||
        typeof v[1] !== 'number' || !Number.isInteger(v[1]) ||
        typeof v[2] !== 'number' || !Number.isInteger(v[2])) {
      throw new Error('坐标必须是三个整数');
    }
    if (Math.abs(v[0]) > MAX_COORD || Math.abs(v[1]) > MAX_COORD || Math.abs(v[2]) > MAX_COORD) {
      throw new Error(`坐标分量绝对值超过 ${MAX_COORD}`);
    }
    return [v[0], v[1], v[2]];
  }

  /** 有向体积的 6 倍，带符号 BigInt。 */
  function signedVolume6(points, cell) {
    const t = cell.map(i => i3(bi(points[i][0]), bi(points[i][1]), bi(points[i][2])));
    return orient3d(t[0], t[1], t[2], t[3]);
  }

  /** 单元 AABB（整数 min/max）。 */
  function cellAABB(points, cell) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const id of cell) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], points[id][k]);
        mx[k] = Math.max(mx[k], points[id][k]);
      }
    }
    return { mn, mx };
  }
  function aabbOverlap(a, b) {
    return a.mn[0] <= b.mx[0] && b.mn[0] <= a.mx[0] &&
           a.mn[1] <= b.mx[1] && b.mn[1] <= a.mx[1] &&
           a.mn[2] <= b.mx[2] && b.mn[2] <= a.mx[2];
  }

  /**
   * 生成需要做精确相交裁决的候选单元对。
   * 两类：(1) 共享至少一个顶点（邻接，可能有面/边/点接触）；
   *      (2) 无共享顶点但 AABB 相交（潜在体积穿插，必须排查）。
   */
  function candidatePairs(points, cells) {
    const nC = cells.length;
    const bbs = cells.map(c => cellAABB(points, c));
    const pairSet = new Set();
    const add = (a, b) => { if (a !== b) pairSet.add(a < b ? a * nC + b : b * nC + a); };

    // (1) 顶点邻接
    const vertCells = new Map();
    cells.forEach((cell, ci) => {
      for (const id of cell) {
        if (!vertCells.has(id)) vertCells.set(id, []);
        const list = vertCells.get(id);
        for (const other of list) add(ci, other);
        list.push(ci);
      }
    });

    // (2) 空间哈希补捉无共享顶点但 AABB 相交的对
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const n = Math.max(1, Math.round(Math.cbrt(nC)));
    const span = [hi[0] - lo[0] || 1, hi[1] - lo[1] || 1, hi[2] - lo[2] || 1];
    const cellOf = (p) => [
      Math.min(n - 1, Math.max(0, Math.floor((p[0] - lo[0]) / span[0] * n))),
      Math.min(n - 1, Math.max(0, Math.floor((p[1] - lo[1]) / span[1] * n))),
      Math.min(n - 1, Math.max(0, Math.floor((p[2] - lo[2]) / span[2] * n))),
    ];
    const grid = new Map();
    bbs.forEach((bb, ci) => {
      const g0 = cellOf(bb.mn), g1 = cellOf(bb.mx);
      for (let x = g0[0]; x <= g1[0]; x++)
        for (let y = g0[1]; y <= g1[1]; y++)
          for (let z = g0[2]; z <= g1[2]; z++) {
            const key = x + ',' + y + ',' + z;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(ci);
          }
    });
    for (const list of grid.values()) {
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (aabbOverlap(bbs[a], bbs[b])) add(a, b);
        }
    }
    return [...pairSet].map(code => [Math.floor(code / nC), code % nC]);
  }

  /**
   * 校验整副笼（rest 或 pose 同一套拓扑）。
   * @returns {{badCells:number[], reasons:Map<number,string>}}
   */
  function validateCage(points, cells) {
    const bad = new Set();
    const reasons = new Map();
    const flag = (ci, why) => {
      bad.add(ci);
      if (!reasons.has(ci)) reasons.set(ci, why);
    };

    // 1) 单元合法性：顶点互异、有向体积非零
    const volSign = [];
    cells.forEach((cell, ci) => {
      if (cell.length !== 4 || new Set(cell).size !== 4 ||
          cell.some(id => !Number.isInteger(id) || id < 0 || id >= points.length)) {
        flag(ci, '单元必须是 4 个互不相同的有效顶点编号');
        volSign.push(0);
      } else {
        const v = signedVolume6(points, cell);
        const s = signBi(v);
        if (s === 0) { flag(ci, '单元有向体积为零（四点共面）'); }
        volSign.push(s);
      }
    });

    // 2) 两两相交只允许共有顶点张成的接触
    // 预计算每个单元的齐次点，避免在候选对循环里重复 BigInt 分配
    const tetPts = cells.map(cell =>
      cell.map(id => i3(bi(points[id][0]), bi(points[id][1]), bi(points[id][2]))));
    const pairs = candidatePairs(points, cells);
    for (const [ia, ib] of pairs) {
      if (bad.has(ia) || bad.has(ib)) continue;
      const r = X.tetPairLegalIdx(ia, ib, cells, tetPts);
      if (!r.ok) { flag(ia, `与单元 ${ib} 非法相交：${r.reason}`); flag(ib, `与单元 ${ia} 非法相交：${r.reason}`); }
    }
    return { badCells: [...bad].sort((a, b) => a - b), reasons, volSign };
  }

  /** rest→pose 体积符号一致性检查。 */
  function volumeSignMismatch(restSign, poseSign) {
    const out = [];
    for (let i = 0; i < restSign.length; i++) {
      if (restSign[i] !== 0 && poseSign[i] !== 0 && restSign[i] !== poseSign[i]) out.push(i);
    }
    return out;
  }

  /* ---------- 数值线性代数（仅用于变形输出） ---------- */
  function solve3(A, b) {
    const m = [[A[0][0], A[0][1], A[0][2], b[0]],
               [A[1][0], A[1][1], A[1][2], b[1]],
               [A[2][0], A[2][1], A[2][2], b[2]]];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
      if (Math.abs(m[piv][col]) < 1e-12) return null;
      [m[piv], m[col]] = [m[col], m[piv]];
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = m[r][col] / m[col][col];
        for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }
  function mat3Inverse(m) {
    const a = m;
    const c00 = a[1][1] * a[2][2] - a[1][2] * a[2][1];
    const c01 = -(a[1][0] * a[2][2] - a[1][2] * a[2][0]);
    const c02 = a[1][0] * a[2][1] - a[1][1] * a[2][0];
    const c10 = -(a[0][1] * a[2][2] - a[0][2] * a[2][1]);
    const c11 = a[0][0] * a[2][2] - a[0][2] * a[2][0];
    const c12 = -(a[0][0] * a[2][1] - a[0][1] * a[2][0]);
    const c20 = a[0][1] * a[1][2] - a[0][2] * a[1][1];
    const c21 = -(a[0][0] * a[1][2] - a[0][2] * a[1][0]);
    const c22 = a[0][0] * a[1][1] - a[0][1] * a[1][0];
    const det = a[0][0] * c00 + a[0][1] * c01 + a[0][2] * c02;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    // 余子式转置 = 逆
    return [
      [c00 * invDet, c10 * invDet, c20 * invDet],
      [c01 * invDet, c11 * invDet, c21 * invDet],
      [c02 * invDet, c12 * invDet, c22 * invDet],
    ];
  }

  /**
   * 计算每个单元 rest→pose 的仿射映射 x' = F x + t，
   * 以及法线矩阵 N = (F^-1)^T。
   */
  function cellTransforms(rest, pose, cells) {
    return cells.map(cell => {
      const r0 = rest[cell[0]], p0 = pose[cell[0]];
      const colsR = [0, 1, 2].map(k => [rest[cell[k + 1]][0] - r0[0], rest[cell[k + 1]][1] - r0[1], rest[cell[k + 1]][2] - r0[2]]);
      const colsP = [0, 1, 2].map(k => [pose[cell[k + 1]][0] - p0[0], pose[cell[k + 1]][1] - p0[1], pose[cell[k + 1]][2] - p0[2]]);
      // F * colsR[j] = colsP[j]，逐行求解
      const F = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let row = 0; row < 3; row++) {
        const A = [colsR[0], colsR[1], colsR[2]].map(c => [...c]);
        const sol = solve3(A, [colsP[0][row], colsP[1][row], colsP[2][row]]);
        if (!sol) return null;
        F[row] = sol;
      }
      const invF = mat3Inverse(F);
      if (!invF) return null;
      // N = inv(F)^T
      const N = [
        [invF[0][0], invF[1][0], invF[2][0]],
        [invF[0][1], invF[1][1], invF[2][1]],
        [invF[0][2], invF[1][2], invF[2][2]],
      ];
      const t = [
        p0[0] - dot3(F[0], r0),
        p0[1] - dot3(F[1], r0),
        p0[2] - dot3(F[2], r0),
      ];
      return { F, N, t };
    });
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function applyAffine(tr, x) {
    return [dot3(tr.F[0], x) + tr.t[0], dot3(tr.F[1], x) + tr.t[1], dot3(tr.F[2], x) + tr.t[2]];
  }
  // 法线规则 n' = F^{-T} n。N 已按 N[i][j]=invF[j][i] 构造（即 N=F^{-T}），
  // 故 (N·n) 的第 i 个分量 = Σ_j N[i][j] n[j]，直接用 N 的行点乘即可。
  function applyNormal(tr, n) {
    return [dot3(tr.N[0], n), dot3(tr.N[1], n), dot3(tr.N[2], n)];
  }
  function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (!Number.isFinite(l) || l === 0) return null;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  const api = {
    MAX_COORD, EPS6, intPoint, signedVolume6, validateCage, volumeSignMismatch,
    candidatePairs, cellAABB, aabbOverlap, cellTransforms, applyAffine, applyNormal, normalize3,
    solve3, mat3Inverse,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; global.TCCage = api; }
  else global.TCCage = api;
})(typeof window !== 'undefined' ? window : globalThis);
