// 滤波器设计：Kaiser 窗加窗 sinc 原型低通 + 零群延迟多相分支。
// 约定（见样例包 格式说明.md）：
//   输出第 m 个样本对应时刻 m/fo，取输入在 m·fi/fo 处的带限重建值；
//   不引入整体滤波器延迟，输入两端之外按 0 处理。

import { nextPow2, fft } from './fft.js';

export function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 把 fo/fi 约分为 L/M（输出 L 个样本对应输入 M 个样本）。 */
export function reduceRatio(fi, fo) {
  const g = gcd(fi, fo);
  return { L: fo / g, M: fi / g };
}

/** 第一类零阶修正贝塞尔函数（级数展开）。 */
function i0(x) {
  const t = x / 2;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 40; k++) {
    term *= (t / k) ** 2;
    sum += term;
    if (term < 1e-16 * sum) break;
  }
  return sum;
}

/** 由阻带衰减 A(dB) 求 Kaiser 参数 β。 */
export function kaiserBeta(attenDb) {
  const A = attenDb;
  if (A > 50) return 0.1102 * (A - 8.7);
  if (A >= 21) return 0.5842 * (A - 21) ** 0.4 + 0.07886 * (A - 21);
  return 0;
}

/** Kaiser 公式预测给定参数下实际可达阻带衰减(dB)。 */
export function predictedAttenuation(P, transitionNormalized) {
  // transitionNormalized：过渡带宽度相对高采样率 fsH 的归一化频率（cycles/sample）
  const K = P; // 每分支抽头数，原型长度 K_total = P·L；Δω = 2π·Δf/fsH
  const dw = 2 * Math.PI * transitionNormalized;
  return 2.285 * dw * K + 7.85;
}

/**
 * 设计有理比 L/M 重采样器。
 * @param fi 输入采样率
 * @param fo 输出采样率
 * @param opts { tapsPerBranch:P, attenDb, cutoffRatio }
 *   cutoffRatio：通带边沿占 min(fi,fo)/2 的比例（默认 0.95）
 * @returns 多相分支系数 coefs[k]，长度均为 P；以及设计参数
 */
export function designResampler(fi, fo, opts = {}) {
  const P = opts.tapsPerBranch ?? 208;
  const attenDb = opts.attenDb ?? 80;
  const cutoffRatio = opts.cutoffRatio ?? 0.95;
  if (!(P >= 8 && P % 2 === 0)) {
    throw new Error('每分支抽头数必须是不小于 8 的偶数');
  }
  const { L, M } = reduceRatio(fi, fo);
  const fsLow = Math.min(fi, fo);
  // 原型滤波器位于 LCM 等效采样率：L·fi = M·fo
  const fsHigh = L * fi;
  const passHz = cutoffRatio * (fsLow / 2);
  const stopHz = fsLow / 2;
  const transitionHz = stopHz - passHz;
  // 原型归一化截止角频率（相对 fsHigh）
  const wc = (2 * Math.PI * passHz) / fsHigh;
  const beta = kaiserBeta(attenDb);
  // 窗支撑半径（LCM 域样本单位）：分支抽头 d = L·q - k，q∈[-P/2, P/2)
  const D = (P * L) / 2;
  const i0b = i0(beta);

  // 零延迟多相分支（L 个分支，k=0..L-1）：
  //   输出 m 对应输入域位置 x_m = m·M/L = i + k/L
  //   i = floor(x_m)，k = m·M - i·L
  // 分支 k 的抽头 qi 对应输入偏移 q = qi - P/2；
  // 重建 sinc 的自变量为 (q - k/L)，对应原型（LCM 域）偏移 d = L·q - k。
  const coefs = new Array(L);
  for (let k = 0; k < L; k++) {
    const c = new Float64Array(P);
    for (let qi = 0; qi < P; qi++) {
      const q = qi - P / 2;
      const d = L * q - k;
      let w = 0;
      const ad = Math.abs(d);
      if (ad <= D) {
        w = i0(beta * Math.sqrt(Math.max(0, 1 - (d / D) ** 2))) / i0b;
      }
      const h = d === 0 ? wc / Math.PI : Math.sin(wc * d) / (Math.PI * d);
      c[qi] = h * w;
    }
    coefs[k] = c;
  }

  // 归一化：k=0 分支直流增益为 1（保证 0 Hz 幅度严格为 1）
  let gain0 = 0;
  for (let qi = 0; qi < P; qi++) gain0 += coefs[0][qi];
  for (let k = 0; k < L; k++) {
    for (let qi = 0; qi < P; qi++) coefs[k][qi] /= gain0;
  }

  const achieved = predictedAttenuation(P, transitionHz / fsHigh);

  return {
    fi, fo, L, M, P, attenDb, cutoffRatio, beta,
    fsLow, fsHigh, passHz, stopHz, transitionHz,
    coefs, D, achievedAttenDb: achieved,
    prototypeLength: P * L,
  }
}

/**
 * 原型低通频率响应（幅度 dB），用于页面展示与通带/阻带测量。
 * 频率轴同时给出 Hz（相对低采样率域）与归一化频率。
 */
export function prototypeResponse(design, fftSize) {
  const { P, L, M, coefs, fsHigh, fsLow } = design;
  const K = P * L;
  fftSize = fftSize || nextPow2(K * 2);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  // 由分支系数重建居中的原型 h(d)，再移位成因果序列做 FFT
  const center = (K - 1) / 2;
  for (let k = 0; k < L; k++) {
    for (let qi = 0; qi < P; qi++) {
      const q = qi - P / 2;
      const d = L * q - k;
      if (Math.abs(d) > center) continue;
      const n = Math.round(d + center);
      if (n >= 0 && n < K) re[n] = coefs[k][qi];
    }
  }
  fft(re, im, false);
  const bins = fftSize >> 1;
  const magDb = new Float64Array(bins + 1);
  const freqsHigh = new Float64Array(bins + 1); // Hz，fsHigh 域
  const freqsLow = new Float64Array(bins + 1);  // 折算到低采样率域
  let dc = Math.hypot(re[0], im[0]);
  if (dc === 0) dc = 1;
  for (let i = 0; i <= bins; i++) {
    // FFT 作用在 fsHigh 原型域；物理频率与采样率无关，直接由 fsHigh 换算
    freqsHigh[i] = (i * fsHigh) / fftSize;
    freqsLow[i] = freqsHigh[i];
    magDb[i] = 20 * Math.log10(Math.max(Math.hypot(re[i], im[i]) / dc, 1e-12));
  }
  return { magDb, freqsHigh, freqsLow, fftSize, fsHigh, fsLow };
}
