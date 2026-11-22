// Python 参考实现对照 samples/expected.json 全量校验。
// 运行：node tests/python_check.mjs [samples-dir]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REF = join(ROOT, 'src', 'py', 'lfv_ref.py');
const samplesDir = process.argv[2] || join(ROOT, 'samples');
const expected = JSON.parse(readFileSync(join(samplesDir, 'expected.json'), 'utf8'));

let pass = 0;
let fail = 0;
function eq(actual, want, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else { fail++; console.log(`  FAIL: ${msg}\n    实际 ${a}\n    期望 ${b}`); }
}

for (const [name, want] of Object.entries(expected.valid)) {
  const file = join(samplesDir, 'cases', `${name}.json`);
  const out = execFileSync('python3', ['-I', REF, 'run', file], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  const got = JSON.parse(out);
  eq(got.outputs, want.outputs, `${name}: 输出日志（Python）`);
  eq(got.faults.map((f) => [f.frame, f.fiber, f.pc, f.kind]),
    want.faults.map((f) => [f.frame, f.fiber, f.pc, f.kind]), `${name}: 运行错误（Python）`);
  eq(got.slots, want.slots, `${name}: 共享槽（Python）`);
  eq(got.finalFrame, want.finalFrame, `${name}: 最终帧号（Python）`);
  eq(got.stopReason, want.stopReason, `${name}: 停止原因（Python）`);
  eq(got.totalInstr, want.totalInstr, `${name}: 指令总数（Python）`);
}

for (const [name, want] of Object.entries(expected.invalid)) {
  const file = join(samplesDir, 'cases', 'invalid', `${name}.json`);
  let got;
  try {
    const out = execFileSync('python3', ['-I', REF, 'run', file], { encoding: 'utf8' });
    got = JSON.parse(out);
  } catch (e) {
    got = JSON.parse(e.stdout || '{}');
  }
  eq({ kind: got.kind, pc: got.pc }, { kind: want.kind, pc: want.pc }, `${name}: 拒绝类别与指令号（Python）`);
}

console.log(`\npython_check: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
