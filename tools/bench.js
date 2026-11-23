/*
 * 性能基准：node --max-old-space-size=2048 tools/bench.js
 * 模拟 1800 帧 × 24.88M 像素（上限内）的统计、求解与出表。
 */
'use strict';
const core = require('../src/core.js');

const W = 256, H = 54, N = 1800; // 24,883,200 px
const px = new Uint16Array(W * H * 3 * N);
let seed = 12345;
for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; px[i] = seed % 1024; }

const meta = {
  width: W, height: H,
  pts_us: Array.from({ length: N }, (_, i) => i * 40000),
  end_us: N * 40000,
  cuts: [0, 300, 600, 900, 1200, 1500],
  weights: new Array(N).fill(1),
  locks: [],
};

let t = performance.now();
const st = core.computeStats(px, W, H, N);
const t1 = performance.now();
const sol = core.solveAll(meta, st.suggested);
const t2 = performance.now();
const table = core.buildTable(meta, st, sol.exposure);
const t3 = performance.now();

console.log('规模       ' + W + '×' + H + ' × ' + N + ' 帧 = ' + (W * H * N) + ' px');
console.log('统计 P95   ' + (t1 - t).toFixed(0) + ' ms');
console.log('求解曝光   ' + (t2 - t1).toFixed(0) + ' ms');
console.log('出表       ' + (t3 - t2).toFixed(0) + ' ms');
console.log('合计       ' + (t3 - t).toFixed(0) + ' ms' + (sol.ok ? '' : '（无解）'));
console.log('表行数     ' + table.frames.length + ' / objective ' + sol.objective);
