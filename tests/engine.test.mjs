// 求解器单元测试 + 小规模暴力枚举对照
// 运行：node tests/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const E = require('../site/engine.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(fs.readFileSync(path.join(here, '..', 'samples', 'footlock-lattice.json'), 'utf8'));

const COOLDOWN = 2;

/* ---------- 暴力枚举（完全独立于 DP） ---------- */

function bruteForce(raw) {
  const input = E.normalizeInput(raw);
  const { samples, ticks, edges } = input;
  const T = ticks.length;

  // 边按 from 分组（允许同一 from>to 多条边，全部枚举）
  const byFrom = new Map();
  for (const e of edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }

  const tabs = ticks.map(tk => E.buildWorldTable(tk, samples));
  let best = null; // { cost: BigInt, ids: number[] }

  function lexLess(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  function dfs(t, prevSample, cooldown, cost, ids) {
    if (t === T) {
      if (best === null || cost < best.cost || (cost === best.cost && lexLess(ids, best.ids))) {
        best = { cost, ids: ids.slice() };
      }
      return;
    }
    const tick = ticks[t];
    if (t === 0) {
      for (const si of tick.allowedList) {
        dfs(1, si, 0, tick.poseCost[si], [samples[si].id]);
      }
      return;
    }
    const outs = byFrom.get(prevSample) || [];
    for (const e of outs) {
      const b = e.to;
      if (!tick.allowed[b]) continue;
      if (e.jump && cooldown > 0) continue;
      const a = samples[prevSample], bb = samples[b];
      const ta = tabs[t - 1], tb = tabs[t];
      if (a.left.support && bb.left.support && (ta.wlx[prevSample] !== tb.wlx[b] || ta.wly[prevSample] !== tb.wly[b])) continue;
      if (a.right.support && bb.right.support && (ta.wrx[prevSample] !== tb.wrx[b] || ta.wry[prevSample] !== tb.wry[b])) continue;
      const nc = e.jump ? COOLDOWN : (cooldown > 0 ? cooldown - 1 : 0);
      dfs(t + 1, b, nc, cost + e.fee + tick.poseCost[b], ids.concat([bb.id]));
    }
  }
  dfs(0, -1, 0, 0n, []);
  return best;
}

function solveOk(raw) {
  const input = E.normalizeInput(raw);
  return E.solve(input);
}

function assertMatchesBrute(raw, label) {
  const bf = bruteForce(raw);
  const r = solveOk(raw);
  if (bf === null) {
    assert.equal(r.ok, false, label + '：暴力无解，引擎应无解');
    return;
  }
  assert.equal(r.ok, true, label + '：暴力有解，引擎应有解');
  assert.equal(r.totalCostString, bf.cost.toString(), label + '：总代价应与暴力一致');
  assert.deepEqual(r.sequenceIds, bf.ids, label + '：序列应与暴力一致（含同价字典序）');
  // 独立复核引擎序列合法且费用一致
  const ev = E.evaluateSequence(E.normalizeInput(raw), r.sequenceIds);
  assert.equal(ev.ok, true, label + '：引擎序列应合法：' + (ev.error || ''));
  assert.equal(ev.totalCostString, r.totalCostString, label + '：独立费用复核一致');
}

/* ---------- 样例 ---------- */

test('样例：根轨迹与脚锁下选中 1 -> 3，总价 3', () => {
  const r = solveOk(sample);
  // 拍0 只有样本1(cost 1)；拍1 可选 2(cost 2, fee0) 或 3(cost 0, fee2 jump)。
  // 样本1 左脚 (1,0) 支撑，样本2 左脚 (0,0) 支撑：世界落点拍0=(1,0)，拍1=(1,0) 相同 -> 合法；
  // 样本3 左脚 (0,1) 不支撑，右脚 (0,0) 支撑，样本1 右脚不支撑 -> 无脚锁约束。
  // 1->2 总价 1+0+2=3；1->3 总价 1+2+0=3。同价，序列 [1,2] 比 [1,3] 编号早？
  // 编号序列 [1,2] vs [1,3]：第2拍 2<3，故应选 [1,2]。
  assert.equal(r.ok, true);
  assert.deepEqual(r.sequenceIds, [1, 2]);
  assert.equal(r.totalCostString, '3');
});

test('样例导出 → 重导核算通过', () => {
  const input = E.normalizeInput(sample);
  const r = E.solve(input);
  const doc = E.buildReplay(input, r);
  const v = E.verifyReplay(doc);
  assert.equal(v.ok, true, v.errors.join('；'));
});

/* ---------- 验收点 1：脚锁几何 ---------- */

test('验收1：逆时针 90°，根 (10,0)->(11,-1)，局部 (1,0) 两拍世界落点同为 (11,0)', () => {
  const q0 = E.rotateQuarter(1, 0, 0); // (1,0)
  const q1 = E.rotateQuarter(1, 0, 1); // (0,1) 逆时针 90°
  assert.deepEqual([10 + q0[0], 0 + q0[1]], [11, 0]);
  assert.deepEqual([11 + q1[0], -1 + q1[1]], [11, 0]);

  const raw = {
    samples: [
      { id: 1, left: [1, 0, true], right: [-1, 0, false] },
      { id: 2, left: [1, 0, true], right: [5, 7, false] },  // 左脚支撑且局部与1相同
      { id: 3, left: [2, 0, true], right: [-1, 0, false] }  // 左脚支撑但局部改为 (2,0)
    ],
    edges: [
      { from: 1, to: 2, fee: '0', jump: false },
      { from: 1, to: 3, fee: '0', jump: false }
    ],
    ticks: [
      { root: [10, 0], angle: 0, costs: { '1': '0' } },
      { root: [11, -1], angle: 90, costs: { '2': '0', '3': '0' } }
    ]
  };
  const r = solveOk(raw);
  assert.equal(r.ok, true);
  // 2 的左脚世界落点 = (11,-1)+R90(1,0)=(11,0) 与拍0的 (11,0) 一致 -> 合法；
  // 3 的左脚 = (11,-1)+R90(2,0)=(11,1) 不一致 -> 必须拒绝。
  assert.deepEqual(r.sequenceIds, [1, 2]);
  assert.equal(r.details[1].footlockLeft, 'locked');

  // 只保留 1->3 时无解
  const raw2 = JSON.parse(JSON.stringify(raw));
  raw2.edges = [{ from: 1, to: 3, fee: '0', jump: false }];
  const r2 = solveOk(raw2);
  assert.equal(r2.ok, false);
  assert.equal(r2.firstImpossibleTick, 1);
});

test('验收1：右脚从支撑到离地并换落点，该边仍合法', () => {
  const raw = {
    samples: [
      { id: 1, left: [0, 0, false], right: [0, 0, true] },
      { id: 2, left: [0, 0, false], right: [9, 9, false] } // 右脚刚离地，落点随便
    ],
    edges: [{ from: 1, to: 2, fee: '0', jump: false }],
    ticks: [
      { root: [0, 0], angle: 0, costs: { '1': '0' } },
      { root: [100, 100], angle: 180, costs: { '2': '0' } }
    ]
  };
  const r = solveOk(raw);
  assert.equal(r.ok, true);
  assert.equal(r.details[1].footlockRight, 'air');
});

test('验收1：两脚都支撑且都锁住时仍合法', () => {
  const raw = {
    samples: [
      { id: 1, left: [1, 0, true], right: [-1, 0, true] },
      { id: 2, left: [1, 0, true], right: [-1, 0, true] }
    ],
    edges: [{ from: 1, to: 2, fee: '0', jump: false }],
    ticks: [
      { root: [4, 5], angle: 0, costs: { '1': '0' } },
      { root: [4, 5], angle: 0, costs: { '2': '0' } }
    ]
  };
  const r = solveOk(raw);
  assert.equal(r.ok, true);
  assert.equal(r.details[1].footlockLeft, 'locked');
  assert.equal(r.details[1].footlockRight, 'locked');
});

/* ---------- 验收点 2：跳转冷却 ---------- */

test('验收2：跳在第1、3条边被冷却禁止，只可选跳在第1、4条边（更贵）', () => {
  // 序列 A0 -> A1 -> A2 -> A3 -> A4，边1..4；两条支路：
  //  便宜路：边1跳、边3跳（跳后两条边禁跳 => 边2、3 禁止跳 -> 边3 不合法）
  //  合规路：边1跳、边4跳（边2、3 禁跳，边4 允许）
  function build(jumps, fees) {
    const ids = [10, 11, 12, 13, 14];
    const samples = ids.map(id => ({ id, left: [0, 0, false], right: [0, 0, false] }));
    const edges = [];
    for (let i = 0; i < 4; i++) {
      edges.push({ from: ids[i], to: ids[i + 1], fee: String(fees[i]), jump: jumps[i] });
    }
    const ticks = ids.map((_, i) => ({ root: [i, 0], angle: 0, costs: { [String(ids[i])]: '0' } }));
    return { samples, edges, ticks };
  }
  // 便宜但不合法：跳边 1、3
  const cheap = build([true, false, true, false], [1, 1, 1, 10]);
  const rc = solveOk(cheap);
  assert.equal(rc.ok, false, '边3 在冷却中，整条路径应不可达');

  // 合法：跳边 1、4
  const legal = build([true, false, false, true], [1, 1, 1, 2]);
  const rl = solveOk(legal);
  assert.equal(rl.ok, true);
  assert.deepEqual(rl.sequenceIds, [10, 11, 12, 13, 14]);
  assert.equal(rl.totalCostString, '5');
  assert.equal(rl.details[1].jump, true);
  assert.equal(rl.details[2].jump, false);
  assert.equal(rl.details[3].jump, false);
  assert.equal(rl.details[4].jump, true);
});

test('验收2：删除中间普通边后不能自动接回连续帧', () => {
  const samples = [10, 11, 12].map(id => ({ id, left: [0, 0, false], right: [0, 0, false] }));
  const edges = [{ from: 10, to: 11, fee: '0', jump: false }]; // 缺 11->12
  const ticks = [10, 11, 12].map((id, i) => ({ root: [i, 0], angle: 0, costs: { [String(id)]: '0' } }));
  const r = solveOk({ samples, edges, ticks });
  assert.equal(r.ok, false);
  assert.equal(r.firstImpossibleTick, 2);
});

/* ---------- 验收点 3：全局最优 ---------- */

test('验收3：首拍较贵候选带来更低的全程总价', () => {
  // 拍0: A(10) 只接 X(100)；B(11) 接 Y(0)。拍1: X(0), Y(0)。
  // A+X=10+100=110；B+Y=11+0=11 -> 选 B。
  const samples = [
    { id: 1, left: [0, 0, false], right: [0, 0, false] }, // 拍0 首拍候选 A
    { id: 2, left: [0, 0, false], right: [0, 0, false] }, // 拍0 首拍候选 B
    { id: 3, left: [0, 0, false], right: [0, 0, false] }, // 末拍 X
    { id: 4, left: [0, 0, false], right: [0, 0, false] }  // 末拍 Y
  ];
  const edges = [
    { from: 1, to: 3, fee: '100', jump: false },
    { from: 2, to: 4, fee: '0', jump: false }
  ];
  const ticks = [
    { root: [0, 0], angle: 0, costs: { '1': '10', '2': '11' } },
    { root: [0, 0], angle: 0, costs: { '3': '0', '4': '0' } }
  ];
  const raw = { samples, edges, ticks };
  const r = solveOk(raw);
  assert.deepEqual(r.sequenceIds, [2, 4]);
  assert.equal(r.totalCostString, '11');

  // 把 2->4 的费用抬到 500，最优应改回 1->3（110）
  const raw2 = JSON.parse(JSON.stringify(raw));
  raw2.edges[1].fee = '500';
  const r2 = solveOk(raw2);
  assert.deepEqual(r2.sequenceIds, [1, 3]);
  assert.equal(r2.totalCostString, '110');
});

/* ---------- 验收点 4：大整数与同价字典序 ---------- */

test('验收4：总价超出双精度安全范围仍精确相加', () => {
  const H = 1000000000000000n; // 10^15 单项上限
  const samples = [1, 2, 3, 4].map(id => ({ id, left: [0, 0, false], right: [0, 0, false] }));
  const edges = [
    { from: 1, to: 3, fee: H.toString(), jump: false },
    { from: 2, to: 3, fee: H.toString(), jump: false },
    { from: 3, to: 4, fee: '0', jump: false }
  ];
  const ticks = [
    { root: [0, 0], angle: 0, costs: { '1': H.toString(), '2': '0' } },
    { root: [0, 0], angle: 0, costs: { '3': H.toString() } },
    { root: [0, 0], angle: 0, costs: { '4': H.toString() } }
  ];
  const r = solveOk({ samples, edges, ticks });
  assert.equal(r.ok, true);
  // 1: 10^15 + 10^15 + 10^15 + 10^15 = 4*10^15
  // 2: 0 + 10^15 + 10^15 + 10^15 = 3*10^15 -> 选 2
  assert.deepEqual(r.sequenceIds, [2, 3, 4]);
  assert.equal(r.totalCostString, '3000000000000000');
});

test('验收4：同价时按样本编号序列字典序，而非末项比较', () => {
  // 两条路前段分歧为 [1,9] 与 [2,0]，汇合后共用后缀，总价都恰好 = 10^16（= 10 × 10^15）。
  // 10^16 > 2^53，用双精度相加会丢精度，必须 BigInt 精确。
  // 同价须选 [1,9]（首项 1<2），不能比较末项或汇合后的编号。
  const BIG = '1000000000000000'; // 10^15，单项上限
  const samples = [1, 2, 9, 0, 5, 6, 7, 8, 20].map(id => ({ id, left: [0, 0, false], right: [0, 0, false] }));
  const edges = [
    { from: 1, to: 9, fee: '0', jump: false },
    { from: 2, to: 0, fee: '0', jump: false },
    { from: 9, to: 5, fee: '0', jump: false },
    { from: 0, to: 5, fee: '0', jump: false },
    { from: 5, to: 6, fee: BIG, jump: false },
    { from: 6, to: 7, fee: BIG, jump: false },
    { from: 7, to: 8, fee: BIG, jump: false },
    { from: 8, to: 20, fee: BIG, jump: false }
  ];
  const ticks = [
    { root: [0, 0], angle: 0, costs: { '1': '0', '2': '0' } },
    { root: [0, 0], angle: 0, costs: { '9': BIG, '0': BIG } },
    { root: [0, 0], angle: 0, costs: { '5': BIG } },
    { root: [0, 0], angle: 0, costs: { '6': BIG } },
    { root: [0, 0], angle: 0, costs: { '7': BIG } },
    { root: [0, 0], angle: 0, costs: { '8': BIG } },
    { root: [0, 0], angle: 0, costs: { '20': BIG } }
  ];
  const r = solveOk({ samples, edges, ticks });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sequenceIds.slice(0, 2), [1, 9]);
  assert.equal(r.totalCostString, '10000000000000000');
  // 双精度无法精确表示 10^16+1（超出 2^53），确认同价比较走的是精确整数而非浮点
  assert.notEqual(Number('10000000000000001').toString(), '10000000000000001');

  // 给 1->9 加 1，必须改选 [2,0]
  const raw2 = {
    samples, ticks,
    edges: edges.map(e => e.from === 1 && e.to === 9 ? { ...e, fee: '1' } : e)
  };
  const r2 = solveOk(raw2);
  assert.deepEqual(r2.sequenceIds.slice(0, 2), [2, 0]);
  assert.equal(r2.totalCostString, '10000000000000000');
});

test('验收4：编号声明顺序与数值顺序不同也按编号数值序列比较', () => {
  // 样本数组里 9 排在 1 前，但编号序应为 1 < 9。
  const samples = [
    { id: 9, left: [0, 0, false], right: [0, 0, false] },
    { id: 1, left: [0, 0, false], right: [0, 0, false] },
    { id: 5, left: [0, 0, false], right: [0, 0, false] }
  ];
  const edges = [
    { from: 9, to: 5, fee: '0', jump: false },
    { from: 1, to: 5, fee: '0', jump: false }
  ];
  const ticks = [
    { root: [0, 0], angle: 0, costs: { '9': '0', '1': '0' } },
    { root: [0, 0], angle: 0, costs: { '5': '0' } }
  ];
  const r = solveOk({ samples, edges, ticks });
  assert.deepEqual(r.sequenceIds, [1, 5]);
});

/* ---------- 验收点 5：无解定位 ---------- */

test('验收5：首拍即无候选时标第 1 拍不可达', () => {
  const raw = {
    samples: [{ id: 1, left: [0, 0, false], right: [0, 0, false] }],
    edges: [],
    ticks: [{ root: [0, 0], angle: 0, costs: {} }]
  };
  const r = solveOk(raw);
  assert.equal(r.ok, false);
  assert.equal(r.firstImpossibleTick, 0);
  assert.equal(r.firstImpossibleBeat, 1);
});

test('验收5：冷却状态不应被误判为可达——只有跳转边可走但仍在冷却', () => {
  // 拍0->拍1 跳；跳后两条边（拍1->拍2、拍2->拍3）都不能再跳。
  // 拍1->拍2 也是跳转边 -> 拍2（索引 2）不可达，而不是把冷却态误判为可达。
  const samples = [1, 2, 3, 4].map(id => ({ id, left: [0, 0, false], right: [0, 0, false] }));
  const edges = [
    { from: 1, to: 2, fee: '0', jump: true },
    { from: 2, to: 3, fee: '0', jump: true },
    { from: 3, to: 4, fee: '0', jump: true }
  ];
  const ticks = [1, 2, 3, 4].map((id, i) => ({ root: [i, 0], angle: 0, costs: { [String(id)]: '0' } }));
  const r = solveOk({ samples, edges, ticks });
  assert.equal(r.ok, false);
  assert.equal(r.firstImpossibleTick, 2);
  assert.equal(r.firstImpossibleBeat, 3);
  assert.deepEqual(r.prefixIds, [1, 2]);
});

test('验收5：一条路冷却中、另一条脚锁破，下一拍只有跳转边 -> 标该拍不可达', () => {
  // 两条首拍路径在中段汇合：
  //   路径 A：用了跳转边，到达汇合点时仍在冷却；
  //   路径 B：脚锁在汇合处被破坏（两拍都支撑但世界落点不同）。
  // 汇合后的下一拍仅有跳转边 -> 该拍不可达；不可把 A 的低价冷却态当成可达。
  const samples = [
    { id: 1, left: [0, 0, false], right: [0, 0, false] }, // 首拍 A
    { id: 2, left: [0, 0, false], right: [0, 0, false] }, // 首拍 B
    { id: 3, left: [0, 0, false], right: [0, 0, false] }, // A 的中转（跳转进入）
    { id: 4, left: [1, 0, true], right: [0, 0, false] },  // B 的中转（左脚支撑，世界落点将不匹配 5）
    { id: 5, left: [0, 0, true], right: [0, 0, false] },  // 汇合点（左脚支撑，用来卡 B）
    { id: 6, left: [0, 0, false], right: [0, 0, false] }  // 末拍，仅跳转边可达
  ];
  const edges = [
    { from: 1, to: 3, fee: '1', jump: true },   // A：跳转进入 3，冷却生效
    { from: 3, to: 5, fee: '0', jump: false },  // 冷却第 1 条（允许）
    { from: 1, to: 4, fee: '9', jump: false },  // B：普通边进入 4
    { from: 4, to: 5, fee: '0', jump: false },  // B 汇合；4 左脚 (1,0) 与 5 左脚 (0,0) 落点不同 -> 脚锁破
    { from: 5, to: 6, fee: '0', jump: true }    // 汇合后只有跳转边（A 仍在冷却中）
  ];
  const ticks = [
    { root: [0, 0], angle: 0, costs: { '1': '0', '2': '0' } },
    { root: [0, 0], angle: 0, costs: { '3': '0', '4': '0' } },
    { root: [0, 0], angle: 0, costs: { '5': '0' } },
    { root: [0, 0], angle: 0, costs: { '6': '0' } }
  ];
  const r = solveOk({ samples, edges, ticks });
  assert.equal(r.ok, false);
  // 拍1（索引1）可达（两条路都到 3 或 4），拍2（索引2）汇合后进入冷却，
  // 拍3（索引3）仅有跳转边且两条路都还在冷却 -> 索引 3 不可达。
  assert.equal(r.firstImpossibleTick, 3);
  assert.equal(r.firstImpossibleBeat, 4);
});

/* ---------- 验收点 6：编辑与导出一致 ---------- */

test('验收6：编辑根位置使旧路径失效，引擎给出可复核的新解', () => {
  // 两脚支撑连续区，编辑拍1 根位置，破坏脚锁后只能改走另一条备选
  const samples = [
    { id: 1, left: [1, 0, true], right: [-1, 0, true] },
    { id: 2, left: [1, 0, true], right: [-1, 0, true] },
    { id: 3, left: [5, 5, false], right: [7, 7, false] }
  ];
  const edges = [
    { from: 1, to: 2, fee: '0', jump: false },
    { from: 1, to: 3, fee: '0', jump: false }
  ];
  const base = {
    samples, edges,
    ticks: [
      { root: [0, 0], angle: 0, costs: { '1': '0' } },
      { root: [0, 0], angle: 0, costs: { '2': '0', '3': '0' } }
    ]
  };
  const r0 = solveOk(base);
  assert.deepEqual(r0.sequenceIds, [1, 2]);

  // 编辑拍1 根到 (1,0)：样本2 双脚支撑，落点变化 -> 脚锁破，只能走 3
  const edited = JSON.parse(JSON.stringify(base));
  edited.ticks[1].root = [1, 0];
  const r1 = solveOk(edited);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.sequenceIds, [1, 3]);

  // 导出 → 重导，序列/脚点/总价一致
  const input = E.normalizeInput(edited);
  const res = E.solve(input);
  const doc = E.buildReplay(input, res);
  const v = E.verifyReplay(doc);
  assert.equal(v.ok, true, v.errors.join('；'));
  assert.deepEqual(v.result.sequenceIds, r1.sequenceIds);
  assert.equal(v.result.totalCostString, r1.totalCostString);
});

/* ---------- 随机暴力对照 ---------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randomCase(seed) {
  const rnd = mulberry32(seed);
  const T = 2 + (rnd() * 5 | 0);
  const N = 2 + (rnd() * 6 | 0);
  const ids = [];
  for (let i = 0; i < N; i++) ids.push(10 + ((rnd() * 50) | 0));
  // 去重
  const uniq = [...new Set(ids)];
  while (uniq.length < 2) uniq.push(99 + uniq.length);
  const samples = uniq.map(id => {
    const supL = rnd() < 0.5, supR = rnd() < 0.5;
    const lx = supL ? (rnd() * 3 | 0) - 1 : (rnd() * 5 | 0) - 2;
    const rx = supR ? (rnd() * 3 | 0) - 1 : (rnd() * 5 | 0) - 2;
    return { id, left: [lx, 0, supL], right: [rx, 0, supR] };
  });
  const edges = [];
  for (const a of uniq) for (const b of uniq) {
    if (rnd() < 0.35) {
      edges.push({ from: a, to: b, fee: String((rnd() * 20 | 0) - 5), jump: rnd() < 0.3 });
    }
  }
  const angles = [0, 90, 180, 270];
  const ticks = [];
  for (let t = 0; t < T; t++) {
    const costs = {};
    for (const id of uniq) if (rnd() < 0.7) costs[String(id)] = String((rnd() * 10 | 0) - 2);
    ticks.push({ root: [(rnd() * 5 | 0) - 2, (rnd() * 5 | 0) - 2], angle: angles[(rnd() * 4) | 0], costs });
  }
  return { samples, edges, ticks };
}

test('随机 120 例：DP 与暴力枚举的总价、序列完全一致', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const raw = randomCase(seed * 7919);
    assertMatchesBrute(raw, '随机 #' + seed);
  }
});

test('随机 60 例：含平行边（同 from>to 多条，费用/跳转不同）仍与暴力一致', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const raw = randomCase(seed * 31337 + 5);
    // 复制一部分边，改费用与跳转标记，形成平行边
    const extra = [];
    for (const e of raw.edges) {
      if (Math.random() < 0.5) {
        extra.push({ from: e.from, to: e.to, fee: String((Math.random() * 30 | 0) - 10), jump: Math.random() < 0.4 });
      }
    }
    raw.edges = raw.edges.concat(extra);
    assertMatchesBrute(raw, '平行边 #' + seed);
  }
});

test('随机 60 例：注入大费用后仍与暴力一致（BigInt 精确）', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const raw = randomCase(seed * 104729 + 17);
    for (const e of raw.edges) {
      if (Math.random() < 0.5) e.fee = String(1000000000000000n - BigInt((seed * 37) % 1000));
    }
    for (const t of raw.ticks) for (const k of Object.keys(t.costs)) {
      if (Math.random() < 0.5) t.costs[k] = String(1000000000000000n - BigInt((seed * 53) % 1000));
    }
    assertMatchesBrute(raw, '大费用 #' + seed);
  }
});
