/* Web Worker：重计算与主页面隔离，取消通过 generation 令牌实现（旧任务作废、结果不回传） */
'use strict';
importScripts('remap-core.js');

let generation = 0;

self.onmessage = function (ev) {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    generation++;
    self.postMessage({ type: 'cancelled', generation: msg.generation });
    return;
  }
  if (msg.type !== 'run') return;

  const myGen = ++generation;
  const input = msg.input;
  const check = self.CubemapRemap.validateInput(input);
  if (!check.valid) {
    self.postMessage({ type: 'error', generation: myGen, errors: check.errors });
    return;
  }

  const cancel = { cancelled: false };
  const onProgress = (p) => {
    if (myGen !== generation) cancel.cancelled = true;
    else self.postMessage({ type: 'progress', generation: myGen, progress: p });
  };

  const result = self.CubemapRemap.resampleCubemap(input, { cancel, onProgress, chunk: 96 });
  if (cancel.cancelled || myGen !== generation) {
    self.postMessage({ type: 'cancelled', generation: myGen });
    return;
  }
  self.postMessage({
    type: 'done',
    generation: myGen,
    result: {
      n: result.n,
      out: result.out,
      rgb: result.rgb.buffer,
      coverage: result.coverage.buffer,
      stats: result.stats,
    },
  }, [result.rgb.buffer, result.coverage.buffer]);
};
