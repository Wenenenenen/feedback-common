/*
 * png.js — 零依赖 PNG 编解码（纯手写 DEFLATE/inflate + CRC32/Adler32 + 5 种行滤波）
 * 同时支持浏览器（挂到 window.MGSPng）与 Node（module.exports）。
 *
 * decode(arrayBuffer): 解码为
 *   { width, height, gray: Uint8ClampedArray(行主序灰度), channels, colorType, bitDepth }
 * 支持 8 位灰度、灰度+alpha、RGB/RGBA（转灰度）、索引色（PLTE/tRNS，转灰度），
 * 以及 1/2/4 位灰度与索引色；非交错与 Adam7 交错。
 * encodeGray(width, height, grayBytes): 编码 8 位灰度 PNG（ArrayBuffer）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MGSPng = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------- CRC32 / Adler32 ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(data) {
    let a = 1, b = 0;
    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /* ---------------- DEFLATE (RFC1951) inflate ---------------- */
  // 数据元素打包从字节最低位开始（RFC1951 §3.1.1）；Huffman 码先收 MSB，
  // 因此在 LSB 阅读器中把规范码反序后按 LSB 基址建表。
  function BitReader(bytes) {
    this.b = bytes;
    this.pos = 0;
    this.buf = 0;
    this.n = 0;
  }
  BitReader.prototype.bit = function () {
    if (this.n === 0) {
      this.buf = this.b[this.pos++];
      this.n = 8;
    }
    const v = this.buf & 1;
    this.buf >>= 1;
    this.n--;
    return v;
  };
  BitReader.prototype.bits = function (k) {
    let v = 0;
    for (let i = 0; i < k; i++) v |= this.bit() << i;
    return v;
  };
  BitReader.prototype.align = function () {
    this.buf = 0;
    this.n = 0;
  };

  function reverseBits(v, len) {
    let r = 0;
    for (let i = 0; i < len; i++) r = (r << 1) | ((v >> i) & 1);
    return r;
  }

  // 由码长构建规范 Huffman 解码器（RFC1951 §3.2.2，逐位解码）
  function buildHuffman(lengths) {
    const maxBits = Math.max.apply(null, lengths);
    const count = new Uint32Array(maxBits + 1);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i]) count[lengths[i]]++;
    }
    const firstCode = new Int32Array(maxBits + 1).fill(-1);
    const symbolsByLen = Array.from({ length: maxBits + 1 }, () => []);
    let code = 0;
    for (let bits = 1; bits <= maxBits; bits++) {
      code = (code + count[bits - 1]) << 1;
      if (count[bits]) firstCode[bits] = code;
    }
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s]) symbolsByLen[lengths[s]].push(s);
    }
    return { maxBits, firstCode, symbolsByLen };
  }

  // LSB 阅读器逐位接收（先到位在低位）；累积后反序得到 MSB 排列的规范码
  function decodeSymbol(br, h) {
    let buf = 0;
    for (let len = 1; len <= h.maxBits; len++) {
      buf |= br.bit() << (len - 1);
      const base = h.firstCode[len];
      if (base < 0) continue;
      let rev = 0;
      for (let k = 0; k < len; k++) rev = (rev << 1) | ((buf >> k) & 1);
      const offset = rev - base;
      const group = h.symbolsByLen[len];
      if (offset >= 0 && offset < group.length) return group[offset];
    }
    throw new Error("PNG inflate: 无效的 Huffman 码字");
  }

  const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function inflateRaw(input) {
    const br = new BitReader(input);
    const out = [];
    let bfinal = 0;
    do {
      bfinal = br.bit();
      const btype = br.bits(2);
      if (btype === 0) {
        br.align();
        const len = input[br.pos] | (input[br.pos + 1] << 8);
        br.pos += 4; // LEN + NLEN
        for (let i = 0; i < len; i++) out.push(input[br.pos++]);
      } else {
        let litHuff, distHuff;
        if (btype === 1) {
          const litLen = new Uint8Array(288);
          for (let i = 0; i < 144; i++) litLen[i] = 8;
          for (let i = 144; i < 256; i++) litLen[i] = 9;
          for (let i = 256; i < 280; i++) litLen[i] = 7;
          for (let i = 280; i < 288; i++) litLen[i] = 8;
          litHuff = buildHuffman(litLen);
          // 固定距离码：符号 0..29 码长均为 5（30/31 保留不用，码长必须留 0）
          const distLen = new Uint8Array(30);
          for (let i = 0; i < 30; i++) distLen[i] = 5;
          distHuff = buildHuffman(distLen);
        } else if (btype === 2) {
          const hlit = br.bits(5) + 257;
          const hdist = br.bits(5) + 1;
          const hclen = br.bits(4) + 4;
          const clLen = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) clLen[CL_ORDER[i]] = br.bits(3);
          const clHuff = buildHuffman(clLen);
          const all = new Uint8Array(hlit + hdist);
          let idx = 0;
          while (idx < all.length) {
            const sym = decodeSymbol(br, clHuff);
            if (sym < 16) {
              all[idx++] = sym;
            } else if (sym === 16) {
              const rep = br.bits(2) + 3;
              const v = all[idx - 1];
              for (let i = 0; i < rep; i++) all[idx++] = v;
            } else if (sym === 17) {
              const rep = br.bits(3) + 3;
              for (let i = 0; i < rep; i++) all[idx++] = 0;
            } else {
              const rep = br.bits(7) + 11;
              for (let i = 0; i < rep; i++) all[idx++] = 0;
            }
          }
          litHuff = buildHuffman(all.slice(0, hlit));
          distHuff = buildHuffman(all.slice(hlit));
        } else {
          throw new Error("PNG inflate: 保留块类型 3");
        }
        for (;;) {
          const sym = decodeSymbol(br, litHuff);
          if (sym === 256) break;
          if (sym < 256) {
            out.push(sym);
          } else {
            const li = sym - 257;
            const len = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
            const dsym = decodeSymbol(br, distHuff);
            const dist = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
            const start = out.length - dist;
            for (let i = 0; i < len; i++) out.push(out[start + i]);
          }
        }
      }
    } while (!bfinal);
    return new Uint8Array(out);
  }

  // zlib 包装（CMF/FLG + raw deflate + Adler32）
  function inflateZlib(bytes) {
    if ((bytes[0] & 0x0f) !== 8) throw new Error("PNG: 非 zlib 流");
    return inflateRaw(bytes.subarray(2, bytes.length - 4));
  }

  /* ---------------- DEFLATE 压缩（固定 Huffman 块） ---------------- */
  function LsbWriter() {
    this.bytes = [];
    this.buf = 0;
    this.n = 0;
  }
  LsbWriter.prototype.writeBits = function (value, len) {
    for (let i = 0; i < len; i++) {
      this.buf |= ((value >> i) & 1) << this.n;
      this.n++;
      if (this.n === 8) {
        this.bytes.push(this.buf);
        this.buf = 0;
        this.n = 0;
      }
    }
  };
  LsbWriter.prototype.flushByte = function () {
    if (this.n) {
      this.bytes.push(this.buf);
      this.buf = 0;
      this.n = 0;
    }
  };

  // 固定 Huffman 码（RFC1951 §3.2.6，按规范码值赋值；LSB 阅读器的反序由 buildHuffman 处理）
  const FIXED = (() => {
    const code = new Uint16Array(288);
    const bits = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) { code[i] = 0x30 + i; bits[i] = 8; }
    for (let i = 144; i <= 255; i++) { code[i] = 0x190 + (i - 144); bits[i] = 9; }
    for (let i = 256; i <= 279; i++) { code[i] = i - 256; bits[i] = 7; }
    for (let i = 280; i <= 287; i++) { code[i] = 0xC0 + (i - 280); bits[i] = 8; }
    return { code, bits };
  })();

  function deflateFixedBlock(w, data, bfinal) {
    w.writeBits(bfinal, 1);
    w.writeBits(1, 2); // 固定 Huffman
    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      // RFC1951：Huffman 码按 MSB 先打包进 LSB 位流，即写入反序码
      w.writeBits(reverseBits(FIXED.code[s], FIXED.bits[s]), FIXED.bits[s]);
    }
    w.writeBits(reverseBits(FIXED.code[256], FIXED.bits[256]), FIXED.bits[256]);
  }

  function deflateZlib(data) {
    const MAX_BLOCK = 65535;
    const w = new LsbWriter();
    let off = 0;
    if (data.length === 0) {
      deflateFixedBlock(w, data, 1);
    } else {
      while (off < data.length) {
        const chunk = data.subarray(off, Math.min(off + MAX_BLOCK, data.length));
        deflateFixedBlock(w, chunk, off + chunk.length >= data.length ? 1 : 0);
        off += chunk.length;
      }
    }
    w.flushByte();
    const body = new Uint8Array(w.bytes);
    const out = new Uint8Array(body.length + 6);
    out[0] = 0x78; out[1] = 0x01;
    out.set(body, 2);
    const ad = adler32(data);
    const dv = new DataView(out.buffer);
    dv.setUint32(out.length - 4, ad);
    return out;
  }

  /* ---------------- PNG 块与滤波 ---------------- */
  function chunk(type, data) {
    const bodyLen = 4 + data.length;       // 类型(4) + 数据
    const buf = new Uint8Array(bodyLen + 8); // 再加长度字段(4) 与 CRC(4)
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
    buf.set(data, 8);
    dv.setUint32(bodyLen + 4, crc32(buf, 4, bodyLen + 4));
    return buf;
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  function unfilter(raw, width, height, bpp, stride) {
    const out = new Uint8Array(height * stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const ftype = raw[pos++];
      const rowStart = y * stride;
      const prevStart = (y - 1) * stride;
      for (let i = 0; i < stride; i++) {
        const x = raw[pos++]; // 注意 pos 已含每行 1 字节 filter type 的偏移
        const a = i >= bpp ? out[rowStart + i - bpp] : 0;
        const b = y ? out[prevStart + i] : 0;
        const c = y && i >= bpp ? out[prevStart + i - bpp] : 0;
        let v;
        switch (ftype) {
          case 0: v = x; break;
          case 1: v = x + a; break;
          case 2: v = x + b; break;
          case 3: v = x + ((a + b) >> 1); break;
          default: v = x + paeth(a, b, c);
        }
        out[rowStart + i] = v & 255;
      }
    }
    return out;
  }

  // 从子像素字节流按位深展开为每采样一个字节
  function expandSamples(bytes, count, bitDepth) {
    if (bitDepth === 8) return bytes.slice(0, count);
    const out = new Uint8Array(count);
    const mask = (1 << bitDepth) - 1;
    for (let i = 0; i < count; i++) {
      const byteIdx = (i * bitDepth) >> 3;
      const shift = 8 - bitDepth - ((i * bitDepth) & 7);
      out[i] = (bytes[byteIdx] >> shift) & mask;
    }
    return out;
  }

  function deinterlaceAdam7(bytes, width, height, bpp, bitDepth) {
    // Adam7 起始坐标与步长
    const passes = [
      [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]
    ];
    const samplesPerPixel = bpp * 8 / bitDepth;
    const out = new Uint8Array(width * height * bpp);
    let pos = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.max(0, Math.ceil((width - x0) / dx));
      const ph = Math.max(0, Math.ceil((height - y0) / dy));
      if (!pw || !ph) continue;
      const stride = Math.ceil(pw * bpp * 8 / 8);
      const planeRawLen = ph * (stride + 1);
      const raw = bytes.subarray(pos, pos + planeRawLen);
      pos += planeRawLen;
      const plane = unfilter(raw, pw, ph, bpp, stride);
      for (let py = 0; py < ph; py++) {
        for (let px = 0; px < pw; px++) {
          const dstX = x0 + px * dx, dstY = y0 + py * dy;
          for (let s = 0; s < samplesPerPixel; s++) {
            const si = px * samplesPerPixel + s;
            const byteIdx = (si * bitDepth) >> 3;
            const shift = 8 - bitDepth - ((si * bitDepth) & 7);
            const v = (plane[py * stride + byteIdx] >> shift) & ((1 << bitDepth) - 1);
            const di = (dstY * width + dstX) * samplesPerPixel + s;
            const dByte = (di * bitDepth) >> 3;
            const dShift = 8 - bitDepth - ((di * bitDepth) & 7);
            out[dByte] = (out[dByte] & ~(((1 << bitDepth) - 1) << dShift)) | (v << dShift);
          }
        }
      }
    }
    return out;
  }

  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8 ||
      bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      throw new Error("不是 PNG 文件");
    }
    let pos = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let palette = null, trns = null;
    while (pos < bytes.length) {
      const len = (bytes[pos] << 24 | bytes[pos + 1] << 16 |
        bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5],
        bytes[pos + 6], bytes[pos + 7]);
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") {
        width = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
        height = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
        bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      } else if (type === "PLTE") {
        palette = data;
      } else if (type === "tRNS") {
        trns = data;
      } else if (type === "IDAT") {
        idat.push(data);
      } else if (type === "IEND") {
        break;
      }
      pos += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error("不支持的 PNG colorType=" + colorType);
    const bpp = Math.max(1, (channels * bitDepth) >> 3);
    const inflated = inflateZlib(concatBytes(idat));
    const stride = Math.ceil(width * channels * bitDepth / 8);
    const pixels = interlace
      ? deinterlaceAdam7(inflated, width, height, bpp, bitDepth)
      : unfilter(inflated, width, height, bpp, stride);

    const n = width * height;
    const gray = new Uint8ClampedArray(n);
    if (colorType === 0) {
      // 灰度
      const samples = expandSamples(pixels, n, bitDepth);
      const scale = 255 / ((1 << bitDepth) - 1);
      for (let i = 0; i < n; i++) gray[i] = Math.round(samples[i] * scale);
    } else if (colorType === 4) {
      // 灰度 + alpha（取灰度通道）
      const samples = expandSamples(pixels, n * 2, bitDepth);
      const scale = 255 / ((1 << bitDepth) - 1);
      for (let i = 0; i < n; i++) gray[i] = Math.round(samples[i * 2] * scale);
    } else if (colorType === 2 || colorType === 6) {
      // RGB(A) → ITU-R BT.601 灰度
      const samples = expandSamples(pixels, n * channels, bitDepth);
      const scale = bitDepth === 8 ? 1 : 255 / ((1 << bitDepth) - 1);
      for (let i = 0; i < n; i++) {
        const r = samples[i * channels] * scale;
        const g = samples[i * channels + 1] * scale;
        const b = samples[i * channels + 2] * scale;
        gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
    } else if (colorType === 3) {
      if (!palette) throw new Error("索引色 PNG 缺少 PLTE");
      const idx = expandSamples(pixels, n, bitDepth);
      for (let i = 0; i < n; i++) {
        const p = idx[i] * 3;
        const r = palette[p], g = palette[p + 1], b = palette[p + 2];
        gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    return { width, height, gray, channels, colorType, bitDepth };
  }

  function concatBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  /* ---------------- 编码 8 位灰度 PNG ---------------- */
  function encodeGray(width, height, gray) {
    if (gray.length !== width * height) throw new Error("灰度数据尺寸不符");
    const stride = width;
    const raw = new Uint8Array((stride + 1) * height);
    // 自适应选择每行滤波：None / Sub / Up / Average / Paeth 中代价最小
    for (let y = 0; y < height; y++) {
      const rowBase = y * (stride + 1);
      const srcBase = y * stride;
      const choices = [0, 1, 2, 3, 4];
      let best = null, bestCost = Infinity;
      for (const f of choices) {
        const line = new Uint8Array(stride);
        let cost = 0;
        for (let x = 0; x < stride; x++) {
          const v = gray[srcBase + x];
          const a = x ? gray[srcBase + x - 1] : 0;
          const b = y ? gray[srcBase - stride + x] : 0;
          const c = y && x ? gray[srcBase - stride + x - 1] : 0;
          let r;
          switch (f) {
            case 0: r = v; break;
            case 1: r = v - a; break;
            case 2: r = v - b; break;
            case 3: r = v - ((a + b) >> 1); break;
            default: r = v - paeth(a, b, c);
          }
          r &= 255;
          line[x] = r;
          // 绝对差启发式
          cost += r < 128 ? r : 256 - r;
        }
        if (cost < bestCost) { bestCost = cost; best = { f, line }; }
      }
      raw[rowBase] = best.f;
      raw.set(best.line, rowBase + 1);
    }
    const compressed = deflateZlib(raw);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 0;   // color type 0 = 灰度
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0))];
    return concatBytes(parts).buffer;
  }

  return { decode, encodeGray, _internals: { inflateZlib, deflateZlib, adler32, crc32 } };
});
