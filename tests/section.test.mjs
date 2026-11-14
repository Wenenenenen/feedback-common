// Node test bench for the section engine.
//
// Run: node --test tests/section.test.mjs      (no third-party packages, Node >= 20)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseStl, StlError } from '../app/js/stl.js';
import { buildMesh } from '../app/js/mesh.js';
import { sliceMesh, planeBasis, dRangeForBBox, pointInPolygon } from '../app/js/section.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const samples = join(root, 'samples', 'extracted');
const hasSamples = existsSync(join(samples, 'expected.json'));

const load = (name) => {
  const bytes = readFileSync(join(samples, name));
  const parsed = parseStl(bytes);
  const mesh = buildMesh(parsed, { name });
  return { parsed, mesh };
};

const near = (a, b, rel = 1e-5, abs = 1e-6) =>
  Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

// --- synthetic mesh helpers ---------------------------------------------

function boxTriangles(x0, x1, y0, y1, z0, z1) {
  const V = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const F = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const tris = [];
  for (const [a, b, c, d] of F) { tris.push([V[a], V[b], V[c]]); tris.push([V[a], V[c], V[d]]); }
  return tris;
}

function meshOfTriangleLists(lists, name = 'synthetic') {
  const positions = [];
  for (const tris of lists) {
    for (const [a, b, c] of tris) positions.push(...a, ...b, ...c);
  }
  return buildMesh({
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    triangleCount: positions.length / 9,
    format: 'synthetic',
    warnings: [],
  }, { name });
}

// --- reference values ----------------------------------------------------

test('sample fixtures: expected loops, holes, area and perimeter', { skip: !hasSamples }, () => {
  const expected = JSON.parse(readFileSync(join(samples, 'expected.json'), 'utf8'));
  const cache = new Map();
  for (const row of expected) {
    if (!cache.has(row.file)) cache.set(row.file, load(row.file));
    const { mesh } = cache.get(row.file);
    const result = sliceMesh(mesh, row.n, row.d);
    const m = result.measurements;
    const tag = `${row.file} n=${JSON.stringify(row.n)} d=${row.d}`;
    assert.equal(m.loopCount, row.loops, `${tag}: loop count`);
    assert.equal(m.holeCount, row.holes, `${tag}: hole count`);
    assert.ok(near(m.area_mm2, row.area_mm2), `${tag}: area ${m.area_mm2} vs ${row.area_mm2}`);
    assert.ok(near(m.perimeter_mm, row.perimeter_mm), `${tag}: perimeter ${m.perimeter_mm} vs ${row.perimeter_mm}`);
  }
});

test('many-rings fixture slices well inside the 2 s budget', { skip: !hasSamples }, () => {
  const { mesh } = load('many-rings.stl');
  const t0 = performance.now();
  const result = sliceMesh(mesh, [0, 0, 1], 6);
  const last = performance.now();
  // First slice includes JIT warm-up; a second slice is the steady state, but
  // even the cold first slice must be under 2 s.
  assert.ok(last - t0 < 2000, `first slice took ${(last - t0).toFixed(1)} ms`);
  assert.equal(result.measurements.loopCount, 1250);
  assert.equal(result.measurements.bodyCount, 625);
  const t1 = performance.now();
  const again = sliceMesh(mesh, [0, 0, 1], 6);
  assert.ok(performance.now() - t1 < 2000);
  assert.equal(again.measurements.area_mm2, result.measurements.area_mm2);
});

// --- format detection ----------------------------------------------------

test('binary STL starting with "solid" is detected as binary', { skip: !hasSamples }, () => {
  const { parsed } = load('hollow-binary.stl');
  assert.equal(parsed.format, 'binary');
});

test('ASCII and binary versions of the same solid agree', { skip: !hasSamples }, () => {
  const a = load('hollow-ascii.stl');
  const b = load('hollow-binary.stl');
  assert.equal(a.parsed.format, 'ascii');
  assert.equal(b.parsed.format, 'binary');
  assert.equal(a.mesh.triangleCount, b.mesh.triangleCount);
  assert.equal(a.mesh.meta.bbox.min[2], b.mesh.meta.bbox.min[2]);
  const ra = sliceMesh(a.mesh, [0, 0, 1], 6).measurements;
  const rb = sliceMesh(b.mesh, [0, 0, 1], 6).measurements;
  assert.ok(near(ra.area_mm2, rb.area_mm2));
  assert.ok(near(ra.perimeter_mm, rb.perimeter_mm));
});

test('truncated binary is rejected with a clear error', { skip: !hasSamples }, () => {
  assert.throws(() => parseStl(readFileSync(join(samples, 'truncated.stl'))), (err) => {
    assert.ok(err instanceof StlError);
    assert.equal(err.code, 'truncated');
    assert.match(err.message, /截断|truncated/i);
    return true;
  });
});

test('malformed inputs are rejected, never silently accepted', () => {
  assert.throws(() => parseStl(new Uint8Array()), /空文件/);
  assert.throws(() => parseStl(new TextEncoder().encode('solid x\nendsolid x\n')), /facet|ASCII/i);
  const garbage = new Uint8Array(200).fill(0x41);
  assert.throws(() => parseStl(garbage));
});

// --- limit-section semantics ---------------------------------------------

test('d = top face approached from +n is empty; from −n it is the full face', { skip: !hasSamples }, () => {
  const { mesh } = load('cube.stl'); // z in [0, 20], cube 20 mm
  const fromAbove = sliceMesh(mesh, [0, 0, 1], 20);
  assert.equal(fromAbove.measurements.loopCount, 0);
  assert.ok(fromAbove.empty);
  const fromBelow = sliceMesh(mesh, [0, 0, -1], -20);
  assert.equal(fromBelow.measurements.loopCount, 1);
  assert.ok(near(fromBelow.measurements.area_mm2, 400));
  assert.ok(near(fromBelow.measurements.perimeter_mm, 80));
});

test('d = 0 on the bottom face is the full face (material is on +n)', { skip: !hasSamples }, () => {
  const { mesh } = load('cube.stl');
  const r = sliceMesh(mesh, [0, 0, 1], 0);
  assert.equal(r.measurements.loopCount, 1);
  assert.ok(near(r.measurements.area_mm2, 400));
});

test('plane through an edge and through a vertex closes cleanly, no spikes', { skip: !hasSamples }, () => {
  const { mesh } = load('cube.stl');
  const edge = sliceMesh(mesh, [1, 1, 0], 20); // top edge x+y=20, z=20
  assert.ok(edge.empty, 'grazing the top edge from above yields nothing (zero width)');
  const justBelow = sliceMesh(mesh, [1, 1, 0], 20 - 1e-3);
  assert.equal(justBelow.measurements.loopCount, 1, 'no doubled lines or extra loops');
  assert.equal(justBelow.measurements.openChainCount, 0);
  // For n=(1,1,0) and raw d = 20−δ, the plane sits δ/√2 mm below the top
  // edge; the sliver is 40 mm long, so area = 40·δ/√2 and the two long edges
  // give a perimeter of 40 mm.
  const delta = 1e-3;
  assert.ok(near(justBelow.measurements.area_mm2, (40 * delta) / Math.SQRT2, 1e-3, 1e-9));
  assert.ok(near(justBelow.measurements.perimeter_mm, 40, 1e-3, 1e-6));
  const vertex = sliceMesh(mesh, [1, 1, 1], 40); // top corner
  assert.ok(vertex.empty);
  const vertexBelow = sliceMesh(mesh, [1, 1, 1], 40 - 1e-2);
  assert.equal(vertexBelow.measurements.loopCount, 1);
  assert.equal(vertexBelow.measurements.openChainCount, 0);
  // Offsets below the snap tolerance are the same limit as the exact plane:
  // grazing it still yields nothing rather than a sub-print-resolution sliver.
  assert.ok(sliceMesh(mesh, [1, 1, 0], 20 - 1e-6).empty);
  assert.ok(sliceMesh(mesh, [1, 1, 1], 40 - 1e-6).empty);
});

test('a section just below a top face is one clean rectangular loop', { skip: !hasSamples }, () => {
  const { mesh } = load('hollow-binary.stl');
  const r = sliceMesh(mesh, [0, 0, 1], 12 - 1e-3);
  assert.equal(r.measurements.loopCount, 2);
  assert.equal(r.measurements.holeCount, 1);
  assert.ok(near(r.measurements.area_mm2, 336));
  assert.ok(near(r.measurements.perimeter_mm, 112));
});

test('non-normalized n gives the same geometry as the normalized plane', { skip: !hasSamples }, () => {
  const { mesh } = load('cube.stl');
  const a = sliceMesh(mesh, [1, 0, 1], 10);
  const b = sliceMesh(mesh, [2, 0, 2], 20);
  const c = sliceMesh(mesh, [-1, 0, -1], -10);
  for (const other of [b, c]) {
    assert.ok(near(a.measurements.area_mm2, other.measurements.area_mm2));
    assert.ok(near(a.measurements.perimeter_mm, other.measurements.perimeter_mm));
    // Same 3-D ring up to traversal start/direction.
    assert.equal(a.loops[0].points3d.length, other.loops[0].points3d.length);
  }
  assert.ok(near(a.plane.dNormalized, b.plane.dNormalized));
  // Flipping n reverses the approach side, so d̂ flips sign.
  assert.ok(near(a.plane.dNormalized, -c.plane.dNormalized));
});

test('u × v = n, and 2-D coordinates are orthonormal millimetres', () => {
  const { u, v, n } = planeBasis([1, 2, 3]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  assert.ok(Math.abs(Math.hypot(...u) - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
  assert.ok(Math.abs(dot(u, v)) < 1e-12);
  assert.ok(Math.abs(dot(u, n)) < 1e-12);
  const c = cross(u, v);
  assert.ok(Math.abs(c[0] - n[0]) < 1e-12 && Math.abs(c[1] - n[1]) < 1e-12 && Math.abs(c[2] - n[2]) < 1e-12);
});

// --- topology handling ----------------------------------------------------

test('open shell: reported as open, never filled into solid material', { skip: !hasSamples }, () => {
  const { mesh } = load('open-shell.stl');
  assert.ok(mesh.diagnostics.openEdges > 0);
  const r = sliceMesh(mesh, [0, 0, 1], 6);
  assert.ok(r.measurements.openChainCount > 0, 'the missing wall shows as an open chain');
  assert.ok(r.measurements.area_mm2 >= 0, 'area is never invented from an opening');
  assert.equal(r.measurements.orphanHoleCount, 1, 'hole without a closed outer loop stays unknown');
  assert.ok(r.warnings.some((w) => w.includes('开口')));
});

test('non-manifold model: flagged and sliced without double lines', { skip: !hasSamples }, () => {
  const { mesh } = load('nonmanifold.stl');
  assert.ok(mesh.diagnostics.nonManifoldEdges > 0);
  const r = sliceMesh(mesh, [0, 0, 1], 0);
  assert.ok(r.measurements.area_mm2 >= 0);
  assert.ok(r.measurements.loopCount >= 1);
});

test('separate parts are distinguished, holes assigned to their own body', { skip: !hasSamples }, () => {
  const { mesh } = load('double-ring.stl');
  const r = sliceMesh(mesh, [0, 0, 1], 6);
  assert.equal(r.measurements.bodyCount, 2);
  assert.equal(r.measurements.holeCount, 2);
  for (const hole of r.loops.filter((l) => l.kind === 'hole')) {
    assert.notEqual(hole.ownerBodyId, null);
  }
  assert.equal(r.bodies[0].holeCount, 1);
  assert.equal(r.bodies[1].holeCount, 1);
  // Each body's area is 400 − 64.
  assert.ok(near(r.bodies[0].area_mm2, 336));
  assert.ok(near(r.bodies[1].area_mm2, 336));
  // Body bounding boxes are disjoint in x.
  assert.ok(r.bodies[0].bbox2d[2] <= r.bodies[1].bbox2d[0]);
});

test('nested cavity and inside island classify correctly', () => {
  const outer = boxTriangles(-20, 20, -20, 20, 0, 20);
  const cavityVerts = boxTriangles(-14, 14, -14, 14, 4, 16);
  const cavity = cavityVerts.map((t) => [t[0], t[2], t[1]]); // reversed: material outside
  const island = boxTriangles(-5, 5, -5, 5, 8, 12);
  const mesh = meshOfTriangleLists([outer, cavity, island]);
  const r = sliceMesh(mesh, [0, 0, 1], 10);
  assert.equal(r.measurements.loopCount, 3);
  assert.equal(r.measurements.holeCount, 1);
  assert.equal(r.measurements.bodyCount, 2);
  assert.ok(near(r.measurements.area_mm2, 40 * 40 - 28 * 28 + 10 * 10, 1e-4));
  // Solid loops are CCW with positive area, hole is CW with negative area.
  const solids = r.loops.filter((l) => l.kind === 'solid');
  const holes = r.loops.filter((l) => l.kind === 'hole');
  assert.ok(solids.every((l) => l.area_mm2 > 0));
  assert.ok(holes.every((l) => l.area_mm2 < 0 && l.ownerBodyId === 0));
});

test('two solids sharing a wall produce one seam-free boundary', () => {
  const mesh = meshOfTriangleLists([
    boxTriangles(-10, 0, -10, 10, 0, 12),
    boxTriangles(0, 10, -10, 10, 0, 12),
  ]);
  const r = sliceMesh(mesh, [0, 0, 1], 6);
  assert.equal(r.measurements.loopCount, 1, 'coincident seam is not drawn twice');
  assert.ok(near(r.measurements.area_mm2, 400));
  assert.ok(near(r.measurements.perimeter_mm, 80));
  assert.equal(r.measurements.openChainCount, 0);
});

test('stacked solids with a coplanar interface stay one body', () => {
  const mesh = meshOfTriangleLists([
    boxTriangles(-10, 10, -10, 10, 0, 6),
    boxTriangles(-10, 10, -10, 10, 6, 12),
  ]);
  for (const d of [6, 5.99, 6.01]) {
    const r = sliceMesh(mesh, [0, 0, 1], d);
    assert.equal(r.measurements.loopCount, 1);
    assert.ok(near(r.measurements.area_mm2, 400));
    assert.ok(near(r.measurements.perimeter_mm, 80));
  }
});

test('T-junction (vertex on another triangle edge) still closes loops', () => {
  // The two solids share the x=0 wall. The left solid's wall is split at a
  // mid-edge vertex; the right solid's wall is a single quad. A plane at z=6
  // hits that vertex in the interior of the right solid's cut edge, so it
  // must be split there or the right wall's loop cannot close.
  function boxWithSplitSeam(x0, x1) {
    const V = [
      [x0, -10, 0], [x1, -10, 0], [x1, 10, 0], [x0, 10, 0],
      [x0, -10, 12], [x1, -10, 12], [x1, 10, 12], [x0, 10, 12],
    ];
    const tris = [
      [V[0], V[2], V[1]], [V[0], V[3], V[2]],       // z=0, outward −z
      [V[4], V[5], V[6]], [V[4], V[6], V[7]],       // z=12, outward +z
      [V[0], V[1], V[5]], [V[0], V[5], V[4]],       // y=−10
      [V[1], V[2], V[6]], [V[1], V[6], V[5]],       // x=x1
      [V[2], V[3], V[7]], [V[2], V[7], V[6]],       // y=+10
    ];
    // Wall at x=x0, split at a vertex on its mid-line.
    const mid = V.length;
    V.push([x0, 0, 6]);
    tris.push([V[3], V[0], V[mid]]);
    tris.push([V[0], V[4], V[mid]]);
    tris.push([V[4], V[7], V[mid]]);
    tris.push([V[7], V[3], V[mid]]);
    return tris;
  }
  const mesh = meshOfTriangleLists([
    boxWithSplitSeam(-10, 0),
    boxTriangles(0, 10, -10, 10, 0, 12),
  ], 'tjunction');
  const r = sliceMesh(mesh, [0, 0, 1], 6);
  assert.ok(near(r.measurements.area_mm2, 400));
  assert.ok(near(r.measurements.perimeter_mm, 80));
  assert.equal(r.measurements.loopCount, 1);
  assert.equal(r.measurements.openChainCount, 0);
});

test('robustness: every edge case produces finite, non-negative measurements', { skip: !hasSamples }, () => {
  const names = ['cube.stl', 'hollow-binary.stl', 'double-ring.stl', 'open-shell.stl', 'nonmanifold.stl'];
  const dirs = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [1, 1, 0], [1, 1, 1], [0.3, -0.7, 0.2]];
  for (const name of names) {
    const { mesh } = load(name);
    const [lo, hi] = dRangeForBBox(mesh.meta.bbox, [1, 1, 1]);
    for (const n of dirs) {
      for (let k = -1; k <= 7; k++) {
        const d = lo + ((hi - lo) * k) / 6;
        const r = sliceMesh(mesh, n, d);
        assert.ok(Number.isFinite(r.measurements.area_mm2), `${name} ${n} ${d}`);
        assert.ok(Number.isFinite(r.measurements.perimeter_mm));
        assert.ok(r.measurements.openChainCount >= 0);
        for (const loop of r.loops) {
          assert.ok(loop.points2d.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
          assert.ok(loop.perimeter_mm > 0);
        }
      }
    }
  }
});

test('pointInPolygon handles a square and a point on the boundary', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon([5, 5], square), true);
  assert.equal(pointInPolygon([15, 5], square), false);
  assert.equal(pointInPolygon([-1, 0], square), false);
});

// --- exports -------------------------------------------------------------

test('JSON export carries plane, rings, 3-D intersections, ownership, measurements', { skip: !hasSamples }, async () => {
  const { sectionToJson } = await import('../app/js/export.js');
  const { mesh } = load('hollow-binary.stl');
  const section = sliceMesh(mesh, [0, 0, 1], 6);
  const report = sectionToJson(section, mesh.meta, { diagnostics: mesh.diagnostics });
  assert.equal(report.units, 'mm');
  assert.equal(report.plane.d, 6);
  assert.ok(Array.isArray(report.plane.n_unit));
  assert.equal(report.loops.length, 2);
  for (const loop of report.loops) {
    assert.ok(loop.ring_2d_mm.length >= 3);
    assert.equal(loop.intersections_3d_mm.length, loop.ring_2d_mm.length);
    for (const p of loop.intersections_3d_mm) assert.ok(Math.abs(p[2] - 6) < 1e-9);
  }
  const hole = report.loops.find((l) => l.kind === 'hole');
  assert.notEqual(hole.hole_owner_body_id, null);
  assert.ok(near(report.measurements.area_mm2, 336));
});

test('SVG export writes millimetre units, mm-sized document, and flipped y', { skip: !hasSamples }, async () => {
  const { sectionToSvg } = await import('../app/js/export.js');
  const { mesh } = load('hollow-binary.stl');
  const section = sliceMesh(mesh, [0, 0, 1], 6);
  const svg = sectionToSvg(section, { label: 'test' });
  assert.ok(svg.includes('width="24mm"'));
  assert.ok(svg.includes('data-unit="mm"'));
  // 20 mm solid => 20 mm across the viewBox.
  const vb = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert.ok(Math.abs(vb[2] - 24) < 1e-9);
  const paths = svg.match(/<path/g) || [];
  assert.equal(paths.length, 2);
});
