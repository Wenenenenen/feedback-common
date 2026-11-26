// 满额性能基准（Node，可指定线程数）。
// 用法：node tests/bench.mjs [--seconds 90] [--copies 7] [--blocks 256] [--workers 1|4]
//
// 说明：Node 里并行跑 Worker 需浏览器端 Worker 模块；这里测两种口径：
//   1) 单线程内联引擎（与浏览器单线程回退同一条代码路径）
//   2) 生成 + 载入 + 对齐 + 投票逐段计时，并核对全部偏移等于真值

import { performance } from 'node:perf_hooks';
import { budgetScene } from '../tools/cases.mjs';
import { Engine } from '../src/js/engine.js';

function arg(argv, name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
}

const argv = process.argv.slice(2);
const seconds = arg(argv, 'seconds', 90);
const copies = arg(argv, 'copies', 7);
const blocks = arg(argv, 'blocks', 256);

console.log(`满额场景：${copies} 副本 × ${blocks} 块 × ${seconds} 秒`);

let t = performance.now();
const b = budgetScene(seconds, { copies, blocksPer: blocks });
const genMs = performance.now() - t;
console.log(`生成 ZIP        ${genMs.toFixed(0).padStart(6)} ms  ${(b.zip.length / 1e6).toFixed(1)} MB`);

t = performance.now();
const eng = await Engine.load(b.zip, { parallel: false });
const loadMs = performance.now() - t;
console.log(`载入 + 解码     ${loadMs.toFixed(0).padStart(6)} ms`);
console.log(`  （其中导入计时 ${eng.loadMs.toFixed(0)} ms）`);

t = performance.now();
const res = await eng.compute();
const computeMs = performance.now() - t;
const tm = res.timings;
console.log(`对齐 + 投票     ${computeMs.toFixed(0).padStart(6)} ms`);
console.log(`  评分 ${tm.score.toFixed(0)} ms · DP ${tm.dp.toFixed(0)} ms · 投票 ${tm.vote.toFixed(0)} ms`);

let mismatch = 0;
let total = 0;
for (let c = 0; c < copies; c++) {
  for (let i = 0; i < blocks; i++) {
    total++;
    if (res.copies[c].offsets[i] !== b.truth[c][i]) mismatch++;
  }
}
console.log(`偏移对照        ${mismatch === 0 ? '全部一致' : mismatch + ' / ' + total + ' 不一致'}（${total} 块）`);

const wav = eng.exportWav();
console.log(`WAV 字节数      ${wav.length}（应 = 44 + 4×${b.frames} = ${44 + 4 * b.frames}）`);
console.log(`争议声道帧      ${res.stats.disputes} / ${res.stats.channelFrames}`);

// 预算：从“点校对”到“可导出”的引擎部分必须 < 15 秒；单线程是最坏基线
const budgetOk = computeMs < 15000 && mismatch === 0 && wav.length === 44 + 4 * b.frames;
console.log(`\n${budgetOk ? 'PASS 预算 OK' : 'FAIL 超预算或有误'}  (${computeMs.toFixed(0)} ms / 15000 ms)`);
process.exit(budgetOk ? 0 : 1);
