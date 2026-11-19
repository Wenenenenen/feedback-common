// PNG 读写（8 位灰度 / 灰度+Alpha / RGB / 二值掩膜），自研过滤与 chunk 处理，
// 压缩统一走平台 zlib（浏览器 CompressionStream / Node zlib）。
let nodeZlib = null;
try {
  if (typeof CompressionStream === 'undefined') {
    const mod = await import('node:zlib');
    nodeZlib = mod.default;
  }
} catch { /* 浏览器环境 */ }

async function deflate(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new Uint8Array(nodeZlib.deflateSync(Buffer.from(bytes), { level: 9 }));
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new Uint8Array(nodeZlib.inflateSync(Buffer.from(bytes)));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * 解码 PNG。返回 {width,height,channels,colorType,data(Uint8ClampedArray)}。
 * 仅支持 bitDepth=8、非隔行；灰度/灰度+Alpha/RGB/RGBA。
 */
export async function decodePNG(fileBytes) {
  const buf = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('不是有效的 PNG 文件');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1;
  const idat = [];
  while (pos < buf.length) {
    const len = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 && !(bitDepth === 1 && colorType === 0)) {
    throw new Error(`仅支持 8 位灰度/RGB 图像或 1 位二值掩膜，当前位深 ${bitDepth}`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);
  const raw = await inflate(concat(idat));
  const bpp = bitDepth === 1 ? 1 : channels; // 反过滤按字节计
  const stride = bitDepth === 1 ? Math.ceil(width / 8) : width * channels;
  const unfiltered = new Uint8ClampedArray(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const left = x >= bpp ? unfiltered[rowStart + x - bpp] : 0;
      const up = y > 0 ? unfiltered[rowStart - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? unfiltered[rowStart - stride + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + left; break;
        case 2: val = v + up; break;
        case 3: val = v + ((left + up) >> 1); break;
        case 4: val = v + paeth(left, up, upLeft); break;
        default: throw new Error('未知 PNG 过滤器 ' + filter);
      }
      unfiltered[rowStart + x] = val & 0xff;
    }
  }
  if (bitDepth === 1) {
    const out = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      const rowStart = y * stride;
      for (let x = 0; x < width; x++) {
        const bit = (unfiltered[rowStart + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[y * width + x] = bit ? 255 : 0;
      }
    }
    return { width, height, channels: 1, colorType, bitDepth, data: out };
  }
  return { width, height, channels, colorType, bitDepth, data: unfiltered };
}

/** 任意解码结果 -> 单通道灰度（RGB 用 ITU-R 601-1 加权） */
export function toGrayChannel(decoded) {
  const { width, height, channels, colorType, data } = decoded;
  const gray = new Uint8ClampedArray(width * height);
  if (channels === 1) {
    gray.set(data);
  } else if (colorType === 4) {
    for (let i = 0; i < width * height; i++) gray[i] = data[i * 2];
  } else {
    for (let i = 0; i < width * height; i++) {
      const o = i * channels;
      gray[i] = Math.round((data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000);
    }
  }
  return gray;
}

/** 掩膜解码：非零像素视为有效域；灰度+Alpha/RGBA 时优先用 alpha 通道 */
export function toMask(decoded) {
  const { width, height, channels, colorType, data } = decoded;
  const mask = new Uint8Array(width * height);
  if (colorType === 4 || colorType === 6) {
    const ai = channels - 1;
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * channels + ai] > 0 ? 1 : 0;
  } else if (channels === 1) {
    for (let i = 0; i < mask.length; i++) mask[i] = data[i] > 0 ? 1 : 0;
  } else {
    for (let i = 0; i < mask.length; i++) {
      const o = i * channels;
      mask[i] = (data[o] || data[o + 1] || data[o + 2]) ? 1 : 0;
    }
  }
  return mask;
}

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
  const buf = new Uint8Array(data.length + 12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(data, 8);
  dv.setUint32(data.length + 8, crc32(buf.subarray(4, data.length + 8)));
  return buf;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 编码 8 位灰度 PNG；bitDepth=1 时输出二值掩膜 PNG（非零 => 1） */
export async function encodeGrayPNG(gray, width, height, bitDepth = 8) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = 0;
  let raw;
  if (bitDepth === 8) {
    raw = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width + 1)] = 0;
      raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    }
  } else {
    const stride = Math.ceil(width / 8);
    raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const rowOff = y * (stride + 1);
      for (let x = 0; x < width; x++) {
        if (gray[y * width + x]) raw[rowOff + 1 + (x >> 3)] |= 0x80 >>> (x & 7);
      }
    }
  }
  const compressed = await deflate(raw);
  return concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
