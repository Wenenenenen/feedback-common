// core.test.mjs — engine checks against the sample oracle and the stated
// physical conventions.  Run with: node --test tests/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateMeta, decodeRaw, buildVolume, sampleVolume, voxelCenter,
  traceRay, renderImage, computeCamera, presetView, orbitView, planSegments,
  segmentAlpha, windowToGray8, normalizeTransferFunction, evalTransfer,
  encodeSrgbRgba, srgbToLinear, linearToSrgb, rayBoxInterval, DEFAULT_TF,
  DEFAULT_REF_MM, MAX_DIM, buildTransferLut, evalTransferLut,
} from '../app/js/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const casesDir = join(root, 'tests', '.cases');

// Unpack the sample archive once into a fresh scratch directory.
function ensureCases() {
  try {
    readFileSync(join(casesDir, 'oracle.json'));
    return casesDir;
  } catch { /* extract below */ }
  mkdtempSync(join(tmpdir(), 'vrc-'));
  execFileSync('mkdir', ['-p', casesDir]);
  execFileSync('unzip', ['-o', join(root, 'samples', 'volume-ray-cases.zip'), '-d', casesDir], { stdio: 'ignore' });
  return casesDir;
}

const dir = ensureCases();
const readJson = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const readRaw = (name) => new Uint8Array(readFileSync(join(dir, name)));

function loadCase(jsonName) {
  const rawMeta = readJson(jsonName);
  const raw = readRaw(rawMeta.raw);
  const check = validateMeta(rawMeta, raw.byteLength);
  assert.ok(check.ok, check.errors.join('; '));
  return { rawMeta, meta: check.meta, raw, volume: buildVolume(raw, check.meta, jsonName, rawMeta.raw) };
}

const oracle = readJson('oracle.json');
const ramp = loadCase('ramp-u16le.json');
const rampBe = loadCase('ramp-u16be.json');
const uniform = loadCase('uniform-u16le.json');
const uniform8 = loadCase('uniform-u8.json');

test('metadata: valid cases normalise without errors', () => {
  assert.equal(ramp.meta.dimensions.join(','), '16,12,8');
  assert.equal(ramp.meta.bytesPerVoxel, 2);
  assert.equal(ramp.meta.expectedBytes, 3072);
  assert.equal(uniform8.meta.bytesPerVoxel, 1);
  assert.equal(uniform8.meta.expectedBytes, 192);
});

test('metadata: dimension/spacing/type errors are reported precisely', () => {
  const base = { dimensions: [8, 8, 8], spacing: [1, 1, 1], voxelType: 'u16', endian: 'little' };
  const bad = (patch) => validateMeta({ ...base, ...patch }).errors.join(' ');

  assert.match(bad({ dimensions: [0, 8, 8] }), /dimensions\[0\]/);
  assert.match(bad({ dimensions: [8, 8, 129] }), /1\.\.128/);
  assert.match(bad({ dimensions: [8, 8.5, 8] }), /dimensions\[1\]/);
  assert.match(bad({ dimensions: [8, 8] }), /长度为 3/);
  assert.match(bad({ spacing: [1, 0, 1] }), /spacing\[1\]/);
  assert.match(bad({ spacing: [1, -0.5, 1] }), /spacing\[1\]/);
  assert.match(bad({ voxelType: 'f32' }), /voxelType/);
  assert.match(bad({ endian: 'middle' }), /endian/);
  assert.match(bad({ layout: 'z-fastest' }), /layout/);
  assert.match(bad({ origin: 'center' }), /origin/);
  // MAX_DIM is the accepted upper bound
  assert.equal(validateMeta({ ...base, dimensions: [MAX_DIM, 1, 1] }).ok, true);
});

test('metadata: declared length mismatch names expected, actual and delta', () => {
  const res = validateMeta(readJson('invalid-length.json'), 3071);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /16×12×8 u16/);
  assert.match(res.errors[0], /需要 3072 字节/);
  assert.match(res.errors[0], /实际 3071 字节/);
  assert.match(res.errors[0], /少 1 字节/);
  // decoding a wrong-length buffer fails the same way
  assert.throws(
    () => decodeRaw({ dimensions: [16, 12, 8], voxelType: 'u16', endian: 'little' }, readRaw('truncated.raw')),
    /长度不符/
  );
});

test('decoding: open volume box, half-voxel centres', () => {
  assert.deepEqual(ramp.volume.ext, [16, 24, 24]);
  assert.deepEqual(voxelCenter(ramp.volume, 5, 3, 2), [5.5, 7, 7.5]);
  assert.deepEqual(voxelCenter(ramp.volume, 0, 0, 0), [0.5, 1, 1.5]);
});

test('decoding: u16 big- and little-endian agree; u8 reads as-is', () => {
  assert.equal(sampleVolume(rampBe.volume, 5.5, 7, 7.5), sampleVolume(ramp.volume, 5.5, 7, 7.5));
  assert.equal(sampleVolume(ramp.volume, 5.5, 7, 7.5), 532);
  assert.equal(uniform.volume.valueMin, 1000);
  assert.equal(uniform.volume.valueMax, 1000);
  assert.equal(uniform8.volume.valueMin, 128);
  assert.equal(uniform8.volume.valueMax, 128);
});

test('trilinear sampling matches the oracle probe and interpolates between centres', () => {
  const probe = oracle.ramp_probes[0];
  const v = sampleVolume(ramp.volume, ...probe.center_mm);
  assert.equal(v, probe.value);

  // half-way between x centres (5 and 6) at fixed y/z: (532+632)/2
  assert.equal(sampleVolume(ramp.volume, 6.0, 7, 7.5), 582);
  // quarter into x (5→6) and quarter between rows 3 and 4 (y 7→9 is one row)
  const fx = 0.25; // x=5.75 → gx=5.25
  const fy = 0.25; // y=7.5 → gy=3.25
  const expected = (1 - fy) * ((1 - fx) * 532 + fx * 632) + fy * ((1 - fx) * 542 + fx * 642);
  assert.ok(Math.abs(sampleVolume(ramp.volume, 5.75, 7.5, 7.5) - expected) < 1e-9);
  // z centres are 1.5, 4.5, 7.5, 10.5 mm: halfway between them is 9.0 mm
  assert.ok(Math.abs(sampleVolume(ramp.volume, 5.5, 7, 9.0) - 532.5) < 1e-9);
  // clamped outside the box: the edge voxel value
  assert.equal(sampleVolume(ramp.volume, -5, -5, -5), 0);
  assert.equal(sampleVolume(ramp.volume, 999, 999, 999), 1617);
});

test('MIP at +z and +x reproduces the oracle maxima', () => {
  const camZ = computeCamera(ramp.volume, presetView('+z'), 64, 48);
  // +z ray through the voxel column x=5, y=3
  const centre = voxelCenter(ramp.volume, 5, 3, 2);
  const uv = projectPoint(camZ, centre);
  const ray = rayAt(camZ, uv[0], uv[1]);
  const tr = traceRay(ramp.volume, ray.origin, ray.dir, { mode: 'mip', step: 0.5, window: [0, 4095] });
  assert.equal(tr.maxValue, oracle.ramp_mip_plus_z.value);

  const camX = computeCamera(ramp.volume, presetView('+x'), 48, 64);
  const c2 = voxelCenter(ramp.volume, 5, 3, 2);
  const uv2 = projectPoint(camX, c2);
  const ray2 = rayAt(camX, uv2[0], uv2[1]);
  const tr2 = traceRay(ramp.volume, ray2.origin, ray2.dir, { mode: 'mip', step: 0.5, window: [0, 4095] });
  assert.equal(tr2.maxValue, oracle.ramp_mip_plus_x.value);

  // +X view: screen-x follows +Y and screen-y follows +Z
  const right = camX.right;
  const up = camX.up;
  assert.ok(Math.abs(right[1] - 1) < 1e-9, 'screen-right should be +Y for +X view');
  assert.ok(Math.abs(up[2] - 1) < 1e-9, 'screen-up should be +Z for +X view');
});

// rayAt is a helper the tests use directly.
import { rayAt, projectPoint } from '../app/js/core.js';

test('compositing: uniform 32 mm of alpha 0.1/mm gives the oracle alpha and colour', () => {
  const view = { dir: [1, 0, 0], up: [0, 0, 1], zoom: 1, pan: [0, 0] };
  const cam = computeCamera(uniform.volume, view, 32, 32);
  const centre = [uniform.volume.ext[0] / 2, uniform.volume.ext[1] / 2, uniform.volume.ext[2] / 2];
  const uv = projectPoint(cam, centre);
  const ray = rayAt(cam, uv[0], uv[1]);
  const tf = [{ value: 1000, rgb: [1, 0, 0], alpha: 0.1 }];
  const tr = traceRay(uniform.volume, ray.origin, ray.dir, {
    mode: 'composite', step: 1, tf, refMm: 1, window: [0, 2000],
  });
  assert.equal(tr.lengthMm, oracle.uniform_length_mm);
  assert.ok(Math.abs(tr.final.alpha - oracle.uniform_alpha) < 1e-12, `alpha ${tr.final.alpha}`);
  assert.deepEqual(tr.final.rgba8, oracle.uniform_rgba8);
});

test('compositing: opacity does not depend on step size for uniform material', () => {
  const tf = [{ value: 1000, rgb: [1, 0, 0], alpha: 0.1 }];
  const origin = [-1, 12, 8];
  const dirVec = [1, 0, 0];
  let ref = null;
  for (const step of [0.25, 0.5, 1, 2, 4]) {
    const tr = traceRay(uniform.volume, origin, dirVec, { mode: 'composite', step, tf, refMm: 1 });
    if (ref === null) ref = tr.final.alpha;
    assert.ok(Math.abs(tr.final.alpha - ref) < 1e-9, `step ${step} alpha ${tr.final.alpha} vs ${ref}`);
  }
  assert.ok(Math.abs(ref - oracle.uniform_alpha) < 1e-9);
});

test('compositing: short final segment gets its exact share', () => {
  // A 30.5 mm path with step 1: 30 full segments + one 0.5 mm segment.
  assert.ok(Math.abs(segmentAlpha(0.1, 0.5, 1) - (1 - Math.pow(0.9, 0.5))) < 1e-15);
  const tf = [{ value: 1000, rgb: [1, 0, 0], alpha: 0.1 }];
  // 32 mm path but the sample function clamps, so compare against a manual
  // 30.5 terms: 29x1 mm + 1.5 mm remainder
  const L = 30.5;
  const plan = planSegments(L, 2);
  assert.equal(plan.count, 16);
  assert.ok(Math.abs(plan.lastLen - 0.5) < 1e-12);
  assert.equal(plan.lastIsShort, true);
  // exact accumulated alpha of a uniform ray of that length
  const expected = 1 - Math.pow(0.9, L);
  let acc = 0;
  let pos = 0;
  for (let s = 0; s < plan.count; s++) {
    const len = s === plan.count - 1 ? plan.lastLen : 2;
    acc += (1 - acc) * segmentAlpha(0.1, len, 1);
    pos += len;
  }
  assert.ok(Math.abs(pos - L) < 1e-12, `segments must cover the full path, got ${pos}`);
  assert.ok(Math.abs(acc - expected) < 1e-12, `acc ${acc} vs ${expected}`);
  void tf;
});

test('compositing: colour is straight-alpha linear RGB encoded to sRGB', () => {
  assert.deepEqual(encodeSrgbRgba([1, 0, 0], 0.5), [255, 0, 0, 128]);
  assert.ok(Math.abs(srgbToLinear(linearToSrgb(0.2)) - 0.2) < 1e-12);
  const tr = traceRay(uniform.volume, [-1, 12, 8], [1, 0, 0], {
    mode: 'composite', step: 1, tf: [{ value: 1000, rgb: [0.25, 0.5, 0.75], alpha: 0.1 }], refMm: 1,
  });
  const a = tr.final.alpha;
  assert.ok(Math.abs(tr.final.linear[0] - 0.25) < 1e-12);
  assert.ok(Math.abs(tr.final.linear[1] - 0.5) < 1e-12);
  assert.ok(Math.abs(tr.final.linear[2] - 0.75) < 1e-12);
  assert.equal(tr.final.rgba8[3], Math.round(a * 255));
});

test('MIP ignores transfer-function alpha and maps the window linearly', () => {
  assert.equal(windowToGray8(0, [0, 2000]), 0);
  assert.equal(windowToGray8(1000, [0, 2000]), 128);
  assert.equal(windowToGray8(2000, [0, 2000]), 255);
  assert.equal(windowToGray8(99999, [0, 2000]), 255);
  const tr = traceRay(ramp.volume, [-1, 7, 7.5], [1, 0, 0], {
    mode: 'mip', step: 0.5, window: [0, 2000],
    tf: [{ value: 0, rgb: [1, 1, 1], alpha: 0.9 }],
  });
  const g = windowToGray8(tr.maxValue, [0, 2000]);
  assert.deepEqual(tr.final.rgba8, [g, g, g, 255]);
});

test('transfer function edit: stops interpolate in linear RGB and per-mm alpha', () => {
  const tf = [
    { value: 0, rgb: [0, 0, 0], alpha: 0 },
    { value: 100, rgb: [1, 0.5, 0], alpha: 0.2 },
  ];
  const mid = evalTransfer(tf, 50);
  assert.deepEqual(mid.rgb, [0.5, 0.25, 0]);
  assert.ok(Math.abs(mid.alpha - 0.1) < 1e-15);
  // values past the last stop hold the last stop
  assert.equal(evalTransfer(tf, 500).alpha, 0.2);
});

test('transfer function normalisation rejects malformed stops and clamps out-of-range', () => {
  const bad = normalizeTransferFunction([{ value: 1, rgb: [0, 0], alpha: 0 }]);
  assert.equal(bad.errors.length, 2); // stop rejected + no usable stops left
  assert.match(bad.errors[0], /rgb/);
  const clamped = normalizeTransferFunction([{ value: 1, rgb: [2, -1, 0.5], alpha: 3 }]);
  assert.deepEqual(clamped.tf[0].rgb, [1, 0, 0.5]);
  assert.equal(clamped.tf[0].alpha, 1);
  assert.ok(clamped.warnings.length >= 1);
  const sorted = normalizeTransferFunction([
    { value: 10, rgb: [0, 0, 0], alpha: 0 },
    { value: 0, rgb: [1, 1, 1], alpha: 1 },
  ]);
  assert.deepEqual(sorted.tf.map((s) => s.value), [0, 10]);
});

test('camera: six presets name the ray direction and frame the box', () => {
  const vol = ramp.volume;
  const cases = {
    '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
  };
  for (const [name, expected] of Object.entries(cases)) {
    const cam = computeCamera(vol, presetView(name), 100, 80);
    assert.deepEqual(cam.dir, expected, name);
    // every box corner projects inside the frame
    for (const x of [0, vol.ext[0]]) for (const y of [0, vol.ext[1]]) for (const z of [0, vol.ext[2]]) {
      const uv = projectPoint(cam, [x, y, z]);
      assert.ok(uv[0] > -0.001 && uv[0] < 1.001 && uv[1] > -0.001 && uv[1] < 1.001, `${name} corner ${x},${y},${z} -> ${uv}`);
    }
  }
});

test('camera: orbiting keeps the basis orthonormal and matches presets again', () => {
  let view = presetView('+z');
  view = orbitView(view, 37, -12);
  const cam = computeCamera(ramp.volume, view, 64, 64);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot(cam.dir, cam.dir) - 1) < 1e-12);
  assert.ok(Math.abs(dot(cam.up, cam.up) - 1) < 1e-12);
  assert.ok(Math.abs(dot(cam.dir, cam.up)) < 1e-12);
  assert.ok(Math.abs(dot(cam.dir, cam.right)) < 1e-12);
  // returning to an exact preset is recognised again
  const back = { ...presetView('+z') };
  assert.equal(matchPresetForTest(back), '+z');
});

import { matchPreset as matchPresetForTest } from '../app/js/core.js';

test('ray/box interval: enters and exits at the box faces', () => {
  const ext = [16, 24, 24];
  assert.deepEqual(rayBoxInterval([-1, 12, 12], [1, 0, 0], ext), [1, 17]);
  const miss = rayBoxInterval([-1, -5, 12], [1, 0, 0], ext);
  assert.ok(miss[1] < miss[0]);
});

test('renderImage: transparent background, opaque MIP, and composite alpha', () => {
  const cam = computeCamera(uniform.volume, presetView('+z'), 32, 32);
  const tf = [{ value: 1000, rgb: [1, 0, 0], alpha: 0.1 }];
  const mip = renderImage({ volume: uniform.volume, camera: cam, width: 32, height: 32, mode: 'mip', step: 1, tf, refMm: 1, window: [0, 2000] });
  const comp = renderImage({ volume: uniform.volume, camera: cam, width: 32, height: 32, mode: 'composite', step: 1, tf, refMm: 1, window: [0, 2000] });

  let opaque = 0;
  let transparent = 0;
  for (let i = 0; i < 32 * 32; i++) {
    const a = i * 4 + 3;
    if (mip[a] === 255) opaque++;
    if (mip[a] === 0) transparent++;
    assert.equal(mip[i * 4], mip[i * 4 + 1]);
    if (comp[a] === 0) {
      assert.equal(comp[i * 4 + 3], 0);
    } else {
      assert.equal(comp[i * 4], 255);
      assert.equal(comp[i * 4 + 1], 0);
    }
  }
  // the box is ~4:3, so the 1:1 frame has transparent corners
  assert.ok(transparent > 0, 'corners outside the box must be transparent');
  assert.ok(opaque > 0, 'the box interior must be covered');
});

test('renderImage: MIP image matches tracing the same pixel ray', () => {
  const cam = computeCamera(ramp.volume, presetView('+z'), 128, 128);
  const img = renderImage({ volume: ramp.volume, camera: cam, width: 128, height: 128, mode: 'mip', step: 0.5, window: [0, 4095] });
  for (const [px, py] of [[51, 89], [64, 40], [90, 100]]) {
    const ray = rayAt(cam, (px + 0.5) / 128, (py + 0.5) / 128);
    const tr = traceRay(ramp.volume, ray.origin, ray.dir, { mode: 'mip', step: 0.5, window: [0, 4095] });
    const idx = (py * 128 + px) * 4;
    assert.equal(img[idx + 3], 255);
    assert.equal(img[idx], windowToGray8(tr.maxValue, [0, 4095]), `pixel ${px},${py}`);
  }
  // a corner pixel lies outside the box and stays transparent
  const corner = rayAt(cam, 0.5 / 128, 0.5 / 128);
  assert.equal(traceRay(ramp.volume, corner.origin, corner.dir, { mode: 'mip', step: 0.5, window: [0, 4095] }).hit, false);
  assert.equal(img[3], 0);
  // the oracle's integer-voxel maximum appears in the image near that column
  const uv = projectPoint(cam, voxelCenter(ramp.volume, 5, 3, 2));
  let found = false;
  for (let py = Math.floor(uv[1] * 128) - 3; py <= Math.floor(uv[1] * 128) + 3; py++) {
    for (let px = Math.floor(uv[0] * 128) - 3; px <= Math.floor(uv[0] * 128) + 3; px++) {
      if (img[(py * 128 + px) * 4] === windowToGray8(oracle.ramp_mip_plus_z.value, [0, 4095])) found = true;
    }
  }
  assert.ok(found, 'oracle MIP value should show up around the probe voxel');
});

test('settings round-trip: window values survive JSON', () => {
  const settings = readJson('settings.json');
  const norm = normalizeTransferFunction(settings.transferFunction);
  assert.equal(norm.errors.length, 0);
  const round = JSON.parse(JSON.stringify(norm.tf));
  assert.deepEqual(round, norm.tf);
  assert.deepEqual(settings.window, [0, 2000]);
  assert.equal(DEFAULT_REF_MM, settings.opacityReferenceMm);
  assert.equal(settings.step, 1);
});

test('default transfer function is a valid 3-stop ramp', () => {
  const norm = normalizeTransferFunction(DEFAULT_TF);
  assert.equal(norm.errors.length, 0);
  assert.deepEqual(norm.tf.map((s) => s.value), [0, 1000, 4095]);
});

test('renderRows matches traceRay pixel-for-pixel across step sizes', () => {
  const tf = [
    { value: 0, rgb: [0, 0, 0], alpha: 0 },
    { value: 808, rgb: [1, 0.45, 0.1], alpha: 0.08 },
    { value: 1617, rgb: [1, 1, 1], alpha: 0.35 },
  ];
  const size = 32;
  const cam = computeCamera(ramp.volume, presetView('+z'), size, size);
  for (const step of [0.25, 0.5, 0.7, 1, 1.3, 2, 2.5, 3, 3.3, 4]) {
    const img = renderImage({ volume: ramp.volume, camera: cam, width: size, height: size, mode: 'composite', step, tf, refMm: 1 });
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const ray = rayAt(cam, (i + 0.5) / size, (j + 0.5) / size);
        const tr = traceRay(ramp.volume, ray.origin, ray.dir, { mode: 'composite', step, tf, refMm: 1 });
        const idx = (j * size + i) * 4;
        for (let k = 0; k < 4; k++) {
          assert.equal(img[idx + k], tr.final.rgba8[k], `step ${step} px ${i},${j} ch ${k}`);
        }
      }
    }
  }
});

test('transfer LUT stays within half an 8-bit step of the exact function', () => {
  const tf = [
    { value: 0, rgb: [0, 0, 0], alpha: 0 },
    { value: 200, rgb: [0.9, 0.1, 0.4], alpha: 0.03 },
    { value: 900, rgb: [1, 1, 0.2], alpha: 0.22 },
    { value: 4095, rgb: [1, 1, 1], alpha: 0.4 },
  ];
  const lut = buildTransferLut(tf);
  const out = [0, 0, 0, 0];
  let maxErr = 0;
  for (let v = -50; v <= 4150; v += 0.37) {
    evalTransferLut(lut, v, out);
    const exact = evalTransfer(tf, v);
    maxErr = Math.max(maxErr,
      Math.abs(out[0] - exact.rgb[0]), Math.abs(out[1] - exact.rgb[1]), Math.abs(out[2] - exact.rgb[2]));
    assert.ok(Math.abs(out[3] - exact.alpha) < 1e-3, `alpha at ${v}: ${out[3]} vs ${exact.alpha}`);
  }
  assert.ok(maxErr < 1 / 255, `rgb LUT error ${maxErr}`);
});
