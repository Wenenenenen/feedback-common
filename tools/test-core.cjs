'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GT = require('../tracer.js');

const samplePath = path.join(__dirname, '..', 'samples', 'nested-glass.json');
const sampleRaw = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

function scene(partial) {
  return GT.normalizeScene({
    size: [1, 1],
    depth: 4,
    background: [1, 1, 1],
    spheres: [],
    rays: [[[0, 0, -10], [0, 0, 1]]],
    ...partial
  });
}

function eventKindsInOrder(result) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.event) {
      out.push({
        id: node.id,
        sphere: node.event.sphereId,
        in: node.event.inId,
        out: node.event.outId,
        entering: node.event.entering,
        tir: node.event.tir
      });
    }
    for (const child of node.children || []) walk(child);
  }
  walk(result.tree);
  return out;
}

test('sample file normalizes and preserves expected normal-incidence Fresnel split', () => {
  const s = GT.normalizeScene(sampleRaw);
  assert.equal(s.spheres.length, 1);
  assert.equal(s.rays.length, 1);
  const r = GT.traceRay(s, s.rays[0], 4, { detail: true });
  assert.ok(Math.abs(r.tree.event.F - 1 / 36) < 1e-12);
  assert.equal(r.tree.children[0].kind, 'R');
  assert.equal(r.tree.children[1].kind, 'T');
  assert.ok(r.rgb[2] > 0.9999, 'blue channel has no absorption; only depth residual is missing');
  assert.ok(r.residual[2] > 0);
  assert.ok(Math.abs(r.rgb[2] + r.residual[2] - 1) < 1e-9);
  assert.deepEqual(r.rgb255, r.rgb.map((x) => Math.round(255 * Math.min(1, Math.max(0, x)))));
});

test('depth 0 records hit-bound weight as residual instead of background', () => {
  const s = GT.normalizeScene(sampleRaw);
  const r = GT.traceRay(s, s.rays[0], 0, { detail: true });
  assert.equal(r.stats.events, 0);
  assert.equal(r.stats.residualBranches, 1);
  assert.deepEqual(r.rgb, [0, 0, 0]);
  assert.ok(Math.abs(r.residual[0] - 1) < 1e-12);
  assert.equal(r.tree.outcome, 'residual');
});

test('depth 0 residual uses original weight and exposes attenuated candidate value', () => {
  const s = scene({
    spheres: [{ id: 9, c: [0, 0, 0], r: 1, n: 1.5, sigma: [1, 2, 3] }],
    rays: [[[0, 0, 0], [1, 0, 0]]]
  });
  const r = GT.traceRay(s, s.rays[0], 0, { detail: true });
  assert.equal(r.stats.residualBranches, 1);
  assert.deepEqual(r.residual, [1, 1, 1]);
  assert.ok(Math.abs(r.residualArrived[0] - Math.exp(-1)) < 1e-12);
  assert.equal(r.tree.propagated, false);
  assert.ok(r.tree.pendingHit.sphereId === 9);
});

test('a miss escapes even at depth 0', () => {
  const s = scene({
    spheres: [{ id: 1, c: [0, 0, 0], r: 1, n: 1.5, sigma: [0, 0, 0] }],
    rays: [[[-3, 5, 0], [1, 0, 0]]]
  });
  const r = GT.traceRay(s, s.rays[0], 0, { detail: true });
  assert.equal(r.stats.escapes, 1);
  assert.equal(r.stats.residualBranches, 0);
  assert.deepEqual(r.rgb, [1, 1, 1]);
});

test('tangent ray creates no interface event and does not switch medium', () => {
  const s = scene({
    spheres: [{ id: 7, c: [0, 0, 0], r: 1, n: 1.5, sigma: [0, 0, 0] }],
    rays: [[[-2, 1, 0], [1, 0, 0]]]
  });
  const r = GT.traceRay(s, s.rays[0], 4, { detail: true });
  assert.equal(r.stats.events, 0);
  assert.equal(r.tree.outcome, 'escape');
  assert.deepEqual(r.rgb, [1, 1, 1]);
});

test('1e-6 nested clearance is traversed without a directional nudge', () => {
  const outerR = 1 + 1e-6;
  const s = scene({
    depth: 3,
    spheres: [
      { id: 1, c: [0, 0, 0], r: outerR, n: 1.4, sigma: [0, 0, 0] },
      { id: 2, c: [0, 0, 0], r: 1, n: 1.0, sigma: [0, 0, 0] }
    ],
    rays: [[[-3, 0, 0], [1, 0, 0]]]
  });
  const r = GT.traceRay(s, s.rays[0], 2, { detail: true });
  const root = r.tree;
  assert.equal(root.event.sphereId, 1);
  const enterInner = root.children.find((c) => c.kind === 'T');
  assert.equal(enterInner.event.sphereId, 2);
  assert.ok(Math.abs(enterInner.t - 1e-6) < 1e-9, `thin-layer local t=${enterInner.t}`);
  const ids = eventKindsInOrder(r).slice(0, 2).map((e) => e.sphere);
  assert.deepEqual(ids, [1, 2]);
});

test('cavity boundary uses bubble medium to glass, not air to glass', () => {
  const s = scene({
    spheres: [
      { id: 1, c: [0, 0, 0], r: 2, n: 1.5, sigma: [0, 0, 0] },
      { id: 2, c: [0, 0, 0], r: 1, n: 1.0, sigma: [0, 0, 0] }
    ],
    // Starts inside the bubble.
    rays: [[[0, 0, 0], [1, 0, 0]]]
  });
  const r = GT.traceRay(s, s.rays[0], 1, { detail: true });
  assert.equal(r.tree.event.sphereId, 2);
  assert.equal(r.tree.event.inId, 2);
  assert.equal(r.tree.event.outId, 1);
  assert.equal(r.tree.event.entering, false);
  assert.ok(r.tree.event.eta < 1, 'eta = nBubble/nGlass should be < 1');
});

test('ray starting in annular glass resolves inner sphere as glass to bubble', () => {
  const s = scene({
    spheres: [
      { id: 1, c: [0, 0, 0], r: 2, n: 1.5, sigma: [0, 0, 0] },
      { id: 2, c: [0, 0, 0], r: 1, n: 1.0, sigma: [0, 0, 0] }
    ],
    rays: [[[1.5, 0, 0], [-1, 0, 0]]]
  });
  const medium = GT.mediumAt([1.5, 0, 0], s.spheres);
  assert.equal(medium.id, 1);
  const r = GT.traceRay(s, s.rays[0], 1, { detail: true });
  assert.equal(r.tree.event.sphereId, 2);
  assert.equal(r.tree.event.inId, 1);
  assert.equal(r.tree.event.outId, 2);
  assert.equal(r.tree.event.entering, true);
});

test('total internal reflection creates only R branch with unit factor', () => {
  const f = GT.fresnel(0.4, 3, 1);
  assert.equal(f.tir, true);
  assert.equal(f.F, 1);

  const s = scene({
    spheres: [{ id: 1, c: [0, 0, 0], r: 1, n: 3, sigma: [0, 0, 0] }],
    // Off-center interior ray aimed obliquely at upper-right surface.
    rays: [[[-0.2, -0.8, 0], [0.8, 0.6, 0]]]
  });
  const r = GT.traceRay(s, s.rays[0], 2, { detail: true });
  assert.ok(r.stats.tir >= 1);
  const tirEvent = eventKindsInOrder(r).find((e) => e.tir);
  assert.ok(tirEvent);
});

test('intersecting and touching spheres report both ids', () => {
  for (const [label, b, expectedKind] of [
    ['intersect', { id: 2, c: [1.5, 0, 0], r: 1, n: 1.4, sigma: [0, 0, 0] }, 'intersection'],
    ['external-contact', { id: 2, c: [3, 0, 0], r: 1, n: 1.4, sigma: [0, 0, 0] }, 'external-contact'],
    ['internal-contact', { id: 2, c: [1, 0, 0], r: 1, n: 1.4, sigma: [0, 0, 0] }, 'internal-contact']
  ]) {
    assert.throws(() => GT.normalizeScene(scene({
      spheres: [{ id: 1, c: [0, 0, 0], r: 2, n: 1.4, sigma: [0, 0, 0] }, b]
    })), (err) => {
      assert.equal(err.name, 'SceneValidationError');
      assert.ok(err.sphereConflicts.length >= 1, label);
      assert.equal(err.sphereConflicts[0].kind, expectedKind, label);
      const ids = err.sphereConflicts.flatMap((x) => [x.a, x.b]);
      assert.ok(ids.includes(1) && ids.includes(2), label);
      return true;
    }, label);
  }
});

test('valid 1e-6 external clearance is not reported as contact', () => {
  const rel = GT.pairRelation(
    { id: 1, c: [0, 0, 0], r: 1 },
    { id: 2, c: [2 + 1e-6, 0, 0], r: 1 }
  );
  assert.equal(rel.valid, true);
  assert.equal(rel.kind, 'separated');
});

test('export contains unquantized rgb, residual, endpoints, media and weights', () => {
  const s = GT.normalizeScene(sampleRaw);
  const data = GT.buildExport(s, { depth: 4, sourceFile: 'nested-glass.json' });
  assert.equal(data.schema, 'nested-glass-light-paths/v1');
  const ray = data.rays[0];
  assert.ok(Array.isArray(ray.rgb));
  assert.ok(Array.isArray(ray.residual));
  assert.ok(ray.branches.length >= 5);
  for (const b of ray.branches) {
    assert.ok(Array.isArray(b.start));
    assert.ok('weight' in b);
    if (b.event) {
      assert.ok(b.event.sphereId === 1);
      assert.ok(b.event.mediumIn && b.event.mediumOut);
    }
  }
  assert.equal(ray.tree.children[0].kind, 'R');
});
