// 生成满额横段样例：100 万 x 100 万、恰好 20 万条原始横段（含规则小环孔）。
// 用法：node test/make-large-sample.mjs [输出路径]   默认 ./samples/large-run-mask.json
//
// 该文件是纯数据生成器，不依赖 js/topology.js。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(__dirname, '..', 'samples', 'large-run-mask.json');

function prng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = prng(20261127);
const W = 1_000_000;
const H = 1_000_000;
const runs = [];

// 约 6 万段环阵（1 万个 6x4 小环，各含一个 4x2 孔）
for (let gy = 0; gy < 40; gy++) {
  for (let gx = 0; gx < 250; gx++) {
    const bx = 2000 + gx * 3900;
    const by = 2000 + gy * 24000;
    runs.push([by, bx, bx + 6]);
    runs.push([by + 1, bx, bx + 1], [by + 1, bx + 5, bx + 6]);
    runs.push([by + 2, bx, bx + 1], [by + 2, bx + 5, bx + 6]);
    runs.push([by + 3, bx, bx + 6]);
  }
}

// 其余用随机段（含重复/交叠）补到恰好 20 万
let guard = 0;
while (runs.length < 200_000 && guard < 2_000_000) {
  guard++;
  const y = Math.floor(rnd() * H);
  const x0 = Math.floor(rnd() * (W - 4000));
  const len = 1 + Math.floor(rnd() * 3000);
  const x1 = Math.min(W, x0 + len);
  runs.push([y, x0, x1]);
  if (runs.length < 200_000 && guard % 7 === 0) runs.push([y, x0, x1]);
}
runs.length = 200_000;

const json = JSON.stringify({ width: W, height: H, runs });
writeFileSync(out, json);
console.log(`已写入 ${out}：${W}x${H}，runs=${runs.length}，${(json.length / 1024 / 1024).toFixed(1)} MiB`);
