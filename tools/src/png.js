// Minimal PNG encoder: RGBA (color type 6) and grayscale 8-bit (color type 0).
// Zero dependencies. Prefers CompressionStream('deflate') (raw zlib wrapper);
// falls back to hand-written stored deflate blocks so export works anywhere.

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

function adler32(bytes) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(type, 4);
  out.set(data, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)));
  return out;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Stored deflate blocks wrapped in zlib (CMF/FLG + adler32). Always valid.
function storedZlib(data) {
  const blocks = [];
  let pos = 0;
  do {
    const chunk = data.subarray(pos, Math.min(pos + 65535, data.length));
    const last = pos + chunk.length >= data.length;
    const head = new Uint8Array(5);
    head[0] = last ? 1 : 0;
    head[1] = chunk.length & 0xff;
    head[2] = (chunk.length >> 8) & 0xff;
    head[3] = (~chunk.length) & 0xff;
    head[4] = ((~chunk.length) >> 8) & 0xff;
    blocks.push(head, chunk);
    pos += chunk.length;
  } while (pos < data.length);
  const body = concat(blocks);
  const head = new Uint8Array([0x78, 0x01]);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, adler32(data));
  return concat([head, body, tail]);
}

async function zlibWrap(data) {
  if (typeof CompressionStream !== "undefined") {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      // fall through
    }
  }
  return storedZlib(data);
}

function rawWithFilter(width, height, channels, pixels) {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

async function encodePng(width, height, colorType, bitDepth, pixels) {
  const channels = colorType === 6 ? 4 : 1;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = rawWithFilter(width, height, channels, pixels);
  const idat = await zlibWrap(raw);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concat([
    signature,
    chunk(new Uint8Array([73, 72, 68, 82]), ihdr),
    chunk(new Uint8Array([73, 68, 65, 84]), idat),
    chunk(new Uint8Array([73, 69, 78, 68]), new Uint8Array(0)),
  ]);
}

export function encodeRgbaPng(width, height, rgba) {
  return encodePng(width, height, 6, 8, rgba);
}

// status: Uint8Array with codes 0/1/2
export function encodeStatusPng(width, height, status) {
  const gray = new Uint8Array(width * height);
  gray.set(status);
  return encodePng(width, height, 0, 8, gray);
}
