/* test/run.js — 规则正确性与性能测试：node test/run.js */
'use strict';
const { parseModel, createSim } = require('../sim.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.error('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function masses(sim) { return Array.from(sim.state.mass); }

/* 1. 样例基准（手算结果） */
{
  const text = JSON.stringify({
    width: 3, height: 2, wrap: [true, false],
    cells: [
      { i: 0, mass: 29, w: [256, 512, 0, 0] },
      { i: 1, mass: 7, w: [0, 0, 0, 384] },
    ],
    events: [{ step: 1, i: 2, wall: true }],
  });
  const { model, errors } = parseModel(text);
  check('样例解析', !!model, JSON.stringify(errors));
  const sim = createSim(model, model.events);
  check('帧0', JSON.stringify(masses(sim)) === JSON.stringify([29, 7, 0, 0, 0, 0]));
  sim.stepOnce();
  check('帧1', JSON.stringify(masses(sim)) === JSON.stringify([7, 19, 7, 0, 3, 0]), masses(sim).join(','));
  // 帧1时格0（本步事件先生效：格2变墙）：左256→格2为墙退回，右512→格1，自留256；合并 512/512，各3.5，平局余数相同给小编号
  {
    const d = sim.allocDetail(0);
    const self = d.list.find(e => e.dest === 0), other = d.list.find(e => e.dest === 1);
    check('帧1格0分配 4/3', self.amount === 4 && other.amount === 3, JSON.stringify(d.list));
  }
  sim.stepOnce();
  check('帧2（墙冻结+封堵退回+平局小编号）', JSON.stringify(masses(sim)) === JSON.stringify([4, 15, 7, 0, 10, 0]), masses(sim).join(','));
}

/* 2. 绕回同一目的地合并：宽2横向周期，左右都指向同一格 */
{
  const { model } = parseModel(JSON.stringify({
    width: 2, height: 2, wrap: [true, false],
    cells: [{ i: 0, mass: 1024, w: [256, 256, 0, 0] }],
  }));
  const sim = createSim(model, []);
  sim.stepOnce();
  check('绕回合并 512/512', sim.state.mass[0] === 512 && sim.state.mass[1] === 512, masses(sim).join(','));
}

/* 3. 越界封堵退回本格 */
{
  const { model } = parseModel(JSON.stringify({
    width: 3, height: 3, wrap: [false, false],
    cells: [{ i: 0, mass: 1000, w: [512, 0, 512, 0] }], // 左、上均越界
  }));
  const sim = createSim(model, []);
  sim.stepOnce();
  check('越界全部退回', sim.state.mass[0] === 1000, masses(sim).join(','));
}

/* 4. 随机模型：质量守恒 + allocDetail 与 advect 逐步一致 */
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const W = 7, H = 5, N = W * H;
  const cells = [];
  for (let i = 0; i < N; i++) {
    if (rnd() < 0.5) {
      const w = [0, 0, 0, 0].map(() => Math.floor(rnd() * 300));
      const s = w.reduce((a, b) => a + b, 0);
      cells.push({ i, mass: Math.floor(rnd() * 5000), wall: rnd() < 0.1, w: w.map(v => Math.floor(v * 1024 / Math.max(s, 1) / 4)) });
    }
  }
  const events = [];
  for (let k = 0; k < 200; k++) {
    const e = { step: Math.floor(rnd() * 120), i: Math.floor(rnd() * N) };
    if (rnd() < 0.5) e.wall = rnd() < 0.5;
    else e.w = [0, 0, 0, 0].map(() => Math.floor(rnd() * 256));
    events.push(e);
  }
  const { model, errors } = parseModel(JSON.stringify({ width: W, height: H, wrap: [true, true], cells, events }));
  check('随机模型解析', !!model, JSON.stringify(errors && errors.slice(0, 3)));
  const sim = createSim(model, model.events);
  const total = sim.totalMass();
  let conserve = true, cross = true;
  for (let s = 0; s < 120; s++) {
    // 用 allocDetail 独立预测下一帧
    const pred = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = sim.allocDetail(i);
      if (a.frozen) { pred[i] += sim.state.mass[i]; continue; }
      for (const e of a.list) pred[e.dest] += e.amount;
    }
    sim.stepOnce();
    for (let i = 0; i < N; i++) if (sim.state.mass[i] !== pred[i]) { cross = false; break; }
    if (sim.totalMass() !== total) { conserve = false; break; }
  }
  check('120步总质量严格守恒', conserve);
  check('allocDetail 与出流引擎逐步一致', cross);
}

/* 5. 事件编辑后重算一致性（模拟撤销/改历史） */
{
  const base = {
    width: 5, height: 5, wrap: [true, true],
    cells: [{ i: 6, mass: 8000, w: [200, 200, 200, 200] }, { i: 7, mass: 3000, w: [0, 0, 0, 512] }],
  };
  const m1 = parseModel(JSON.stringify(base)).model;
  const simA = createSim(m1, []);
  for (let s = 0; s < 80; s++) simA.stepOnce();
  // 在第 10 步加一道墙，setEvents 后重算，应与全新模拟一致
  const ev = [{ seq: 0, step: 10, i: 7, wall: true }];
  simA.setEvents(ev, 10);
  while (simA.state.step < 80) simA.stepOnce();
  const simB = createSim(m1, ev);
  for (let s = 0; s < 80; s++) simB.stepOnce();
  check('改历史后重算与全新模拟一致', JSON.stringify(masses(simA)) === JSON.stringify(masses(simB)));
}

/* 6. 非法事件行号 */
{
  const bad = JSON.stringify({
    width: 3, height: 2, wrap: [true, false],
    events: [
      { step: 0, i: 1, wall: true },
      { step: 0, i: 99, wall: true },
      { step: -1, i: 0, w: [1, 2, 3, 4] },
      { step: 0, i: 0, w: [600, 600, 0, 0] },
    ],
  });
  const { model, errors } = parseModel(bad);
  check('非法事件被拒绝', !model);
  check('行号指向 2/3/4', errors && errors.map(e => e.line).join(',') === '2,3,4', JSON.stringify(errors));
}

/* 7. 性能：256×256、600步、4万条事件，末帧须 < 12 秒 */
{
  const W = 256, H = 256, N = W * H;
  const cells = [];
  for (let i = 0; i < N; i++) cells.push({ i, mass: 1000, w: [256, 256, 256, 256] });
  let seed = 999;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const events = [];
  for (let k = 0; k < 40000; k++) {
    const e = { step: Math.floor(rnd() * 600), i: Math.floor(rnd() * N) };
    if (rnd() < 0.5) e.wall = rnd() < 0.5;
    else e.w = [0, 0, 0, 0].map(() => Math.floor(rnd() * 257));
    events.push(e);
  }
  const { model, errors } = parseModel(JSON.stringify({ width: W, height: H, wrap: [true, true], cells, events }));
  check('大模型解析', !!model, JSON.stringify(errors && errors.slice(0, 2)));
  const sim = createSim(model, model.events);
  const total = sim.totalMass();
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < 600; s++) sim.stepOnce();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  256×256 × 600步（满格+4万事件）耗时 ' + ms.toFixed(0) + ' ms');
  check('末帧耗时 < 12 秒', ms < 12000, ms.toFixed(0) + 'ms');
  check('大规模质量守恒', sim.totalMass() === total);
}

console.log(failures ? '\n共 ' + failures + ' 项失败' : '\n全部通过');
process.exit(failures ? 1 : 0);
