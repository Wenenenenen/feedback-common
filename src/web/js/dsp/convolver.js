/*
 * 立体声矩阵卷积（首字母=输出，次字母=输入）：
 *   wetL = conv(inL, LL) + conv(inR, LR)
 *   wetR = conv(inL, RL) + conv(inR, RR)
 *   yL[t] = (1-w) * dryL[t] + w * wetL[t - predelay]
 *   yR[t] = (1-w) * dryR[t] + w * wetR[t - predelay]
 *
 * 固定长度 N = 干声长度 + 最长 IR 长度 - 1 + 预延迟；
 * 干声只占自身长度，其余补零；不做自动归一化。
 *
 * 实现：overlap-save 分块 FFT。卷积核补零到块长 B，FFT 尺寸 2B，
 * 每个块输出 B 个有效样本；输入窗口为 [nB-(B-1), nB+B)，
 * 有效卷积结果位于窗口内第 B-1 个样本起。
 */

import { getFFT } from './fft.js';

export const ROUTES = ['LL', 'LR', 'RL', 'RR'];
export const MAX_PREDELAY_MS = 200;
export const MAX_DRY_SECONDS = 60;
export const MAX_IR_SECONDS = 4;

export class CancelledError extends Error {
  constructor(message = '处理已取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

/** 块长 B 必须 >= 最长 IR，且 B 为 2 的幂，最小 1024。 */
export function chooseBlockSize(maxIrLength) {
  return Math.max(1024, nextPowerOfTwo(Math.max(1, maxIrLength)));
}

/** 计算四条 IR 的频域表示（与 block/fftSize 绑定）。 */
export function buildIrSpectra(irs, fft, fftSize) {
  return irs.map((ir) => {
    const buf = new Float64Array(fftSize * 2);
    const len = Math.min(ir.length, fftSize);
    for (let i = 0; i < len; i++) buf[2 * i] = ir[i];
    fft.transform(buf, 0, false);
    return buf;
  });
}

/** 补零到指定长度（已等长时原样返回）。 */
function padTo(src, frames) {
  if (src.length === frames) return src;
  const out = new Float64Array(frames);
  out.set(src.subarray(0, Math.min(src.length, frames)));
  return out;
}

/** 预期总长度（帧）：干声长度 + 最长 IR - 1 + 预延迟。 */
export function predictLength({ dryFrames, maxIrFrames, predelayFrames }) {
  return Math.max(0, dryFrames) + Math.max(1, maxIrFrames) - 1 + Math.max(0, predelayFrames);
}

export class MatrixConvolver {
  /**
   * @param {object} options
   * @param {Float64Array} options.dryL
   * @param {Float64Array} options.dryR
   * @param {Float64Array[]} options.irs 顺序 ROUTES
   * @param {number} options.predelayFrames 整数帧
   * @param {number} options.wetRatio 0..1
   */
  constructor({ dryL, dryR, irs, predelayFrames, wetRatio }) {
    if (!Array.isArray(irs) || irs.length !== 4) throw new Error('需要四条 IR');
    if (!Number.isInteger(predelayFrames) || predelayFrames < 0) {
      throw new Error('预延迟必须是非负整数帧');
    }
    if (!(wetRatio >= 0 && wetRatio <= 1)) throw new Error('湿声比例必须在 0..1');
    // 双声道长度可能不同（例如只导入一侧）；统一补零到等长，避免越界读到 undefined
    this.dryFrames = Math.max(dryL.length, dryR.length);
    this.dryL = padTo(dryL, this.dryFrames);
    this.dryR = padTo(dryR, this.dryFrames);
    this.irs = irs;
    this.predelayFrames = predelayFrames;
    this.wetRatio = wetRatio;

    this.dryFrames = Math.max(dryL.length, dryR.length);
    this.dryFrames = Math.max(dryL.length, dryR.length);
    this.maxIrFrames = irs.reduce((m, ir) => Math.max(m, ir.length), 0);
    this.totalFrames = predictLength({
      dryFrames: this.dryFrames,
      maxIrFrames: this.maxIrFrames,
      predelayFrames,
    });
    this.wetFrames = Math.max(0, this.totalFrames - predelayFrames);
    this.block = chooseBlockSize(this.maxIrFrames);
    this.fftSize = this.block * 2;
    this.fft = getFFT(this.fftSize);
    this.blockCount = this.wetFrames === 0 ? 0 : Math.ceil(this.wetFrames / this.block);

    // 每条 IR 的频谱只算一次；试听按段渲染时按 params 缓存复用
    this.irSpectra = buildIrSpectra(irs, this.fft, this.fftSize);

    this._windowL = new Float64Array(this.fftSize * 2);
    this._windowR = new Float64Array(this.fftSize * 2);
    this._accL = new Float64Array(this.fftSize * 2);
    this._accR = new Float64Array(this.fftSize * 2);
  }

  /** 写入干声部分：y[t] = (1-w) * dry[t]，覆盖整段固长。 */
  renderDry(outputL, outputR) {
    const gain = 1 - this.wetRatio;
    const n = this.totalFrames;
    for (let t = 0; t < n; t++) {
      const l = t < this.dryL.length ? this.dryL[t] : 0;
      const r = t < this.dryR.length ? this.dryR[t] : 0;
      outputL[t] = gain * l;
      outputR[t] = gain * r;
    }
  }

  /**
   * 处理第 n 个块，输出 wet 帧 [nB, nB+B-1]，并叠加到 t + predelay。
   * 输入窗口为 [nB - (B-1), nB + B)，负下标视为零。
   */
  processBlock(n, outputL, outputR) {
    const { block, fftSize, fft } = this;
    const winL = this._windowL;
    const winR = this._windowR;
    winL.fill(0);
    winR.fill(0);

    const base = n * block;
    const windowStart = base - (block - 1);
    const dryLen = this.dryFrames;
    const copyStart = Math.max(0, windowStart);
    const copyEnd = Math.min(base + fftSize, dryLen);
    if (copyEnd > copyStart) {
      // 窗口缓冲是交错复数数组：实数样点写到 2*帧下标，虚部保持 0
      const destFrame = copyStart - windowStart;
      for (let i = 0, t = copyStart; t < copyEnd; i++, t++) {
        winL[2 * (destFrame + i)] = this.dryL[t];
        winR[2 * (destFrame + i)] = this.dryR[t];
      }
    }
    fft.transform(winL, 0, false);
    fft.transform(winR, 0, false);

    const accL = this._accL;
    const accR = this._accR;
    accL.fill(0);
    accR.fill(0);

    const [ll, lr, rl, rr] = this.irSpectra;
    for (let k = 0; k < fftSize * 2; k += 2) {
      const inLr = winL[k];
      const inLi = winL[k + 1];
      const inRr = winR[k];
      const inRi = winR[k + 1];

      // accL += LL * inL + LR * inR
      const llr = ll[k];
      const lli = ll[k + 1];
      const lrr = lr[k];
      const lri = lr[k + 1];
      accL[k] += inLr * llr - inLi * lli + inRr * lrr - inRi * lri;
      accL[k + 1] += inLr * lli + inLi * llr + inRr * lri + inRi * lrr;

      // accR += RL * inL + RR * inR
      const rlr = rl[k];
      const rli = rl[k + 1];
      const rrr = rr[k];
      const rri = rr[k + 1];
      accR[k] += inLr * rlr - inLi * rli + inRr * rrr - inRi * rri;
      accR[k + 1] += inLr * rli + inLi * rlr + inRr * rri + inRi * rrr;
    }

    fft.transform(accL, 0, true);
    fft.transform(accR, 0, true);

    // overlap-save：有效卷积位于窗口内相对位置 B-1 起，对应湿声帧 [nB, nB+B-1]
    const wetStart = base;
    const wetEnd = Math.min(base + block, this.wetFrames);
    const gain = this.wetRatio;
    const pd = this.predelayFrames;
    const total = this.totalFrames;

    for (let t = wetStart; t < wetEnd; t++) {
      const k = 2 * (t - base + block - 1);
      const outIndex = t + pd;
      if (outIndex < total) {
        outputL[outIndex] += gain * accL[k];
        outputR[outIndex] += gain * accR[k];
      }
    }
  }

  /** 同步计算整段（Node 测试用）。 */
  compute({ onBlock } = {}) {
    const outputL = new Float64Array(this.totalFrames);
    const outputR = new Float64Array(this.totalFrames);
    this.renderDry(outputL, outputR);
    for (let n = 0; n < this.blockCount; n++) {
      this.processBlock(n, outputL, outputR);
      onBlock?.(n + 1, this.blockCount);
    }
    return { left: outputL, right: outputR };
  }
}

/**
 * 便捷入口：一次性计算整段。
 * @param {object} options 同 MatrixConvolver，外加 onProgress(0..1)
 */
export function convolveMatrix(options) {
  const conv = new MatrixConvolver(options);
  const onProgress = options.onProgress;
  const { left, right } = conv.compute({
    onBlock: (done, total) => onProgress?.(total ? done / total : 1),
  });
  onProgress?.(1);
  return {
    left,
    right,
    totalFrames: conv.totalFrames,
    wetFrames: conv.wetFrames,
    dryFrames: conv.dryFrames,
    maxIrFrames: conv.maxIrFrames,
    predelayFrames: conv.predelayFrames,
    block: conv.block,
  };
}

/** 仅统计峰值与超限样本（不限幅）。 */
export function measurePeak(left, right) {
  let peak = 0;
  let overL = 0;
  let overR = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]);
    if (a > peak) peak = a;
    if (a > 1) overL++;
    const b = Math.abs(right[i]);
    if (b > peak) peak = b;
    if (b > 1) overR++;
  }
  return { peak, overL, overR, overCount: overL + overR };
}
