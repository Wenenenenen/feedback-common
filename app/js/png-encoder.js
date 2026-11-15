// 纯 JS PNG 编码：输入 RGBA 字节，输出 sRGB PNG（带 sRGB/gAMA/cHRM 块标注）。
// deflate 优先用浏览器 CompressionStream，Node 18+ 同样支持；失败回退到存储块。
(function (global) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    // CRC 覆盖 type + data，位于块尾 4 字节
    dv.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
    return out;
  }

  function concat(parts) {
    const total = parts.reduce((t, p) => t + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // 存储型 zlib（无压缩），作为 CompressionStream 不可用时的回退
  function storedZlib(data) {
    const blocks = Math.ceil(data.length / 65535) || 1;
    const out = new Uint8Array(data.length + 6 * blocks + 6);
    let o = 0;
    out[o++] = 0x78; out[o++] = 0x01;
    for (let pos = 0; pos < data.length || data.length === 0; ) {
      const chunk = data.subarray(pos, pos + 65535);
      const last = pos + chunk.length >= data.length ? 1 : 0;
      out[o++] = last;
      out[o++] = chunk.length & 0xff; out[o++] = (chunk.length >> 8) & 0xff;
      out[o++] = (~chunk.length) & 0xff; out[o++] = ((~chunk.length) >> 8) & 0xff;
      out.set(chunk, o); o += chunk.length;
      pos += chunk.length;
      if (last) break;
    }
    let adler = 1, a = 1, b = 0;
    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]) % 65521;
      b = (b + a) % 65521;
    }
    adler = ((b << 16) | a) >>> 0;
    out[o++] = (adler >>> 24) & 0xff;
    out[o++] = (adler >>> 16) & 0xff;
    out[o++] = (adler >>> 8) & 0xff;
    out[o++] = adler & 0xff;
    return out.subarray(0, o);
  }

  async function deflateZlib(data) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const cs = new CompressionStream('deflate');
        const stream = new Blob([data]).stream().pipeThrough(cs);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) { /* 回退 */ }
    }
    return storedZlib(data);
  }

  async function encodePng(width, height, rgba) {
    if (rgba.length !== width * height * 4) {
      throw new Error('PNG 编码：像素数据尺寸不匹配');
    }
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;   // 8-bit
    ihdr[9] = 6;   // RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    // 加每行 filter 字节（filter 0）
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 4 + 1)] = 0;
      raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    const idat = await deflateZlib(raw);

    // sRGB 标注（渲染意图 0）+ gAMA 0.45455，双重声明色彩空间
    const srgbChunk = chunk('sRGB', new Uint8Array([0]));
    const gama = new Uint8Array(4);
    new DataView(gama.buffer).setUint32(0, 45455);
    const chrm = new Uint8Array(32);
    const cdv = new DataView(chrm.buffer);
    [0.3127, 0.3290, 0.64, 0.33, 0.30, 0.60, 0.15, 0.06].forEach((v, i) =>
      cdv.setUint32(i * 4, Math.round(v * 100000)));

    return concat([
      sig,
      chunk('IHDR', ihdr),
      srgbChunk,
      chunk('gAMA', gama),
      chunk('cHRM', chrm),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0))
    ]);
  }

  global.PngEncoder = { encodePng };
})(typeof window !== 'undefined' ? window : globalThis);
