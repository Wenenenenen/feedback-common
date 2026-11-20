'use strict';
/* 引擎测试:用样例包协议校验 arbiter.js。运行: node test/run-tests.js */
const fs = require('fs');
const path = require('path');
const { Arbiter } = require('../arbiter.js');

const SAMPLES = path.join(__dirname, '..', 'samples', 'extracted');
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8'));
}

function runCase(data) {
  const engine = new Arbiter();
  engine.setConfig(data.config);
  engine.loadEvents(data.events);
  engine.runAll();
  return engine;
}

console.log('== combo.json ==');
{
  const data = load('combo.json');
  const expected = load('combo-expected.json');
  const engine = runCase(data);
  const log = engine.entries;
  const performed = log.filter((e) => e.kind === 'performed');
  check('dash 在 t=40 performed', performed.length === 1 && performed[0].id === 'dash' && performed[0].t === expected.performed[0].t);
  const dashCanceled = log.find((e) => e.kind === 'canceled' && e.id === 'dash');
  check('dash 在 t=70 canceled(首键释放)', dashCanceled && dashCanceled.t === expected.dash_canceled_at);
  const release = log.find((e) => e.kind === 'release' && e.id === 'dash');
  check('占用持续到 t=80', release && release.t === expected.occupied_until);
  const singleCanceled = log.find((e) => e.kind === 'canceled' && e.id === 'single');
  check('single 在 t=40 因占用被 canceled', singleCanceled && singleCanceled.t === 40 && /占用/.test(singleCanceled.reason));
  const menuOk = log.filter((e) => e.id === 'menu-ok');
  check('menu-ok 上下文未激活,无任何动作', menuOk.length === 0);
  const dup = log.find((e) => e.kind === 'input' && e.type === 'down' && e.key === 'K' && e.t === 30);
  check('t=30 重复 down K 被忽略', dup && dup.ignored === true);
  const singleStarted = log.find((e) => e.kind === 'started' && e.id === 'single');
  check('single 在 t=0 started(候选等待窗内)', singleStarted && singleStarted.t === 0);
}

console.log('== hold-boundary.json ==');
{
  const engine = runCase(load('hold-boundary.json'));
  const log = engine.entries;
  const started = log.find((e) => e.kind === 'started' && e.id === 'charge');
  check('charge 在 t=10 started', started && started.t === 10 && started.readyTime === 110);
  check('charge 未 performed(up 与就绪同刻,输入优先)', !log.some((e) => e.kind === 'performed'));
  const canceled = log.find((e) => e.kind === 'canceled' && e.id === 'charge');
  check('charge 在 t=110 canceled(按键提前抬起)', canceled && canceled.t === 110 && canceled.reason === '按键提前抬起');
}
{
  // 变体:up 晚 1ms,则定时器先在 t=110 触发 performed
  const data = load('hold-boundary.json');
  data.events[1].t = 111;
  const engine = runCase(data);
  const log = engine.entries;
  const performed = log.find((e) => e.kind === 'performed' && e.id === 'charge');
  check('变体: charge 在 t=110 performed', performed && performed.t === 110);
  const canceled = log.find((e) => e.kind === 'canceled' && e.id === 'charge');
  check('变体: charge 在 t=111 canceled(动作结束)', canceled && canceled.t === 111);
}

console.log('== context-blur.json ==');
{
  const engine = runCase(load('context-blur.json'));
  const log = engine.entries;
  const singlePerformed = log.find((e) => e.kind === 'performed' && e.id === 'single');
  check('single 在 t=40 performed', singlePerformed && singlePerformed.t === 40);
  const singleCanceled = log.find((e) => e.kind === 'canceled' && e.id === 'single' && e.t === 45);
  check('single 在 t=45 因上下文切换 canceled', singleCanceled && singleCanceled.reason === '上下文切换');
  const dashElim = log.filter((e) => e.kind === 'eliminated' && e.id === 'dash');
  check('dash 两次窗口截止未集齐被淘汰', dashElim.length === 2 && dashElim.every((e) => e.reason === '窗口截止未集齐'));
  const menuOkPerformed = log.find((e) => e.kind === 'performed' && e.id === 'menu-ok');
  check('menu-ok 在 t=110 performed(上下文优先级更高)', menuOkPerformed && menuOkPerformed.t === 110);
  const singleCanceled2 = log.find((e) => e.kind === 'canceled' && e.id === 'single' && e.t === 110);
  check('single 在 t=110 因占用被 canceled', singleCanceled2 && /占用/.test(singleCanceled2.reason));
  const menuOkCanceled = log.find((e) => e.kind === 'canceled' && e.id === 'menu-ok');
  check('menu-ok 在 t=120 因 blur 合成 up 结束', menuOkCanceled && menuOkCanceled.t === 120);
  const synthUp = log.find((e) => e.kind === 'input' && e.type === 'up' && e.synth === true);
  check('blur 合成了 up 事件', !!synthUp);
  check('blur 后物理键清空', engine.snapshot().pressed.length === 0);
}

console.log('== 同刻 down/up/timer 约定 ==');
{
  // 同 t: down 后 up(seq 序),单键绑定 window=0 hold=0
  const engine = new Arbiter();
  engine.setConfig({
    window_ms: 0,
    contexts: [{ id: 'game', priority: 1, active: true }],
    bindings: [{ id: 'tap', context: 'game', priority: 0, keys: ['A'], hold_ms: 0 }],
  });
  engine.loadEvents([
    { t: 5, seq: 0, type: 'down', key: 'A' },
    { t: 5, seq: 1, type: 'up', key: 'A' },
  ]);
  engine.runAll();
  const log = engine.entries;
  // 约定:同刻全部输入(down+up)先处理,up 使 started 候选在定时器前被取消
  check('同刻 down+up:输入优先,不 performed', !log.some((e) => e.kind === 'performed'));
  const canceled = log.find((e) => e.kind === 'canceled' && e.id === 'tap');
  check('同刻 up 使候选 canceled(按键提前抬起)', canceled && canceled.t === 5 && canceled.reason === '按键提前抬起');
}
{
  // up 先于 down 到达同一 t(seq 决定顺序)
  const engine = new Arbiter();
  engine.setConfig({
    window_ms: 10,
    contexts: [{ id: 'game', priority: 1, active: true }],
    bindings: [{ id: 'tap', context: 'game', priority: 0, keys: ['A'], hold_ms: 0 }],
  });
  engine.loadEvents([
    { t: 5, seq: 0, type: 'up', key: 'A' },
    { t: 5, seq: 1, type: 'down', key: 'A' },
  ]);
  engine.runAll();
  const log = engine.entries;
  check('未按下的 up 被忽略', log.some((e) => e.kind === 'input' && e.type === 'up' && e.ignored));
  check('同刻后到的 down 仍建立候选并 performed', log.some((e) => e.kind === 'performed' && e.t === 15));
}

console.log('== 重新武装:全键释放后才允许新一轮候选 ==');
{
  const engine = new Arbiter();
  engine.setConfig({
    window_ms: 40,
    contexts: [{ id: 'game', priority: 1, active: true }],
    bindings: [{ id: 'dash', context: 'game', priority: 0, keys: ['K', 'Shift'], hold_ms: 0 }],
  });
  engine.loadEvents([
    { t: 0, seq: 0, type: 'down', key: 'K' },
    { t: 10, seq: 1, type: 'down', key: 'Shift' }, // started, ready=40
    { t: 20, seq: 2, type: 'up', key: 'K' },       // performed 前抬起 -> canceled
    { t: 30, seq: 3, type: 'down', key: 'K' },     // Shift 仍按住 -> 未重新武装,无新候选
    { t: 50, seq: 4, type: 'up', key: 'Shift' },
    { t: 55, seq: 5, type: 'up', key: 'K' },
    { t: 60, seq: 6, type: 'down', key: 'K' },     // 全键已释放 -> 新候选
    { t: 70, seq: 7, type: 'down', key: 'Shift' },
  ]);
  engine.runAll();
  const log = engine.entries;
  check('第一轮 started 后被 canceled', log.some((e) => e.kind === 'canceled' && e.id === 'dash' && e.t === 20));
  check('t=30 的 down 不产生新候选(未重新武装)', log.filter((e) => e.kind === 'candidate').length === 2);
  check('全键释放后新一轮 performed', log.some((e) => e.kind === 'performed' && e.id === 'dash' && e.t === 100));
}

console.log('== 确定性:runAll 与逐步 step 结果一致 ==');
{
  const data = load('context-blur.json');
  const a = runCase(data).entries;
  const engine = new Arbiter();
  engine.setConfig(data.config);
  engine.loadEvents(data.events);
  while (engine.hasWork()) engine.step();
  const b = engine.entries;
  check('两种驱动方式日志完全一致', JSON.stringify(a) === JSON.stringify(b));
}

console.log('== 容量上限 ==');
{
  const many = { window_ms: 10, contexts: [{ id: 'c', priority: 0, active: true }], bindings: [] };
  for (let i = 0; i < 65; i++) many.bindings.push({ id: 'b' + i, context: 'c', priority: 0, keys: ['K' + i], hold_ms: 0 });
  let threw = false;
  try { new Arbiter().setConfig(many); } catch (e) { threw = /64/.test(e.message); }
  check('超过 64 个绑定被拒绝', threw);
  const engine = new Arbiter();
  engine.setConfig({ window_ms: 10, contexts: [{ id: 'c', priority: 0, active: true }], bindings: [{ id: 'b', context: 'c', priority: 0, keys: ['K'], hold_ms: 0 }] });
  let threw2 = false;
  try { engine.loadEvents(Array.from({ length: 10001 }, (_, i) => ({ t: i, seq: i, type: 'blur' }))); } catch (e) { threw2 = /10000/.test(e.message); }
  check('超过 10000 条事件被拒绝', threw2);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
