// Python 参考实现 与 JS 解释器的随机交叉核对。
//
// 生成大量随机程序（含 FORK/WAIT/SLEEP/CALL/RET/算术回绕/故障/死锁），
// 分别交给 src/py/lfv_ref.py 与 src/web/js/vm.js 运行，逐项比较：
// 输出日志、共享槽、运行错误、最终帧号、停止原因、指令总数。
//
// 用法：node tests/crosscheck.mjs [轮数=200] [种子=1]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, VM, ImportError } from '../src/web/js/vm.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REF = join(ROOT, 'src', 'py', 'lfv_ref.py');
const rounds = Number(process.argv[2] || 200);
let seed = Number(process.argv[3] || 1);

// xorshift32：可复现伪随机
function rand() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
const ri = (n) => Math.floor(rand() * n);
const pick = (arr) => arr[ri(arr.length)];

const EVENT_NAMES = ['a', 'b', 'c', 'go'];
const INSTR_BUDGET = 20000; // 随机程序可能无限循环；两侧用同一上限，超限不参与比较

function genProgram() {
  const n = 4 + ri(40);
  const code = [];
  // 先铺一批基础指令，再随机覆写，保证跳转目标总在范围内
  for (let i = 0; i < n; i++) code.push(['HALT']);
  const evCount = ri(8);
  const events = [];
  for (let i = 0; i < evCount; i++) {
    const f = ri(12);
    events.push([f, pick(EVENT_NAMES), (ri(2000) - 1000) | 0]);
  }
  // 事件按帧排序，模拟常规输入（顺序仍自由，但这里按帧分组更接近真实用法）
  events.sort((x, y) => x[0] - y[0]);

  for (let i = 0; i < n; i++) {
    const r = ri(100);
    if (r < 30) code[i] = ['PUSH', (ri(40000) - 20000) | 0];
    else if (r < 42) code[i] = ['LOAD', ri(6)];
    else if (r < 54) code[i] = ['STORE', ri(6)];
    else if (r < 64) code[i] = ['ADD'];
    else if (r < 70) code[i] = ['JNZ', i + 1 + ri(Math.max(1, n - i - 1))];
    else if (r < 76) code[i] = ['CALL', ri(n)];
    else if (r < 82) code[i] = ['RET'];
    else if (r < 88) code[i] = ['FORK', ri(n)];
    else if (r < 92) code[i] = ['SLEEP', 1 + ri(4)];
    else if (r < 96) code[i] = ['WAIT', pick(EVENT_NAMES)];
    else if (r < 99) code[i] = ['EMIT', pick(EVENT_NAMES)];
    else code[i] = ['HALT'];
  }
  // 修正 JNZ 目标越界（随机时已保证，但再夹一次）
  for (let i = 0; i < n; i++) {
    const ins = code[i];
    if (['JNZ', 'CALL', 'FORK'].includes(ins[0])) ins[1] = Math.min(n - 1, Math.max(0, ins[1]));
  }
  const obj = { code, events };
  if (rand() < 0.5) obj.frames = ri(30);
  return obj;
}

function jsRun(obj) {
  let prog;
  try {
    prog = compileProgram(obj);
  } catch (e) {
    if (e instanceof ImportError) return { importError: { kind: e.kind, pc: e.pc } };
    throw e;
  }
  const vm = new VM(prog);
  vm.run(null, INSTR_BUDGET);
  return {
    outputs: vm.outputs.map((o) => [o[0], o[1], o[2], o[3]]),
    faults: vm.faults.map((f) => ({ frame: f.frame, fiber: f.fiber, pc: f.pc, kind: f.kind })),
    slots: Array.from(vm.state.slots),
    finalFrame: vm.frame,
    halted: vm.halted,
    stopReason: vm.state.stopReason,
    totalInstr: vm.state.totalInstr,
    liveFibers: vm.state.liveCount,
    finished: vm.state.finished,
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'lfv-x-'));
let failures = 0;
let compared = 0;
let importRejects = 0;

try {
  for (let round = 0; round < rounds; round++) {
    const obj = genProgram();
    const file = join(tmp, `case-${round}.json`);
    writeFileSync(file, JSON.stringify(obj));

    const jsResult = jsRun(obj);

    let pyResult;
    try {
      const out = execFileSync('python3', ['-I', REF, 'run', file, String(INSTR_BUDGET)], {
        encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      });
      pyResult = JSON.parse(out);
    } catch (e) {
      // 非零退出 = 导入被拒绝
      try {
        const out = JSON.parse(e.stdout || '{}');
        pyResult = { importError: { kind: out.kind, pc: out.pc } };
      } catch {
        console.error(`轮 ${round}: Python 执行失败`, e.stderr || e.message);
        failures++;
        continue;
      }
    }

    if (jsResult.importError || pyResult.importError) {
      const a = JSON.stringify(jsResult.importError ?? null);
      const b = JSON.stringify(pyResult.importError ?? null);
      if (a !== b) {
        failures++;
        if (failures <= 5) console.log(`轮 ${round}: 导入判定不一致 JS=${a} PY=${b}`);
      } else {
        importRejects++;
      }
      continue;
    }

    // 触及指令上限的程序：两侧应在同一处停下（都未 halted），否则说明调度不一致
    if (!jsResult.halted || !pyResult.halted) {
      if (jsResult.halted === pyResult.halted) {
        compared++;
      } else {
        failures++;
        if (failures <= 5) {
          console.log(`轮 ${round}: 指令上限处停止状态不一致 JS halted=${jsResult.halted} PY halted=${pyResult.halted}`);
          console.log('  程序:', JSON.stringify(obj));
        }
      }
      continue;
    }

    compared++;
    // Python 的 faults 多带 message（JS 侧的文本供 UI 用，措辞允许不同），比较时只取结构化字段
    const pyFaults = (pyResult.faults || []).map((f) => ({ frame: f.frame, fiber: f.fiber, pc: f.pc, kind: f.kind }));
    const normalized = { ...pyResult, faults: pyFaults };
    const fields = ['outputs', 'faults', 'slots', 'finalFrame', 'halted', 'stopReason',
      'totalInstr', 'liveFibers', 'finished'];
    let bad = false;
    for (const f of fields) {
      if (JSON.stringify(jsResult[f]) !== JSON.stringify(normalized[f])) {
        bad = true;
        if (failures < 5) {
          console.log(`轮 ${round}: 字段 ${f} 不一致`);
          console.log('  JS:', JSON.stringify(jsResult[f]));
          console.log('  PY:', JSON.stringify(pyResult[f]));
          console.log('  程序:', JSON.stringify(obj));
        }
        break;
      }
    }
    if (bad) failures++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ncrosscheck: ${compared} 个程序逐项一致, ${importRejects} 个导入拒绝一致, ${failures} 个不一致`);
process.exit(failures ? 1 : 0);
