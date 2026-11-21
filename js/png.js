/*
 * png.js — minimal PNG writer for the ROI exports.
 *
 * Only what the exports need: 16-bit grayscale, 16-bit RGB and 8-bit
 * grayscale, all with filter type 0 and zlib via fflate. Chunk layout, CRCs
 * and network byte order are handled here.
 *
 * UMD: window.PngWriter in the browser, module.exports under Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/fflate.js'));
  } else {
    root.PngWriter = factory(root.fflate);
  }
})(typeof self !== 'undefined' ? self : this, function (fflate) {
  'use strict';

  const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  function crc32(bytes) {
    const table = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function be32(value) {
    return Uint8Array.from([
      (value >>> 24) & 0xff, (value >>> 16) & 0xff,
      (value >>> 8) & 0xff, value & 0xff
    ]);
  }

  function chunk(type, data) {
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
    const out = new Uint8Array(12 + data.length);
    out.set(be32(data.length), 0);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, 4);
    out.set(be32(crc32(crcInput)), 8 + data.length);
    return out;
  }

  /**
   * @param {{width:number,height:number,bitDepth:number,colorType:number,
   *          raw:Uint8Array}} opts raw already row-filtered, network order
   */
  function encode(opts) {
    const { width, height, bitDepth, colorType, raw } = opts;
    const ihdr = new Uint8Array(13);
    ihdr.set(be32(width), 0);
    ihdr.set(be32(height), 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace
    const compressed = fflate.zlibSync(raw, { level: 6 });
    const parts = [
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', compressed),
      chunk('IEND', new Uint8Array(0))
    ];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  function withFilterRows(rows, rowBytes) {
    const out = new Uint8Array(rows.length * (rowBytes + 1));
    for (let y = 0; y < rows.length; y++) {
      out[y * (rowBytes + 1)] = 0; // filter: none
      out.set(rows[y], y * (rowBytes + 1) + 1);
    }
    return out;
  }

  /** 16-bit grayscale from one value per pixel. */
  function encodeGray16(values, width, height) {
    const rowBytes = width * 2;
    const rows = [];
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(rowBytes);
      for (let x = 0; x < width; x++) {
        const v = values[y * width + x] & 0xffff;
        row[x * 2] = v >>> 8;
        row[x * 2 + 1] = v & 0xff;
      }
      rows.push(row);
    }
    return encode({
      width, height, bitDepth: 16, colorType: 0,
      raw: withFilterRows(rows, rowBytes)
    });
  }

  /** 16-bit RGB from channel-interleaved values. */
  function encodeRgb16(values, width, height, channels) {
    const rowBytes = width * 3 * 2;
    const rows = [];
    const ch = channels || 3;
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(rowBytes);
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          const v = values[(y * width + x) * ch + c] & 0xffff;
          row[(x * 3 + c) * 2] = v >>> 8;
          row[(x * 3 + c) * 2 + 1] = v & 0xff;
        }
      }
      rows.push(row);
    }
    return encode({
      width, height, bitDepth: 16, colorType: 2,
      raw: withFilterRows(rows, rowBytes)
    });
  }

  /** 8-bit grayscale mask: 255 = valid, 0 = missing. */
  function encodeMask(mask, width, height) {
    const rowBytes = width;
    const rows = [];
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(width);
      for (let x = 0; x < width; x++) row[x] = mask[y * width + x] ? 255 : 0;
      rows.push(row);
    }
    return encode({
      width, height, bitDepth: 8, colorType: 0,
      raw: withFilterRows(rows, rowBytes)
    });
  }

  return { encode, encodeGray16, encodeRgb16, encodeMask, crc32 };
});
