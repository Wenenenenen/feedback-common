// 真峰值（True Peak, dBTP）测量：自行实现的过采样重建。
// 采用带限插值——Hann 窗截断的 sinc 理想重建滤波器，以多项（polyphase）结构
// 做 4 倍过采样。不使用 FFT，也不调用任何现成响度/真峰值库。
// EBU R128 / Tech 3341 要求过采样比不低于 4 倍；默认即 4 倍，
// 另提供 8 倍选项用于交叉验证（结果应基本重合）。

const DEFAULT_TAPS_PER_PHASE = 24;
const HANN_A = 0.5;

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * 构造多项滤波器组（子滤波器长度 tapsPerPhase，须为偶数）。
 * 对输出样本 y[n*F + p]，相位 p 的理想延迟为 (P/2 + p/F)：
 *   h_p[k] = window(k - P/2) * sinc(k - P/2 - p/F)
 * phase 0 的子滤波器脉冲居中在 k=P/2，且各子滤波器分别归一化，
 * 保证所有相位直流增益一致（整体直流增益为 1）。
 */
function buildPolyphase(factor, tapsPerPhase) {
  if (tapsPerPhase % 2 !== 0) throw new Error('tapsPerPhase 须为偶数');
  const half = tapsPerPhase / 2;
  const phases = [];
  for (let p = 0; p < factor; p++) {
    const frac = p / factor;
    const h = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let k = 0; k < tapsPerPhase; k++) {
      const d = k - half; // 相对中心的整数延迟
      const w = HANN_A + 0.5 * Math.cos((Math.PI * d) / half); // Hann 窗，中心为 1
      const v = w * sinc(d - frac);
      h[k] = v;
      sum += v;
    }
    for (let k = 0; k < tapsPerPhase; k++) h[k] /= sum;
    phases.push(h);
  }
  return phases;
}

/**
 * 对单声道做 factor 倍过采样。
 * 边界外样本视为 0（零填充）；输出长度恰为 frames*factor，
 * 原采样点经 phase 0 子滤波器（延迟 half 个输入样本）对齐重建。
 * @returns {Float64Array}
 */
export function upsample(input, factor = 4, tapsPerPhase = DEFAULT_TAPS_PER_PHASE) {
  const frames = input.length;
  const phases = buildPolyphase(factor, tapsPerPhase);
  const half = tapsPerPhase / 2;
  const out = new Float64Array(frames * factor);

  for (let n = 0; n < frames; n++) {
    for (let p = 0; p < factor; p++) {
      const h = phases[p];
      let acc = 0;
      // y[nF+p] = Σ_k h_p[k]·x[n + k - half]
      for (let k = 0; k < tapsPerPhase; k++) {
        const idx = n + k - half;
        if (idx >= 0 && idx < frames) acc += h[k] * input[idx];
      }
      out[n * factor + p] = acc;
    }
  }
  return out;
}

/**
 * 单声道真峰值：返回过采样信号的最大绝对值（线性幅度）。
 */
export function channelTruePeak(input, factor = 4, tapsPerPhase = DEFAULT_TAPS_PER_PHASE) {
  const up = upsample(input, factor, tapsPerPhase);
  let peak = 0;
  for (let i = 0; i < up.length; i++) {
    const a = Math.abs(up[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * 逐声道真峰值（dBTP）。全静音返回 null。
 * @returns {{ peaksLinear: number[], dbtp: (number|null)[] }}
 */
export function truePeak(planar, factor = 4, tapsPerPhase = DEFAULT_TAPS_PER_PHASE) {
  const peaksLinear = planar.map((ch) => channelTruePeak(ch, factor, tapsPerPhase));
  const dbtp = peaksLinear.map((p) => (p === 0 ? null : 20 * Math.log10(p)));
  return { peaksLinear, dbtp };
}
