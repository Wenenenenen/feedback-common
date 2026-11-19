'use strict';
/* 用样例包里的 expected 值验证引擎语义；node test/engine.test.js */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const SAMPLES = path.join(__dirname, '..', 'samples');
// 测试直接从 zip 解压目录或 samples 目录读取；优先 samples 下已解压文件
function loadSample(name) {
  const p1 = path.join(SAMPLES, name);
  if (fs.existsSync(p1)) return JSON.parse(fs.readFileSync(p1, 'utf8'));
  throw new Error(`缺少样例 ${name}，请先解压 samples/reactive-tree-courier-cases.zip 到 samples/`);
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

function runTicks(tree, run, n, afterEach) {
  const nm = E.buildNodeMap(tree);
  for (let i = 0; i < n; i++) {
    E.step(run, tree, nm);
    if (afterEach) afterEach(run.tick - 1, run);
  }
}

/* ---------- preemption.json：高优先级抢占，中止旧分支且不回退位置 ---------- */
{
  console.log('preemption.json');
  const spec = loadSample('preemption.json');
  const v = E.validateTree(spec);
  check('校验通过', v.ok, v.errors.join('; '));
  const run = E.createRun(spec);
  const nm = E.buildNodeMap(spec);
  const posAt = {};
  for (let t = 0; t < 3; t++) {
    E.step(run, spec, nm);
    posAt[t] = [...run.position];
  }
  const exp = spec.expected.positions;
  check('tick0 位置 [0.05,0]', near(posAt[0][0], exp['0'][0]) && near(posAt[0][1], exp['0'][1]), JSON.stringify(posAt[0]));
  check('tick1 位置 [0.1,0]', near(posAt[1][0], exp['1'][0]) && near(posAt[1][1], exp['1'][1]), JSON.stringify(posAt[1]));
  check('tick2 位置 [0.05,0]（抢占后朝新目标，不回退）', near(posAt[2][0], exp['2'][0]) && near(posAt[2][1], exp['2'][1]), JSON.stringify(posAt[2]));
  const abort = run.trace.find((e) => e.tick === 2 && e.to === 'aborted');
  check('tick2 记录 abort 且节点为 normal', !!abort && abort.node === spec.expected.abortAt2,
    JSON.stringify(run.trace.filter((e) => e.tick === 2)));
}

/* ---------- memory.json：记忆序列不重复执行已完成节点 ---------- */
{
  console.log('memory.json');
  const spec = loadSample('memory.json');
  const v = E.validateTree(spec);
  check('校验通过', v.ok, v.errors.join('; '));
  const run = E.createRun(spec);
  const nm = E.buildNodeMap(spec);
  const bbAt = {};
  for (let t = 0; t < 4; t++) {
    E.step(run, spec, nm);
    bbAt[t] = { ...run.blackboard };
  }
  check('tick2 counter=9（输入覆盖且 set 未重跑）', bbAt[2].counter === spec.expected.counterAt2, JSON.stringify(bbAt[2]));
  check('tick3 done=true', bbAt[3].done === spec.expected.doneAt3, JSON.stringify(bbAt[3]));
  const setExecs = run.trace.filter((e) => e.node === 'set' && e.to === 'success' && e.tick <= 3).length;
  check('set 到 tick3 只执行 1 次', setExecs === spec.expected.setExecutionsThrough3, `实际 ${setExecs}`);
}

/* ---------- stress.json：128 节点 ---------- */
{
  console.log('stress.json');
  const spec = loadSample('stress.json');
  check('恰好 128 节点', spec.nodes.length === 128, `${spec.nodes.length}`);
  const v = E.validateTree(spec);
  check('校验通过', v.ok, v.errors.join('; '));
  const run = E.createRun(spec);
  const nm = E.buildNodeMap(spec);
  const res = E.step(run, spec, nm);
  check('ticks=0 的 wait 链在 1 个 tick 内全部完成', res === 'success', res);
  check('根结束后整树复位', Object.keys(run.runtime).length === 0);
}

/* ---------- invalid-cycle.json：环必须被拒绝 ---------- */
{
  console.log('invalid-cycle.json');
  const spec = loadSample('invalid-cycle.json');
  const v = E.validateTree(spec);
  check('校验失败', !v.ok);
  check('报告环', v.errors.some((e) => e.includes('环')), v.errors.join('; '));
}

/* ---------- 共享子节点 / 无效参数 ---------- */
{
  console.log('手工构造的非法树');
  const shared = {
    root: 'r',
    nodes: [
      { id: 'r', type: 'reactiveSelector', children: ['a', 'b'] },
      { id: 'a', type: 'memorySequence', children: ['c'] },
      { id: 'b', type: 'memorySequence', children: ['c'] },
      { id: 'c', type: 'wait', ticks: 1 },
    ],
    position: [0, 0],
  };
  const v1 = E.validateTree(shared);
  check('共享子节点被拒绝', !v1.ok && v1.errors.some((e) => e.includes('共享')), v1.errors.join('; '));

  const badParams = {
    root: 'r',
    nodes: [
      { id: 'r', type: 'memorySequence', children: ['w', 'm', 'c'] },
      { id: 'w', type: 'wait', ticks: -1 },
      { id: 'm', type: 'move', target: [1], speed: 0 },
      { id: 'c', type: 'condition', key: 'x', equals: [1] },
    ],
    position: [0, 0],
  };
  const v2 = E.validateTree(badParams);
  check('负 ticks 被拒绝', v2.errors.some((e) => e.includes('ticks')), v2.errors.join('; '));
  check('非法 target/speed 被拒绝', v2.errors.some((e) => e.includes('target')) && v2.errors.some((e) => e.includes('speed')));
  check('非标量 equals 被拒绝', v2.errors.some((e) => e.includes('equals')));

  const tooMany = {
    root: 'n0',
    nodes: [{ id: 'n0', type: 'memorySequence', children: Array.from({ length: 127 }, (_, i) => `n${i + 1}`) },
      ...Array.from({ length: 127 }, (_, i) => ({ id: `n${i + 1}`, type: 'wait', ticks: 0 }))],
    position: [0, 0],
  };
  // 128 个可以，129 个不行
  check('128 节点上限内通过', E.validateTree(tooMany).ok);
  tooMany.nodes.push({ id: 'n128', type: 'wait', ticks: 0 });
  check('129 节点超限被拒绝', E.validateTree(tooMany).errors.some((e) => e.includes('上限')));
}

/* ---------- 快照/恢复：恢复后轨迹与不中断运行一致 ---------- */
{
  console.log('快照一致性');
  const spec = loadSample('preemption.json');
  // 不中断基准：连续跑 8 tick
  const base = E.createRun(spec);
  const nm = E.buildNodeMap(spec);
  const baseLog = [];
  for (let t = 0; t < 8; t++) {
    E.step(base, spec, nm);
    baseLog.push({ tick: t, pos: [...base.position], bb: { ...base.blackboard }, st: { ...base.status } });
  }
  // 中断：跑 3 tick → 快照 → 全新 run 恢复 → 再跑 5 tick
  const part = E.createRun(spec);
  for (let t = 0; t < 3; t++) E.step(part, spec, nm);
  const snap = E.snapshot(part);
  const restored = E.createRun(spec);
  E.restore(restored, snap);
  const restLog = [];
  for (let t = 0; t < 5; t++) {
    E.step(restored, spec, nm);
    restLog.push({ tick: restored.tick - 1, pos: [...restored.position], bb: { ...restored.blackboard }, st: { ...restored.status } });
  }
  let same = restLog.length === 5;
  for (let i = 0; i < 5 && same; i++) {
    const a = baseLog[3 + i];
    const b = restLog[i];
    if (a.tick !== b.tick || JSON.stringify(a.pos) !== JSON.stringify(b.pos) ||
        JSON.stringify(a.bb) !== JSON.stringify(b.bb) || JSON.stringify(a.st) !== JSON.stringify(b.st)) {
      same = false;
    }
  }
  check('恢复后 5 个 tick 的位置/黑板/状态与不中断运行完全一致', same,
    `base=${JSON.stringify(baseLog.slice(3))} rest=${JSON.stringify(restLog)}`);

  // 树被编辑后旧快照不能套用
  const edited = E.deepCopy(spec);
  edited.nodes.find((n) => n.id === 'normal').speed = 2;
  const run2 = E.createRun(edited);
  let threw = false;
  try { E.restore(run2, snap); } catch (e) { threw = /版本/.test(e.message); }
  check('树编辑后恢复快照被拒绝', threw);
}

/* ---------- 等待计数与序列游标确实进了快照 ---------- */
{
  console.log('快照内容');
  const spec = loadSample('memory.json');
  const run = E.createRun(spec);
  const nm = E.buildNodeMap(spec);
  E.step(run, spec, nm); // tick0：set 完成，wait 激活 count=0
  E.step(run, spec, nm); // tick1：wait count=1
  const snap = E.snapshot(run);
  check('快照含等待计数', snap.runtime.wait && snap.runtime.wait.count === 1, JSON.stringify(snap.runtime));
  check('快照含序列游标', snap.runtime.s && snap.runtime.s.cursor === 1, JSON.stringify(snap.runtime));
  check('快照含 tick/版本/黑板/位置',
    snap.tick === 2 && typeof snap.version === 'string' && !!snap.blackboard && Array.isArray(snap.position));
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
