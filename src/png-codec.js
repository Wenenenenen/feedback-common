// png-codec.js — Minimal self-written PNG codec.
// Decoder: 8-bit, non-interlaced PNG only (all color types converted to RGBA).
// Encoder: 8-bit RGBA, non-interlaced, adaptive row filtering.
// zlib is delegated to pako; everything else (chunk framing, unfiltering, filtering) is hand-rolled.
import { inflate as pakoInflate, deflate as pakoDeflate } from '../lib/pako.esm.mjs';
import { crc32 } from './crc32.js';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decode a complete standalone PNG (Uint8Array) into { width, height, rgba: Uint8ClampedArray }.
export function decodePng(bytes) {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    throw new Error('PNG 签名无效');
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let seenIhdr = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`截断：偏移 ${offset} 处块头不完整（需要 8 字节，剩余 ${bytes.length - offset}）`);
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = dv.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    const crcEnd = bodyEnd + 4;
    if (crcEnd > bytes.length) {
      throw new Error(`截断：${type} 块 @${offset} 声明 ${length} 字节，文件仅剩 ${bytes.length - bodyStart} 字节`);
    }
    const storedCrc = dv.getUint32(bodyEnd);
    const actualCrc = crc32(bytes, offset + 4, bodyEnd);
    if (storedCrc !== actualCrc) {
      throw new Error(`CRC 错误：${type} 块 @${offset}，存储值 0x${storedCrc.toString(16).padStart(8, '0')}，计算值 0x${actualCrc.toString(16).padStart(8, '0')}`);
    }
    const body = bytes.subarray(bodyStart, bodyEnd);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error(`IHDR 长度非法 @${offset}：${length}`);
      const iv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = iv.getUint32(0);
      height = iv.getUint32(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
      if (!(colorType in COLOR_CHANNELS)) throw new Error(`不支持的颜色类型 ${colorType}（IHDR @${offset}）`);
      if (interlace !== 0) throw new Error(`不支持隔行 PNG（interlace=${interlace}，IHDR @${offset}）`);
      if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG（当前位深 ${bitDepth}，IHDR @${offset}）`);
      seenIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(body.slice());
    } else if (type === 'IEND') {
      break;
    }
    offset = crcEnd;
  }
  if (!seenIhdr) throw new Error('缺少 IHDR 块');
  if (!idat.length) throw new Error('缺少 IDAT 块');

  const channels = COLOR_CHANNELS[colorType];
  const stride = width * channels;
  let raw;
  try {
    raw = pakoInflate(new Uint8Array(Buffer_concat(idat)));
  } catch (e) {
    throw new Error(`zlib 解压失败：${e.message}`);
  }
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`图像数据截断：解码出 ${raw.length} 字节，需要 ${expected} 字节`);
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    line.set(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const x = line[i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paethPredictor(a, b, c); break;
        default: throw new Error(`未知行过滤器类型 ${filter}（第 ${y} 行）`);
      }
      line[i] = v & 0xff;
    }
    prev.set(line);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 6) {
        rgba[o] = line[s]; rgba[o + 1] = line[s + 1]; rgba[o + 2] = line[s + 2]; rgba[o + 3] = line[s + 3];
      } else if (colorType === 2) {
        rgba[o] = line[s]; rgba[o + 1] = line[s + 1]; rgba[o + 2] = line[s + 2]; rgba[o + 3] = 255;
      } else if (colorType === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[s]; rgba[o + 3] = 255;
      } else if (colorType === 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[s]; rgba[o + 3] = line[s + 1];
      }
    }
  }
  return { width, height, rgba };
}

function Buffer_concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function chunkBytes(type, body) {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(typeBytes, 4);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Encode RGBA pixels into a standalone 8-bit RGBA non-interlaced PNG.
export function encodePng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // no interlace

  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const outStart = y * (stride + 1);
    // Adaptive: compute sum of absolute differences for filters 0..4 and pick the smallest.
    const candidates = [0, 1, 2, 3, 4].map((f) => {
      const filtered = new Uint8Array(stride);
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgba[rowStart + i];
        const a = i >= 4 ? rgba[rowStart + i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let v;
        switch (f) {
          case 0: v = x; break;
          case 1: v = x - a; break;
          case 2: v = x - b; break;
          case 3: v = x - ((a + b) >> 1); break;
          case 4: v = x - paethPredictor(a, b, c); break;
        }
        v &= 0xff;
        filtered[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      return { f, filtered, sum };
    });
    candidates.sort((p, q) => p.sum - q.sum);
    const best = candidates[0];
    raw[outStart] = best.f;
    raw.set(best.filtered, outStart + 1);
    prev.set(rgba.subarray(rowStart, rowStart + stride));
  }
  const compressed = pakoDeflate(raw, { level: 9 });
  return concatBytes([
    PNG_SIGNATURE.slice(),
    chunkBytes('IHDR', ihdr),
    chunkBytes('IDAT', compressed),
    chunkBytes('IEND', new Uint8Array(0)),
  ]);
}
