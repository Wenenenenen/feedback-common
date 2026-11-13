/* worker.js — 分析 Worker：主线程 terminate() 即可在 1 秒内取消；
 * gen 世代号防止旧任务结果覆盖后续编辑。 */
importScripts('dsp.js', 'analysis-core.js');

self.onmessage = function (e) {
  const { gen, ref, track } = e.data;
  const post = (obj) => self.postMessage(Object.assign({ gen }, obj));
  try {
    const result = ANALYSIS.analyze(
      new Float32Array(ref.mono), ref.rate,
      new Float32Array(track.mono), track.rate,
      (pct) => post({ type: 'progress', pct })
    );
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
};
