// Test harness: Fraction units, closed-form moment checks, validator
// localization, and full cross-validation against tools/reference.py.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Fraction, frac } from '../src/bigfraction.js';
import { parsePgm } from '../src/pgm.js';
import { validateRegion, RegionError } from '../src/validate.js';
import { computeRasterMoments, cellContributions, derivedStats } from '../src/moments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CASES = path.join(ROOT, 'tests', 'cases');

let passed = 0, failed = 0;
const failures = [];
const normFracStr = (s) => (s.includes('/') ? s : `${s}/1`);
function check(name, cond, detail = '') {
  if (cond) { passed++; }
  else { failed++; failures.push(`${name}${detail ? ': ' + detail : ''}`); console.error(`FAIL ${name} ${detail}`); }
}
function eqFrac(name, got, wantStr) {
  const s = got instanceof Fraction ? got.toString() : String(got);
  check(name, s === wantStr, `got ${s}, want ${wantStr}`);
}

// ---------- Fraction basics ----------
{
  const a = frac(2n, 4n), b = frac(1n, 3n);
  check('frac reduces', a.toString() === '1/2');
  eqFrac('add', a.add(b), '5/6');
  eqFrac('sub', a.sub(b), '1/6');
  eqFrac('mul', a.mul(b), '1/6');
  eqFrac('div', a.div(b), '3/2');
  eqFrac('neg denom', frac(1n, -3n), '-1/3');
  check('zero normalized', frac(0n, 7n).toString() === '0/1');
  check('cmp', frac(1n, 3n).cmp(frac(2n, 5n)) < 0);
  check('ceil/floor pos', frac(7n, 3n).floor() === 2n && frac(7n, 3n).ceil() === 3n);
  check('ceil/floor neg', frac(-7n, 3n).floor() === -3n && frac(-7n, 3n).ceil() === -2n);
  check('decimal rounding', frac(1n, 3n).toDecimal(4) === '0.3333');
}

// ---------- Green's theorem on known shapes ----------
{
  const P = (x, y) => [frac(x), frac(y)];
  void P;
  // reach polygonMoments indirectly through a full-cover region instead:
  // use computeRasterMoments on a 1x1 image with region == the pixel.
  const img = { width: 1, height: 1, gray: Uint16Array.from([1]) };
  const r = computeRasterMoments(
    { outer: [[0, 0], [16, 0], [16, 16], [0, 16]], holes: [] }, img);
  eqFrac('square M00', r.totals.M00, '1/1');
  eqFrac('square M10', r.totals.M10, '1/2');
  eqFrac('square M01', r.totals.M01, '1/2');
  eqFrac('square M20', r.totals.M20, '1/3');
  eqFrac('square M02', r.totals.M02, '1/3');
  eqFrac('square M11', r.totals.M11, '1/4');
  eqFrac('square area', r.coveredArea, '1/1');
  check('square full cell count', r.fullCount === 1 && r.cellCount === 1);

  // right triangle (0,0),(1,0),(0,1), gray 1: area 1/2, M10=M01=1/6,
  // M20=M02=1/12, M11=1/24
  const t = computeRasterMoments(
    { outer: [[0, 0], [16, 0], [0, 16]], holes: [] }, img);
  eqFrac('tri M00', t.totals.M00, '1/2');
  eqFrac('tri M10', t.totals.M10, '1/6');
  eqFrac('tri M01', t.totals.M01, '1/6');
  eqFrac('tri M20', t.totals.M20, '1/12');
  eqFrac('tri M02', t.totals.M02, '1/12');
  eqFrac('tri M11', t.totals.M11, '1/24');
  check('triangle is partial cell', t.partialCount === 1 && t.fullCount === 0);

  // reversed winding must give identical results (winding-independent)
  const t2 = computeRasterMoments(
    { outer: [[0, 16], [16, 0], [0, 0]], holes: [] }, img);
  for (const k of Object.keys(t.totals)) eqFrac(`winding ${k}`, t2.totals[k], t.totals[k].toString());

  // gray weighting: gray=3 scales every moment by 3
  const img3 = { width: 1, height: 1, gray: Uint16Array.from([3]) };
  const r3 = computeRasterMoments(
    { outer: [[0, 0], [16, 0], [16, 16], [0, 16]], holes: [] }, img3);
  eqFrac('gray weight M00', r3.totals.M00, '3/1');
  eqFrac('gray weight M20', r3.totals.M20, '1/1');
}

// ---------- validator ----------
{
  const good = { outer: [[0, 0], [80, 0], [80, 80], [0, 80]], holes: [[[16, 16], [48, 16], [48, 48], [16, 48]]] };
  check('valid region accepted', (() => { try { validateRegion(good); return true; } catch { return false; } })());

  const expectIssues = (name, region, mustInclude = '') => {
    try {
      validateRegion(region);
      check(name, false, 'expected rejection');
    } catch (e) {
      check(name, e instanceof RegionError && e.issues.length > 0 &&
        (!mustInclude || JSON.stringify(e.issues).includes(mustInclude)),
        JSON.stringify(e.issues || []));
    }
  };

  expectIssues('self crossing', {
    outer: [[0, 0], [80, 80], [80, 0], [0, 80]], holes: [] }, '交叉');
  expectIssues('duplicate vertex', {
    outer: [[0, 0], [80, 0], [80, 0], [0, 80]], holes: [] }, '重合');
  expectIssues('collinear overlap', {
    outer: [[0, 0], [40, 0], [80, 0], [80, 80], [0, 80]], holes: [] }, '重叠');
  expectIssues('hole touches outer', {
    outer: [[0, 0], [80, 0], [80, 80], [0, 80]],
    holes: [[[0, 20], [40, 20], [40, 40], [0, 40]]] }, '外环');
  expectIssues('holes touch each other', {
    outer: [[0, 0], [120, 0], [120, 120], [0, 120]],
    holes: [
      [[20, 20], [60, 20], [60, 60], [20, 60]],
      [[60, 40], [90, 40], [90, 80], [60, 80]]] }, '孔');
  expectIssues('too few vertices', { outer: [[0, 0], [80, 0]], holes: [] });
  expectIssues('non-integer vertex', { outer: [[0, 0], [80.5, 0], [80, 80]], holes: [] });

  // issue localization carries ring + edge/vertex indices
  try {
    validateRegion({ outer: [[0, 0], [80, 80], [80, 0], [0, 80]], holes: [] });
  } catch (e) {
    check('localized edges', e.issues.some((i) => Array.isArray(i.edges)));
  }

  // app-flow: invalid edit leaves the previous valid region intact
  const saved = JSON.parse(JSON.stringify(good));
  const edited = { outer: [[0, 0], [80, 80], [80, 0], [0, 80]], holes: [] };
  let current = saved;
  try { validateRegion(edited); current = edited; } catch { /* keep old */ }
  check('old region retained on invalid edit', current === saved);

  // 1024-vertex cap
  const big = { outer: Array.from({ length: 1025 }, (_, i) => [i * 16, (i % 2) * 16]), holes: [] };
  expectIssues('vertex cap', big, '1024');
}

// ---------- PGM parser ----------
{
  const samplePath = path.join(ROOT, 'samples', 'extracted', 'gray.pgm');
  const img = parsePgm(new Uint8Array(readFileSync(samplePath)));
  check('sample dimensions', img.width === 4 && img.height === 3 && img.maxval === 65535);
  check('sample first pixel BE16', img.gray[0] === 0x0064);
  check('sample second pixel', img.gray[1] === 0x00c8);
  let threw = false;
  try { parsePgm(new Uint8Array([0x50, 0x36, 0x0a])); } catch { threw = true; }
  check('P6 rejected', threw);
}

// ---------- cross-validation against the Python reference ----------
function runReference(caseDir) {
  const py = spawnSync('python3', ['-I', path.join(ROOT, 'tools', 'reference.py'),
    path.join(caseDir, 'gray.pgm'), path.join(caseDir, 'region.json')],
    { encoding: 'utf8' });
  if (py.status !== 0) throw new Error('reference.py failed: ' + py.stderr);
  return JSON.parse(py.stdout);
}

const caseNames = JSON.parse(readFileSync(path.join(CASES, 'manifest.json'), 'utf8'));
const timings = [];
for (const name of caseNames) {
  const dir = path.join(CASES, name);
  const region = JSON.parse(readFileSync(path.join(dir, 'region.json'), 'utf8'));
  const image = parsePgm(new Uint8Array(readFileSync(path.join(dir, 'gray.pgm'))));

  let valid = true;
  try { validateRegion(region); } catch (e) {
    valid = false;
    check(`[${name}] invalid region localized`, e.issues.length > 0);
    continue;
  }
  check(`[${name}] valid`, valid);

  const t0 = performance.now();
  const result = computeRasterMoments(region, image);
  timings.push([name, performance.now() - t0]);

  const ref = runReference(dir);
  for (const k of ['M00', 'M10', 'M01', 'M20', 'M02', 'M11']) {
    eqFrac(`[${name}] total ${k}`, result.totals[k], normFracStr(ref.totals[k]));
  }

  // per-cell agreement: geometric moments and area
  const refCells = new Map(ref.cells.map((c) => [`${c.r},${c.c}`, c]));
  let jsCells = 0;
  for (let r = 0; r < image.height; r++) {
    for (let c = 0; c < image.width; c++) {
      const got = cellContributions(result, image, r, c);
      const want = refCells.get(`${r},${c}`);
      if (!got) { check(`[${name}] cell ${r},${c} absent`, !want); continue; }
      jsCells++;
      check(`[${name}] cell ${r},${c} exists`, !!want);
      if (!want) continue;
      eqFrac(`[${name}] cell ${r},${c} area`, got.area, normFracStr(want.area));
      for (const k of ['M00', 'M10', 'M01', 'M20', 'M02', 'M11']) {
        eqFrac(`[${name}] cell ${r},${c} weighted ${k}`, got.weighted[k],
          mulFracStr(want.g, want[k]));
      }
    }
  }
  check(`[${name}] cell count`, jsCells === ref.cells.length, `${jsCells} vs ${ref.cells.length}`);

  // derived stats and zero-mass rule
  const stats = derivedStats(result.totals);
  if (result.totals.M00.isZero()) {
    check(`[${name}] zero mass nulls`, stats.centroid === null && stats.covariance === null);
  } else {
    check(`[${name}] centroid present`, stats.centroid && stats.covariance);
  }
}

function mulFracStr(g, fracStr) {
  const parts = fracStr.split('/');
  const n = BigInt(parts[0]);
  const d = BigInt(parts[1] ?? '1');
  return new Fraction(BigInt(g) * n, d).toString();
}

// ---------- performance ----------
for (const [name, ms] of timings) {
  if (name === 'perf_256') {
    console.log(`perf: ${name} ${ms.toFixed(1)} ms`);
    check('256x256 under 5s', ms < 5000);
  } else {
    console.log(`time: ${name} ${ms.toFixed(1)} ms`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
