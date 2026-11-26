/* worker-sdt.js — 标签分批 SDT 计算 Web Worker
 * 消息入参：
 *   { W, H, labelIds:[...], coordsByLabel: Map<label, Int32Array|number[]>,
 *     sx, sy, wrap, jobId }
 * 返回（Transferable 传输各 TypedArray buffer）：
 *   { jobId, partial:{d1,d2,l1,l2,r1,c1,r2,c2} }
 */
'use strict';
importScripts('./sdt-core.js');

self.onmessage = function (ev) {
  const m = ev.data;
  const coordMap = new Map();
  for (const [lab, arr] of m.coordsByLabel) {
    coordMap.set(lab, arr instanceof Int32Array ? arr : Int32Array.from(arr));
  }
  const partial = SDTCore.runLabels(
    m.W, m.H, coordMap, m.labelIds, m.sx, m.sy, m.wrap,
    (done, total) => self.postMessage({ type: 'progress', jobId: m.jobId, done, total })
  );
  const buffers = [];
  for (const k of ['d1', 'd2', 'l1', 'l2', 'r1', 'c1', 'r2', 'c2']) {
    buffers.push(partial[k].buffer);
  }
  self.postMessage({ type: 'done', jobId: m.jobId, partial }, buffers);
};
