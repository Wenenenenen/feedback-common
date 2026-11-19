/* Quantify black-fringe / alpha-correctness on the cutout fixture. */
const fs = require('fs');
const path = require('path');
const BCC = require('../web/bc-codec.js');
const BINF = require('../web/bc-inflate.js');

function readPNG(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12); }
    else if (type === 'IDAT') idat.push(new Uint8Array(buf.subarray(pos + 8, pos + 8 + len)));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  let tot = 0; for (const c of idat) tot += c.length;
  const merged = new Uint8Array(tot);
  let o = 0; for (const c of idat) { merged.set(c, o); o += c.length; }
  const raw = BINF.inflateZlib(merged);
  const ch = 4, stride = w * ch;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let src = 0;
  const prev = new Uint8Array(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[src++];
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rv = raw[src++], a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v;
      if (f === 0) v = rv; else if (f === 1) v = rv + a; else if (f === 2) v = rv + b;
      else if (f === 3) v = rv + ((a + b) >> 1); else v = rv + paeth(a, b, c);
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const oo = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) rgba[oo + k] = line[x * 4 + k];
    }
    prev.set(line);
  }
  return { width: w, height: h, rgba };
}

const img = readPNG(path.join(__dirname, '..', '_cases_extracted', 'cutout.png'));
const { payload } = BCC.encodeImage(img, img.width, img.height, 'BC1');
const { rgba: dec } = BCC.decodePayload(payload, img.width, img.height, 'BC1');

let fringeOpaque = 0, fringeBad = 0;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const o = (y * img.width + x) * 4;
    if (img.rgba[o + 3] !== 255) continue;
    let edge = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
      if (img.rgba[(ny * img.width + nx) * 4 + 3] < 128) edge = true;
    }
    if (edge) { fringeOpaque++; if (dec[o + 3] !== 255) fringeBad++; }
  }
}
console.log('opaque texels on a transparency edge:', fringeOpaque);
console.log('those wrongly decoded non-opaque (visible fringe):', fringeBad);

let transWrong = 0;
for (let i = 3; i < dec.length; i += 4) {
  if (img.rgba[i] === 0 && dec[i] !== 0) transWrong++;
  if (img.rgba[i] === 255 && dec[i] !== 255) transWrong++;
}
console.log('texels with a decoded alpha differing from the binary source alpha:', transWrong);
process.exit(fringeBad === 0 && transWrong === 0 ? 0 : 1);
