const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseImprintJSON,
  StackOptimizer,
  findCycle,
} = require('../solver.js');

const samplePath = path.join(__dirname, '..', 'samples', 'imprint-stack.json');
const sample = parseImprintJSON(fs.readFileSync(samplePath, 'utf8'));

test('bundled sample reaches the expected zero-cost lexicographic order', () => {
  const optimizer = new StackOptimizer(sample);
  const edges = sample.locks.map((lock) => [lock.above - 1, lock.below - 1]);
  const result = optimizer.solve(edges);

  assert.equal(result.ok, true);
  assert.deepEqual(result.orderLayers, [3, 1, 2, 4]);
  assert.equal(result.score, 0);

  const evaluation = optimizer.evaluate(result.order);
  assert.equal(evaluation.score, 0);
  assert.equal(evaluation.mismatchCount, 0);
});

test('sample reverse query charges the contradictory pixel', () => {
  const optimizer = new StackOptimizer(sample);
  const result = optimizer.solve([[2, 1], [1, 0]]); // 3>2 and reversed 2>1

  assert.equal(result.ok, true);
  assert.deepEqual(result.orderLayers, [3, 2, 1, 4]);
  assert.equal(result.score, 5);
  assert.equal(optimizer.evaluate(result.order).mismatchCount, 1);
});

test('sample detects the direct reversed lock cycle', () => {
  const optimizer = new StackOptimizer(sample);
  const result = optimizer.solve([[2, 1], [1, 2]]); // 3>2 and 2>3

  assert.equal(result.ok, false);
  assert.deepEqual(result.cycleLayers, [2, 3, 2]);
  assert.equal(result.cycleText, '2 → 3 → 2');
});

test('all-zero weights choose ordinary lexicographic order', () => {
  const data = makeRandomData(6, 80, { zeroWeights: true });
  const optimizer = new StackOptimizer(data);
  const result = optimizer.solve([]);

  assert.deepEqual(result.orderLayers, [1, 2, 3, 4, 5, 6]);
  assert.equal(result.score, 0);
});

test('subset DP matches exhaustive permutations on random data and locks', () => {
  for (let seed = 1; seed <= 80; seed += 1) {
    const random = mulberry32(seed);
    const n = 1 + Math.floor(random() * 7);
    const data = makeRandomData(n, 1 + Math.floor(random() * 180), { random });
    const optimizer = new StackOptimizer(data);

    // Build only forward edges in a random topological order, guaranteeing acyclicity.
    const topological = shuffle([...Array(n).keys()], random);
    const position = new Array(n);
    topological.forEach((layer, index) => { position[layer] = index; });
    const edges = [];
    for (let u = 0; u < n; u += 1) {
      for (let v = u + 1; v < n; v += 1) {
        if (random() < 0.16) {
          if (position[u] < position[v]) edges.push([u, v]);
          else edges.push([v, u]);
        }
      }
    }

    const result = optimizer.solve(edges);
    assert.equal(result.ok, true, `seed ${seed} should be acyclic`);

    const brute = bruteForceOptimum(optimizer, n, edges);
    assert.equal(result.score, brute.score, `score mismatch seed ${seed}`);
    assert.deepEqual(
      result.orderLayers,
      brute.order.map((x) => x + 1),
      `lexicographic order mismatch seed ${seed}`,
    );
    assert.equal(
      optimizer.evaluate(result.order).score,
      result.score,
      `pixel score mismatch seed ${seed}`,
    );
  }
});

test('findCycle returns a real directed cycle', () => {
  const cycle = findCycle(5, [[0, 1], [1, 2], [2, 3], [3, 1]]);
  assert.ok(cycle);
  assert.equal(cycle[0], cycle[cycle.length - 1]);

  const edges = new Set();
  for (let i = 0; i < cycle.length - 1; i += 1) edges.add(`${cycle[i]}>${cycle[i + 1]}`);
  for (let i = 0; i < cycle.length - 1; i += 1) {
    assert.ok(edges.has(`${cycle[i]}>${cycle[i + 1]}`));
  }
});

function bruteForceOptimum(optimizer, n, edges) {
  let bestScore = Infinity;
  let bestOrder = null;

  for (const order of permutations([...Array(n).keys()])) {
    if (!satisfiesEdges(order, edges)) continue;
    const score = optimizer.evaluate(order).score;
    const orderLayers = order.map((x) => x + 1);
    if (
      score < bestScore
      || (score === bestScore && lexLess(orderLayers, bestOrder ? bestOrder.map((x) => x + 1) : null))
    ) {
      bestScore = score;
      bestOrder = order;
    }
  }

  return { score: bestScore, order: bestOrder };
}

function satisfiesEdges(order, edges) {
  const position = new Map(order.map((layer, index) => [layer, index]));
  return edges.every(([above, below]) => position.get(above) < position.get(below));
}

function lexLess(a, b) {
  if (!b) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const result = [];
  items.forEach((item, index) => {
    const rest = items.slice(0, index).concat(items.slice(index + 1));
    for (const suffix of permutations(rest)) result.push([item, ...suffix]);
  });
  return result;
}

function makeRandomData(n, pixelCount, options = {}) {
  const random = options.random || Math.random;
  const fullMask = (1 << n) - 1;
  const cover = new Uint32Array(pixelCount);
  const observed = new Uint8Array(pixelCount);
  const weight = new Uint8Array(pixelCount);

  for (let p = 0; p < pixelCount; p += 1) {
    cover[p] = Math.floor(random() * (fullMask + 1));
    observed[p] = Math.floor(random() * (n + 1));
    weight[p] = options.zeroWeights ? 0 : Math.floor(random() * 256);
  }

  return {
    width: pixelCount,
    height: 1,
    layerCount: n,
    pixelCount,
    cover,
    observed,
    weight,
    locks: [],
  };
}

function shuffle(items, random) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
