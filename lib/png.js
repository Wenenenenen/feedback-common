// 8 位灰度 PNG 编解码（零第三方依赖）。
// 解码支持 color type 0 / bit depth 8、非隔行；编码默认自适应行滤波。
// 压缩使用平台内置 CompressionStream / DecompressionStream（deflate = zlib 封装）。
// 这样浏览器与 Node 18+ 共用同一份实现，不引入任何现成图像库或去噪库。

import { crc32 } from './crc32.js';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_TYPE_NAMES = {
  0: '灰度',
  2: 'RGB',
  3: '索引色',
  4: '灰度+Alpha',
  6: 'RGBA',
};

function u32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function u16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

function writeU32(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

function writeU16(buf, off, v) {
  buf[off] = (v >>> 8) & 0xff;
  buf[off + 1] = v & 0xff;
}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前运行环境缺少 DecompressionStream，无法解压 PNG');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

// CompressionStream 不可用时的退路：zlib 头 + 全 stored 块 + adler32。
function deflateStored(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, bytes.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = (~len) & 0xff;
    out[o++] = ((~len) >>> 8) & 0xff;
    out.set(bytes.subarray(start, start + len), o);
    o += len;
  }
  writeU32(out, o, adler32(bytes));
  return out;
}

async function deflateZlib(bytes) {
  if (typeof CompressionStream !== 'function') return deflateStored(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePNG(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || !SIGNATURE.every((v, i) => bytes[i] === v)) {
    throw new Error('不是有效的 PNG 文件（签名不匹配）');
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  let sawIEND = false;
  while (pos + 8 <= bytes.length) {
    const length = u32(bytes, pos);
    const typeStart = pos + 4;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error(`PNG 块 ${type} 越界`);
    const expected = u32(bytes, dataEnd);
    const actual = crc32(bytes, typeStart, dataEnd);
    if (expected !== actual) throw new Error(`PNG 块 ${type} CRC 校验失败`);
    if (type === 'IHDR') {
      ihdr = {
        width: u32(bytes, dataStart),
        height: u32(bytes, dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        compression: bytes[dataStart + 10],
        filter: bytes[dataStart + 11],
        interlace: bytes[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
    pos = dataEnd + 4;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (!sawIEND) throw new Error('PNG 缺少 IEND');
  if (!idat.length) throw new Error('PNG 缺少 IDAT 数据');
  if (ihdr.compression !== 0) throw new Error('不支持的 PNG 压缩方式');
  if (ihdr.interlace !== 0) throw new Error('不支持隔行（Adam7）PNG');
  if (ihdr.bitDepth !== 8 || ihdr.colorType !== 0) {
    const name = COLOR_TYPE_NAMES[ihdr.colorType] || `colorType=${ihdr.colorType}`;
    throw new Error(`仅支持 8 位灰度 PNG，当前为 ${ihdr.bitDepth} 位 ${name}`);
  }
  const { width, height } = ihdr;
  if (width < 1 || height < 1) throw new Error('PNG 尺寸必须至少为 1×1');

  const total = idat.reduce((n, c) => n + c.length, 0);
  const packed = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    packed.set(c, off);
    off += c.length;
  }
  const raw = await inflateZlib(packed);
  const expectedRaw = height * (1 + width);
  if (raw.length < expectedRaw) {
    throw new Error(`PNG 像素数据不足：期望 ${expectedRaw} 字节，实际 ${raw.length}`);
  }

  const data = new Uint8Array(width * height);
  const prev = new Uint8Array(width);
  const row = new Uint8Array(width);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < width; x++) row[x] = raw[rp++];
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let x = 1; x < width; x++) row[x] = (row[x] + row[x - 1]) & 0xff;
        break;
      case 2:
        for (let x = 0; x < width; x++) row[x] = (row[x] + prev[x]) & 0xff;
        break;
      case 3:
        for (let x = 0; x < width; x++) {
          const left = x > 0 ? row[x - 1] : 0;
          row[x] = (row[x] + ((left + prev[x]) >>> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < width; x++) {
          const a = x > 0 ? row[x - 1] : 0;
          const b = prev[x];
          const c = x > 0 ? prev[x - 1] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          row[x] = (row[x] + pred) & 0xff;
        }
        break;
      default:
        throw new Error(`PNG 第 ${y} 行使用未知滤波器 ${filter}`);
    }
    data.set(row, y * width);
    prev.set(row);
  }
  return { width, height, data };
}

function filteredRows(width, height, gray) {
  // 逐行在 5 种滤波器中取“有符号字节绝对值和”最小者，兼顾压缩率与速度。
  const stride = width + 1;
  const out = new Uint8Array(stride * height);
  const candidate = new Uint8Array(width);
  const best = new Uint8Array(width);
  let prev = new Uint8Array(width);
  let current = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    current = gray.subarray(y * width, (y + 1) * width);
    let bestScore = Infinity;
    let bestFilter = 0;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let x = 0; x < width; x++) {
        const left = x > 0 ? current[x - 1] : 0;
        const up = prev[x];
        const ul = x > 0 ? prev[x - 1] : 0;
        let pred = 0;
        if (f === 1) pred = left;
        else if (f === 2) pred = up;
        else if (f === 3) pred = (left + up) >>> 1;
        else if (f === 4) {
          const p = left + up - ul;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        }
        const v = (current[x] - pred) & 0xff;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        best.set(candidate);
      }
    }
    out[y * stride] = bestFilter;
    out.set(best, y * stride + 1);
    prev = current;
  }
  return out;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function toGray8(data, width, height, round) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = round ? Math.round(data[i]) : data[i];
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }
  return out;
}

export async function encodeGrayPNG(width, height, data, options = {}) {
  const { round = true } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('PNG 尺寸非法');
  }
  if (data.length < width * height) throw new Error('PNG 像素数据长度不足');
  const gray = toGray8(data, width, height, round);
  const raw = filteredRows(width, height, gray);
  const compressed = await deflateZlib(raw);

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function grayToImageData(gray, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, width, height };
}
