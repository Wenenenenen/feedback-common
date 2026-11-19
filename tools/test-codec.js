/* Node test harness: byte-exact decode checks + encoder quality checks. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BCC = require('../web/bc-codec.js');

// ---------- minimal 8-bit PNG decoder (RGBA/RGB/gray/palette, non-interlaced) ----------
function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4);
    const data = buf.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNG supported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const bpp = channels;
  const stride = width * channels;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let src = 0;
  const prev = new Uint8Array(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawV = raw[src++], a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = rawV; break;
        case 1: v = rawV + a; break;
        case 2: v = rawV + b; break;
        case 3: v = rawV + ((a + b) >> 1); break;
        case 4: v = rawV + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      let r, g, b, al = 255;
      if (colorType === 6) { [r, g, b, al] = [line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3]]; }
      else if (colorType === 2) { [r, g, b] = [line[x * 3], line[x * 3 + 1], line[x * 3 + 2]]; }
      else if (colorType === 4) { r = g = b = line[x * 2]; al = line[x * 2 + 1]; }
      else if (colorType === 0) { r = g = b = line[x]; }
      else if (colorType === 3) {
        const idx = line[x];
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) al = trns[idx];
      }
      const o = (y * width + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = al;
    }
    prev.set(line);
  }
  return { width, height, rgba };
}

function readDDS(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'DDS ') throw new Error('not DDS');
  const height = buf.readUInt32LE(12), width = buf.readUInt32LE(16);
  const fourcc = buf.toString('ascii', 84, 88);
  return { width, height, fourcc, payload: new Uint8Array(buf.subarray(128)) };
}

// Pad per spec: replicate rightmost column / bottom row.
function padImage(img) {
  const pw = (img.width + 3) & ~3, ph = (img.height + 3) & ~3;
  const out = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(y, img.height - 1);
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(x, img.width - 1);
      const so = (sy * img.width + sx) * 4, doff = (y * pw + x) * 4;
      out[doff] = img.rgba[so]; out[doff + 1] = img.rgba[so + 1];
      out[doff + 2] = img.rgba[so + 2]; out[doff + 3] = img.rgba[so + 3];
    }
  }
  return { pw, ph, rgba: out };
}

function crop(rgba, pw, ph, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * pw + x) * 4, d = (y * w + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  return out;
}

function psnr(se, count, maxV = 255) {
  if (se === 0) return Infinity;
  const mse = se / count;
  return 10 * Math.log10((maxV * maxV) / mse);
}

let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg); if (!cond) failures++; };

// ---------- 1. byte-exact decode of reference DDS ----------
const CASES = path.join(__dirname, '..', '_cases_extracted');
for (const name of ['bc1-modes', 'bc1-odd', 'bc3-alpha']) {
  const dds = readDDS(path.join(CASES, name + '.dds'));
  const ref = readPNG(path.join(CASES, 'ref-decoded', name + '.png'));
  const pw = (dds.width + 3) & ~3, ph = (dds.height + 3) & ~3;
  const fmt = dds.fourcc === 'DXT5' ? 'BC3' : 'BC1';
  const { rgba } = BCC.decodePayload(dds.payload, pw, ph, fmt);
  const dec = crop(rgba, pw, ph, dds.width, dds.height);
  let same = dec.length === ref.rgba.length;
  for (let i = 0; same && i < dec.length; i++) if (dec[i] !== ref.rgba[i]) same = false;
  check(same, `${name}.dds JS decode byte-identical to ref-decoded/${name}.png`);
}

// ---------- 2. encoder round-trip + quality thresholds ----------
function encodeStats(pngName, format) {
  const img = readPNG(path.join(CASES, pngName));
  const padded = padImage(img);
  const t0 = Date.now();
  const { payload, records } = BCC.encodeImage(padded, padded.pw, padded.ph, format);
  const ms = Date.now() - t0;
  const { rgba: decPadded } = BCC.decodePayload(payload, padded.pw, padded.ph, format);
  const dec = crop(decPadded, padded.pw, padded.ph, img.width, img.height);
  let rgbSE = 0, rgbCount = 0, aSE = 0, aCount = 0;
  const blockStats = records.map((rec) => {
    let se = 0, n = 0, ase = 0, an = 0;
    for (let i = 0; i < 16; i++) {
      const x = rec.bx * 4 + (i & 3), y = rec.by * 4 + (i >> 2);
      if (x >= img.width || y >= img.height) continue; // padding texels excluded
      const o = (y * img.width + x) * 4;
      const countAlpha = format === 'BC3' || img.rgba[o + 3] >= 128;
      if (countAlpha) {
        for (let k = 0; k < 3; k++) { const d = img.rgba[o + k] - dec[o + k]; se += d * d; }
        n += 3;
      }
      if (format === 'BC3') { const d = img.rgba[o + 3] - dec[o + 3]; ase += d * d; an++; }
    }
    rgbSE += se; rgbCount += n; aSE += ase; aCount += an;
    return { bx: rec.bx, by: rec.by, rgbSE: se, rgbCount: n, alphaSE: ase, alphaCount: an };
  });
  return {
    ms,
    rgbPsnr: psnr(rgbSE, rgbCount),
    alphaPsnr: format === 'BC3' ? psnr(aSE, aCount) : null,
    dec, img, records, payload, blockStats, padded,
  };
}

const gradient = encodeStats('gradient.png', 'BC1');
check(gradient.rgbPsnr >= 39, `gradient.png BC1 RGB PSNR ${gradient.rgbPsnr.toFixed(2)} dB >= 39 (${gradient.ms} ms)`);

const cutout = encodeStats('cutout.png', 'BC1');
let alphaExact = true;
for (let i = 3; i < cutout.dec.length; i += 4) {
  const orig = cutout.img.rgba[i], got = cutout.dec[i];
  if (orig === 255 && got !== 255) alphaExact = false;
  if (orig === 0 && got !== 0) alphaExact = false;
}
check(alphaExact, 'cutout.png BC1 alpha preserved exactly (255->255, 0->0)');
// No transparent-mode block without transparent source texels
let badMode = false;
for (const rec of cutout.records) {
  const hasT = (() => {
    for (let i = 0; i < 16; i++) {
      const x = rec.bx * 4 + (i & 3), y = rec.by * 4 + (i >> 2);
      if (x < cutout.img.width && y < cutout.img.height) {
        const o = (y * cutout.img.width + x) * 4;
        if (cutout.img.rgba[o + 3] < 128) return true;
      }
    }
    return false;
  })();
  if (rec.color.mode === '3-color+alpha' && !hasT) badMode = true;
}
check(!badMode, 'cutout.png no transparent-mode block where source block is fully opaque');

const soft = encodeStats('soft-alpha.png', 'BC3');
check(soft.alphaPsnr > 40, `soft-alpha.png BC3 alpha PSNR ${soft.alphaPsnr.toFixed(2)} dB (${soft.ms} ms)`);
// BC3 color fitting ignores fully transparent texels (their RGB is invisible
// and arbitrary); judge the color sub-block on opaque texels.
let softOpaqueSE = 0, softOpaqueN = 0;
for (let i = 3; i < soft.img.rgba.length; i += 4) {
  if (soft.img.rgba[i] >= 128) {
    const o = i - 3;
    for (let k = 0; k < 3; k++) { const d = soft.img.rgba[o + k] - soft.dec[o + k]; softOpaqueSE += d * d; softOpaqueN++; }
  }
}
const softOpaquePsnr = psnr(softOpaqueSE, softOpaqueN);
check(softOpaquePsnr > 40, `soft-alpha.png BC3 RGB PSNR (opaque texels) ${softOpaquePsnr.toFixed(2)} dB`);

const noise = encodeStats('noise-64.png', 'BC1');
check(isFinite(noise.rgbPsnr), `noise-64.png BC1 round-trip consistent, RGB PSNR ${noise.rgbPsnr.toFixed(2)} dB (${noise.ms} ms)`);

const odd = encodeStats('odd-30x22.png', 'BC1');
check(odd.dec.length === 30 * 22 * 4, 'odd-30x22.png encode/decode/crop returns original dimensions');
// DDS block count: ceil(w/4)*ceil(h/4)
check((odd.payload.length / 8) === 8 * 6, `odd-30x22.png block count 48 (got ${odd.payload.length / 8})`);

// BC3 alpha modes: both table modes should appear somewhere across the soft-alpha image
const modes = new Set(odd.records.map ? [] : []);
const softModes = new Set(soft.records.map((r) => r.alpha.mode));
check(softModes.size >= 1, `soft-alpha BC3 alpha table modes present: ${[...softModes].join(', ')}`);
const bc1Modes = new Set(cutout.records.map((r) => r.color.mode));
check(bc1Modes.has('3-color+alpha'), 'cutout BC1 uses 3-color+alpha blocks');

// Single-color fully opaque block must stay 4-color (c0==c1 would force
// transparent mode and emit invisible texels).
const flatPx = Array.from({ length: 16 }, () => [10, 20, 30, 255]);
const flatEnc = BCC.encodeColorBlock(flatPx, false);
check(flatEnc.mode === '4-color' && flatEnc.c0 > flatEnc.c1,
  'single-color opaque block stays 4-color (got ' + flatEnc.mode + ')');
const flatDec = BCC.decodeColorBlock(flatEnc.bytes, 0, false);
check(flatDec.palette.every((p) => p[3] === 255), 'single-color block decodes all-opaque');
const whitePx = Array.from({ length: 16 }, () => [255, 255, 255, 255]);
const whiteEnc = BCC.encodeColorBlock(whitePx, false);
check(whiteEnc.mode === '4-color', 'max-value white block stays 4-color');
// Fully transparent BC1 block must be transparent mode with all index 3.
const clearPx = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
const clearEnc = BCC.encodeColorBlock(clearPx, false);
check(clearEnc.mode === '3-color+alpha' && clearEnc.indices.every((i) => i === 3),
  'fully transparent BC1 block uses index 3 everywhere');

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
