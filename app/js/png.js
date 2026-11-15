// png.js — minimal, dependency-free PNG encoder for straight-alpha 8-bit RGBA.
//
// Produces a colour-type-6 (RGBA), bit-depth-8 PNG with an sRGB chunk so
// viewers treat the RGB channels as sRGB.  Pixel bytes are written unchanged,
// so alpha stays straight (not premultiplied).
//
// Compression is a self-contained fixed-Huffman DEFLATE with greedy LZ77.
// It is not the smallest possible encoding, but it is exact and needs no
// third-party library, keeping the page fully offline.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

class BitWriter {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n + 1024));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  // Write the low `count` bits of `value`, LSB-first (as DEFLATE packs them).
  bits(value, count) {
    this.ensure(4);
    this.bitBuf |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCount -= 8;
    }
  }

  // Huffman codes are transmitted most-significant bit first.
  huffman(code, count) {
    let rev = 0;
    for (let i = 0; i < count; i++) rev = (rev << 1) | ((code >>> i) & 1);
    this.bits(rev, count);
  }

  flush() {
    if (this.bitCount > 0) {
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCount = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function writeLiteral(bw, sym) {
  if (sym < 144) bw.huffman(0x30 + sym, 8);
  else if (sym < 256) bw.huffman(0x190 + (sym - 144), 9);
  else if (sym < 280) bw.huffman(sym - 256, 7);
  else bw.huffman(0xc0 + (sym - 280), 8);
}

function lengthCode(len) {
  for (let i = LENGTH_BASE.length - 1; i >= 0; i--) {
    if (len >= LENGTH_BASE[i]) return i;
  }
  return 0;
}

function distanceCode(dist) {
  for (let i = DIST_BASE.length - 1; i >= 0; i--) {
    if (dist >= DIST_BASE[i]) return i;
  }
  return 0;
}

const MAX_WINDOW = 32768; // DEFLATE's maximum back-reference distance

/** DEFLATE a byte array into a zlib stream (fixed Huffman, greedy LZ77). */
export function deflateZlib(data) {
  const bw = new BitWriter(Math.max(1024, (data.length >> 1) + 64));
  // zlib header: deflate, 32K window, no preset dict, check bits valid
  bw.bits(0x78, 8);
  bw.bits(0x01, 8);
  // single fixed-Huffman block, final
  bw.bits(0b011, 3);

  const n = data.length;
  const HASH_SIZE = 1 << 16;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);

  const MAX_MATCH = 258;
  const MIN_MATCH = 3;
  const MAX_CHAIN = 24;

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const h = hash(i);
      let candidate = head[h];
      let chain = 0;
      const maxLen = Math.min(MAX_MATCH, n - i);
      while (candidate >= 0 && chain < MAX_CHAIN) {
        const dist = i - candidate;
        if (dist > MAX_WINDOW) break; // farther back than DEFLATE can encode
        if (data[candidate + bestLen] === data[i + bestLen]) {
          let len = 0;
          while (len < maxLen && data[candidate + len] === data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = dist;
            if (len >= maxLen) break;
          }
        }
        candidate = prev[candidate];
        chain++;
      }
      prev[i] = head[h];
      head[h] = i;
    }
    if (bestLen >= MIN_MATCH) {
      const lc = lengthCode(bestLen);
      writeLiteral(bw, 257 + lc);
      if (LENGTH_EXTRA[lc]) bw.bits(bestLen - LENGTH_BASE[lc], LENGTH_EXTRA[lc]);
      const dc = distanceCode(bestDist);
      bw.huffman(dc, 5);
      if (DIST_EXTRA[dc]) bw.bits(bestDist - DIST_BASE[dc], DIST_EXTRA[dc]);
      // insert the interior positions of the match into the hash chain, but
      // leave the next position (i + bestLen) for the next iteration's search
      const end = Math.min(i + bestLen - 1, n - MIN_MATCH);
      for (let k = i + 1; k <= end; k++) {
        const h = hash(k);
        prev[k] = head[h];
        head[h] = k;
      }
      i += bestLen;
    } else {
      writeLiteral(bw, data[i]);
      i++;
    }
  }
  writeLiteral(bw, 256); // end of block
  const body = bw.flush();

  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  const ad = adler32(data);
  out[body.length] = (ad >>> 24) & 0xff;
  out[body.length + 1] = (ad >>> 16) & 0xff;
  out[body.length + 2] = (ad >>> 8) & 0xff;
  out[body.length + 3] = ad & 0xff;
  return out;
}

function chunk(type, payload) {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  const crc = crc32(out, 4, 8 + payload.length);
  view.setUint32(8 + payload.length, crc);
  return out;
}

/**
 * Encode straight-alpha RGBA bytes (length = width*height*4, sRGB colour)
 * into a PNG file as a Uint8Array.
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('PNG 尺寸无效');
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`PNG 像素长度不符：需要 ${width * height * 4}，实际 ${rgba.length}`);
  }
  // Scanlines with filter byte 0 (None) in front of every row.
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const srgb = new Uint8Array([0]); // perceptual rendering intent
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('sRGB', srgb),
    chunk('IDAT', deflateZlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export { crc32, adler32 };
