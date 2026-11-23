/*
 * Solve-and-report pipeline shared by the Web Worker and the main-thread
 * fallback. Requires AICore in the global scope.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function core() {
    if (root.AICore) return root.AICore;
    if (typeof require === 'function') {
      try { return require('./core.js'); } catch { /* fall through */ }
    }
    throw new Error('求解核心未加载');
  }

  async function runSolve(cfg, opts = {}) {
    const C = core();
    const res = await C.solveAll(cfg, {
      onEvent: opts.onEvent,
      shouldAbort: opts.shouldAbort,
      channelOpts: opts.channelOpts,
    });
    if (res.aborted) return { aborted: true };

    const exportObj = C.makeExport(cfg, res);
    // Round-trip through JSON exactly as the downloaded file would be read
    // back, then certify the projected gradient from the decoded taps.
    const jsonText = JSON.stringify(exportObj);
    const decoded = JSON.parse(jsonText);
    const cert = C.certifyExport(cfg, decoded);

    const { M, P, Q, taps } = cfg;
    const N = res.geometry.N;
    const series = [];
    const perMeasurement = [];
    for (let q = 0; q < Q; q++) {
      const pred = res.predictions[q];
      const tgt = res.targets[q];
      const resid = res.residuals[q];
      const perM = [];
      for (let m = 0; m < M; m++) {
        let sse = 0, peak = 0;
        const r = resid[m];
        for (let n = 0; n < N; n++) {
          const v = r[n];
          sse += v * v;
          const av = v < 0 ? -v : v;
          if (av > peak) peak = av;
        }
        perM.push({
          m,
          target: tgt[m],
          prediction: pred[m],
          residual: r,
          sse,
          weightedSse: cfg.weights[m] * sse,
          rms: Math.sqrt(sse / Math.max(1, N)),
          peak,
        });
      }
      perMeasurement.push(perM);
      series.push({
        q,
        target: tgt,
        prediction: pred,
        residual: resid,
      });
    }

    const payload = {
      aborted: false,
      M, P, Q, taps,
      delay: cfg.delay,
      lambda: cfg.lambda,
      weights: Array.from(cfg.weights),
      limits: Array.from(cfg.limits),
      objective: res.objective,
      objectiveResidual: res.objectiveResidual,
      tapSum: res.tapSum,
      projectedResidual: res.projectedResidual,
      iterations: res.iterations,
      outer: res.outer,
      elapsed: res.elapsed,
      geometry: {
        N: res.geometry.N, L: res.geometry.L, maxH: res.geometry.maxH,
        maxConv: res.geometry.maxConv, maxT: res.geometry.maxT,
      },
      perChannel: res.perChannel,
      filters: res.filters,
      predictions: res.predictions,
      targets: res.targets,
      residuals: res.residuals,
      series,
      perMeasurement,
      certification: {
        withinTolerance: cert.withinTolerance,
        projectedResidual: cert.projectedResidual,
        perChannelPg: cert.perChannelPg,
        maxOverrun: cert.maxOverrun,
        tapsChecked: P * Q * taps,
      },
      exportText: jsonText,
      exportBytes: jsonText.length,
    };
    return payload;
  }

  // Collect transferable ArrayBuffers from a payload.
  function transferables(payload) {
    const list = [];
    const push = (a) => {
      if (a && a.buffer && !list.includes(a.buffer)) list.push(a.buffer);
    };
    for (const f of payload.filters) push(f);
    for (const q of payload.series) {
      for (const m of q.target) push(m);
      for (const m of q.prediction) push(m);
      for (const m of q.residual) push(m);
    }
    return list;
  }

  return { runSolve, transferables };
});
