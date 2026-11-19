// Exporters: PNG (hand-rolled chunks + zlib stored blocks, no dependencies)
// and the per-pixel JSON described in 格式说明.md.

// ---- sRGB transfer (linear float -> sRGB encoded 0..255) ----
export function linearToSrgbByte(c) {
  const v = Math.min(1, Math.max(0, c));
  const enc = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(enc * 255);
}

// ---- CRC32 (PNG chunk checksums) ----
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
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
  const typeBytes = [...type].map((ch) => ch.charCodeAt(0));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  // Layout: length(4) | type+data(body) | CRC(4)
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// zlib stream (RFC1950) wrapping raw DEFLATE stored (uncompressed) blocks.
function zlibStoredBlocks(data) {
  const blocks = [];
  blocks.push(new Uint8Array([0x78, 0x01])); // CM=deflate, CINFO=7, FCHECK
  const MAX = 65535;
  for (let off = 0; off < data.length; off += MAX) {
    const len = Math.min(MAX, data.length - off);
    const header = new Uint8Array(5);
    header[0] = off + len >= data.length ? 1 : 0; // BFINAL
    header[1] = len & 0xff; // LEN
    header[2] = (len >> 8) & 0xff;
    header[3] = (~len) & 0xff; // NLEN
    header[4] = ((~len) >> 8) & 0xff;
    blocks.push(header, data.subarray(off, off + len));
  }
  const adler = adler32(data);
  blocks.push(new Uint8Array(u32be(adler)));
  return concat(blocks);
}

// rgba: Uint8ClampedArray/Uint8Array of RGBA bytes, row-major, top to bottom.
export function encodePng(width, height, rgba) {
  // Add the per-scanline filter byte (0 = none).
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }
  const ihdr = new Uint8Array([
    ...u32be(width), ...u32be(height),
    8, // bit depth
    6, // color type RGBA
    0, 0, 0,
  ]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("sRGB", new Uint8Array([0])), // rendering intent: perceptual
    chunk("IDAT", zlibStoredBlocks(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return concat(parts);
}

// Build an RGBA byte buffer from the engine's linear float color planes.
export function colorBufferToRgba(result) {
  const { width, height, rgb, faceBuffer } = result;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const covered = faceBuffer[i] >= 0;
    out[i * 4] = covered ? linearToSrgbByte(rgb[0][i]) : 0;
    out[i * 4 + 1] = covered ? linearToSrgbByte(rgb[1][i]) : 0;
    out[i * 4 + 2] = covered ? linearToSrgbByte(rgb[2][i]) : 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Per-pixel JSON exactly per 格式说明.md. coverage is the documented optional
// extra; include it when requested.
export function buildPixelJson(result, includeCoverage = true) {
  const { width, height } = result;
  const pixels = new Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const face = result.faceBuffer[i];
    if (face < 0) {
      pixels[i] = { face: -1, depth: null, rgb: [0, 0, 0] };
    } else {
      pixels[i] = {
        face,
        depth: result.depthBuffer[i],
        rgb: [result.rgb[0][i], result.rgb[1][i], result.rgb[2][i]],
      };
    }
  }
  const out = { width, height, pixels };
  if (includeCoverage) out.coverage = Array.from(result.coverage);
  return out;
}

export function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
