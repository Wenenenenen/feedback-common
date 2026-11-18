/* 求解 Worker：主线程通过 terminate() 实现取消，新任务即开新 Worker。 */
importScripts('solver.js');

self.onmessage = function (e) {
  var msg = e.data;
  var id = msg.id;
  var t0 = performance.now();
  try {
    var result = PoissonSolver.solve(msg.params, function (ch, iter, relres) {
      self.postMessage({ type: 'progress', id: id, channel: ch, iter: iter, relres: relres });
    });
    self.postMessage({
      type: 'done',
      id: id,
      elapsedMs: performance.now() - t0,
      result: {
        solution: result.solution,
        regionPixels: result.regionPixels,
        anchored: result.anchored,
        bbox: result.bbox,
        residuals: result.residuals,
        iterations: result.iterations,
        converged: result.converged,
        rangeMin: result.rangeMin,
        rangeMax: result.rangeMax
      }
    }, [result.solution.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: id, message: String((err && err.stack) || err) });
  }
};
