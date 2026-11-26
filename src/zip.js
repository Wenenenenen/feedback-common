/*
 * 纯手写 ZIP 读取与 RFC1951 inflate，无任何第三方依赖。
 * 仅支持本项目需要的子集：stored(0) 与 deflate(8)，单盘、无加密、无 ZIP64。
 */
(function (global) {
  'use strict';

  /* ---------------- CRC32 ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- RFC1951 inflate ---------------- */
  function makeBitReader(view, start, end) {
    var pos = start;
    var bitbuf = 0;
    var bitcnt = 0;
    function bits(n) {
      while (bitcnt < n) {
        if (pos >= end) throw new Error('inflate: 数据意外结束');
        bitbuf |= view.getUint8(pos++) << bitcnt;
        bitcnt += 8;
      }
      var v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n;
      bitcnt -= n;
      return v;
    }
    function align() {
      var drop = bitcnt & 7;
      bitbuf >>>= drop;
      bitcnt -= drop;
    }
    function bytePos() { return pos - ((bitcnt + 7) >> 3); }
    return { bits: bits, align: align, bytePos: bytePos, get pos() { return pos; }, set pos(v) { pos = v; } };
  }

  // 由码长构造规范 Huffman 表，返回 {symbols, count, offsets}（RFC1951 3.2.2）
  function buildHuffman(lengths) {
    var MAXBITS = 15;
    var count = new Uint16Array(MAXBITS + 1);
    var i;
    for (i = 0; i < lengths.length; i++) {
      if (lengths[i] < 0 || lengths[i] > MAXBITS) throw new Error('inflate: 非法码长');
      count[lengths[i]]++;
    }
    count[0] = 0;
    var offsets = new Int32Array(MAXBITS + 2);
    for (i = 1; i <= MAXBITS; i++) offsets[i + 1] = offsets[i] + count[i];
    var symbols = new Uint16Array(lengths.length);
    var idx = new Int32Array(MAXBITS + 1);
    for (i = 1; i <= MAXBITS; i++) idx[i] = offsets[i];
    for (i = 0; i < lengths.length; i++) {
      var len = lengths[i];
      if (len !== 0) symbols[idx[len]++] = i;
    }
    return { symbols: symbols, offsets: offsets, maxBits: MAXBITS };
  }

  function decodeSymbol(reader, table) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= table.maxBits; len++) {
      code |= reader.bits(1);
      var count = table.offsets[len + 1] - table.offsets[len];
      if (code - count < first) return table.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: Huffman 编码超出码表');
  }

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function inflateBlock(view, reader, out, fixedLit, fixedDist) {
    var bfinal = reader.bits(1);
    var btype = reader.bits(2);
    var litTable, distTable;
    if (btype === 0) {
      reader.align();
      var p = reader.pos;
      if (p + 4 > view.byteLength) throw new Error('inflate: stored 块越界');
      var len = view.getUint16(p, true);
      var nlen = view.getUint16(p + 2, true);
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored 块长度校验失败');
      p += 4;
      if (p + len > view.byteLength) throw new Error('inflate: stored 块越界');
      for (var i = 0; i < len; i++) out.push(view.getUint8(p + i));
      reader.pos = p + len;
      return bfinal;
    }
    if (btype === 3) throw new Error('inflate: 非法块类型 3');
    if (btype === 1) {
      litTable = fixedLit;
      distTable = fixedDist;
    } else {
      var hlit = reader.bits(5) + 257;
      var hdist = reader.bits(5) + 1;
      var hclen = reader.bits(4) + 4;
      if (hlit > 286 || hdist > 30) throw new Error('inflate: 动态码表参数非法');
      var clLengths = new Uint8Array(19);
      for (var c = 0; c < hclen; c++) clLengths[CL_ORDER[c]] = reader.bits(3);
      var clTable = buildHuffman(clLengths);
      var allLengths = new Uint8Array(hlit + hdist);
      var sym = 0;
      while (sym < hlit + hdist) {
        var s = decodeSymbol(reader, clTable);
        if (s < 16) {
          allLengths[sym++] = s;
        } else if (s === 16) {
          if (sym === 0) throw new Error('inflate: 码长重复无前置');
          var rep = reader.bits(2) + 3;
          while (rep--) allLengths[sym] = allLengths[sym - 1], sym++;
        } else if (s === 17) {
          var z = reader.bits(3) + 3;
          while (z--) allLengths[sym++] = 0;
        } else {
          var z2 = reader.bits(7) + 11;
          while (z2--) allLengths[sym++] = 0;
        }
      }
      var litLengths = allLengths.slice(0, hlit);
      var distLengths = allLengths.slice(hlit);
      litTable = buildHuffman(litLengths);
      // 距离码全为 0 表示块内无回溯（允许只有一个码、长度为 0 的表）
      var anyDist = false;
      for (var d = 0; d < distLengths.length; d++) if (distLengths[d]) { anyDist = true; break; }
      distTable = anyDist ? buildHuffman(distLengths) : null;
    }
    for (;;) {
      var sym2 = decodeSymbol(reader, litTable);
      if (sym2 < 256) {
        out.push(sym2);
      } else if (sym2 === 256) {
        break;
      } else {
        if (sym2 > 285) throw new Error('inflate: 非法长度符号 ' + sym2);
        var li = sym2 - 257;
        var length = LEN_BASE[li] + reader.bits(LEN_EXTRA[li]);
        if (!distTable) throw new Error('inflate: 缺少距离码表却出现回溯');
        var dsym = decodeSymbol(reader, distTable);
        if (dsym > 29) throw new Error('inflate: 非法距离符号 ' + dsym);
        var distance = DIST_BASE[dsym] + reader.bits(DIST_EXTRA[dsym]);
        if (distance > out.length) throw new Error('inflate: 回溯距离超出已输出数据');
        var start = out.length - distance;
        for (var k = 0; k < length; k++) out.push(out[start + k]);
      }
    }
    return bfinal;
  }

  function buildFixedTables() {
    var lit = new Uint8Array(288);
    for (var i = 0; i < 144; i++) lit[i] = 8;
    for (; i < 256; i++) lit[i] = 9;
    for (; i < 280; i++) lit[i] = 7;
    for (; i < 288; i++) lit[i] = 8;
    var dist = new Uint8Array(30);
    for (var j = 0; j < 30; j++) dist[j] = 5;
    return { lit: buildHuffman(lit), dist: buildHuffman(dist) };
  }

  function inflate(bytes, start, compSize) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var end = start + compSize;
    var reader = makeBitReader(view, start, end);
    var fixed = buildFixedTables();
    var out = [];
    var bfinal = 0;
    while (!bfinal) bfinal = inflateBlock(view, reader, out, fixed.lit, fixed.dist);
    return new Uint8Array(out);
  }

  /* ---------------- ZIP 容器解析 ---------------- */
  function u16(view, off) { return view.getUint16(off, true); }
  function u32(view, off) { return view.getUint32(off, true); }

  // 校验路径：必须是相对路径、无盘符、无反斜杠、无 .. 段，不允许以 / 开头
  function safePath(name) {
    if (name === '' || name.indexOf('\\') !== -1 || name.charAt(0) === '/') return false;
    if (/^[A-Za-z]:/.test(name)) return false;
    var parts = name.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..' || parts[i] === '' ) {
        // 允许末尾斜杠（目录项），中间空段不允许
        if (i === parts.length - 1 && parts[i] === '') continue;
        return false;
      }
    }
    return true;
  }

  /**
   * 解析 ZIP，返回 Map<path, Uint8Array>（目录项除外）。
   * options: { verifyCrc: true }
   */
  function unzip(buffer, options) {
    if (!(buffer instanceof ArrayBuffer) && !(ArrayBuffer.isView(buffer))) {
      throw new Error('ZIP: 需要 ArrayBuffer 或 TypedArray');
    }
    var bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 22) throw new Error('ZIP: 文件过小，不是有效 ZIP');

    // 从尾部找 EOCD 签名 0x06054b50
    var eocd = -1;
    var maxScan = Math.min(bytes.length, 22 + 65535);
    for (var i = bytes.length - 22; i >= bytes.length - maxScan; i--) {
      if (i < 0) break;
      if (u32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: 未找到中央目录结束标记（EOCD）');
    var diskNo = u16(view, eocd + 4);
    var cdDisk = u16(view, eocd + 6);
    if (diskNo !== 0 || cdDisk !== 0) throw new Error('ZIP: 不支持分盘压缩包');
    var total = u16(view, eocd + 10);
    var cdSize = u32(view, eocd + 12);
    var cdOff = u32(view, eocd + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP: 不支持 ZIP64');
    if (cdOff + cdSize > bytes.length) throw new Error('ZIP: 中央目录越界');

    var entries = new Map();
    var p = cdOff;
    for (var n = 0; n < total; n++) {
      if (p + 46 > bytes.length || u32(view, p) !== 0x02014b50) throw new Error('ZIP: 中央目录项损坏');
      var flags = u16(view, p + 8);
      var method = u16(view, p + 10);
      var crc = u32(view, p + 16);
      var compSize = u32(view, p + 20);
      var uncompSize = u32(view, p + 24);
      var nameLen = u16(view, p + 28);
      var extraLen = u16(view, p + 30);
      var commentLen = u16(view, p + 32);
      var localOff = u32(view, p + 42);
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
        throw new Error('ZIP: 不支持 ZIP64');
      }
      if (flags & 0x1) throw new Error('ZIP: 不支持加密条目');
      if (flags & 0x8) throw new Error('ZIP: 不支持数据描述符（流式）条目');
      if (flags & ~0x3fff) throw new Error('ZIP: 使用了不支持的标志位 0x' + flags.toString(16));
      var nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      var name = utf8Decode(nameBytes);
      p += 46 + nameLen + extraLen + commentLen;
      if (!safePath(name)) throw new Error('ZIP: 条目路径非法: ' + name);
      if (name.charAt(name.length - 1) === '/') continue; // 目录项
      if (entries.has(name)) throw new Error('ZIP: 条目重复: ' + name);

      if (localOff + 30 > bytes.length || u32(view, localOff) !== 0x04034b50) {
        throw new Error('ZIP: 本地文件头损坏: ' + name);
      }
      var lNameLen = u16(view, localOff + 26);
      var lExtraLen = u16(view, localOff + 28);
      var dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (dataOff + compSize > bytes.length) throw new Error('ZIP: 条目数据越界: ' + name);
      var raw;
      if (method === 0) {
        if (compSize !== uncompSize) throw new Error('ZIP: stored 条目尺寸不一致: ' + name);
        raw = bytes.slice(dataOff, dataOff + compSize);
      } else if (method === 8) {
        raw = inflate(bytes, dataOff, compSize);
        if (raw.length !== uncompSize) throw new Error('ZIP: 解压尺寸不符: ' + name);
      } else {
        throw new Error('ZIP: 不支持的压缩方式 ' + method + '（仅支持 stored/deflate）: ' + name);
      }
      if (options && options.verifyCrc && crc32(raw) !== crc) {
        throw new Error('ZIP: CRC32 校验失败: ' + name);
      }
      entries.set(name, raw);
    }
    return entries;
  }

  function utf8Decode(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) { /* Node 旧版本兜底走手动解码 */ }
    var s = '';
    for (var i = 0; i < bytes.length; ) {
      var b = bytes[i++];
      var cp;
      if (b < 0x80) cp = b;
      else if ((b & 0xe0) === 0xc0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if ((b & 0xf0) === 0xe0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      if (cp > 0xffff) {
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        s += String.fromCharCode(cp);
      }
    }
    return s;
  }

  var api = { unzip: unzip, inflate: inflate, crc32: crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.StokesZip = api;
})(typeof window !== 'undefined' ? window : globalThis);
