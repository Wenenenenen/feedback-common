/* Node test suite for the tetrahedral probe core.

   Run: node test/run.js
   Covers exact predicates, degeneracy reasons, triangulation invariants, shuffle
   stability, and the query contract (non-negative weights, projection, clamping). */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const CORE = require(path.join(__dirname, '..', 'src', 'core.js'));
const TRI = require(path.join(__dirname, '..', 'src', 'tri.js'));
const QUERY = require(path.join(__dirname, '..', 'src', 'query.js'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

function group(name) { console.log('\n' + name); }

/* ---------------------------------------------------------------- helpers */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomPoints(n, seed) {
  const r = rng(seed);
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const p = [
      Math.floor(r() * 2001) - 1000,
      Math.floor(r() * 2001) - 1000,
      Math.floor(r() * 2001) - 1000,
    ];
    const k = p.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function lattice(dims, step) {
  const out = [];
  for (let x = 0; x < dims[0]; x++)
    for (let y = 0; y < dims[1]; y++)
      for (let z = 0; z < dims[2]; z++) out.push([x * step, y * step, z * step]);
  return out;
}

function fingerprintOf(points) {
  const r = TRI.triangulate(points);
  assert.ok(r.ok, 'triangulation failed: ' + r.message);
  return r.fingerprint;
}

function shuffle(points, seed) {
  const idx = points.map((_, i) => i);
  let s = seed * 7919 + 13;
  for (let i = idx.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return { points: idx.map((i) => points[i]), idx };
}

const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'samples', 'tetra-probe-cases.json'), 'utf8'));

const CASES = {
  cube: lattice([2, 2, 2], 4),
  grid3: lattice([3, 3, 3], 10),
  grid4: lattice([4, 4, 4], 10),
  box: lattice([2, 3, 4], 10),
  affine: SAMPLE.cases[0].probes.map((p) => p.p),
  cosphere: SAMPLE.cases[1].probes.map((p) => p.p),
  extremes: [
    [-1000, -1000, -1000], [1000, -1000, -1000], [-1000, 1000, -1000],
    [-1000, -1000, 1000], [1000, 1000, 1000], [1000, 1000, -1000],
    [1000, -1000, 1000], [-1000, 1000, 1000],
  ],
  random16: randomPoints(16, 3),
  random33: randomPoints(33, 7),
  random64: randomPoints(64, 11),
};

/* ---------------------------------------------------------------- core */

group('exact predicates');
test('orient sign follows right-hand rule', () => {
  assert.strictEqual(CORE.orient3d([0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4]), 1);
  assert.strictEqual(CORE.orient3d([0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, -4]), -1);
  assert.strictEqual(CORE.orient3d([0, 0, 0], [4, 0, 0], [0, 4, 0], [4, 4, 0]), 0);
});

test('insphere sign: centre inside, far point outside', () => {
  const a = [0, 0, 0], b = [4, 0, 0], c = [0, 4, 0], d = [0, 0, 4];
  assert.strictEqual(CORE.insphereSign(a, b, c, d, [1, 1, 1]), 1);
  assert.strictEqual(CORE.insphereSign(a, b, c, d, [40, 40, 40]), -1);
});

test('cospherical tie is broken deterministically', () => {
  const a = [0, 0, 0], b = [4, 0, 0], c = [0, 4, 0], d = [0, 0, 4];
  const e = [4, 4, 4]; /* on the same sphere */
  const base = CORE.insphereInfo(a, b, c, d, e, 0, 1, 2, 3, 4);
  assert.strictEqual(base.tie, true);
  for (let k = 0; k < 5; k++) {
    const again = CORE.insphereInfo(a, b, c, d, e, 0, 1, 2, 3, 4);
    assert.strictEqual(again.sign, base.sign);
  }
  assert.notStrictEqual(base.sign, 0);
});

/* ---------------------------------------------------------------- degeneracy */

group('degeneracy reasons');
test('too few probes', () => {
  const r = TRI.triangulate([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'too-few');
  assert.ok(/至少需要 4/.test(r.message));
});
test('duplicate coordinates', () => {
  const r = TRI.triangulate([[0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4], [4, 0, 0]]);
  assert.strictEqual(r.code, 'duplicate');
  assert.ok(/重合/.test(r.message));
});
test('collinear probes', () => {
  const r = TRI.triangulate([[0, 0, 0], [3, 3, 3], [6, 6, 6], [9, 9, 9]]);
  assert.strictEqual(r.code, 'collinear');
  assert.ok(/直线/.test(r.message));
});
test('coplanar probes name a defining plane', () => {
  const r = TRI.triangulate([[0, 0, 0], [4, 0, 0], [0, 4, 0], [4, 4, 0], [2, 2, 0]]);
  assert.strictEqual(r.code, 'coplanar');
  assert.ok(/共面/.test(r.message));
  assert.strictEqual(r.detail.plane.length, 3);
});
test('integer coordinates outside range are still handled exactly', () => {
  const r = TRI.triangulate([[0, 0, 0], [1000, 0, 0], [0, 1000, 0], [0, 0, 1000], [500, 500, 500]]);
  assert.ok(r.ok, r.message);
  assert.ok(r.validation.ok);
});

/* ---------------------------------------------------------------- triangulation */

group('triangulation invariants');
for (const [name, points] of Object.entries(CASES)) {
  test(name + ': valid, oriented, volume closed, empty spheres', () => {
    const r = TRI.triangulate(points);
    assert.ok(r.ok, r.message);
    assert.ok(r.validation.ok, (r.validation.errors || []).join('; '));
    assert.strictEqual(r.validation.sphereViolations, 0);
    assert.ok(r.tets.length >= 1);
    /* every probe is used exactly once per contained region */
    const used = new Set();
    for (const t of r.tets) for (const v of t) used.add(v);
    assert.strictEqual(used.size, points.length);
  });
}

test('shuffle stability across all cases', () => {
  for (const [name, points] of Object.entries(CASES)) {
    const base = fingerprintOf(points);
    for (let k = 1; k <= 3; k++) {
      const sh = shuffle(points, k);
      assert.strictEqual(fingerprintOf(sh.points), base, name + ' shuffle ' + k);
    }
  }
});

test('cospherical cube is deterministic between identical runs', () => {
  const a = TRI.triangulate(CASES.cube);
  const b = TRI.triangulate(CASES.cube);
  assert.strictEqual(a.fingerprint, b.fingerprint);
});

test('hull faces are convex and outward', () => {
  const r = TRI.triangulate(CASES.random33);
  assert.ok(r.hull.length > 0);
  for (const h of r.hull) {
    const [a, b, c] = h.tri;
    for (let i = 0; i < r.points.length; i++) {
      if (h.tri.includes(i)) continue;
      const s = CORE.detOrientBig(r.points[a], r.points[b], r.points[c], r.points[i]);
      assert.ok(s < 0n, 'hull face ' + h.tri + ' has point on the outside');
    }
  }
});

test('adjacency is symmetric', () => {
  const r = TRI.triangulate(CASES.random16);
  for (let i = 0; i < r.tets.length; i++) {
    for (let fi = 0; fi < 4; fi++) {
      const nb = r.neighbors[i][fi];
      if (nb < 0) continue;
      let back = false;
      for (let fj = 0; fj < 4; fj++) if (r.neighbors[nb][fj] === i) back = true;
      assert.ok(back, 'neighbour not symmetric for tet ' + i);
    }
  }
});

/* ---------------------------------------------------------------- queries */

function coeffsFor(probes) {
  return probes.map((p) => p.c);
}

function hullOf(points) {
  const r = TRI.triangulate(points);
  assert.ok(r.ok, r.message);
  return r;
}

group('query contract');
test('inside weights are non-negative and sum to one', () => {
  const r = hullOf(CASES.random16);
  const rnd = rng(99);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of r.points) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]);
  }
  const coeffs = r.points.map((p, i) => [
    [0.2 + i * 0.001, 0.1, 0, 0],
    [0.2, 0.1, 0, 0],
    [0.2, 0.1, 0, 0],
  ]);
  let insideCount = 0;
  for (let n = 0; n < 120; n++) {
    const q = [0, 1, 2].map((k) => min[k] + rnd() * (max[k] - min[k]));
    const res = QUERY.evaluate(r.points, r.tets, r.hull, coeffs, q, [0, 1, 0]);
    if (!res || res.outside) continue;
    insideCount++;
    const sum = res.weights.reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, 'weights sum ' + sum);
    for (const w of res.weights) assert.ok(w >= -1e-9, 'negative weight ' + w);
  }
  assert.ok(insideCount > 40, 'sample points mostly outside the hull');
});

test('outside query projects onto the hull surface', () => {
  const r = hullOf(CASES.cube);
  const coeffs = r.points.map(() => [[0.5, 0, 0, 0], [0.5, 0, 0, 0], [0.5, 0, 0, 0]]);
  const q = [40, 40, 40];
  const res = QUERY.evaluate(r.points, r.tets, r.hull, coeffs, q, [0, 1, 0]);
  assert.ok(res.outside);
  assert.ok(res.projected, 'expected a projected point');
  assert.ok(res.distance > 0);
  /* The projected point must lie on the hull: on some hull triangle. */
  const p = res.projected;
  let onHull = false;
  for (const h of r.hull) {
    const [a, b, c] = h.tri.map((i) => r.points[i]);
    const b3 = QUERY.barycentric(r.points, [h.tri[0], h.tri[1], h.tri[2], (() => {
      /* any vertex will do for the triangle-plane test; use an off-plane helper */
      return r.tets[h.tet].find((v) => !h.tri.includes(v));
    })()], p);
    if (b3.inside) { onHull = true; break; }
  }
  assert.ok(onHull, 'projected point is not on the hull');
});

test('outside coefficients stay inside the probe range (no extrapolation)', () => {
  const r = hullOf(CASES.random16);
  const coeffs = r.points.map((p, i) => [
    [0.1 + (i % 5) * 0.1, 0.2, 0.05, 0],
    [0.2 + (i % 3) * 0.1, 0.1, 0, 0.05],
    [0.3 + (i % 7) * 0.05, 0, 0.1, 0],
  ]);
  const lo = [[Infinity, Infinity, Infinity, Infinity], [Infinity, Infinity, Infinity, Infinity], [Infinity, Infinity, Infinity, Infinity]];
  const hi = [[-Infinity, -Infinity, -Infinity, -Infinity], [-Infinity, -Infinity, -Infinity, -Infinity], [-Infinity, -Infinity, -Infinity, -Infinity]];
  for (const c of coeffs) {
    for (let ch = 0; ch < 3; ch++) for (let j = 0; j < 4; j++) {
      lo[ch][j] = Math.min(lo[ch][j], c[ch][j]);
      hi[ch][j] = Math.max(hi[ch][j], c[ch][j]);
    }
  }
  for (let n = 0; n < 60; n++) {
    const q = [1200 - n * 41, 900 - n * 33, 1100 - n * 27];
    const res = QUERY.evaluate(r.points, r.tets, r.hull, coeffs, q, [0, 1, 0]);
    assert.ok(res.ok);
    for (let ch = 0; ch < 3; ch++) {
      for (let j = 0; j < 4; j++) {
        assert.ok(res.coeff[ch][j] >= lo[ch][j] - 1e-9 && res.coeff[ch][j] <= hi[ch][j] + 1e-9,
          'coefficient escaped probe range: ' + res.coeff[ch][j]);
      }
    }
    for (const w of res.weights) assert.ok(w >= -1e-9);
  }
});

test('lighting clamps negatives to zero', () => {
  const points = CASES.affine;
  const r = hullOf(points);
  const coeffs = points.map(() => [[-1, 0, 0, 0], [-1, 0, 0, 0], [-1, 0, 0, 0]]);
  const res = QUERY.evaluate(points, r.tets, r.hull, coeffs, points[4], [0, 1, 0]);
  assert.deepStrictEqual(res.clamped, [0, 0, 0]);
  assert.deepStrictEqual(res.negative, [true, true, true]);
});

test('interpolation is exact at probes', () => {
  const points = CASES.affine;
  const r = hullOf(points);
  const coeffs = points.map((p, i) => [
    [i * 0.1, 0.2, 0.3, 0.4],
    [i * 0.2, 0.1, 0, 0.2],
    [i * 0.3, 0, 0.2, 0.1],
  ]);
  for (let i = 0; i < points.length; i++) {
    const res = QUERY.evaluate(points, r.tets, r.hull, coeffs, points[i], [0, 1, 0]);
    for (let ch = 0; ch < 3; ch++) {
      for (let j = 0; j < 4; j++) {
        assert.ok(Math.abs(res.coeff[ch][j] - coeffs[i][ch][j]) < 1e-9,
          'probe ' + i + ' channel ' + ch + ' term ' + j);
      }
    }
  }
});

test('crossing a cell face does not change the lighting', () => {
  const points = CASES.random16;
  const r = hullOf(points);
  const coeffs = points.map((p, i) => [
    [0.1 + i * 0.01, 0.2, 0.05, 0],
    [0.2, 0.1 + i * 0.005, 0, 0.05],
    [0.3, 0, 0.1, i * 0.01],
  ]);
  const byKey = new Map();
  for (let ti = 0; ti < r.tets.length; ti++) {
    for (let fi = 0; fi < 4; fi++) {
      const f = CORE.faceOf(r.tets[ti], fi);
      const k = CORE.faceKey(f[0], f[1], f[2]);
      const e = byKey.get(k);
      if (e) e.push(ti); else byKey.set(k, [ti]);
    }
  }
  /* On a shared face, the two adjacent tetrahedra must interpolate identically: the shared
     face vertices are the only ones that carry non-zero weight from either side. */
  function interpOn(tet, pt) {
    const b = QUERY.barycentric(points, tet, pt);
    const w = b.normalized.map((v) => (Math.abs(v) < 1e-12 ? 0 : v));
    const out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let k = 0; k < 4; k++) {
      for (let ch = 0; ch < 3; ch++) for (let j = 0; j < 4; j++) {
        out[ch][j] += w[k] * coeffs[tet[k]][ch][j];
      }
    }
    return out;
  }
  let worst = 0, checked = 0;
  for (const [k, lst] of byKey) {
    if (lst.length !== 2) continue;
    const f = k.split(',').map(Number);
    const centroid = [0, 1, 2].map(
      (d) => (points[f[0]][d] + points[f[1]][d] + points[f[2]][d]) / 3);
    const A = interpOn(r.tets[lst[0]], centroid);
    const B = interpOn(r.tets[lst[1]], centroid);
    for (let ch = 0; ch < 3; ch++) for (let j = 0; j < 4; j++) {
      worst = Math.max(worst, Math.abs(A[ch][j] - B[ch][j]));
    }
    checked++;
  }
  assert.ok(checked > 0);
  assert.ok(worst < 1e-9, 'worst discontinuity ' + worst);
});

/* ---------------------------------------------------------------- samples */

group('sample cases from samples/tetra-probe-cases.json');
for (const cse of SAMPLE.cases) {
  test(cse.id + ': triangulates and every query resolves', () => {
    const points = cse.probes.map((p) => p.p);
    const r = hullOf(points);
    const coeffs = cse.probes.map((p) => p.c);
    for (const q of cse.queries) {
      const res = QUERY.evaluate(points, r.tets, r.hull, coeffs, q, [0, 1, 0]);
      assert.ok(res.ok);
      assert.ok(res.weights.every((w) => w >= -1e-9));
      assert.ok(res.clamped.every((v) => v >= 0));
    }
  });
}

/* ---------------------------------------------------------------- report */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  for (const f of failures) console.log('\n' + f.name + '\n' + (f.err.stack || f.err.message));
  process.exit(1);
}
