// 焦点堆栈 · 多尺度金字塔融合核心（纯 JavaScript，零依赖；浏览器 Worker 与 Node 共用）
//
// 严格按 samples 内《约定.json》实现：
//  - sRGB 解码为线性 RGB，亮度系数 0.2126/0.7152/0.0722；
//  - 卷积越界一律 reflect101（−1→1，n→n−2），长度为 1 时恒取唯一像素；
//  - 清晰度 S = |四邻拉普拉斯| 的 3×3 均值，W_i=(S_i+1e-6)/Σ_j(S_j+1e-6)；
//  - 高斯金字塔核 [1,4,6,4,1]/16 可分离，低通后取偶数坐标，尺寸向上取半；
//    图像与权重都建金字塔，每层权重重新归一化；最细为第 1 层，1×1 不再下采样；
//  - 展开：目标精确尺寸零图 → 偶数坐标放低层值 → 同核二维卷积 ×4；
//  - 拉普拉斯层 = 本层高斯 − 下一层展开，顶层 = 高斯图；
//  - 各层按权重融合后由粗到细展开相加；
//  - 锁定在重建完成后逐像素用指定原图的线性值覆盖（此处等价地直接覆盖原图 8 位值，
//    因为 sRGB 8 位 ↔ 线性往返在本实现中逐字节精确），标签 0=自动、1..N=指定来源。

export const EPSILON = 1e-6;
export const LUMINANCE = [0.2126, 0.7152, 0.0722];
export const KERNEL = [1, 4, 6, 4, 1].map((v) => v / 16);
export const MAX_LEVELS = 6;
export const MAX_DIMENSION = 512;
export const MIN_IMAGES = 2;
export const MAX_IMAGES = 7;

const SRGB_TO_LINEAR = (() => {
  const t = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    const c = v / 255;
    t[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

// 8 位 sRGB → 线性查找表（只读使用）。
export const LINEAR_LUT = SRGB_TO_LINEAR;

export function srgb8ToLinear(v) {
  return SRGB_TO_LINEAR[v];
}

// 线性 0..1 → sRGB 8 位（先限幅再四舍五入）。与 srgb8ToLinear 对 0..255 全部往返精确。
export function linearToSrgb8(c) {
  if (!(c > 0)) return 0;
  if (c >= 1) return 255;
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const v = Math.round(s * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// reflect101：−1→1，n→n−2；n=1 恒为 0。
export function mirrorIndex(i, n) {
  if (n === 1) return 0;
  let j = i;
  while (j < 0 || j >= n) j = j < 0 ? -j : 2 * (n - 1) - j;
  return j;
}

const mirrorTableCache = new Map();
// 返回长度 n+4 的表：索引 p 对应 i = p−2。
function mirrorTable(n) {
  let t = mirrorTableCache.get(n);
  if (!t) {
    t = new Int32Array(n + 4);
    for (let i = -2; i <= n + 1; i++) t[i + 2] = mirrorIndex(i, n);
    mirrorTableCache.set(n, t);
  }
  return t;
}

function blur2D(src, w, h) {
  const tw = mirrorTable(w);
  const th = mirrorTable(h);
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += src[o + tw[x + k + 2]] * KERNEL[k + 2];
      tmp[o + x] = s;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += tmp[th[y + k + 2] * w + x] * KERNEL[k + 2];
      out[y * w + x] = s;
    }
  }
  return out;
}

// 低通后取偶数坐标，尺寸向上取半。
export function downsample(src, w, h) {
  const blurred = blur2D(src, w, h);
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const row = 2 * y * w;
    const orow = y * nw;
    for (let x = 0; x < nw; x++) out[orow + x] = blurred[row + 2 * x];
  }
  return { w: nw, h: nh, data: out };
}

// 展开到精确目标尺寸：零图 → 偶数坐标放低层值 → 同核二维卷积 ×4。
export function expandTo(low, lowW, lowH, targetW, targetH) {
  const zero = new Float64Array(targetW * targetH);
  for (let y = 0; y < lowH; y++) {
    const dstRow = 2 * y * targetW;
    const srcRow = y * lowW;
    for (let x = 0; x < lowW; x++) {
      if (2 * x < targetW && 2 * y < targetH) zero[dstRow + 2 * x] = low[srcRow + x];
    }
  }
  const blurred = blur2D(zero, targetW, targetH);
  for (let i = 0; i < blurred.length; i++) blurred[i] *= 4;
  return blurred;
}

// 各层尺寸：最细第 1 层；尺寸向上取半；1×1 不再下采样；最多 requested 层。
export function pyramidSizes(w, h, requested) {
  const maxLevels = Math.max(1, Math.min(MAX_LEVELS, requested | 0));
  const sizes = [{ w, h }];
  while (sizes.length < maxLevels) {
    const prev = sizes[sizes.length - 1];
    if (prev.w === 1 && prev.h === 1) break;
    const nw = Math.ceil(prev.w / 2);
    const nh = Math.ceil(prev.h / 2);
    if (nw === prev.w && nh === prev.h) break;
    sizes.push({ w: nw, h: nh });
  }
  return sizes;
}

function gaussianPyramid(plane, sizes) {
  const levels = [plane];
  let cur = plane;
  let cw = sizes[0].w;
  let ch = sizes[0].h;
  for (let l = 1; l < sizes.length; l++) {
    const d = downsample(cur, cw, ch);
    levels.push(d.data);
    cur = d.data;
    cw = d.w;
    ch = d.h;
  }
  return levels;
}

// 亮度四邻拉普拉斯绝对值的 3×3 均值。
export function sharpness(lum, w, h) {
  const tw = mirrorTable(w);
  const th = mirrorTable(h);
  const absLap = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const up = th[y - 1 + 2] * w;
    const down = th[y + 1 + 2] * w;
    for (let x = 0; x < w; x++) {
      const v =
        lum[o + tw[x - 1 + 2]] + lum[o + tw[x + 1 + 2]] + lum[up + x] + lum[down + x] - 4 * lum[o + x];
      absLap[o + x] = Math.abs(v);
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const r0 = th[y - 1 + 2] * w;
    const r1 = th[y + 2] * w;
    const r2 = th[y + 1 + 2] * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < 3; dy++) {
        const row = dy === 0 ? r0 : dy === 1 ? r1 : r2;
        for (let dx = -1; dx <= 1; dx++) s += absLap[row + tw[x + dx + 2]];
      }
      out[o + x] = s / 9;
    }
  }
  return out;
}

export function luminanceFromRgb8(rgb8, w, h) {
  const out = new Float64Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 3) {
    out[i] = LUMINANCE[0] * SRGB_TO_LINEAR[rgb8[p]] + LUMINANCE[1] * SRGB_TO_LINEAR[rgb8[p + 1]] + LUMINANCE[2] * SRGB_TO_LINEAR[rgb8[p + 2]];
  }
  return out;
}

function channelFromRgb8(rgb8, w, h, ch) {
  const out = new Float64Array(w * h);
  for (let i = 0, p = ch; i < out.length; i++, p += 3) out[i] = SRGB_TO_LINEAR[rgb8[p]];
  return out;
}

// 基处权重：W_i=(S_i+1e-6)/Σ_j(S_j+1e-6)。纹理为零时各帧等权，绝不出现 0/0。
export function baseWeights(sharpMaps, pixelCount) {
  const n = sharpMaps.length;
  const denom = new Float64Array(pixelCount);
  for (let i = 0; i < n; i++) {
    const s = sharpMaps[i];
    for (let j = 0; j < pixelCount; j++) denom[j] += s[j] + EPSILON;
  }
  let invalid = 0;
  const out = sharpMaps.map((s) => {
    const a = new Float64Array(pixelCount);
    for (let j = 0; j < pixelCount; j++) {
      const d = denom[j];
      if (!(d > 0) || !Number.isFinite(d)) {
        a[j] = 1 / n;
        invalid++;
      } else a[j] = (s[j] + EPSILON) / d;
    }
    return a;
  });
  return { weights: out, invalidPixels: invalid };
}

// 权重高斯金字塔，每层重新归一化（按图像索引顺序求和，保证确定性）。
function weightPyramid(weights, sizes) {
  const n = weights.length;
  const pyramids = weights.map((w0) => gaussianPyramid(w0, sizes));
  const diagnostics = [];
  let invalid = 0;
  for (let l = 0; l < sizes.length; l++) {
    const count = sizes[l].w * sizes[l].h;
    const sum = new Float64Array(count);
    for (let i = 0; i < n; i++) {
      const p = pyramids[i][l];
      for (let j = 0; j < count; j++) sum[j] += p[j];
    }
    let minSum = Infinity;
    let maxSum = -Infinity;
    let filled = 0;
    for (let j = 0; j < count; j++) {
      const s = sum[j];
      if (!(s > 0) || !Number.isFinite(s)) {
        sum[j] = 1; // 理论不可达（核全正），保底避免无效权重
        filled++;
      }
      if (sum[j] < minSum) minSum = sum[j];
      if (sum[j] > maxSum) maxSum = sum[j];
    }
    for (let i = 0; i < n; i++) {
      const p = pyramids[i][l];
      for (let j = 0; j < count; j++) p[j] /= sum[j];
    }
    invalid += filled;
    diagnostics.push({ level: l + 1, width: sizes[l].w, height: sizes[l].h, minSum, maxSum, uniformFallbacks: filled });
  }
  return { pyramids, diagnostics, invalidPixels: invalid };
}

export function dominantSource(weights, pixelCount) {
  const n = weights.length;
  const out = new Uint8Array(pixelCount);
  for (let j = 0; j < pixelCount; j++) {
    let best = 0;
    let bw = weights[0][j];
    for (let i = 1; i < n; i++) {
      if (weights[i][j] > bw) {
        bw = weights[i][j];
        best = i;
      }
    }
    out[j] = best;
  }
  return out;
}

// 锁定覆盖：标签 0=自动，1..N=第 k 张原图（0 基为 k−1）。
// 输出像素直接取该原图的 8 位 sRGB 值——与「用原图线性值覆盖后再编码」逐字节等价。
export function applyLock(fusedRgb8, labels, images, pixelCount) {
  const out = new Uint8Array(fusedRgb8);
  const n = images.length;
  let locked = 0;
  if (!labels) return { rgb8: out, lockedPixels: 0 };
  for (let i = 0; i < pixelCount; i++) {
    const label = labels[i];
    if (label >= 1 && label <= n) {
      const src = images[label - 1].rgb8;
      out[i * 3] = src[i * 3];
      out[i * 3 + 1] = src[i * 3 + 1];
      out[i * 3 + 2] = src[i * 3 + 2];
      locked++;
    }
  }
  return { rgb8: out, lockedPixels: locked };
}

/**
 * 运行完整焦点堆栈。
 * @param {{images: Array<{name:string,width:number,height:number,rgb8:Uint8Array}>, levels:number}} input
 * @returns 融合结果、权重、主导来源与诊断信息
 */
export function runStack({ images, levels }) {
  const n = images.length;
  const width = images[0].width;
  const height = images[0].height;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sizes = pyramidSizes(width, height, levels);
  const L = sizes.length;
  const pixelCount = width * height;

  // 1) 每帧清晰度 S_i
  const sharpMaps = [];
  for (let i = 0; i < n; i++) {
    const lum = luminanceFromRgb8(images[i].rgb8, width, height);
    sharpMaps.push(sharpness(lum, width, height));
  }

  // 2) 基处权重 W_i 与主导来源（平局取最小索引）
  const { weights, invalidPixels: baseInvalid } = baseWeights(sharpMaps, pixelCount);
  const dominant = dominantSource(weights, pixelCount);
  let lowTexturePixels = 0;
  for (let j = 0; j < pixelCount; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sharpMaps[i][j];
    if (sum === 0) lowTexturePixels++;
  }

  // 3) 权重金字塔（每层重新归一化）
  const wp = weightPyramid(weights, sizes);

  // 4) 图像高斯金字塔 + 拉普拉斯层 + 按层权重融合
  const fusedLap = [0, 1, 2].map(() => sizes.map((s) => new Float64Array(s.w * s.h)));
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const plane = channelFromRgb8(images[i].rgb8, width, height, ch);
      const gauss = gaussianPyramid(plane, sizes);
      for (let l = 0; l < L; l++) {
        const size = sizes[l];
        let lap;
        if (l === L - 1) {
          lap = gauss[l];
        } else {
          const next = sizes[l + 1];
          const up = expandTo(gauss[l + 1], next.w, next.h, size.w, size.h);
          lap = new Float64Array(size.w * size.h);
          const base = gauss[l];
          for (let j = 0; j < lap.length; j++) lap[j] = base[j] - up[j];
        }
        const wl = wp.pyramids[i][l];
        const acc = fusedLap[ch][l];
        for (let j = 0; j < acc.length; j++) acc[j] += wl[j] * lap[j];
      }
    }
  }

  // 5) 由粗到细展开相加
  const resultPlanar = new Array(3);
  for (let ch = 0; ch < 3; ch++) {
    let rec = fusedLap[ch][L - 1];
    for (let l = L - 2; l >= 0; l--) {
      const target = sizes[l];
      const next = sizes[l + 1];
      const up = expandTo(rec, next.w, next.h, target.w, target.h);
      const acc = fusedLap[ch][l];
      for (let j = 0; j < up.length; j++) up[j] += acc[j];
      rec = up;
    }
    resultPlanar[ch] = rec;
  }

  // 6) 限幅并编码 sRGB（未锁定的融合结果）
  const fusedRgb8 = new Uint8Array(pixelCount * 3);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 3) {
    fusedRgb8[p] = linearToSrgb8(resultPlanar[0][i]);
    fusedRgb8[p + 1] = linearToSrgb8(resultPlanar[1][i]);
    fusedRgb8[p + 2] = linearToSrgb8(resultPlanar[2][i]);
  }

  // 供差值视图使用的线性平面（Float32 仅作显示，不参与结果计算）
  const fusedLinear = resultPlanar.map((p) => Float32Array.from(p));

  // 结果统计
  let outOfRange = 0;
  let maxValue = -Infinity;
  let minValue = Infinity;
  for (let ch = 0; ch < 3; ch++) {
    const p = resultPlanar[ch];
    for (let j = 0; j < p.length; j++) {
      const v = p[j];
      if (!Number.isFinite(v)) throw new Error('融合结果出现非有限值');
      if (v < 0 || v > 1) outOfRange++;
      if (v > maxValue) maxValue = v;
      if (v < minValue) minValue = v;
    }
  }

  const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  return {
    width,
    height,
    levels: L,
    requestedLevels: Math.max(1, Math.min(MAX_LEVELS, levels | 0)),
    sizes,
    images: images.map((im) => ({ name: im.name, width: im.width, height: im.height })),
    weights: weights.map((w) => Float32Array.from(w)),
    dominant,
    fusedRgb8,
    fusedLinear,
    elapsedMs,
    stats: {
      pixelCount,
      outOfRange,
      minLinear: minValue,
      maxLinear: maxValue,
      lowTexturePixels,
      invalidWeightPixels: baseInvalid + wp.invalidPixels,
      weightLevels: wp.diagnostics,
    },
  };
}

/**
 * 差值视图用：融合结果（线性，未限幅）与目标（原图或主导硬选择）之差的逐像素最大通道幅值。
 * 返回 { magnitude: Float32Array, mean, max }。
 */
export function differenceMagnitude(fusedLinear, images, dominant, width, height, target) {
  const count = width * height;
  const mag = new Float32Array(count);
  const cache = new Map();
  const planeFor = (index, ch) => {
    const key = index * 3 + ch;
    let p = cache.get(key);
    if (!p) {
      p = channelFromRgb8(images[index].rgb8, width, height, ch);
      cache.set(key, p);
    }
    return p;
  };
  const targets = target === 'hard' ? null : [target];
  let sum = 0;
  let max = 0;
  for (let j = 0; j < count; j++) {
    let m = 0;
    const inds = targets || [dominant[j]];
    for (const idx of inds) {
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(fusedLinear[ch][j] - planeFor(idx, ch)[j]);
        if (d > m) m = d;
      }
    }
    mag[j] = m;
    sum += m;
    if (m > max) max = m;
  }
  return { magnitude: mag, mean: sum / count, max };
}
