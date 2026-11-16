/*
 * 烘焙 Worker：把整段等距柱状积分放到后台线程，主线程保持可操作、可取消。
 *
 * 消息：
 *   {type:'bake', jobId, values:Float32Array, width, height}
 *   {type:'cancel', jobId}
 * 回复：
 *   {type:'progress', jobId, fraction, row}
 *   {type:'done', jobId, result:{...}}
 *   {type:'cancelled', jobId}
 *   {type:'error', jobId, code, message, details}
 *
 * 积分按行分块并在块间让出事件循环，因此 cancel 消息能在烘焙中途被处理，
 * 不必等整张图算完。Float64Array 结果以 transferable 传回。
 */

import { bakeEquirectAsync, BakeCancelledError } from './sh.js';

const cancelled = new Set();
let activeJob = null;

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId);
    if (activeJob === msg.jobId) activeJob = null;
    return;
  }

  if (msg.type !== 'bake') return;
  void runBake(msg);
};

async function runBake({ jobId, values, width, height }) {
  if (activeJob !== null && activeJob !== jobId) cancelled.add(activeJob);
  activeJob = jobId;
  try {
    const result = await bakeEquirectAsync(values, width, height, {
      chunkRows: 4,
      shouldCancel: () => cancelled.has(jobId) || activeJob !== jobId,
      onProgress: (fraction, row) => {
        self.postMessage({ type: 'progress', jobId, fraction, row });
      },
    });
    if (cancelled.has(jobId)) {
      self.postMessage({ type: 'cancelled', jobId });
      return;
    }
    activeJob = null;
    self.postMessage(
      {
        type: 'done',
        jobId,
        result: {
          radiance: result.radiance,
          rowContrib: result.rowContrib,
          rowSolidAngles: result.rowSolidAngles,
          rowMeanLuminance: result.rowMeanLuminance,
          totalSolidAngle: result.totalSolidAngle,
          naiveMean: result.naiveMean,
          weightedMean: result.weightedMean,
          width: result.width,
          height: result.height,
        },
      },
      [result.radiance.buffer, result.rowContrib.buffer, result.rowSolidAngles.buffer,
        result.rowMeanLuminance.buffer, result.naiveMean.buffer, result.weightedMean.buffer],
    );
  } catch (err) {
    if (err instanceof BakeCancelledError || cancelled.has(jobId)) {
      self.postMessage({ type: 'cancelled', jobId });
      return;
    }
    activeJob = null;
    self.postMessage({
      type: 'error',
      jobId,
      code: err?.code || err?.name || 'BAKE_ERROR',
      message: err?.message || String(err),
      details: err?.details || null,
    });
  } finally {
    cancelled.delete(jobId);
  }
}
