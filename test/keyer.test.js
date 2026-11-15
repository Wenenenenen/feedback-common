// Node verification harness. Run: node --test test/
// The sample data lives outside the repo working tree; paths come from argv
// via env CASES_DIR so the tests never hard-code the untrusted location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPNG } from './png-node.mjs';
import { computeMatte, rasterizePolygons, despill, compositeLinear, buildRgba, buildMatteBytes } from '../src/keyer.js';
import { processFrame } from '../src/export.js';
import { encodePNG, decodePNG } from '../src/png.js';
import { readZip, writeZip } from '../src/zip.js';
import { importSequenceZip, frameNumberFromName } from '../src/sequence.js';

const CASES = process.env.CASES_DIR;
const skip = CASES ? false : { skip: 'CASES_DIR not set' };

const PARAMS = {
  keyColor: [33, 211, 33],
  inner: 0.01,
  outer: 0.63,
  softness: 0,
  despillStrength: 0.5,
  protectPolygons: [[[112, 32], [140, 32], [140, 62], [112, 62]]],
  removePolygons: [[[130, 46], [148, 46], [148, 78], [130, 78]]],
};

function matteMAE(matte, refGray) {
  let s = 0;
  for (let i = 0; i < matte.length; i++) s += Math.abs(matte[i] * 255 - refGray[i]);
  return s / matte.length / 255;
}

test('frame number extraction handles unpadded names', () => {
  assert.equal(frameNumberFromName('frame_1.png'), 1);
  assert.equal(frameNumberFromName('frame_10.png'), 10);
  assert.equal(frameNumberFromName('dir/shot.0042.png'), 42);
  assert.equal(frameNumberFromName('no-number.png'), null);
});

test('polygon pixel-center rasterization covers exact integer rectangles', () => {
  const w = 160, h = 120;
  const m = rasterizePolygons(w, h, PARAMS.protectPolygons);
  assert.equal(m.reduce((a, b) => a + b, 0), 28 * 30);
  const r = rasterizePolygons(w, h, PARAMS.removePolygons);
  assert.equal(r.reduce((a, b) => a + b, 0), 18 * 32);
  // overlap: remove must win after both are applied
  const cal = readPNG(join(CASES ?? '.', 'cal/frame_1.png'));
  if (!CASES) return;
  const matte = computeMatte(cal.data, w, h, PARAMS);
  for (let y = 46; y < 78; y++) for (let x = 130; x < 148; x++) {
    assert.equal(matte[y * w + x], 0, `remove pixel ${x},${y} not zero`);
  }
  for (let y = 32; y < 46; y++) for (let x = 112; x < 130; x++) {
    assert.equal(matte[y * w + x], 1, `protect-only pixel ${x},${y} not one`);
  }
});

test('calibration matte MAE <= 0.04 with preset polygons', skip, () => {
  const cal = readPNG(join(CASES, 'cal/frame_1.png'));
  const ref = readPNG(join(CASES, 'calibration-alpha.png'));
  const matte = computeMatte(cal.data, cal.width, cal.height, PARAMS);
  const mae = matteMAE(matte, ref.data);
  assert.ok(mae <= 0.04, `MAE ${mae} exceeds 0.04`);
  assert.ok(mae < 0.01, `MAE ${mae} should be comfortably inside tolerance`);
});

test('all 24 sequence frames match reference alpha within tolerance', skip, () => {
  const seqDir = join(CASES, 'seq');
  const refDir = join(CASES, 'ref');
  const names = readdirSync(seqDir).filter(f => f.endsWith('.png'))
    .sort((a, b) => frameNumberFromName(a) - frameNumberFromName(b));
  let worst = 0;
  for (const name of names) {
    const frame = readPNG(join(seqDir, name));
    const ref = readPNG(join(refDir, name));
    const matte = computeMatte(frame.data, frame.width, frame.height, PARAMS);
    const mae = matteMAE(matte, ref.data);
    worst = Math.max(worst, mae);
    assert.ok(mae <= 0.04, `${name} MAE ${mae}`);
  }
  assert.ok(worst > 0);
});

test('protected region keeps original RGB and full opacity; remove is zero', skip, () => {
  const cal = readPNG(join(CASES, 'cal/frame_1.png'));
  const out = processFrame(cal.data, cal.width, cal.height, PARAMS, { rgb: cal.data });
  const w = cal.width;
  for (let y = 32; y < 46; y++) for (let x = 112; x < 130; x++) {
    const p = y * w + x, i = p * 3, o = p * 4;
    assert.equal(out.rgba[o + 3], 255);
    assert.equal(out.rgba[o], cal.data[i]);
    assert.equal(out.rgba[o + 1], cal.data[i + 1]);
    assert.equal(out.rgba[o + 2], cal.data[i + 2]);
  }
  for (let y = 46; y < 78; y++) for (let x = 130; x < 148; x++) {
    const o = (y * w + x) * 4;
    assert.equal(out.rgba[o + 3], 0);
    assert.equal(out.rgba[o], 0);
    assert.equal(out.rgba[o + 1], 0);
    assert.equal(out.rgba[o + 2], 0);
  }
});

test('fully transparent pixels carry zero RGB and matte is 8-bit gray', () => {
  const w = 4, h = 2;
  const rgb = new Uint8Array(w * h * 3).fill(100);
  const matte = new Float32Array(w * h);
  matte[0] = 0; matte[1] = 0.5; matte[2] = 1;
  const rgba = buildRgba(rgb, matte, w, h);
  assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 0]);
  const mb = buildMatteBytes(matte);
  assert.equal(mb[1], Math.round(0.5 * 255));
  assert.equal(mb[2], 255);
});

test('PNG round-trip for RGB, gray and RGBA', async () => {
  const w = 8, h = 4;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 255;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (i * 13) & 255;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 17) & 255;
  for (const [ch, data] of [[3, rgb], [1, gray], [4, rgba]]) {
    const png = await encodePNG(w, h, ch, data);
    const back = await decodePNG(png);
    assert.equal(back.width, w);
    assert.equal(back.channels, ch);
    assert.deepEqual(back.data, data);
  }
});

test('ZIP round-trip preserves names and bytes', async () => {
  const entries = [
    { name: 'rgba/frame_1.png', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'matte/frame_1.png', bytes: new Uint8Array(200).fill(7) },
  ];
  const zip = await writeZip(entries);
  const back = await readZip(zip);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0].bytes, entries[0].bytes);
  assert.deepEqual(back[1].bytes, entries[1].bytes);
});

test('import rejects mismatched-size sequence and enforces limits', skip, async () => {
  const bad = readFileSync(join(CASES, 'invalid-size.zip'));
  await assert.rejects(() => importSequenceZip(bad), /不一致/);
  const good = readFileSync(join(CASES, 'sequence.zip'));
  const imported = await importSequenceZip(good);
  assert.equal(imported.frames.length, 24);
  assert.equal(imported.width, 160);
  assert.equal(imported.frames[0].number, 1);
  assert.equal(imported.frames[9].number, 10);
  assert.deepEqual(imported.frames.map(f => f.number), [...Array(24)].map((_, i) => i + 1));
});

test('import enforces 120-frame cap, RGB-only rule and numeric names', async () => {
  const { writeZip } = await import('../src/zip.js');
  const { encodePNG } = await import('../src/png.js');
  const rgb = new Uint8Array(4 * 4 * 3).fill(40);
  const gray = new Uint8Array(4 * 4).fill(128);
  const rgbPng = await encodePNG(4, 4, 3, rgb);
  const grayPng = await encodePNG(4, 4, 1, gray);

  // 121 frames -> rejected
  const tooMany = [];
  for (let i = 1; i <= 121; i++) tooMany.push({ name: `f_${i}.png`, bytes: rgbPng });
  await assert.rejects(async () => importSequenceZip(await writeZip(tooMany)), /120/);

  // exactly 120 frames -> accepted
  const ok = [];
  for (let i = 1; i <= 120; i++) ok.push({ name: `f_${i}.png`, bytes: rgbPng });
  const imported = await importSequenceZip(await writeZip(ok));
  assert.equal(imported.frames.length, 120);

  // grayscale frame -> rejected as non-RGB
  await assert.rejects(
    async () => importSequenceZip(await writeZip([
      { name: 'f_1.png', bytes: rgbPng },
      { name: 'f_2.png', bytes: grayPng },
    ])),
    /RGB/
  );

  // no numeric frame name -> rejected
  await assert.rejects(
    async () => importSequenceZip(await writeZip([{ name: 'frame.png', bytes: rgbPng }])),
    /帧号/
  );

  // duplicate frame numbers -> rejected
  await assert.rejects(
    async () => importSequenceZip(await writeZip([
      { name: 'f_1.png', bytes: rgbPng },
      { name: 'g_1.png', bytes: rgbPng },
    ])),
    /重复/
  );
});

test('export ZIP contains three paired directories and valid PNGs', skip, async () => {
  const good = readFileSync(join(CASES, 'sequence.zip'));
  const imported = await importSequenceZip(good);
  const bg = readPNG(join(CASES, 'background.png'));
  const { exportZip } = await import('../src/export.js');
  const out = await exportZip(imported.frames, imported.width, imported.height, PARAMS, { rgb: bg.data });
  const entries = await readZip(out);
  const dirs = new Set(entries.map(e => e.name.split('/')[0]));
  assert.deepEqual([...dirs].sort(), ['composite', 'matte', 'rgba']);
  assert.equal(entries.length, 24 * 3);
  for (const e of entries) {
    const img = await decodePNG(e.bytes);
    assert.equal(img.width, 160);
    assert.equal(img.height, 120);
    if (e.name.startsWith('rgba/')) assert.equal(img.channels, 4);
    if (e.name.startsWith('matte/')) assert.equal(img.channels, 1);
    if (e.name.startsWith('composite/')) assert.equal(img.channels, 3);
  }
});
