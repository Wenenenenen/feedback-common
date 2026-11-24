// 性能基准：满额 64^3 候选 + 512×512 图像，计时求解全过程。
// 运行：node test/bench.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTable, InverseSolver, forward, encodeP6 } from '../src/lut-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function foldedDenseTable() {
  // 64 节点等距轴 + 折返非线性节点，制造大量输出碰撞
  const axes = [
    Array.from({ length: 64 }, (_, i) => i),
    Array.from({ length: 64 }, (_, i) => i),
    Array.from({ length: 64 }, (_, i) => i),
  ];
  const nodes = [];
  for (let r = 0; r < 64; r++) {
    for (let g = 0; g < 64; g++) {
      for (let b = 0; b < 64; b++) {
        // 三角波折返 + 平区段，全部输出仍为 0..255 整数
        const tri = (x) => (x <= 31 ? x * 8 : (63 - x) * 8);
        const flat = (x) => (x >= 48 ? 200 : Math.round((x / 47) * 200));
        nodes.push([tri(r), flat(g), tri(b)]);
      }
    }
  }
  return validateTable({ axes, nodes });
}

const W = 512;
const H = 512;
const rgb = new Uint8Array(W * H * 3);
// 伪随机目标色，覆盖整个 0..255 立方
let seed = 123456789;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed & 255;
};
for (let i = 0; i < rgb.length; i++) rgb[i] = rnd();

const table = foldedDenseTable();

let t0 = performance.now();
const solver = new InverseSolver(
  table,
  [[0, 63], [0, 63], [0, 63]],
  [32, 32, 32],
  [3, 5, 2]
);
const t1 = performance.now();

let lastPct = -1;
const codes = await solver.solveImage(rgb, (done, total) => {
  const pct = Math.floor((done / total) * 100);
  if (pct !== lastPct && pct % 10 === 0) {
    process.stdout.write(`\r进度 ${pct}%`);
    lastPct = pct;
  }
});
const t2 = performance.now();
process.stdout.write('\n');

// 验证：随机抽 200 个像素做全枚举核对
let checks = 0;
for (let k = 0; k < 200; k++) {
  const p = Math.floor((rnd() / 256) * W * H);
  const o = p * 3;
  const target = [rgb[o], rgb[o + 1], rgb[o + 2]];
  let best = null;
  let bestKey = null;
  for (let r = 0; r < 64; r++) {
    for (let g = 0; g < 64; g++) {
      for (let b = 0; b < 64; b++) {
        const out = forward(table, r, g, b);
        const err =
          3 * (out[0] - target[0]) ** 2 +
          5 * (out[1] - target[1]) ** 2 +
          2 * (out[2] - target[2]) ** 2;
        const man = Math.abs(r - 32) + Math.abs(g - 32) + Math.abs(b - 32);
        const key = [err, man, r, g, b];
        if (
          bestKey === null ||
          key[0] < bestKey[0] ||
          (key[0] === bestKey[0] &&
            (key[1] < bestKey[1] ||
              (key[1] === bestKey[1] &&
                (key[2] < bestKey[2] ||
                  (key[2] === bestKey[2] &&
                    (key[3] < bestKey[3] ||
                      (key[3] === bestKey[3] && key[4] < bestKey[4])))))))
        ) {
          bestKey = key;
          best = [r, g, b];
        }
      }
    }
  }
  const got = [codes[o], codes[o + 1], codes[o + 2]];
  if (got.join(',') !== best.join(',')) {
    throw new Error(`pixel ${p}: got ${got} want ${best}`);
  }
  checks++;
}

// 顺便验证 P6 回写
const bytes = encodeP6(W, H, codes);
if (bytes.length !== 15 + W * H * 3) throw new Error('P6 长度异常');

console.log(`候选码总数      : ${solver.candidateCount}`);
console.log(`不同输出色数量  : ${solver.buckets.size}`);
console.log(`构建+正向枚举   : ${(t1 - t0).toFixed(0)} ms`);
console.log(`512×512 反查    : ${(t2 - t1).toFixed(0)} ms`);
console.log(`总计（含构建）  : ${(t2 - t0).toFixed(0)} ms`);
console.log(`抽样暴力核对    : ${checks} 像素全部一致`);
console.log(`预算 15000 ms   : ${t2 - t0 < 15000 ? '达标 ✅' : '超时 ❌'}`);
