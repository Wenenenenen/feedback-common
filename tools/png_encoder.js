/*
 * Minimal PNG encoder: 8-bit or 16-bit, grayscale (color type 0) or RGB
 * (color type 2), non-interlaced. Compression uses CompressionStream where
 * available (browsers) and falls back to an uncompressed zlib stream (stored
 * deflate blocks), which every PNG decoder accepts. No third-party code.
 */
(function (global) {
  "use strict";

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

  function adler32(bytes) {
    var a = 1, b = 0;
    for (var i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function chunk(type, data) {
    var len = data.length;
    var out = new Uint8Array(len + 12);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(len + 8, crc32(out.subarray(4, len + 8)));
    return out;
  }

  function concat(parts) {
    var total = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  // Stored (uncompressed) zlib stream: 2-byte zlib header, stored deflate
  // blocks (max 65535 payload bytes), 4-byte adler32 trailer.
  function storedZlib(data) {
    var blocks = Math.ceil(data.length / 65535) || 1;
    var out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    out[0] = 0x78; out[1] = 0x01;
    var pos = 2, off = 0;
    while (off < data.length || off === 0) {
      var n = Math.min(65535, data.length - off);
      var last = off + n >= data.length ? 1 : 0;
      out[pos++] = last;
      out[pos++] = n & 0xff; out[pos++] = (n >> 8) & 0xff;
      out[pos++] = (~n) & 0xff; out[pos++] = ((~n) >> 8) & 0xff;
      out.set(data.subarray(off, off + n), pos);
      pos += n; off += n;
      if (data.length === 0) break;
    }
    var dv = new DataView(out.buffer);
    dv.setUint32(pos, adler32(data));
    return out;
  }

  function zlibCompress(data) {
    if (typeof CompressionStream !== "undefined") {
      try {
        var cs = new CompressionStream("deflate");
        var stream = new Blob([data]).stream().pipeThrough(cs);
        return new Response(stream).arrayBuffer().then(function (buf) {
          return new Uint8Array(buf);
        });
      } catch (e) { /* fall through */ }
    }
    return Promise.resolve(storedZlib(data));
  }

  /*
   * samples: Uint8Array (8-bit) or Uint16Array (16-bit), planar pixel order,
   * channels = 1 (grayscale) or 3 (RGB). Each scanline gets a filter-0 byte.
   */
  function encodePng(width, height, channels, bitDepth, samples, text) {
    var bytesPerSample = bitDepth / 8;
    var rowBytes = width * channels * bytesPerSample;
    var raw = new Uint8Array((rowBytes + 1) * height);
    var dv = new DataView(raw.buffer);
    var sp = 0, rp = 0;
    for (var y = 0; y < height; y++) {
      raw[rp++] = 0; // filter type none
      if (bitDepth === 8) {
        for (var i = 0; i < rowBytes; i++) raw[rp++] = samples[sp++];
      } else {
        for (var j = 0; j < width * channels; j++) dv.setUint16(rp, samples[sp++], false), rp += 2;
      }
    }

    var colorType = channels === 1 ? 0 : 2;
    var ihdr = new Uint8Array(13);
    var hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    var textChunks = [];
    if (text) {
      Object.keys(text).forEach(function (key) {
        var kb = new TextEncoder().encode(key);
        var vb = new TextEncoder().encode(String(text[key]));
        var payload = new Uint8Array(kb.length + 1 + vb.length);
        payload.set(kb, 0); payload[kb.length] = 0; payload.set(vb, kb.length + 1);
        textChunks.push(chunk("tEXt", payload));
      });
    }

    var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    return zlibCompress(raw).then(function (compressed) {
      return concat([sig, chunk("IHDR", ihdr)]
        .concat(textChunks)
        .concat([chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))]));
    });
  }

  // Quantization per 约定.txt: clip to [0,1], then floor(65535*v + 0.5).
  function quantize16(v) {
    if (!(v > 0)) v = 0;       // clips negatives and NaN
    if (v > 1) v = 1;
    return Math.floor(65535 * v + 0.5);
  }
  function quantize8(v) {
    if (!(v > 0)) v = 0;
    if (v > 1) v = 1;
    return Math.floor(255 * v + 0.5);
  }

  var api = {
    encodePng: encodePng,
    quantize16: quantize16,
    quantize8: quantize8,
    crc32: crc32,
    adler32: adler32,
    storedZlib: storedZlib
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.PngEncoder = api;
})(typeof window !== "undefined" ? window : globalThis);
