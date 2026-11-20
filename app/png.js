// 自包含 PNG 解码：仅灰度（color type 0），位深 1/2/4/8/16，无交错。
// 输出统一为 Uint16Array 行优先节点标量（像素即网格节点）。
// 16 位 PNG 必须保留全精度，不能走浏览器 ImageData（会被截断到 8 位）。

import { rawInflate } from "./inflate.js";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw, width, height, bpp, scanline) {
  const out = new Uint8Array(height * scanline);
  let src = 0;
  let dst = 0;
  for (let r = 0; r < height; r++) {
    const filterType = raw[src++];
    const lineStart = dst;
    const prevStart = lineStart - scanline; // 上一行在 out 中的起点（首行时为负）
    for (let i = 0; i < scanline; i++) {
      const x = raw[src++];
      const a = i >= bpp ? out[lineStart + i - bpp] : 0;
      const b = r > 0 ? out[prevStart + i] : 0;
      const c = r > 0 && i >= bpp ? out[prevStart + i - bpp] : 0;
      let v;
      switch (filterType) {
        case 0: v = x; break;
        case 1: v = (x + a) & 255; break;
        case 2: v = (x + b) & 255; break;
        case 3: v = (x + ((a + b) >> 1)) & 255; break;
        case 4: v = (x + paeth(a, b, c)) & 255; break;
        default: throw new Error(`PNG: 不支持的过滤器类型 ${filterType}`);
      }
      out[lineStart + i] = v;
    }
    dst += scanline;
  }
  return out;
}

export function decodePng(bytes) {
  if (
    bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a
  ) {
    throw new Error("PNG: 文件签名不正确");
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < bytes.length) {
    const length = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
      height = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filterMethod = data[11];
      interlace = data[12];
      if (compression !== 0 || filterMethod !== 0) throw new Error("PNG: 不支持的压缩/过滤方式");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height) throw new Error("PNG: 缺少 IHDR");
  if (colorType !== 0) throw new Error(`PNG: 仅支持灰度图（color type 0），当前为 ${colorType}`);
  if (interlace !== 0) throw new Error("PNG: 不支持 Adam7 交错图像");
  const allowedDepths = { 1: true, 2: true, 4: true, 8: true, 16: true };
  if (!allowedDepths[bitDepth]) throw new Error(`PNG: 不支持的位深 ${bitDepth}`);
  if (width < 2 || height < 2 || width > 1024 || height > 1024) {
    throw new Error(`PNG: 网格节点数每边须在 2..1024，当前 ${width}x${height}`);
  }
  const bpp = bitDepth === 16 ? 2 : 1; // 灰度每像素字节数（扫描线反过滤用）
  const bitsPerScanline = width * bitDepth;
  const scanline = (bitsPerScanline + 7) >> 3;
  const inflated = rawInflate(new Uint8Array(concatChunks(idat)));
  const pixels = unfilter(inflated, width, height, bpp, scanline);

  const values = new Uint16Array(width * height);
  if (bitDepth === 16) {
    for (let i = 0; i < width * height; i++) {
      values[i] = (pixels[2 * i] << 8) | pixels[2 * i + 1];
    }
  } else if (bitDepth === 8) {
    for (let i = 0; i < width * height; i++) values[i] = pixels[i];
  } else {
    const samplesPerByte = 8 / bitDepth;
    const maxSample = (1 << bitDepth) - 1;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const byteIndex = r * scanline + (c / samplesPerByte | 0);
        const shift = 8 - bitDepth * ((c % samplesPerByte) + 1);
        values[r * width + c] = (pixels[byteIndex] >> shift) & maxSample;
      }
    }
  }
  return { width, height, bitDepth, values };
}

function concatChunks(chunks) {
  let total = 0;
  for (const ch of chunks) total += ch.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    merged.set(ch, off);
    off += ch.length;
  }
  return merged;
}

// 掩膜解析：同尺寸、0 与 255（任意 >0 视为有效，但只容忍纯 0/255 以外的灰度并按 >127 处理）
export function decodeMask(bytes, expectW, expectH) {
  const img = decodePng(bytes);
  if (img.width !== expectW || img.height !== expectH) {
    throw new Error(`掩膜: 尺寸 ${img.width}x${img.height} 与图像 ${expectW}x${expectH} 不一致`);
  }
  const valid = new Uint8Array(expectW * expectH);
  for (let i = 0; i < valid.length; i++) valid[i] = img.values[i] > 127 ? 1 : 0;
  return valid;
}
