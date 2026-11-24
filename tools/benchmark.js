#!/usr/bin/env node
'use strict';

/* 满额工况基准：24 行 × 8 列，覆盖多种代价分布与大量并列表。
 * 目标：每次求解 5 秒内完成。
 */

const Solver = require('../src/solver.js');

function fill(n, v) { return new Array(n).fill(v); }
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function costs(R, C, g, maxv) {
  const vKeep = [], vRem = [], hKeep = [], hRem = [];
  for (let i = 0; i < R * (C - 1); i++) { vKeep.push(Math.floor(g() * maxv)); vRem.push(Math.floor(g() * maxv)); }
  for (let i = 0; i < (R - 1) * C; i++) { hKeep.push(Math.floor(g() * maxv)); hRem.push(Math.floor(g() * maxv)); }
  return { vKeep, vRem, hKeep, hRem };
}

const R = 24, C = 8;
const cases = [];
function add(label, spec) { cases.push({ label, spec }); }

add('全零（最大并列）', { R, C, vKeep: fill(R * (C - 1), 0), vRem: fill(R * (C - 1), 0), hKeep: fill((R - 1) * C, 0), hRem: fill((R - 1) * C, 0), locks: [] });
add('全一', { R, C, vKeep: fill(R * (C - 1), 1), vRem: fill(R * (C - 1), 1), hKeep: fill((R - 1) * C, 1), hRem: fill((R - 1) * C, 1), locks: [] });
for (const maxv of [2, 4, 16, 256]) {
  add(`随机 0..${maxv - 1}`, Object.assign({ R, C, locks: [] }, costs(R, C, rng(1000 + maxv), maxv)));
}
// 交替 0/1，制造大量并列
{
  const vK = [], vR = [], hK = [], hR = [];
  for (let i = 0; i < R * (C - 1); i++) { vK.push(i % 2); vR.push((i + 1) % 2); }
  for (let i = 0; i < (R - 1) * C; i++) { hK.push(i % 2); hR.push((i + 1) % 2); }
  add('交替 0/1', { R, C, vKeep: vK, vRem: vR, hKeep: hK, hRem: hR, locks: [] });
}
// 稀疏锁定 + 随机代价
{
  const locks = [];
  for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) if ((r * 7 + c * 3) % 9 === 0) locks.push({ axis: 'v', row: r, col: c, keep: (r + c) % 2 === 0 });
  for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) if ((r * 3 + c * 5) % 11 === 0) locks.push({ axis: 'h', row: r, col: c, keep: (r * c) % 3 === 0 });
  add(`随机 0..255 + ${locks.length} 锁定`, Object.assign({ R, C, locks }, costs(R, C, rng(777), 256)));
}

let worst = 0;
for (const { label, spec } of cases) {
  const t0 = process.hrtime.bigint();
  const res = Solver.solve(spec);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  worst = Math.max(worst, ms);
  const status = res.feasible ? `loss=${res.loss} count=${res.count}` : `不可行(${res.reason})`;
  console.log(`${label.padEnd(24)} ${ms.toFixed(1).padStart(8)} ms  ${status}`);
}
console.log(`\n最慢 ${worst.toFixed(1)} ms；阈值 5000 ms：${worst < 5000 ? '通过' : '超时'}`);
process.exit(worst < 5000 ? 0 : 1);
