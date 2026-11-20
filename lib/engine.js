// 协同变换去噪引擎（纯计算，不依赖 DOM / Worker）。
//
// 流程严格按样例说明：
//  1. 参考中心 0,s,2s,... (小于边长) + 最后一像素，去重升序，行列笛卡尔积；
//  2. 每个参考图块在 ±r 方框与图像范围的交集内枚举全部整数候选中心，
//     按图块均方距离、y、x 排序，取不超过 K 与候选数的最大 2 次幂个；
//  3. 每图块二维正交 DCT-II，同频系数沿组序做归一化 Walsh-Hadamard；
//  4. 硬阈值初估：|组系数| < 2.7σ 置 0，但组索引 0 的 (0,0) 全局 DC 保留；
//     组权重 1/max(1, 保留系数数)，逆变换后按权重累加再逐像素归一化；
//  5. 维纳二次重建：同时变换原图与初估组，gain = pilot²/(pilot²+σ²)，
//     输出 gain·noisy，组权重 1/max(1e-12, Σgain²)，同法聚合；
//  6. σ=0 直接原样返回两阶段结果。
//
// 图块越界采样使用不重复端点的镜像（仅用于取数），但累加只写回
// “中心 + 偏移”落在原图范围内的原始像素；镜像取到的越界像素不折叠回图内。

import { patchOffsets, referenceCenters, buildPatchIndexMap } from './layout.js';
import { dct2, idct2, groupTransform, inverseGroupTransform } from './transform.js';

export const DEFAULT_PARAMS = Object.freeze({
  patch: 4,
  radius: 4,
  stride: 2,
  capacity: 4,
  sigma: 18,
  threshold: 2.7,
});

export const LIMITS = Object.freeze({
  minSide: 1,
  maxSide: 256,
  patchOptions: [4, 8],
  radiusRange: [4, 12],
  strideRange: [2, 8],
  capacityOptions: [2, 4, 8],
  sigmaRange: [0, 50],
  thresholdRange: [0.5, 5],
});

export function validateParams(input) {
  const p = { ...DEFAULT_PARAMS, ...input };
  const errors = [];
  if (!LIMITS.patchOptions.includes(p.patch)) errors.push('图块大小必须是 4 或 8');
  if (!Number.isInteger(p.radius) || p.radius < 4 || p.radius > 12) errors.push('搜索半径必须在 4 到 12 之间');
  if (!Number.isInteger(p.stride) || p.stride < 2 || p.stride > p.patch) errors.push('步长必须在 2 到图块大小之间');
  if (!LIMITS.capacityOptions.includes(p.capacity)) errors.push('组容量必须是 2、4 或 8');
  if (!Number.isFinite(p.sigma) || p.sigma < 0 || p.sigma > 50) errors.push('噪声标准差必须在 0 到 50 之间');
  if (!Number.isFinite(p.threshold) || p.threshold < 0.5 || p.threshold > 5) errors.push('硬阈值倍数必须在 0.5 到 5 之间');
  if (errors.length) {
    const err = new Error(errors.join('；'));
    err.name = 'ParameterError';
    err.details = errors;
    throw err;
  }
  return p;
}

export function validateImage(image) {
  if (!image || !image.data) throw new Error('图像数据缺失');
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('图像尺寸非法');
  }
  if (width > LIMITS.maxSide || height > LIMITS.maxSide) {
    throw new Error(`图像边长不能超过 ${LIMITS.maxSide} 像素（当前 ${width}×${height}）`);
  }
  if (image.data.length < width * height) throw new Error('图像像素数据长度不足');
  return { width, height };
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function toFloats(image, width, height) {
  const n = width * height;
  const out = new Float64Array(n);
  const data = image.data;
  for (let i = 0; i < n; i++) out[i] = data[i];
  return out;
}

// 从镜像采样映射中提取一个 p×p 图块。
export function extractPatch(image, width, yMapRow, xMapRow) {
  const p = yMapRow.length;
  const out = new Float64Array(p * p);
  for (let i = 0; i < p; i++) {
    const row = yMapRow[i] * width;
    for (let j = 0; j < p; j++) out[i * p + j] = image[row + xMapRow[j]];
  }
  return out;
}

function before(a, b) {
  return a.d < b.d || (a.d === b.d && (a.y < b.y || (a.y === b.y && a.x < b.x)));
}

function insertCandidate(chosen, m, cand) {
  let i = chosen.length;
  if (i >= m && !before(cand, chosen[i - 1])) return;
  if (i < m) chosen.push(cand);
  else i -= 1;
  while (i > 0 && before(cand, chosen[i - 1])) {
    chosen[i] = chosen[i - 1];
    i--;
  }
  chosen[i] = cand;
}

/**
 * 对单个参考中心执行匹配。枚举交集内所有整数候选中心，距离按
 * “每像素均方误差”直接累加平方差（8 位整数输入下精确，并列稳定）；
 * 边界窗口经镜像映射取样。返回按 (距离, y, x) 升序的组员与候选总数。
 */
export function matchGroup(image, width, height, refY, refX, params, maps) {
  const p = params.patch;
  const p2 = p * p;
  const half = p >> 1;
  const r = params.radius;
  const y0 = Math.max(0, refY - r);
  const y1 = Math.min(height - 1, refY + r);
  const x0 = Math.max(0, refX - r);
  const x1 = Math.min(width - 1, refX + r);
  const candidateCount = (y1 - y0 + 1) * (x1 - x0 + 1);
  const cap = Math.min(params.capacity, candidateCount);
  let m = 1;
  while (m * 2 <= cap) m *= 2;

  const ryMap = maps.y[refY];
  const rxMap = maps.x[refX];
  const ref = new Float64Array(p2);
  for (let i = 0; i < p; i++) {
    const row = ryMap[i] * width;
    for (let j = 0; j < p; j++) ref[i * p + j] = image[row + rxMap[j]];
  }

  const chosen = [];
  for (let y = y0; y <= y1; y++) {
    const top = y - half;
    const interiorRow = top >= 0 && top + p <= height;
    const yMapRow = maps.y[y];
    for (let x = x0; x <= x1; x++) {
      const left = x - half;
      const interior = interiorRow && left >= 0 && left + p <= width;
      // 直接累加平方差：8 位整数输入下求和精确，能稳定复现
      // “距离相同则按 y、x 排序”的并列规则（交叉项展开会引入浮点并列噪声）。
      let sumD2 = 0;
      if (interior) {
        for (let i = 0; i < p; i++) {
          const row = (top + i) * width + left;
          const srow = i * p;
          for (let j = 0; j < p; j++) {
            const diff = image[row + j] - ref[srow + j];
            sumD2 += diff * diff;
          }
        }
      } else {
        const xMapRow = maps.x[x];
        for (let i = 0; i < p; i++) {
          const row = yMapRow[i] * width;
          const srow = i * p;
          for (let j = 0; j < p; j++) {
            const diff = image[row + xMapRow[j]] - ref[srow + j];
            sumD2 += diff * diff;
          }
        }
      }
      let d = sumD2 / p2;
      if (!Number.isFinite(d) || d < 0) d = 0;
      insertCandidate(chosen, m, { d, y, x });
    }
  }
  return { m, candidateCount, members: chosen };
}

function buildMaps(width, height, p) {
  const offsets = patchOffsets(p);
  return {
    offsets,
    y: buildPatchIndexMap(height, offsets),
    x: buildPatchIndexMap(width, offsets),
  };
}

export function buildMapsFor(width, height, p) {
  return buildMaps(width, height, p);
}

function dctGroup(image, width, members, p, maps) {
  const p2 = p * p;
  const n = members.length;
  const out = new Float64Array(n * p2);
  for (let i = 0; i < n; i++) {
    const mem = members[i];
    const patch = extractPatch(image, width, maps.y[mem.y], maps.x[mem.x]);
    out.set(dct2(patch, p), i * p2);
  }
  return out;
}

// 只把原始坐标落在 [0,L) 内的重建像素累加回图；镜像取到的越界像素丢弃。
function accumulate(width, height, members, coefs, p2, p, weight, acc, wsum) {
  for (let i = 0; i < members.length; i++) {
    const mem = members[i];
    const spatial = idct2(coefs.subarray(i * p2, (i + 1) * p2), p);
    const top = mem.y - (p >> 1);
    const left = mem.x - (p >> 1);
    const dy0 = Math.max(0, -top);
    const dy1 = Math.min(p, height - top);
    const dx0 = Math.max(0, -left);
    const dx1 = Math.min(p, width - left);
    for (let dy = dy0; dy < dy1; dy++) {
      const row = (top + dy) * width;
      const srow = dy * p;
      for (let dx = dx0; dx < dx1; dx++) {
        const idx = row + left + dx;
        acc[idx] += spatial[srow + dx] * weight;
        wsum[idx] += weight;
      }
    }
  }
}

function normalize(acc, wsum, fallback, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = wsum[i] > 0 ? acc[i] / wsum[i] : fallback[i];
  return out;
}

export function emptyStageStats() {
  return {
    groups: 0,
    membersTotal: 0,
    candidateTotal: 0,
    candidateMin: Infinity,
    candidateMax: 0,
    retainedTotal: 0,
    weightTotal: 0,
    gainSqTotal: 0,
    groupSizes: {},
    meanGroupSize: 0,
    meanRetained: 0,
    meanWeight: 0,
    meanCandidates: 0,
    meanGainSq: 0,
    weightStats: { min: 0, max: 0, mean: 0, median: 0, p02: 0, p98: 0 },
    zeroWeightPixels: 0,
  };
}

function summarize(values) {
  const n = values.length;
  if (!n) return { min: 0, max: 0, mean: 0, median: 0, p02: 0, p98: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let zero = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (!(v > 0)) zero++;
    sum += v;
  }
  const sorted = Float64Array.from(values).sort();
  return {
    min,
    max,
    mean: sum / n,
    median: sorted[n >> 1],
    p02: sorted[Math.min(n - 1, Math.floor(n * 0.02))],
    p98: sorted[Math.min(n - 1, Math.floor(n * 0.98))],
    zeroCount: zero,
  };
}

function finalizeStats(stats, wsum) {
  stats.weightStats = summarize(wsum);
  stats.zeroWeightPixels = stats.weightStats.zeroCount || 0;
  const groups = stats.groups || 1;
  stats.meanGroupSize = stats.membersTotal / groups;
  stats.meanRetained = stats.retainedTotal / groups;
  stats.meanWeight = stats.weightTotal / groups;
  stats.meanCandidates = stats.candidateTotal / groups;
  stats.meanGainSq = stats.gainSqTotal / groups;
  if (!Number.isFinite(stats.candidateMin)) stats.candidateMin = 0;
  delete stats.weightStats.zeroCount;
}

function canceledResult(original, width, height, params, started) {
  return {
    params,
    width,
    height,
    original,
    pilot: null,
    final: null,
    weight1: null,
    weight2: null,
    canceled: true,
    zeroNoise: params.sigma === 0,
    groups: { stage1: emptyStageStats(), stage2: emptyStageStats() },
    timing: { totalMs: now() - started, stage1Ms: 0, stage2Ms: 0 },
    warnings: [],
  };
}

/**
 * 异步运行两阶段去噪（协作式让出事件循环，便于取消）。
 * @param {{width:number,height:number,data:ArrayLike<number>}} image 8 位灰度
 * @param {object} inputParams 参数（缺省用 DEFAULT_PARAMS）
 * @param {{onProgress?:Function, shouldCancel?:Function, yieldNow?:Function}} hooks
 */
export async function runDenoise(image, inputParams = {}, hooks = {}) {
  const { width, height } = validateImage(image);
  const params = validateParams(inputParams);
  const n = width * height;
  const original = toFloats(image, width, height);
  const started = now();

  if (params.sigma === 0) {
    if (hooks.shouldCancel?.()) return canceledResult(original, width, height, params, started);
    const ones = new Float64Array(n).fill(1);
    // 未做聚合：如实报告“每个像素权重恒为 1”，而不是留一组 0 造成误导。
    const stageStats = () => {
      const st = emptyStageStats();
      st.weightStats = { min: 1, max: 1, mean: 1, median: 1, p02: 1, p98: 1 };
      st.zeroWeightPixels = 0;
      st.candidateMin = 0;
      return st;
    };
    hooks.onProgress?.({ phase: 'done', done: 1, total: 1 });
    return {
      params,
      width,
      height,
      original,
      pilot: Float64Array.from(original),
      final: Float64Array.from(original),
      weight1: ones,
      weight2: Float64Array.from(ones),
      canceled: false,
      zeroNoise: true,
      groups: { stage1: stageStats(), stage2: stageStats() },
      timing: { totalMs: now() - started, stage1Ms: 0, stage2Ms: 0 },
      warnings: [],
    };
  }

  const refYs = referenceCenters(height, params.stride);
  const refXs = referenceCenters(width, params.stride);
  const refCount = refYs.length * refXs.length;
  const total = refCount * 2;
  const maps = buildMaps(width, height, params.patch);
  const p2 = params.patch * params.patch;
  const threshold = params.threshold * params.sigma;
  const sigma2 = params.sigma * params.sigma;

  let lastYield = now();
  let lastProgress = 0;
  let done = 0;
  const tick = async (phase) => {
    const t = now();
    if (t - lastYield >= 12) {
      lastYield = t;
      await hooks.yieldNow?.();
    }
    if (hooks.shouldCancel?.()) return true;
    if (t - lastProgress >= 80 || done === total) {
      lastProgress = t;
      hooks.onProgress?.({ phase, done, total });
    }
    return false;
  };

  // ---------- 第一阶段：硬阈值初估 ----------
  const acc1 = new Float64Array(n);
  const wsum1 = new Float64Array(n);
  const stats1 = emptyStageStats();
  const stage1Start = now();

  for (let iy = 0; iy < refYs.length; iy++) {
    const refY = refYs[iy];
    for (let ix = 0; ix < refXs.length; ix++) {
      const refX = refXs[ix];
      const match = matchGroup(original, width, height, refY, refX, params, maps);
      const m = match.m;
      const members = match.members;
      stats1.groupSizes[m] = (stats1.groupSizes[m] || 0) + 1;
      stats1.candidateTotal += match.candidateCount;
      stats1.candidateMin = Math.min(stats1.candidateMin, match.candidateCount);
      stats1.candidateMax = Math.max(stats1.candidateMax, match.candidateCount);

      const noisyGroup = dctGroup(original, width, members, params.patch, maps);
      const grouped = groupTransform(noisyGroup, m, p2);
      let retained = 0;
      for (let i = 0; i < m; i++) {
        const base = i * p2;
        for (let k = 0; k < p2; k++) {
          const idx = base + k;
          if (i === 0 && k === 0) {
            retained++;
            continue;
          }
          if (Math.abs(grouped[idx]) < threshold) grouped[idx] = 0;
          else retained++;
        }
      }
      const weight = 1 / Math.max(1, retained);
      stats1.retainedTotal += retained;
      const reconstructed = inverseGroupTransform(grouped, m, p2);
      accumulate(width, height, members, reconstructed, p2, params.patch, weight, acc1, wsum1);
      stats1.groups++;
      stats1.membersTotal += m;
      stats1.weightTotal += weight;

      done++;
      if (await tick('pilot')) return canceledResult(original, width, height, params, started);
    }
  }

  const pilot = normalize(acc1, wsum1, original, n);
  const stage1Ms = now() - stage1Start;
  finalizeStats(stats1, wsum1);
  // 第二阶段才计算增益；第一阶段没有“保留数”的反向指标。
  stats1.meanGainSq = null;
  stats1.gainSqTotal = null;

  // ---------- 第二阶段：维纳二次重建 ----------
  const acc2 = new Float64Array(n);
  const wsum2 = new Float64Array(n);
  const stats2 = emptyStageStats();
  const stage2Start = now();

  for (let iy = 0; iy < refYs.length; iy++) {
    const refY = refYs[iy];
    for (let ix = 0; ix < refXs.length; ix++) {
      const refX = refXs[ix];
      const match = matchGroup(pilot, width, height, refY, refX, params, maps);
      const m = match.m;
      const members = match.members;
      stats2.groupSizes[m] = (stats2.groupSizes[m] || 0) + 1;
      stats2.candidateTotal += match.candidateCount;
      stats2.candidateMin = Math.min(stats2.candidateMin, match.candidateCount);
      stats2.candidateMax = Math.max(stats2.candidateMax, match.candidateCount);

      const noisyGroup = dctGroup(original, width, members, params.patch, maps);
      const pilotGroup = dctGroup(pilot, width, members, params.patch, maps);
      const noisyT = groupTransform(noisyGroup, m, p2);
      const pilotT = groupTransform(pilotGroup, m, p2);
      const out = new Float64Array(m * p2);
      let gainSqSum = 0;
      for (let idx = 0; idx < m * p2; idx++) {
        const q = pilotT[idx];
        const q2 = q * q;
        const gain = q2 / (q2 + sigma2);
        out[idx] = gain * noisyT[idx];
        gainSqSum += gain * gain;
      }
      const weight = 1 / Math.max(1e-12, gainSqSum);
      stats2.gainSqTotal += gainSqSum;
      const reconstructed = inverseGroupTransform(out, m, p2);
      accumulate(width, height, members, reconstructed, p2, params.patch, weight, acc2, wsum2);
      stats2.groups++;
      stats2.membersTotal += m;
      stats2.weightTotal += weight;

      done++;
      if (await tick('final')) return canceledResult(original, width, height, params, started);
    }
  }

  const final = normalize(acc2, wsum2, original, n);
  const stage2Ms = now() - stage2Start;
  finalizeStats(stats2, wsum2);
  // 维纳阶段不使用硬阈值，保留系数数不适用。
  stats2.meanRetained = null;
  stats2.retainedTotal = null;

  hooks.onProgress?.({ phase: 'done', done: total, total });
  return {
    params,
    width,
    height,
    original,
    pilot,
    final,
    weight1: wsum1,
    weight2: wsum2,
    canceled: false,
    zeroNoise: false,
    groups: { stage1: stats1, stage2: stats2 },
    timing: { totalMs: now() - started, stage1Ms, stage2Ms },
    warnings: [],
  };
}

/**
 * 按需重算某个参考图块的两阶段组信息，用于检查器：
 * 组员位置/距离、空间 DCT 系数、组域系数、硬阈值保留掩码、维纳增益。
 * 匹配过程与引擎完全一致（第一阶段用原图，第二阶段用初估）。
 */
export function inspectGroup(result, refY, refX) {
  const { params, width, height, original, pilot } = result;
  if (!original) throw new Error('结果尚未生成');
  if (params.sigma === 0) {
    return {
      refY,
      refX,
      zeroNoise: true,
      patch: params.patch,
      stage1: { members: [], m: 0, candidateCount: 0, retainedCount: 0, groupWeight: 0, matrices: [] },
      stage2: { members: [], m: 0, candidateCount: 0, sumGainSq: 0, groupWeight: 0, matrices: [] },
    };
  }
  if (!Number.isInteger(refY) || !Number.isInteger(refX) || refY < 0 || refY >= height || refX < 0 || refX >= width) {
    throw new Error('参考中心超出图像范围');
  }
  const maps = buildMaps(width, height, params.patch);
  const p = params.patch;
  const p2 = p * p;
  const threshold = params.threshold * params.sigma;
  const sigma2 = params.sigma * params.sigma;

  const makeStage = (matchImage, isWiener) => {
    const match = matchGroup(matchImage, width, height, refY, refX, params, maps);
    const m = match.m;
    const members = match.members;
    const noisy = dctGroup(original, width, members, p, maps);
    const noisyT = groupTransform(noisy, m, p2);
    const pilotT = isWiener ? groupTransform(dctGroup(pilot, width, members, p, maps), m, p2) : null;
    let retained = 0;
    let sumGainSq = 0;
    const keepMask = new Uint8Array(m * p2);
    const gains = isWiener ? new Float64Array(m * p2) : null;
    for (let i = 0; i < m; i++) {
      for (let k = 0; k < p2; k++) {
        const idx = i * p2 + k;
        if (isWiener) {
          const q = pilotT[idx];
          const g = (q * q) / (q * q + sigma2);
          gains[idx] = g;
          sumGainSq += g * g;
        } else if (i === 0 && k === 0) {
          keepMask[idx] = 1;
          retained++;
        } else if (Math.abs(noisyT[idx]) >= threshold) {
          keepMask[idx] = 1;
          retained++;
        }
      }
    }
    const groupWeight = isWiener ? 1 / Math.max(1e-12, sumGainSq) : 1 / Math.max(1, retained);
    const matrices = members.map((mem, i) => {
      const base = i * p2;
      const dct = Array.from(noisy.subarray(base, base + p2));
      const groupCoef = Array.from(noisyT.subarray(base, base + p2));
      return {
        dct,
        groupCoef,
        pilotCoef: isWiener ? Array.from(pilotT.subarray(base, base + p2)) : null,
        gain: isWiener ? Array.from(gains.subarray(base, base + p2)) : null,
        outputCoef: isWiener
          ? Array.from(gains.subarray(base, base + p2), (g, j) => g * noisyT[base + j])
          : Array.from(groupedPreview(noisyT, keepMask, base, p2)),
        keep: isWiener ? null : Array.from(keepMask.subarray(base, base + p2)),
      };
    });
    return {
      m,
      candidateCount: match.candidateCount,
      members: members.map((mem) => ({ y: mem.y, x: mem.x, distance: mem.d })),
      retainedCount: isWiener ? null : retained,
      groupWeight,
      sumGainSq: isWiener ? sumGainSq : null,
      matrices,
    };
  };

  return {
    refY,
    refX,
    zeroNoise: false,
    patch: p,
    sigma: params.sigma,
    threshold,
    stage1: makeStage(original, false),
    stage2: makeStage(pilot, true),
  };
}

function groupedPreview(noisyT, keepMask, base, p2) {
  const out = new Float64Array(p2);
  for (let k = 0; k < p2; k++) out[k] = keepMask[base + k] ? noisyT[base + k] : 0;
  return out;
}

export function psnr(reference, candidate, width, height) {
  let sum = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const d = reference[i] - candidate[i];
    sum += d * d;
  }
  const mse = sum / n;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

export function mse(reference, candidate, width, height) {
  let sum = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const d = reference[i] - candidate[i];
    sum += d * d;
  }
  return sum / n;
}
