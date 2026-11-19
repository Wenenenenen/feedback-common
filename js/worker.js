// 重算 Worker：接收 RGB8 帧与层数，跑完整金字塔融合，返回自动结果、权重与主导来源。
// 锁定不参与金字塔计算（约定要求锁定不改自动权重），因此 Worker 只负责自动融合，
// 锁定覆盖由页面在结果上即时完成——这样重算期间涂的笔画不会被过期快照覆盖。
import { runStack } from '../js/core.js';

self.onmessage = (e) => {
  const { id, images, levels } = e.data;
  try {
    const result = runStack({ images, levels });
    self.postMessage({
      id,
      ok: true,
      width: result.width,
      height: result.height,
      levels: result.levels,
      requestedLevels: result.requestedLevels,
      sizes: result.sizes,
      weights: result.weights,
      dominant: result.dominant,
      fusedRgb8: result.fusedRgb8,
      fusedLinear: result.fusedLinear,
      stats: result.stats,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
