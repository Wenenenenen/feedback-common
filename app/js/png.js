// png.js — minimal PNG decode/encode used by the page, the worker and tests.
//
// Decode: 8/16-bit, colour types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha),
// 6 (RGBA), interlace 0.  The result is always straight-alpha RGBA8; 16-bit
// samples keep their high byte.  CRC is verified for critical chunks and the
// stream must end with IEND, so truncated files are rejected.
//
// Encode: 8-bit RGBA (type 6) or grayscale (type 0), filter 0 rows, zlib IDAT,
// no ancillary chunks (mask PNGs therefore survive byte-for-byte value checks).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflateBytes(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw new Error(`IDAT 解压失败：${err.message || err}`);
  }
}

async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw new Error(`PNG 在偏移 ${pos} 处被截断（缺少块头）`);
    const length = view.getUint32(pos);
    if (pos + 12 + length > bytes.length) {
      throw new Error(`PNG 在偏移 ${pos} 处被截断（块长度 ${length} 超出文件尾部）`);
    }
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    const crc = view.getUint32(pos + 8 + length);
    const typeBytes = bytes.subarray(pos + 4, pos + 8);
    const calc = crc32(new Uint8Array([...typeBytes, ...data]));
    chunks.push({ type, data, crc, calc, critical: (typeBytes[0] & 0x20) === 0 });
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') {
    throw new Error('PNG 缺少 IEND 块，文件可能被截断');
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, width, height, bppIn, bitsPerPixel) {
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    if (filter > 4) throw new Error(`第 ${y} 行使用了未知过滤器 ${filter}`);
    const line = raw.subarray(at + 1, at + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    if (filter === 0) {
      cur.set(line);
    } else if (filter === 1) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bppIn ? cur[x - bppIn] : 0;
        cur[x] = (line[x] + a) & 0xff;
      }
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) cur[x] = (line[x] + prev[x]) & 0xff;
    } else if (filter === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bppIn ? cur[x - bppIn] : 0;
        cur[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xff;
      }
    } else {
      for (let x = 0; x < stride; x++) {
        const a = x >= bppIn ? cur[x - bppIn] : 0;
        const b = prev[x];
        const c = x >= bppIn ? prev[x - bppIn] : 0;
        cur[x] = (line[x] + paeth(a, b, c)) & 0xff;
      }
    }
    prev = cur;
  }
  return out;
}

// Decode a PNG file (Uint8Array/ArrayBuffer) to straight-alpha RGBA8.
export async function decodePng(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input instanceof ArrayBuffer ? input : input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 8) throw new Error('PNG 太短，无法识别');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('不是 PNG 文件（签名不符）');
  }

  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new Error('PNG 缺少或不完整的 IHDR');
  for (const c of chunks) {
    if (c.critical && c.crc !== c.calc) {
      throw new Error(`PNG 块 ${c.type} 的 CRC 校验失败，文件可能损坏`);
    }
  }
  const iv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = iv.getUint32(0);
  const height = iv.getUint32(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];

  if (width < 1 || height < 1) throw new Error('PNG 尺寸无效');
  if (compression !== 0) throw new Error(`不支持的 PNG 压缩方式 ${compression}`);
  if (filterMethod !== 0) throw new Error(`不支持的 PNG 过滤方式 ${filterMethod}`);
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG，请重新导出为逐行 PNG');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的 PNG 位深 ${bitDepth}（仅支持 8 与 16 位）`);

  const channelCount = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channelCount) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);

  let palette = null;
  let paletteAlpha = null;
  for (const c of chunks) {
    if (c.type === 'PLTE') {
      palette = c.data;
      if (palette.length % 3 !== 0) throw new Error('PNG 调色板长度无效');
    } else if (c.type === 'tRNS' && colorType === 3) {
      paletteAlpha = c.data;
    }
  }
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE 块');

  const idatParts = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (!idatParts.length) throw new Error('PNG 没有 IDAT 数据');
  let total = 0;
  for (const p of idatParts) total += p.length;
  const idat = new Uint8Array(total);
  let off = 0;
  for (const p of idatParts) { idat.set(p, off); off += p.length; }

  const raw = await inflateBytes(idat);
  const bitsPerPixel = channelCount * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) {
    throw new Error(`PNG 图像数据被截断：需要 ${(stride + 1) * height} 字节，实际 ${raw.length} 字节`);
  }
  const bppIn = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const pixels = unfilter(raw, width, height, bppIn, bitsPerPixel);

  const rgba = new Uint8ClampedArray(width * height * 4);
  const sample = (lineOff, x, channel) => {
    if (bitDepth === 8) return pixels[lineOff + x * channelCount + channel];
    const o = lineOff + (x * channelCount + channel) * 2;
    return pixels[o];
  };

  let nonOpaque = 0;
  for (let y = 0; y < height; y++) {
    const lineOff = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (colorType === 0) {
        r = g = b = sample(lineOff, x, 0);
      } else if (colorType === 4) {
        r = g = b = sample(lineOff, x, 0);
        a = sample(lineOff, x, 1);
      } else if (colorType === 3) {
        const idx = bitDepth === 8 ? pixels[lineOff + x] : sample(lineOff, x, 0);
        const pi = idx * 3;
        if (pi + 2 >= palette.length) throw new Error(`第 ${y} 行第 ${x} 列的调色板索引 ${idx} 越界`);
        r = palette[pi]; g = palette[pi + 1]; b = palette[pi + 2];
        if (paletteAlpha && idx < paletteAlpha.length) a = paletteAlpha[idx];
      } else if (colorType === 2) {
        r = sample(lineOff, x, 0); g = sample(lineOff, x, 1); b = sample(lineOff, x, 2);
      } else {
        r = sample(lineOff, x, 0); g = sample(lineOff, x, 1); b = sample(lineOff, x, 2); a = sample(lineOff, x, 3);
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      if (a !== 255) nonOpaque++;
    }
  }

  return { width, height, rgba, bitDepth, colorType, nonOpaque };
}

function chunk(type, data) {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = crc32(body);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc);
  return out;
}

// encodePng({ width, height, kind: 'rgba'|'gray', data })
//   rgba: Uint8ClampedArray/Uint8Array length w*h*4, straight alpha
//   gray: Uint8Array length w*h, values kept exactly
export async function encodePng({ width, height, kind, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('PNG 尺寸无效');
  }
  const colorType = kind === 'gray' ? 0 : 6;
  const channels = kind === 'gray' ? 1 : 4;
  const expected = width * height * channels;
  if (data.length !== expected) throw new Error(`PNG 像素数据长度应为 ${expected}，实际 ${data.length}`);

  const stride = width * channels;
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    filtered.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = await deflateBytes(filtered);

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Count of pixels whose alpha is not 255; used for the import warning.
export function countNonOpaque(rgba) {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) n++;
  return n;
}
