// 独立的暴力参考实现（不依赖 src/js 的任何代码），用于逐样点核对。
// 只用标准库，按包内定义直接计算：直接求和卷积、直接求最大值。

/* 解析指数扫频（用于构造已知答案） */
export function analyticSweep({ f0, f1, frames, sr = 48000, amp = 1 }) {
  const T = frames / sr;
  const L = Math.log(f1 / f0);
  const x = new Float64Array(frames);
  for (let n = 0; n < frames; n++) {
    const t = n / sr;
    const ph = 2 * Math.PI * f0 * T / L * (Math.exp(L * t / T) - 1);
    x[n] = amp * Math.sin(ph);
  }
  return x;
}

export function inverseSweepRef(sweep, f0, f1) {
  const N = sweep.length;
  const L = Math.log(f1 / f0);
  const g = new Float64Array(N);
  for (let j = 0; j < N; j++) g[j] = sweep[N - 1 - j] * Math.exp(-j * L / N);
  return g;
}

/* D = (x*g)[N-1]，直接卷积的单个系数 */
export function calibratorRef(sweep, f0, f1) {
  const N = sweep.length;
  const L = Math.log(f1 / f0);
  let D = 0;
  for (let k = 0; k < N; k++) D += sweep[k] * sweep[N - 1 - (N - 1 - k)] * Math.exp(-(N - 1 - k) * L / N);
  return D;
}

/* 暴力线性卷积（O(MN)，仅用于小规模测试） */
export function convolveRef(y, g) {
  const out = new Float64Array(y.length + g.length - 1);
  for (let i = 0; i < y.length; i++) {
    const yi = y[i];
    if (yi === 0) continue;
    for (let j = 0; j < g.length; j++) out[i + j] += yi * g[j];
  }
  return out;
}

/* 指定输出区间的卷积系数（直接求和） */
export function convAt(y, g, idx) {
  const lo = Math.max(0, idx - (g.length - 1));
  const hi = Math.min(y.length - 1, idx);
  let s = 0;
  for (let k = lo; k <= hi; k++) s += y[k] * g[idx - k];
  return s;
}

/* 完整参考分析：返回零点、窗口、能量
 *
 * 只在需要的那几段做直接求和卷积（搜索区间 + 各窗），否则 O(MN) 会慢得不实用。
 * 返回的 c 只在这些段内有值，其余为 0——引用者只能访问这些段。
 */
export function analyzeRef(y, sweep, params) {
  const N = sweep.length;
  const { f0, f1, lo, hi, pre, post } = params;
  const L = Math.log(f1 / f0);
  const g = inverseSweepRef(sweep, f0, f1);
  const D = calibratorRef(sweep, f0, f1);
  if (D === 0) throw new Error('D = 0');
  const M = y.length;
  const dataLen = M + N - 1;
  const c = new Float64Array(dataLen);
  const fill = (a, b) => {
    const s = Math.max(0, a);
    const e = Math.min(dataLen - 1, b);
    for (let i = s; i <= e; i++) c[i] = convAt(y, g, i) / D;
  };
  // 先在搜索区间找零点
  fill(N - 1 + lo, N - 1 + hi);
  let zero = N - 1 + lo;
  let best = Math.abs(c[zero]);
  for (let n = N - 1 + lo + 1; n <= N - 1 + hi; n++) {
    const a = Math.abs(c[n]);
    if (a > best) { best = a; zero = n; }
  }
  const windows = [];
  for (let q = 1; q <= 4; q++) {
    const shift = Math.floor(N * Math.log(q) / L + 0.5);
    const center = zero - shift;
    const start = center - pre;
    const end = center + post;
    fill(start, end - 1);
    let energy = 0;
    let peak = 0;
    let peakIndex = -1;
    for (let i = start; i < end; i++) {
      const v = (i >= 0 && i < dataLen) ? c[i] : 0;
      energy += v * v;
      if (Math.abs(v) > Math.abs(peak)) { peak = v; peakIndex = i; }
    }
    windows.push({ q, shift, center, start, end, energy, peak, peakIndex, zeroFilled: (start < 0 ? -start : 0) + (end > dataLen ? end - dataLen : 0) });
  }
  const conflicts = [];
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const A = windows[a], B = windows[b];
    if (A.start < B.end && B.start < A.end) conflicts.push([A.q, B.q]);
  }
  return { D, c, zero, zeroRel: zero - (N - 1), windows, conflicts, dataLen };
}
