// 端到端管线：RAW 字节 + 白平衡 + 算法 -> RGB 平面 / 16 位采样图 / 指标

import { parseRaw, normalizePlanes } from './raw.js';
import { ALGORITHMS, toUint16, psnr16 } from './demosaic.js';

export function processRaw(rawBytes, wb, algorithmId) {
  const algo = ALGORITHMS[algorithmId];
  if (!algo) throw new Error(`未知算法 ${algorithmId}`);
  const raw = parseRaw(rawBytes);
  const { planes, mask } = normalizePlanes(raw, wb);
  const rgbPlanes = algo.run(raw, planes);
  const rgb16 = toUint16(rgbPlanes);
  return { raw, mask, planes, rgbPlanes, rgb16, algorithm: algorithmId };
}

export function comparePsnr(rgb16, reference16) {
  return {
    overall: psnr16(rgb16, reference16),
    perChannel: [0, 1, 2].map((c) => {
      const n = rgb16.length / 3;
      const a = new Uint16Array(n);
      const b = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        a[i] = rgb16[i * 3 + c];
        b[i] = reference16[i * 3 + c];
      }
      return psnr16(a, b);
    }),
  };
}
