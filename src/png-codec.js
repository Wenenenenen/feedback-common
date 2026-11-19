// Pure-JS PNG codec (no external deps), shared by the browser app and Node tests.
// Supports grayscale/RGB/RGBA at 8/16-bit, non-interlaced. 16-bit values are
// read with full uint16 precision; 8-bit palette/gray <8 are expanded to 8-bit.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  const BLOCK = 5552;
  for (let i = 0; i < buf.length; i += BLOCK) {
    const end = Math.min(i + BLOCK, buf.length);
    for (let j = i; j < end; j++) {
      a += buf[j];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBuf = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBuf.length + data.length);
  body.set(typeBuf, 0);
  body.set(data, typeBuf.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return Buffer4.concat([len, body, crc]);
}

// Indirection so the same source runs in browsers (globalThis.Buffer absent).
const Buffer4 = {
  alloc(n) { return new Uint8Array(n); },
  from(a, enc) {
    if (typeof a === 'string') return new TextEncoder().encode(a);
    return new Uint8Array(a);
  },
  concat(arrs) {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  },
};

// Raw stored-block DEFLATE (no compression) wrapped as a zlib stream.
export function storedDeflate(data) {
  const blocks = [];
  let pos = 0;
  do {
    const n = Math.min(65535, data.length - pos);
    const last = pos + n >= data.length;
    const hdr = new Uint8Array(5);
    hdr[0] = last ? 1 : 0;
    hdr[1] = n & 255;
    hdr[2] = (n >> 8) & 255;
    hdr[3] = (~n) & 255;
    hdr[4] = ((~n) >> 8) & 255;
    blocks.push(hdr, data.subarray(pos, pos + n));
    pos += n;
  } while (pos < data.length);
  const raw = Buffer4.concat(blocks);
  const av = adler32(data);
  const adler = new Uint8Array(4);
  adler[0] = (av >> 24) & 255; adler[1] = (av >> 16) & 255;
  adler[2] = (av >> 8) & 255; adler[3] = av & 255;
  // zlib header: CM=8, CINFO=7, FLG check byte, no preset dict.
  return Buffer4.concat([new Uint8Array([0x78, 0x01]), raw, adler]);
}

// deflateFn: (Uint8Array) => Promise<Uint8Array>
export async function encodePNG(width, height, channels, bitDepth, samples, deflateFn) {
  if (channels !== 1 && channels !== 3 && channels !== 4) throw new Error('unsupported channels');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('unsupported bit depth');
  const bytesPerSample = bitDepth / 8;
  const rowLen = width * channels * bytesPerSample;
  const raw = new Uint8Array((rowLen + 1) * height);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    raw[rp++] = 0; // filter type 0 (None)
    const rowBase = y * width * channels;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const v = samples[rowBase + x * channels + c];
        if (bitDepth === 16) {
          raw[rp++] = (v >> 8) & 255;
          raw[rp++] = v & 255;
        } else {
          raw[rp++] = v & 255;
        }
      }
    }
  }
  // deflateFn returns a complete zlib stream (header + deflate + adler32),
  // matching CompressionStream('deflate') in browsers and zlib.deflate in Node.
  const zlibStream = await deflateFn(raw);

  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer4.concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStream),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// inflateFn: (Uint8Array) => Promise<Uint8Array>, inflates a zlib stream.
export async function decodePNG(buf, inflateFn) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a PNG file');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat = [];
  let palette = null;
  while (pos + 8 <= buf.length) {
    const len = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const o = data.byteOffset;
      const b = data.buffer;
      width = new DataView(b, o, 4).getUint32(0);
      height = new DataView(b, o + 4, 4).getUint32(0);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'IEND') break;
    pos += 12 + len; // 4-byte length + 4-byte type + data + 4-byte CRC
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error('unsupported PNG color type ' + colorType);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const inflated = await inflateFn(Buffer4.concat(idat).slice());

  if (bitDepth < 8) {
    return decodeSubByte(inflated, width, height, bitDepth, colorType, palette);
  }
  const bpp = (channels * bitDepth) / 8;
  const stride = width * channels * (bitDepth / 8);
  const out = new Uint8Array(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[rp++];
    const row = y * stride, prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[rp++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = (raw + a) & 255; break;
        case 2: v = (raw + b) & 255; break;
        case 3: v = (raw + ((a + b) >> 1)) & 255; break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (raw + pr) & 255;
        }
      }
      out[row + x] = v;
    }
  }
  const samples = new Uint16Array(width * height * channels);
  if (bitDepth === 16) {
    // Unsigned reconstruction: << and | would run through signed Int32.
    for (let i = 0, j = 0; i < out.length; i += 2, j++) samples[j] = out[i] * 256 + out[i + 1];
  } else {
    for (let i = 0; i < out.length; i++) samples[i] = out[i];
  }
  return { width, height, bitDepth, colorType, channels, samples };
}

function paethPred(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Handles 1/2/4-bit grayscale and indexed images (expanded to 8-bit samples).
function decodeSubByte(inflated, width, height, bitDepth, colorType, palette) {
  const channels = colorType === 3 ? 3 : 1;
  const stride = Math.ceil(width / (8 / bitDepth));
  const out = new Uint8Array(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[rp++];
    const row = y * stride, prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[rp++];
      const a = x >= 1 ? out[row + x - 1] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= 1 ? out[prev + x - 1] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = (raw + a) & 255; break;
        case 2: v = (raw + b) & 255; break;
        case 3: v = (raw + ((a + b) >> 1)) & 255; break;
        default: v = (raw + paethPred(a, b, c)) & 255;
      }
      out[row + x] = v;
    }
  }
  const samples = new Uint16Array(width * height * channels);
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bitOff = x * bitDepth;
      const byte = out[y * stride + (bitOff >> 3)];
      const idx = (byte >> (8 - bitDepth - (bitOff & 7))) & mask;
      const si = (y * width + x) * channels;
      if (colorType === 3) {
        if (!palette) throw new Error('indexed PNG missing palette');
        samples[si] = palette[idx * 3];
        samples[si + 1] = palette[idx * 3 + 1];
        samples[si + 2] = palette[idx * 3 + 2];
      } else {
        samples[si] = Math.round((idx / mask) * 255);
      }
    }
  }
  return { width, height, bitDepth: 8, colorType, channels, samples };
}

export function validateGuide(img) {
  if (img.width > 512 || img.height > 512) throw new Error('单边最多 512 像素');
  if (img.bitDepth !== 8) throw new Error('引导图必须是 8 位 PNG');
  if (img.colorType !== 2 && img.colorType !== 6) throw new Error('引导图必须是 RGB（或 RGBA）PNG');
}

export function validateDepth(img) {
  if (img.bitDepth !== 16 || img.colorType !== 0) throw new Error('深度图必须是 16 位灰度 PNG');
}

export function validateMask(img) {
  if (img.bitDepth !== 8 || (img.colorType !== 0 && img.colorType !== 4)) {
    throw new Error('掩膜必须是 8 位灰度 PNG');
  }
}

// Browser helpers -----------------------------------------------------------

export async function browserInflate(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('当前浏览器不支持 DecompressionStream，请使用现代浏览器');
}

export async function browserDeflate(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return storedDeflate(bytes);
}

export function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
