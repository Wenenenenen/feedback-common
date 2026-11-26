/*
 * Minimal ZIP reader / writer for the browser (no dependencies).
 *
 * Reader: locate the end-of-central-directory record, walk the central
 * directory, then inflate entries on demand.  Method 0 (stored) and
 * method 8 (deflate) are supported; deflate uses DecompressionStream.
 *
 * Writer: store-only archives, enough for bundling exported PNG frames.
 */
(function (global) {
  'use strict';

  var VCC = global.VCC = global.VCC || {};

  // ---- CRC32 -----------------------------------------------------------
  var crcTable = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('浏览器不支持 DecompressionStream，无法解压 ZIP'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function ZipArchive(arrayBuffer) {
    this.bytes = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
    this.entries = new Map();
    this._parse();
  }

  ZipArchive.prototype._u16 = function (off) { return this.view.getUint16(off, true); };
  ZipArchive.prototype._u32 = function (off) { return this.view.getUint32(off, true); };

  ZipArchive.prototype._parse = function () {
    var bytes = this.bytes;
    var len = bytes.length;
    // end of central directory: signature 0x06054b50
    var eocd = -1;
    var scanStart = Math.max(0, len - 65557);
    for (var i = len - 22; i >= scanStart; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    var count = this._u16(eocd + 10);
    var cdOffset = this._u32(eocd + 16);

    var p = cdOffset;
    var decoder = new TextDecoder('utf-8');
    for (var e = 0; e < count; e++) {
      if (this._u32(p) !== 0x02014b50) break;
      var flags = this._u16(p + 8);
      var method = this._u16(p + 10);
      var crc = this._u32(p + 16);
      var compSize = this._u32(p + 20);
      var uncompSize = this._u32(p + 24);
      var nameLen = this._u16(p + 28);
      var extraLen = this._u16(p + 30);
      var commentLen = this._u16(p + 32);
      var localOffset = this._u32(p + 42);
      var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (!/\/$/.test(name)) {
        this.entries.set(name, {
          name: name,
          method: method,
          crc: crc,
          compSize: compSize,
          uncompSize: uncompSize,
          localOffset: localOffset,
          flags: flags
        });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  };

  ZipArchive.prototype.list = function () { return Array.from(this.entries.keys()); };

  ZipArchive.prototype.read = function (name) {
    var ent = this.entries.get(name);
    if (!ent) return Promise.reject(new Error('ZIP 内找不到 ' + name));
    var p = ent.localOffset;
    if (this._u32(p) !== 0x04034b50) return Promise.reject(new Error('ZIP 本地文件头损坏: ' + name));
    var nameLen = this._u16(p + 26);
    var extraLen = this._u16(p + 28);
    var dataStart = p + 30 + nameLen + extraLen;
    var data = this.bytes.subarray(dataStart, dataStart + ent.compSize);
    if (ent.method === 0) return Promise.resolve(data);
    if (ent.method === 8) return inflateRaw(data);
    return Promise.reject(new Error('不支持的 ZIP 压缩方式 ' + ent.method));
  };

  VCC.ZipArchive = ZipArchive;
  VCC.crc32 = crc32;

  // ---- writer (store only) --------------------------------------------
  function buildZip(files) {
    // files: [{ name, data: Uint8Array }]
    var encoder = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var dosTime = 0;
    var dosDate = 0x21; // 1980-01-01

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nameBytes = encoder.encode(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local);
      parts.push(data);

      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + data.length;
    }

    var cdStart = offset;
    var cdSize = 0;
    for (var c = 0; c < central.length; c++) { parts.push(central[c]); cdSize += central[c].length; }

    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    parts.push(end);

    return new Blob(parts, { type: 'application/zip' });
  }

  VCC.buildZip = buildZip;
})(typeof self !== 'undefined' ? self : window);
