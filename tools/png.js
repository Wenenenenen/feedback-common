// Minimal PNG decoder/encoder for 8-bit grayscale images (no external deps).
// Decoder supports the bit depths/color types the project needs; encoder
// emits 8-bit grayscale PNGs (used for valid masks in the browser build too).
import zlib from 'node:zlib';

function readChunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const chunks = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    chunks.push({ type, data });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

const PAETH = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePNG(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');

  const idat = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
  const raw = zlib.inflateSync(idat);

  // channels per pixel and bytes per pixel (only the subset we need)
  let channels;
  if (colorType === 0) channels = 1;
  else if (colorType === 2) channels = 3;
  else if (colorType === 4) channels = 2;
  else if (colorType === 6) channels = 4;
  else throw new Error('color type ' + colorType + ' unsupported');
  if (bitDepth !== 8 && !(bitDepth === 16 && colorType === 0)) {
    throw new Error('bit depth ' + bitDepth + ' unsupported');
  }
  const bpp = channels * (bitDepth === 16 ? 2 : 1);
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: val = v + PAETH(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      out[rowStart + x] = val & 255;
    }
  }

  // Downsample to 8-bit grayscale
  const gray = new Uint8Array(width * height);
  if (colorType === 0 && bitDepth === 8) {
    gray.set(out);
  } else if (colorType === 0 && bitDepth === 16) {
    for (let i = 0; i < width * height; i++) gray[i] = out[i * 2];
  } else {
    const ch = bpp / (bitDepth === 16 ? 2 : 1);
    for (let i = 0; i < width * height; i++) {
      const r = out[i * bpp], g = out[i * bpp + 1], bl = out[i * bpp + 2];
      gray[i] = ch >= 3 ? Math.round(0.299 * r + 0.587 * g + 0.114 * bl) : r;
    }
  }
  return { width, height, data: gray };
}

export function encodePNGGray(width, height, data /* Uint8Array */) {
  const chunks = [];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(makeChunk('IHDR', ihdr));

  const stride = width;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.subarray ? raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
                  : raw.set(Buffer.from(data.slice(y * stride, (y + 1) * stride)), y * (stride + 1) + 1);
  }
  chunks.push(makeChunk('IDAT', zlib.deflateSync(raw, { level: 6 })));
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
