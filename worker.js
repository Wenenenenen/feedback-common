/* worker.js — 渲染 Worker：接收一条 (声源, 耳) 任务，渲染后经 Transferable 返回。 */
'use strict';
importScripts('render-core.js');

self.onmessage = function (e) {
  const m = e.data;
  if (m.type !== 'render') return;
  const samples = new Int16Array(m.samples);
  const trackFrames = new Int32Array(m.trackFrames);
  const trackAngs = new Int32Array(m.trackAngs);
  const angles = new Int32Array(m.angles);
  const taps = new Float64Array(m.taps);
  const delays = new Float64Array(m.delays);
  const out = new Float64Array(m.totalLen);
  try {
    RenderCore.renderSourceEar(
      samples, trackFrames, trackAngs, angles, taps, delays, m.L, out,
      (done) => { self.postMessage({ type: 'progress', taskId: m.taskId, done }); return true; }
    );
    self.postMessage(
      { type: 'done', taskId: m.taskId, srcId: m.srcId, ear: m.ear, buffer: out.buffer },
      [out.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', taskId: m.taskId, message: String(err && err.message || err) });
  }
};
