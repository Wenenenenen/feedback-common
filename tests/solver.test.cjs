'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Solver = require('../solver.js');
const IO = require('../io.js');

function* enumerateCurves(n, maxValue, slopeMax, slopeStep, locksByX) {
  const curve = new Array(n);

  function* recurse(i, previousSlope) {
    if (i === n) {
      yield curve.slice();
      return;
    }

    for (let y = 0; y <= maxValue; y += 1) {
      if (locksByX.has(i) && y !== locksByX.get(i)) continue;

      if (i === 0) {
        curve[i] = y;
        yield* recurse(i + 1, null);
      } else {
        const d = y - curve[i - 1];
        if (d < 0 || d > slopeMax) continue;
        if (previousSlope !== null && Math.abs(d - previousSlope) > slopeStep) continue;
        curve[i] = y;
        yield* recurse(i + 1, d);
      }
    }
  }

  yield* recurse(0, null);
}

function bruteForce({ n, maxValue, slopeMax = 3, slopeStep = 1, W, A, locks = [] }) {
  const locksByX = new Map(locks.map((l) => [l.x ?? l[0], l.y ?? l[1]]));
  let bestCost = Infinity;
  let bestCurve = null;
  let count = 0;

  // Generator visits curves in lexicographic order.
  for (const curve of enumerateCurves(n, maxValue, slopeMax, slopeStep, locksByX)) {
    count += 1;
    let cost = 0;
    for (let x = 0; x < n; x += 1) {
      cost += (W[x] || 0) * curve[x] * curve[x] - 2 * (A[x] || 0) * curve[x];
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestCurve = curve;
    }
  }

  return { bestCost, bestCurve, count };
}

test('DP matches exhaustive optimum and lexicographic tie for random small cases', () => {
  let seed = 0x12345678;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  for (let trial = 0; trial < 300; trial += 1) {
    const n = 2 + Math.floor(rand() * 6); // 2..7
    const maxValue = 1 + Math.floor(rand() * 3); // values 0..1 or 0..3
    const slopeMax = 1 + Math.floor(rand() * 3); // 1..3
    const W = Array.from({ length: n }, () => Math.floor(rand() * 20));
    const A = Array.from({ length: n }, () => Math.floor(rand() * 20 * maxValue));

    const locks = [];
    const lockCount = Math.floor(rand() * 3);
    for (let k = 0; k < lockCount; k += 1) {
      const x = Math.floor(rand() * n);
      const y = Math.floor(rand() * (maxValue + 1));
      const existing = locks.find((l) => l.x === x);
      if (existing) existing.y = y;
      else locks.push({ x, y });
    }

    const expected = bruteForce({ n, maxValue, slopeMax, slopeStep: 1, W, A, locks });
    const actual = Solver.solveAnchoredCurve({
      bins: n,
      maxValue,
      slopeMax,
      slopeStep: 1,
      weightSum: Float64Array.from(W),
      weightedTargetSum: Float64Array.from(A),
      locks,
    });

    if (!expected.bestCurve) {
      assert.equal(actual.ok, false, `trial ${trial}: expected infeasible`);
      assert.match(actual.message, /无法同时满足/);
      continue;
    }

    assert.equal(actual.ok, true, `trial ${trial}: ${actual.message}`);
    assert.deepEqual(
      actual.curve,
      expected.bestCurve,
      `trial ${trial} n=${n} maxValue=${maxValue} slopeMax=${slopeMax} locks=${JSON.stringify(locks)}`,
    );
    assert.equal(actual.objectiveVariable, expected.bestCost);
    assert.equal(Solver.analyzeCurve(actual.curve, { locks, maxValue, slopeMax }).feasible, true);
  }
});

test('production curve has 4096 entries and respects all constraints for sample-like data', async () => {
  const zipPath = path.join(__dirname, '..', 'samples', 'anchored-tone-cases.zip');
  const buffer = fs.readFileSync(zipPath);
  const files = await IO.unzip(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

  const byBase = Object.fromEntries(Object.values(files).map((f) => [IO.baseName(f.name), f.data]));
  const source = IO.readP5(byBase['source.pgm']);
  const target = IO.readP5(byBase['target.pgm']);
  const weights = IO.readP5(byBase['weights.pgm']);
  const locks = JSON.parse(new TextDecoder().decode(byBase['locks.json'])).locks;

  assert.equal(source.width, 4);
  assert.equal(source.height, 2);
  assert.equal(source.maxval, 4095);
  assert.equal(target.maxval, 1023);
  assert.equal(weights.maxval, 255);

  const obs = Solver.aggregateObservations(source.data, target.data, weights.data, 4096);
  const result = Solver.solveAnchoredCurve({ ...obs, locks });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.curve.length, 4096);
  assert.ok(result.curve.every((v) => Number.isInteger(v) && v >= 0 && v <= 1023));

  for (const [x, y] of locks) assert.equal(result.curve[x], y);

  for (let i = 0; i < 4095; i += 1) {
    const d = result.curve[i + 1] - result.curve[i];
    assert.ok(d >= 0 && d <= 3, `slope ${d} at ${i}`);
    if (i > 0) {
      const prev = result.curve[i] - result.curve[i - 1];
      assert.ok(Math.abs(d - prev) <= 1, `slope jump at ${i}`);
    }
  }

  // The sample contains one zero-weight pixel; it must not affect usedPixels.
  assert.equal(obs.pixelCount, 8);
  assert.equal(obs.usedPixels, 7);

  // A direct score recomputation agrees with the solver result.
  const score = Solver.scoreCurve(result.curve, obs);
  assert.equal(score.weightedSquaredError, result.weightedSquaredError);
});

test('collective slope-jump lock conflict is diagnosed as infeasible', () => {
  const result = Solver.solveAnchoredCurve({
    bins: 3,
    maxValue: 3,
    slopeMax: 3,
    locks: [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 2, y: 3 }],
    weightSum: new Float64Array(3),
    weightedTargetSum: new Float64Array(3),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'infeasible_locks');
  assert.match(result.message, /无法同时满足/);
  assert.ok(result.failedLock);
  assert.equal(result.failedLock.x, 2);
});

test('more than 32 locks are rejected', () => {
  const locks = Array.from({ length: 33 }, (_, i) => [i * 100, Math.min(1023, i * 30)]);
  const result = Solver.solveAnchoredCurve({ locks });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'too_many_locks');
});
