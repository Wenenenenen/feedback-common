// bench.js — 满额规模性能基准
import { solve } from '../app/js/solver.js';
import { makeInstance, normalize } from './gen.js';

const full = makeInstance(42, {
  takes: 8,
  cues: 240,
  perCue: 96,
  changes: 12,
  switchCost: 2,
  gap: 240,
  slotW: 4000,
  takeLen: 48000 * 180,
  costMax: 20,
  idMode: 'shuffled',
  monotonicSrc: true,
});

const inst = normalize(full);
console.log(`规模: ${inst.cues.length} 句 × 96 候选, ${inst.takes.length} 轨, 切轨上限 ${inst.changes}`);

// 预热
const warm = solve(inst);
console.log(`可行性: ok=${warm.ok} 代价=${warm.totalCost} 切轨=${warm.switches}`);

const runs = 5;
const times = [];
for (let i = 0; i < runs; i++) {
  const r = solve(inst);
  times.push(r.solveMs);
  console.log(
    `run ${i + 1}: ${r.solveMs.toFixed(1)} ms  状态总数=${r.states}  结果代价=${r.totalCost} 切轨=${r.switches}`
  );
}
console.log(`平均 ${(times.reduce((a, b) => a + b, 0) / runs).toFixed(1)} ms, 最快 ${Math.min(...times).toFixed(1)} ms`);

// 最恶劣形态: 所有候选两两兼容 -> 状态数饱和 96*13*240
const dense = makeInstance(7, {
  takes: 8, cues: 240, perCue: 96, changes: 12, switchCost: 2,
  gap: 0, slotW: 100000, minLen: 100, maxLen: 200, costMax: 3,
  takeLen: 48000 * 180, monotonicSrc: true,
});
const dInst = normalize(dense);
const r2 = solve(dInst);
console.log(`\n密集兼容形态: ok=${r2.ok} ${r2.solveMs.toFixed(1)} ms 状态总数=${r2.states}`);

// 无解检测: 切轨预算 0 且源坐标故意倒退 -> 必然在某句死掉
const dead = makeInstance(99, {
  takes: 8, cues: 240, perCue: 96, changes: 0, switchCost: 2,
  gap: 240, slotW: 4000, takeLen: 48000 * 180,
});
// 只保留每句第一个候选, 并把它们的 src 改成倒退序列
dead.cues.forEach((cue, k) => {
  cue.candidates = [cue.candidates[0]];
  cue.candidates[0][2] = 100000 - k * 10;
});
const r3 = solve(normalize(dead));
console.log(`\n无解形态: ok=${r3.ok} failedCue=${r3.failedCue} 耗时=${r3.solveMs.toFixed(1)} ms`);

// 带锁定的重算(锁定一个槽内合法候选)
const lockCand = inst.cues[10].candidates.find(
  (c) => c.dst >= inst.cues[10].slot[0] && c.dst + c.len <= inst.cues[10].slot[1]
);
const locks = new Map([[10, lockCand.id], [120, inst.cues[120].candidates[0].id]]);
const r4 = solve(inst, { locks });
console.log(`\n双锁定重算: ${r4.solveMs.toFixed(1)} ms ok=${r4.ok} 代价=${r4.totalCost} 锁定生效=${r4.ok && r4.ids[10] === lockCand.id}`);
