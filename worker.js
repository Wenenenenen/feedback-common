/* worker.js — 分块渲染 Worker，通过 importScripts 加载同一份 sampler.js */
'use strict';
if (typeof self.Sampler === 'undefined' && typeof importScripts === 'function') {
  importScripts(self.__SAMPLER_URL__);
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (msg.type !== 'render') return;
  var p = msg.params;
  var tex = { w: p.texW, h: p.texH, lin: new Float32Array(p.texLin) };
  try {
    var result = self.Sampler.renderAll({
      tex: tex, H: p.H, outW: p.outW, outH: p.outH,
      address: p.address, aniso: p.aniso, maxRadius: p.maxRadius,
      methods: p.methods
    }, function (rows, total) {
      self.postMessage({ type: 'progress', rows: rows, total: total });
    });
    var transfer = [];
    Object.keys(result.buffers).forEach(function (k) { transfer.push(result.buffers[k].buffer); });
    self.postMessage({ type: 'done', buffers: result.buffers, stats: result.stats }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
