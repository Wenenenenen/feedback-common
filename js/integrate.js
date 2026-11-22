/**
 * 积分调度：优先 Worker，Worker 不可用（file:// / 被拦截）时回退主线程。
 */
import { buildScene, renderIntegrated } from './shutter.js';

let worker = null;
let workerBroken = false;
let seq = 0;
const pending = new Map();

/** 测试/排障用：URL 带 noworker=1 时强制走主线程回退。 */
const FORCE_FALLBACK = (() => {
  try {
    return new URLSearchParams(location.search).has('noworker');
  } catch {
    return false;
  }
})();

function ensureWorker() {
  if (worker || workerBroken || FORCE_FALLBACK || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./integrate-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      const entry = pending.get(msg.reqId);
      if (!entry) return;
      if (msg.type === 'progress') {
        if (entry.onProgress) entry.onProgress(msg.done, msg.total);
      } else if (msg.type === 'done') {
        pending.delete(msg.reqId);
        entry.resolve({
          data: new Float64Array(msg.data),
          weights: new Float64Array(msg.weights),
          W: msg.W,
          H: msg.H,
        });
      } else if (msg.type === 'error') {
        pending.delete(msg.reqId);
        entry.reject(new Error(msg.message));
      }
    };
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) runFallback(entry);
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function runFallback(entry) {
  try {
    const { caseObj, params, onProgress, resolve, reject } = entry;
    const scene = buildScene(caseObj);
    const { data, weights } = renderIntegrated(scene, params, onProgress);
    resolve({ data, weights, W: scene.W, H: scene.H });
  } catch (e) {
    entry.reject(e);
  }
}

/**
 * 计算整帧积分。
 * @returns {{promise: Promise<{data,weights,W,H}>, cancel: Function}}
 */
export function integrateFrame(caseObj, params, onProgress) {
  const w = ensureWorker();
  const reqId = ++seq;
  if (!w) {
    let cancelled = false;
    const promise = new Promise((resolve, reject) => {
      if (cancelled) return;
      runFallback({ caseObj, params, onProgress, resolve, reject });
    });
    return { promise, cancel: () => { cancelled = true; } };
  }
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    pending.set(reqId, {
      caseObj,
      params,
      onProgress,
      resolve: (v) => { settled = true; resolve(v); },
      reject: (e) => { settled = true; reject(e); },
    });
    w.postMessage({ reqId, caseObj, params });
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      pending.delete(reqId);
      // 无法精确中断 Worker 内计算；丢弃其结果即可（下次请求继续复用 Worker）
      settled = true;
    },
  };
}
