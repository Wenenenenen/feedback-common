/*
 * 按帧范围渲染输出（试听 / 分段取回用）。
 *
 * 与 MatrixConvolver 使用同一套 overlap-save 规则，但只计算 [start, end)
 * 相交的湿声块，因此超长输出也能按需取片段。干声按输出下标直接叠加。
 *
 * 这里不做归一化，也不限幅。
 */

/**
 * @param {object} p
 * @param {Float64Array} p.dryL
 * @param {Float64Array} p.dryR
 * @param {Float64Array[]} p.irSpectra 顺序 LL/LR/RL/RR，已按 p.fftSize FFT
 * @param {number} p.fftSize
 * @param {number} p.block
 * @param {number} p.totalFrames
 * @param {number} p.wetRatio
 * @param {number} p.predelayFrames
 * @param {number} p.start 输出起始帧（含）
 * @param {number} p.end 输出结束帧（不含）
 * @param {object} p.fft FFT 实例
 */
export function renderRange({
  dryL,
  dryR,
  irSpectra,
  fftSize,
  block,
  totalFrames,
  wetRatio,
  predelayFrames,
  start,
  end,
  fft,
  onBlockDone,
}) {
  const len = Math.max(0, end - start);
  const outL = new Float64Array(len);
  const outR = new Float64Array(len);
  if (len === 0) return { outL, outR };

  const dryGain = 1 - wetRatio;
  const wetFrames = Math.max(0, totalFrames - predelayFrames);
  const pd = predelayFrames;

  // 干声：输出 t 使用 dry[t]（超出干声长度为零；两侧长度可能不同）
  const dryLen = Math.max(dryL.length, dryR.length);
  for (let t = start; t < end; t++) {
    const i = t - start;
    outL[i] = dryGain * (t < dryL.length ? dryL[t] : 0);
    outR[i] = dryGain * (t < dryR.length ? dryR[t] : 0);
  }

  if (wetFrames <= 0) return { outL, outR };

  // 输出 t 的湿声来自 wet[t - pd]
  const firstWet = Math.max(0, start - pd);
  const lastWet = Math.min(wetFrames - 1, end - 1 - pd);
  if (lastWet < firstWet) return { outL, outR };

  const firstBlock = Math.floor(firstWet / block);
  const lastBlock = Math.min(Math.ceil((lastWet + 1) / block) - 1, Math.ceil(wetFrames / block) - 1);

  const winL = new Float64Array(fftSize * 2);
  const winR = new Float64Array(fftSize * 2);
  const accL = new Float64Array(fftSize * 2);
  const accR = new Float64Array(fftSize * 2);
  const [ll, lr, rl, rr] = irSpectra;

  for (let n = firstBlock; n <= lastBlock; n++) {
    const base = n * block;
    const windowStart = base - (block - 1);
    winL.fill(0);
    winR.fill(0);

    const copyStart = Math.max(0, windowStart);
    const copyEnd = Math.min(base + fftSize, dryLen);
    if (copyEnd > copyStart) {
      const destFrame = copyStart - windowStart;
      for (let i = 0, t = copyStart; t < copyEnd; i++, t++) {
        const k = 2 * (destFrame + i);
        winL[k] = t < dryL.length ? dryL[t] : 0;
        winR[k] = t < dryR.length ? dryR[t] : 0;
      }
    }
    fft.transform(winL, 0, false);
    fft.transform(winR, 0, false);
    accL.fill(0);
    accR.fill(0);

    for (let k = 0; k < fftSize * 2; k += 2) {
      const inLr = winL[k];
      const inLi = winL[k + 1];
      const inRr = winR[k];
      const inRi = winR[k + 1];
      accL[k] += inLr * ll[k] - inLi * ll[k + 1] + inRr * lr[k] - inRi * lr[k + 1];
      accL[k + 1] += inLr * ll[k + 1] + inLi * ll[k] + inRr * lr[k + 1] + inRi * lr[k];
      accR[k] += inLr * rl[k] - inLi * rl[k + 1] + inRr * rr[k] - inRi * rr[k + 1];
      accR[k + 1] += inLr * rl[k + 1] + inLi * rl[k] + inRr * rr[k + 1] + inRi * rr[k];
    }
    fft.transform(accL, 0, true);
    fft.transform(accR, 0, true);

    const wetFrom = Math.max(base, firstWet);
    const wetTo = Math.min(base + block - 1, lastWet);
    for (let t = wetFrom; t <= wetTo; t++) {
      const k = 2 * (t - base + block - 1);
      outL[t + pd - start] += wetRatio * accL[k];
      outR[t + pd - start] += wetRatio * accR[k];
    }
    onBlockDone?.(n);
  }

  return { outL, outR };
}
