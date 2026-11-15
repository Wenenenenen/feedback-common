/*
 * 后台任务调度：常驻单 Worker。
 *  - 音频数据只在载入/变更时复制一次并转移给 Worker，主线程保留原件；
 *  - 每个任务有 id 与 token；参数一变就 cancel 旧任务，Worker 在块边界让出并响应；
 *  - 主线程再用 generation 校验回包，双重保证旧任务不会覆盖新结果。
 *
 * 任务句柄：{ id, promise, cancel() }
 */

let worker = null;
let nextId = 1;
const live = new Map();
let audioId = 0;
const pendingAudio = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./conv-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = handleMessage;
  worker.onerror = (event) => {
    const error = new Error(`后台线程错误：${event.message || '未知错误'}`);
    for (const entry of live.values()) entry.reject(error);
    live.clear();
  };
  return worker;
}

function handleMessage(event) {
  const msg = event.data || {};

  if (msg.type === 'audio-ready') {
    const waiter = pendingAudio.get(msg.audioId);
    if (waiter) {
      pendingAudio.delete(msg.audioId);
      waiter.resolve();
    }
    return;
  }

  const entry = live.get(msg.id);
  if (!entry) return;
  if (msg.type === 'progress') {
    entry.onProgress?.(msg.progress);
    return;
  }
  live.delete(msg.id);
  if (msg.type === 'error') {
    entry.reject(new Error(msg.message || '后台处理失败'));
  } else if (msg.type === 'cancelled') {
    entry.reject(Object.assign(new Error('处理已取消'), { cancelled: true }));
  } else {
    entry.resolve(msg);
  }
}

/**
 * 把音频数据交给 Worker。每次调用都会等待 Worker 确认就绪。
 * @returns {Promise<void>}
 */
export function setAudio({ dryL, dryR, irs, sampleRate }) {
  const copy = (arr) => Float64Array.from(arr);
  const payload = {
    dryL: copy(dryL),
    dryR: copy(dryR),
    irs: irs.map(copy),
    sampleRate,
  };
  const id = ++audioId;
  const w = ensureWorker();
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAudio.delete(id);
      reject(new Error('后台线程未在 8 秒内就绪'));
    }, 8000);
    pendingAudio.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    });
  });
  w.postMessage(
    {
      type: 'audio',
      audioId: id,
      dryL: payload.dryL,
      dryR: payload.dryR,
      irs: payload.irs,
      sampleRate,
    },
    [payload.dryL.buffer, payload.dryR.buffer, ...payload.irs.map((ir) => ir.buffer)],
  );
  return promise;
}

function startTask(type, fields, { onProgress } = {}) {
  const id = nextId++;
  const w = ensureWorker();
  const promise = new Promise((resolve, reject) => {
    live.set(id, { resolve, reject, onProgress });
    w.postMessage({ type, id, ...fields });
  });
  return {
    id,
    promise,
    cancel() {
      cancelTask(id);
    },
  };
}

export function startAnalyze(params, options) {
  return startTask('analyze', { params }, options);
}

export function startRender(params, startFrame, endFrame, options) {
  return startTask('render', { params, startFrame, endFrame }, options);
}

export function startExport(params, options) {
  return startTask('export', { params }, options);
}

/** 终止任务并让 promise 以 cancelled 拒绝。 */
export function cancelTask(taskOrId) {
  const id = typeof taskOrId === 'number' ? taskOrId : taskOrId?.id;
  if (!id || !worker) return;
  const entry = live.get(id);
  worker.postMessage({ type: 'cancel', id });
  if (entry) {
    live.delete(id);
    entry.reject(Object.assign(new Error('处理已取消'), { cancelled: true }));
  }
}
