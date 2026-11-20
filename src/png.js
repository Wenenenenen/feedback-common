/*
 * PNG 解码 / 编码（8 位，非隔行）
 *
 * 解码使用浏览器内置 DecompressionStream，不依赖任何图像库。
 * 输入要求 8 位 RGB（颜色类型 2），另外兼容灰度 0 与调色板 3，
 * 统一转换为 RGB；含 Alpha 的 PNG（4/6）与 16 位色深会明确拒绝。
 */
(function (root) {
  'use strict';

  var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function writeU32(b, o, v) {
    b[o] = (v >>> 24) & 255;
    b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255;
    b[o + 3] = v & 255;
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    var c = 0xffffffff;
    for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function inflateZlib(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压数据（DecompressionStream）');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function deflateZlib(bytes) {
    if (typeof CompressionStream !== 'function') {
      throw new Error('当前浏览器不支持压缩数据（CompressionStream）');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a);
    var pb = Math.abs(p - b);
    var pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  }

  async function decode(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 8) throw new Error('不是有效的 PNG 文件');
    for (var s = 0; s < 8; s++) {
      if (b[s] !== SIGNATURE[s]) throw new Error('不是有效的 PNG 文件');
    }
    var pos = 8;
    var width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
    var haveHeader = false;
    var palette = null;
    var hasTransparency = false;
    var idatParts = [];
    var idatLength = 0;
    var sawEnd = false;

    while (pos + 8 <= b.length) {
      var length = readU32(b, pos);
      var type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      var dataStart = pos + 8;
      if (dataStart + length + 4 > b.length) throw new Error('PNG 数据块被截断');
      var dataEnd = dataStart + length;

      if (type === 'IHDR') {
        if (length !== 13) throw new Error('PNG 头信息损坏');
        width = readU32(b, dataStart);
        height = readU32(b, dataStart + 4);
        bitDepth = b[dataStart + 8];
        colorType = b[dataStart + 9];
        var compression = b[dataStart + 10];
        var filterMethod = b[dataStart + 11];
        interlace = b[dataStart + 12];
        if (compression !== 0 || filterMethod !== 0) {
          throw new Error('PNG 使用了不支持的压缩或滤波方式');
        }
        haveHeader = true;
      } else if (type === 'PLTE') {
        if (length % 3 !== 0) throw new Error('PNG 调色板损坏');
        palette = b.subarray(dataStart, dataEnd);
      } else if (type === 'tRNS') {
        hasTransparency = true;
      } else if (type === 'IDAT') {
        idatParts.push(b.subarray(dataStart, dataEnd));
        idatLength += length;
      } else if (type === 'IEND') {
        sawEnd = true;
        break;
      }
      pos = dataEnd + 4;
    }

    if (!haveHeader) throw new Error('PNG 缺少头信息');
    if (width <= 0 || height <= 0) throw new Error('PNG 尺寸无效');
    if (!sawEnd && idatLength === 0) throw new Error('PNG 缺少像素数据');
    if (interlace !== 0) {
      throw new Error('不支持隔行扫描（Adam7）PNG，请另存为非隔行 PNG');
    }
    if (bitDepth !== 8) throw new Error('仅支持 8 位色深的 PNG（当前为 ' + bitDepth + ' 位）');
    if (colorType === 4 || colorType === 6) {
      throw new Error('PNG 含透明通道；请使用 8 位 RGB（无 Alpha）PNG');
    }
    if (hasTransparency) {
      throw new Error('PNG 带透明色信息；请使用 8 位 RGB（无 Alpha）PNG');
    }
    if (colorType !== 0 && colorType !== 2 && colorType !== 3) {
      throw new Error('不支持的 PNG 颜色类型（' + colorType + '）');
    }
    if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE 数据');
    if (width > 256 || height > 256) {
      throw new Error('图片为 ' + width + '×' + height + '，超过 256 像素的边长上限');
    }
    if (idatParts.length === 0) throw new Error('PNG 缺少像素数据');

    var idat = new Uint8Array(idatLength);
    var offset = 0;
    for (var p = 0; p < idatParts.length; p++) {
      idat.set(idatParts[p], offset);
      offset += idatParts[p].length;
    }
    var raw = await inflateZlib(idat);

    var channels = colorType === 2 ? 3 : 1;
    var stride = width * channels;
    var expected = (stride + 1) * height;
    if (raw.length < expected) throw new Error('PNG 像素数据长度不足');

    var pixels = new Uint8Array(stride * height);
    var prev = new Uint8Array(stride);
    var cur = new Uint8Array(stride);
    var rp = 0;
    for (var y = 0; y < height; y++) {
      var filter = raw[rp++];
      if (filter > 4) throw new Error('PNG 行滤波类型无效');
      cur.set(raw.subarray(rp, rp + stride));
      rp += stride;
      for (var i = 0; i < stride; i++) {
        var a = i >= channels ? cur[i - channels] : 0;
        var bb = prev[i];
        var c = i >= channels ? prev[i - channels] : 0;
        var v = cur[i];
        if (filter === 1) v = (v + a) & 255;
        else if (filter === 2) v = (v + bb) & 255;
        else if (filter === 3) v = (v + ((a + bb) >> 1)) & 255;
        else if (filter === 4) v = (v + paeth(a, bb, c)) & 255;
        cur[i] = v;
      }
      pixels.set(cur, y * stride);
      var tmp = prev;
      prev = cur;
      cur = tmp;
    }

    var N = width * height;
    var rgb = new Uint8Array(N * 3);
    if (colorType === 2) {
      rgb.set(pixels);
    } else if (colorType === 0) {
      for (var g = 0; g < N; g++) {
        var gv = pixels[g];
        rgb[g * 3] = gv;
        rgb[g * 3 + 1] = gv;
        rgb[g * 3 + 2] = gv;
      }
    } else {
      var paletteSize = palette.length / 3;
      for (var q = 0; q < N; q++) {
        var idx = pixels[q];
        if (idx >= paletteSize) throw new Error('PNG 调色板索引越界');
        rgb[q * 3] = palette[idx * 3];
        rgb[q * 3 + 1] = palette[idx * 3 + 1];
        rgb[q * 3 + 2] = palette[idx * 3 + 2];
      }
    }

    return { width: width, height: height, rgb: rgb, colorType: colorType };
  }

  function chunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    writeU32(out, 0, data.length);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  }

  async function encode(width, height, colorType, pixels) {
    var channels = colorType === 6 ? 4 : 1;
    if (pixels.length !== width * height * channels) throw new Error('像素数据长度不正确');
    var stride = width * channels;
    var raw = new Uint8Array((stride + 1) * height);
    for (var y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;
      raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    var compressed = await deflateZlib(raw);

    var ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, width);
    writeU32(ihdr, 4, height);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    var chunks = [
      new Uint8Array(SIGNATURE),
      chunk('IHDR', ihdr),
      chunk('IDAT', compressed),
      chunk('IEND', new Uint8Array(0))
    ];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  root.MattePng = { decode: decode, encode: encode };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decode: decode, encode: encode };
  }
})(typeof self !== 'undefined' ? self : globalThis);
