/* 满额性能测试：240 帧 × 128×72 × 6000 候选窗口，要求求解 < 15 秒 */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'solver.js'));

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function genFull(seed) {
  const rand = rng(seed);
  const W = 128, H = 72, F = 240, NCOL = 32;
  const palette = [];
  for (let i = 0; i < NCOL; i++) palette.push([Math.floor(rand()*256), Math.floor(rand()*256), Math.floor(rand()*256)]);
  const frames = [];
  const winPerFrame = 25; // 240 × 25 = 6000，顶满上限
  for (let f = 0; f < F; f++) {
    // 移动的前景块 + 随机噪点（稀疏覆盖）
    const cx = Math.floor(64 + 50 * Math.cos(f / 20)), cy = Math.floor(36 + 28 * Math.sin(f / 13));
    const pixels = Array.from({ length: H }, () => new Array(W).fill(0));
    for (let i = 0; i < 60; i++) {
      const x = Math.max(0, Math.min(W - 1, cx + Math.floor((rand() - 0.5) * 24)));
      const y = Math.max(0, Math.min(H - 1, cy + Math.floor((rand() - 0.5) * 16)));
      pixels[y][x] = 1 + Math.floor(rand() * NCOL);
    }
    for (let i = 0; i < 12; i++) pixels[Math.floor(rand()*H)][Math.floor(rand()*W)] = 1 + Math.floor(rand() * NCOL);
    const windows = [[0, 0, W, H]]; // 保底全屏窗口
    for (let i = 1; i < winPerFrame; i++) {
      if (i % 3 === 0) { // 围绕前景块的窗口
        const x0 = Math.max(0, cx - 4 - Math.floor(rand() * 20)), y0 = Math.max(0, cy - 4 - Math.floor(rand() * 12));
        windows.push([x0, y0, Math.min(W, x0 + 8 + Math.floor(rand() * 40)), Math.min(H, y0 + 6 + Math.floor(rand() * 24))]);
      } else { // 随机窗口
        const x0 = Math.floor(rand() * W), y0 = Math.floor(rand() * H);
        windows.push([x0, y0, x0 + 1 + Math.floor(rand() * (W - x0)), y0 + 1 + Math.floor(rand() * (H - y0))]);
      }
    }
    frames.push({ pixels, windows });
  }
  return { width: W, height: H, palette, frames };
}

const input = genFull(42);
const errs = S.validate(input);
if (errs.length) { console.error('生成输入未通过校验:', errs); process.exit(1); }
const totalWin = input.frames.reduce((s, f) => s + f.windows.length, 0);
console.log(`输入：${input.width}×${input.height}，${input.frames.length} 帧，${totalWin} 个候选窗口`);

const norm = S.normalize(input);
const t0 = process.hrtime.bigint();
const gen = S.createSolver(norm).solve();
let r, lastProg = 0;
while (!(r = gen.next()).done) lastProg = r.value.frame;
const res = r.value;
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;
console.log(`求解耗时：${ms.toFixed(0)} ms（预算 15000 ms）`);
if (!res.ok) {
  console.log(`结果：不可行，最早不可达帧 = 第 ${res.failFrame} 帧，前一帧可达状态 ${res.failStates.length} 个`);
} else {
  console.log(`结果：总代价 ${res.totalCost} 字节`);
  const t2 = process.hrtime.bigint();
  const sim = S.simulate(norm, res.plan);
  const bin = S.buildSOP1(norm, res.plan, sim);
  const parsed = S.parseSOP1(bin);
  const replay = S.simulateSOP1(parsed);
  let bad = 0;
  for (let f = 1; f <= norm.F; f++) if (replay[f-1].disp.join(',') !== norm.T[f].join(',')) bad++;
  const t3 = process.hrtime.bigint();
  console.log(`模拟+导出+回放校验：${Number(t3-t2)/1e6 | 0} ms，${bad === 0 ? '240 帧全部逐像素一致 ✓' : bad + ' 帧不一致 ✗'}`);
  console.log(`SOP1 文件 ${bin.length} 字节（含 ${4+2+2+2+32*3} 字节固定头）`);
  process.exit(ms < 15000 && bad === 0 ? 0 : 1);
}
