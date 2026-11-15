// Synchronous PNG decoder for Node tests (mirrors src/png.js decode logic).
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function readPNG(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png: ' + file);
  let off = 8, width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : (() => { throw new Error('colorType ' + colorType); })();
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[pos++];
    for (let x = 0; x < stride; x++) {
      const raw = inflated[pos++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        default: v = raw + paeth(a, b, c);
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: new Uint8Array(out) };
}
