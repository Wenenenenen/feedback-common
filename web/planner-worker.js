// Planner worker: validates input JSON and runs subset DP off the UI thread.
'use strict';
importScripts('headroom.js');

self.onmessage = (ev) => {
  const { plan, reqId } = ev.data;
  const errs = self.HEADROOM.validatePlan(plan);
  if (errs.length) {
    self.postMessage({ reqId, ok: false, errors: errs });
    return;
  }
  const t0 = (self.performance || Date).now();
  let sol;
  try {
    sol = self.HEADROOM.solvePlan(plan.sections, plan.bands);
  } catch (e) {
    self.postMessage({ reqId, ok: false, errors: [String(e && e.message || e)] });
    return;
  }
  const ms = Math.round(((self.performance || Date).now() - t0) * 10) / 10;
  if (!sol) {
    self.postMessage({ reqId, ok: true, noSolution: true, ms });
    return;
  }
  // transfer TypedArrays as plain arrays for structured clone simplicity
  self.postMessage({
    reqId,
    ok: true,
    ms,
    solution: {
      order: sol.order,
      total: sol.total,
      prefixSum: sol.prefixSum,
      bookByStage: sol.bookByStage.map((a) => Array.from(a)),
      marginByStage: sol.marginByStage.map((a) => Array.from(a)),
    },
  });
};
