/**
 * 求解 Worker：薄封装。取消由主线程 terminate 本 Worker 实现
 * （终止后由主线程重新拉起；流水线本身也检查 abortSignal 以支持主线程回退）。
 */
import { runReconstruction } from './reconstruct.js';

self.onmessage = (ev) => {
  if (ev.data.type !== 'start') return;
  try {
    runReconstruction(ev.data.payload, (msg, transfer) => {
      self.postMessage(msg, transfer || []);
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
