/*
 * Worker 协议测试（Node 模拟 self/postMessage 环境）。
 * 验证：正常求解往返、非法输入报错、连续请求的 seq 纪律、取消语义。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..', '..');
const coreSrc = fs.readFileSync(path.join(root, 'js', 'solver-core.js'), 'utf8');
const bodySrc = fs.readFileSync(path.join(root, 'js', 'worker-body.js'), 'utf8');

function makeWorkerSandbox() {
  const mailbox = [];
  const sandbox = {
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1e6 },
    Float64Array, Int32Array, Uint8Array, Set, Math, JSON, isFinite, Number, Date, Error,
    console
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (msg) => mailbox.push(msg);
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox);
  vm.runInContext(bodySrc, sandbox);
  // worker-body.js 挂的是 NR_WORKER_BODY(global)，调用即装上 onmessage
  vm.runInContext('NR_WORKER_BODY(self);', sandbox);
  return { sandbox, mailbox };
}

function makeInput(mod) {
  const base = {
    width: 4, height: 3, spacing: [1, 1], wrap: [true, true],
    samples: [], pins: []
  };
  for (let i = 0; i < 12; i++) {
    base.samples.push([0.1 * (i % 3), -0.05 * ((i / 3) | 0), 1, 1 + (i % 8)]);
  }
  if (mod) mod(base);
  return base;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('Worker 协议');

test('正常求解：回传 result 且通过 1e-7 验收', () => {
  const { sandbox, mailbox } = makeWorkerSandbox();
  sandbox.self.onmessage({ data: { type: 'solve', seq: 1, input: makeInput() } });
  assert.strictEqual(mailbox.length, 1);
  const msg = mailbox[0];
  assert.strictEqual(msg.type, 'result');
  assert.strictEqual(msg.seq, 1);
  assert.strictEqual(msg.ok, true);
  assert.strictEqual(msg.verifyPassed, true);
  assert.ok(msg.heights instanceof Float64Array);
  assert.ok(msg.edgeA instanceof Int32Array);
});

test('非法输入：回传 ok:false 与格号错误，不抛异常', () => {
  const { sandbox, mailbox } = makeWorkerSandbox();
  const bad = makeInput((b) => { b.samples[2] = null; b.pins = [[2, 0]]; }); // 锁孔
  sandbox.self.onmessage({ data: { type: 'solve', seq: 7, input: bad } });
  const msg = mailbox[0];
  assert.strictEqual(msg.ok, false);
  assert.strictEqual(msg.seq, 7);
  assert.ok(msg.errors.join(' ').includes('2'));
});

test('连续两个 seq：各自回传且序号正确，结果不串号', () => {
  const { sandbox, mailbox } = makeWorkerSandbox();
  sandbox.self.onmessage({ data: { type: 'solve', seq: 1, input: makeInput() } });
  sandbox.self.onmessage({
    data: { type: 'solve', seq: 2, input: makeInput((b) => { b.spacing = [2, 2]; }) }
  });
  assert.strictEqual(mailbox.length, 2);
  assert.strictEqual(mailbox[0].seq, 1);
  assert.strictEqual(mailbox[1].seq, 2);
  assert.ok(mailbox[0].verifyPassed && mailbox[1].verifyPassed);
});

test('成功结果不带 cancelled 标记', () => {
  const { sandbox, mailbox } = makeWorkerSandbox();
  sandbox.self.onmessage({ data: { type: 'solve', seq: 1, input: makeInput() } });
  const msg = mailbox[0];
  assert.ok(!msg.cancelled);
  assert.strictEqual(msg.verifyPassed, true);
});

test('shouldCancel 触发：求解中止且不产生 heights/残差（旧计算语义）', () => {
  // 直接用核心 API 验证 Worker 内部同款取消路径
  const NR = require(path.join(root, 'js', 'solver-core.js'));
  const big = makeInput((b) => {
    b.width = 96; b.height = 96;
    b.samples = [];
    for (let i = 0; i < 96 * 96; i++) {
      b.samples.push([Math.sin(i) * 0.4, Math.cos(i) * 0.4, 1, 8]);
    }
  });
  const v = NR.validateInput(big);
  const model = NR.buildModel(v.data);
  const out = NR.solveModel(model, { shouldCancel: () => true });
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(out.heights, undefined);
  assert.strictEqual(out.edgeResidual, undefined);
});

test('Worker 源码与核心可拼接（Blob 构建可行性）且无语法错误', () => {
  // 模拟 app.js 的 Blob 组装：UMD 头 + 工厂 toString + body toString
  const NR = require(path.join(root, 'js', 'solver-core.js'));
  const sandbox2 = {};
  vm.createContext(sandbox2);
  vm.runInContext(bodySrc, sandbox2);
  const bodyFn = sandbox2.NR_WORKER_BODY;
  const src = [
    "'use strict';",
    'var __NR_factory = ' + NR.__factory__.toString() + ';',
    '(function (root, factory) { root.NormalRelief = factory(); })(self, __NR_factory);',
    'var __workerBody = ' + bodyFn.toString() + ';',
    '__workerBody(self);'
  ].join('\n');
  // eslint-disable-next-line no-new-func
  new Function('self', src);
});

console.log('\n' + (process.exitCode ? '存在失败用例' : passed + ' 个 Worker 测试全部通过'));
