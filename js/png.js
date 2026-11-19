// 极简 PNG 编解码（零第三方依赖）。
//
// 编码：8 位 RGB（color type 2）或 8 位灰度（color type 0，用于锁定标签），
//       每行 filter 0，保证输出逐字节确定（相同输入 → 相同文件）。
// 解码：8 位灰度/真彩（含 Alpha 时丢弃 Alpha，灰度另存一份单通道副本），
//       实现全部 5 种行滤波，校验 CRC。
//
// zlib：浏览器走原生 CompressionStream/DecompressionStream，
//       Node（>=18）同样有这两个全局对象，因此两条路径共用一份代码。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlibDeflate(data) {
  const cs = new CompressionStream('deflate'); // W3C 'deflate' = zlib (RFC 1950)
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zlibInflate(data) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, body) {
  const len = body.length;
  const out = new Uint8Array(len + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(len + 8, crc32(out.subarray(4, len + 8)));
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

function ihdrChunk(width, height, colorType) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return chunk('IHDR', ihdr);
}

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// rgb8：长度 width*height*3 的交织 8 位 RGB。
export async function encodePngRgb8(width, height, rgb8) {
  if (rgb8.length !== width * height * 3) throw new Error('PNG 编码输入尺寸不匹配');
  const raw = new Uint8Array((width * 3 + 1) * height);
  let p = 0;
  let s = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width * 3; x++) raw[p++] = rgb8[s++];
  }
  return concat([PNG_SIG, ihdrChunk(width, height, 2), chunk('IDAT', await zlibDeflate(raw)), chunk('IEND', new Uint8Array(0))]);
}

// gray8：长度 width*height 的 8 位灰度。
export async function encodePngGray8(width, height, gray8) {
  if (gray8.length !== width * height) throw new Error('PNG 编码输入尺寸不匹配');
  const raw = new Uint8Array((width + 1) * height);
  let p = 0;
  let s = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) raw[p++] = gray8[s++];
  }
  return concat([PNG_SIG, ihdrChunk(width, height, 0), chunk('IDAT', await zlibDeflate(raw)), chunk('IEND', new Uint8Array(0))]);
}

const PAETH = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// 返回 { width, height, depth, colorType, gray8, rgb8 }
// gray8 只在源为灰度时给出（锁定标签用），rgb8 总是给出（Alpha 丢弃）。
export async function decodePng(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 8) throw new Error('PNG 文件过短');
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) throw new Error('不是 PNG 文件（签名错误）');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let seenIhdr = false;
  const idatParts = [];
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off);
    if (off + 12 + len > buf.length) throw new Error('PNG 块长度越界（文件被截断？）');
    const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    const body = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== dv.getUint32(off + 8 + len)) {
      throw new Error(`PNG ${type} 块 CRC 校验失败`);
    }
    if (type === 'IHDR') {
      const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = bv.getUint32(0);
      height = bv.getUint32(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw new Error('暂不支持压缩/滤波/隔行扩展的 PNG');
      seenIhdr = true;
    } else if (type === 'IDAT') {
      idatParts.push(body);
    } else if (type === 'IEND') {
      break;
    } else if (type.charCodeAt(0) < 97) {
      throw new Error(`遇到未知关键块 ${type}`);
    }
    off += 12 + len;
  }
  if (!seenIhdr) throw new Error('PNG 缺少 IHDR');
  if (width <= 0 || height <= 0) throw new Error('PNG 尺寸非法');
  if (![0, 2, 4, 6].includes(colorType)) throw new Error(`不支持的 PNG color type ${colorType}`);
  if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG，收到 ${bitDepth} 位`);

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const stride = width * channels;
  const inflated = await zlibInflate(concat(idatParts));
  if (inflated.length !== (stride + 1) * height) {
    throw new Error('PNG 数据长度与尺寸不符');
  }
  const planes = new Uint8Array(stride * height);
  let inOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[inOff++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const raw = inflated[inOff++];
      const a = i >= channels ? planes[rowStart + i - channels] : 0;
      const b = y > 0 ? planes[prevStart + i] : 0;
      const c = y > 0 && i >= channels ? planes[prevStart + i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + PAETH(a, b, c); break;
        default: throw new Error(`非法 PNG 行滤波类型 ${filter}`);
      }
      planes[rowStart + i] = v & 0xff;
    }
  }

  const rgb8 = new Uint8Array(width * height * 3);
  const gray8 = colorType === 0 || colorType === 4 ? new Uint8Array(width * height) : null;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    if (colorType === 0) {
      rgb8[i * 3] = rgb8[i * 3 + 1] = rgb8[i * 3 + 2] = planes[i];
      gray8[i] = planes[i];
    } else if (colorType === 4) {
      const v = planes[i * 2];
      rgb8[i * 3] = rgb8[i * 3 + 1] = rgb8[i * 3 + 2] = v;
      gray8[i] = v;
    } else if (colorType === 2) {
      rgb8[i * 3] = planes[i * 3];
      rgb8[i * 3 + 1] = planes[i * 3 + 1];
      rgb8[i * 3 + 2] = planes[i * 3 + 2];
    } else {
      rgb8[i * 3] = planes[i * 4];
      rgb8[i * 3 + 1] = planes[i * 4 + 1];
      rgb8[i * 3 + 2] = planes[i * 4 + 2];
    }
  }
  return { width, height, depth: bitDepth, colorType, gray8, rgb8 };
}
