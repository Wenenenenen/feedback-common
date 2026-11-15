// Minimal PNG codec sufficient for this workbench.
// Encoder: color type 2 (8-bit RGB), 0 (8-bit grayscale), 6 (8-bit RGBA).
// Decoder: same three color types, 8-bit only, all five PNG filter types.
// Browser decode normally goes through createImageBitmap/Canvas; this decoder
// exists so the exact pipeline is testable in Node and as a fallback.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(len + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(len + 8, crc32(out.subarray(4, len + 8)));
  return out;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function deflateBytes(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Node fallback (must be imported dynamically to keep the browser bundle clean).
  const { deflateSync } = await import('node:zlib');
  return deflateSync(bytes);
}

// channels: 1 grayscale, 3 RGB, 4 RGBA. data: Uint8ClampedArray/Uint8Array.
export async function encodePNG(width, height, channels, data) {
  if (width > 1280 || height > 720) throw new Error('PNG size exceeds 1280x720');
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None); deterministic and simple
    raw.set(data.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = await deflateBytes(raw);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

async function inflateBytes(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateSync } = await import('node:zlib');
  return inflateSync(bytes);
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Returns { width, height, channels, data: Uint8Array }. Rejects anything that
// is not 8-bit RGB/RGBA/grayscale, matching the import contract.
export async function decodePNG(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('not a PNG file');
  }
  let off = 8, width = 0, height = 0, depth = 0, colorType = -1;
  const idat = [];
  while (off < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4);
      depth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNGs are supported, got bit depth ' + depth);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : -1;
  if (channels < 0 || channels === 2) throw new Error('only 8-bit RGB, RGBA or grayscale PNGs are supported');
  const inflated = await inflateBytes(concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[pos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[pos++];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: throw new Error('unknown PNG filter ' + filter);
      }
      out[rowStart + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
