/*
 * 旋转渲染核心：格式换算 + 主动旋转 + 24-bit 量化。
 *
 * 内部一律使用规范序 [W, Y, Z, X]（即 AmbiX 的 ACN 顺序、SN3D 缩放）。
 * 旋转只作用于 (X, Y, Z)，W 原样通过（0 阶项各向同性，不参与旋转）。
 *
 * 设计要点：
 * - 规范序的旋转结果（W,Y,Z,X）一次算好并量化为 24-bit 整数。
 * - 两种输出格式只差 W 的 √2 与通道重排；导出时 W 由原始输入 W 直接按目标
 *   格式量化，不经过二次量化。因此预览与导出共用同一条旋转曲线。
 * - 试听解码、方向示意、导出都从这份量化结果派生。
 */

import { canonicalIndexMap, FORMAT_SPECS, SQRT2 } from '../ambisonic.js';
import { quatToMatrix, slerp } from '../quaternion.js';
import { quantize24 } from '../wav.js';

export const SCALE = 8388608;
const CANON_NAMES = ['W', 'Y', 'Z', 'X'];

/**
 * 文件通道顺序 → 规范序，W 按格式乘增益。
 * 返回 {W,Y,Z,X} 四个 Float32Array（顺序为 [W,Y,Z,X]）与 frames。
 */
export function toCanonical(inputPlanes, inputFormat) {
  const map = canonicalIndexMap(inputFormat);
  const gain = FORMAT_SPECS[inputFormat].wGainToCanonical;
  const frames = inputPlanes[0].length;
  const w = new Float32Array(frames);
  const srcW = inputPlanes[map.W];
  if (gain === 1) {
    w.set(srcW);
  } else {
    for (let i = 0; i < frames; i++) w[i] = srcW[i] * gain;
  }
  return {
    W: w,
    Y: inputPlanes[map.Y].slice(),
    Z: inputPlanes[map.Z].slice(),
    X: inputPlanes[map.X].slice(),
    frames,
  };
}

/**
 * 每帧旋转矩阵与四元数的供给器。
 * 输出到长度 13 的数组：0..8 为行主序 3×3，9..12 为四元数 [w,x,y,z]。
 *
 * @param {Object} rotation
 * @param {'static'|'automation'} rotation.mode
 * @param {number[]} [rotation.matrix] static 模式的行主序 3×3
 * @param {number[]} [rotation.quat] static 模式的四元数
 * @param {number[]} [rotation.frames] automation 模式的帧号（严格递增）
 * @param {number[][]} [rotation.quats] automation 模式的四元数（已归一化、已对齐）
 */
export function createMatrixProvider(rotation) {
  if (rotation.mode === 'static') {
    const m = rotation.matrix;
    const q = rotation.quat;
    return (frame, out) => {
      out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
      out[3] = m[3]; out[4] = m[4]; out[5] = m[5];
      out[6] = m[6]; out[7] = m[7]; out[8] = m[8];
      if (q) { out[9] = q[0]; out[10] = q[1]; out[11] = q[2]; out[12] = q[3]; }
    };
  }

  const frames = rotation.frames;
  const quats = rotation.quats;
  if (!frames || !quats || frames.length === 0) throw new Error('关键帧曲线为空');
  const last = frames.length - 1;

  return (frame, out) => {
    let q;
    if (frame <= frames[0]) {
      q = quats[0];
    } else if (frame >= frames[last]) {
      q = quats[last];
    } else {
      // 试听/分段渲染时帧号可能跳跃，用二分而不是游标
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (frames[mid] <= frame) lo = mid;
        else hi = mid;
      }
      const span = frames[hi] - frames[lo];
      q = slerp(quats[lo], quats[hi], span > 0 ? (frame - frames[lo]) / span : 0);
    }
    const m = quatToMatrix(q);
    out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
    out[3] = m[3]; out[4] = m[4]; out[5] = m[5];
    out[6] = m[6]; out[7] = m[7]; out[8] = m[8];
    out[9] = q[0]; out[10] = q[1]; out[11] = q[2]; out[12] = q[3];
  };
}

export class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'CancelledError';
  }
}

/**
 * 统计累加器：按规范序逐通道记录峰值与溢出。
 * W 在 FuMa 输出下会被除以 √2，因此 W 的溢出要按两个阈值分别统计：
 *   ambix: |W| >= 1
 *   fuma : |W| >= √2
 */
class StatsAccumulator {
  constructor() {
    this.peak = [0, 0, 0, 0];
    this.overCount = [0, 0, 0, 0];
    this.overFrame = [-1, -1, -1, -1];
    this.wOverFumaCount = 0;
    this.wOverFumaFrame = -1;
    this.nonFiniteCount = 0;
  }

  add(sample, channel, frame) {
    const a = sample < 0 ? -sample : sample;
    if (a > this.peak[channel]) this.peak[channel] = a;
    if (channel === 0) {
      // W：两个输出格式阈值不同
      if (a >= 1) {
        this.overCount[0]++;
        if (this.overFrame[0] < 0) this.overFrame[0] = frame;
      }
      if (a >= SQRT2) {
        this.wOverFumaCount++;
        if (this.wOverFumaFrame < 0) this.wOverFumaFrame = frame;
      }
      return;
    }
    if (a >= 1) {
      this.overCount[channel]++;
      if (this.overFrame[channel] < 0) this.overFrame[channel] = frame;
    }
  }
}

/**
 * 渲染整段，返回规范序的 24-bit 整型平面与逐格式统计。
 *
 * @param {Object} canonical toCanonical 的结果
 * @param {Object} rotation 见 createMatrixProvider
 * @param {Object} [options]
 * @param {(done:number,total:number)=>void} [options.onProgress]
 * @param {{aborted:boolean}} [options.signal]
 * @param {number} [options.chunkFrames]
 * @param {boolean} [options.yieldBetweenChunks] 每块后让出事件循环，便于取消与进度刷新
 * @returns {Promise<{planes:Int32Array[], canonical:Object, stats:Object}>}
 *   planes 顺序为规范序 [W,Y,Z,X]
 */
export async function renderCanonical(canonical, rotation, options = {}) {
  const frames = canonical.frames;
  const matrixAt = createMatrixProvider(rotation);
  const chunkFrames = options.chunkFrames || 131072;
  const onProgress = options.onProgress;
  const signal = options.signal;

  const planes = [
    new Int32Array(frames),
    new Int32Array(frames),
    new Int32Array(frames),
    new Int32Array(frames),
  ];
  const outW = planes[0];
  const outY = planes[1];
  const outZ = planes[2];
  const outX = planes[3];

  const { W, Y, Z, X } = canonical;
  const m = new Float64Array(13);
  const acc = new StatsAccumulator();

  for (let start = 0; start < frames; start += chunkFrames) {
    if (signal && signal.aborted) throw new CancelledError();
    const end = Math.min(start + chunkFrames, frames);
    for (let f = start; f < end; f++) {
      matrixAt(f, m);
      const x = X[f];
      const y = Y[f];
      const z = Z[f];
      const w = W[f];
      const yo = m[3] * x + m[4] * y + m[5] * z;
      const zo = m[6] * x + m[7] * y + m[8] * z;
      const xo = m[0] * x + m[1] * y + m[2] * z;

      if (!Number.isFinite(w) || !Number.isFinite(yo) || !Number.isFinite(zo) || !Number.isFinite(xo)) {
        acc.nonFiniteCount++;
      }
      acc.add(w, 0, f);
      acc.add(yo, 1, f);
      acc.add(zo, 2, f);
      acc.add(xo, 3, f);

      outW[f] = quantize24(w);
      outY[f] = quantize24(yo);
      outZ[f] = quantize24(zo);
      outX[f] = quantize24(xo);
    }
    if (onProgress) onProgress(end, frames);
    if (options.yieldBetweenChunks) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    planes,
    canonical,
    stats: {
      canonicalPeak: acc.peak,
      canonicalOverCount: acc.overCount,
      canonicalOverFrame: acc.overFrame,
      nonFiniteCount: acc.nonFiniteCount,
      ambix: formatStats(acc, 'ambix'),
      fuma: formatStats(acc, 'fuma'),
    },
  };
}

/**
 * 规范序统计 → 指定输出格式的统计（通道下标按该格式的文件顺序给出）。
 * @returns {{peak:number, peakChannel:number, overflowCount:number,
 *            overflowFrame:number, overflowChannel:number}}
 */
export function formatStats(acc, outputFormat) {
  const wScale = outputFormat === 'fuma' ? 1 / SQRT2 : 1;
  const peaks = acc.peak.map((p, c) => (c === 0 ? p * wScale : p));

  let peak = 0;
  let peakChannel = canonicalChannelToFormat(0, outputFormat);
  for (let c = 0; c < 4; c++) {
    if (peaks[c] > peak) {
      peak = peaks[c];
      peakChannel = canonicalChannelToFormat(c, outputFormat);
    }
  }

  let overflowCount = 0;
  let overflowFrame = -1;
  let overflowChannel = -1;
  for (let c = 0; c < 4; c++) {
    const count = c === 0
      ? (outputFormat === 'fuma' ? acc.wOverFumaCount : acc.overCount[0])
      : acc.overCount[c];
    if (count <= 0) continue;
    overflowCount += count;
    const frame = c === 0
      ? (outputFormat === 'fuma' ? acc.wOverFumaFrame : acc.overFrame[0])
      : acc.overFrame[c];
    if (overflowFrame < 0 || (frame >= 0 && frame < overflowFrame)) {
      overflowFrame = frame;
      overflowChannel = canonicalChannelToFormat(c, outputFormat);
    }
  }
  return { peak, peakChannel, overflowCount, overflowFrame, overflowChannel };
}

/** 规范序通道下标 → 输出格式通道下标。 */
export function canonicalChannelToFormat(canonicalChannel, outputFormat) {
  const map = canonicalIndexMap(outputFormat);
  return map[CANON_NAMES[canonicalChannel]];
}

/** 输出格式通道名（下标为该格式的文件顺序）。 */
export function outputChannelName(formatId, index) {
  const order = formatId === 'fuma' ? ['W', 'X', 'Y', 'Z'] : ['W', 'Y', 'Z', 'X'];
  return order[index];
}

/**
 * 规范序量化平面 → 指定输出格式的整型平面（导出用）。
 * - ambix：W Y Z X 原序
 * - fuma ：W 由原始（未旋转的）W 重新量化到 1/√2 电平，随后 X Y Z 重排
 * 传入 canonicalWSource 为 toCanonical 得到的原始 W，避免二次量化。
 */
export function formatPlanes(planes, canonicalWSource, outputFormat) {
  const frames = planes[0].length;
  const out = [
    new Int32Array(frames),
    new Int32Array(frames),
    new Int32Array(frames),
    new Int32Array(frames),
  ];
  if (outputFormat === 'ambix') {
    out[0].set(planes[0]);
    out[1].set(planes[1]);
    out[2].set(planes[2]);
    out[3].set(planes[3]);
    return out;
  }
  const wOut = out[0];
  const scale = 1 / SQRT2;
  for (let i = 0; i < frames; i++) wOut[i] = quantize24(canonicalWSource[i] * scale);
  out[1].set(planes[3]); // X
  out[2].set(planes[1]); // Y
  out[3].set(planes[2]); // Z
  return out;
}

