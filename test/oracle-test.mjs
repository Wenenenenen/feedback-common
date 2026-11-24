// oracle-test.mjs — 与独立 Python 参考实现做端到端字节/缺口/来源对照。
// 会调用 python3 test/reference_oracle.py 生成用例。
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const O = require('../optical-core.js');
const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const dir = mkdtempSync(join(tmpdir(), 'optical-oracle-'));

let failures = 0, passes = 0;
function ok(c, m) { if (c) passes++; else { failures++; console.error('  FAIL', m); } }

for (let seed = 100; seed < 140; seed++) {
  const fx = join(dir, `f${seed}.json`);
  const ex = join(dir, `e${seed}.json`);
  execFileSync('python3', ['-I', join(ROOT, 'test', 'reference_oracle.py'),
    'gen', String(seed), fx, ex], { stdio: 'ignore' });
  const data = JSON.parse(readFileSync(fx, 'utf8'));
  const py = JSON.parse(readFileSync(ex, 'utf8'));
  const js = O.renderStrips(data);

  ok(js.frameCount === py.frameCount, `seed${seed} frameCount`);
  let pcmSame = js.pcm.length === py.pcm.length;
  let firstDiff = -1;
  for (let i = 0; pcmSame && i < py.pcm.length; i++) {
    if (js.pcm[i] !== py.pcm[i]) { pcmSame = false; firstDiff = i; }
  }
  ok(pcmSame, `seed${seed} PCM 与 Python oracle 完全一致` +
    (firstDiff >= 0 ? `（首差 idx=${firstDiff} js=${js.pcm[firstDiff]} py=${py.pcm[firstDiff]}）` : ''));

  ok(JSON.stringify(Array.from(js.coverage.left)) === JSON.stringify(py.coverageLeft),
    `seed${seed} 左覆盖一致`);
  ok(JSON.stringify(Array.from(js.coverage.right)) === JSON.stringify(py.coverageRight),
    `seed${seed} 右覆盖一致`);
  ok(JSON.stringify(js.getGaps('left')) === JSON.stringify(py.gapsLeft), `seed${seed} 左缺口一致`);
  ok(JSON.stringify(js.getGaps('right')) === JSON.stringify(py.gapsRight), `seed${seed} 右缺口一致`);

  let srcSame = true; let detail = '';
  for (let f = 0; f < py.sources.length; f++) {
    const info = js.inspectFrame(f);
    const a = JSON.stringify(info.left.sources), b = JSON.stringify(py.sources[f].left);
    const ar = JSON.stringify(info.right.sources), br = JSON.stringify(py.sources[f].right);
    if (a !== b || ar !== br) { srcSame = false; detail = ` f${f}: jsL=${a} pyL=${b} jsR=${ar} pyR=${br}`; break; }
  }
  ok(srcSame, `seed${seed} 逐帧条带来源一致${detail}`);
}

console.log(`\nOracle 对照：${passes} 通过，${failures} 失败`);
process.exit(failures ? 1 : 0);
