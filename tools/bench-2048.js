#!/usr/bin/env node
/* 2048×2048 压力基准：每隔 4 格一个种子，32 标签循环，模拟最密集的满尺寸样张。
 * 分别测单线程 runLabels 全标签、以及模拟 worker 分批后 mergePartials 的总耗时。 */
'use strict';
const path = require('path');
const Core = require(path.join(__dirname, '..', 'js', 'sdt-core.js'));

function buildStress(W, H, step, nLabels) {
  // 确定性满铺：(c,r) 满足 c%step==0 && r%step==0，标签按 (c/step + r/step) 循环
  const labelCoords = new Map();
  for (let r = 0; r < H; r += step) {
    for (let c = 0; c < W; c += step) {
      const lab = 1 + (((c / step) + (r / step) * 2) % nLabels);
      if (!labelCoords.has(lab)) labelCoords.set(lab, []);
      labelCoords.get(lab).push(c, r);
    }
  }
  const coordMap = new Map();
  for (const [lab, arr] of labelCoords) coordMap.set(lab, Int32Array.from(arr));
  return coordMap;
}

function timeit(label, fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label}: ${ms.toFixed(0)} ms`);
  return { ms, r };
}

function main() {
  const W = 2048, H = 2048, step = 4, nLabels = 32;
  const sx = 1, sy = 1, wrap = true;
  const radius = 64, margin = 8;
  console.log(`网格 ${W}×${H}，每 ${step} 格一种子，标签数 ${nLabels}，wrap=${wrap}`);
  const coordMap = buildStress(W, H, step, nLabels);
  let totalSeeds = 0;
  for (const [, arr] of coordMap) totalSeeds += arr.length >> 1;
  console.log(`种子总数 ${totalSeeds}`);

  // 1) 单线程全标签
  const allIds = [...coordMap.keys()];
  const { ms: singleMs, r: topSingle } = timeit('单线程 runLabels(32 标签)', () =>
    Core.runLabels(W, H, coordMap, allIds, sx, sy, wrap, null));
  const fill1 = timeit('  applyFill', () => Core.applyFill(W, H, topSingle, radius, margin));

  // 2) 模拟 4 worker 分批 + 单独计时 merge
  const groups = [[], [], [], []];
  allIds.forEach((id, i) => groups[i % 4].push(id));
  const t0 = process.hrtime.bigint();
  const parts = groups.map(g => Core.runLabels(W, H, coordMap, g, sx, sy, wrap, null));
  const batchMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const tm = process.hrtime.bigint();
  const topMerged = Core.mergePartials(W, H, parts);
  const mergeMs = Number(process.hrtime.bigint() - tm) / 1e6;
  console.log(`4 批串行计算: ${batchMs.toFixed(0)} ms；mergePartials: ${mergeMs.toFixed(0)} ms`);
  const fillMerged = Core.applyFill(W, H, topMerged, radius, margin);

  // 3) 非环绕对照
  const t1 = process.hrtime.bigint();
  const topNoWrap = Core.runLabels(W, H, coordMap, allIds, sx, sy, false, null);
  const noWrapMs = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`单线程非环绕: ${noWrapMs.toFixed(0)} ms`);
  const fillNoWrap = Core.applyFill(W, H, topNoWrap, radius, margin);

  // 一致性：分批合并结果必须与单线程完全相同
  let diff = 0;
  for (let p = 0; p < W * H; p++) {
    if (topSingle.d1[p] !== topMerged.d1[p] || topSingle.l1[p] !== topMerged.l1[p] ||
        topSingle.d2[p] !== topMerged.d2[p] || topSingle.l2[p] !== topMerged.l2[p]) diff++;
  }
  console.log(`分批合并 vs 单线程不一致格数: ${diff}`);
  console.log(`填充格数: 单线程=${fill1.r.filled} 分批=${fillMerged.filled} 非环绕=${fillNoWrap.filled}`);

  // 理想墙钟：单线程总量按 worker 数均摊 + 串行 merge + fill
  const fillMs = 28;
  for (const nw of [4, 6, 8, 12]) {
    const ideal = (singleMs / nw) + mergeMs + fillMs;
    console.log(`  ${nw} worker 理想墙钟 ≈ ${ideal.toFixed(0)} ms ${ideal < 15000 ? '✓' : '✗'}`);
  }
  console.log(singleMs < 15000 ? `✓ 单线程达标` : `（单线程 ${singleMs.toFixed(0)}ms，依赖 worker 并行达标）`);
}

main();
