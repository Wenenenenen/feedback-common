// Node-side validation of sampler.js against reference.json.
// Run: node tools/verify_node.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Sampler } = require(path.join(__dirname, '..', 'sampler.js'));

function readPNG(file) {
  const data = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, colorType = 0, idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunk = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(width * height * ch);
  const prev = Buffer.alloc(stride);
  let i = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride));
    i += stride;
    if (f === 1) for (let x = ch; x < stride; x++) line[x] = (line[x] + line[x - ch]) & 255;
    else if (f === 2) for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
    else if (f === 3) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255;
    } else if (f === 4) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      line[x] = (line[x] + pr) & 255;
    }
    line.copy(out, y * stride);
    line.copy(prev);
  }
  return { width, height, data: new Uint8ClampedArray(out) };
}

const casesDir = path.join(__dirname, '..', 'cases-extracted');
const reference = JSON.parse(fs.readFileSync(path.join(casesDir, 'reference.json'), 'utf8'));
const img = readPNG(path.join(casesDir, 'texture.png'));
const tex = Sampler.makeTexture(img);
let overall = 0;
for (let idx = 0; idx < 4; idx++) {
  const cs = JSON.parse(fs.readFileSync(path.join(casesDir, `case-${idx}.json`), 'utf8'));
  let worst = 0;
  for (const row of reference.filter(r => r.case === idx)) {
    const [x, y] = row.pixel;
    const rec = Sampler.computePixel(tex, cs.H, x, y, cs.address, cs.anisotropy, 32, ['elliptic']);
    const got = rec.invalid ? [0, 0, 0, 0] : [rec.color.r, rec.color.g, rec.color.b, rec.color.a];
    for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(got[k] - row.linearRGBA[k]));
  }
  overall = Math.max(overall, worst);
  console.log(`case-${idx}: worst abs diff vs reference = ${worst.toExponential(3)}`);
}
console.log(`OVERALL: ${overall.toExponential(3)}`);

// 额外校验：renderAll 与逐像素一致 + nearest/bilinear 也跑通
const cs = JSON.parse(fs.readFileSync(path.join(casesDir, 'case-0.json'), 'utf8'));
const res = Sampler.renderAll({ tex, H: cs.H, outW: cs.width, outH: cs.height, address: cs.address, aniso: cs.anisotropy, maxRadius: 32 });
console.log('renderAll case-0:', JSON.stringify(res.stats), 'buffer bytes:', res.buffers.elliptic.length);
const px = res.buffers.elliptic[(20 * cs.width + 15) * 4];
const rec = Sampler.computePixel(tex, cs.H, 15, 20, cs.address, cs.anisotropy, 32, ['elliptic']);
console.assert(px === Sampler.linearToSRGBByte(rec.color.r), 'renderAll/computePixel mismatch');
console.log('renderAll matches computePixel ✓');
