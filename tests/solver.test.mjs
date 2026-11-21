import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RD = require('../src/solver.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(fs.readFileSync(path.join(here, '..', 'samples', 'replay-shot-director.json'), 'utf8'));

test('样例主用例：最优序列 A,B,C 总成本 4，无硬切', () => {
  const model = RD.buildModel(sample);
  const r = RD.solve(model);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sequence, sample.expected.shots);
  assert.equal(r.totalCost, sample.expected.cost);
  assert.deepEqual(r.cutBeats, sample.expected.cutBeats);
});

test('样例锁镜用例：锁第 2 拍（索引 1）为 A -> A,A,C 成本 5，硬切拍 2（索引 2）', () => {
  const model = RD.buildModel(sample);
  const r = RD.solve(model, sample.lockCase.locks);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sequence, sample.lockCase.expected.shots);
  assert.equal(r.totalCost, sample.lockCase.expected.cost);
  assert.deepEqual(r.cutBeats, sample.lockCase.expected.cutBeats);
});

test('样例失败用例：最早不可排拍为索引 2（第 3 拍），原因是硬切间距不足', () => {
  const failInput = {
    shots: sample.shots, inset: sample.inset, follow: sample.follow,
    cutCost: sample.cutCost, cutGap: sample.cutGap,
    beats: sample.failure.beats
  };
  const model = RD.buildModel(failInput);
  const r = RD.solve(model);
  assert.equal(r.ok, false);
  assert.equal(r.firstImpossibleBeat, sample.failure.firstImpossibleBeat);
  assert.equal(r.reason, 'cut-gap');
  // 失败时给出最优可达前缀：第 2 拍只有 C(序号 2) 可行，故为 A->C，硬切代价 5
  assert.deepEqual(r.prefixBest.sequenceIdx, [0, 2]);
  assert.equal(r.prefixBest.cost, 5);
});

test('无跟拍边时相邻硬切受 cutGap 约束；放宽 cutGap 即可解', () => {
  const input = {
    shots: { L: [0, 0, 10, 10], R: [20, 0, 30, 10] },
    inset: 0, cutCost: 5, cutGap: 2,
    beats: [
      { required: [[1, 1, 2, 2]] },
      { required: [[21, 1, 22, 2]] },
      { required: [[1, 1, 2, 2]] }
    ]
  };
  const m1 = RD.buildModel(input);
  const r1 = RD.solve(m1);
  assert.equal(r1.ok, false);
  assert.equal(r1.firstImpossibleBeat, 2);

  const r2 = RD.solve(RD.buildModel({ ...input, cutGap: 1 }));
  assert.equal(r2.ok, true);
  assert.equal(r2.totalCost, 10);
  assert.deepEqual(r2.cutBeats, [1, 2]);
});

test('可选目标漏拍累加权重；入镜不收费', () => {
  const input = {
    shots: { S: [0, 0, 10, 10] },
    inset: 0, cutCost: 5, cutGap: 1,
    beats: [
      { optional: [{ box: [1, 1, 2, 2], weight: 3 }, { box: [8, 8, 9, 9], weight: 4 }] },
      { optional: [{ box: [50, 50, 51, 51], weight: 7 }] }
    ]
  };
  const r = RD.solve(RD.buildModel(input));
  assert.equal(r.ok, true);
  assert.equal(r.details[0].missCost, 0);
  assert.equal(r.details[1].missCost, 7);
  assert.equal(r.totalCost, 7);
});

test('贴边算完整入镜；inset 收紧后镜头可能不可用', () => {
  const input = {
    shots: { S: [0, 0, 10, 10] },
    inset: 1, cutCost: 1, cutGap: 1,
    beats: [{ required: [[1, 1, 9, 9]] }]
  };
  assert.equal(RD.solve(RD.buildModel(input)).ok, true);
  const r2 = RD.solve(RD.buildModel({ ...input, inset: 2 }));
  assert.equal(r2.ok, false);
  assert.equal(r2.firstImpossibleBeat, 0);
  assert.equal(r2.reason, 'no-eligible');
});

test('同价时取镜头编号序列字典序最小（按声明顺序，不按名字字符串）', () => {
  const input = {
    shots: { ten: [0, 0, 100, 100], six: [0, 0, 100, 100] },
    inset: 0, cutCost: 1, cutGap: 1,
    beats: [{ required: [[1, 1, 2, 2]] }, { required: [[1, 1, 2, 2]] }]
  };
  const r = RD.solve(RD.buildModel(input));
  // "six" 虽字符串更小，但声明序在第 2 位，应选声明序更靠前的 "ten"
  assert.deepEqual(r.sequence, ['ten', 'ten']);
});

test('跟拍边代价优先于硬切；重复同镜头零代价', () => {
  const input = {
    shots: { A: [0, 0, 10, 10], B: [10, 0, 20, 10] },
    inset: 0, cutCost: 9, cutGap: 5,
    follow: [['A', 'B', 2]],
    beats: [
      { required: [[1, 1, 2, 2]] },
      { required: [[11, 1, 12, 2]] },
      { required: [[11, 1, 12, 2]] }
    ]
  };
  const r = RD.solve(RD.buildModel(input));
  assert.equal(r.ok, true);
  assert.deepEqual(r.sequence, ['A', 'B', 'B']);
  assert.equal(r.totalCost, 2);
  assert.equal(r.details[1].transition, 'follow');
  assert.equal(r.details[2].transition, 'stay');
});

test('锁定不可行镜头直接在该拍报失败', () => {
  const input = {
    shots: { A: [0, 0, 10, 10], B: [20, 0, 30, 10] },
    inset: 0, cutCost: 5, cutGap: 1,
    beats: [{ required: [[1, 1, 2, 2]] }, { required: [[21, 1, 22, 2]] }]
  };
  const r = RD.solve(RD.buildModel(input), { 0: 'B' });
  assert.equal(r.ok, false);
  assert.equal(r.firstImpossibleBeat, 0);
  assert.equal(r.reason, 'lock-infeasible');
});

test('非法输入抛出明确错误', () => {
  assert.throws(() => RD.buildModel({}), /shots/);
  assert.throws(() => RD.buildModel({ shots: { A: [0, 0, 1, 1] }, beats: 'x' }), /beats/);
  assert.throws(() => RD.buildModel({ shots: { A: [0, 0, 1, 1] }, cutGap: 0, beats: [] }), /cutGap/);
  assert.throws(() => RD.buildModel({ shots: { A: [0, 0, 1, 1] }, cutGap: -1, beats: [] }), /cutGap/);
  assert.throws(() => RD.buildModel({
    shots: { A: [0, 0, 1, 1] },
    follow: [['A', 'Z', 1]], beats: []
  }), /未知镜头/);
});

test('空 beats 返回空方案；超规模报错', () => {
  const r = RD.solve(RD.buildModel({ shots: { A: [0, 0, 1, 1] }, beats: [] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.sequence, []);
  assert.throws(() => RD.buildModel({
    shots: { A: [0, 0, 1, 1] },
    beats: Array.from({ length: 241 }, () => ({}))
  }), /240/);
});

test('成本明细：subtotal 与 cumulative 一致，锁定标记正确', () => {
  const model = RD.buildModel(sample);
  const r = RD.solve(model, { 1: 'A' });
  r.details.forEach((d, i) => {
    assert.equal(d.subtotal, d.missCost + d.transitionCost);
    if (i > 0) assert.equal(d.cumulative, r.details[i - 1].cumulative + d.subtotal);
  });
  assert.equal(r.details[1].locked, true);
  assert.equal(r.details[0].locked, false);
  assert.equal(r.totalCost, r.details[r.details.length - 1].cumulative);
});

test('浮点 cutGap：差 2 满足 1.5 下限；差 1 不满足', () => {
  const base = {
    shots: { L: [0, 0, 10, 10], R: [20, 0, 30, 10] },
    inset: 0, cutCost: 5,
    beats: [
      { required: [[1, 1, 2, 2]] },
      { required: [[21, 1, 22, 2]] },
      { required: [[1, 1, 2, 2]] }
    ]
  };
  // cutGap=1.5：硬切在拍 1、2，差 1 < 1.5 -> 无解
  const r1 = RD.solve(RD.buildModel({ ...base, cutGap: 1.5 }));
  assert.equal(r1.ok, false);
  assert.equal(r1.firstImpossibleBeat, 2);
  // cutGap=0.5：差 1 >= 0.5 -> 合法，两次硬切
  const r2 = RD.solve(RD.buildModel({ ...base, cutGap: 0.5 }));
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.cutBeats, [1, 2]);
});

test('跟拍边重复声明取最小代价', () => {
  const input = {
    shots: { A: [0, 0, 10, 10], B: [10, 0, 20, 10] },
    inset: 0, cutCost: 9, cutGap: 1,
    follow: [['A', 'B', 4], ['A', 'B', 2]],
    beats: [
      { required: [[1, 1, 2, 2]] },
      { required: [[11, 1, 12, 2]] }
    ]
  };
  const r = RD.solve(RD.buildModel(input));
  assert.equal(r.totalCost, 2);
});
