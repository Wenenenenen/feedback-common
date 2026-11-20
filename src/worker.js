'use strict';
// 修补 Worker：主线程只负责交互，算法在后台跑，取消通过任务令牌即时生效。
import { runInpaint, encodeNNF, verifyNNFErrors } from './inpaint.js';

let currentToken = 0;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    currentToken++; // 令正在运行的 onProgress 令牌失效
    self.postMessage({ type: 'canceled' });
    return;
  }
  if (msg.type !== 'run') return;

  const token = ++currentToken;
  const { image, mask, width, height, params } = msg;

  try {
    const result = runInpaint({
      image,
      mask,
      width,
      height,
      patchSize: params.patchSize,
      levels: params.levels,
      iterations: params.iterations,
      seed: params.seed,
      onProgress: (info) => {
        if (token !== currentToken) return false; // 已取消/被新任务取代
        self.postMessage({ type: 'progress', token, info });
        return true;
      },
    });
    if (token !== currentToken) return; // 运行期间被取消，丢弃旧结果

    let nnfBytes = null;
    let nnfArrays = null;
    let verification = null;
    if (result.status === 'ok') {
      nnfBytes = encodeNNF(result.finalNnf, mask, width, height);
      // 结构化克隆会把 TypedArray 作为独立缓冲传输，供主线程点选反查。
      nnfArrays = { nnfX: result.finalNnf.nnfX.slice(), nnfY: result.finalNnf.nnfY.slice() };
      verification = verifyNNFErrors({
        targetSnapshot: result.targetSnapshot,
        originalImage: image,
        mask,
        nnfX: result.finalNnf.nnfX,
        nnfY: result.finalNnf.nnfY,
        width,
        height,
        patchSize: params.patchSize,
      });
    }
    self.postMessage({
      type: 'done',
      token,
      result: {
        status: result.status,
        message: result.message,
        image: result.image,
        targetSnapshot: result.targetSnapshot,
        levelReports: result.levelReports,
        nnfBytes,
        nnfArrays,
        verification,
        params: result.params,
      },
    });
  } catch (err) {
    if (token !== currentToken) return;
    self.postMessage({ type: 'error', token, message: String(err && err.message ? err.message : err) });
  }
};
