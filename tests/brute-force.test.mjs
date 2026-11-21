/* 小规模暴力枚举对照：穷举所有镜头序列，验证 DP 结果成本最低且字典序最小 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RD = require('../src/solver.js');

function bruteForce(model, locks) {
  const n = model.beats.length;
  const S = model.shotIds.length;
  let best = null;
  const seq = new Array(n);

  function lexSmaller(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  function evalSeq() {
    let total = 0;
    let lastCut = -1;
    const cuts = [];
    for (let bi = 0; bi < n; bi++) {
      const si = seq[bi];
      if (locks.has(bi) && locks.get(bi) !== si) return null;
      const opt = model.perBeat[bi].options[si];
      if (!opt.feasible) return null;
      total += opt.missCost;
      if (bi > 0) {
        const prev = seq[bi - 1];
        if (si !== prev) {
          const edge = model.follow.get(model.shotIds[prev] + ' ' + model.shotIds[si]);
          if (edge !== undefined) total += edge;
          else {
            if (lastCut !== -1 && bi - lastCut < model.cutGap) return null;
            total += model.cutCost;
            lastCut = bi;
            cuts.push(bi);
          }
        }
      }
    }
    return { cost: total, seq: seq.slice(), cuts };
  }

  function rec(bi) {
    if (bi === n) {
      const r = evalSeq();
      if (!r) return;
      if (!best || r.cost < best.cost || (r.cost === best.cost && lexSmaller(r.seq, best.seq))) {
        best = r;
      }
      return;
    }
    for (let si = 0; si < S; si++) {
      seq[bi] = si;
      rec(bi + 1);
    }
  }
  rec(0);
  return best;
}

// 随机但确定性的场景
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test('DP 与暴力枚举在 30 个随机小场景上完全一致（含锁定/无解）', () => {
  const rand = rng(42);
  for (let caseNo = 0; caseNo < 30; caseNo++) {
    const S = 2 + Math.floor(rand() * 3);   // 2-4 镜头
    const N = 3 + Math.floor(rand() * 5);   // 3-7 拍
    const shots = {};
    for (let i = 0; i < S; i++) {
      const x = Math.floor(rand() * 20);
      shots['c' + i] = [x, 0, x + 8 + Math.floor(rand() * 6), 10];
    }
    const beats = [];
    for (let bi = 0; bi < N; bi++) {
      const b = { required: [], optional: [] };
      const rx = Math.floor(rand() * 30);
      b.required.push([rx, 2 + Math.floor(rand() * 4), rx + 1 + Math.floor(rand() * 2), 8]);
      if (rand() > 0.5) {
        const ox = Math.floor(rand() * 30);
        b.optional.push({ box: [ox, 1, ox + 2, 9], weight: 1 + Math.floor(rand() * 5) });
      }
      beats.push(b);
    }
    const input = {
      shots, inset: Math.floor(rand() * 2),
      cutCost: 3 + Math.floor(rand() * 6),
      cutGap: 1 + Math.floor(rand() * 3),
      follow: [],
      beats
    };
    // 随机加两条跟拍边
    for (let k = 0; k < 2; k++) {
      const a = Math.floor(rand() * S), c = Math.floor(rand() * S);
      if (a !== c) input.follow.push(['c' + a, 'c' + c, 1 + Math.floor(rand() * 3)]);
    }
    const model = RD.buildModel(input);
    const locks = new Map();
    if (rand() > 0.5) locks.set(Math.floor(rand() * N), Math.floor(rand() * S));
    const lockObj = {};
    locks.forEach((si, bi) => { lockObj[bi] = model.shotIds[si]; });

    const dp = RD.solve(model, lockObj);
    const brute = bruteForce(model, locks);

    if (!brute) {
      assert.equal(dp.ok, false, 'case ' + caseNo + ' 应无解');
    } else {
      assert.equal(dp.ok, true, 'case ' + caseNo + ' 应有解');
      assert.equal(dp.totalCost, brute.cost, 'case ' + caseNo + ' 成本不一致');
      assert.deepEqual(dp.sequenceIdx, brute.seq, 'case ' + caseNo + ' 字典序选择不一致');
      assert.deepEqual(dp.cutBeats, brute.cuts, 'case ' + caseNo + ' 硬切拍不一致');
    }
  }
});
