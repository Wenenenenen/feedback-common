#!/usr/bin/env node
/*
 * Core test suite.  Run with: node --test tests/
 * Uses only node:test / node:assert and the core module.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const BHE = require('../src/core.js');

const SAMPLES = path.join(__dirname, '..', 'samples', 'extracted');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8'));

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, name + '.json'), 'utf8'));
}

function run(name, lambda) {
  const v = BHE.validateInput(load(name));
  assert.equal(v.ok, true, name + ' should validate');
  return { data: v.data, model: BHE.extract(v.data, lambda == null ? BHE.DEFAULT_LAMBDA : lambda) };
}

const COUNT_KEYS = ['vertices', 'triangles', 'boundary_crossings', 'boundary_edges', 'nonmanifold_edges'];

test('all reference cases reproduce the documented topology counts', () => {
  for (const [name, exp] of Object.entries(EXPECTED)) {
    const { model } = run(name);
    const c = BHE.expectedCounts(model);
    for (const k of COUNT_KEYS) {
      if (exp[k] == null) continue;
      assert.equal(c[k], exp[k], name + '.' + k);
    }
  }
});

test('skew-cell lands on the true box-constrained minimum, not a clamped one', () => {
  const { model } = run('skew-cell');
  const exp = EXPECTED['skew-cell'];
  const v = model.vertices[0];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(v.position[i] - exp.position[i]) <= 1e-9 * Math.max(1, Math.abs(exp.position[i])),
      'position[' + i + '] got ' + v.position[i] + ' want ' + exp.position[i]);
    assert.ok(Math.abs(v.unconstrained[i] - exp.unconstrained[i]) <= 1e-9 * Math.max(1, Math.abs(exp.unconstrained[i])),
      'unconstrained[' + i + ']');
  }
  assert.ok(Math.abs(v.objective - exp.objective) <= 1e-9 * Math.max(1, exp.objective));
  assert.deepEqual(v.activeAxes, exp.active_axes);
  // The naive per-axis clamp is strictly worse.
  assert.ok(v.clampObjective > exp.naive_clamp_objective - 1e-12);
  assert.ok(v.clampObjective > v.objective + 1e-4);
});

test('rank-one plane is solved exactly, objective is zero', () => {
  const { model } = run('rank-one');
  const exp = EXPECTED['rank-one'];
  const v = model.vertices[0];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(v.position[i] - exp.position[i]) <= 1e-9);
  assert.ok(Math.abs(v.objective) <= 1e-12);
});

test('every vertex stays inside its own cell box', () => {
  for (const name of ['sphere', 'limit-sphere', 'anisotropic', 'sharp-box', 'inverted-sphere', 'checkerboard']) {
    const { model } = run(name);
    for (const v of model.vertices) {
      for (let a = 0; a < 3; a++) {
        assert.ok(v.position[a] >= v.box.lower[a] - 1e-12 && v.position[a] <= v.box.upper[a] + 1e-12,
          name + ' vertex ' + v.index + ' axis ' + a + ' escaped its box');
      }
    }
  }
});

test('the solved vertex is no worse than every candidate on a dense random probe', () => {
  // Sample 4000 points in the box and confirm none beats the reported objective
  // beyond tolerance. This catches "clamp each axis" style mistakes.
  const { model } = run('skew-cell');
  const v = model.vertices[0];
  const lo = v.box.lower, hi = v.box.upper;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const F = (x) => {
    let data = 0;
    for (const r of v.residuals) {
      const d = r.normal[0] * (x[0] - r.hit[0]) + r.normal[1] * (x[1] - r.hit[1]) + r.normal[2] * (x[2] - r.hit[2]);
      data += d * d;
    }
    const dc = [x[0] - v.centroid[0], x[1] - v.centroid[1], x[2] - v.centroid[2]];
    return data + model.lambda * (dc[0] * dc[0] + dc[1] * dc[1] + dc[2] * dc[2]);
  };
  for (let i = 0; i < 4000; i++) {
    const x = [lo[0] + rnd() * (hi[0] - lo[0]), lo[1] + rnd() * (hi[1] - lo[1]), lo[2] + rnd() * (hi[2] - lo[2])];
    assert.ok(F(x) >= v.objective - 1e-12, 'probe point ' + i + ' beats the reported minimum');
  }
});

test('lambda is honoured and stays within its documented range', () => {
  const { data } = run('sphere');
  const a = BHE.extract(data, 1e-6);
  const b = BHE.extract(data, 1);
  assert.equal(a.vertices.length, b.vertices.length);
  let moved = 0;
  for (let i = 0; i < a.vertices.length; i++) {
    const p = a.vertices[i].position, q = b.vertices[i].position;
    moved += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  }
  assert.ok(moved > 1e-3, 'changing lambda should move vertices');
  assert.throws(() => BHE.extract(data, 2), /lambda/);
});

test('triangles face the positive-sign side', () => {
  for (const name of ['sphere', 'sharp-box', 'open-plane']) {
    const { model } = run(name);
    for (const [ia, ib, ic] of model.triangles) {
      const A = model.vertices[ia].position, Bp = model.vertices[ib].position, C = model.vertices[ic].position;
      const u = [Bp[0] - A[0], Bp[1] - A[1], Bp[2] - A[2]];
      const w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      let ref = [0, 0, 0];
      for (const id of [ia, ib, ic]) for (const e of model.vertices[id].edges) {
        ref[0] += e.normal[0]; ref[1] += e.normal[1]; ref[2] += e.normal[2];
      }
      const d = n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2];
      assert.ok(d > 0, name + ' winding points away from the positive side');
    }
  }
});

test('cells are numbered by z, then y, then x', () => {
  const { model } = run('sphere');
  for (let i = 1; i < model.cells.length; i++) {
    const p = model.cells[i - 1], q = model.cells[i];
    const order = q[2] - p[2] || q[1] - p[1] || q[0] - p[0];
    assert.ok(order > 0, 'cells out of order at ' + i);
  }
});

test('all-same-sign input yields an empty mesh without errors', () => {
  const { model } = run('empty');
  assert.equal(model.vertices.length, 0);
  assert.equal(model.triangles.length, 0);
  assert.equal(model.boundaryCrossings, 0);
  assert.equal(model.boundaryEdges.length, 0);
});

test('validation locates each malformed edge by field and index', () => {
  const cases = [
    ['invalid-missing-edge', 'missing-edge', /edges/, { axis: 'z', node: [0, 0, 0] }],
    ['invalid-duplicate-edge', 'duplicate-edge', /^edges\[3\]$/, { axis: 'x', node: [0, 0, 0] }],
    ['invalid-zero-normal', 'zero-normal', /^edges\[0\]\.normal$/, null],
    ['invalid-zero-sign', 'invalid-sign', /^signs\[0\]$/, null],
  ];
  for (const [name, code, fieldRe, edge] of cases) {
    const v = BHE.validateInput(load(name));
    assert.equal(v.ok, false, name + ' must be rejected');
    const hit = v.errors.find((e) => e.code === code);
    assert.ok(hit, name + ' should report ' + code + '; got ' + v.errors.map((e) => e.code).join(','));
    assert.match(hit.field, fieldRe, name + ' field');
    if (edge) assert.deepEqual(hit.edge, edge, name + ' edge location');
  }
});

test('synthetic validation errors: t range, non-finite, same-sign record, bad axis', () => {
  const base = load('skew-cell');
  const clone = () => JSON.parse(JSON.stringify(base));

  let raw = clone();
  raw.edges[0].t = 1;
  let v = BHE.validateInput(raw);
  assert.equal(v.errors[0].code, 't-out-of-range');
  assert.equal(v.errors[0].field, 'edges[0].t');

  raw = clone();
  raw.edges[1].normal = [0, NaN, 1];
  v = BHE.validateInput(raw);
  assert.ok(v.errors.some((e) => e.code === 'non-finite' && /edges\[1\]\.normal\[1\]/.test(e.field)));

  raw = clone();
  raw.edges.push({ axis: 'y', node: [1, 0, 0], t: 0.5, normal: [0, 1, 0] });
  v = BHE.validateInput(raw);
  assert.ok(v.errors.some((e) => e.code === 'unexpected-edge' && /edges\[3\]/.test(e.field)));

  raw = clone();
  raw.edges[0].axis = 'w';
  v = BHE.validateInput(raw);
  assert.ok(v.errors.some((e) => e.code === 'invalid-axis' && e.field === 'edges[0].axis'));

  raw = clone();
  raw.dims = [1, 2, 2];
  v = BHE.validateInput(raw);
  assert.ok(v.errors.some((e) => e.code === 'dims-out-of-range'));
});

test('editing a shared edge updates every incident cell', () => {
  const raw = load('sphere');
  const v0 = BHE.validateInput(raw);
  const m0 = BHE.extract(v0.data, 1e-3);
  let key = null;
  for (const [k, list] of m0.edgeCellMap) if (list.length === 4) { key = k; break; }
  assert.ok(key, 'sphere should contain a fully shared crossing edge');
  const ids = m0.edgeCellMap.get(key);
  assert.ok(ids && ids.length >= 2, 'edge should be shared');
  const before = ids.map((i) => m0.vertices[i].position.slice());

  const raw2 = JSON.parse(JSON.stringify(raw));
  const rec = raw2.edges.find((e) => e.axis + ':' + e.node.join(',') === key);
  rec.t = 0.85;
  const m1 = BHE.extract(BHE.validateInput(raw2).data, 1e-3);
  for (const id of ids) {
    const p = m1.vertices[id].position;
    const q = before[ids.indexOf(id)];
    const moved = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
    assert.ok(moved > 1e-9, 'cell ' + id + ' did not move');
  }
});

test('OBJ and diagnostics exports are finite and self-consistent', () => {
  const { data, model } = run('sharp-box');
  const obj = BHE.toOBJ(model);
  const lines = obj.trim().split('\n');
  const vs = lines.filter((l) => l.startsWith('v '));
  const fs2 = lines.filter((l) => l.startsWith('f '));
  assert.equal(vs.length, model.vertices.length);
  assert.equal(fs2.length, model.triangles.length);
  for (const l of vs) {
    for (const tok of l.slice(2).split(' ')) assert.ok(Number.isFinite(Number(tok)));
  }
  for (const l of fs2) {
    for (const tok of l.slice(2).split(' ')) {
      const idx = Number(tok);
      assert.ok(Number.isInteger(idx) && idx >= 1 && idx <= vs.length);
    }
  }

  const diag = BHE.toDiagnostics(model, data, []);
  assert.equal(diag.cells.length, model.vertices.length);
  for (const c of diag.cells) {
    assert.equal(c.active_axes.length, 3);
    for (const s of c.active_axes) assert.ok(['lower', 'free', 'upper'].includes(s));
    assert.ok(Number.isFinite(c.objective));
    assert.ok(Number.isFinite(c.data_error));
    assert.ok(Array.isArray(c.residuals) && c.residuals.length > 0);
  }
  assert.deepEqual(diag.counts, BHE.expectedCounts(model));
});

test('invalid input still exports a diagnostics document with the errors', () => {
  const raw = load('invalid-duplicate-edge');
  const v = BHE.validateInput(raw);
  assert.equal(v.ok, false);
  const diag = BHE.toDiagnostics(null, null, v.errors, { lambda: 1e-3, grid: { dims: raw.dims, origin: raw.origin, spacing: raw.spacing } });
  assert.equal(diag.cells.length, 0);
  assert.equal(diag.errors[0].code, 'duplicate-edge');
  assert.equal(diag.errors[0].field, 'edges[3]');
});

test('boundary crossings count edges missing neighbours, untouched by welding', () => {
  const { model } = run('open-plane');
  assert.equal(model.counts.boundary_crossings, 15);
  assert.equal(model.counts.boundary_edges, 8);
  // No vertex welding: vertex count equals the number of mixed cells.
  assert.equal(model.vertices.length, model.cells.length);
});
