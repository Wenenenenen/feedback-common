const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const Core = require('../agreement-core.js');

function makeDataset({ truthIds, predictionIds, truthAreas, predictionAreas, intersections }) {
  const nT = truthIds.length;
  const nP = predictionIds.length;
  return {
    width: 16,
    height: 16,
    truthIds,
    predictionIds,
    truthIndex: new Map(truthIds.map((id, i) => [id, i])),
    predictionIndex: new Map(predictionIds.map((id, i) => [id, i])),
    truthAreas,
    predictionAreas,
    intersections: intersections instanceof Int32Array
      ? intersections
      : Int32Array.from(intersections),
    truthObjects: truthIds.map((id, index) => ({ id, index, area: truthAreas[index] })),
    predictionObjects: predictionIds.map((id, index) => ({ id, index, area: predictionAreas[index] })),
    excludedTruth: [],
    excludedPrediction: [],
  };
}

function bruteForceMatch(ds, thresholdValue = '0') {
  const threshold = Core.parseThresholds([thresholdValue])[0];
  const nT = ds.truthIds.length;
  const nP = ds.predictionIds.length;
  let best = null;

  function compareCandidate(card, score, assignment) {
    if (!best) return true;
    if (card !== best.card) return card > best.card;
    if (score !== best.score) return score > best.score;
    for (let i = 0; i < nT; i += 1) {
      const a = assignment[i] === -1 ? nP : assignment[i];
      const b = best.assignment[i] === -1 ? nP : best.assignment[i];
      if (a !== b) return a < b;
    }
    return false;
  }

  function search(ti, usedPred, assignment, card, score) {
    if (ti === nT) {
      if (compareCandidate(card, score, assignment)) {
        best = { card, score, assignment: assignment.slice() };
      }
      return;
    }

    assignment[ti] = -1;
    search(ti + 1, usedPred, assignment, card, score);

    for (let pj = 0; pj < nP; pj += 1) {
      if (usedPred.has(pj)) continue;
      if (!Core.isEligible(ds, ti, pj, threshold)) continue;
      const overlap = Core.getOverlap(ds, ti, pj);
      usedPred.add(pj);
      assignment[ti] = pj;
      search(ti + 1, usedPred, assignment, card + 1, score + overlap.iouMillionFloor);
      usedPred.delete(pj);
      assignment[ti] = -1;
    }
  }

  search(0, new Set(), new Array(nT).fill(-1), 0, 0);
  return best.assignment;
}

function coreAssignment(result, nT) {
  const assignment = new Array(nT).fill(-1);
  for (const p of result.pairs) assignment[p.truthIndex] = p.predictionIndex;
  return assignment;
}

test('parsePgm reads big-endian 16-bit samples and P5 comments', () => {
  const header = Buffer.from('P5\n# unit test\n2 1\n65535\n', 'ascii');
  const pixels = Buffer.from([0x00, 0x01, 0xff, 0xff]);
  const image = Core.parsePgm(new Uint8Array(Buffer.concat([header, pixels])), 'unit.pgm');
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.equal(image.bitDepth, 16);
  assert.deepEqual([...image.data], [1, 65535]);
});

test('global matching resolves the prediction that greedily steals two truths', () => {
  // Rows are truths T1,T2; columns predictions P1,P2.
  // P1 overlaps T2 slightly more strongly than T1, while P2 can rescue T2.
  const ds = makeDataset({
    truthIds: [10, 20],
    predictionIds: [100, 200],
    truthAreas: [100, 100],
    predictionAreas: [100, 100],
    intersections: [
      90, 0,
      95, 50,
    ],
  });

  const result = Core.matchThreshold(ds, '3000');
  assert.equal(result.counts.matchedPairs, 2);
  assert.deepEqual(
    result.pairs.map((p) => [p.truthId, p.predictionId]),
    [[10, 100], [20, 200]],
  );
  assert.deepEqual(result.unmatchedTruthIds, []);
  assert.deepEqual(result.unmatchedPredictionIds, []);
});

test('zero intersection is ineligible even at threshold zero', () => {
  const ds = makeDataset({
    truthIds: [1],
    predictionIds: [2],
    truthAreas: [10],
    predictionAreas: [10],
    intersections: [0],
  });
  const result = Core.matchThreshold(ds, '0');
  assert.equal(result.counts.matchedPairs, 0);
  assert.deepEqual(result.unmatchedTruthIds, [1]);
  assert.deepEqual(result.unmatchedPredictionIds, [2]);
});

test('exact threshold uses integer arithmetic, including boundary', () => {
  const ds = makeDataset({
    truthIds: [1],
    predictionIds: [2],
    truthAreas: [2],
    predictionAreas: [2],
    intersections: [2], // union = 2, IoU = 1
  });
  assert.equal(Core.matchThreshold(ds, '10000').counts.matchedPairs, 1);

  const half = makeDataset({
    truthIds: [1],
    predictionIds: [2],
    truthAreas: [2],
    predictionAreas: [2],
    intersections: [1], // union 3, IoU 1/3
  });
  assert.equal(Core.matchThreshold(half, '3333').counts.matchedPairs, 1);
  assert.equal(Core.matchThreshold(half, '3334').counts.matchedPairs, 0);
});

test('matcher matches brute force cardinality, micro-IoU score, and lex tie-break', () => {
  let seed = 0x12345678;
  function random() {
    // deterministic LCG
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  for (let trial = 0; trial < 200; trial += 1) {
    const nT = Math.floor(random() * 6);
    const nP = Math.floor(random() * 6);
    const truthIds = Array.from({ length: nT }, (_, i) => [3, 11, 27, 101, 4096, 65000][i]);
    const predictionIds = Array.from({ length: nP }, (_, i) => [7, 13, 99, 300, 8080, 65534][i]);
    const truthAreas = Array.from({ length: nT }, () => 20 + Math.floor(random() * 180));
    const predictionAreas = Array.from({ length: nP }, () => 20 + Math.floor(random() * 180));
    const intersections = new Int32Array(nT * nP);

    for (let ti = 0; ti < nT; ti += 1) {
      for (let pj = 0; pj < nP; pj += 1) {
        const maxInter = Math.min(truthAreas[ti], predictionAreas[pj]);
        // Most edges exist; some are zero to exercise optional assignment.
        intersections[ti * nP + pj] = random() < 0.18
          ? 0
          : 1 + Math.floor(random() * maxInter);
      }
    }

    const ds = makeDataset({ truthIds, predictionIds, truthAreas, predictionAreas, intersections });
    const result = Core.matchThreshold(ds, '0');
    const actual = coreAssignment(result, nT);
    const expected = bruteForceMatch(ds, '0');
    assert.deepEqual(actual, expected, `trial ${trial} nT=${nT} nP=${nP}`);
  }
});

function readZipPgmEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = {};
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(compressed) : Buffer.from(compressed);
    offset = dataStart + compressedSize;
  }
  return entries;
}

test('truth ignore pixels remove area from both masks and empty predictions are excluded', () => {
  const truthData = Uint16Array.from([1, 1, 65535, 65535]);
  const predictionData = Uint16Array.from([2, 2, 3, 3]);
  const image = (data) => ({ width: 2, height: 2, data, maxval: 65535, bitDepth: 16 });
  const ds = Core.buildDataset(image(truthData), image(predictionData));

  assert.equal(ds.ignoredPixels, 2);
  assert.deepEqual(ds.truthIds, [1]);
  assert.deepEqual(ds.predictionIds, [2]);
  assert.deepEqual(ds.predictionAreas, [2]);
  assert.deepEqual(ds.excludedPrediction, [{ id: 3, rawArea: 2, reason: '全部像素位于真值 65535 忽略区' }]);

  const perfect = Core.matchThreshold(ds, '10000');
  assert.equal(perfect.counts.matchedPairs, 1);
  assert.equal(perfect.pairs[0].intersectionArea, 2);
  assert.equal(perfect.pairs[0].unionArea, 2);
});

test('bundled sample archive produces expected ignore-aware counts and pairs', () => {
  const zipPath = path.join(__dirname, '..', 'samples', 'instance-agreement.zip');
  const entries = readZipPgmEntries(zipPath);
  const truth = Core.parsePgm(new Uint8Array(entries['truth.pgm']), 'truth.pgm');
  const prediction = Core.parsePgm(new Uint8Array(entries['prediction.pgm']), 'prediction.pgm');
  const ds = Core.buildDataset(truth, prediction);

  assert.equal(ds.width, 4);
  assert.equal(ds.height, 3);
  assert.equal(ds.ignoredPixels, 2);
  assert.deepEqual(ds.truthIds, [1, 3]);
  assert.deepEqual(ds.predictionIds, [301, 302]);
  assert.deepEqual(ds.excludedPrediction.map((x) => x.id), [900]);

  const result = Core.matchThreshold(ds, '5000');
  assert.equal(result.counts.matchedPairs, 2);
  assert.deepEqual(result.pairs.map((p) => [p.truthId, p.predictionId]), [[1, 301], [3, 302]]);
  assert.equal(result.pairs[0].intersectionArea, 2);
  assert.equal(result.pairs[0].unionArea, 2);
  assert.equal(result.pairs[1].intersectionArea, 4);
  assert.equal(result.pairs[1].unionArea, 5);
});
