/*
 * hdr-engine.js — 曝光包围 HDR 合成引擎（无 DOM 依赖，浏览器 / Node 通用）
 *
 * 严格按样例包内《约定.json》实现：
 *  - 整数像素中心坐标、偏移对齐、共同覆盖矩形（左闭右开）
 *  - sRGB 线性化 + 三角帽权重 w(z)，整像素权重取三通道最小值
 *  - 加权辐射度恢复 sum(w*e)/sum(w)，e = srgb_decode(rgb)/exposure
 *  - log2 辐射度中位数运动检测，运动/无有效帧回退参考帧
 *  - Reinhard 整体色调映射（几何平均亮度 + key + 显示 EV）
 *  - PFM（PF，底行优先，小端 float32）导出未映射辐射度
 * 不调用任何现成 HDR 合成接口。
 */
(function (global) {
  'use strict';

  var INV_255 = 1 / 255;

  function ascii(u8, start, end) {
    var s = '';
    for (var i = start; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  // ---------- 基础传递函数 ----------

  // sRGB 码值 z∈[0,1] -> 线性光
  function srgbDecode(z) {
    return z <= 0.04045 ? z / 12.92 : Math.pow((z + 0.055) / 1.055, 2.4);
  }

  // 线性光 -> sRGB 码值
  function srgbEncode(l) {
    if (l <= 0) return 0;
    if (l >= 1) return 1;
    return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  }

  // 单通道权重：z<=0.02 或 z>=0.98 为 0，否则 1-|2z-1|
  function channelWeight(z) {
    if (z <= 0.02 || z >= 0.98) return 0;
    return 1 - Math.abs(2 * z - 1);
  }

  // ---------- PNG 头校验（8 位 RGB、非隔行、单边<=512） ----------

  function parsePNGInfo(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (var i = 0; i < 8; i++) {
      if (u8[i] !== sig[i]) throw new Error('不是合法的 PNG 文件');
    }
    if (u8.length < 24 || ascii(u8, 12, 16) !== 'IHDR') {
      throw new Error('PNG 缺少 IHDR 块');
    }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var width = dv.getUint32(16);
    var height = dv.getUint32(20);
    var bitDepth = u8[24];
    var colorType = u8[25];
    var interlace = u8[28];
    return { width: width, height: height, bitDepth: bitDepth, colorType: colorType, interlace: interlace };
  }

  function validatePNG(bytes) {
    var info = parsePNGInfo(bytes);
    if (info.bitDepth !== 8) throw new Error('仅支持 8 位 PNG（实际位深 ' + info.bitDepth + '）');
    if (info.colorType !== 2) throw new Error('仅支持 RGB 三通道 PNG（颜色类型 ' + info.colorType + '）');
    if (info.interlace !== 0) throw new Error('不支持隔行扫描 PNG');
    if (info.width > 512 || info.height > 512) {
      throw new Error('单边最多 512 像素（实际 ' + info.width + 'x' + info.height + '）');
    }
    return info;
  }

  // ---------- 对齐与共同覆盖区 ----------

  /*
   * frame 像素 (sx,sy) -> 共同坐标 (sx+dx, sy+dy)；
   * 换参考帧时减去其偏移。输出矩形相对参考帧像素坐标，左闭右开。
   * frames: [{dx, dy}], 所有帧同尺寸 W x H。
   */
  function computeCrop(frames, refIndex, W, H) {
    var refDx = frames[refIndex].dx;
    var refDy = frames[refIndex].dy;
    var x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (var i = 0; i < frames.length; i++) {
      var fx0 = frames[i].dx - refDx;            // 该帧在参考像素系中的覆盖矩形
      var fy0 = frames[i].dy - refDy;
      var fx1 = fx0 + W;
      var fy1 = fy0 + H;
      if (fx0 > x0) x0 = fx0;
      if (fy0 > y0) y0 = fy0;
      if (fx1 < x1) x1 = fx1;
      if (fy1 < y1) y1 = fy1;
    }
    if (x1 <= x0 || y1 <= y0) {
      throw new Error('各帧按给定偏移没有共同覆盖区域，无法合成');
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, width: x1 - x0, height: y1 - y0 };
  }

  // ---------- 核心恢复 ----------

  /*
   * frames: [{ name, rgb: Uint8Array(W*H*3, 8bit), exposure, dx, dy }]
   * opts: { reference, motionThresholdEv }
   * 返回裁剪区（参考像素系）上的两组辐射度及诊断图。
   */
  function recover(frames, W, H, opts) {
    opts = opts || {};
    var refIndex = opts.reference | 0;
    var thr = opts.motionThresholdEv != null ? opts.motionThresholdEv : 1;
    var N = frames.length;
    if (refIndex < 0 || refIndex >= N) throw new Error('参考帧下标越界');
    for (var i = 0; i < N; i++) {
      if (!(frames[i].exposure > 0)) throw new Error('第 ' + i + ' 帧曝光量必须为正数');
    }

    var crop = computeCrop(frames, refIndex, W, H);
    var cw = crop.width, ch = crop.height;
    var nPix = cw * ch;

    var radianceRaw = new Float32Array(nPix * 3);   // 剔除前（加权恢复）
    var radiance = new Float32Array(nPix * 3);      // 剔除后（运动回退参考帧）
    var motionMask = new Uint8Array(nPix);
    var noValidMask = new Uint8Array(nPix);
    var fallbackMask = new Uint8Array(nPix);       // 输出取参考帧的像素
    var weightSum = new Float32Array(nPix);
    var validCount = new Uint8Array(nPix);
    var contributions = new Array(N);
    for (i = 0; i < N; i++) contributions[i] = new Float32Array(nPix);

    var refDx = frames[refIndex].dx;
    var refDy = frames[refIndex].dy;
    var refRGB = frames[refIndex].rgb;
    var refExposure = frames[refIndex].exposure;

    // 每像素临时缓冲
    var w = new Float64Array(N);
    var e0 = new Float64Array(N), e1 = new Float64Array(N), e2 = new Float64Array(N);
    var log0 = new Float64Array(N), log1 = new Float64Array(N), log2 = new Float64Array(N);
    var validIdx = new Int32Array(N);

    for (var oy = 0; oy < ch; oy++) {
      var ry = crop.y0 + oy;
      for (var ox = 0; ox < cw; ox++) {
        var rx = crop.x0 + ox;
        var out = oy * cw + ox;

        var nValid = 0, sumW = 0;
        var rawR = 0, rawG = 0, rawB = 0;

        for (var f = 0; f < N; f++) {
          var fr = frames[f];
          var sx = rx + refDx - fr.dx;
          var sy = ry + refDy - fr.dy;
          var si = (sy * W + sx) * 3;
          var z0 = fr.rgb[si] * INV_255;
          var z1 = fr.rgb[si + 1] * INV_255;
          var z2 = fr.rgb[si + 2] * INV_255;
          var wc0 = channelWeight(z0);
          var wc1 = channelWeight(z1);
          var wc2 = channelWeight(z2);
          var ww = Math.min(wc0, wc1, wc2);   // 整像素权重取三通道最小
          w[f] = ww;
          var invE = 1 / fr.exposure;
          var er = srgbDecode(z0) * invE;
          var eg = srgbDecode(z1) * invE;
          var eb = srgbDecode(z2) * invE;
          e0[f] = er; e1[f] = eg; e2[f] = eb;
          if (ww > 0) {
            validIdx[nValid++] = f;
            sumW += ww;
            rawR += ww * er;
            rawG += ww * eg;
            rawB += ww * eb;
          }
        }

        weightSum[out] = sumW;
        validCount[out] = nValid;

        // 参考帧线性 RGB / 曝光（参考帧在裁剪区内恒有像素）
        var ri = (ry * W + rx) * 3;
        var refR = srgbDecode(refRGB[ri] * INV_255) / refExposure;
        var refG = srgbDecode(refRGB[ri + 1] * INV_255) / refExposure;
        var refB = srgbDecode(refRGB[ri + 2] * INV_255) / refExposure;

        if (nValid === 0) {
          // 整组饱和或全黑：无有效帧，确定性回退参考，不计运动
          noValidMask[out] = 1;
          fallbackMask[out] = 1;
          radianceRaw[out * 3] = radiance[out * 3] = refR;
          radianceRaw[out * 3 + 1] = radiance[out * 3 + 1] = refG;
          radianceRaw[out * 3 + 2] = radiance[out * 3 + 2] = refB;
          continue;
        }

        rawR /= sumW; rawG /= sumW; rawB /= sumW;
        radianceRaw[out * 3] = rawR;
        radianceRaw[out * 3 + 1] = rawG;
        radianceRaw[out * 3 + 2] = rawB;

        // 曝光贡献占比
        for (f = 0; f < N; f++) {
          if (w[f] > 0) contributions[f][out] = w[f] / sumW;
        }

        // 运动检测：有效帧每通道 log2(max(e,1e-6)) 的中位数（偶数取两中值平均）
        for (var k = 0; k < nValid; k++) {
          var fi = validIdx[k];
          log0[k] = Math.log2(Math.max(e0[fi], 1e-6));
          log1[k] = Math.log2(Math.max(e1[fi], 1e-6));
          log2[k] = Math.log2(Math.max(e2[fi], 1e-6));
        }
        var m0 = median(log0, nValid);
        var m1 = median(log1, nValid);
        var m2 = median(log2, nValid);

        var isMotion = false;
        for (k = 0; k < nValid && !isMotion; k++) {
          fi = validIdx[k];
          if (Math.abs(log0[k] - m0) > thr ||
              Math.abs(log1[k] - m1) > thr ||
              Math.abs(log2[k] - m2) > thr) {
            isMotion = true;
          }
        }

        if (isMotion) {
          motionMask[out] = 1;
          fallbackMask[out] = 1;
          radiance[out * 3] = refR;
          radiance[out * 3 + 1] = refG;
          radiance[out * 3 + 2] = refB;
        } else {
          radiance[out * 3] = rawR;
          radiance[out * 3 + 1] = rawG;
          radiance[out * 3 + 2] = rawB;
        }
      }
    }

    return {
      width: cw,
      height: ch,
      crop: crop,
      reference: refIndex,
      radianceRaw: radianceRaw,
      radiance: radiance,
      motionMask: motionMask,
      noValidMask: noValidMask,
      fallbackMask: fallbackMask,
      weightSum: weightSum,
      validCount: validCount,
      contributions: contributions
    };
  }

  function median(buf, n) {
    var arr = Array.prototype.slice.call(buf, 0, n).sort(function (a, b) { return a - b; });
    if (n & 1) return arr[n >> 1];
    return 0.5 * (arr[n / 2 - 1] + arr[n / 2]);
  }

  // ---------- 整体色调映射 ----------

  /*
   * L  = 0.2126R+0.7152G+0.0722B
   * Lavg = exp(mean(log(1e-6+L)))
   * Lm = key*2^EV*L/Lavg；Ld = Lm/(1+Lm)
   * 线性 RGB 乘 Ld/max(L,1e-6)，限幅后 sRGB 编码
   */
  function toneMap(radiance, width, height, opts) {
    opts = opts || {};
    var key = opts.key != null ? opts.key : 0.18;
    var ev = opts.ev != null ? opts.ev : 0;
    var n = width * height;
    var sumLog = 0;
    for (var p = 0; p < n; p++) {
      var i = p * 3;
      var L = 0.2126 * radiance[i] + 0.7152 * radiance[i + 1] + 0.0722 * radiance[i + 2];
      sumLog += Math.log(1e-6 + L);
    }
    var Lavg = Math.exp(sumLog / n);
    var gain = key * Math.pow(2, ev) / Lavg;

    var out = new Uint8ClampedArray(n * 3);
    for (p = 0; p < n; p++) {
      i = p * 3;
      var r = radiance[i], g = radiance[i + 1], b = radiance[i + 2];
      L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var Lm = gain * L;
      var Ld = Lm / (1 + Lm);
      var s = Ld / Math.max(L, 1e-6);
      out[i] = Math.round(srgbEncode(r * s) * 255);
      out[i + 1] = Math.round(srgbEncode(g * s) * 255);
      out[i + 2] = Math.round(srgbEncode(b * s) * 255);
    }
    return { bytes: out, lavg: Lavg };
  }

  // ---------- PFM 导出：PF，底行优先，RGB 交错，小端 float32 ----------

  function encodePFM(radiance, width, height) {
    var header = 'PF\n' + width + ' ' + height + '\n-1.0\n';
    var headerBytes = [];
    for (var i = 0; i < header.length; i++) headerBytes.push(header.charCodeAt(i) & 255);
    var rowBytes = width * 3 * 4;
    var u8 = new Uint8Array(headerBytes.length + rowBytes * height);
    u8.set(headerBytes, 0);
    var dv = new DataView(u8.buffer);
    var off = headerBytes.length;
    for (var y = height - 1; y >= 0; y--) {        // 底行优先
      var rowStart = y * width * 3;
      for (var k = 0; k < width * 3; k++) {
        dv.setFloat32(off, radiance[rowStart + k], true);  // 小端
        off += 4;
      }
    }
    return u8;
  }

  // ---------- PNG 编码（8 位 RGB、非隔行；零依赖，zlib 存储块） ----------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    var c = 0xFFFFFFFF;
    for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(bytes) {
    var a = 1, b = 0;
    for (var i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function pushBE32(arr, v) {
    arr.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }

  function pngChunk(type, data) {
    var out = [];
    pushBE32(out, data.length);
    var typeStart = out.length;
    for (var i = 0; i < 4; i++) out.push(type.charCodeAt(i));
    for (i = 0; i < data.length; i++) out.push(data[i]);
    var crcInput = new Uint8Array(out.length - typeStart + data.length);
    // CRC 覆盖 type + data
    var p = 0;
    for (i = typeStart; i < out.length; i++) crcInput[p++] = out[i];
    pushBE32(out, crc32(crcInput, 0, crcInput.length));
    return out;
  }

  /*
   * 输入 rgb: Uint8Array(width*height*3)，输出完整 8 位 RGB PNG（filter type 0 + zlib 存储块）
   */
  function encodePNG(rgb, width, height) {
    var stride = width * 3;
    var raw = new Uint8Array((stride + 1) * height);
    for (var y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;   // filter: None
      var rowBase = y * (stride + 1);
      var srcBase = y * stride;
      for (var px = 0; px < stride; px++) raw[rowBase + 1 + px] = rgb[srcBase + px];
    }
    // zlib 流：CMF=0x78 FLG=0x01，分块用 BTYPE=00（不压缩）
    var zlib = [0x78, 0x01];
    var off = 0;
    while (off < raw.length) {
      var chunk = Math.min(65535, raw.length - off);
      var last = off + chunk >= raw.length ? 1 : 0;
      zlib.push(last);
      zlib.push(chunk & 255, (chunk >> 8) & 255);
      var nlen = (~chunk) & 0xFFFF;
      zlib.push(nlen & 255, (nlen >> 8) & 255);
      for (var i = 0; i < chunk; i++) zlib.push(raw[off + i]);
      off += chunk;
    }
    pushBE32(zlib, adler32(raw));

    var ihdr = [];
    pushBE32(ihdr, width);
    pushBE32(ihdr, height);
    ihdr.push(8, 2, 0, 0, 0);   // 8bit, color type 2 (RGB), no interlace

    var bytes = [137, 80, 78, 71, 13, 10, 26, 10];
    bytes = bytes.concat(pngChunk('IHDR', ihdr));
    bytes = bytes.concat(pngChunk('IDAT', zlib));
    bytes = bytes.concat(pngChunk('IEND', []));
    return new Uint8Array(bytes);
  }

  // ---------- 导出清单 JSON ----------

  /*
   * 汇总一次合成的全部参数与裁剪坐标，供导出 JSON 使用。
   */
  function buildExportMeta(params) {
    var r = params.result;
    var frames = params.frames.map(function (f, i) {
      return {
        file: f.name,
        exposure: f.exposure,
        offset: [f.dx, f.dy],
        is_reference: i === r.reference,
        mean_weight_share: meanOf(r.contributions[i])
      };
    });
    var n = r.width * r.height;
    return {
      reference: r.reference,
      parameters: {
        key: params.key,
        display_ev: params.ev,
        motion_threshold_ev: params.motionThresholdEv
      },
      crop: {
        coordinate_space: 'reference_frame_pixels',
        interval: 'left_closed_right_open',
        x0: r.crop.x0,
        y0: r.crop.y0,
        x1: r.crop.x1,
        y1: r.crop.y1,
        width: r.width,
        height: r.height
      },
      frames: frames,
      stats: {
        output_width: r.width,
        output_height: r.height,
        motion_pixels: countMask(r.motionMask),
        no_valid_frame_pixels: countMask(r.noValidMask),
        reference_fallback_pixels: countMask(r.fallbackMask),
        geometric_mean_luminance: params.lavg
      },
      files: {
        pfm: params.pfmName,
        preview_png: params.pngName
      },
      pipeline_note: 'PFM 为未映射线性辐射度（不含显示曝光补偿）；PNG 为 Reinhard 整体色调映射预览'
    };
  }

  function meanOf(a) {
    if (!a.length) return 0;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function countMask(m) {
    var c = 0;
    for (var i = 0; i < m.length; i++) c += m[i];
    return c;
  }

  // ---------- 配置校验与归一化 ----------

  /*
   * manifest: 解析后的 JSON；files: 可用文件名集合（可选）
   * 返回 { reference, frames: [{file, exposure, dx, dy}] }
   */
  function normalizeManifest(manifest, availableNames) {
    if (!manifest || typeof manifest !== 'object') throw new Error('JSON 内容不是对象');
    if (!Array.isArray(manifest.frames)) throw new Error('JSON 缺少 frames 数组');
    var n = manifest.frames.length;
    if (n < 2 || n > 7) throw new Error('帧数必须在 2 到 7 之间（实际 ' + n + '）');
    var frames = [];
    for (var i = 0; i < n; i++) {
      var fr = manifest.frames[i];
      if (!fr || typeof fr.file !== 'string') throw new Error('第 ' + i + ' 帧缺少 file 字段');
      if (availableNames && availableNames.indexOf(fr.file) < 0) {
        throw new Error('清单引用的文件缺失：' + fr.file);
      }
      if (typeof fr.exposure !== 'number' || !(fr.exposure > 0)) {
        throw new Error('第 ' + i + ' 帧 exposure 必须为正数');
      }
      if (!Array.isArray(fr.offset) || fr.offset.length !== 2 ||
          !Number.isInteger(fr.offset[0]) || !Number.isInteger(fr.offset[1])) {
        throw new Error('第 ' + i + ' 帧 offset 必须是两个整数');
      }
      frames.push({ file: fr.file, exposure: fr.exposure, dx: fr.offset[0], dy: fr.offset[1] });
    }
    var reference = manifest.reference != null ? manifest.reference : 0;
    if (!Number.isInteger(reference) || reference < 0 || reference >= n) {
      throw new Error('reference 必须是 [0,' + (n - 1) + '] 内的整数');
    }
    return { reference: reference, frames: frames };
  }

  // 无清单时的手动默认配置（曝光 1、偏移 0）
  function defaultManifest(fileNames) {
    return {
      reference: 0,
      frames: fileNames.map(function (f) {
        return { file: f, exposure: 1, dx: 0, dy: 0 };
      })
    };
  }

  var HDR = {
    srgbDecode: srgbDecode,
    srgbEncode: srgbEncode,
    channelWeight: channelWeight,
    parsePNGInfo: parsePNGInfo,
    validatePNG: validatePNG,
    computeCrop: computeCrop,
    recover: recover,
    median: median,
    toneMap: toneMap,
    encodePFM: encodePFM,
    encodePNG: encodePNG,
    crc32: crc32,
    adler32: adler32,
    buildExportMeta: buildExportMeta,
    normalizeManifest: normalizeManifest,
    defaultManifest: defaultManifest,
    DEFAULTS: { key: 0.18, ev: 0, motionThresholdEv: 1 }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HDR;
  } else {
    global.HDR = HDR;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
