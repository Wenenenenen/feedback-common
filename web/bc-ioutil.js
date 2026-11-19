/*
 * Image I/O, DDS serialization, metrics and export helpers for the
 * BC block inspection tool. Depends only on bc-codec.js (global BCC).
 */
(function (root) {
  'use strict';

  // ---------- PNG decoding (8-bit, non-interlaced; common color types) ----------
  // Uses the browser-native DecompressionStream for the IDAT zlib payload.
  async function decodePNGAsync(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('不是 PNG 文件');
    const dv = new DataView(arrayBuffer);
    let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
    let palette = null, trns = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
        bitDepth = data[8]; colorType = data[9];
        if (data[12] !== 0) throw new Error('不支持交错 PNG');
      } else if (type === 'PLTE') palette = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (bitDepth !== 8) throw new Error('只支持 8 位 PNG (8-bit required)，该文件位深为 ' + bitDepth);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error('不支持的 PNG 颜色类型 ' + colorType);

    const merged = concatBytes(idat);
    // Pure-JS RFC1951 inflate (bc-inflate.js); avoids depending on the
    // DecompressionStream/Response pipeline, which is unavailable in some
    // embedded and headless browsers.
    const raw = BINFLATE.inflateZlib(merged);

    const stride = width * channels;
    const rgba = new Uint8ClampedArray(width * height * 4);
    let src = 0;
    const prev = new Uint8Array(stride);
    const paeth = (a, b, c) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < height; y++) {
      const filter = raw[src++];
      const line = new Uint8Array(stride);
      for (let x = 0; x < stride; x++) {
        const rv = raw[src++];
        const a = x >= channels ? line[x - channels] : 0;
        const b = prev[x];
        const c = x >= channels ? prev[x - channels] : 0;
        let v;
        switch (filter) {
          case 0: v = rv; break;
          case 1: v = rv + a; break;
          case 2: v = rv + b; break;
          case 3: v = rv + ((a + b) >> 1); break;
          case 4: v = rv + paeth(a, b, c); break;
          default: throw new Error('PNG 过滤器类型非法: ' + filter);
        }
        line[x] = v & 255;
      }
      for (let x = 0; x < width; x++) {
        let r, g, b, al = 255;
        if (colorType === 6) {
          r = line[x * 4]; g = line[x * 4 + 1]; b = line[x * 4 + 2]; al = line[x * 4 + 3];
        } else if (colorType === 2) {
          r = line[x * 3]; g = line[x * 3 + 1]; b = line[x * 3 + 2];
        } else if (colorType === 4) {
          r = g = b = line[x * 2]; al = line[x * 2 + 1];
        } else if (colorType === 0) {
          r = g = b = line[x];
        } else if (colorType === 3) {
          const idx = line[x];
          r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
          if (trns && idx < trns.length) al = trns[idx];
        }
        const o = (y * width + x) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = al;
      }
      prev.set(line);
    }
    return { width, height, rgba };
  }

  function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // ---------- validation / padding ----------
  const MAX_SIDE = 1024;

  function validateImage(img) {
    if (img.width > MAX_SIDE || img.height > MAX_SIDE) {
      throw new Error('单边不能超过 1024 像素 (max 1024px)，当前 ' + img.width + '×' + img.height);
    }
    if (img.width === 0 || img.height === 0) throw new Error('图像尺寸为 0');
  }

  // Replicate rightmost column / bottom row to a multiple of 4.
  function padImage(img) {
    const pw = (img.width + 3) & ~3;
    const ph = (img.height + 3) & ~3;
    if (pw === img.width && ph === img.height) {
      return { pw, ph, rgba: img.rgba, reused: true };
    }
    const out = new Uint8ClampedArray(pw * ph * 4);
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(y, img.height - 1);
      for (let x = 0; x < pw; x++) {
        const sx = Math.min(x, img.width - 1);
        const so = (sy * img.width + sx) * 4, d = (y * pw + x) * 4;
        out[d] = img.rgba[so]; out[d + 1] = img.rgba[so + 1];
        out[d + 2] = img.rgba[so + 2]; out[d + 3] = img.rgba[so + 3];
      }
    }
    return { pw, ph, rgba: out, reused: false };
  }

  function cropToOriginal(rgba, pw, ph, w, h) {
    if (pw === w && ph === h) return rgba;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (y * pw + x) * 4, d = (y * w + x) * 4;
        out[d] = rgba[s]; out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
      }
    }
    return out;
  }

  // ---------- DDS writer (header strictly per 格式说明.md) ----------
  function buildDDS(payload, width, height, format) {
    const header = new ArrayBuffer(128);
    const dv = new DataView(header);
    const u8 = new Uint8Array(header);
    u8.set([0x44, 0x44, 0x53, 0x20], 0);          // "DDS "
    dv.setUint32(4, 124, true);                    // dwSize
    dv.setUint32(8, 0x000A1007, true);            // dwFlags
    dv.setUint32(12, height, true);               // dwHeight (original, unpadded)
    dv.setUint32(16, width, true);                // dwWidth
    dv.setUint32(20, payload.length, true);       // dwPitchOrLinearSize = blocks*blockBytes
    // 24..108 mostly zero; pixel format struct starts at 76.
    dv.setUint32(76, 32, true);                   // pf.dwSize
    dv.setUint32(80, 0x4, true);                  // pf.dwFlags = DDPF_FOURCC
    const fourcc = format === 'BC3' ? 'DXT5' : 'DXT1';
    u8.set([fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3)], 84);
    dv.setUint32(108, 0x1000, true);              // dwCaps
    return concatBytes([new Uint8Array(header), payload]);
  }

  function parseDDS(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'DDS ') throw new Error('不是 DDS 文件');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const height = dv.getUint32(12, true), width = dv.getUint32(16, true);
    const fourcc = String.fromCharCode(buf[84], buf[85], buf[86], buf[87]);
    if (fourcc !== 'DXT1' && fourcc !== 'DXT5') throw new Error('只支持 DXT1/DXT5（' + fourcc + '）');
    return {
      width, height,
      format: fourcc === 'DXT5' ? 'BC3' : 'BC1',
      payload: buf.subarray(128),
    };
  }

  // ---------- metrics ----------
  // Per-pixel RGB squared error (all 3 channels summed) and alpha error.
  // BC1: only pixels with source alpha>=128 count toward RGB stats.
  // BC3: RGB over all texels per spec, plus alpha channel separately.
  function computeStats(src, dec, width, height, format, blockGrid) {
    const perBlock = new Array(blockGrid.bw * blockGrid.bh);
    for (let i = 0; i < perBlock.length; i++) {
      perBlock[i] = { rgbSE: 0, rgbN: 0, alphaSE: 0, alphaN: 0, maxAbs: 0 };
    }
    let rgbSE = 0, rgbN = 0, alphaSE = 0, alphaN = 0, maxAbs = 0;
    const perPixel = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const bi = ((y >> 2) * blockGrid.bw) + (x >> 2);
        const rec = perBlock[bi];
        const countRGB = format === 'BC3' || src.rgba[o + 3] >= 128;
        let pixelSE = 0;
        if (countRGB) {
          for (let k = 0; k < 3; k++) {
            const d = src.rgba[o + k] - dec[o + k];
            rgbSE += d * d; rgbN++;
            rec.rgbSE += d * d; rec.rgbN++;
            pixelSE += d * d;
            rec.maxAbs = Math.max(rec.maxAbs, Math.abs(d));
            maxAbs = Math.max(maxAbs, Math.abs(d));
          }
        }
        perPixel[y * width + x] = pixelSE;
        if (format === 'BC3') {
          const d = src.rgba[o + 3] - dec[o + 3];
          alphaSE += d * d; alphaN++;
          rec.alphaSE += d * d; rec.alphaN++;
          rec.maxAbs = Math.max(rec.maxAbs, Math.abs(d));
        }
      }
    }
    const psnr = (se, n) => (se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n)));
    for (const rec of perBlock) {
      rec.rgbPsnr = rec.rgbN ? psnr(rec.rgbSE, rec.rgbN) : null;
      rec.alphaPsnr = rec.alphaN ? psnr(rec.alphaSE, rec.alphaN) : null;
      rec.rgbMse = rec.rgbN ? rec.rgbSE / rec.rgbN : null;
    }
    return {
      rgbPsnr: rgbN ? psnr(rgbSE, rgbN) : null,
      rgbMse: rgbN ? rgbSE / rgbN : null,
      alphaPsnr: alphaN ? psnr(alphaSE, alphaN) : null,
      alphaMse: alphaN ? alphaSE / alphaN : null,
      maxAbs, perBlock, perPixel,
    };
  }

  // ---------- JSON export ----------
  function buildExportJSON(opts) {
    const { fileName, format, src, width, height, paddedW, paddedH, stats, records, bw, bh } = opts;
    const blockOut = [];
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const bi = by * bw + bx;
        const rec = records[bi];
        const st = stats.perBlock[bi];
        const entry = {
          blockX: bx, blockY: by,
          color: {
            c0: '0x' + rec.color.c0.toString(16).padStart(4, '0'),
            c1: '0x' + rec.color.c1.toString(16).padStart(4, '0'),
            mode: rec.color.mode,
            indices: Array.from(rec.color.indices),
            palette: rec.color.palette.map((p) => Array.from(p)),
          },
          rgbMse: st.rgbMse,
          rgbPsnr: st.rgbPsnr === null ? null : Number(st.rgbPsnr.toFixed(4)),
          maxAbsChannelError: st.maxAbs,
        };
        if (format === 'BC3') {
          entry.alpha = {
            a0: rec.alpha.a0, a1: rec.alpha.a1,
            mode: rec.alpha.mode,
            table: Array.from(rec.alpha.table),
            indices: Array.from(rec.alpha.indices),
          };
          entry.alphaPsnr = st.alphaPsnr === null ? null : Number(st.alphaPsnr.toFixed(4));
        }
        blockOut.push(entry);
      }
    }
    return {
      source: fileName,
      format,
      originalSize: { width, height },
      paddedSize: { width: paddedW, height: paddedH },
      padding: paddedW === width && paddedH === height ? 'none' : 'replicate-edge',
      generatedAt: new Date().toISOString(),
      wholeImage: {
        rgbPsnr: stats.rgbPsnr === null ? null : Number(stats.rgbPsnr.toFixed(4)),
        rgbMse: stats.rgbMse === null ? null : Number(stats.rgbMse.toFixed(4)),
        alphaPsnr: stats.alphaPsnr === null ? null : Number(stats.alphaPsnr.toFixed(4)),
        alphaMse: stats.alphaMse === null ? null : Number(stats.alphaMse.toFixed(4)),
        maxAbsChannelError: stats.maxAbs,
        rgbPsnrNote: format === 'BC1'
          ? '按约定仅统计源 alpha>=128 的像素'
          : '按约定统计全部像素；全透明像素的源 RGB 不参与编码拟合',
      },
      blockCount: bw * bh,
      blocks: blockOut,
    };
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const BCUIO = {
    decodePNGAsync, validateImage, padImage, cropToOriginal,
    buildDDS, parseDDS, computeStats, buildExportJSON, downloadBlob,
    concatBytes,
  };
  root.BCUIO = BCUIO;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BCUIO;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
