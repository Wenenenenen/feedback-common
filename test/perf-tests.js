/*
 * 性能与边界补充测试：node test/perf-tests.js
 *  - 512×512 上限图的四邻/八邻运行时间与内存
 *  - 八邻 vs 四邻在对角捷径上的代价差异
 *  - 无掩膜、全图单种子全覆盖
 */
"use strict";
const MGSSegment = require("../app/segment.js");

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.error("  ✗ " + name + (extra ? " — " + extra : "")); }
}

const SIDE = 512;
const rand = rng(42);
const gray = Uint8ClampedArray.from({ length: SIDE * SIDE }, () => Math.floor(rand() * 256));
// 6 个标签、每标签 3 个种子，分散布点
const seeds = [];
const used = new Set();
for (let lab = 1; lab <= 6; lab++) {
  let placed = 0, guard = 0;
  while (placed < 3 && guard++ < 1000) {
    const x = Math.floor(rand() * SIDE), y = Math.floor(rand() * SIDE);
    const key = y * SIDE + x;
    if (used.has(key)) continue;
    used.add(key);
    seeds.push({ label: lab, x, y });
    placed++;
  }
}

for (const conn of [4, 8]) {
  const t0 = process.hrtime.bigint();
  const r = MGSSegment.segment(gray, SIDE, SIDE, { connectivity: conn, seeds });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const mem = (r.labels.byteLength + r.cost.byteLength + r.tie.byteLength +
    r.reached.byteLength + r.excluded.byteLength) / 1024 / 1024;
  console.log(`  ${conn}邻域 512×512：${ms.toFixed(0)} ms，结果数组约 ${mem.toFixed(1)} MiB`);
  check(`${conn}邻域在 2 秒内完成`, ms < 2000, ms + "ms");
  check(`${conn}邻域无掩膜时全部像素可达`,
    r.reached.every((v) => v === 1) && r.excluded.every((v) => v === 0));
  const assigned = r.labels.reduce((a, v) => a + (v ? 1 : 0), 0) +
    r.tie.reduce((a, v) => a + v, 0);
  check(`${conn}邻域每个像素要么归属要么分界（合计=${assigned}）`, assigned === SIDE * SIDE);
  check(`${conn}邻域只出现已声明的 6 个标签或 0`,
    new Set(r.labels).size <= 7 && [...new Set(r.labels)].every((l) => l === 0 || l <= 6));
}

console.log("== 八邻对角捷径 ==");
{
  // 3x3 全同灰度，种子 (0,0)，对角 (2,2)：
  // 四邻最短 4 条正交边；八邻可走 2 条对角边
  const g = new Uint8ClampedArray(9).fill(100);
  const r4 = MGSSegment.segment(g, 3, 3,
    { connectivity: 4, seeds: [{ label: 1, x: 0, y: 0 }] });
  const r8 = MGSSegment.segment(g, 3, 3,
    { connectivity: 8, seeds: [{ label: 1, x: 0, y: 0 }] });
  check("四邻 (2,2) 代价 = 4*10*256", r4.cost[8] === 4 * 10 * 256, String(r4.cost[8]));
  check("八邻 (2,2) 代价 = 2*14*256（对角更短）", r8.cost[8] === 2 * 14 * 256, String(r8.cost[8]));
  check("八邻代价严格小于四邻", r8.cost[8] < r4.cost[8]);
}

console.log("== 对角穿角：掩膜 L 形拐角 ==");
{
  // 3x3：除 (1,0) 外全部有效。种子 (0,0)，问 (2,1) 是否可达
  // 从 (0,0) 到 (1,1) 的对角边侧像素为 (1,0)=无效 → 禁行；但 (0,0)->(0,1)->(1,1) 可走
  const w = 3, h = 3;
  const g = new Uint8ClampedArray(w * h).fill(50);
  const mask = new Uint8Array(w * h).fill(1);
  mask[1] = 0; // (1,0) 无效
  const r = MGSSegment.segment(g, w, h,
    { mask, connectivity: 8, seeds: [{ label: 1, x: 0, y: 0 }] });
  check("拐角禁穿不影响正交绕行，(2,1) 仍可达", r.reached[5] === 1);
  check("(1,0) 被排除", r.excluded[1] === 1);
  // (0,0)->(1,1) 直连对角被禁，故 (1,1) 只能经 (0,1)：2 条正交边
  check("(1,1) 走正交绕行，代价=2*10*256", r.cost[4] === 2 * 10 * 256, String(r.cost[4]));
}

console.log(fail ? `\n${fail} 项失败` : "\n性能/边界测试全部通过");
process.exit(fail ? 1 : 0);
