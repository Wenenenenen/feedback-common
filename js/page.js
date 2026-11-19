/*
 * 页面逻辑：载入素材 → 调用 PCR.analyze → 时间线 / 逐帧对比 / 导出。
 * 不依赖任何外部库：ZIP 与 PNG 的读写都用浏览器自带的 CompressionStream/DecompressionStream。
 */
(function () {
  'use strict';

  var state = {
    width: 0, height: 0,
    frames: [],          // Uint8Array 灰度（或取亮度）
    rgb: null,           // 可选：原始 RGB 帧（彩色素材）
    analysis: null,
    current: 0,
    diff: false,
    zoom: false,
    sourceName: '',
    thumbCache: new Map()
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = {};

  /* ------------------------------------------------------------------ */
  /* 工具                                                               */
  /* ------------------------------------------------------------------ */

  function setStatus(msg, isError) {
    el.status.textContent = msg;
    el.status.classList.toggle('err', !!isError);
  }

  function outputKind(o) {
    if (o.type === 'interlaced') return 'inter';
    return o.interpolated ? 'orphan' : 'film';
  }

  function kindLabel(o) {
    if (o.type === 'interlaced') return '纯隔行';
    if (o.interpolated) return '孤场插补';
    return o.exact ? '精确拼回' : '胶片格';
  }

  /* ------------------------------------------------------------------ */
  /* ZIP 读取（支持 store / deflate）                                     */
  /* ------------------------------------------------------------------ */

  function u16(d, p) { return d[p] | (d[p + 1] << 8); }
  function u32(d, p) { return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) + d[p + 3] * 0x1000000; }

  function findEocd(d) {
    for (var i = d.length - 22; i >= 0 && i >= d.length - 65558; i--) {
      if (u32(d, i) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持 DecompressionStream，无法解压 ZIP');
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(buffer) {
    var d = new Uint8Array(buffer);
    var eocd = findEocd(d);
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    var count = u16(d, eocd + 10);
    var cdOffset = u32(d, eocd + 16);
    var entries = [];
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (u32(d, p) !== 0x02014b50) break;
      var method = u16(d, p + 10);
      var compSize = u32(d, p + 20);
      var nameLen = u16(d, p + 28);
      var extraLen = u16(d, p + 30);
      var commentLen = u16(d, p + 32);
      var localOff = u32(d, p + 42);
      var name = new TextDecoder('utf-8').decode(d.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { bytes: d, entries: entries };
  }

  async function extractEntry(zip, entry) {
    var d = zip.bytes, lp = entry.localOff;
    if (u32(d, lp) !== 0x04034b50) throw new Error('ZIP 条目损坏：' + entry.name);
    var nameLen = u16(d, lp + 26), extraLen = u16(d, lp + 28);
    var start = lp + 30 + nameLen + extraLen;
    var raw = d.subarray(start, start + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error('不支持的 ZIP 压缩方式：' + entry.method);
  }

  /* ------------------------------------------------------------------ */
  /* PNG 解码（8 位灰度 / RGB / RGBA / 调色板；支持 0–4 号滤波）          */
  /* ------------------------------------------------------------------ */

  function decodePng(bytes) {
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('不是 PNG');
    var p = 8, idat = [], ihdr = null, palette = null, trns = null;
    while (p + 8 <= bytes.length) {
      var len = (bytes[p] << 24 >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3];
      var type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      var start = p + 8;
      if (type === 'IHDR') {
        ihdr = {
          width: (bytes[start] << 24 >>> 0) + (bytes[start + 1] << 16) + (bytes[start + 2] << 8) + bytes[start + 3],
          height: (bytes[start + 4] << 24 >>> 0) + (bytes[start + 5] << 16) + (bytes[start + 6] << 8) + bytes[start + 7],
          depth: bytes[start + 8], color: bytes[start + 9], interlace: bytes[start + 12]
        };
      } else if (type === 'PLTE') {
        palette = bytes.subarray(start, start + len);
      } else if (type === 'tRNS') {
        trns = bytes.subarray(start, start + len);
      } else if (type === 'IDAT') {
        idat.push(bytes.subarray(start, start + len));
      } else if (type === 'IEND') break;
      p = start + len + 4;
    }
    if (!ihdr) throw new Error('PNG 缺少 IHDR');
    if (ihdr.depth !== 8) throw new Error('只支持 8 位 PNG（当前 ' + ihdr.depth + ' 位）');
    if (ihdr.interlace) throw new Error('不支持隔行扫描的 PNG');

    var w = ihdr.width, h = ihdr.height;
    var channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
    if (!channels) throw new Error('不支持的 PNG 颜色类型：' + ihdr.color);

    /* 拼接 IDAT 并解压 */
    var total = 0, i;
    for (i = 0; i < idat.length; i++) total += idat[i].length;
    var joined = new Uint8Array(total), off = 0;
    for (i = 0; i < idat.length; i++) { joined.set(idat[i], off); off += idat[i].length; }
    var inflated = pngInflate(joined);

    var stride = w * channels;
    var bpp = channels;
    var out = new Uint8Array(h * stride);
    var prev = new Uint8Array(stride);
    var src = 0;
    for (var y = 0; y < h; y++) {
      var filter = inflated[src++];
      var line = inflated.subarray(src, src + stride);
      src += stride;
      var cur = out.subarray(y * stride, (y + 1) * stride);
      cur.set(line);
      for (var x = 0; x < stride; x++) {
        var a = x >= bpp ? cur[x - bpp] : 0;
        var b = prev[x];
        var c = x >= bpp ? prev[x - bpp] : 0;
        if (filter === 1) cur[x] = (cur[x] + a) & 255;
        else if (filter === 2) cur[x] = (cur[x] + b) & 255;
        else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
        else if (filter === 4) {
          var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          var pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          cur[x] = (cur[x] + pr) & 255;
        } else if (filter !== 0) throw new Error('未知 PNG 滤波器：' + filter);
      }
      out.set(cur, y * stride);
      prev = cur;
    }

    /* 转成灰度 + 可选 RGB */
    var gray = new Uint8Array(w * h);
    var rgb = null;
    if (ihdr.color === 0 || ihdr.color === 4) {
      for (i = 0; i < w * h; i++) gray[i] = out[i * channels];
      if (ihdr.color === 4) {
        rgb = new Uint8Array(w * h * 3);
        for (i = 0; i < w * h; i++) {
          var g4 = out[i * 4];
          rgb[i * 3] = g4; rgb[i * 3 + 1] = g4; rgb[i * 3 + 2] = g4;
        }
      }
    } else if (ihdr.color === 3) {
      if (!palette) throw new Error('调色板 PNG 缺少 PLTE');
      rgb = new Uint8Array(w * h * 3);
      for (i = 0; i < w * h; i++) {
        var pi = out[i] * 3;
        var r = palette[pi], g = palette[pi + 1], b2 = palette[pi + 2];
        rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b2;
        gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b2);
      }
    } else {
      rgb = new Uint8Array(w * h * 3);
      for (i = 0; i < w * h; i++) {
        var r2 = out[i * channels], g2 = out[i * channels + 1], bl = out[i * channels + 2];
        rgb[i * 3] = r2; rgb[i * 3 + 1] = g2; rgb[i * 3 + 2] = bl;
        gray[i] = Math.round(0.299 * r2 + 0.587 * g2 + 0.114 * bl);
      }
    }
    return { width: w, height: h, gray: gray, rgb: rgb };
  }

  /* 用浏览器解 zlib 流（PNG 的 IDAT 是 zlib 包装） */
  /* DecompressionStream 是异步的，PNG 解码必须在主线程同步完成，所以自带同步 inflate。 */
  function pngInflate(bytes) { return inflateSync(bytes); }

  /*
   * 同步 inflate（仅 deflate 格式，含 zlib 头）。浏览器没有同步解压 API，
   * 而 PNG 解码必须在主线程同步完成，所以这里自带一个精简实现。
   */
  function inflateSync(data) {
    var pos = 0;
    /* 跳过 zlib 头 */
    if (data[0] === 0x78) {
      pos = 2;
      if (data[1] & 0x20) pos = 6;
    }
    var out = new Uint8Array(Math.max(1024, data.length * 4));
    var outLen = 0;
    var bitBuf = 0, bitCnt = 0;
    function ensure(n) {
      if (outLen + n <= out.length) return;
      var next = new Uint8Array(Math.max(out.length * 2, outLen + n));
      next.set(out.subarray(0, outLen));
      out = next;
    }
    function bits(n) {
      while (bitCnt < n) {
        if (pos >= data.length) throw new Error('PNG 数据被截断');
        bitBuf |= data[pos++] << bitCnt;
        bitCnt += 8;
      }
      var v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCnt -= n;
      return v;
    }
    var fixedLit = null, fixedDist = null;
    function buildCodes(lengths) {
      var maxBits = 0, i;
      for (i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
      var blCount = new Array(maxBits + 1).fill(0);
      for (i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
      var nextCode = new Array(maxBits + 1).fill(0);
      var code = 0;
      for (var b = 1; b <= maxBits; b++) {
        code = (code + (blCount[b - 1] || 0)) << 1;
        nextCode[b] = code;
      }
      var map = new Map();
      for (i = 0; i < lengths.length; i++) {
        var len = lengths[i];
        if (!len) continue;
        var c = nextCode[len]++;
        /* deflate 的霍夫曼码按 MSB 先写入比特流，decodeSym 也按 MSB 先累积，
           所以这里直接用自然位序建表，不做反转。 */
        map.set(len * 65536 + c, i);
      }
      return { map: map, maxBits: maxBits };
    }
    function decodeSym(codes) {
      var code = 0;
      for (var len = 1; len <= codes.maxBits; len++) {
        code = (code << 1) | bits(1);
        var sym = codes.map.get(len * 65536 + code);
        if (sym !== undefined) return sym;
      }
      throw new Error('PNG 霍夫曼码无效');
    }
    var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

    var last = 0;
    while (!last) {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        var len = data[pos] | (data[pos + 1] << 8);
        pos += 4;
        ensure(len);
        out.set(data.subarray(pos, pos + len), outLen);
        outLen += len; pos += len;
        continue;
      }
      var litCodes, distCodes;
      if (type === 1) {
        if (!fixedLit) {
          var litLens = new Array(288);
          for (var i2 = 0; i2 < 288; i2++) litLens[i2] = i2 < 144 ? 8 : i2 < 256 ? 9 : i2 < 280 ? 7 : 8;
          fixedLit = buildCodes(litLens);
          var distLens = new Array(30).fill(5);
          fixedDist = buildCodes(distLens);
        }
        litCodes = fixedLit; distCodes = fixedDist;
      } else if (type === 2) {
        var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        var clLens = new Array(19).fill(0);
        for (var i3 = 0; i3 < hclen; i3++) clLens[order[i3]] = bits(3);
        var clCodes = buildCodes(clLens);
        var lengths = [];
        while (lengths.length < hlit + hdist) {
          var sym = decodeSym(clCodes);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) {
            var rep = 3 + bits(2), prevLen = lengths[lengths.length - 1];
            for (var r1 = 0; r1 < rep; r1++) lengths.push(prevLen);
          } else if (sym === 17) {
            var rep2 = 3 + bits(3);
            for (var r2 = 0; r2 < rep2; r2++) lengths.push(0);
          } else {
            var rep3 = 11 + bits(7);
            for (var r3 = 0; r3 < rep3; r3++) lengths.push(0);
          }
        }
        litCodes = buildCodes(lengths.slice(0, hlit));
        distCodes = buildCodes(lengths.slice(hlit));
      } else throw new Error('PNG 压缩块类型无效');

      for (;;) {
        var sym2 = decodeSym(litCodes);
        if (sym2 < 256) {
          ensure(1); out[outLen++] = sym2;
        } else if (sym2 === 256) break;
        else {
          var li = sym2 - 257;
          var length = LEN_BASE[li] + bits(LEN_EXTRA[li]);
          var ds = decodeSym(distCodes);
          var dist = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
          ensure(length);
          var from = outLen - dist;
          if (from < 0) throw new Error('PNG 回溯距离越界');
          for (var k2 = 0; k2 < length; k2++) out[outLen + k2] = out[from + k2];
          outLen += length;
        }
      }
    }
    return out.subarray(0, outLen);
  }

  /* ------------------------------------------------------------------ */
  /* PNG 编码（8 位灰度，无滤波）                                         */
  /* ------------------------------------------------------------------ */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
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

  /* 存储型 deflate（不压缩，但完全合法；导出体积与源相仿） */
  function zlibStore(bytes) {
    var blocks = Math.ceil(bytes.length / 65535) || 1;
    var out = new Uint8Array(2 + blocks * 5 + bytes.length + 4);
    var p = 0;
    out[p++] = 0x78; out[p++] = 0x01;
    var off = 0;
    for (var b = 0; b < blocks; b++) {
      var len = Math.min(65535, bytes.length - off);
      var last = b === blocks - 1 ? 1 : 0;
      out[p++] = last;
      out[p++] = len & 255; out[p++] = len >> 8;
      out[p++] = ~len & 255; out[p++] = (~len >> 8) & 255;
      out.set(bytes.subarray(off, off + len), p);
      p += len; off += len;
    }
    var ad = adler32(bytes);
    out[p++] = ad >>> 24; out[p++] = (ad >>> 16) & 255; out[p++] = (ad >>> 8) & 255; out[p++] = ad & 255;
    return out.subarray(0, p);
  }

  function pngEncode(gray, w, h) { return pngEncodePixels(gray, w, h, 1); }

  /* 8 位 RGB PNG */
  function pngEncodeRGB(rgb, w, h) { return pngEncodePixels(rgb, w, h, 3); }

  function pngEncodePixels(pixels, w, h, channels) {
    var stride = w * channels + 1;
    var raw = new Uint8Array(stride * h);
    for (var y = 0; y < h; y++) {
      raw[y * stride] = 0;
      raw.set(pixels.subarray(y * w * channels, (y + 1) * w * channels), y * stride + 1);
    }
    var comp = zlibStore(raw);
    var chunks = [];
    function chunk(type, data) {
      var b = new Uint8Array(12 + data.length);
      var len = data.length;
      b[0] = len >>> 24; b[1] = (len >>> 16) & 255; b[2] = (len >>> 8) & 255; b[3] = len & 255;
      for (var i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
      b.set(data, 8);
      var crc = crc32(b.subarray(4, 8 + data.length));
      b[8 + data.length] = crc >>> 24; b[9 + data.length] = (crc >>> 16) & 255;
      b[10 + data.length] = (crc >>> 8) & 255; b[11 + data.length] = crc & 255;
      chunks.push(b);
    }
    var ihdr = new Uint8Array(13);
    ihdr[0] = w >>> 24; ihdr[1] = (w >>> 16) & 255; ihdr[2] = (w >>> 8) & 255; ihdr[3] = w & 255;
    ihdr[4] = h >>> 24; ihdr[5] = (h >>> 16) & 255; ihdr[6] = (h >>> 8) & 255; ihdr[7] = h & 255;
    ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    chunk('IHDR', ihdr);
    chunk('IDAT', comp);
    chunk('IEND', new Uint8Array(0));
    var total = 8, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    out.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
    var p2 = 8;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], p2); p2 += chunks[i].length; }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* ZIP 写出（store）                                                   */
  /* ------------------------------------------------------------------ */

  function zipEncode(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = crc32(f.data);
      var local = new Uint8Array(30 + name.length);
      var p = 0;
      function w32(v) { local[p++] = v & 255; local[p++] = (v >>> 8) & 255; local[p++] = (v >>> 16) & 255; local[p++] = (v >>> 24) & 255; }
      function w16(v) { local[p++] = v & 255; local[p++] = (v >>> 8) & 255; }
      w32(0x04034b50); w16(20); w16(0); w16(0); w16(dosTime); w16(dosDate);
      w32(crc); w32(f.data.length); w32(f.data.length); w16(name.length); w16(0);
      local.set(name, p);
      parts.push(local, f.data);

      var cen = new Uint8Array(46 + name.length);
      var q = 0;
      function c32(v) { cen[q++] = v & 255; cen[q++] = (v >>> 8) & 255; cen[q++] = (v >>> 16) & 255; cen[q++] = (v >>> 24) & 255; }
      function c16(v) { cen[q++] = v & 255; cen[q++] = (v >>> 8) & 255; }
      c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(dosTime); c16(dosDate);
      c32(crc); c32(f.data.length); c32(f.data.length); c16(name.length); c16(0); c16(0);
      c16(0); c16(0); c32(0); c32(offset);
      cen.set(name, q);
      central.push(cen);

      offset += local.length + f.data.length;
    });

    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var eocd = new Uint8Array(22);
    var e = 0;
    function e32(v) { eocd[e++] = v & 255; eocd[e++] = (v >>> 8) & 255; eocd[e++] = (v >>> 16) & 255; eocd[e++] = (v >>> 24) & 255; }
    function e16(v) { eocd[e++] = v & 255; eocd[e++] = (v >>> 8) & 255; }
    e32(0x06054b50); e16(0); e16(0); e16(files.length); e16(files.length);
    e32(cdSize); e32(offset); e16(0);

    var all = parts.concat(central, [eocd]);
    var total = 0;
    all.forEach(function (a) { total += a.length; });
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function (a) { out.set(a, pos); pos += a.length; });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 素材载入                                                            */
  /* ------------------------------------------------------------------ */

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function loadSample() {
    if (!window.PCR_SAMPLE) { setStatus('内置样例缺失', true); return; }
    var s = window.PCR_SAMPLE;
    setStatus('解压内置样例…');
    var raw;
    if (typeof DecompressionStream !== 'undefined') {
      var bytes = base64ToBytes(s.data);
      var ds = new DecompressionStream('deflate');
      raw = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
    } else {
      raw = inflateSync(base64ToBytes(s.data));
    }
    var W = s.width, H = s.height, N = s.frameCount;
    if (raw.length !== W * H * N) throw new Error('样例数据长度不符');
    var frames = [];
    for (var i = 0; i < N; i++) frames.push(raw.subarray(i * W * H, (i + 1) * W * H));
    state.width = W; state.height = H; state.frames = frames; state.rgb = null;
    state.sourceName = s.name;
    analyzeAndRender();
  }

  async function loadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    setStatus('读取文件…');
    try {
      var zipFile = files.find(function (f) { return /\.zip$/i.test(f.name) || f.type === 'application/zip'; });
      if (zipFile) {
        await loadZip(await zipFile.arrayBuffer());
        return;
      }
      var pngs = files.filter(function (f) { return /\.png$/i.test(f.name) || f.type === 'image/png'; });
      if (!pngs.length) throw new Error('请选择 ZIP 或 PNG 文件');
      pngs.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
      var decoded = [];
      for (var i = 0; i < pngs.length; i++) {
        var buf = new Uint8Array(await pngs[i].arrayBuffer());
        decoded.push(decodePng(buf));
      }
      installFrames(decoded, pngs.length + ' 张 PNG');
    } catch (err) {
      setStatus('载入失败：' + err.message, true);
    }
  }

  async function loadZip(buffer) {
    var zip = await readZip(buffer);
    /* 优先取 frames/ 下的 PNG；没有就用根目录的全部 PNG */
    var names = zip.entries.filter(function (e) { return /\.png$/i.test(e.name); });
    var inFrames = names.filter(function (e) { return /(^|\/)frames\//i.test(e.name); });
    var picks = (inFrames.length ? inFrames : names).slice();
    if (!picks.length) throw new Error('ZIP 里没有 PNG 文件');
    picks.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    var decoded = [];
    for (var i = 0; i < picks.length; i++) {
      if (i % 20 === 0) setStatus('解码 ' + (i + 1) + '/' + picks.length + '…');
      var data = await extractEntry(zip, picks[i]);
      var png = decodePng(data);
      /* 只取 frames/ 时自动排除 truth/ 之类 */
      decoded.push(png);
    }
    installFrames(decoded, picks.length + ' 帧（ZIP）');
  }

  function installFrames(decoded, label) {
    if (!decoded.length) throw new Error('没有可用帧');
    var w = decoded[0].width, h = decoded[0].height;
    for (var i = 1; i < decoded.length; i++) {
      if (decoded[i].width !== w || decoded[i].height !== h) {
        throw new Error('第 ' + (i + 1) + ' 帧尺寸不同（' + decoded[i].width + '×' + decoded[i].height + '）');
      }
    }
    state.width = w; state.height = h;
    state.frames = decoded.map(function (d) { return d.gray; });
    state.rgb = decoded.every(function (d) { return d.rgb; }) ? decoded.map(function (d) { return d.rgb; }) : null;
    state.sourceName = label;
    analyzeAndRender();
  }

  /* ------------------------------------------------------------------ */
  /* 分析                                                                */
  /* ------------------------------------------------------------------ */

  function analyzeAndRender() {
    setStatus('逐场分析中…');
    /* 先让状态文字显示出来再做重计算 */
    setTimeout(function () {
      try {
        var t0 = performance.now();
        var result = PCR.analyze({ frames: state.frames, width: state.width, height: state.height });
        var ms = Math.round(performance.now() - t0);
        state.analysis = result;
        state.current = 0;
        state.thumbCache.clear();
        buildTimeline();
        buildTable();
        buildOverview();
        buildDiagnostics();
        renderCurrent();
        el.exportZip.disabled = false;
        el.copyJson.disabled = false;
        setStatus('分析完成：' + result.frameCount + ' 帧 → ' + result.outputs.length + ' 个画面，用时 ' + ms + ' ms。' + state.sourceName);
      } catch (err) {
        console.error(err);
        setStatus('分析失败：' + err.message, true);
      }
    }, 20);
  }

  /* ------------------------------------------------------------------ */
  /* 画面渲染                                                            */
  /* ------------------------------------------------------------------ */

  function renderFrameCanvas(canvas, pixels, w, h, rgb) {
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    if (rgb) {
      for (var i = 0, j = 0; i < w * h; i++, j += 4) {
        img.data[j] = rgb[i * 3];
        img.data[j + 1] = rgb[i * 3 + 1];
        img.data[j + 2] = rgb[i * 3 + 2];
        img.data[j + 3] = 255;
      }
    } else {
      for (var k = 0, m = 0; k < w * h; k++, m += 4) {
        var g = pixels[k];
        img.data[m] = g; img.data[m + 1] = g; img.data[m + 2] = g; img.data[m + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* 把一场按行写进目标（parity 0 = 偶数行，1 = 奇数行） */
  function weaveField(dst, src, w, h, start) {
    var rows = Math.ceil((h - start) / 2);
    for (var y = 0; y < rows; y++) {
      var s = y * w, d = (start + 2 * y) * w;
      for (var x = 0; x < w; x++) dst[d + x] = src[s + x];
    }
  }

  function rgbOfFrame(f) { return state.rgb ? state.rgb[f] : null; }

  function renderBefore(o, canvas) {
    var w = state.width, h = state.height;
    var f = o.type === 'interlaced' ? o.sourceFrame : o.minFrame;
    renderFrameCanvas(canvas, state.frames[f], w, h, rgbOfFrame(f), true);
  }

  function renderAfter(o, canvas) {
    var rendered = PCR.renderOutput({ frames: state.frames, width: state.width, height: state.height }, state.analysis, o);
    if (state.rgb) {
      var rgbPixels = PCR.renderOutputRGB(
        { frames: state.frames, rgbFrames: state.rgb, width: state.width, height: state.height },
        state.analysis, o);
      if (rgbPixels) {
        renderFrameCanvas(canvas, null, state.width, state.height, rgbPixels, true);
        return rendered;
      }
    }
    renderFrameCanvas(canvas, rendered.pixels, state.width, state.height, null);
    return rendered;
  }

  function renderDiff(o, canvas) {
    var before = state.frames[o.type === 'interlaced' ? o.sourceFrame : o.minFrame];
    var after = PCR.renderOutput({ frames: state.frames, width: state.width, height: state.height }, state.analysis, o).pixels;
    var d = new Uint8Array(before.length);
    for (var i = 0; i < d.length; i++) {
      var v = Math.abs(before[i] - after[i]) * 4;
      d[i] = v > 255 ? 255 : v;
    }
    renderFrameCanvas(canvas, d, state.width, state.height, null);
  }

  /* ------------------------------------------------------------------ */
  /* 概览                                                                */
  /* ------------------------------------------------------------------ */

  function buildOverview() {
    var a = state.analysis;
    var exact = 0, orphan = 0, inter = 0;
    a.outputs.forEach(function (o) {
      if (o.type === 'interlaced') inter++;
      else if (o.interpolated) orphan++;
      else exact++;
    });
    var stats = el.overview.querySelectorAll('.stat b');
    stats[0].textContent = a.outputs.length;
    stats[1].textContent = exact;
    stats[2].textContent = orphan;
    stats[3].textContent = inter;
    stats[4].textContent = a.orderRuns.length;
    stats[5].textContent = a.reLock.length;
    stats[6].textContent = a.frameCount;
  }

  /* ------------------------------------------------------------------ */
  /* 时间线                                                              */
  /* ------------------------------------------------------------------ */

  function slotX(slot, totalSlots, width) {
    return (slot / totalSlots) * width;
  }

  function buildTimeline() {
    var a = state.analysis;
    var N = a.frameCount;
    var totalSlots = 2 * N;
    /* 缩略图至少 20px 宽才看得清；放不下就横向滚动 */
    var avail = Math.max(280, el.tlScroll.clientWidth - 6);
    var width = Math.max(avail, Math.min(N * 20, 6000));

    el.tlInner.style.width = width + 'px';
    [el.laneOrder, el.laneCadence, el.laneType].forEach(function (l) { l.innerHTML = ''; });

    /* 场序条 */
    a.orderRuns.forEach(function (run) {
      var seg = document.createElement('div');
      seg.className = 'seg order' + (run.order === 'bff' ? ' bff' : '');
      var x0 = slotX(2 * run.start, totalSlots, width);
      var x1 = slotX(2 * (run.end + 1), totalSlots, width);
      seg.style.left = x0 + 'px';
      seg.style.width = Math.max(2, x1 - x0) + 'px';
      seg.textContent = run.order.toUpperCase();
      seg.title = '帧 ' + run.start + '–' + run.end + '：' + run.order.toUpperCase();
      el.laneOrder.appendChild(seg);
    });

    /* 节奏条：2 场与 3 场交替出现才是 3:2；颜色区分 2/3，不跟随交替的加顶边 */
    a.outputs.forEach(function (o) {
      var x0 = slotX(o.key, totalSlots, width);
      var x1 = slotX(o.key + Math.max(o.slotCount, 1.6), totalSlots, width);
      var seg = document.createElement('div');
      var cls = 'seg ';
      if (o.type === 'interlaced') cls += 'cadence-none';
      else if (o.interpolated) cls += 'cadence-none';
      else cls += o.slotCount === 3 ? 'cadence-1' : 'cadence-0';
      if (o.cadenceOk === false) cls += ' irregular';
      seg.className = cls;
      seg.style.left = x0 + 'px';
      seg.style.width = Math.max(1.5, x1 - x0 - 0.6) + 'px';
      seg.title = '画面 ' + o.index + '：' + (o.slotCount || 0) + ' 场' +
        (o.cadenceOk === false ? '（不跟随 2/3 交替，节奏在此断开）' : '');
      el.laneCadence.appendChild(seg);
    });

    /* 判定条 */
    a.outputs.forEach(function (o) {
      var k = outputKind(o);
      var x0 = slotX(o.key, totalSlots, width);
      var x1 = slotX(o.key + Math.max(o.slotCount, 1.6), totalSlots, width);
      var seg = document.createElement('div');
      seg.className = 'seg type-' + k;
      seg.style.left = x0 + 'px';
      seg.style.width = Math.max(1.5, x1 - x0 - 0.6) + 'px';
      el.laneType.appendChild(seg);
    });

    /* 胶片格缩略图 */
    el.strip.innerHTML = '';
    a.outputs.forEach(function (o, idx) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell k-' + outputKind(o);
      cell.dataset.index = String(idx);
      cell.setAttribute('aria-label', '画面 ' + idx + '：' + kindLabel(o));
      var x0 = slotX(o.key, totalSlots, width);
      var x1 = slotX(o.key + Math.max(o.slotCount, 1), totalSlots, width);
      var cw = Math.max(9, x1 - x0 - 1.5);
      cell.style.left = x0 + 'px';
      cell.style.width = cw + 'px';
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = String(idx);
      cell.appendChild(tag);
      cell.addEventListener('click', function () { selectOutput(idx); });
      el.strip.appendChild(cell);
    });

    /* 分数条 */
    var lane = el.scoreLane;
    Array.prototype.slice.call(lane.querySelectorAll('.bar')).forEach(function (b) { b.remove(); });
    var maxScore = 3.2;
    for (var i = 0; i < N; i++) {
      var rep = a.fieldReports[i];
      var s = Math.min(rep.top.best.score, rep.bottom.best.score);
      var bar = document.createElement('div');
      bar.className = 'bar k-' + (a.frameStates[i] === 'interlaced' ? 'int' : a.frameStates[i] === 'orphan' ? 'orphan' : 'film');
      var x = slotX(2 * i, totalSlots, width);
      var hgt = Math.max(1.5, Math.min(1, s / maxScore) * 22);
      bar.style.left = x + 'px';
      bar.style.height = hgt + 'px';
      bar.title = '帧 ' + i + ' 最低场匹配分 ' + s.toFixed(2) + (s <= 1.2 ? '（同源）' : '（不同源）');
      lane.appendChild(bar);
    }
    /* 阈值线：1.20 处 */
    var thr = lane.querySelector('.thr-line');
    if (!thr) {
      thr = document.createElement('div');
      thr.className = 'thr-line';
      thr.style.cssText = 'position:absolute;left:0;right:0;border-top:1px dashed var(--line-strong);opacity:.8';
      lane.appendChild(thr);
    }
    thr.style.bottom = (6 + Math.min(1, 1.2 / maxScore) * 22) + 'px';

    el.scrub.max = String(a.outputs.length - 1);
    updateThumbs();
  }

  /* 缩略图：每格渲染一次并缓存成 data URL */
  function thumbFor(idx) {
    var cached = state.thumbCache.get(idx);
    if (cached !== undefined) return cached;
    var o = state.analysis.outputs[idx];
    var r = PCR.renderOutput({ frames: state.frames, width: state.width, height: state.height }, state.analysis, o);
    var rgbOut = state.rgb ? PCR.renderOutputRGB(
      { frames: state.frames, rgbFrames: state.rgb, width: state.width, height: state.height },
      state.analysis, o) : null;
    var big = document.createElement('canvas');
    big.width = state.width; big.height = state.height;
    var bctx = big.getContext('2d');
    var img = bctx.createImageData(state.width, state.height);
    for (var k = 0, m = 0; k < r.pixels.length; k++, m += 4) {
      if (rgbOut) {
        img.data[m] = rgbOut[k * 3]; img.data[m + 1] = rgbOut[k * 3 + 1]; img.data[m + 2] = rgbOut[k * 3 + 2];
      } else {
        var g = r.pixels[k];
        img.data[m] = g; img.data[m + 1] = g; img.data[m + 2] = g;
      }
      img.data[m + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
    var small = document.createElement('canvas');
    small.width = 48; small.height = Math.max(8, Math.round(48 * state.height / state.width));
    small.getContext('2d').drawImage(big, 0, 0, small.width, small.height);
    var url = small.toDataURL('image/png');
    state.thumbCache.set(idx, url);
    return url;
  }

  function updateThumbs() {
    var cells = el.strip.querySelectorAll('.cell');
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cell.dataset.done) continue;
      var idx = Number(cell.dataset.index);
      cell.dataset.done = '1';
      var url = thumbFor(idx);
      if (url) cell.style.backgroundImage = 'url(' + url + ')';
    }
  }

  /* ------------------------------------------------------------------ */
  /* 表格                                                                */
  /* ------------------------------------------------------------------ */

  function buildTable() {
    var a = state.analysis;
    var tbody = el.tableBody;
    tbody.innerHTML = '';
    var frag = document.createDocumentFragment();
    a.outputs.forEach(function (o, idx) {
      var tr = document.createElement('tr');
      tr.dataset.index = String(idx);
      tr.tabIndex = 0;
      var topScore = '—', botScore = '—';
      if (o.type === 'film') {
        if (o.topFrame !== null) topScore = a.fieldReports[o.topFrame].top.best.score.toFixed(2);
        if (o.bottomFrame !== null) botScore = a.fieldReports[o.bottomFrame].bottom.best.score.toFixed(2);
      }
      var chips = [];
      chips.push('<td class="n">' + idx + '</td>');
      chips.push('<td class="n">' + o.key + '</td>');
      chips.push('<td><span class="tag-pill ' + outputKind(o) + '">' + kindLabel(o) + '</span></td>');
      chips.push('<td class="n">' + (o.topFrame === null ? '—' : o.topFrame) + '</td>');
      chips.push('<td class="n">' + topScore + '</td>');
      chips.push('<td class="n">' + (o.bottomFrame === null ? '—' : o.bottomFrame) + '</td>');
      chips.push('<td class="n">' + botScore + '</td>');
      chips.push('<td class="n">' + (o.type === 'film' ? o.order.toUpperCase() : '—') + '</td>');
      chips.push('<td class="n">' + (o.type === 'film' ? o.slotCount + '场' : '—') + '</td>');
      tr.innerHTML = chips.join('');
      tr.addEventListener('click', function () { selectOutput(idx); });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectOutput(idx); }
      });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function highlightTable() {
    var rows = el.tableBody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var on = Number(rows[i].dataset.index) === state.current;
      rows[i].setAttribute('aria-current', on ? 'true' : 'false');
      if (on && rows[i].scrollIntoView) {
        var wrap = rows[i].closest('.table-wrap');
        var top = rows[i].offsetTop - wrap.clientHeight / 2;
        wrap.scrollTop = Math.max(0, top);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 诊断                                                                */
  /* ------------------------------------------------------------------ */

  function buildDiagnostics() {
    var a = state.analysis;
    function fill(node, rows, empty) {
      node.innerHTML = '';
      if (!rows.length) {
        var li = document.createElement('li');
        li.className = 'empty';
        li.textContent = empty;
        node.appendChild(li);
        return;
      }
      rows.forEach(function (r) {
        var li = document.createElement('li');
        li.innerHTML = '<span>' + r[0] + '</span><b>' + r[1] + '</b>';
        node.appendChild(li);
      });
    }
    fill(el.diagOrder, a.orderRuns.map(function (r) {
      return ['帧 ' + r.start + '–' + r.end, r.order.toUpperCase()];
    }), '无');

    fill(el.diagCadence, a.cadence.runs.map(function (r) {
      var tail = r.mismatches ? ' · ' + r.mismatches + ' 处不符' : '';
      return ['帧 ' + r.startFrame + '–' + r.endFrame, r.firstSize + ' 场起' + tail];
    }), '未找到 3:2 节奏');

    var reasons = { order: '换场序', cadence: '节奏重锁', 'interlaced-start': '进入隔行段' };
    fill(el.diagRelock, a.reLock.map(function (r) {
      var txt = r.reason.split('+').map(function (k) { return reasons[k] || k; }).join(' + ');
      return ['帧 ' + r.frame, txt];
    }), '无');

    fill(el.diagOrphans, a.orphans.map(function (o) {
      return ['画面 ' + o.outputIndex + ' · 缺' + (o.missing === 'top' ? '上场' : '下场'), '帧 ' + o.sourceFrame];
    }), '没有孤场');
  }

  /* ------------------------------------------------------------------ */
  /* 当前画面                                                            */
  /* ------------------------------------------------------------------ */

  function selectOutput(idx) {
    var max = state.analysis.outputs.length - 1;
    state.current = Math.max(0, Math.min(max, idx));
    renderCurrent();
  }

  function updateTimelineCurrent() {
    var cells = el.strip.querySelectorAll('.cell');
    var active = null;
    for (var i = 0; i < cells.length; i++) {
      var on = Number(cells[i].dataset.index) === state.current;
      cells[i].setAttribute('aria-current', on ? 'true' : 'false');
      if (on) active = cells[i];
    }
    if (!active) return;
    var sc = el.tlScroll;
    var left = active.offsetLeft, right = left + active.offsetWidth;
    if (left < sc.scrollLeft + 60) sc.scrollLeft = Math.max(0, left - 60);
    else if (right > sc.scrollLeft + sc.clientWidth - 20) sc.scrollLeft = right - sc.clientWidth + 20;
  }

  function renderCurrent() {
    var a = state.analysis;
    if (!a) return;
    var o = a.outputs[state.current];
    renderBefore(o, el.beforeCanvas);
    var rendered = renderAfter(o, el.afterCanvas);
    if (state.diff) renderDiff(o, el.afterCanvas);

    el.beforeNote.textContent = '帧 ' + (o.type === 'interlaced' ? o.sourceFrame : o.minFrame);
    el.afterNote.textContent = rendered.note === 'exact' ? '精确拼回'
      : rendered.note === 'interlaced' ? '去隔行' : '场内插补';

    /* 元信息 */
    el.beforeMeta.innerHTML = '';
    var chipsBefore = ['原始 ' + state.width + '×' + state.height, '两场交错'];
    el.beforeMeta.innerHTML = chipsBefore.map(function (t) { return '<span class="chip">' + t + '</span>'; }).join('');

    el.afterMeta.innerHTML = '';
    var chips = [];
    chips.push('<span class="chip strong">画面 ' + o.index + '</span>');
    if (o.type === 'film') {
      chips.push('<span class="chip ' + (o.interpolated ? 'interp' : 'exact') + '">' + kindLabel(o) + '</span>');
      chips.push('<span class="chip">上场 ← 帧 ' + (o.topFrame === null ? '插补' : o.topFrame) + '</span>');
      chips.push('<span class="chip">下场 ← 帧 ' + (o.bottomFrame === null ? '插补' : o.bottomFrame) + '</span>');
      chips.push('<span class="chip">' + o.order.toUpperCase() + '</span>');
      chips.push('<span class="chip">' + o.slotCount + ' 场</span>');
      if (o.cadenceOk === false) chips.push('<span class="chip interp">节奏不规则</span>');
    } else {
      chips.push('<span class="chip inter">纯隔行 · 去隔行</span>');
      chips.push('<span class="chip">上场 帧 ' + o.sourceFrame + ' 插值成整幅</span>');
      chips.push('<span class="chip">' + o.order.toUpperCase() + '</span>');
    }
    el.afterMeta.innerHTML = chips.join('');

    /* 判定 */
    var vt = el.verdictTitle, vd = el.verdictDesc;
    vt.className = 'v ' + outputKind(o);
    if (o.type === 'interlaced') {
      vt.textContent = '纯隔行段';
      vd.textContent = '这一帧的上、下场各自属于不同时刻，拼不成一格胶片画面。只取上场做边导向场内插值，得到时间一致的去隔行画面，单独输出。';
    } else if (o.interpolated) {
      vt.textContent = '孤场 · 场内插补';
      vd.textContent = '这一格只剩' + (o.missing === 'top' ? '上场' : '下场') + '（缺' + (o.missing === 'top' ? '上场' : '下场') + '）。' +
        '用已知一场做边导向场内插值补全，没有硬配到相邻的场，并在 JSON 里单独标记。';
    } else {
      vt.textContent = '精确拼回';
      vd.textContent = '上场取自帧 ' + o.topFrame + '，下场取自帧 ' + (o.bottomFrame === null ? '—' : o.bottomFrame) +
        '，两场同属一格原始画面，拼回后逐像素一致。';
    }

    /* 分数 */
    buildScores(o);
    updateTimelineCurrent();
    highlightTable();
    el.scrub.value = String(state.current);
    el.posLabel.textContent = (state.current + 1) + ' / ' + a.outputs.length;
    el.prevBtn.disabled = state.current === 0;
    el.nextBtn.disabled = state.current === a.outputs.length - 1;
    updateThumbs();
  }

  function meter(score, threshold, maxVal) {
    var pct = Math.max(0, Math.min(1, score / maxVal)) * 100;
    var thrPct = Math.max(0, Math.min(1, threshold / maxVal)) * 100;
    return '<div class="meter"><div class="fill' + (score > threshold ? ' bad' : '') + '" style="width:' + pct + '%"></div>' +
      '<div class="thr" style="left:' + thrPct + '%"></div></div>' +
      '<div class="meter-legend"><span>0</span><span>阈值 ' + threshold.toFixed(2) + '</span><span>' + maxVal + '</span></div>';
  }

  function buildScores(o) {
    var a = state.analysis;
    var host = el.scores;
    host.innerHTML = '';

    if (o.type === 'interlaced') {
      var rep0 = a.fieldReports[o.sourceFrame];
      host.innerHTML =
        scoreRow('上场 · 帧 ' + o.sourceFrame, rep0.top.best, 'top') +
        scoreRow('下场 · 帧 ' + o.sourceFrame, rep0.bottom.best, 'bottom') +
        pairRow(null, '两场不同源，拼不成一格胶片画面，按隔行处理');
      return;
    }

    var topRow, botRow;
    if (o.topFrame !== null) {
      topRow = o.interpolated
        ? presentRow('上场 · 帧 ' + o.topFrame, '这一场是孤场，找不到同源的另半格')
        : scoreRow('上场 · 帧 ' + o.topFrame, a.fieldReports[o.topFrame].top.best, 'top', a.fieldReports[o.topFrame].top.dup);
    } else {
      topRow = missingRow('上场', '该场缺失，由场内插值补全');
    }
    if (o.bottomFrame !== null) {
      botRow = o.interpolated
        ? presentRow('下场 · 帧 ' + o.bottomFrame, '这一场是孤场，找不到同源的另半格')
        : scoreRow('下场 · 帧 ' + o.bottomFrame, a.fieldReports[o.bottomFrame].bottom.best, 'bottom', a.fieldReports[o.bottomFrame].bottom.dup);
    } else {
      botRow = missingRow('下场', '该场缺失，由场内插值补全');
    }
    var pairText = o.exact
      ? '两场来自同一格，梳齿分 ' + o.score.toFixed(2) + ' ≤ 1.20，判为同源'
      : '只有一场，无法计算配对分';
    host.innerHTML = topRow + botRow + pairRow(o.score, pairText, o.exact);
  }

  function presentRow(label, note) {
    return '<div class="score-row"><div class="sr-head"><span class="lbl">' + label +
      '</span><span class="val interp">沿用</span></div><div class="sr-sub">' + note + '</div></div>';
  }

  function missingRow(label, note) {
    return '<div class="score-row"><div class="sr-head"><span class="lbl">' + label +
      '</span><span class="val interp">插补</span></div><div class="sr-sub">' + note + '</div></div>';
  }

  function pairRow(score, text, good) {
    if (score === null || score === undefined) {
      return '<div class="score-row pair"><div class="sr-head"><span class="lbl">本格配对分</span>' +
        '<span class="val">—</span></div><div class="sr-sub">' + text + '</div></div>';
    }
    return '<div class="score-row pair"><div class="sr-head"><span class="lbl">本格配对分</span>' +
      '<span class="val ' + (good ? 'good' : 'bad') + '">' + score.toFixed(2) + '</span></div>' +
      '<div class="sr-sub">' + text + '</div>' + meter(score, 1.2, 8) + '</div>';
  }

  function scoreRow(label, best, parity, dup) {
    var good = best.score <= 1.2;
    var cls = good ? 'good' : 'bad';
    var partner = '帧 ' + best.frame + ' 的' + (parity === 'top' ? '下场' : '上场');
    if (best.frame === Number(label.match(/帧 (\d+)/)[1])) partner = '本帧' + (parity === 'top' ? '下场' : '上场');
    var dupTxt = dup ? ' · 重复分 ' + dup.score.toFixed(2) + '（帧 ' + dup.frame + '）' : '';
    return '<div class="score-row">' +
      '<div class="sr-head"><span class="lbl">' + label + '</span><span class="val ' + cls + '">' + best.score.toFixed(2) + '</span></div>' +
      '<div class="sr-sub">最佳同源：' + partner + ' · ' + (good ? '同源' : '不同源') + dupTxt + '</div>' +
      meter(best.score, 1.2, 8) +
      '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* 导出                                                                */
  /* ------------------------------------------------------------------ */

  function buildSourceJson() {
    var a = state.analysis;
    var items = a.outputs.map(function (o) {
      var row = {
        index: o.index,
        type: o.type === 'interlaced' ? 'interlaced' : 'film',
        slot: o.key,
        slots: o.slots,
        order: o.order,
        exact: o.exact
      };
      if (o.type === 'interlaced') {
        row.frame = o.sourceFrame;
        row.note = '两场不同源；取上场做场内插值去隔行';
        row.deinterlaceField = 'top';
      } else {
        row.topFrame = o.topFrame;
        row.bottomFrame = o.bottomFrame;
        row.topSource = o.topFrame === null ? 'interpolated' : 'frame ' + o.topFrame + ' top';
        row.bottomSource = o.bottomFrame === null ? 'interpolated' : 'frame ' + o.bottomFrame + ' bottom';
        if (o.interpolated) {
          row.isolated = true;
          row.missing = o.interpolated;
          row.note = '孤场：' + (o.interpolated === 'top' ? '缺上场' : '缺下场') + '，场内插值补全';
        }
      }
      return row;
    });
    return {
      source: state.sourceName,
      width: state.width,
      height: state.height,
      videoFrames: a.frameCount,
      outputs: items,
      orderRuns: a.orderRuns,
      cadenceRuns: a.cadence.runs,
      reLock: a.reLock,
      orphans: a.orphans.map(function (o) { return o.sourceFrame; })
    };
  }

  function download(name, bytes, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  function exportZip() {
    var a = state.analysis;
    if (!a) return;
    setStatus('生成 PNG 序列…');
    setTimeout(function () {
      try {
        var files = [];
        var pad = String(a.outputs.length - 1).length;
        a.outputs.forEach(function (o) {
          var name = 'restored/' + String(o.index).padStart(Math.max(4, pad), '0') + '.png';
          var rgbOut = state.rgb ? PCR.renderOutputRGB(
            { frames: state.frames, rgbFrames: state.rgb, width: state.width, height: state.height }, a, o) : null;
          if (rgbOut) {
            var rgb = new Uint8Array(rgbOut.length);
            for (var j = 0; j < rgbOut.length; j++) rgb[j] = rgbOut[j];
            files.push({ name: name, data: pngEncodeRGB(rgb, state.width, state.height) });
            return;
          }
          var r = PCR.renderOutput({ frames: state.frames, width: state.width, height: state.height }, a, o);
          var gray = new Uint8Array(r.pixels.length);
          for (var i = 0; i < r.pixels.length; i++) gray[i] = r.pixels[i];
          files.push({ name: name, data: pngEncode(gray, state.width, state.height) });
        });
        var json = new TextEncoder().encode(JSON.stringify(buildSourceJson(), null, 2));
        files.push({ name: 'sources.json', data: json });
        var zip = zipEncode(files);
        download('pulldown-restored.zip', zip, 'application/zip');
        setStatus('已导出 ' + a.outputs.length + ' 个 PNG + sources.json（' + (zip.length / 1024).toFixed(0) + ' KB）。');
      } catch (err) {
        setStatus('导出失败：' + err.message, true);
      }
    }, 20);
  }

  function copyJson() {
    var text = JSON.stringify(buildSourceJson(), null, 2);
    el.jsonView.value = text;
    el.jsonPanel.hidden = false;
    el.jsonPanel.scrollIntoView({ block: 'nearest' });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus('来源 JSON 已复制到剪贴板（共 ' + text.length + ' 字符）。');
      }).catch(function () {
        setStatus('剪贴板不可用，已在下方显示 JSON，可手动选取复制。');
      });
    } else {
      setStatus('剪贴板不可用，已在下方显示 JSON，可手动选取复制。');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 交互绑定                                                            */
  /* ------------------------------------------------------------------ */

  function bind() {
    el.btnSample.addEventListener('click', function () {
      loadSample().catch(function (err) { setStatus('样例载入失败：' + err.message, true); });
    });
    el.fileInput.addEventListener('change', function (ev) {
      loadFiles(ev.target.files).catch(function (err) { setStatus('载入失败：' + err.message, true); });
    });
    el.prevBtn.addEventListener('click', function () { selectOutput(state.current - 1); });
    el.nextBtn.addEventListener('click', function () { selectOutput(state.current + 1); });
    el.scrub.addEventListener('input', function () { selectOutput(Number(el.scrub.value)); });

    el.viewDiff.addEventListener('click', function () {
      state.diff = !state.diff;
      el.viewDiff.setAttribute('aria-pressed', state.diff ? 'true' : 'false');
      if (state.analysis) renderCurrent();
    });
    el.zoomBtn.addEventListener('click', function () {
      state.zoom = !state.zoom;
      el.zoomBtn.setAttribute('aria-pressed', state.zoom ? 'true' : 'false');
      el.beforeBox.classList.toggle('zoom', state.zoom);
      el.afterBox.classList.toggle('zoom', state.zoom);
    });

    el.exportZip.addEventListener('click', exportZip);
    el.copyJson.addEventListener('click', copyJson);

    document.addEventListener('keydown', function (ev) {
      if (!state.analysis) return;
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); selectOutput(state.current - 1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); selectOutput(state.current + 1); }
    });
  }

  function init() {
    ['status', 'overview', 'tlScroll', 'tlInner', 'laneOrder', 'laneCadence', 'laneType', 'strip',
      'scoreLane', 'prevBtn', 'nextBtn', 'posLabel', 'scrub', 'beforeBox', 'afterBox', 'beforeCanvas',
      'afterCanvas', 'beforeNote', 'afterNote', 'beforeMeta', 'afterMeta', 'verdictTitle', 'verdictDesc',
      'verdict', 'scores', 'viewDiff', 'zoomBtn', 'tableBody', 'diagOrder', 'diagCadence',
      'diagRelock', 'diagOrphans', 'exportZip', 'copyJson', 'btnSample', 'fileInput',
      'jsonPanel', 'jsonView'].forEach(function (id) {
      el[id] = $(id);
    });
    bind();
    /* 首屏直接载入样例，让页面打开就是工作状态 */
    if (window.PCR_SAMPLE) {
      loadSample().catch(function (err) {
        setStatus('样例载入失败：' + err.message + '（可直接导入 ZIP/PNG）', true);
      });
    } else {
      setStatus('未找到内置样例，请导入 ZIP 或 PNG 序列。');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__pcr = state;
  /* 供本地校验使用：导出/导入的纯函数 */
  window.__pcrTools = {
    pngEncode: pngEncode, pngEncodeRGB: pngEncodeRGB, zipEncode: zipEncode, decodePng: decodePng,
    readZip: readZip, extractEntry: extractEntry, inflateSync: inflateSync,
    buildSourceJson: buildSourceJson, renderOutput: function (o) {
      return PCR.renderOutput({ frames: state.frames, width: state.width, height: state.height }, state.analysis, o);
    }
  };
})();
