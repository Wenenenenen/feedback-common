/*
 * 最小 8 位灰度 PNG 读写（手工实现 chunk 组装、反滤镜与校验）。
 * 仅依赖注入的 zlib（pako）完成 IDAT 的 deflate/inflate，不使用任何图像编码器
 * 代替 G53 流；PNG 只负责把实验图片搬进/搬出浏览器。
 *
 * 支持读取：位深 8、颜色类型 0（灰度），滤镜 0..4、多 IDAT、 Adam7 以外的常见情况。
 * 写出：位深 8 灰度、滤镜类型 0（None），单 IDAT。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PNG8 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function u32be(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }

  function readU32(data, off) {
    return (data[off] * 0x1000000 + (data[off + 1] << 16) +
      (data[off + 2] << 8) + data[off + 3]) >>> 0;
  }

  function ascii(bytes) {
    return String.fromCharCode.apply(null, bytes);
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  /** 解析 8 位灰度 PNG，返回 { width, height, pixels:Uint8Array } */
  function decode(uint8, zlib) {
    for (let i = 0; i < 8; i++) {
      if (uint8[i] !== PNG_SIG[i]) throw new Error('PNG 签名错误');
    }
    let off = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];

    while (off < uint8.length) {
      const len = readU32(uint8, off);
      const type = ascii(uint8.subarray(off + 4, off + 8));
      const body = uint8.subarray(off + 8, off + 8 + len);
      // CRC 校验（类型+内容）
      const crcInput = new Uint8Array(4 + len);
      crcInput.set(uint8.subarray(off + 4, off + 8), 0);
      crcInput.set(body, 4);
      const expectCrc = readU32(uint8, off + 8 + len);
      // CRC 由调用方可选校验；这里用 zlib 注入的 crc32（与 G53 同实现）
      if (zlib.crc32 && zlib.crc32(crcInput) !== expectCrc) {
        throw new Error('PNG chunk ' + type + ' CRC 错误');
      }
      if (type === 'IHDR') {
        width = readU32(body, 0);
        height = readU32(body, 4);
        bitDepth = body[8];
        colorType = body[9];
        interlace = body[12];
      } else if (type === 'IDAT') {
        idat.push(body);
      } else if (type === 'IEND') {
        break;
      }
      off += 12 + len;
    }

    if (colorType !== 0) throw new Error('仅支持灰度 PNG（color type 0），收到 ' + colorType);
    if (bitDepth !== 8) throw new Error('仅支持 8 位灰度，收到位深 ' + bitDepth);
    if (interlace !== 0) throw new Error('不支持 Adam7 隔行 PNG');
    if (width < 1 || height < 1 || width > 1024 || height > 1024) {
      throw new Error('边长需在 1..1024，实际 ' + width + 'x' + height);
    }

    const raw = zlib.inflate(concat(idat));
    const bpp = 1; // 每像素字节数
    const stride = width;
    const pixels = new Uint8Array(width * height);
    let pos = 0;

    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const rowStart = y * stride;
      const prevStart = rowStart - stride;
      for (let x = 0; x < stride; x++) {
        const cur = raw[pos++];
        const a = x >= bpp ? pixels[rowStart + x - bpp] : 0;
        const b = y > 0 ? pixels[prevStart + x] : 0;
        const c = (y > 0 && x >= bpp) ? pixels[prevStart + x - bpp] : 0;
        let v;
        switch (filter) {
          case 0: v = cur; break;
          case 1: v = cur + a; break;
          case 2: v = cur + b; break;
          case 3: v = cur + ((a + b) >> 1); break;
          case 4: v = cur + paeth(a, b, c); break;
          default: throw new Error('未知 PNG 滤镜类型 ' + filter);
        }
        pixels[rowStart + x] = v & 255;
      }
    }
    return { width, height, pixels };
  }

  function concat(arrs) {
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  function chunk(type, body, zlib) {
    const typeBytes = [];
    for (let i = 0; i < 4; i++) typeBytes.push(type.charCodeAt(i));
    const len = u32be(body.length);
    const crcInput = new Uint8Array(4 + body.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(body, 4);
    const crc = u32be(zlib.crc32(crcInput));
    return concat([Uint8Array.from(len), crcInput, Uint8Array.from(crc)]);
  }

  /** 把灰度像素编码为 8 位灰度 PNG（滤镜 None） */
  function encode(pixels, width, height, zlib) {
    if (pixels.length !== width * height) throw new Error('像素数与宽高不符');
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 0;  // color type: grayscale
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // no interlace

    // 每行前加滤镜字节 0
    const raw = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
      raw[y * (width + 1)] = 0;
      raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    }
    const idat = zlib.deflate(raw);
    return concat([
      Uint8Array.from(PNG_SIG),
      chunk('IHDR', ihdr, zlib),
      chunk('IDAT', idat, zlib),
      chunk('IEND', new Uint8Array(0), zlib),
    ]);
  }

  return { decode, encode };
});
