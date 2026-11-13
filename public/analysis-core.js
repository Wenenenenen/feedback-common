/* analysis-core.js — 漂移估计核心：由参考轨与待校准轨的单声道 PCM 估计
 *   t_ref = a · t_track + b
 * 两阶段：200Hz 起音包络分块全局相关 + RANSAC 粗拟合 → 1kHz 包络局部精化 + 鲁棒重拟合。
 * 静音/掉音段包络为零自动被跳过；重复片段造成的错误峰由 RANSAC 剔除。
 * 双模式：Worker（全局 ANALYSIS，依赖全局 DSP）与 Node（module.exports）。 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./dsp.js'));
  } else {
    global.ANALYSIS = factory(global.DSP);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (DSP) {
  'use strict';

  const AN_RATE = 8000;   // 分析重采样率
  const ENV_HI = 1000;    // 精化包络率（1ms 分辨率）
  const ENV_LO = 200;     // 粗匹配包络率
  const MIN_COMMON_SEC = 10; // 共同片段不足 10 秒 → 证据不足

  /* 阶段 1：假设 a≈1，分块全局相关，RANSAC 同时解出粗 a、b。 */
  function stage1(refEnv, trkEnv, refDur, trkDur) {
    const chunkLen = 6 * ENV_LO; // 6 秒块
    const hop = 3 * ENV_LO;      // 3 秒步进
    if (trkEnv.length < chunkLen || refEnv.length < chunkLen) return null;
    const refCS = DSP.sqCumsum(refEnv);
    const pts = { x: [], y: [], s: [] };
    for (let cs = 0; cs + chunkLen <= trkEnv.length; cs += hop) {
      const chunk = trkEnv.subarray(cs, cs + chunkLen);
      const cn = DSP.normOf(chunk);
      if (cn < 1e-6) continue; // 静音块
      const corr = DSP.correlateValid(refEnv, chunk);
      if (!corr) continue;
      let bestLag = -1, bestScore = 0;
      for (let lag = 0; lag < corr.length; lag++) {
        const refNorm = Math.sqrt(Math.max(0, refCS[lag + chunkLen] - refCS[lag]));
        const score = corr[lag] / (cn * refNorm + 1e-12);
        if (score > bestScore) { bestScore = score; bestLag = lag; }
      }
      if (bestLag >= 0 && bestScore > 0.3) {
        pts.x.push((cs + chunkLen / 2) / ENV_LO);
        pts.y.push((bestLag + chunkLen / 2) / ENV_LO);
        pts.s.push(bestScore);
      }
    }
    if (pts.x.length < 3) return null;
    return DSP.ransacLine(pts.x, pts.y, 0.05, 3, 400);
  }

  /* 阶段 2：以粗映射为预测，1kHz 包络 ±150ms 局部相关，抛物线插值到亚毫秒。 */
  function stage2(refEnv, trkEnv, a1, b1, trkDur) {
    const win = 3 * ENV_HI;    // 3 秒窗
    const hop = 2 * ENV_HI;    // 2 秒步进
    const search = 150;        // ±150ms
    const refCS = DSP.sqCumsum(refEnv);
    // 全局范数用于静音门限
    const globalNorm = DSP.normOf(trkEnv) / Math.sqrt(Math.max(1, trkEnv.length / win));
    const pts = { x: [], y: [], s: [] };
    for (let tt = 1.0; tt + 3.0 <= trkDur + 1e-6; tt += 2.0) {
      const cs = Math.round(tt * ENV_HI);
      if (cs + win > trkEnv.length) break;
      const chunk = trkEnv.subarray(cs, cs + win);
      const cn = DSP.normOf(chunk);
      if (cn < 0.02 * globalNorm || cn < 1e-7) continue; // 静音/掉音
      const pred = a1 * tt + b1; // 预测的参考起点（秒）
      const center = Math.round(pred * ENV_HI);
      let bestLag = 0, bestScore = -1;
      const scores = [];
      const lags = [];
      for (let lag = center - search; lag <= center + search; lag++) {
        if (lag < 0 || lag + win > refEnv.length) continue;
        let dot = 0;
        for (let i = 0; i < win; i++) dot += refEnv[lag + i] * chunk[i];
        const refNorm = Math.sqrt(Math.max(0, refCS[lag + win] - refCS[lag]));
        const score = dot / (cn * refNorm + 1e-12);
        lags.push(lag); scores.push(score);
        if (score > bestScore) { bestScore = score; bestLag = lag; }
      }
      if (bestScore < 0.35) continue;
      // 抛物线亚采样插值
      const bi = lags.indexOf(bestLag);
      let delta = 0;
      if (bi > 0 && bi < lags.length - 1) {
        delta = DSP.parabolic(scores[bi - 1], scores[bi], scores[bi + 1]);
      }
      pts.x.push(tt + 1.5);
      pts.y.push((bestLag + delta) / ENV_HI + 1.5);
      pts.s.push(bestScore);
    }
    return pts;
  }

  /* 主入口。返回 {ok:true, a,b,anchors,coverageSec,rmsMs,meanScore} 或 {ok:false, reason} */
  function analyze(refMono, refRate, trkMono, trkRate, progress) {
    progress = progress || function () {};
    const refDur = refMono.length / refRate;
    const trkDur = trkMono.length / trkRate;
    progress(0.05);
    const ref8 = DSP.resampleLinear(refMono, refRate, AN_RATE);
    const trk8 = DSP.resampleLinear(trkMono, trkRate, AN_RATE);
    progress(0.2);
    const refEnvHi = DSP.onsetEnvelope(ref8, AN_RATE, ENV_HI);
    const trkEnvHi = DSP.onsetEnvelope(trk8, AN_RATE, ENV_HI);
    const refEnvLo = DSP.decimate(refEnvHi, ENV_HI / ENV_LO);
    const trkEnvLo = DSP.decimate(trkEnvHi, ENV_HI / ENV_LO);
    progress(0.35);

    const s1 = stage1(refEnvLo, trkEnvLo, refDur, trkDur);
    progress(0.6);
    if (!s1) {
      return { ok: false, reason: '未找到一致的时间对应关系：可能是无关录音，或共同内容太少。' };
    }
    if (Math.abs(s1.a - 1) > 0.05) {
      return { ok: false, reason: '粗估计的漂移异常（|a−1| > 5%），判定为证据不足。' };
    }

    const pts = stage2(refEnvHi, trkEnvHi, s1.a, s1.b, trkDur);
    progress(0.85);
    if (pts.x.length < 5) {
      return { ok: false, reason: '有效对应点不足（静音/掉音过多或共同内容太少），证据不足。' };
    }
    const fit = DSP.ransacLine(pts.x, pts.y, 0.012, 5, 600);
    if (!fit) {
      return { ok: false, reason: '对应点无法拟合出一致的线性映射，证据不足。' };
    }
    if (Math.abs(fit.a - 1) > 0.05) {
      return { ok: false, reason: '估计的漂移异常（|a−1| > 5%），判定为证据不足。' };
    }
    // 共同覆盖时长：内点锚窗（各 3 秒）的并集
    const iv = fit.inliers.map(i => [pts.x[i] - 1.5, pts.x[i] + 1.5]).sort((p, q) => p[0] - q[0]);
    let coverage = 0, curS = -1e9, curE = -1e9;
    for (const [s, e] of iv) {
      if (s > curE) { coverage += curE - curS; curS = s; curE = e; }
      else if (e > curE) curE = e;
    }
    coverage += curE - curS;
    let meanScore = 0;
    const anchors = fit.inliers.map(i => {
      meanScore += pts.s[i];
      return { tTrack: pts.x[i], tRef: pts.y[i], score: pts.s[i] };
    });
    meanScore /= fit.inliers.length;
    if (coverage < MIN_COMMON_SEC) {
      return {
        ok: false,
        reason: '共同片段约 ' + coverage.toFixed(1) + ' 秒，不足 ' + MIN_COMMON_SEC + ' 秒，证据不足。',
        coverageSec: coverage,
      };
    }
    if (meanScore < 0.45) {
      return { ok: false, reason: '相关强度过低（均值 ' + meanScore.toFixed(2) + '），判定为证据不足。' };
    }
    progress(1);
    return {
      ok: true,
      a: fit.a,
      b: fit.b,
      anchors,
      coverageSec: coverage,
      rmsMs: fit.rms * 1000,
      meanScore,
    };
  }

  return { analyze, MIN_COMMON_SEC };
});
