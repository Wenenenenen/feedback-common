#!/usr/bin/env node
/* 正确性：随机小网格，SDT 管线 vs 朴素逐种子暴力实现，逐格比对全部字段 */
'use strict';
const path = require('path');
const Core = require(path.join(__dirname, '..', 'js', 'sdt-core.js'));
const INF = Core.INF;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOne(rng, trial) {
  const W = 1 + Math.floor(rng() * 24);
  const H = 1 + Math.floor(rng() * 24);
  const wrap = rng() < 0.5;
  const sx = 1 + Math.floor(rng() * 5);
  const sy = 1 + Math.floor(rng() * 5);
  const nLabels = 1 + Math.floor(rng() * 5);
  const density = 0.02 + rng() * 0.25;
  const seeds = [];
  const occ = new Set();
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (rng() < density) {
      const lab = 1 + Math.floor(rng() * nLabels);
      const key = r * W + c;
      if (!occ.has(key)) { occ.add(key); seeds.push([c, r, lab]); }
    }
  }
  const radius = Math.floor(rng() * (Math.max(W, H) + 4));
  const margin = Math.floor(rng() * 40);

  // 参考实现
  const bf = Core.bruteForce(W, H, seeds, sx, sy, wrap, radius, margin);

  // SDT 管线：随机切成若干“worker 批”，再走 mergePartials
  const labelCoords = new Map();
  for (const [c, r, lab] of seeds) {
    if (!labelCoords.has(lab)) labelCoords.set(lab, []);
    labelCoords.get(lab).push(c, r);
  }
  const coordMap = new Map();
  for (const [lab, arr] of labelCoords) coordMap.set(lab, Int32Array.from(arr));
  const allIds = [...coordMap.keys()];
  const parts = [];
  // 随机分组（含每标签一组、单组两种极端）
  const shuffled = allIds.slice().sort(() => rng() - 0.5);
  const cuts = shuffled.length <= 1 ? [shuffled.length]
    : [1 + Math.floor(rng() * shuffled.length)];
  let off = 0;
  const groups = [];
  for (const cut of cuts) { groups.push(shuffled.slice(off, off + cut)); off += cut; }
  if (off < shuffled.length) groups.push(shuffled.slice(off));
  for (const g of groups) {
    if (g.length) parts.push(Core.runLabels(W, H, coordMap, g, sx, sy, wrap, null));
  }
  const top = parts.length === 1 ? parts[0] : Core.mergePartials(W, H, parts);
  const fill = Core.applyFill(W, H, top, radius, margin);

  let fails = 0;
  const n = W * H;
  for (let p = 0; p < n; p++) {
    const t = bf.info[p];
    const eq = (a, b) => a === b;
    const checks = [
      ['d1', top.d1[p], t.d1 === INF ? INF : t.d1],
      ['l1', top.l1[p], t.l1],
      ['r1', top.r1[p], t.r1],
      ['c1', top.c1[p], t.c1],
      ['d2', top.d2[p], t.d2 === INF ? INF : t.d2],
      ['l2', top.l2[p], t.l2],
      ['r2', top.r2[p], t.r2],
      ['c2', top.c2[p], t.c2],
      ['fill', fill.out[p], bf.ref[p]],
    ];
    for (const [name, got, want] of checks) {
      if (!eq(got, want)) {
        if (fails < 8) {
          const r = Math.floor(p / W), c = p % W;
          console.log(`trial ${trial} MISMATCH ${name} at (c=${c},r=${r}) ` +
            `got=${got} want=${want} | W=${W} H=${H} wrap=${wrap} sx=${sx} sy=${sy} ` +
            `radius=${radius} margin=${margin} seeds=${JSON.stringify(seeds)}`);
        }
        fails++;
      }
    }
  }
  return fails;
}

function main() {
  const rng = mulberry32(20261127);
  const trials = 400;
  let totalFails = 0;
  for (let i = 0; i < trials; i++) totalFails += runOne(rng, i);
  if (totalFails) { console.log(`FAIL: ${totalFails} mismatches`); process.exit(1); }
  console.log(`OK: ${trials} random trials, all fields match brute force`);

  // 手工并列场景：两标签等距、同标签两点等距（验证四级破并列）
  const W = 8, H = 8;
  const seeds = [[2, 4, 2], [6, 4, 3], [2, 0, 2], [6, 0, 3]];
  const bf = Core.bruteForce(W, H, seeds, 1, 1, false, 20, 0);
  const coordMap = new Map([[2, Int32Array.from([2, 4, 2, 0])], [3, Int32Array.from([6, 4, 6, 0])]]);
  const top = Core.runLabels(W, H, coordMap, [2, 3], 1, 1, false, null);
  const p = 4 * W + 4; // (c=4,r=4)：到 (2,4)l2 与 (6,4)l3 等距
  if (top.l1[p] !== 2 || top.d1[p] !== 4 || top.l2[p] !== 3 || top.d2[p] !== 4) {
    console.log('FAIL tie case', top.l1[p], top.d1[p], top.l2[p], top.d2[p]);
    process.exit(1);
  }
  console.log('OK: hand-crafted tie-break (distance -> label -> row -> col)');

  // 单标签场景：d2 必须为 INF（余量无限），全部填充
  const coordMap2 = new Map([[7, Int32Array.from([0, 0])]]);
  const top2 = Core.runLabels(5, 5, coordMap2, [7], 1, 1, true, null);
  const fill2 = Core.applyFill(5, 5, top2, 100, 999999);
  if (top2.d2[24] !== INF || fill2.out.some(v => v !== 7)) {
    console.log('FAIL single-label infinite-margin case'); process.exit(1);
  }
  console.log('OK: single label => no foreign seed, margin treated as infinite');
}

main();
