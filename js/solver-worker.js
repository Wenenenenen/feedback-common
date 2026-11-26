// 求解 Worker：在后台跑平面对偶 + 最小权完美匹配，避免花算法阻塞 UI。
import { normalizeDocument, buildModel, solveModel, estimateDefects } from './directors.js';

self.onmessage = (ev) => {
  const { kind, payload, reqId } = ev.data || {};
  try {
    if (kind === 'solve-doc') {
      const { doc } = payload;
      const model = buildModel(doc);
      const est = estimateDefects(model);
      const t0 = performance.now();
      const sol = solveModel(model);
      const ms = performance.now() - t0;
      self.postMessage({
        kind: 'solved', reqId,
        flips: Array.from(sol.flips),
        totalCost: sol.totalCost,
        components: sol.components,
        engine: sol.engine,
        ms,
        estimate: est,
      });
    } else if (kind === 'solve-model') {
      // 预留：结构化克隆 model 后直接解（当前主线程传 doc 更简单）
      const t0 = performance.now();
      const sol = solveModel(payload.model);
      self.postMessage({
        kind: 'solved', reqId,
        flips: Array.from(sol.flips),
        totalCost: sol.totalCost,
        components: sol.components,
        engine: sol.engine,
        ms: performance.now() - t0,
      });
    }
  } catch (err) {
    self.postMessage({ kind: 'error', reqId, message: err?.message || String(err), stack: err?.stack || '' });
  }
};
