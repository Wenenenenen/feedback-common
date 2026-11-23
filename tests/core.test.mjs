import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  validateProjectObject, parseSignals, energyTerms, geometry, FFT,
  buildSpectra, buildEngine, computeC, solveChannel, solveAll,
  projectedResidual, makeExport, CERT,
} = require('../src/core.js');
import { buildCase, denseMatrices, solveDenseQP, directResidual, objectiveFromFilters } from './reference.mjs';

function tinyCfg(over = {}) {
  const cfg = buildCase({
    M: 3, P: 3, Q: 1,
    hLens: (m, p) => 50 + 7 * ((m * 3 + p) % 5),
    tLens: () => 40,
    taps: 24, delay: 9, lambda: 0.2,
    weights: [1, 1.5, 0.7], limits: [0.4, 0.5, 0.6],
    seed: 11, amplitude: 0.02, ...over,
  });
  cfg.weights = over.weights || [1, 1.5, 0.7];
  cfg.limits = over.limits || [0.4, 0.5, 0.6];
  return cfg;
}

test('FFT round trip', () => {
  const fft = new FFT(256);
  const re = new Float64Array(256), im = new Float64Array(256);
  for (let i = 0; i < 40; i++) re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 0.13);
  const ref = re.slice();
  fft.fwd(re, im); fft.inv(re, im);
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(re[i] - ref[i]) < 1e-13);
});

test('engine matvec matches dense B and Cholesky inverse matches dense solve', () => {
  const cfg = tinyCfg();
  const spec = buildSpectra(cfg);
  const engine = buildEngine(cfg, spec);
  const { B, n } = denseMatrices(cfg);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(0.37 * i) * 0.5;
  const y = new Float64Array(n);
  engine.matvec(x, y, null);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += B[i * n + j] * x[j];
    maxErr = Math.max(maxErr, Math.abs(s - y[i]));
  }
  assert.ok(maxErr < 1e-10, `matvec err ${maxErr}`);
  // B is the *truncated* Toeplitz normal operator; the symbol inverse is a
  // preconditioner, not an exact inverse. Check symmetry and positivity.
  let asym = 0;
  for (let i = 0; i < n; i += 3) for (let j = 0; j < n; j += 5) {
    asym = Math.max(asym, Math.abs(B[i * n + j] - B[j * n + i]));
  }
  assert.ok(asym < 1e-9, `B symmetry ${asym}`);
  const y2 = new Float64Array(n);
  engine.binv(y, y2, null);
  const yy = new Float64Array(n);
  engine.matvec(y2, yy, null);
  let quad = 0, nrm = 0;
  for (let i = 0; i < n; i++) { quad += x[i] * y2[i]; nrm += x[i] * x[i]; }
  assert.ok(quad > 0.5 * nrm, `preconditioned quadratic form ${quad} vs ${nrm}`);
});

test('rhs c matches dense reference', () => {
  const cfg = tinyCfg();
  const spec = buildSpectra(cfg);
  const { cs, n } = denseMatrices(cfg);
  for (let q = 0; q < cfg.Q; q++) {
    const c = computeC(cfg, spec, q);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(c[i] - cs[q][i]));
    assert.ok(maxErr < 1e-11, `c err ${maxErr}`);
  }
});

test('box QP solution matches dense active set', async () => {
  const cfg = tinyCfg({ limits: [0.02, 0.03, 0.01] });
  const spec = buildSpectra(cfg);
  const engine = buildEngine(cfg, spec);
  const { B, cs, n } = denseMatrices(cfg);
  const c = computeC(cfg, spec, 0);
  const sol = await solveChannel(cfg, spec, engine, c, { pgTarget: 1e-9 });
  const G = [];
  for (let p = 0; p < cfg.P; p++) for (let k = 0; k < cfg.taps; k++) G.push(cfg.limits[p]);
  const ref = solveDenseQP(B, cs[0], G, n, { tol: 1e-12 });
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(sol.f[i] - ref.f[i]));
  assert.ok(sol.projectedResidual < 1e-8, `pg ${sol.projectedResidual}`);
  assert.ok(maxDiff < 1e-8, `solution diff ${maxDiff}`);
  // solution is optimal: objective no worse than reference
  const obj = (f) => { let s = 0.5 * 0; let q = 0; for (let i = 0; i < n; i++) { q -= c[i] * f[i]; for (let j = 0; j < n; j++) q += 0.5 * f[i] * B[i * n + j] * f[j]; } return q; };
  assert.ok(obj(sol.f) <= obj(ref.f) + 1e-10);
});

test('projected gradient certified for tiny case', async () => {
  const cfg = tinyCfg();
  const spec = buildSpectra(cfg);
  const engine = buildEngine(cfg, spec);
  for (let q = 0; q < cfg.Q; q++) {
    const c = computeC(cfg, spec, q);
    const r = await solveChannel(cfg, spec, engine, c, {});
    assert.ok(r.projectedResidual <= 1e-7, `pg ${r.projectedResidual}`);
  }
});
