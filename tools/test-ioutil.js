/* Tests for DDS serialization, padding/crop, stats and JSON export shape. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BCC = require('../web/bc-codec.js');

// Minimal require shim: bc-ioutil references browser globals only inside
// functions, so requiring it under Node is safe for the pure logic.
globalThis.Response = globalThis.Response || class {};
globalThis.DecompressionStream = globalThis.DecompressionStream || class {};
globalThis.Blob = globalThis.Blob || class {};
require('../web/bc-inflate.js');
const BCUIO = require('../web/bc-ioutil.js');

let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg); if (!cond) failures++; };

// ---- DDS header byte layout vs the sample DDS files ----
for (const [name, fmt] of [['bc1-modes', 'BC1'], ['bc3-alpha', 'BC3'], ['bc1-odd', 'BC1']]) {
  const ref = fs.readFileSync(path.join(__dirname, '..', '_cases_extracted', name + '.dds'));
  const width = ref.readUInt32LE(16), height = ref.readUInt32LE(12);
  const payload = new Uint8Array(ref.subarray(128));
  const built = BCUIO.buildDDS(payload, width, height, fmt);
  let same = built.length === ref.length;
  for (let i = 0; same && i < 128; i++) if (built[i] !== ref[i]) same = false;
  check(same, `${name}.dds regenerated header byte-identical (${fmt})`);
  // payload preserved
  let payloadSame = built.length === ref.length;
  for (let i = 128; payloadSame && i < ref.length; i++) if (built[i] !== ref[i]) payloadSame = false;
  check(payloadSame, `${name}.dds payload preserved`);
}

// ---- DDS parse roundtrip ----
const parsed = BCUIO.parseDDS(fs.readFileSync(path.join(__dirname, '..', '_cases_extracted', 'bc3-alpha.dds')));
check(parsed.format === 'BC3' && parsed.width === 64 && parsed.height === 64, 'parseDDS reads BC3 metadata');

// ---- padding: replicate right column / bottom row ----
const w = 5, h = 3;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const o = (y * w + x) * 4;
  rgba[o] = x * 10; rgba[o + 1] = y * 10; rgba[o + 2] = 1; rgba[o + 3] = 255;
}
const padded = BCUIO.padImage({ width: w, height: h, rgba });
check(padded.pw === 8 && padded.ph === 4, `pads 5x3 -> 8x4 (got ${padded.pw}x${padded.ph})`);
// rightmost replicated column: padded pixel (6,0) equals source (4,0)
const s40 = (0 * w + 4) * 4, p60 = (0 * 8 + 6) * 4;
check(padded.rgba[p60] === rgba[s40] && padded.rgba[p60 + 1] === rgba[s40 + 1], 'right edge column replicated');
// bottom replicated row: (0,3) equals source (0,2)
const s02 = (2 * w + 0) * 4, p03 = (3 * 8 + 0) * 4;
check(padded.rgba[p03] === rgba[s02] && padded.rgba[p03 + 1] === rgba[s02 + 1], 'bottom edge row replicated');
// crop back
const cropped = BCUIO.cropToOriginal(padded.rgba, 8, 4, w, h);
let cropSame = true;
for (let i = 0; i < rgba.length; i++) if (cropped[i] !== rgba[i]) cropSame = false;
check(cropSame, 'cropToOriginal restores source pixels exactly');

// ---- validation ----
let threw = false;
try { BCUIO.validateImage({ width: 2000, height: 4, rgba: new Uint8Array(0) }); } catch (e) { threw = true; }
check(threw, 'rejects image wider than 1024');
threw = false;
try { BCUIO.validateImage({ width: 4, height: 4, rgba: new Uint8Array(64) }); } catch (e) { threw = true; }
check(!threw, 'accepts 4x4 image');

// ---- stats correctness on a synthetic constant block ----
const N = 4;
const src = { width: N, height: N, rgba: new Uint8ClampedArray(N * N * 4) };
for (let i = 0; i < N * N; i++) { src.rgba[i * 4] = 100; src.rgba[i * 4 + 1] = 150; src.rgba[i * 4 + 2] = 200; src.rgba[i * 4 + 3] = 255; }
const enc = BCC.encodeImage(src, N, N, 'BC1');
const dec = BCC.decodePayload(enc.payload, N, N, 'BC1').rgba;
const stats = BCUIO.computeStats(src, dec, N, N, 'BC1', { bw: 1, bh: 1 });
check(stats.rgbPsnr !== null && stats.perBlock.length === 1, 'stats produce one block record');
check(typeof stats.rgbPsnr === 'number' && stats.rgbPsnr > 20, `constant block PSNR high (${stats.rgbPsnr?.toFixed(1)} dB)`);

// ---- JSON export shape ----
const json = BCUIO.buildExportJSON({
  fileName: 'x.png', format: 'BC1', src, width: N, height: N,
  paddedW: N, paddedH: N, stats, records: enc.records, bw: 1, bh: 1,
});
check(json.blockCount === 1 && json.blocks[0].color.mode && Array.isArray(json.blocks[0].color.indices), 'JSON export has per-block color record');
check(json.wholeImage.rgbPsnr !== undefined && json.padding === 'none', 'JSON whole-image stats and padding flag');
const roundtrip = JSON.parse(JSON.stringify(json));
check(roundtrip.blocks[0].color.indices.length === 16, 'JSON serializes cleanly');

console.log(failures === 0 ? '\nALL I/O TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
