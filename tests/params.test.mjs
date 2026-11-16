// params.test.mjs — parameter snapshots, geometry keys and export JSON.
// Run with: node --test tests/params.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { geometryKey, snapshotParams, buildParamsJson, archiveName, quantize } from '../app/js/params.js';
import { DEFAULTS } from '../app/js/core.js';

const meta = { width: 160, height: 96, fx: 100, fy: 100, cx: 80, cy: 48, color: 'color.png', depth: 'plane.f32' };

const baseState = () => ({
  eyeDistance: 0.1, zeroPlane: 4, jump: 0.5, fillEnabled: true, fillMaxGap: 24,
});

test('geometryKey: changes with every rasterisation input and nothing else', () => {
  const p = { ...meta, eyeDistance: 0.1, zeroPlane: 4, jump: 0.5 };
  const key = geometryKey(p);
  for (const patch of [{ fx: 99 }, { fy: 99 }, { cx: 79 }, { cy: 47 }, { eyeDistance: 0.11 }, { zeroPlane: 3.9 }, { jump: 0.51 }]) {
    assert.notEqual(geometryKey({ ...p, ...patch }), key, `expected a new key for ${JSON.stringify(patch)}`);
  }
  // Fill settings are deliberately not part of the key.
  assert.equal(geometryKey({ ...p, fillEnabled: false, fillMaxGap: 3 }), key);
  // Sub-micro differences are normalised away.
  assert.equal(geometryKey({ ...p, jump: 0.5 + 1e-9 }), key);
});

test('snapshot: quantises and keeps the fill contract text', () => {
  const s = snapshotParams({ eyeDistance: 0.1234567891, zeroPlane: 4.0000004, jump: 0.5, fillEnabled: false, fillMaxGap: 7.6 });
  assert.equal(s.eyeDistance, 0.123457);
  assert.equal(s.zeroPlane, 4);
  assert.equal(s.jump, 0.5);
  assert.equal(s.fillDisplayed, false);
  assert.equal(s.fillMaxGap, 8);
  assert.match(s.fillStrategy, /补洞/);
});

test('params.json: complete recipe with source fingerprints', () => {
  const result = {
    triangleCount: 29686,
    depthRange: { min: 1, max: 4, invalid: 37, valid: 15323, hasRange: true },
    stats: {
      leftHoles: 261, rightHoles: 261, leftCovered: 15099, rightCovered: 15099,
      leftFill: { filled: 261, runs: 63, filledRuns: 63, skippedRuns: 0, longestRun: 6, maxGap: 24 },
      rightFill: { filled: 261, runs: 63, filledRuns: 63, skippedRuns: 0, longestRun: 6, maxGap: 24 },
    },
  };
  const dataset = { caseName: 'occlusion', colorHash: '0xabc', depthHash: '0xdef', depthBytes: 61440 };
  const json = buildParamsJson({ state: baseState(), meta, dataset, result });
  assert.equal(json.format, 'stereo-depth-forge/v1');
  assert.equal(json.source.width, 160);
  assert.equal(json.source.depthFile, 'plane.f32');
  assert.equal(json.source.depthFnv1a, '0xdef');
  assert.equal(json.source.invalidDepthCount, 37);
  assert.deepEqual(json.source.depthRangeM, [1, 4]);
  assert.equal(json.params.eyeDistance, 0.1);
  assert.equal(json.params.fillMaxGap, 24);
  assert.equal(json.derived.eyeXLeft, -0.05);
  assert.equal(json.derived.eyeXRight, 0.05);
  assert.equal(json.derived.disparityAtNearM, 7.5);
  assert.equal(json.render.triangleCount, 29686);
  assert.equal(json.render.leftHoles, 261);
  // Every file the archive carries is described.
  for (const name of ['left.png', 'right.png', 'left-filled.png', 'right-filled.png', 'left-mask.png', 'right-mask.png', 'params.json']) {
    assert.ok(json.files[name], `missing description for ${name}`);
  }
  // The JSON must survive a serialisation round trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
});

test('archive name: filesystem safe and timestamped', () => {
  const name = archiveName({ caseName: 'a/b c:d' }, new Date(2026, 10, 17, 3, 4, 5));
  assert.match(name, /^a_b_c_d-20261117-030405\.zip$/);
  assert.match(archiveName({ caseName: null }, new Date(2026, 0, 2, 0, 0, 0)), /^stereo-20260102-000000\.zip$/);
});

test('quantize rounds to six decimals without trailing drift', () => {
  assert.equal(quantize(0.1 + 0.2), 0.3);
  assert.equal(quantize(1e-9), 0);
  assert.equal(quantize(-0.0000004), 0);
});
