// End-to-end export verification in Node: import the sample ZIP, apply the
// preset, run the exact browser pipeline (src/*), write the export ZIP back,
// and assert every contract the UI relies on.
//   CASES_DIR=... node tools/e2e-verify.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importSequenceZip } from '../src/sequence.js';
import { exportZip } from '../src/export.js';
import { readZip } from '../src/zip.js';
import { decodePNG } from '../src/png.js';

const C = process.env.CASES_DIR;
if (!C) { console.error('set CASES_DIR'); process.exit(1); }

const preset = JSON.parse(readFileSync(join(C, 'preset.json'), 'utf8'));
const toByte = l => Math.round((l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
const params = {
  keyColor: preset.green_linear_rgb.map(toByte),
  inner: 0.01,
  outer: 0.63,
  softness: 0,
  despillStrength: 0.5,
  protectPolygons: preset.protect_polygons,
  removePolygons: preset.remove_polygons,
};
console.log('key color from preset:', params.keyColor);

const imported = await importSequenceZip(readFileSync(join(C, 'sequence.zip')));
const bg = await decodePNG(new Uint8Array(readFileSync(join(C, 'background.png'))));
const zip = await exportZip(imported.frames, imported.width, imported.height, params, { rgb: bg.data });
writeFileSync(join(C, 'e2e-export.zip'), zip);

const entries = await readZip(zip);
const byDir = { rgba: [], matte: [], composite: [] };
for (const e of entries) {
  const [dir, name] = e.name.split('/');
  byDir[dir].push({ name, bytes: e.bytes });
}
for (const d of Object.keys(byDir)) byDir[d].sort((a, b) => +a.name.match(/\d+/) - +b.name.match(/\d+/));

let failures = 0;
const fail = msg => { failures++; console.error('FAIL:', msg); };

if (entries.length !== imported.frames.length * 3) fail('entry count ' + entries.length);
for (const d of ['rgba', 'matte', 'composite']) {
  if (byDir[d].length !== imported.frames.length) fail(d + ' frame count');
}

// reference comparison + structural rules
let worstMAE = 0;
for (const frame of imported.frames) {
  const ref = await decodePNG(new Uint8Array(readFileSync(join(C, 'ref', frame.name))));
  const matteEntry = byDir.matte.find(e => e.name === frame.name);
  const rgbaEntry = byDir.rgba.find(e => e.name === frame.name);
  const compEntry = byDir.composite.find(e => e.name === frame.name);
  if (!matteEntry || !rgbaEntry || !compEntry) { fail('missing pair for ' + frame.name); continue; }

  const mattePng = await decodePNG(matteEntry.bytes);
  const rgbaPng = await decodePNG(rgbaEntry.bytes);
  const compPng = await decodePNG(compEntry.bytes);

  if (mattePng.channels !== 1) fail(frame.name + ' matte not grayscale');
  if (rgbaPng.channels !== 4) fail(frame.name + ' rgba not RGBA');
  if (compPng.channels !== 3) fail(frame.name + ' composite not RGB');
  for (const img of [mattePng, rgbaPng, compPng]) {
    if (img.width !== imported.width || img.height !== imported.height) fail(frame.name + ' size drift');
  }

  let mae = 0;
  for (let i = 0; i < ref.data.length; i++) mae += Math.abs(mattePng.data[i] - ref.data[i]);
  mae /= ref.data.length * 255;
  worstMAE = Math.max(worstMAE, mae);
  if (mae > 0.04) fail(`${frame.name} MAE ${mae.toFixed(4)} > 0.04`);

  // transparent pixels must be RGB-zero
  for (let p = 0, o = 0; p < rgbaPng.width * rgbaPng.height; p++, o += 4) {
    if (rgbaPng.data[o + 3] === 0 && (rgbaPng.data[o] || rgbaPng.data[o + 1] || rgbaPng.data[o + 2])) {
      fail(frame.name + ' transparent pixel has non-zero RGB at ' + p); break;
    }
  }
  // protected region: opaque + original RGB
  for (let y = 32; y < 46; y++) for (let x = 112; x < 130; x++) {
    const p = y * imported.width + x;
    if (rgbaPng.data[p * 4 + 3] !== 255) { fail(frame.name + ' protect alpha at ' + x + ',' + y); break; }
    const si = p * 3, di = p * 4;
    if (rgbaPng.data[di] !== frame.rgb[si] || rgbaPng.data[di + 1] !== frame.rgb[si + 1] || rgbaPng.data[di + 2] !== frame.rgb[si + 2]) {
      fail(frame.name + ' protect RGB changed at ' + x + ',' + y); break;
    }
  }
  // removed region: alpha zero
  for (let y = 46; y < 78; y++) for (let x = 130; x < 148; x++) {
    if (rgbaPng.data[(y * imported.width + x) * 4 + 3] !== 0) { fail(frame.name + ' remove alpha'); break; }
  }
}

// invalid-size must be rejected
let rejected = false;
try {
  await importSequenceZip(readFileSync(join(C, 'invalid-size.zip')));
} catch { rejected = true; }
if (!rejected) fail('invalid-size.zip was not rejected');

console.log(`frames=${imported.frames.length} worstMatteMAE=${worstMAE.toFixed(5)} (limit 0.04)`);
console.log(failures ? `E2E FAILED (${failures})` : 'E2E OK: all export contracts verified');
process.exit(failures ? 1 : 0);
