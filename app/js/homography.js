// 归一化 DLT 单应估计 + 固定种子 RANSAC（自实现，不调用任何现成配准接口）。
// 对应点格式：{ a: [x,y], b: [x,y] }，坐标为像素中心。

import { matMul, normalizeH, symmetricEigN } from './linalg.js';

// Hartley 各向同性归一化，返回 { T, pts }
function normalizePoints(pts) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let meanDist = 0;
  for (const [x, y] of pts) meanDist += Math.hypot(x - cx, y - cy);
  meanDist /= n;
  if (!(meanDist > 1e-9)) {
    throw new Error('对应点退化：点全部重合，无法建立归一化坐标');
  }
  const s = Math.SQRT2 / meanDist;
  // [X] = T [x]，T 先平移再缩放
  const T = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  const out = pts.map(([x, y]) => [s * (x - cx), s * (y - cy)]);
  return { T, pts: out };
}

// 归一化 DLT。points: [{a,b}...]，至少 4 对且不得退化。
// 成功返回归一化（h33=1）的 H_ab（a 坐标 -> b 坐标），退化时抛错。
export function estimateHomography(points) {
  if (points.length < 4) {
    throw new Error('单应估计至少需要 4 对对应点，当前只有 ' + points.length + ' 对');
  }
  const aPts = points.map((p) => p.a);
  const bPts = points.map((p) => p.b);
  const na = normalizePoints(aPts);
  const nb = normalizePoints(bPts);
  const n = points.length;
  const A = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [x, y] = na.pts[i];
    const [u, v] = nb.pts[i];
    A[i * 2] = [-x, -y, -1, 0, 0, 0, u * x, u * y, u];
    A[i * 2 + 1] = [0, 0, 0, -x, -y, -1, v * x, v * y, v];
  }
  // A^T A（9x9 对称），最小特征值的特征向量即 DLT 解
  const AtA = new Float64Array(81);
  for (const row of A) {
    for (let i = 0; i < 9; i++) {
      const ri = row[i];
      if (ri === 0) continue;
      for (let j = 0; j < 9; j++) AtA[i * 9 + j] += ri * row[j];
    }
  }
  const eig = symmetricEigN(Array.from(AtA), 9);
  const lambdaMin = eig.values[0];
  const lambdaMax = eig.values[eig.values.length - 1];
  if (!(lambdaMax > 0) || lambdaMin > 1e-8 * lambdaMax) {
    throw new Error('对应点退化：归一化 DLT 矩阵秩亏（点共线或配置不足）');
  }
  const h = eig.vectors[0];
  if (Math.abs(h[8]) < 1e-12) {
    throw new Error('对应点退化：解出的单应 h33≈0（地平线被映到有限区域）');
  }
  const Hn = [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], h[8],
  ];
  // 物理坐标单应：H = Tb^-1 Hn Ta
  const TbInv = invertAffine(nb.T);
  const H = normalizeH(matMul(matMul(TbInv, Hn), na.T));
  return H;
}

// 归一化变换 T 为仿射（第三行 0,0,1），直接求逆
function invertAffine(T) {
  const s = T[0];
  const tx = T[2];
  const sy = T[4];
  const ty = T[5];
  const is = 1 / s;
  return [is, 0, -tx * is, 0, 1 / sy, -ty / sy, 0, 0, 1];
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

function reprojectionError(H, p) {
  const [u, v] = applyH(H, p.a[0], p.a[1]);
  return Math.hypot(u - p.b[0], v - p.b[1]);
}

// 固定种子的可复现 PRNG（mulberry32）
export function makeRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleIndices(n, k, rng) {
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

// RANSAC 剔除误点。
// 输入 pairs: [[[xa,ya],[xb,yb]], ...]；threshold: 像素欧氏重投影阈值。
// 返回 { H, inliers: 索引数组, outliers, residuals, iterations, degenerateSamples }
export function ransacHomography(pairs, threshold, options = {}) {
  const seed = options.seed ?? 20240517;
  const maxIters = options.maxIterations ?? 5000;
  const confidence = options.confidence ?? 0.99;
  const points = pairs.map(([a, b]) => ({ a, b }));
  const n = points.length;
  if (n < 4) {
    throw new Error('RANSAC 至少需要 4 对对应点，当前只有 ' + n + ' 对');
  }
  const rng = makeRng(seed);
  let best = null; // { inliers, count, sse, H }
  let iterations = 0;
  let degenerateSamples = 0;
  let targetIters = maxIters;

  while (iterations < maxIters && iterations < targetIters) {
    iterations++;
    const sample = sampleIndices(n, 4, rng);
    let Hsample;
    try {
      Hsample = estimateHomography(sample.map((i) => points[i]));
    } catch {
      degenerateSamples++;
      continue;
    }
    const inliers = [];
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const e = reprojectionError(Hsample, points[i]);
      if (e <= threshold) {
        inliers.push(i);
        sse += e * e;
      }
    }
    const candidate = { inliers, count: inliers.length, sse, H: Hsample };
    if (
      !best ||
      candidate.count > best.count ||
      (candidate.count === best.count && candidate.sse < best.sse)
    ) {
      best = candidate;
      const w = best.count / n;
      if (w > 0 && w < 1) {
        const denom = 1 - Math.pow(w, 4);
        if (denom > 1e-12) {
          targetIters = Math.min(
            maxIters,
            Math.max(iterations + 1, Math.ceil(Math.log(1 - confidence) / Math.log(denom)))
          );
        }
      } else if (w >= 1) {
        targetIters = iterations; // 全内点，提前结束
      }
    }
  }

  if (!best) {
    throw new Error('RANSAC 未能从任何 4 点采样中估计出单应（采样全部退化）');
  }
  // 内点重估计（归一化 DLT）；内点不足 4 时退回最佳采样模型
  let H = best.H;
  let finalInliers = best.inliers;
  if (best.inliers.length >= 4) {
    try {
      H = estimateHomography(best.inliers.map((i) => points[i]));
      // 重估计后按同一阈值复核内点集合，保证残差口径一致
      finalInliers = [];
      for (let i = 0; i < n; i++) {
        if (reprojectionError(H, points[i]) <= threshold) finalInliers.push(i);
      }
      if (finalInliers.length < 4) {
        H = best.H;
        finalInliers = best.inliers;
      }
    } catch {
      degenerateSamples++;
    }
  }
  const inlierSet = new Set(finalInliers);
  const residuals = points.map((p, i) => ({
    index: i,
    error: reprojectionError(H, p),
    inlier: inlierSet.has(i),
  }));
  return {
    H,
    inliers: finalInliers,
    outliers: points.map((_, i) => i).filter((i) => !inlierSet.has(i)),
    residuals,
    iterations,
    degenerateSamples,
  };
}
