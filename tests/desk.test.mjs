import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  buildCase, denseMatrices, solveDenseQP, objectiveFromFilters, directResidual,
} from './reference.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/core.js');
const ZIP = require('../src/inflate.js');
const REPORT = require('../src/report.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------ validation ------------------------------ */

test('project validation names the offending field and index', () => {
  const base = {
    weights: [1, 1], limits: [0.8, 0.8], h_lengths: [[8, 8], [8, 8]],
    t_lengths: [[4], [4]], lambda: 0.2, delay: 1, taps: 16,
  };
  assert.equal(core.validateProjectObject(base).errors.length, 0);

  const cases = [
    [{ ...base, weights: [1, 5] }, 'project.json: weights[1]'],
    [{ ...base, limits: [0.8, 0] }, 'project.json: limits[1]'],
    [{ ...base, lambda: 9 }, 'project.json: lambda'],
    [{ ...base, delay: 4096 }, 'project.json: delay'],
    [{ ...base, taps: 0 }, 'project.json: taps'],
    [{ ...base, h_lengths: [[8, 8], [8]] }, 'project.json: h_lengths[1]'],
    [{ ...base, t_lengths: [[4, 4], [4]] }, 'project.json: t_lengths[1]'],
    [{ ...base, weights: [1, 1, 1] }, 'project.json: weights'],
    [{ ...base, h_lengths: [[8, 8, 8, 8, 8, 8, 8, 8, 8], [8, 8, 8, 8, 8, 8, 8, 8, 8]] }, 'project.json: h_lengths[0]'],
    [{ ...base, h_lengths: [[8, 8], [8, 8], [8, 8]] }, 'project.json: t_lengths'],
  ];
  for (const [proj, expectedPath] of cases) {
    const out = core.validateProjectObject(proj);
    assert.ok(out.errors.length > 0, `expected error for ${expectedPath}`);
    assert.ok(out.errors.some((e) => e.path === expectedPath || e.path.startsWith(expectedPath)),
      `expected path ${expectedPath}, got ${out.errors.map((e) => e.path).join(', ')}`);
  }
});

test('signal parsing locates bad samples and rejects size mismatch', () => {
  const cfg = {
    M: 2, P: 2, Q: 1,
    h_lengths: [[3, 3], [3, 3]], t_lengths: [[2], [2]],
  };
  const n = 16; // 4 paths x 3 + 2 paths x 2
  const good = new Float32Array(n);
  good.fill(0.1);
  const bytes = new Uint8Array(good.buffer.slice(0));
  assert.equal(core.parseSignals(bytes.buffer, cfg).errors.length, 0);

  // NaN at h[m=1][p=0][n=1] -> flat index
  const bad = good.slice();
  const hOffsets = [];
  let off = 0;
  for (let m = 0; m < 2; m++) for (let p = 0; p < 2; p++) { hOffsets.push({ m, p, off }); off += 3; }
  bad[hOffsets[2].off + 1] = NaN;
  let r = core.parseSignals(new Uint8Array(bad.buffer.slice(0)).buffer, cfg);
  assert.ok(r.errors.length > 0);
  assert.match(r.errors[0].path, /signals\.f32/);
  assert.match(r.errors[0].path, /h\[m=2\]\[p=1\]\[n=1\]/);

  const over = good.slice();
  over[0] = 1.5;
  r = core.parseSignals(new Uint8Array(over.buffer.slice(0)).buffer, cfg);
  assert.match(r.errors[0].message, /超过 1/);

  r = core.parseSignals(new Uint8Array(8).buffer, cfg);
  assert.equal(r.errors[0].path, 'signals.f32');
  assert.match(r.errors[0].message, /期望/);
});

test('energy bound uses sum over paths inside the square', () => {
  const H = [[new Float64Array([0.5, -0.5]), new Float64Array([0.25])],
             [new Float64Array([1]), new Float64Array([0])]];
  const e = core.energyTerms(H, [2, 1]);
  // m0: l1 = 1 and 0.25 -> 1 + 0.0625 = 1.0625, *2 = 2.125
  assert.ok(Math.abs(e.perMeasurement[0].val - 2.125) < 1e-12);
  // m1: l1 = 1 and 0 -> 1, *1 = 1
  assert.ok(Math.abs(e.perMeasurement[1].val - 1) < 1e-12);
  assert.ok(Math.abs(e.total - 3.125) < 1e-12);
});

/* ------------------------------- zip ------------------------------------ */

test('zip reader handles stored and deflate, rejects traversal', async () => {
  const sample = path.join(ROOT, 'samples', 'array-inverse-cases.zip');
  const entries = await ZIP.unzip(fs.readFileSync(sample));
  assert.deepEqual([...entries.keys()].sort(), ['project.json', 'signals.f32', '约定.txt']);
  const proj = JSON.parse(new TextDecoder().decode(entries.get('project.json')));
  assert.equal(proj.taps, 16);

  const built = ZIP.zip([
    { name: 'a/one.txt', data: new TextEncoder().encode('hello') },
    { name: 'b.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
  ]);
  const back = await ZIP.unzip(built);
  assert.equal(new TextDecoder().decode(back.get('a/one.txt')), 'hello');
  assert.deepEqual([...back.get('b.bin')], [1, 2, 3, 4, 5]);

  // traversal entry must be refused
  const evil = ZIP.zip([{ name: '../escape.txt', data: new TextEncoder().encode('x') }]);
  await assert.rejects(() => ZIP.unzip(evil), /非法/);

  await assert.rejects(() => ZIP.unzip(new Uint8Array(32)), /ZIP/);
});

/* ------------------------------ solver ---------------------------------- */

function tinyCfg(over = {}) {
  const cfg = buildCase({
    M: 3, P: 3, Q: 2,
    hLens: (m, p) => 40 + 5 * ((m * 3 + p) % 4),
    tLens: (m, q) => 30 + q * 7,
    taps: 20, delay: 9, lambda: 0.2,
    weights: [1, 1.5, 0.7], limits: [0.05, 0.03, 0.08],
    seed: 5, amplitude: 0.02, ...over,
  });
  cfg.weights = over.weights || [1, 1.5, 0.7];
  cfg.limits = over.limits || [0.05, 0.03, 0.08];
  return cfg;
}

test('solveAll matches dense reference and certifies the export', async () => {
  const cfg = tinyCfg();
  const res = await core.solveAll(cfg, { yieldFn: async () => {} });
  assert.equal(res.aborted, false);
  const { B, cs, n } = denseMatrices(cfg);
  const G = [];
  for (let p = 0; p < cfg.P; p++) for (let k = 0; k < cfg.taps; k++) G.push(cfg.limits[p]);
  for (let q = 0; q < cfg.Q; q++) {
    const ref = solveDenseQP(B, cs[q], G, n, { tol: 1e-12 });
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(ref.f[i] - res.filters[q][i]));
    assert.ok(diff < 1e-7, `q${q} solution diff ${diff}`);
  }
  // objective from an independent time-domain evaluation
  const refObj = objectiveFromFilters(cfg, res.filters).total;
  assert.ok(Math.abs(refObj - res.objective) < 1e-10 * Math.max(1, refObj), `objective ${res.objective} vs ${refObj}`);

  const exp = core.makeExport(cfg, res);
  const expJson = JSON.parse(JSON.stringify(exp));
  assert.deepEqual(expJson, exp);
  assert.equal(exp.sample_rate, 48000);
  assert.equal(exp.taps, cfg.taps);
  assert.equal(exp.delay, cfg.delay);
  assert.equal(exp.lambda, cfg.lambda);
  assert.equal(exp.filters.length, cfg.P);
  assert.equal(exp.filters[0].length, cfg.Q);
  assert.equal(exp.filters[0][0].length, cfg.taps);
  const cert = core.certifyExport(cfg, exp);
  assert.ok(cert.withinTolerance, `cert pg ${cert.projectedResidual}`);
  assert.ok(cert.projectedResidual <= 1e-7);
  assert.equal(cert.maxOverrun, 0);
});

test('covariance operator, rhs and predictions match direct convolution', async () => {
  const cfg = tinyCfg();
  const spec = core.buildSpectra(cfg);
  const engine = core.buildEngine(cfg, spec);
  const { B, cs, n } = denseMatrices(cfg);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(0.37 * i);
  const y = new Float64Array(n);
  engine.matvec(x, y, null);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += B[i * n + j] * x[j];
    assert.ok(Math.abs(s - y[i]) < 1e-10);
  }
  const N = spec.geo.N;
  for (let q = 0; q < cfg.Q; q++) {
    const c = core.computeC(cfg, spec, q);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(c[i] - cs[q][i]) < 1e-11);
    const pred = core.computePrediction(cfg, spec, x, q);
    const res = directResidual(cfg, x, q);
    for (let m = 0; m < cfg.M; m++) {
      const t = core.shiftedTarget(cfg, m, q);
      for (let i = 0; i < N; i++) {
        assert.ok(Math.abs(pred[m][i] - (res[m][i] + t[i])) < 1e-10);
      }
    }
  }
});

test('rank-deficient and degenerate measurements still certify', async () => {
  const cases = [
    // identical speakers everywhere
    { hLens: () => 30, tLens: () => 20, taps: 16, delay: 4, M: 2, P: 3, Q: 1,
      gen: (m, p, n) => 0.05 * Math.sin(0.2 * n + 0.5 * m) },
    // one silent speaker
    { hLens: () => 30, tLens: () => 20, taps: 16, delay: 4, M: 2, P: 3, Q: 1,
      gen: (m, p, n) => (p === 2 ? 0 : 0.05 * Math.sin(0.2 * n + 0.5 * m + 1.9 * p)) },
    // one silent measurement with all-zero targets
    { hLens: () => 20, tLens: () => 15, taps: 10, delay: 2, M: 3, P: 2, Q: 2,
      gen: (m, p, n) => (m === 1 ? 0 : 0.04 * Math.sin(0.17 * n + p)) },
    // entire case zero
    { hLens: () => 8, tLens: () => 4, taps: 4, delay: 0, M: 2, P: 2, Q: 1,
      gen: () => 0 },
  ];
  for (const c of cases) {
    const cfg = buildCase({
      M: c.M, P: c.P, Q: c.Q, hLens: c.hLens, tLens: c.tLens,
      taps: c.taps, delay: c.delay, lambda: 0.05,
      weights: Array(c.M).fill(1), limits: Array(c.P).fill(0.3),
      seed: 9,
    });
    for (let m = 0; m < cfg.M; m++) for (let p = 0; p < cfg.P; p++) {
      for (let nn = 0; nn < cfg.H[m][p].length; nn++) cfg.H[m][p][nn] = c.gen(m, p, nn);
    }
    const res = await core.solveAll(cfg, { yieldFn: async () => {} });
    assert.equal(res.aborted, false);
    assert.ok(res.projectedResidual <= 1e-7, `pg ${res.projectedResidual}`);
    const cert = core.certifyExport(cfg, JSON.parse(JSON.stringify(core.makeExport(cfg, res))));
    assert.ok(cert.withinTolerance, `cert ${cert.projectedResidual}`);
    for (let q = 0; q < cfg.Q; q++) for (let p = 0; p < cfg.P; p++) for (let k = 0; k < cfg.taps; k++) {
      assert.ok(Math.abs(res.filters[q][p * cfg.taps + k]) <= cfg.limits[p] + 1e-14);
    }
  }
});

test('cancellation never publishes a result and leaves the caller in control', async () => {
  const cfg = tinyCfg();
  let calls = 0;
  const res = await core.solveAll(cfg, {
    yieldFn: async () => {},
    shouldAbort: () => { calls += 1; return calls > 1; },
  });
  assert.equal(res.aborted, true);
  assert.equal(res.filters, undefined);
});

test('stage events arrive in order and carry progress', async () => {
  const cfg = tinyCfg();
  const events = [];
  await core.solveAll(cfg, { yieldFn: async () => {}, onEvent: (e) => events.push(e) });
  const stages = events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.ok(stages.includes('spectra'));
  assert.ok(stages.includes('operator'));
  assert.ok(stages.includes('rhs'));
  assert.ok(stages.includes('solve'));
  assert.ok(stages.includes('iterate'));
});

/* ------------------------- report pipeline ------------------------------ */

test('report payload exposes export, curves and certification', async () => {
  const cfg = tinyCfg();
  const payload = await REPORT.runSolve(cfg);
  assert.equal(payload.aborted, false);
  assert.ok(payload.certification.withinTolerance);
  assert.ok(payload.certification.projectedResidual <= 1e-7);
  assert.equal(payload.series.length, cfg.Q);
  for (const s of payload.series) {
    assert.equal(s.target.length, cfg.M);
    for (let m = 0; m < cfg.M; m++) {
      assert.equal(s.target[m].length, payload.geometry.N);
      assert.equal(s.prediction[m].length, payload.geometry.N);
      assert.equal(s.residual[m].length, payload.geometry.N);
      for (let i = 0; i < payload.geometry.N; i++) {
        assert.ok(Math.abs(s.residual[m][i] - (s.prediction[m][i] - s.target[m][i])) < 1e-15);
      }
    }
  }
  const decoded = JSON.parse(payload.exportText);
  assert.equal(decoded.projected_residual, payload.certification.projectedResidual);
  assert.equal(decoded.objective, payload.objective);
  const transfer = REPORT.transferables(payload);
  assert.ok(transfer.length >= cfg.Q * cfg.P * 3);
});

/* --------------------------- full scale budget -------------------------- */

test('full-scale worst case solves inside the 25 s budget', async () => {
  const M = 8, P = 8, Q = 2, hlen = 4096, tlen = 4096, taps = 4096, delay = 4095;
  let seed = 21;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rn = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const H = [], T = [], h_lengths = [], t_lengths = [];
  const weights = Array(M).fill(4);
  const l1per = Math.sqrt(15.5 / (M * 4 * P)) * 0.99;
  for (let m = 0; m < M; m++) {
    H.push([]); h_lengths.push([]);
    for (let p = 0; p < P; p++) {
      const h = new Float64Array(hlen);
      let acc = 0;
      for (let n = 0; n < hlen; n++) { acc = 0.98 * acc + rn() * 0.1; h[n] = acc * Math.exp(-n / 900); }
      let s1 = 0;
      for (let n = 0; n < hlen; n++) s1 += Math.abs(h[n]);
      for (let n = 0; n < hlen; n++) h[n] *= l1per / s1;
      H[m].push(h); h_lengths[m].push(hlen);
    }
  }
  for (let m = 0; m < M; m++) {
    T.push([]); t_lengths.push([]);
    for (let q = 0; q < Q; q++) {
      const t = new Float64Array(tlen);
      for (let n = 0; n < tlen; n++) t[n] = 0.02 * rn() * Math.exp(-n / 1500);
      T[m].push(t); t_lengths[m].push(tlen);
    }
  }
  const cfg = { M, P, Q, H, T, h_lengths, t_lengths, weights, limits: Array(P).fill(0.001), lambda: 0.05, delay, taps };
  const t0 = core.now();
  const res = await core.solveAll(cfg, { yieldFn: async () => {} });
  const elapsed = core.now() - t0;
  assert.equal(res.aborted, false);
  assert.ok(res.geometry.N === 8191, `N ${res.geometry.N}`);
  assert.ok(res.geometry.L <= 8192, `L ${res.geometry.L}`);
  assert.ok(res.projectedResidual <= 1e-7, `pg ${res.projectedResidual}`);
  const json = JSON.parse(JSON.stringify(core.makeExport(cfg, res)));
  const cert = core.certifyExport(cfg, json);
  assert.ok(cert.withinTolerance);
  assert.ok(elapsed < 25000, `solve took ${elapsed} ms`);
});
