// Cross-check the JS core against the Python reference outputs.
// Run: node tools/node_check.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require(path.join(__dirname, '..', 'web', 'headroom.js'));

const ROOT = path.join(__dirname, '..');
const CASES = path.join(ROOT, 'tools', 'cases');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pyRef(planPath, wavPath, outPrefix) {
  const out = execFileSync('python3', ['-I',
    path.join(ROOT, 'tools', 'ref.py'), planPath, wavPath, outPrefix],
    { encoding: 'utf8' });
  if (out.startsWith('NO SOLUTION')) return null;
  const m = out.match(/order \(id, shift\): (\[.*\])/);
  const seq = JSON.parse(m[1].replace(/\(([^)]*)\)/g, '[$1]'));
  const total = Number(out.match(/total shift: (\d+)/)[1]);
  const psum = Number(out.match(/prefix sum: (\d+)/)[1]);
  const clips = JSON.parse(
    out.match(/clips per stage\/channel: (\[.*\])/)[1]
      .replace(/\(([^)]*)\)/g, '[$1]'));
  return { seq, total, psum, clips, wav: outPrefix + '.wav' };
}

function readPcm16(p) {
  const buf = fs.readFileSync(p);
  // 44-byte standard header produced by both writers
  const n = (buf.length - 44) / 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2);
  return out;
}

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

const jsonCases = fs.readdirSync(CASES)
  .filter((f) => f.endsWith('.json'))
  .sort();
const wavCases = fs.readdirSync(CASES)
  .filter((f) => f.endsWith('.wav'))
  .sort();

for (const jf of jsonCases) {
  const plan = readJson(path.join(CASES, jf));
  const t0 = Date.now();
  const sol = H.solvePlan(plan.sections, plan.bands);
  const dt = Date.now() - t0;
  const tmpWav = path.join(CASES, wavCases[0]);
  const py = pyRef(path.join(CASES, jf), tmpWav,
    path.join('/tmp', 'py_' + jf.replace('.json', '')));
  if (py === null) {
    check(sol === null, `${jf}: both report no solution (${dt} ms)`);
    continue;
  }
  check(sol !== null, `${jf}: JS found a solution`);
  const jsSeq = sol.order.map((o) => [o.id, o.shift]);
  check(JSON.stringify(jsSeq) === JSON.stringify(py.seq),
    `${jf}: order matches ${JSON.stringify(jsSeq)} (${dt} ms)`);
  check(sol.total === py.total, `${jf}: total shift ${sol.total}`);
  check(sol.prefixSum === py.psum, `${jf}: prefix sum ${sol.prefixSum}`);
  // margins must be non-negative and limit-book identity
  sol.marginByStage.forEach((m, k) => {
    for (let b = 0; b < m.length; b++) {
      check(m[b] >= 0, `${jf} stage ${k} band ${b} margin ${m[b]} >= 0`);
      const sec = plan.sections.find((s) => s.id === sol.order[k].id);
      check(m[b] === sec.limit[b] - sol.bookByStage[k][b],
        `${jf} stage ${k} band ${b} margin identity`);
    }
  });
}

// full simulation cross-check on every wav x every solvable json
for (const jf of jsonCases) {
  const plan = readJson(path.join(CASES, jf));
  const sol = H.solvePlan(plan.sections, plan.bands);
  if (!sol) continue;
  const byId = {};
  plan.sections.forEach((s) => { byId[s.id] = s; });
  for (const wf of wavCases) {
    const bytes = fs.readFileSync(path.join(CASES, wf));
    const wav = H.parseWav(new Uint8Array(bytes));
    const res = H.simulate(byId, sol.order, wav.frames,
      wav.channels, wav.samples);
    const pref = `/tmp/py_${jf.replace('.json', '')}_${wf.replace('.wav', '')}`;
    const py = pyRef(path.join(CASES, jf), path.join(CASES, wf), pref);
    const pyPcm = readPcm16(py.wav);
    let mism = 0;
    for (let i = 0; i < res.output.length; i++) {
      if (res.output[i] !== pyPcm[i]) { mism++; if (mism <= 3) {
        console.error(`  sample ${i}: js=${res.output[i]} py=${pyPcm[i]}`);
      } }
    }
    check(mism === 0,
      `${jf} x ${wf}: ${res.output.length} samples identical`);
    check(JSON.stringify(Array.from(res.clips, (a) => Array.from(a)))
      === JSON.stringify(py.clips),
      `${jf} x ${wf}: clip counts match ${JSON.stringify(py.clips)}`);

    // subrange export must equal the same frames cut from the full output
    const lo = Math.floor(wav.frames * 0.23);
    const hi = Math.floor(wav.frames * 0.67);
    const ch = wav.channels;
    const slice = new Int16Array((hi - lo) * ch);
    for (let f = lo; f < hi; f++) {
      for (let c = 0; c < ch; c++) {
        slice[(f - lo) * ch + c] = res.output[f * ch + c];
      }
    }
    const rebuilt = H.buildWav(slice, ch, wav.sampleRate);
    fs.writeFileSync('/tmp/js_slice.wav', rebuilt);
    const back = H.parseWav(fs.readFileSync('/tmp/js_slice.wav'));
    let sm = 0;
    for (let i = 0; i < slice.length; i++) {
      if (back.samples[i] !== slice[i]) sm++;
    }
    check(sm === 0 && back.frames === hi - lo,
      `${jf} x ${wf}: half-open slice [${lo},${hi}) round-trips`);
  }
}

// rounding edge cases incl. negatives
const rv = [
  [3, 2, 2], [-3, 2, -2], [5, 2, 2], [-5, 2, -2], [1, 2, 0], [-1, 2, 0],
  [7, 4, 2], [-7, 4, -2], [9, 4, 2], [-9, 4, -2], [10, 4, 2], [-10, 4, -2],
];
for (const [v, d, e] of rv) {
  check(H.roundHalfEvenDiv(v, d) === e, `round(${v}/${d})=${e}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
