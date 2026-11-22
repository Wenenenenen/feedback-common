// Node 测试：JS 解释器对照 samples/expected.json 全量校验。
// 运行：node tests/node_check.mjs [samples-dir]
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compileProgram, VM, ImportError, LIMITS } from '../src/web/js/vm.js';

const ROOT = new URL('..', import.meta.url).pathname;
const samplesDir = process.argv[2] || join(ROOT, 'samples');
const expected = JSON.parse(readFileSync(join(samplesDir, 'expected.json'), 'utf8'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); }
}
function eq(actual, want, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(want);
  ok(a === b, `${msg}\n    实际 ${a}\n    期望 ${b}`);
}

// ---------------------------------------------------------------- 有效用例

for (const [name, want] of Object.entries(expected.valid)) {
  const file = join(samplesDir, 'cases', `${name}.json`);
  const src = JSON.parse(readFileSync(file, 'utf8'));
  const vm = new VM(compileProgram(src));
  const r = vm.run();

  eq(vm.outputs, want.outputs, `${name}: 输出日志`);
  eq(vm.faults, want.faults, `${name}: 运行错误`);
  eq(Array.from(vm.state.slots), want.slots, `${name}: 共享槽`);
  eq(vm.frame, want.finalFrame, `${name}: 最终帧号`);
  eq(vm.halted, want.halted, `${name}: 是否停止`);
  eq(vm.state.stopReason, want.stopReason, `${name}: 停止原因`);
  eq(vm.state.totalInstr, want.totalInstr, `${name}: 指令总数`);
  eq(vm.state.liveCount, want.liveFibers, `${name}: 存活协程`);
  eq(vm.state.finished, want.finished, `${name}: 结束协程数`);
}

// ---------------------------------------------------------------- 无效用例

for (const [name, want] of Object.entries(expected.invalid)) {
  const file = join(samplesDir, 'cases', 'invalid', `${name}.json`);
  const src = JSON.parse(readFileSync(file, 'utf8'));
  let err = null;
  try { compileProgram(src); } catch (e) { err = e; }
  if (!err) { fail++; console.log(`  FAIL: ${name} 应被拒绝但通过了导入`); continue; }
  ok(err instanceof ImportError, `${name}: 抛出 ImportError`);
  eq({ kind: err.kind, pc: err.pc }, { kind: want.kind, pc: want.pc }, `${name}: 错误类别与指令号`);
  ok(typeof err.message === 'string' && err.message.length > 0, `${name}: 有可读消息`);
}

// ---------------------------------------------------------------- 快照确定性

// 对每个有效用例，在“每一条指令执行后”的中途导出快照，恢复后续跑，
// 要求输出日志逐条一致、共享槽/错误/帧号一致。
const fullRuns = new Map();
for (const name of Object.keys(expected.valid)) {
  const src = JSON.parse(readFileSync(join(samplesDir, 'cases', `${name}.json`), 'utf8'));
  const vm = new VM(compileProgram(src));
  vm.run();
  fullRuns.set(name, {
    outputs: JSON.stringify(vm.outputs),
    slots: JSON.stringify(Array.from(vm.state.slots)),
    faults: JSON.stringify(vm.faults),
    frame: vm.frame,
    reason: vm.state.stopReason,
  });
}

for (const [name, full] of fullRuns) {
  const src = JSON.parse(readFileSync(join(samplesDir, 'cases', `${name}.json`), 'utf8'));
  const prog = compileProgram(src);
  const total = new VM(prog).run().executed;
  const cuts = [];
  // 指令数不多时逐条切；多则均匀取样，保证覆盖帧中不同位置
  if (total <= 800) { for (let i = 0; i <= total; i++) cuts.push(i); }
  else { for (let i = 0; i <= total; i += Math.max(1, Math.floor(total / 400))) cuts.push(i); cuts.push(total); }
  let bad = 0;
  for (const cut of cuts) {
    const a = new VM(prog);
    a.run(null, cut);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = VM.fromSnapshot(snap);
    b.run();
    const got = {
      outputs: JSON.stringify(b.outputs),
      slots: JSON.stringify(Array.from(b.state.slots)),
      faults: JSON.stringify(b.faults),
      frame: b.frame,
      reason: b.state.stopReason,
    };
    if (JSON.stringify(got) !== JSON.stringify(full)) {
      bad++;
      if (bad <= 2) {
        console.log(`  FAIL: ${name} 在 ${cut} 条指令处快照恢复后不一致`);
        console.log('    恢复:', got.outputs, got.slots, got.frame, got.reason);
        console.log('    完整:', full.outputs, full.slots, full.frame, full.reason);
      }
    }
  }
  ok(bad === 0, `${name}: ${cuts.length} 个快照切点全部一致（不一致 ${bad}）`);
}

// 快照本身可 JSON 往返且逐字段稳定
{
  const src = JSON.parse(readFileSync(join(samplesDir, 'cases', 'shared-same-frame.json'), 'utf8'));
  const vm = new VM(compileProgram(src));
  vm.run(null, 5);
  const s1 = JSON.stringify(vm.snapshot());
  const s2 = JSON.stringify(VM.fromSnapshot(JSON.parse(s1)).snapshot());
  ok(s1 === s2, '快照经「导出→恢复→导出」逐字节稳定');
}

// 快照拒绝非法内容
{
  const src = JSON.parse(readFileSync(join(samplesDir, 'cases', 'sleep-cross-frame.json'), 'utf8'));
  const vm = new VM(compileProgram(src));
  const snap = vm.snapshot();
  snap.state.slots = [1, 2, 3];
  let err = null;
  try { VM.fromSnapshot(snap); } catch (e) { err = e; }
  ok(err instanceof ImportError, '快照槽位长度错误被拒绝');
}

// ---------------------------------------------------------------- 单步与断点

// 单步执行与连续运行的输出一致
for (const name of Object.keys(expected.valid)) {
  const src = JSON.parse(readFileSync(join(samplesDir, 'cases', `${name}.json`), 'utf8'));
  const prog = compileProgram(src);
  const a = new VM(prog); a.run();
  const b = new VM(prog);
  let guard = 0;
  while (!b.halted && guard++ < 2_000_000) b.stepInstruction();
  eq(b.outputs, a.outputs, `${name}: 单步输出与连续运行一致`);
  eq(Array.from(b.state.slots), Array.from(a.state.slots), `${name}: 单步共享槽一致`);
}

// 断点停在执行前：同一指令可被重复停下，且“继续”不会原地重停
{
  const src = { code: [['PUSH', 1], ['PUSH', 2], ['ADD'], ['EMIT', 'x'], ['HALT']] };
  const vm = new VM(compileProgram(src));
  const bp = new Set([2, 4]);
  const first = vm.run(bp);
  eq(first.reason, 'breakpoint', '断点命中（reason）');
  eq([first.pc, first.executed], [2, 2], '在 pc=2 执行前停下（此前已执行 2 条）');
  eq(vm.state.totalInstr, 2, '断点处停在前一条之后、本条之前');
  eq(vm.peek().pc, 2, 'peek 指向断点指令');
  eq(vm.outputs.length, 0, '断点前尚未输出');

  // 调试器行为：从断点继续时忽略“当前这个”命中位置
  const second = vm.run(bp, Infinity, { fiber: 0, pc: 2 });
  eq([second.reason, second.pc, second.executed], ['breakpoint', 4, 2], '继续执行到下一个断点 pc=4');
  eq(JSON.stringify(vm.outputs), JSON.stringify([[0, 0, 'x', 3]]), '断点前已执行的 EMIT 正确');

  const third = vm.run(bp, Infinity, { fiber: 0, pc: 4 });
  eq(third.reason, 'halted', '继续到结束');
  eq(vm.state.stopReason, 'empty', '自然结束原因');
}

// 循环回到同一断点会再次命中（断点是位置，不是一次性事件）
{
  const src = { code: [['PUSH', 1], ['JNZ', 0], ['HALT']] };
  const prog = compileProgram(src);
  const vm = new VM(prog);
  const bp = new Set([0]);
  const r1 = vm.run(bp);
  eq([r1.reason, r1.pc], ['breakpoint', 0], '首次命中 pc=0');
  const r2 = vm.run(bp, Infinity, { fiber: 0, pc: 0 });
  eq([r2.reason, r2.pc], ['breakpoint', 0], 'ignore 只跳过首次命中，循环回到 pc=0 再次命中');
  ok(r2.executed > 0, '两次命中之间确实执行了指令');
}

// 多协程：忽略目标只作用于那个协程的那条指令，其他协程的断点照常命中
{
  // 子协程在下一帧从 pc=4 开始；协程 0 本帧就会经过 pc=5。
  const code = [
    ['FORK', 4],            // 0
    ['PUSH', 1],            // 1
    ['JNZ', 4],             // 2 → 4
    ['HALT'],               // 3
    ['PUSH', 1],            // 4
    ['JNZ', 7],             // 5 断点
    ['HALT'],               // 6
    ['HALT'],               // 7
  ];
  const prog = compileProgram({ code });
  const vm = new VM(prog);
  const bp = new Set([5]);
  const r1 = vm.run(bp);
  eq([r1.reason, r1.fiber, r1.pc], ['breakpoint', 0, 5], '协程 0 在 pc=5 命中');
  // 忽略协程 0 的 pc=5；协程 1（下一帧）到达 pc=5 时仍应命中
  const r2 = vm.run(bp, Infinity, { fiber: 0, pc: 5 });
  ok(r2.reason === 'breakpoint' && r2.pc === 5 && r2.fiber === 1,
    `忽略只对协程 0 生效，协程 1 仍在 pc=5 命中（实际 ${JSON.stringify(r2)}）`);
}

// 忽略位置只匹配指定协程：另一协程停在同一 pc 时仍应命中
{
  // 协程 1 在帧 1 先经过 pc=3；协程 0 被事件唤醒后也在帧 2 经过 pc=3。
  const code = [
    ['FORK', 6],            // 0
    ['WAIT', 'go'],         // 1
    ['JNZ', 3],             // 2 事件值 1 → 跳到 3
    ['PUSH', 1],            // 3 断点
    ['HALT'],               // 4
    ['HALT'],               // 5
    ['PUSH', 2],            // 6
    ['JNZ', 3],             // 7 → 3
    ['HALT'],               // 8
  ];
  const prog = compileProgram({ code, events: [[2, 'go', 1]] });
  const vm = new VM(prog);
  const bp = new Set([3]);
  const r1 = vm.run(bp);
  eq([r1.reason, r1.fiber, r1.pc], ['breakpoint', 1, 3], '子协程 1 先在 pc=3 命中');
  const r2 = vm.run(bp, Infinity, { fiber: 1, pc: 3 });
  ok(r2.reason === 'breakpoint' && r2.pc === 3 && r2.fiber === 0,
    `忽略只对协程 1 生效，协程 0 仍在 pc=3 命中（实际 ${JSON.stringify(r2)}）`);
}

// ---------------------------------------------------------------- 容量上限

{
  let big;
  try {
    big = compileProgram({ code: Array.from({ length: LIMITS.CODE + 1 }, () => ['HALT']) });
    ok(false, '超过 8192 条指令应被拒绝');
  } catch (e) {
    ok(e instanceof ImportError && e.pc === LIMITS.CODE, '超过 8192 条指令被拒绝并指出位置');
  }
  let tooManyEvents;
  try {
    compileProgram({ code: [['HALT']], events: Array.from({ length: LIMITS.EVENTS + 1 }, () => [0, 'x', 0]) });
    ok(false, '超过 2 万条事件应被拒绝');
  } catch (e) {
    ok(e instanceof ImportError, '超过 2 万条事件被拒绝');
  }
}

// 正好 8192 条指令、2 万条事件可导入
{
  const code = Array.from({ length: LIMITS.CODE - 1 }, () => ['PUSH', 0]);
  code.push(['HALT']);
  const events = Array.from({ length: LIMITS.EVENTS }, (_, i) => [i % 50, `e${i % 7}`, i]);
  const prog = compileProgram({ code, events });
  ok(prog.n === LIMITS.CODE, '8192 条指令可导入');
  ok(prog.events.count === LIMITS.EVENTS, '2 万条事件可导入');
}

console.log(`\nnode_check: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
