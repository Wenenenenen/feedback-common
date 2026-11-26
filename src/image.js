/*
 * PPM (P6) / PNG / JPEG decoding into {width, height, canvas}.
 * Sample assets are 8-bit binary P6 PPMs; browsers cannot display those
 * directly, so they are decoded pixel-by-pixel into a canvas here.
 */
(function (global) {
  'use strict';
  var VCC = global.VCC = global.VCC || {};

  function parsePPM(bytes) {
    // P6\n<w> <h>\n<maxval>\n<pixels>
    var pos = 0;
    var header = [];
    while (header.length < 4 && pos < bytes.length) {
      // skip whitespace and comments
      while (pos < bytes.length && (bytes[pos] === 32 || bytes[pos] === 9 ||
             bytes[pos] === 10 || bytes[pos] === 13)) pos++;
      if (bytes[pos] === 35) { // '#'
        while (pos < bytes.length && bytes[pos] !== 10) pos++;
        continue;
      }
      var start = pos;
      while (pos < bytes.length && bytes[pos] !== 32 && bytes[pos] !== 9 &&
             bytes[pos] !== 10 && bytes[pos] !== 13) pos++;
      header.push(new TextDecoder().decode(bytes.subarray(start, pos)));
      if (header.length === 1 && header[0] !== 'P6') throw new Error('仅支持 P6 二进制 PPM');
    }
    if (header.length < 4) throw new Error('PPM 头部不完整');
    var w = parseInt(header[1], 10);
    var h = parseInt(header[2], 10);
    var maxval = parseInt(header[3], 10);
    pos++; // single whitespace after maxval
    if (!(w > 0) || !(h > 0)) throw new Error('PPM 尺寸无效');
    if (maxval !== 255) throw new Error('仅支持 8 位 PPM（maxval=255）');
    var need = w * h * 3;
    if (bytes.length - pos < need) throw new Error('PPM 像素数据不足');

    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var src = pos;
    var dst = img.data;
    for (var i = 0, j = 0; i < need; i += 3, j += 4) {
      dst[j] = bytes[src + i];
      dst[j + 1] = bytes[src + i + 1];
      dst[j + 2] = bytes[src + i + 2];
      dst[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { width: w, height: h, canvas: canvas };
  }

  function decodeBlob(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes[0] === 0x50 && bytes[1] === 0x36) return parsePPM(bytes);
      return createImageBitmap(blob).then(function (bmp) {
        var canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        return { width: bmp.width, height: bmp.height, canvas: canvas };
      });
    });
  }

  // Decode one image file (by name) from an opened project folder/zip.
  function decodeSource(source, name) {
    return source.readFile(name).then(function (blob) { return decodeBlob(blob); });
  }

  VCC.parsePPM = parsePPM;
  VCC.decodeBlob = decodeBlob;
  VCC.decodeSource = decodeSource;
})(typeof self !== 'undefined' ? self : window);
