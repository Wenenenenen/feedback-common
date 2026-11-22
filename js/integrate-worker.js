/**
 * 曝光积分 Worker：把整帧解析积分放到后台，带逐行进度。
 * 场景与参数以纯数据传入。
 */
import { buildScene, renderIntegrated } from './shutter.js';

self.onmessage = (ev) => {
  const { reqId, caseObj, params } = ev.data;
  try {
    const scene = buildScene(caseObj);
    let last = 0;
    const { data, weights } = renderIntegrated(scene, params, (done, total) => {
      const now = performance.now();
      if (now - last > 30 || done === total) {
        last = now;
        self.postMessage({ reqId, type: 'progress', done, total });
      }
    });
    self.postMessage(
      { reqId, type: 'done', data: data.buffer, weights: weights.buffer, W: scene.W, H: scene.H },
      [data.buffer, weights.buffer],
    );
  } catch (e) {
    self.postMessage({ reqId, type: 'error', message: String(e && e.message ? e.message : e) });
  }
};
