// 纯 JS PNG 编解码（仅本任务需要的子集，无任何第三方库）。
//   解码：灰度 8/16 位、非隔行、filter 0..4，返回 Uint16Array 样本值。
//   编码：16 位灰度 PNG（IHDR + iTXt 参数 + IDAT + IEND），deflate 用平台自带
//         CompressionStream；解码用 DecompressionStream。浏览器与 Node 18+ 均可用。
//
// 本文件不依赖 DOM，可在 Worker / Node 测试中直接 import。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n >>> 0;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new PngError('当前运行环境缺少 DecompressionStream，无法解压 PNG');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateZlib(bytes) {
  if (typeof CompressionStream !== 'function') {
    throw new PngError('当前运行环境缺少 CompressionStream，无法写出 PNG');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function writeU32(b, o, v) {
  b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}

function isLatin1String(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function makeChunk(type, data) {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const out = new Uint8Array(12 + data.length + 0);
  const withCrc = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = crc32(concatBytes([typeBytes, data]));
  writeU32(out, 8 + data.length, crc);
  withCrc.set(out);
  return withCrc;
}

function makeTextChunk(keyword, text) {
  // iTXt: keyword\0 compressionFlag(0) compressionMethod(0) langTag\0 translated\0 text(UTF-8)
  const kw = isLatin1String(keyword) ? utf8.encode(keyword) : utf8.encode('Params');
  const body = concatBytes([
    kw, new Uint8Array([0, 0, 0]), new Uint8Array([0]), new Uint8Array([0]),
    utf8.encode(text),
  ]);
  return makeChunk('iTXt', body);
}

/**
 * 解码 PNG。
 * @param {Uint8Array} bytes
 * @returns {Promise<{width:number,height:number,bitDepth:number,colorType:number,
 *   data:Uint16Array, hasAlpha:boolean, interlaced:boolean, text:Record<string,string>}>}
 */
export async function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 8) throw new PngError('不是有效的 PNG 文件（文件过短）');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new PngError('不是有效的 PNG 文件（签名不符）');

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let sawIhdr = false;
  const idat = [];
  const text = {};
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = readU32(bytes, off);
    if (off + 12 + len > bytes.length) throw new PngError('PNG 数据块被截断');
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      if (len < 13) throw new PngError('IHDR 长度非法');
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10], filter = data[11];
      interlace = data[12];
      if (compression !== 0 || filter !== 0) throw new PngError('PNG 使用了不支持的压缩/滤波方法');
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) text[String.fromCharCode.apply(null, data.subarray(0, z))] =
        String.fromCharCode.apply(null, data.subarray(z + 1));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        // compressionFlag, compressionMethod, langTag\0, translated\0, text
        let p = z + 1;
        const compFlag = data[p]; p += 2;
        const langEnd = data.indexOf(0, p);
        const transEnd = data.indexOf(0, langEnd + 1);
        const raw = data.subarray(transEnd + 1);
        const key = utf8Decoder.decode(data.subarray(0, z));
        if (compFlag === 0) text[key] = utf8Decoder.decode(raw);
      }
    }
    off += 12 + len;
  }
  if (!sawIhdr) throw new PngError('PNG 缺少 IHDR');

  if (width <= 0 || height <= 0) throw new PngError('PNG 尺寸非法');
  if (colorType !== 0) {
    const names = { 2: 'RGB', 3: '调色板', 4: '灰度+Alpha', 6: 'RGBA' };
    throw new PngError(`需要灰度 PNG（颜色类型 0），实际为 ${names[colorType] || colorType}`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) throw new PngError(`仅支持 8/16 位灰度，实际 ${bitDepth} 位`);
  if (interlace !== 0) throw new PngError('不支持隔行扫描 PNG');

  if (idat.length === 0) throw new PngError('PNG 缺少 IDAT');
  const raw = await inflateZlib(concatBytes(idat));

  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = bytesPerSample;
  const stride = width * bpp;
  const need = (stride + 1) * height;
  if (raw.length < need) throw new PngError('PNG 像素数据长度不足');

  const data = new Uint16Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    cur.set(raw.subarray(p, p + stride));
    p += stride;
    const row = y * width;
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
          cur[i] = (cur[i] + pr) & 255;
        }
        break;
      default:
        throw new PngError(`未知的 PNG 行滤波类型 ${filter}`);
    }
    if (bitDepth === 8) {
      for (let x = 0; x < width; x++) data[row + x] = cur[x];
    } else {
      for (let x = 0; x < width; x++) data[row + x] = (cur[2 * x] << 8) | cur[2 * x + 1];
    }
    const t = prev; prev = cur; cur = t;
  }

  return { width, height, bitDepth, colorType, data, hasAlpha: false, interlaced: false, text };
}

/**
 * 编码 16 位灰度 PNG。samples 为 0..65535 的样本值。
 * @param {Uint16Array} samples
 * @param {number} width
 * @param {number} height
 * @param {Record<string,string>|null} textChunks
 */
export async function encodeGray16(samples, width, height, textChunks = null) {
  if (samples.length !== width * height) throw new PngError('样本数量与尺寸不符');
  const stride = width * 2;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const v = samples[y * width + x] & 0xffff;
      raw[o + 1 + 2 * x] = (v >>> 8) & 255;
      raw[o + 2 + 2 * x] = v & 255;
    }
  }
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts = [SIG, makeChunk('IHDR', ihdr)];
  if (textChunks) {
    for (const [k, v] of Object.entries(textChunks)) parts.push(makeTextChunk(k, String(v)));
  }
  parts.push(makeChunk('IDAT', await deflateZlib(raw)));
  parts.push(makeChunk('IEND', new Uint8Array(0)));
  return concatBytes(parts);
}
