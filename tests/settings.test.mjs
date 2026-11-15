// settings.test.mjs — export/import round-trip and validation.
// Run with: node --test tests/settings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildVolume, validateMeta, presetView, computeCamera, renderImage, orbitView, normalizeTransferFunction, DEFAULT_TF } from '../app/js/core.js';
import { makeSettings, parseSettings, volumeFingerprint, SETTINGS_SCHEMA } from '../app/js/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = join(here, '.cases');
const meta = JSON.parse(readFileSync(join(cases, 'ramp-u16le.json'), 'utf8'));
const raw = new Uint8Array(readFileSync(join(cases, 'ramp-u16le.raw')));
const volume = buildVolume(raw, validateMeta(meta, raw.byteLength).meta);

const liveState = () => ({
  volume,
  view: presetView('+z'),
  mode: 'composite',
  step: 1,
  tf: DEFAULT_TF.map((s) => ({ value: s.value, rgb: s.rgb.slice(), alpha: s.alpha })),
  window: [0, 2000],
  imageSize: 128,
  refMm: 1,
  sourceName: 'ramp-u16le.json',
});

test('settings round-trip restores the exact render', () => {
  const st = liveState();
  const exported = makeSettings(st);
  assert.equal(exported.schema, SETTINGS_SCHEMA);
  assert.equal(exported.units, 'mm');
  const parsed = parseSettings(JSON.parse(JSON.stringify(exported)), volume);
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  const s = parsed.settings;

  const renderWith = (cfg) => {
    const cam = computeCamera(volume, cfg.view, cfg.imageSize[0], cfg.imageSize[1]);
    return renderImage({
      volume, camera: cam, width: cfg.imageSize[0], height: cfg.imageSize[1],
      mode: cfg.mode, step: cfg.step, tf: normalizeTransferFunction(cfg.tf).tf,
      refMm: cfg.refMm, window: cfg.window,
    });
  };
  const a = renderWith({ view: st.view, mode: st.mode, step: st.step, tf: st.tf, imageSize: [128, 128], refMm: st.refMm, window: st.window });
  const b = renderWith({ ...s, imageSize: s.imageSize });
  assert.deepEqual(Array.from(b), Array.from(a), 'reproduced frame must be byte-identical');
});

test('exported settings include camera, step, transfer function and fingerprint', () => {
  const str = JSON.stringify(makeSettings(liveState()), null, 2);
  assert.match(str, /"dir": \[/);
  assert.match(str, /"step": 1/);
  assert.match(str, /"transferFunction": \[/);
  assert.match(str, /"opacityReferenceMm": 1/);
  assert.match(str, /"valuesFnv1a": "/);
  assert.match(str, /"alphaPerMm": "1 - \(1 - alpha\)\^/);
});

test('an oblique camera survives the round-trip', () => {
  const st = liveState();
  st.view = orbitView(st.view, 33, -21);
  const parsed = parseSettings(JSON.parse(JSON.stringify(makeSettings(st))), volume);
  assert.equal(parsed.ok, true);
  const v = parsed.settings.view;
  const d = st.view.dir;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(v.dir[i] - d[i]) < 1e-5, `dir[${i}]`);
  // up must be orthonormal to dir
  const dot = v.dir[0] * v.up[0] + v.dir[1] * v.up[1] + v.dir[2] * v.up[2];
  assert.ok(Math.abs(dot) < 1e-9);
});

test('imported settings validate every field with precise messages', () => {
  const good = makeSettings(liveState());
  const bad = (patch) => {
    const copy = JSON.parse(JSON.stringify(good));
    Object.assign(copy, patch);
    return parseSettings(copy, volume);
  };
  const step = bad({ step: 9 });
  assert.equal(step.ok, false);
  assert.match(step.errors[0], /0.25..4 mm/);

  const mode = bad({ mode: 'maximum' });
  assert.match(mode.errors[0], /mode/);

  const win = bad({ window: [5, 5] });
  assert.match(win.errors[0], /window/);

  const size = bad({ imageSize: [8, 512] });
  assert.match(size.errors[0], /imageSize/);

  const tf = bad({ transferFunction: [{ value: 'x', rgb: [0, 0, 0], alpha: 0 }] });
  assert.match(tf.errors[0], /有限数值/);

  const ref = bad({ opacityReferenceMm: 0 });
  assert.match(ref.errors[0], /opacityReferenceMm/);
});

test('dimension mismatch is a hard error, fingerprint mismatch a warning', () => {
  const good = makeSettings(liveState());
  const other = JSON.parse(JSON.stringify(good));
  other.data.fingerprint.dimensions = [32, 24, 16];
  const res = parseSettings(other, volume);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /尺寸/);

  const fp = JSON.parse(JSON.stringify(good));
  fp.data.fingerprint.valuesFnv1a = 'deadbeef';
  const res2 = parseSettings(fp, volume);
  assert.equal(res2.ok, true, 'a different fingerprint is still loadable');
  assert.match(res2.warnings.join(' '), /指纹/);
});

test('up vector parallel to dir is rejected; a skewed up is repaired', () => {
  const good = makeSettings(liveState());
  const parallel = JSON.parse(JSON.stringify(good));
  parallel.view.up = parallel.view.dir.slice();
  const res = parseSettings(parallel, volume);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /平行/);

  const skewed = JSON.parse(JSON.stringify(good));
  skewed.view.up = [0.2, 1, 0.1];
  const res2 = parseSettings(skewed, volume);
  assert.equal(res2.ok, true);
  assert.match(res2.warnings.join(' '), /正交化/);
  const dot = res2.settings.view.up[0] * res2.settings.view.dir[0]
    + res2.settings.view.up[1] * res2.settings.view.dir[1]
    + res2.settings.view.up[2] * res2.settings.view.dir[2];
  assert.ok(Math.abs(dot) < 1e-12);
});

test('fingerprint is deterministic for the same data', () => {
  const a = volumeFingerprint(volume);
  const b = volumeFingerprint(volume);
  assert.deepEqual(a, b);
  assert.equal(a.voxelCount, 1536);
  assert.match(a.valuesFnv1a, /^[0-9a-f]{8}$/);
});

test('a non-object settings file is rejected', () => {
  assert.match(parseSettings(null, volume).errors[0], /JSON 对象/);
  assert.match(parseSettings([], volume).errors[0], /JSON 对象/);
  assert.match(parseSettings('x', volume).errors[0], /JSON 对象/);
});

test('the sample settings.json shorthand imports cleanly', () => {
  const sample = JSON.parse(readFileSync(join(cases, 'settings.json'), 'utf8'));
  const res = parseSettings(sample, volume);
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.settings.mode, 'composite');
  assert.equal(res.settings.view.preset, '+z');
  assert.deepEqual(res.settings.view.dir, [0, 0, 1]);
  assert.equal(res.settings.step, 1);
  assert.deepEqual(res.settings.imageSize, [256, 256]);
  assert.deepEqual(res.settings.window, [0, 2000]);
  assert.equal(res.settings.opacityReferenceMm, 1);
  assert.equal(res.settings.transferFunction.length, 3);
});

test('a bare numeric window is read as [0, v]', () => {
  const good = makeSettings(liveState());
  good.window = 2000;
  const res = parseSettings(good, volume);
  assert.equal(res.ok, true);
  assert.deepEqual(res.settings.window, [0, 2000]);
});

test('an unknown string view names the presets it accepts', () => {
  const good = makeSettings(liveState());
  good.view = '+q';
  const res = parseSettings(good, volume);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /\+x/);
});
