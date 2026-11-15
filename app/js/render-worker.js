// render-worker.js — runs ray marching off the main thread so the UI stays
// responsive while a frame is being computed.
//
// Protocol (main thread → worker):
//   {type:'init', ...volume}    once per data set
//   {type:'render', jobId, view, width, height, mode, step, tf, refMm, window}
//   {type:'probe', requestId, ray, mode, step, tf, refMm, window}
// Worker → main:
//   {type:'progress', jobId, fraction}
//   {type:'done', jobId, buffer, elapsedMs}     (buffer transferred)
//   {type:'probe-result', requestId, trace}
//   {type:'error', jobId, message}
//
// A render is split into horizontal bands with a yield between them.  When a
// newer render arrives the running one is marked stale and stopped at the next
// band, so only the newest result is ever delivered.

import {
  renderRows, computeCamera, traceRay, normalizeTransferFunction,
  DEFAULT_TF, DEFAULT_REF_MM,
} from './core.js';

let volume = null;
let active = null;     // {job, img, row, cancelled}
let queued = null;     // newest render job waiting for the active one

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    volume = {
      dims: msg.dims,
      spacing: msg.spacing,
      ext: msg.ext,
      invSpacing: msg.invSpacing,
      values: msg.values,
      valueMin: msg.valueMin,
      valueMax: msg.valueMax,
      dataType: msg.dataType,
      meta: msg.meta,
    };
    // A new data set invalidates any frame computed from the old one.
    active = null;
    queued = null;
    return;
  }

  if (msg.type === 'render') {
    queued = msg;
    if (active) {
      active.cancelled = true; // stop at the next band boundary
    } else {
      startNext();
    }
    return;
  }

  if (msg.type === 'probe') {
    if (!volume) {
      self.postMessage({ type: 'probe-result', requestId: msg.requestId, trace: null, error: '数据未加载' });
      return;
    }
    try {
      const tf = normalizeTransferFunction(msg.tf && msg.tf.length ? msg.tf : DEFAULT_TF).tf;
      const trace = traceRay(volume, msg.ray.origin, msg.ray.dir, {
        mode: msg.mode, step: msg.step, tf, refMm: msg.refMm || DEFAULT_REF_MM, window: msg.window,
      });
      self.postMessage({ type: 'probe-result', requestId: msg.requestId, trace });
    } catch (err) {
      self.postMessage({
        type: 'probe-result', requestId: msg.requestId, trace: null,
        error: String((err && err.message) || err),
      });
    }
  }
};

function startNext() {
  if (!volume || !queued) return;
  const job = queued;
  queued = null;
  active = { job, img: null, row: 0, cancelled: false, started: performance.now() };
  setTimeout(() => runBand(active), 0);
}

function runBand(state) {
  if (state.cancelled || active !== state) {
    if (active === state) active = null;
    if (queued) startNext();
    return;
  }
  const job = state.job;
  try {
    if (!state.img) {
      state.img = new Uint8ClampedArray(job.width * job.height * 4);
      state.tf = normalizeTransferFunction(job.tf && job.tf.length ? job.tf : DEFAULT_TF).tf;
      state.camera = computeCamera(volume, job.view, job.width, job.height);
      // ~48 bands keep each yield short (well under a frame budget on a
      // 1024² frame) so a newer job pre-empts quickly.
      state.band = Math.max(1, Math.floor(job.height / 48));
    }
    const stop = Math.min(job.height, state.row + state.band);
    renderRows(volume, state.camera, job.width, job.height, state.row, stop, {
      mode: job.mode, step: job.step, tf: state.tf, refMm: job.refMm, window: job.window,
    }, state.img);
    state.row = stop;
    self.postMessage({ type: 'progress', jobId: job.jobId, fraction: state.row / job.height });

    if (state.row < job.height) {
      setTimeout(() => runBand(state), 0);
    } else {
      const elapsedMs = performance.now() - state.started;
      self.postMessage({
        type: 'done',
        jobId: job.jobId,
        buffer: state.img.buffer,
        width: job.width,
        height: job.height,
        elapsedMs,
      }, [state.img.buffer]);
      state.img = null;
      active = null;
      if (queued) startNext();
    }
  } catch (err) {
    active = null;
    self.postMessage({ type: 'error', jobId: job.jobId, message: String((err && err.message) || err) });
    if (queued) startNext();
  }
}
