// 交付增益决策。
// 只允许整轨共用一个固定增益（所有声道、所有样本同倍数），
// 禁止动态处理、独立声道增益。峰值与目标冲突时优先保证真峰值不越上限，
// 并报告离响度目标还差多少。无法测得整轨 I 时禁止交付。

/**
 * @param {object} measurement analyze() 的结果
 * @param {number} targetLufs 目标响度（LUFS）
 * @param {number} ceilingDbtp 真峰值上限（dBTP）
 */
export function planGain(measurement, targetLufs, ceilingDbtp) {
  const iLufs = measurement.integratedLufs;
  if (iLufs === null || iLufs === undefined) {
    return {
      canDeliver: false,
      reason: '无法测得整轨 I（纯静音或无完整门限块），禁止交付',
      gainDb: null,
      gainLinear: null,
      peakConstrained: false,
      targetGapLu: null,
      predictedIntegratedLufs: null,
      predictedMaxTruePeakDbtp: null,
    };
  }

  // 响度目标所需增益
  const loudnessGainDb = targetLufs - iLufs;

  // 峰值约束允许的最大增益（取所有声道中最高真峰值）
  const tpValues = measurement.perChannel
    .map((c) => c.truePeakDbtp)
    .filter((v) => v !== null && v !== undefined);
  if (tpValues.length === 0) {
    return {
      canDeliver: false,
      reason: '无法测得真峰值（纯静音），禁止交付',
      gainDb: null,
      gainLinear: null,
      peakConstrained: false,
      targetGapLu: null,
      predictedIntegratedLufs: null,
      predictedMaxTruePeakDbtp: null,
    };
  }
  const maxTp = Math.max(...tpValues);
  const peakGainDb = ceilingDbtp - maxTp;

  const peakConstrained = peakGainDb < loudnessGainDb;
  const gainDb = peakConstrained ? peakGainDb : loudnessGainDb;
  const gainLinear = Math.pow(10, gainDb / 20);

  const predictedIntegratedLufs = iLufs + gainDb;
  const predictedMaxTruePeakDbtp = maxTp + gainDb;
  // 受峰值约束时，交付响度与目标的缺口（正数表示还差多少 LU 才到目标）
  const targetGapLu = peakConstrained ? targetLufs - predictedIntegratedLufs : 0;

  return {
    canDeliver: true,
    reason: peakConstrained
      ? `峰值约束优先：达到上限 ${ceilingDbtp} dBTP 后，响度仍距目标 ${targetGapLu.toFixed(2)} LU`
      : '按响度目标施加固定增益，真峰值未越上限',
    gainDb,
    gainLinear,
    peakConstrained,
    targetGapLu,
    predictedIntegratedLufs,
    predictedMaxTruePeakDbtp,
  };
}

/**
 * 施加整轨固定增益（不做限幅、不动静音、不改帧数/声道/采样率）。
 * @returns {Float32Array[]} 新的 planar 数组
 */
export function applyGain(planar, gainLinear) {
  return planar.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let n = 0; n < ch.length; n++) out[n] = ch[n] * gainLinear;
    return out;
  });
}
