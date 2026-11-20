// Node test harness: validates the flow core against the sample truth.
// Run: node test-flow.js <samples-dir> [param-overrides JSON]
import { readFileSync } from 'node:fs';
import { decodePNG } from './png.js';
import { computeDenseFlow, DEFAULT_PARAMS } from '../web/flow-core.js';

const samples = process.argv[2];
const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const params = { ...DEFAULT_PARAMS, ...overrides };

const readGray = (name) => decodePNG(readFileSync(`${samples}/${name}`));
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

async function runCase(caseName) {
  const meta = JSON.parse(readFileSync(`${samples}/${caseName}.json`, 'utf8'));
  const A = readGray(meta.first), B = readGray(meta.second);
  const W = A.width, H = A.height;
  const result = await computeDenseFlow(A.data, B.data, W, H, params, 'forward');
  if (result.canceled) throw new Error('unexpected cancel');

  if (caseName === 'flat') {
    const nValid = result.valid.reduce((s, x) => s + x, 0);
    return { caseName, nValid, pass: nValid === 0, detail: { validPixels: nValid } };
  }

  const truth = new Float32Array(new Uint8Array(readFileSync(`${samples}/${meta.truth}`)).buffer);
  const truthValid = readGray(meta.valid).data.map(v => v > 127);
  const epes = [];
  let nTruthValid = 0, nHit = 0;
  const compErr = { u: [], v: [] };
  for (let i = 0; i < W * H; i++) {
    if (!truthValid[i]) continue;
    nTruthValid++;
    if (!result.valid[i]) continue;
    nHit++;
    const du = result.u[i] - truth[2 * i], dv = result.v[i] - truth[2 * i + 1];
    epes.push(Math.hypot(du, dv));
    compErr.u.push(du); compErr.v.push(dv);
  }
  const medEpe = median(epes);
  const meanU = compErr.u.reduce((s, x) => s + x, 0) / compErr.u.length;
  const meanV = compErr.v.reduce((s, x) => s + x, 0) / compErr.v.length;
  const totalValid = result.valid.reduce((s, x) => s + x, 0);
  // Task requirement: median endpoint error over truth-valid pixels <= 0.35px.
  // Recall is reported separately (mask need not equal the truth mask exactly).
  const pass = medEpe <= 0.35 && nHit >= 0.9 * nTruthValid;
  return {
    caseName, pass,
    detail: {
      medianEPE: medEpe.toFixed(4),
      p90EPE: epes.length ? epes[Math.floor(0.9 * epes.length)].toFixed(3) : null,
      maxEPE: epes.length ? Math.max(...epes).toFixed(3) : null,
      recall: `${nHit}/${nTruthValid}`,
      meanBias: `(${meanU.toFixed(4)}, ${meanV.toFixed(4)})`,
      outputValidPixels: totalValid,
      levelsUsed: result.levelsUsed,
    },
  };
}

const cases = ['integer', 'subpixel', 'occluded', 'piecewise', 'flat'];
let allPass = true;
for (const c of cases) {
  const r = await runCase(c);
  allPass = allPass && r.pass;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.caseName.padEnd(10)}`, JSON.stringify(r.detail));
}
console.log('\nparams:', JSON.stringify(params));
process.exit(allPass ? 0 : 1);
