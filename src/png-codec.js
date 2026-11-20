'use strict';
// 自实现 PNG 编解码（仅 8 位，支持灰度 / RGB / RGBA / 灰度+alpha，非隔行）。
// 解码用 DecompressionStream('deflate') 做 inflate；编码用手写的 STORE 型 zlib
// 数据块（无压缩），因此任意环境输出逐字节一致，不依赖具体 zlib 版本。

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR_COLOR_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function crc32Table() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_TABLE = crc32Table();

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
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境缺少 DecompressionStream，无法解码 PNG');
  }
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 确定性 zlib 编码：固定头部 + STORE 块 + adler32。
function deflateZlibStore(bytes) {
  const blocks = [];
  // zlib 头：CM=8, CINFO=7 (32K 窗口), FCHECK 使头部 16 位可被 31 整除。
  // 0x78 0x01 => 0x7801 % 31 == 0。
  let pos = 0;
  const MAX_BLOCK = 0xffff;
  while (pos < bytes.length || blocks.length === 0) {
    const remain = bytes.length - pos;
    const n = Math.min(MAX_BLOCK, Math.max(0, remain));
    const block = new Uint8Array(n + 5);
    block[0] = remain <= MAX_BLOCK ? 1 : 0; // BFINAL
    block[1] = n & 0xff;
    block[2] = (n >>> 8) & 0xff;
    block[3] = (~n) & 0xff;
    block[4] = ((~n) >>> 8) & 0xff;
    block.set(bytes.subarray(pos, pos + n), 5);
    blocks.push(block);
    pos += n;
    if (n === 0) break;
  }
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, adler32(bytes));
  return concat([new Uint8Array([0x78, 0x01]), ...blocks, checksum]);
}

function unfilterScanlines(raw, width, bpp) {
  const stride = width * bpp;
  const height = raw.length / (stride + 1);
  const out = new Uint8Array(stride * height);
  let p = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.slice(p, p + stride);
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v += pr;
      } else if (filter !== 0) {
        throw new Error('不支持的 PNG 滤镜类型 ' + filter);
      }
      line[x] = v & 0xff;
    }
    out.set(line, y * stride);
    prev = line;
  }
  return out;
}

// 返回 { width, height, channels, data: Uint8Array }
export async function decodePNG(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('不是 PNG 文件');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      bitDepth = dv.getUint8(8);
      colorType = dv.getUint8(9);
      interlace = dv.getUint8(12);
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8 位 PNG（当前位深 ' + bitDepth + '）');
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  const channels = IHDR_COLOR_CHANNELS[colorType];
  if (!channels) throw new Error('不支持的 PNG 颜色类型 ' + colorType);
  const raw = await inflateZlib(concat(idat));
  const data = unfilterScanlines(raw, width, channels);
  return { width, height, channels, data };
}

// 通用编码：colorType 2 = RGB，0 = 灰度。均为 8 位非隔行。
export function encodePNG(width, height, channels, data) {
  if (channels !== 3 && channels !== 1) {
    throw new Error('编码仅支持 RGB(3) 或灰度(1)');
  }
  const colorType = channels === 3 ? 2 : 0;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // 非隔行
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const zlibData = deflateZlibStore(raw);
  return concat([
    new Uint8Array(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibData),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
