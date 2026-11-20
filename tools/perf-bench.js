'use strict';
// 性能基准：构造最坏情况（大边长 + 大洞），测量单次运行耗时。
import { runInpaint } from '../src/inpaint.js';

function makeCase(size, holeFrac, patchSize, levels, iterations) {
  const n = size * size;
  const image = new Uint8Array(n * 3);
  const mask = new Uint8Array(n);
  // 伪纹理（确定性，不用 Math.random）
  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s & 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      image[i * 3] = (x * 7 + y * 3) & 255;
      image[i * 3 + 1] = (x * 3 + y * 7) & 255;
      image[i * 3 + 2] = rnd();
    }
  }
  // 中央方形大洞
  const hs = Math.round(size * Math.sqrt(holeFrac));
  const o = (size - hs) >> 1;
  for (let y = o; y < o + hs; y++) for (let x = o; x < o + hs; x++) mask[y * size + x] = 255;
  return { image, mask, size, patchSize, levels, iterations };
}

for (const [size, frac, ps, lv, it] of [
  [256, 0.25, 7, 1, 10],
  [512, 0.25, 7, 1, 10],
  [512, 0.25, 7, 2, 10],
  [512, 0.5, 9, 3, 8],
]) {
  const c = makeCase(size, frac, ps, lv, it);
  const holes = c.mask.filter((v) => v === 255).length;
  const t0 = Date.now();
  const res = runInpaint({ image: c.image, mask: c.mask, width: size, height: size,
    patchSize: ps, levels: lv, iterations: it, seed: 1 });
  const t1 = Date.now();
  console.log(`${size}px hole=${(frac * 100).toFixed(0)}%(${holes}) P=${ps} L=${lv} it=${it} -> ${res.status} ${t1 - t0}ms`);
}
