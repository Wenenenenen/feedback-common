/* 引擎验证：对照 samples/rail-switch-yard.json 的 expected 与 extra 用例 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Engine = require('../engine.js');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'samples', 'rail-switch-yard.json'), 'utf8')
);

let pass = 0;
function ok(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' -> ' + detail : ''}`);
  pass++;
  console.log(`  ✓ ${name}`);
}

// ---- 主样例：expected.heads + expected.switchChanges ----
{
  const { errors } = Engine.validate(sample);
  ok('主样例校验通过', errors.length === 0, errors.join('; '));

  const res = Engine.checkExpected(sample, sample.commands, sample.expected);
  ok('主样例逐步车头与扳道结果全部符合 expected', res.ok, res.errors.join('; '));

  const sim = Engine.run(sample, sample.commands);
  const h = sim.state.history;

  // 逐步核对关键语义
  ok('共推进 5 步', h.length === 5, `实际 ${h.length}`);

  const d = h.flatMap((r) => r.decisions);
  ok('前两次扳道被拒、第三次接受', d.map((x) => (x.accepted ? '接受' : '拒绝')).join(',') === '拒绝,拒绝,接受');
  ok('拒绝原因指出占用块', d[0].reason.includes('X'));
  ok('第 4 步接受时记录 from=X', d[2].from === 'X' && d[2].requested === 'Y');

  // 列车 A：A0,A1 -> X -> C0 -> C1（每步车身长度保持 2），第 3 步到站
  const a = h.map((r) => r.trains.find((t) => t.trainId === 'A'));
  ok('A 前 3 步移动、到站后不再移动', a.slice(0, 3).every((t) => t.moved) && a.slice(3).every((t) => !t.moved));
  ok('A 车身长度恒为 2', a.every((t) => t.bodyAfter.length === 2));
  ok('A 第 3 步到站 C1', a[2].headAfter === 'C1' && a[2].remainingAfter.length === 0);
  ok('A 在到达当步记录 arrived=true', a[2].arrived === true && a[2].moved === true);
  ok('A 到站后的步记录 arrived=true 且不再移动', a[3].arrived === true && a[3].moved === false);
  ok('A 到站后仍占用 C0,C1（步 5 全场占用 C0,C1,D0）',
    JSON.stringify(h[4].occupied.sort()) === JSON.stringify(['C0', 'C1', 'D0']));

  // 列车 B：道岔在第 4 步才扳到 Y，前 3 步因道岔朝向等待
  const b = h.map((r) => r.trains.find((t) => t.trainId === 'B'));
  ok('B 前 3 步因道岔朝向 X 等待', b.slice(0, 3).every((t) => !t.moved && t.waitReason.includes('道岔')));
  ok('B 第 4 步进 Y、第 5 步进 D0', b[3].headAfter === 'Y' && b[4].headAfter === 'D0');
  ok('B 第 5 步到站', b[4].remainingAfter.length === 0);

  // 步首占用检查：第 2 步 A 的车尾仍在 X，扳道必须拒绝
  ok('第 2 步 X 处于步首占用', h[1].trains.find((t) => t.trainId === 'A').body.includes('X'));
}

// ---- extra[0]：同目标块，编号靠前者抢到，后者等待 ----
{
  const ex = sample.extra[0];
  const res = Engine.checkExpected(ex, [], ex.expectedHeads);
  ok('extra[0] 终局车头符合', res.ok, res.errors.join('; '));
  const sim = Engine.run(ex, []);
  const step1 = sim.state.history[0];
  const a = step1.trains.find((t) => t.trainId === 'A');
  const b = step1.trains.find((t) => t.trainId === 'B');
  ok('A 抢到 J 并移动', a.moved && a.headAfter === 'J');
  ok('B 因 J 已被 A 抢到而等待', !b.moved && b.waitReason.includes('抢到'));
  ok('再推一步 J 仍步首被 A 占用，B 继续等待',
    !sim.step().trains.find((t) => t.trainId === 'B').moved);
}

// ---- extra[1]：双向边对头冲突，双方目标块步首被占，双双等待 ----
{
  const ex = sample.extra[1];
  const res = Engine.checkExpected(ex, [], ex.expectedHeads);
  ok('extra[1] 终局车头符合（死锁不动）', res.ok, res.errors.join('; '));
  const sim0 = Engine.run(ex, []);
  ok('开局即僵局，run() 不推进任何步', sim0.state.history.length === 0);
  const sim = Engine.createSimulation(ex, []);
  const step1 = sim.step();
  ok('双方都等待', step1.trains.every((t) => !t.moved));
  ok('等待原因是目标块步首被占', step1.trains.every((t) => t.waitReason.includes('步首')));
  ok('车头保持 L、R 不动', JSON.stringify(step1.heads) === JSON.stringify(['L', 'R']));
}

// ---- 锁：车尾完全退出后的下一步才能扳动 ----
{
  // 车身长度 2。移动序列：[A0,A1] ->(步2) [A1,X] ->(步3) [X,C0] ->(步4) [C0,C1]
  // X 在步 3 步首被车头占、步 4 步首被车尾占，步 5 步首才完全空闲。
  const lvl = {
    edges: [['A0', 'A1'], ['A1', 'X'], ['X', 'C0'], ['C0', 'C1']],
    switches: [{ id: 'S', positions: ['X', 'Y'], initial: 'X' }],
    trains: [{ id: 'A', body: ['A0', 'A1'], route: ['X', 'C0', 'C1'] }],
  };
  const sim = Engine.createSimulation(lvl, []);
  const r1 = sim.step({ S: 'Y' });
  ok('第 1 步扳道接受（步首车身 A0,A1，位置块 X 空闲）', r1.decisions[0].accepted);
  ok('第 1 步扳到 Y 后 A 因朝向不符等待', !r1.trains[0].moved && r1.trains[0].waitReason.includes('道岔'));
  const r2 = sim.step({ S: 'X' });
  ok('第 2 步扳回 X 接受且 A 移动', r2.decisions[0].accepted && r2.trains[0].moved);
  const r3 = sim.step({ S: 'Y' });
  ok('第 3 步扳道被拒（车头占 X）', !r3.decisions[0].accepted && r3.trains[0].moved);
  const r4 = sim.step({ S: 'Y' });
  ok('第 4 步扳道被拒（车尾占 X），A 同时移动到站',
    !r4.decisions[0].accepted && r4.trains[0].moved && r4.trains[0].remainingAfter.length === 0);
  const r5 = sim.step({ S: 'Y' });
  ok('第 5 步扳道接受（车尾已完全退出 X 的下一步）', r5.decisions[0].accepted);
}

// ---- 编号自然序 ----
ok('自然序 A<B<A2<A10',
  JSON.stringify(['A10', 'B', 'A2', 'A'].sort(Engine.naturalCompare)) === JSON.stringify(['A', 'A2', 'A10', 'B']));

// ---- 校验器 ----
{
  const bad = Engine.validate({
    edges: [['x', 'y']],
    switches: [],
    trains: new Array(17).fill(0).map((_, i) => ({ id: 'T' + i, body: ['x'], route: [] })),
  });
  ok('17 列车报错', bad.errors.some((e) => e.includes('16')));

  const dup = Engine.validate({
    edges: [['a', 'b'], ['b', 'c']],
    switches: [],
    trains: [
      { id: 'A', body: ['a'], route: [] },
      { id: 'B', body: ['a'], route: [] },
    ],
  });
  ok('初始车身重叠报错', dup.errors.some((e) => e.includes('重叠')));

  // 畸形输入不抛异常，只收集错误
  const malformed = Engine.validate({
    edges: [['only'], null, ['x', 'y']],
    switches: [{ id: 'S' }],
    trains: [{ id: 'A' }],
    commands: [['bad']],
  });
  ok('畸形边/道岔/列车/操作表只报错不抛异常', malformed.errors.length >= 4);
  ok('顶层非对象也不抛异常', Engine.validate(null).errors.length === 1);
}

console.log(`\n全部 ${pass} 项通过`);
