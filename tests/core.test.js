const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../src/core.js');

const sampleRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'samples', 'label-outline.json'), 'utf8')
);

function leftSideLabel(e, width, height, cells) {
  const get = (r, c) => {
    if (r < 0 || c < 0 || r >= height || c >= width) return 0;
    return cells[r * width + c];
  };

  if (e.y1 === e.y2) {
    const y = e.y1;
    if (e.x2 > e.x1) return get(y - 1, e.x1); // east: north is screen-left
    return get(y, Math.min(e.x1, e.x2));      // west: south is screen-left
  }

  const x = e.x1;
  if (e.y2 > e.y1) return get(e.y1, x);       // down: east is screen-left
  return get(Math.min(e.y1, e.y2), x - 1);     // up: west is screen-left
}

test('sample parses and creates one uniquely stored oriented edge per boundary', () => {
  const model = new C.LabelGridModel(sampleRaw);
  assert.equal(model.width, 12);
  assert.equal(model.height, 9);

  const edges = C.buildUnitEdges(model.cells, model.width, model.height);
  assert.equal(edges.length, 45);
  assert.equal(new Set(edges.map(e => e.id)).size, edges.length);

  const undirected = new Set(edges.map(e => {
    const p1 = `${e.x1},${e.y1}`;
    const p2 = `${e.x2},${e.y2}`;
    return p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
  }));
  assert.equal(undirected.size, edges.length, 'same undirected edge must be stored once');

  for (const e of edges) {
    assert.ok(e.left < e.right, 'smaller label must be on oriented left side');
    assert.equal(leftSideLabel(e, model.width, model.height, model.cells), e.left);
  }
});

test('area limit zero preserves the exact unit boundary set', () => {
  const result = C.processGrid(sampleRaw, { maxDoubleArea: 0 });
  assert.equal(result.maxDoubleArea, 0);
  assert.ok(result.removedCount > 0, 'collinear points may still be merged');
  assert.ok(C.areaZeroBoundariesMatch(result));

  for (const e of result.edges) {
    assert.ok(e.x1 === e.x2 || e.y1 === e.y2, 'zero-area chords must stay axis aligned');
    assert.ok(e.left < e.right);
  }

  const svg = C.buildLabelSVG(result);
  assert.match(svg, /<svg[^>]*stroke="none"/);
  assert.doesNotMatch(svg, /<path[^>]*stroke=/);
  assert.match(svg, /fill-rule="evenodd"/);
  // The enclosed zero cell is represented by the inner subpath of label 1.
  assert.match(svg, /M3 5L3 4L4 4L4 5Z/);
});

test('four-label diagonal touch keeps a degree-four junction and separate label rings', () => {
  const raw = { labels: [[1, 2], [2, 1]] };
  const result = C.processGrid(raw, { maxDoubleArea: 1 });
  const center = C.vertexId(1, 1, result.width);
  const incident = result.edges.filter(e => e.a === center || e.b === center);
  assert.equal(incident.length, 4, 'four-color point must not be collapsed or pair-crossed');

  const labelOneCycles = result.cycles.filter(q => q.left === 1);
  assert.equal(labelOneCycles.length, 2, 'diagonally touching label 1 regions must stay separate rings');
});

test('exact triangle intrusion rejects contacts away from chord endpoints', () => {
  const A = { x: 0, y: 0 };
  const V = { x: 0, y: 2 };
  const B = { x: 2, y: 0 };

  assert.equal(C.segmentIntrudesTriangle({ x: -1, y: -1 }, A, A, V, B), false);
  assert.equal(C.segmentIntrudesTriangle({ x: 3, y: -1 }, B, A, V, B), false);
  assert.equal(
    C.segmentIntrudesTriangle({ x: 0, y: 1 }, { x: 1, y: 0 }, A, V, B),
    true,
    'contact with old-edge interior is forbidden'
  );
  assert.equal(
    C.segmentIntrudesTriangle({ x: 0, y: 1 }, { x: 2, y: 1 }, A, V, B),
    true,
    'segment crossing the triangle is forbidden'
  );

  assert.equal(
    C.segmentIntrudesSegment({ x: -1, y: 0 }, { x: 0, y: 0 }, A, B),
    false,
    'endpoint-only contact is allowed'
  );
  assert.equal(
    C.segmentIntrudesSegment({ x: 1, y: 0 }, { x: 1, y: 1 }, A, B),
    true,
    'chord-interior contact is forbidden'
  );
});

test('cell edits coalesce batches and support undo/redo', () => {
  const model = new C.LabelGridModel(sampleRaw);
  const before = model.get(4, 3);
  assert.equal(before, 0);

  assert.ok(model.editCell(4, 3, 2));
  assert.equal(model.get(4, 3), 2);
  assert.equal(model.undo(), true);
  assert.equal(model.get(4, 3), 0);
  assert.equal(model.redo(), true);
  assert.equal(model.get(4, 3), 2);

  model.undo();
  model.beginBatch();
  model.paintInBatch(1, 1, 9);
  model.paintInBatch(1, 2, 9);
  model.commitBatch();
  assert.equal(model.get(1, 1), 9);
  assert.equal(model.get(1, 2), 9);
  model.undo();
  assert.notEqual(model.get(1, 1), 9);
  assert.notEqual(model.get(1, 2), 9);
  model.redo();
  assert.equal(model.get(1, 1), 9);
});

test('rejects grids above 512 cells per side', () => {
  assert.throws(
    () => new C.LabelGridModel({ labels: Array.from({ length: 513 }, () => [0]) }),
    /512/
  );
});

test('enforces 60,000 unit edge limit with a coded error', () => {
  const n = 256;
  const labels = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push((r + c) % 2 ? 1 : 2);
    labels.push(row);
  }
  assert.throws(
    () => C.processGrid({ labels }, { maxDoubleArea: 0 }),
    err => err.code === 'EDGE_LIMIT' && err.details.boundaryCount > 60000
  );
});

test('acceptance: two identical [1,2] rows have one oriented x=1 shared edge', () => {
  const result = C.processGrid({ labels: [[1, 2], [1, 2]] }, { maxDoubleArea: 0 });
  const shared = result.edges.filter(e => e.x1 === 1 && e.x2 === 1);
  assert.equal(shared.length, 1);
  assert.deepEqual([shared[0].x1, shared[0].y1], [1, 2]);
  assert.deepEqual([shared[0].x2, shared[0].y2], [1, 0]);
  assert.equal(shared[0].left, 1);
  assert.equal(shared[0].right, 2);
  assert.ok(result.edges.every(e => e.left !== e.right));
});

test('acceptance: single cell removes (0,0) at area 1 and cannot collapse the third side', () => {
  const zero = C.processGrid({ labels: [[1]] }, { maxDoubleArea: 0 });
  assert.equal(zero.edges.length, 4);

  const one = C.processGrid({ labels: [[1]] }, { maxDoubleArea: 1 });
  const points = new Set();
  for (const e of one.edges) {
    points.add(`${e.x1},${e.y1}`);
    points.add(`${e.x2},${e.y2}`);
  }
  assert.equal(one.edges.length, 3);
  assert.deepEqual([...points].sort(), ['0,1', '1,0', '1,1']);
  assert.ok(!points.has('0,0'));

  // A much larger limit still leaves a triangle because the next chord would
  // coincide with the remaining third edge.
  const huge = C.processGrid({ labels: [[1]] }, { maxDoubleArea: 10_000 });
  assert.equal(huge.edges.length, 3);
});

test('acceptance: exact 512x112 alternating-row fixture has 58,080 units and 337 edges at zero', () => {
  const width = 512;
  const height = 112;
  const cells = new Int32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) cells[r * width + c] = r % 2 ? 2 : 1;
  }

  assert.equal(C.countBoundaryEdges(cells, width, height), 58080);
  const started = performance.now();
  const result = C.processGrid({ width, height, cells }, { maxDoubleArea: 0 });
  const elapsed = performance.now() - started;
  assert.equal(result.unitEdges.length, 58080);
  assert.equal(result.edges.length, 337);
  assert.ok(C.areaZeroBoundariesMatch(result));
  assert.ok(elapsed < 12000, `stripe fixture took ${elapsed}ms`);
});

test('full-size bounded-edge input processes within 12 seconds', () => {
  const n = 512;
  const labels = Array.from({ length: n }, () => new Array(n).fill(0));
  let seed = 0x12345678;
  function rand() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  // Sparse two-phase field gives roughly the 60k boundary-edge scale.
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (rand() < 0.055) labels[r][c] = 1 + Math.floor(rand() * 3);
    }
  }

  const raw = { labels, palette: { 1: '#ff0000', 2: '#00ff00', 3: '#0000ff' } };
  const count = C.countBoundaryEdges(
    Int32Array.from(labels.flat()), n, n
  );
  assert.ok(count <= 60000, `fixture should be within edge limit, got ${count}`);

  const started = performance.now();
  const result = C.processGrid(raw, { maxDoubleArea: 2 });
  const elapsed = performance.now() - started;
  assert.ok(result.edges.length > 0);
  assert.ok(elapsed < 12000, `processing took ${elapsed}ms`);
});
