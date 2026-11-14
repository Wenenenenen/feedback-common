// 用 samples 标注验收检测器：node test/run-samples.mjs <样例目录>
// 判定：每个 expected 事件需匹配同声道同键、起止误差 ≤15ms 的检测事件；不允许漏报/多报。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const require = createRequire(import.meta.url);
const DTMF = require('../dtmf.js');

const dir = process.argv[2];
if (!dir) { console.error('usage: node run-samples.mjs <samples-dir>'); process.exit(2); }

const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
const TOL_MS = 15;

let fail = 0;

for (const [file, expected] of Object.entries(cases.expected)) {
  const wav = DTMF.decodeWav(readFileSync(join(dir, file)).buffer);
  const floats = wav.int16.map(DTMF.toFloat);
  const t0 = Date.now();
  const detected = await DTMF.detectAudio(floats, wav.sampleRate);
  const ms = Date.now() - t0;

  const det = detected.map((e) => ({
    key: e.key, channel: e.channel, startMs: e.startMs, endMs: e.endMs,
  }));
  const used = new Array(det.length).fill(false);
  const problems = [];

  for (const exp of expected) {
    const expStart = exp.start * 1000, expEnd = exp.end * 1000;
    let hit = -1;
    for (let i = 0; i < det.length; i++) {
      if (used[i]) continue;
      const d = det[i];
      if (d.channel !== exp.channel || d.key !== exp.key) continue;
      if (Math.abs(d.startMs - expStart) <= TOL_MS && Math.abs(d.endMs - expEnd) <= TOL_MS) { hit = i; break; }
    }
    if (hit >= 0) used[hit] = true;
    else {
      const near = det.filter((d) => d.channel === exp.channel && Math.abs(d.startMs - expStart) < 100);
      problems.push(`漏报/超差: ${exp.key} ch${exp.channel} [${expStart.toFixed(0)},${expEnd.toFixed(0)}]ms` +
        (near.length ? ` 附近检出 ${JSON.stringify(near)}` : ''));
    }
  }
  det.forEach((d, i) => {
    if (!used[i]) problems.push(`多报: ${d.key} ch${d.channel} [${d.startMs.toFixed(1)},${d.endMs.toFixed(1)}]ms`);
  });

  const ok = problems.length === 0;
  if (!ok) fail = 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} (${wav.sampleRate}Hz ${wav.numChannels}ch, 检出${det.length} 期望${expected.length}, ${ms}ms)`);
  for (const p of problems) console.log('   ' + p);
  if (!ok && det.length) {
    console.log('   全部检出:', det.map((d) => `${d.key}@ch${d.channel}[${d.startMs.toFixed(0)}-${d.endMs.toFixed(0)}]`).join(' '));
  }
}

process.exit(fail);
