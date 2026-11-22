/* Node 测试（运行：node -I tests/run-tests.js） */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RWS = require('../engine.js');

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try {
      await fn();
      passed++;
      console.log('  ok - ' + name);
    } catch (e) {
      console.error('FAIL - ' + name);
      console.error('  ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n  ') : e));
      process.exitCode = 1;
    }
  })());
}

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'replay-witness.json'), 'utf8'));

test('样本：校验通过、基线锁定 #1/score/+', () => {
  const v = RWS.validate(sample);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const model = RWS.buildModel(sample);
  const base = RWS.baseline(model);
  assert.ok(base.witness);
  assert.strictEqual(base.witness.eventIndex, 1);
  assert.strictEqual(base.witness.eventId, 'b');
  assert.strictEqual(base.witness.field, 'score');
  assert.strictEqual(base.witness.sign, '+');
  assert.strictEqual(base.witness.oldValue, 2);
  assert.strictEqual(base.witness.nextValue, 3);
});

test('样本：缩减到 [t,b] 两事件，见证三项全中，x 被删', () => {
  const model = RWS.buildModel(sample);
  const base = RWS.baseline(model);
  return RWS.shrink(model, base, {}).then((res) => {
    assert.strictEqual(res.status, 'finished');
    assert.deepStrictEqual(Array.from(res.alive), [0, 1]);
    assert.strictEqual(res.accepts, 1);
    const exp = RWS.buildExport(model, res.alive, res.witness, { rounds: res.rounds.length, trials: res.trials });
    assert.strictEqual(exp.events.length, 2);
    assert.strictEqual(exp.verification.witnessReproduced, true);
    assert.strictEqual(exp.witness.eventId, 'b');
    // 分块轨迹：第一轮 k=2 块 [t,b] 拒、[x] 受
    assert.strictEqual(res.rounds[0].k, 2);
    assert.deepStrictEqual(res.rounds[0].sizes, [2, 1]);
    assert.strictEqual(res.rounds[0].trials[0][3], 2); // 差异消失
    assert.strictEqual(res.rounds[0].trials[1][3], 0); // 接受
  });
});

test('样本：无差异时直接提示 no-diff', () => {
  const doc = JSON.parse(JSON.stringify(sample));
  doc.next.bonus = [[null, 'add', 'score', 2]];
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  assert.strictEqual(base.witness, null);
  return RWS.shrink(model, base, {}).then((res) => {
    assert.strictEqual(res.status, 'no-diff');
    assert.strictEqual(res.rounds.length, 0);
  });
});

test('回绕：add 按有符号 32 位回绕，符号按数学差值（旧正新负 → -）', () => {
  const doc = {
    initial: { s: 0 },
    observe: ['s'],
    old: { k: [[null, 'add', 's', 2147483647]] },
    next: { k: [[null, 'add', 's', 1]] },
    events: [{ id: 'e0', frame: 0, kind: 'k', deps: [] }],
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  assert.strictEqual(base.witness.oldValue, 2147483647);
  assert.strictEqual(base.witness.nextValue, 1);
  assert.strictEqual(base.witness.sign, '-');
});

test('回绕：负+负越过 -2^31 回绕成正数，数学差值仍判 +', () => {
  const doc = {
    initial: { s: -1 },
    observe: ['s'],
    old: { k: [[null, 'add', 's', -2147483648]] },   // -1 + -2^31 -> 2147483647
    next: { k: [[null, 'add', 's', 1]] },              // 0
    events: [{ id: 'e0', frame: 0, kind: 'k', deps: [] }],
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  assert.strictEqual(base.witness.oldValue, 2147483647);
  assert.strictEqual(base.witness.nextValue, 0);
  assert.strictEqual(base.witness.sign, '-');
});

test('set/add/条件/无匹配规则保持状态', () => {
  const doc = {
    initial: { a: 5, b: 0 },
    observe: ['a', 'b'],
    old: {
      gate: [['a', 'lt', 10, 'set', 'b', 7], [['a', 'eq', 5], 'add', 'a', 1]],
    },
    next: {
      gate: [['a', 'lt', 10, 'set', 'b', 7], [['a', 'eq', 5], 'add', 'a', 2]],
    },
    events: [
      { id: 'g', frame: 0, kind: 'gate', deps: [] },
      { id: 'idle', frame: 1, kind: 'nothing', deps: [] },
      { id: 'g2', frame: 2, kind: 'gate', deps: ['g'] },
    ],
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  // g: a 6/7（首次差异 #0, a, +）；idle 无规则保持；g2: a 7/9, b 7/7
  assert.strictEqual(base.witness.eventIndex, 0);
  assert.strictEqual(base.witness.field, 'a');
  assert.strictEqual(base.witness.sign, '+');
  return RWS.shrink(model, base, {}).then((res) => {
    // idle 无规则保持状态，g2 依赖 g 且差异已在 g 锁定 → 两者都可删，只剩见证 g
    assert.deepStrictEqual(Array.from(res.alive), [0]);
    const rep = RWS.replayReduced(model, res.alive);
    assert.strictEqual(rep.firstDiff.eventIndex, 0);
    assert.strictEqual(rep.firstDiff.field, 'a');
    assert.strictEqual(rep.firstDiff.sign, '+');
    assert.strictEqual(rep.finalOld[0], 6);
    assert.strictEqual(rep.finalNext[0], 7);
  });
});

test('钻石依赖：删上游级联删除全部下游，独立分支可保留', () => {
  // 0 根；1,2 依赖 0；3 依赖 1,2（钻石）；4 独立，见证在 4
  const doc = {
    initial: { s: 0 },
    observe: ['s'],
    old: { k: [[null, 'add', 's', 1]] },
    next: { k: [[null, 'add', 's', 2]] },
    events: [
      { id: 'r', frame: 0, kind: 'idle', deps: [] },
      { id: 'a', frame: 1, kind: 'idle', deps: ['r'] },
      { id: 'b', frame: 2, kind: 'idle', deps: ['r'] },
      { id: 'c', frame: 3, kind: 'idle', deps: ['a', 'b'] },
      { id: 'w', frame: 4, kind: 'k', deps: [] },
    ],
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  assert.strictEqual(base.witness.eventIndex, 4);
  return RWS.shrink(model, base, {}).then((res) => {
    const kept = Array.from(res.alive);
    assert.ok(kept.includes(4), '见证事件必须保留');
    assert.deepStrictEqual(kept, [4]); // 钻石全部可删，且删除被级联
    const rep = RWS.replayReduced(model, res.alive);
    assert.strictEqual(rep.firstDiff.eventIndex, 4);

    // 直接验证：删见证事件 w 后重放 → 无差异（对应缩减日志 verdict=2 差异消失）
    const withoutWitness = Array.from(base.alive).filter((x) => x !== 4);
    const rep2 = RWS.replayReduced(model, withoutWitness);
    assert.strictEqual(rep2.firstDiff, null);
  });
});

test('漂成另一种差异：见证失配拒绝（verdict=3）', () => {
  // 删前置事件后，首次差异位置提前到别的事件
  const doc = {
    initial: { s: 0 },
    observe: ['s'],
    old: { k: [[null, 'add', 's', 1]], j: [[null, 'set', 's', 100]] },
    next: { k: [[null, 'add', 's', 2]], j: [[null, 'set', 's', 100]] },
    events: [
      { id: 'e0', frame: 0, kind: 'j', deps: [] },         // set 100，两版相同
      { id: 'e1', frame: 1, kind: 'k', deps: ['e0'] },     // 101 vs 102 → 见证
      { id: 'e2', frame: 2, kind: 'idle', deps: [] },
    ],
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  assert.strictEqual(base.witness.eventIndex, 1);
  return RWS.shrink(model, base, {}).then((res) => {
    // 删 [e0]：e1 被级联删，e2 无差异 → 拒绝（差异消失）
    // 删 [e2]：见证完好 → 接受，剩 [e0,e1]
    assert.deepStrictEqual(Array.from(res.alive), [0, 1]);
    const firstRound = res.rounds[0];
    assert.strictEqual(firstRound.trials[0][3], 2);
    assert.strictEqual(firstRound.trials[1][3], 0);
  });
});

test('坏依赖：指向不存在/未来事件的依赖被指出事件号与依赖 id', () => {
  const bad = JSON.parse(JSON.stringify(sample));
  bad.events[1].deps = ['ghost'];
  let v = RWS.validate(bad);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors[0].eventIndex, 1);
  assert.strictEqual(v.errors[0].depId, 'ghost');
  assert.ok(/ghost/.test(v.errors[0].message));

  const bad2 = JSON.parse(JSON.stringify(sample));
  bad2.events[0].deps = ['x']; // x 在执行序更晚
  v = RWS.validate(bad2);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors[0].eventIndex, 0);
  assert.strictEqual(v.errors[0].depId, 'x');
});

test('取消：第一轮取消时保留上一份可重演结果（基线全量）', () => {
  const doc = JSON.parse(JSON.stringify(sample));
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  let calls = 0;
  const hooks = { isCancelled: () => { calls++; return true; } };
  return RWS.shrink(model, base, hooks).then((res) => {
    assert.strictEqual(res.status, 'cancelled');
    assert.deepStrictEqual(Array.from(res.alive), [0, 1, 2]);
    const rep = RWS.replayReduced(model, res.alive);
    assert.strictEqual(rep.firstDiff.eventIndex, 1);
  });
});

test('取消发生在接受之后：保留的是最近一次接受的结果', () => {
  const doc = {
    initial: { s: 0 }, observe: ['s'],
    old: { k: [[null, 'add', 's', 1]] },
    next: { k: [[null, 'add', 's', 2]] },
    events: [
      { id: 'a', frame: 0, kind: 'idle', deps: [] },
      { id: 'b', frame: 1, kind: 'idle', deps: [] },
      { id: 'c', frame: 2, kind: 'k', deps: [] },
    ],
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  let trialCount = 0;
  // 第一次试删后即请求取消；取消在下一个检查点生效，保留此前已接受的结果
  const hooks = {
    onTrial: () => { trialCount++; },
    isCancelled: () => trialCount >= 1,
  };
  return RWS.shrink(model, base, hooks).then((res) => {
    assert.strictEqual(res.status, 'cancelled');
    const kept = Array.from(res.alive);
    // 取消时保留的结果必须仍可重演，且见证 c（#2）在其中
    assert.ok(kept.includes(2));
    const rep = RWS.replayReduced(model, res.alive);
    assert.strictEqual(rep.firstDiff.eventIndex, 2);
  });
});

test('5 万事件单链、差异在链尾：8 秒内完成并可导出', () => {
  const N = 50000;
  const events = new Array(N);
  events[0] = { id: 'e0', frame: 0, kind: 'idle', deps: [] };
  for (let i = 1; i < N - 1; i++) {
    events[i] = { id: 'e' + i, frame: i, kind: 'idle', deps: ['e' + (i - 1)] };
  }
  // 最后一个事件产生差异
  events[N - 1] = { id: 'e' + (N - 1), frame: N - 1, kind: 'boom', deps: ['e' + (N - 2)] };
  const doc = {
    initial: { s: 0 }, observe: ['s'],
    old: { boom: [[null, 'add', 's', 1]] },
    next: { boom: [[null, 'add', 's', 2]] },
    events,
  };
  const t0 = Date.now();
  const v = RWS.validate(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const model = RWS.buildModel(doc);
  assert.strictEqual(model.isChain, true);
  const base = RWS.baseline(model);
  const tBase = Date.now() - t0;
  assert.strictEqual(base.witness.eventIndex, N - 1);
  assert.strictEqual(base.witness.sign, '+');

  return RWS.shrink(model, base, {}).then((res) => {
    const tTotal = Date.now() - t0;
    assert.strictEqual(res.status, 'finished');
    assert.strictEqual(res.alive.length, N); // 任何删除都级联吞掉链尾 → 无法保留故障
    assert.ok(res.trials > 40000, '试删次数应接近链长，实际 ' + res.trials);
    const tExp0 = Date.now();
    const exp = RWS.buildExport(model, res.alive, res.witness, { trials: res.trials, rounds: res.rounds.length });
    const tExp = Date.now() - tExp0;
    assert.strictEqual(exp.verification.witnessReproduced, true);
    assert.strictEqual(exp.events.length, N);
    console.log('  50k 链：基线 ' + tBase + 'ms，缩减 ' + res.elapsedMs + 'ms（' +
      res.trials + ' 次试删 / ' + res.rounds.length + ' 轮），导出 ' + tExp + 'ms，总计 ' + tTotal + 'ms');
    assert.ok(tTotal < 8000, '总耗时 ' + tTotal + 'ms 超过 8 秒预算');
  });
});

test('5 万事件单链可缩减场景：链尾前大量可删节点', () => {
  const N = 50000;
  const events = new Array(N);
  events[0] = { id: 'e0', frame: 0, kind: 'boom', deps: [] }; // 见证在链头
  for (let i = 1; i < N; i++) {
    events[i] = { id: 'e' + i, frame: i, kind: 'idle', deps: ['e' + (i - 1)] };
  }
  const doc = {
    initial: { s: 0 }, observe: ['s'],
    old: { boom: [[null, 'add', 's', 1]] },
    next: { boom: [[null, 'add', 's', 2]] },
    events,
  };
  const model = RWS.buildModel(doc);
  const base = RWS.baseline(model);
  const t0 = Date.now();
  return RWS.shrink(model, base, {}).then((res) => {
    assert.deepStrictEqual(Array.from(res.alive), [0]);
    const rep = RWS.replayReduced(model, res.alive);
    assert.strictEqual(rep.firstDiff.eventIndex, 0);
    console.log('  50k 链（可缩减）：' + res.elapsedMs + 'ms，' + res.accepts + ' 次接受，剩余 ' + res.alive.length);
    assert.ok(Date.now() - t0 < 8000);
  });
});

test('分块：均分且较长块靠前', () => {
  assert.deepStrictEqual(RWS.splitBlocks(5, 2).map((b) => b[1] - b[0]), [3, 2]);
  assert.deepStrictEqual(RWS.splitBlocks(4, 2).map((b) => b[1] - b[0]), [2, 2]);
  assert.deepStrictEqual(RWS.splitBlocks(7, 3).map((b) => b[1] - b[0]), [3, 2, 2]);
  assert.deepStrictEqual(RWS.splitBlocks(3, 3).map((b) => b[1] - b[0]), [1, 1, 1]);
});

test('导出包可被识别并转回可重演源格式', () => {
  const model = RWS.buildModel(sample);
  const base = RWS.baseline(model);
  return RWS.shrink(model, base, {}).then((res) => {
    const exp = RWS.buildExport(model, res.alive, res.witness);
    assert.ok(RWS.isExport(exp));
    const src = RWS.exportToSource(exp);
    const m2 = RWS.buildModel(src);
    const base2 = RWS.baseline(m2);
    assert.strictEqual(base2.witness.eventIndex, 1);
    assert.strictEqual(base2.witness.field, 'score');
    assert.strictEqual(base2.witness.sign, '+');
  });
});

Promise.all(pending).then(() => {
  if (process.exitCode) console.error('\n存在失败用例');
  else console.log('\n全部 ' + passed + ' 个测试通过');
});
