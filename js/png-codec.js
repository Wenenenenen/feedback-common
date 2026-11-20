// PNG 编解码：仅支持 8 位、非隔行 PNG。
// 解码兼容灰度(0)/RGB(2)/调色板(3)/灰度+Alpha(4)/RGBA(6)；
// 编码支持 RGB(2) 与灰度(0)。压缩使用 zlib（CompressionStream 'deflate'）。

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
  const buf = new Uint8Array(len + 12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(data, 8);
  dv.setUint32(len + 8, crc32(buf.subarray(4, len + 8)));
  return buf;
}

async function zlibDeflate(bytes) {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Node 旧版本兜底：zlib 模块
  const { deflateSync } = await import('node:zlib');
  return deflateSync(bytes);
}

function zlibInflate(bytes) {
  // 浏览器/Node 均可用 DecompressionStream；测试环境 Node22 全局可用
  if (typeof DecompressionStream === 'function') {
    return new Uint8Array(); // 实际走异步路径，见 decodePNG
  }
  throw new Error('DecompressionStream 不可用');
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateSync } = await import('node:zlib');
  return inflateSync(bytes);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG。
 * @returns {{width:number,height:number,colorType:number,data:Uint8Array,channels:number}}
 */
export async function decodePNG(input) {
  // 兼容 ArrayBuffer / Node Buffer / 带 byteOffset 的视图，统一得到紧凑 Uint8Array
  let bytes;
  if (input instanceof Uint8Array) {
    bytes = new Uint8Array(input.byteLength);
    bytes.set(input);
  } else {
    bytes = new Uint8Array(input);
  }
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('不是 PNG 文件');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null;
  while (pos + 8 <= bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + pos);
    const length = dv.getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = dv.getUint32(8);
      height = dv.getUint32(12);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (interlace !== 0) throw new Error('不支持 Adam7 隔行 PNG');
  if (bitDepth !== 8) throw new Error('仅支持 8 位 PNG（当前位深 ' + bitDepth + '）');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的 PNG 颜色类型 ' + colorType);

  const raw = await inflate(concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  const prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error('未知 PNG 滤波器 ' + filter);
      cur[x] = v & 255;
    }
    prev.set(cur);
  }

  if (colorType === 3) {
    if (!palette) throw new Error('调色板 PNG 缺少 PLTE');
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const pi = out[i] * 3;
      rgb[i * 3] = palette[pi];
      rgb[i * 3 + 1] = palette[pi + 1];
      rgb[i * 3 + 2] = palette[pi + 2];
    }
    return { width, height, colorType, channels: 3, data: rgb };
  }
  return { width, height, colorType, channels, data: out };
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * 编码 PNG。
 * @param {Uint8Array} data 紧凑像素数据
 * @param {number} colorType 2=RGB（3通道）或 0=灰度（1通道）
 */
export async function encodePNG(width, height, data, colorType = 2) {
  const channels = colorType === 0 ? 1 : 3;
  if (data.length !== width * height * channels) throw new Error('像素数据长度与尺寸不符');
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const src = data.subarray(y * stride, (y + 1) * stride);
    // 自适应滤波器：逐行取绝对字节和最小者
    const candidates = [
      { f: 0, bytes: new Uint8Array(stride) },
      { f: 1, bytes: new Uint8Array(stride) },
      { f: 2, bytes: new Uint8Array(stride) },
      { f: 3, bytes: new Uint8Array(stride) },
      { f: 4, bytes: new Uint8Array(stride) },
    ];
    for (let x = 0; x < stride; x++) {
      const v = src[x];
      const a = x >= channels ? src[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      candidates[0].bytes[x] = v;
      candidates[1].bytes[x] = v - a;
      candidates[2].bytes[x] = v - b;
      candidates[3].bytes[x] = v - ((a + b) >> 1);
      candidates[4].bytes[x] = v - paeth(a, b, c);
    }
    let best = candidates[0], bestScore = Infinity;
    for (const cand of candidates) {
      let score = 0;
      for (let i = 0; i < stride; i++) score += Math.abs(cand.bytes[i]);
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    const rowBase = y * (stride + 1);
    raw[rowBase] = best.f;
    for (let x = 0; x < stride; x++) raw[rowBase + 1 + x] = best.bytes[x] & 255;
    prev.set(src);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;          // 位深
  ihdr[9] = colorType;  // 颜色类型
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = await zlibDeflate(raw);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  return concat(parts);
}
