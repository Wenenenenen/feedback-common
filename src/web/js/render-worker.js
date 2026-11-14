// 渲染 Worker：每个 Worker 负责一个水平分带。
// 校验失败时抛出 ValidationError，由主线程保留上一帧。
import { renderBand, ValidationError } from './renderer.js';

self.onmessage = (ev) => {
  const { seq, scene, size, camera, y0, y1 } = ev.data;
  try {
    const band = renderBand(scene, size, camera, y0, y1);
    // 转移大容量缓冲，减少结构化克隆开销
    const transfer = [
      band.linear.buffer, band.rgb8.buffer, band.fragStart.buffer,
      band.fragId.buffer, band.fragDepth.buffer, band.fragRgba.buffer, band.fragComp.buffer,
    ];
    self.postMessage({ seq, ok: true, band }, transfer);
  } catch (err) {
    const msg = err instanceof ValidationError ? err.message : String(err && err.message || err);
    self.postMessage({ seq, ok: false, error: msg });
  }
};
