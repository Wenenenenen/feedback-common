const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SF = require('../strip-forge.js');

test('ships the sample to the expected shortest stream and mapping', () => {
  const doc = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'samples', 'ordered-strips.json'), 'utf8')
  );
  const result = SF.packDocument(doc);
  assert.deepEqual(result.indices, [0, 1, 2, 3, -1, 9, 10, 11]);
  assert.equal(result.length, 8);
  assert.deepEqual(
    result.mapping.map((m) => [m.originalIndex, m.windowStart, m.parity]),
    [
      [0, 0, 0],
      [1, 1, 1],
      [2, 5, 0]
    ]
  );
  assert.equal(result.mapping[2].raw[2], 11);
  assert.equal(SF.verifyResult(doc, result).ok, true);
});

test('uses degenerate windows when they beat restart', () => {
  const faces = [{ v: [2, 3, 4], group: 0, last: 3 }, { v: [1, 2, 3], group: 0, last: null }];
  const result = SF.packDocument({ faces });
  assert.deepEqual(result.indices, [4, 2, 3, 3, 2, 1]);
  assert.equal(result.stats.degenerateWindowCount, 2);
  assert.equal(result.stats.restartCount, 0);
  assert.equal(SF.verifyResult({ faces }, result).ok, true);
});

test('forced group boundaries contain exactly one restart index', () => {
  const faces = [
    { v: [0, 1, 2], group: 0, last: null },
    { v: [3, 4, 5], group: 1, last: 5 }
  ];
  const result = SF.packDocument({ faces });
  assert.deepEqual(result.indices, [0, 1, 2, -1, 3, 4, 5]);
  assert.equal(result.stats.restartCount, 1);
  assert.equal(SF.verifyResult({ faces }, result).ok, true);
});

test('rejects non-contiguous groups and bad last vertices', () => {
  assert.throws(() =>
    SF.validateDocument({
      faces: [
        { v: [0, 1, 2], group: 0, last: null },
        { v: [1, 2, 3], group: 1, last: null },
        { v: [2, 3, 4], group: 0, last: null }
      ]
    })
  );
  assert.throws(() =>
    SF.validateDocument({ faces: [{ v: [0, 1, 2], group: 0, last: 9 }] })
  );
  assert.throws(() =>
    SF.validateDocument({ faces: [{ v: [0, 0, 2], group: 0, last: null }] })
  );
});

test('preserves winding when a last vertex is locked', () => {
  const result = SF.packDocument({
    faces: [{ v: [0, 1, 2], group: 0, last: 0 }]
  });
  // 只有循环移位 [1,2,0] 的第三点是 0；不能交换成反向面。
  assert.deepEqual(result.indices, [1, 2, 0]);
  assert.deepEqual(result.mapping[0].canonical, [1, 2, 0]);
});

test('packs the prescribed 100k chain quickly', () => {
  const faces = new Array(100000);
  for (let i = 0; i < 100000; i++) {
    faces[i] = {
      v: i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2],
      group: 0,
      last: null
    };
  }
  const started = Date.now();
  const result = SF.packDocument({ faces });
  const elapsed = Date.now() - started;
  assert.equal(result.indices.length, 100002);
  assert.equal(result.indices[100001], 100001);
  assert.equal(result.stats.degenerateWindowCount, 0);
  assert.equal(SF.verifyResult({ faces }, result).ok, true);
  assert.ok(elapsed < 8000, `packing took ${elapsed}ms`);
});
