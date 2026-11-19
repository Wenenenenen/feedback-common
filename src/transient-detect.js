// transient-detect.js — 瞬态（敲击）检测，无依赖
// 思路：短时能量包络 -> 正向通量（能量上升沿）-> 自适应局部阈值 + 噪声门
// -> 局部峰选取（每簇只留一个）-> 不应期 -> 样本级能量起点精修。

export async function detectTransients(mono, sampleRate, onProgress = null, yieldHook = null) {
  const N = mono.length;
  const half = Math.max(64, Math.round(sampleRate * 0.005)); // 5ms 半窗
  const hop = Math.max(32, Math.round(sampleRate * 0.0025)); // 2.5ms 跳幅

  // ---- 1. 短时能量包络 ----
  const nb = 1 + Math.floor((N - 1) / hop);
  const env = new Float64Array(nb);
  for (let k = 0; k < nb; k++) {
    const c = k * hop;
    const lo = Math.max(0, c - half);
    const hi = Math.min(N, c + half);
    let s = 0;
    for (let i = lo; i < hi; i++) s += mono[i] * mono[i];
    env[k] = s / (hi - lo);
    if (onProgress && (k & 255) === 0) onProgress(0.2 * k / nb);
    if (yieldHook && (k & 1023) === 0) await yieldHook();
  }

  // ---- 2. 正向通量 ----
  const flux = new Float64Array(nb);
  for (let k = 1; k < nb; k++) flux[k] = Math.max(0, env[k] - env[k - 1]);

  // 噪声门：取全片能量的低分位作为底噪，门限设其上方，避免静音区误触发
  const envSorted = Float64Array.from(env).sort();
  const noiseFloor = envSorted[Math.floor(nb * 0.25)] + 1e-12;
  const gate = noiseFloor * 8 + 1e-10;

  // ---- 3. 自适应局部阈值，得到显著通量样本（暂不做局部峰约束）----
  const medianWin = Math.max(8, Math.round(0.2 / 0.0025)); // 200ms
  const refracBins = Math.max(1, Math.round(0.03 / 0.0025)); // 30ms 不应期
  const hot = new Uint8Array(nb);
  const buf = [];
  for (let k = 1; k < nb - 1; k++) {
    const lo = Math.max(0, k - medianWin);
    const hi = Math.min(nb, k + medianWin + 1);
    buf.length = 0;
    for (let j = lo; j < hi; j++) buf.push(flux[j]);
    buf.sort((a, b2) => a - b2);
    const med = buf[buf.length >> 1];
    const thr = med * 2.0 + 1e-12;
    if (flux[k] > thr && env[k] > gate) hot[k] = 1;
    if (onProgress && (k & 255) === 0) onProgress(0.2 + 0.3 * k / nb);
    if (yieldHook && (k & 1023) === 0) await yieldHook();
  }

  // ---- 4. 非极大值抑制：把连续显著区聚成簇，每簇取通量最大的 bin；
  //        再用不应期去重。多击鼓点会形成宽通量平台，取簇内主峰即起振点 ----
  const picked = [];
  let k = 1;
  while (k < nb - 1) {
    if (!hot[k]) { k++; continue; }
    // 扩展当前连续簇（允许中间 1 个 bin 的小断裂）
    let clusterEnd = k;
    while (clusterEnd + 1 < nb - 1 && (hot[clusterEnd + 1] ||
      (clusterEnd + 2 < nb - 1 && hot[clusterEnd + 2]))) {
      clusterEnd++;
    }
    // 簇内取通量最大者：对瞬态（click）这就是起振峰；
    // 缓升鼓点若峰稍后移，再由样本级精修回溯到坡脚
    const bestK = (() => {
      let bk = k;
      for (let j = k + 1; j <= clusterEnd; j++) if (flux[j] > flux[bk]) bk = j;
      return bk;
    })();
    if (!picked.length || bestK - picked[picked.length - 1] >= refracBins) {
      picked.push(bestK);
    } else if (flux[bestK] > flux[picked[picked.length - 1]]) {
      picked[picked.length - 1] = bestK;
    }
    k = clusterEnd + 1;
  }

  // ---- 5. 样本级精修：从通量峰向前回溯到真正的起振起点。
  // 鼓点起振后能量会持续上升数百样本，"最大能量"落在起振之后；
  // ---- 5. 样本级精修：在通量峰附近定位起振沿的【第一个显著样本】。
  // 能量包络窗会让通量峰位置相对真实起振偏移；无论瞬跳 click 还是缓升鼓点，
  // 起振点都是能量首次越过"前导本底 + 起振后短窗能量的一定比例"的样本，
  // 取第一个越界点可避免误选到起振之后更强的后续击打。
  const refineHalf = Math.round(sampleRate * 0.012);
  const riseWin = Math.max(8, Math.round(sampleRate * 0.002)); // 2ms
  const out = [];
  for (let i = 0; i < picked.length; i++) {
    const center = picked[i] * hop;
    const lo = Math.max(1, center - refineHalf);
    const hi = Math.min(N - 1, center + refineHalf);
    // 前导本底
    let base = 0, bn = 0;
    for (let j = Math.max(0, lo - refineHalf); j < lo; j++) { base += mono[j] * mono[j]; bn++; }
    base = bn ? base / bn : 0;
    // 起振后短窗能量，反映本次起振的量级
    let riseE = 0, rn = 0;
    for (let j = center; j < Math.min(hi, center + riseWin); j++) { riseE += mono[j] * mono[j]; rn++; }
    riseE = rn ? riseE / rn : 0;
    const thr = base + riseE * 0.25 + 1e-12;
    // 从窗口左沿扫描，取第一个稳定越过门限的样本
    let p = center;
    let run = 0;
    for (let j = lo; j <= hi; j++) {
      if (mono[j] * mono[j] >= thr) {
        if (++run >= 2) { p = j - 1; break; }
      } else run = 0;
    }
    // 与已输出锚点保持最小 10ms 间隔
    if (!out.length || p - out[out.length - 1] >= Math.round(sampleRate * 0.01)) out.push(p);
    if (onProgress && (i & 63) === 0) onProgress(0.5 + 0.25 * i / picked.length);
  }
  return out;
}
