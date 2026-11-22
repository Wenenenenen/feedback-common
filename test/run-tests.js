'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Selector = require('../selector.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'relay-respawn-selector.json'), 'utf8'));

function baseScenario() {
  const c = JSON.parse(JSON.stringify(sample));
  delete c.noSolution;
  delete c.island;
  delete c.format;
  return c;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { console.error('FAIL - ' + name); console.error(e.message); process.exitCode = 1; }
}

// 1. 主样例：a→Z, b→Y，安全分 [4,3]，集合总距离 5
test('主样例选点结果与期望一致', () => {
  const r = Selector.computeSelection(baseScenario());
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.result, '应有解');
  assert.strictEqual(r.result.assign.a, 'Z');
  assert.strictEqual(r.result.assign.b, 'Y');
  assert.deepStrictEqual(r.result.safety, [4, 3]);
  assert.strictEqual(r.result.minSafety, 3);
  assert.strictEqual(r.result.sumSafety, 7);
  assert.strictEqual(r.result.rallySum, 5);
});

// 2. 无解变体：移除 Z 后整批排不下，并给出冲突诊断
test('无解变体给出冲突诊断', () => {
  const cfg = baseScenario();
  cfg.sites = cfg.sites.filter(s => !(sample.noSolution.remove || []).includes(s.id));
  delete cfg.expected;
  const r = Selector.computeSelection(cfg);
  assert.strictEqual(r.result, null);
  assert.ok(r.failure, '应有失败诊断');
  assert.strictEqual(r.failure.maxPlaced, 1);
  assert.strictEqual(r.failure.unplaced.length, 1);
  const u = r.failure.unplaced[0];
  assert.ok(u.blockedBy && u.blockedBy.length > 0, '应列出被堵的候选点');
  assert.ok(u.blockedBy.every(b => b.conflicts.length > 0), '每个被堵候选点都应指明冲突对象');
});

// 3. 孤岛变体：X 在墙的另一侧，够不到接力点，只能选 Y
test('孤岛变体：够不到接力点的候选被淘汰', () => {
  const r = Selector.computeSelection(JSON.parse(JSON.stringify(sample.island)));
  assert.ok(r.result);
  assert.strictEqual(r.result.assign.a, 'Y');
  const reqA = r.requests.find(q => q.id === 'a');
  const candX = reqA.candidates.find(c => c.siteId === 'X');
  assert.ok(!candX.valid);
  assert.ok(candX.reasons.some(t => t.includes('接力点')), '淘汰原因应提到接力点: ' + candX.reasons);
});

// 4. 没有可达对手时安全分记 12
test('无对手时安全分为上限 12', () => {
  const r = Selector.computeSelection({
    grid: ['.....'],
    checkpoint: [2, 0],
    rally: { A: [0, 0] },
    active: [],
    minGap: 1,
    requests: [{ id: 'a', team: 'A' }],
    sites: [{ id: 'P', xy: [4, 0], teams: ['A'] }]
  });
  assert.strictEqual(r.result.assign.a, 'P');
  assert.deepStrictEqual(r.result.safety, [12]);
});

// 5. 安全分上限：对手很远时截断到 12
test('安全分截断到上限 12', () => {
  const grid = Array.from({ length: 1 }, () => '.'.repeat(30));
  const r = Selector.computeSelection({
    grid,
    checkpoint: [15, 0],
    rally: { A: [0, 0] },
    active: [{ team: 'B', xy: [29, 0] }],
    minGap: 1,
    requests: [{ id: 'a', team: 'A' }],
    sites: [{ id: 'P', xy: [0, 0], teams: ['A'] }]
  });
  assert.deepStrictEqual(r.result.safety, [12]); // 实际距离 29 → 截断为 12
});

// 6. 被在场机器人占用的候选点被淘汰
test('被占用的候选点被淘汰', () => {
  const r = Selector.computeSelection({
    grid: ['.....'],
    checkpoint: [2, 0],
    rally: { A: [0, 0] },
    active: [{ team: 'B', xy: [1, 0] }],
    minGap: 1,
    requests: [{ id: 'a', team: 'A' }],
    sites: [
      { id: 'P', xy: [1, 0], teams: ['A'] },
      { id: 'Q', xy: [4, 0], teams: ['A'] }
    ]
  });
  const reqA = r.requests.find(q => q.id === 'a');
  const candP = reqA.candidates.find(c => c.siteId === 'P');
  assert.ok(!candP.valid && candP.reasons.some(t => t.includes('占用')));
  assert.strictEqual(r.result.assign.a, 'Q');
});

// 7. 最小距离约束：同批落点距离必须 >= minGap
test('同批落点满足最小距离', () => {
  const r = Selector.computeSelection({
    grid: ['.........'],
    checkpoint: [4, 0],
    rally: { A: [0, 0], B: [8, 0] },
    active: [],
    minGap: 4,
    requests: [{ id: 'a', team: 'A' }, { id: 'b', team: 'B' }],
    sites: [
      { id: 'P', xy: [3, 0], teams: ['A', 'B'] },
      { id: 'Q', xy: [5, 0], teams: ['A', 'B'] },
      { id: 'R', xy: [0, 0], teams: ['A', 'B'] },
      { id: 'S', xy: [8, 0], teams: ['A', 'B'] }
    ]
  });
  assert.ok(r.result);
  const pa = r.result.assign.a, pb = r.result.assign.b;
  assert.notStrictEqual(pa, pb);
  const xs = { P: 3, Q: 5, R: 0, S: 8 };
  assert.ok(Math.abs(xs[pa] - xs[pb]) >= 4, pa + ' 与 ' + pb + ' 距离不足');
});

// 8. 前三项都打平时，按请求编号顺序取候选点编号字典序更小者
test('完全打平时按候选点编号定胜负', () => {
  const r = Selector.computeSelection({
    grid: ['.....'],
    checkpoint: [2, 0],
    rally: { A: [2, 0] },
    active: [],
    minGap: 1,
    requests: [{ id: 'a', team: 'A' }],
    sites: [
      { id: 'Q', xy: [3, 0], teams: ['A'] },
      { id: 'P', xy: [1, 0], teams: ['A'] }
    ]
  });
  // P、Q 安全分相同（12），到集合点 [2,0] 距离都是 1 → 编号小者 P 胜
  assert.strictEqual(r.result.assign.a, 'P');
});

// 9. 集合总距离作为第三排序键
test('集合总距离更小者优先', () => {
  const r = Selector.computeSelection({
    grid: ['.......'],
    checkpoint: [3, 0],
    rally: { A: [0, 0] },
    active: [],
    minGap: 1,
    requests: [{ id: 'a', team: 'A' }],
    sites: [
      { id: 'F', xy: [6, 0], teams: ['A'] }, // 距集合点 6
      { id: 'N', xy: [1, 0], teams: ['A'] }  // 距集合点 1
    ]
  });
  assert.strictEqual(r.result.assign.a, 'N');
  assert.strictEqual(r.result.rallySum, 1);
});

console.log(passed + ' 个测试通过' + (process.exitCode ? '（存在失败）' : ''));
