// run-tests.js — Node 对拍测试: node --experimental-vm-modules 不需要, 直接 node tests/run-tests.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solve } from '../app/js/solver.js';
import { makeInstance, normalize } from './gen.js';
import { bruteSolve } from './brute.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ---- 1. 样本数据冒烟 ----
{
  const raw = JSON.parse(readFileSync(join(here, '..', 'data-extracted', 'cues.json'), 'utf8'));
  const r = solve(normalize(raw));
  check('sample ok', r.ok, JSON.stringify(r));
  if (r.ok) {
    // 人工核算: 同轨 t0 三条都可选(源区间 0-6000, 7000-13000, 14000-20000 不重叠)
    // 候选代价 3+3+3=9, 零切轨 -> 最优
    check('sample total', r.totalCost === 9, `total=${r.totalCost}`);
    check('sample switches', r.switches === 0, `sw=${r.switches}`);
    check('sample ids', r.ids.join(',') === '0,2,4', `ids=${r.ids}`);
    check('sample gap', verifyTimeline(normalize(raw), r.ids, raw.gap));
  }
}

// ---- 2. 随机对拍(顺序编号 + 打乱编号) ----
for (const idMode of ['sequential', 'shuffled']) {
  for (let seed = 1; seed <= 400; seed++) {
    const raw = makeInstance(seed * 7919 + (idMode === 'shuffled' ? 1 : 0), {
      takes: 1 + (seed % 4),
      cues: 3 + (seed % 7),
      perCue: 2 + (seed % 7),
      changes: seed % 5,
      gap: (seed % 3) * 120,
      idMode,
      costMax: seed % 4 === 0 ? 0 : 9, // 部分实例全部零代价, 专打平局
    });
    const inst = normalize(raw);
    const dp = solve(inst);
    const bf = bruteSolve(raw);
    check(`fuzz-${idMode}-${seed} ok-flag`, dp.ok === bf.ok, `seed=${seed}`);
    if (dp.ok && bf.ok) {
      check(`fuzz-${idMode}-${seed} total`, dp.totalCost === bf.total,
        `seed=${seed} dp=${dp.totalCost} bf=${bf.total}`);
      check(`fuzz-${idMode}-${seed} switches`, dp.switches === bf.switches);
      check(`fuzz-${idMode}-${seed} ids`, dp.ids.join('.') === bf.ids.join('.'),
        `dp=[${dp.ids}] bf=[${bf.ids}]`);
      check(`fuzz-${idMode}-${seed} feasible`, verifyAll(inst, dp.ids, raw.changes, raw.gap));
    } else if (!dp.ok && !bf.ok) {
      check(`fuzz-${idMode}-${seed} failedCue`, dp.failedCue === bf.failedCue,
        `dp=${dp.failedCue} bf=${bf.failedCue}`);
    }
  }
}

// ---- 3. 锁定对拍 ----
for (let seed = 1; seed <= 200; seed++) {
  const raw = makeInstance(seed * 104729, {
    takes: 2 + (seed % 3),
    cues: 4 + (seed % 6),
    perCue: 3 + (seed % 6),
    changes: seed % 4,
    idMode: seed % 2 ? 'sequential' : 'shuffled',
  });
  const inst = normalize(raw);
  const lockCue = seed % inst.cues.length;
  const lockCand = inst.cues[lockCue].candidates[seed % inst.cues[lockCue].candidates.length];
  const locks = new Map([[lockCue, lockCand.id]]);
  const dp = solve(inst, { locks });
  const bf = bruteSolve(raw, locks);
  check(`lock-${seed} flag`, dp.ok === bf.ok, `seed=${seed}`);
  if (dp.ok && bf.ok) {
    check(`lock-${seed} total`, dp.totalCost === bf.total);
    check(`lock-${seed} ids`, dp.ids.join('.') === bf.ids.join('.'),
      `dp=[${dp.ids}] bf=[${bf.ids}]`);
    check(`lock-${seed} honored`, dp.ids[lockCue] === lockCand.id);
  } else if (!dp.ok && !bf.ok) {
    check(`lock-${seed} failedCue`, dp.failedCue === bf.failedCue,
      `dp=${dp.failedCue} bf=${bf.failedCue}`);
  }
}

// ---- 4. 手工构造的边界场景 ----
{
  // 同轨源区间倒退: 必须换轨或放弃
  const raw = {
    takes: ['t0.wav', 't1.wav'], frames: 10000, gap: 10, changes: 1, switchCost: 5,
    cues: [
      { slot: [0, 1000], candidates: [[0, 0, 500, 0, 400, 1], [1, 1, 0, 0, 400, 1]] },
      { slot: [500, 1500], candidates: [[2, 0, 100, 500, 300, 1], [3, 1, 500, 500, 300, 1]] },
    ],
  };
  const inst = normalize(raw);
  const r = solve(inst);
  check('src-regress ok', r.ok);
  // 选 id1(t1) + id3(t1): 同轨不重叠(0-400, 500-800), 代价2, 零切轨
  check('src-regress picks t1 chain', r.ids.join('.') === '1.3', `ids=${r.ids}`);
  check('src-regress cost', r.totalCost === 2);
}

{
  // 切轨预算 0 且唯一可行链需要切轨 -> 无解, failedCue 指向第二句
  const raw = {
    takes: ['t0.wav', 't1.wav'], frames: 10000, gap: 10, changes: 0, switchCost: 5,
    cues: [
      { slot: [0, 1000], candidates: [[0, 0, 0, 0, 400, 1]] },
      { slot: [500, 1500], candidates: [[1, 1, 0, 500, 300, 1]] },
    ],
  };
  const r = solve(normalize(raw));
  check('budget0 infeasible', !r.ok && r.failedCue === 1, JSON.stringify(r));
}

{
  // 候选超槽被过滤, 若整句都超槽则 failedCue=0
  const raw = {
    takes: ['t0.wav'], frames: 10000, gap: 10, changes: 0, switchCost: 5,
    cues: [
      { slot: [0, 500], candidates: [[0, 0, 0, 200, 400, 1]] }, // dst+len=600 > 500
    ],
  };
  const r = solve(normalize(raw));
  check('slot overflow cue0', !r.ok && r.failedCue === 0, JSON.stringify(r));
}

{
  // gap 不足: 第二句候选贴太近, 全部非法
  const raw = {
    takes: ['t0.wav'], frames: 10000, gap: 100, changes: 0, switchCost: 5,
    cues: [
      { slot: [0, 1000], candidates: [[0, 0, 0, 0, 500, 1]] },
      { slot: [0, 1200], candidates: [[1, 0, 600, 550, 100, 1]] }, // 间隔仅50
    ],
  };
  const r = solve(normalize(raw));
  check('gap infeasible', !r.ok && r.failedCue === 1, JSON.stringify(r));
}

{
  // 平局字典序: 两条链代价/切轨完全相同, 应取编号序列更小者
  const raw = {
    takes: ['t0.wav', 't1.wav'], frames: 10000, gap: 10, changes: 2, switchCost: 1,
    cues: [
      { slot: [0, 1000], candidates: [[7, 0, 0, 0, 100, 5], [3, 1, 0, 0, 100, 5]] },
      { slot: [200, 1200], candidates: [[9, 0, 200, 200, 100, 5], [4, 1, 200, 200, 100, 5]] },
    ],
  };
  const r = solve(normalize(raw));
  // 同轨链: [3,4](t1) 与 [7,9](t0), 代价均为10零切轨, 字典序 [3,4] 小
  check('lex tie ids', r.ids.join('.') === '3.4', `ids=${r.ids}`);
  check('lex tie cost', r.totalCost === 10 && r.switches === 0);
}

{
  // 打乱编号下的字典序(编号与候选数组顺序无关)
  const raw = {
    takes: ['t0.wav', 't1.wav'], frames: 10000, gap: 10, changes: 2, switchCost: 1,
    cues: [
      { slot: [0, 1000], candidates: [[12, 0, 0, 0, 100, 0], [2, 1, 0, 0, 100, 0]] },
      { slot: [200, 1200], candidates: [[11, 0, 200, 200, 100, 0], [5, 1, 200, 200, 100, 0]] },
    ],
  };
  const r = solve(normalize(raw));
  check('shuffled lex', r.ids.join('.') === '2.5', `ids=${r.ids}`);
}

{
  // 锁定超槽候选: failedCue 指向锁定句
  const raw = {
    takes: ['t0.wav'], frames: 10000, gap: 10, changes: 0, switchCost: 5,
    cues: [
      { slot: [0, 1000], candidates: [[0, 0, 0, 0, 400, 1], [1, 0, 0, 900, 400, 1]] },
    ],
  };
  const r = solve(normalize(raw), { locks: new Map([[0, 1]]) });
  check('lock overflow', !r.ok && r.failedCue === 0, JSON.stringify(r));
}

// ---- 校验工具 ----
function verifyAll(inst, ids, changes, gap) {
  const byId = new Map();
  inst.cues.forEach((cue, k) => cue.candidates.forEach((c) => byId.set(c.id, { c, k, cue })));
  let prev = null;
  let sw = 0;
  for (const id of ids) {
    const { c, cue } = byId.get(id);
    if (c.dst < cue.slot[0] || c.dst + c.len > cue.slot[1]) return false;
    if (prev) {
      if (c.dst < prev.dst + prev.len + gap) return false;
      if (c.take === prev.take && c.src < prev.src + prev.len) return false;
      if (c.take !== prev.take) sw++;
    }
    prev = c;
  }
  return sw <= changes;
}

function verifyTimeline(inst, ids, gap) {
  return verifyAll(inst, ids, inst.changes, gap);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
