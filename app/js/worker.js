// Web Worker：隔离耗时的两阶段协同去噪。
// 任务串行执行；新任务到达时旧任务在协作点立即退出，旧任务的结果不会发出。
// 主线程另以 jobId 过滤，双保险确保旧参数不会覆盖新结果。

import { runDenoise } from '../../lib/engine.js';

let running = false;
let pending = null;
let activeJob = 0;
let cancelRequested = false;

function yieldToMessages() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function execute(msg) {
  running = true;
  activeJob = msg.jobId;
  cancelRequested = false;
  const jobId = msg.jobId;
  try {
    const result = await runDenoise(
      { width: msg.width, height: msg.height, data: msg.data },
      msg.params,
      {
        shouldCancel: () => cancelRequested || activeJob !== jobId,
        yieldNow: yieldToMessages,
        onProgress: (p) => {
          if (jobId === activeJob && !cancelRequested) self.postMessage({ type: 'progress', jobId, ...p });
        },
      },
    );
    if (activeJob !== jobId || result.canceled) {
      self.postMessage({ type: 'canceled', jobId });
      return;
    }
    const transfer = [result.original, result.pilot, result.final, result.weight1, result.weight2]
      .map((a) => a && a.buffer)
      .filter(Boolean);
    self.postMessage(
      {
        type: 'done',
        jobId,
        width: result.width,
        height: result.height,
        params: result.params,
        original: result.original,
        pilot: result.pilot,
        final: result.final,
        weight1: result.weight1,
        weight2: result.weight2,
        groups: result.groups,
        timing: result.timing,
        zeroNoise: result.zeroNoise,
      },
      transfer,
    );
  } catch (err) {
    self.postMessage({ type: 'error', jobId, message: (err && err.message) || String(err) });
  } finally {
    running = false;
    if (pending) {
      const next = pending;
      pending = null;
      execute(next);
    }
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'cancel') {
    cancelRequested = true;
    if (pending) pending = null;
    return;
  }
  if (msg.type !== 'run') return;
  if (running) {
    // 串行：新任务排队，旧任务会在下一个协作点因 activeJob 变化而退出。
    pending = msg;
    activeJob = -1;
    cancelRequested = true;
    return;
  }
  execute(msg);
};
