/*!
 * 图像编解码与合成（无第三方依赖）
 * - P6 PPM(RGB) / P5 PGM(灰度) 解析，支持 # 注释
 * - 直通(straight) / 预乘(premult) 合成；未配 -> RGBA 全 0
 * - 预乘反算采用精确有理比较实现“四舍六入五成双”
 * - 自带 PNG 编码（IHDR/IDAT/IEND + CRC32），deflate 用 CompressionStream('deflate')
 * UMD: window.GKCodec / module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GKCodec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ImageError extends Error {
    constructor(message, detail) {
      super(message);
      this.name = 'ImageError';
      this.detail = detail;
    }
  }

  // ---------------- PNM (PPM/PGM) ----------------
  function isSpace(b) {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
  }

  // 从 buf[pos] 读一个 ASCII token（跳过空白与 # 行注释）
  function readToken(buf, pos) {
    const n = buf.length;
    let p = pos;
    while (p < n) {
      const b = buf[p];
      if (isSpace(b)) { p++; continue; }
      if (b === 0x23) { // '#'
        while (p < n && buf[p] !== 0x0a && buf[p] !== 0x0d) p++;
        continue;
      }
      break;
    }
    let start = p;
    while (p < n && !isSpace(buf[p])) p++;
    return { token: Buffer_from(buf, start, p - start), next: p };
  }

  function Buffer_from(buf, start, len) {
    // 避免依赖 Buffer：直接构造字符串
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[start + i]);
    return s;
  }

  function parsePNM(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let pos = 0;
    let r = readToken(buf, pos); const magic = r.token; pos = r.next;
    r = readToken(buf, pos); const width = parseInt(r.token, 10); pos = r.next;
    r = readToken(buf, pos); const height = parseInt(r.token, 10); pos = r.next;
    r = readToken(buf, pos); const maxval = parseInt(r.token, 10); pos = r.next;

    if (magic !== 'P6' && magic !== 'P5') {
      throw new ImageError('仅支持 8 位 P6 PPM 或 P5 PGM，实际魔数为 ' + JSON.stringify(magic));
    }
    if (!(width > 0) || !(height > 0)) throw new ImageError('PNM 宽高非法');
    if (maxval !== 255) throw new ImageError('约定要求 8 位通道(maxval=255)，实际 maxval=' + maxval);

    // maxval 之后恰好一个空白符
    if (pos < buf.length && isSpace(buf[pos])) pos++;
    else throw new ImageError('PNM 头后缺少分隔空白');

    const pixels = width * height;
    if (magic === 'P6') {
      const need = pixels * 3;
      if (buf.length - pos < need) throw new ImageError('PPM 像素数据不完整：需要 ' + need + ' 字节，剩余 ' + (buf.length - pos));
      const rgb = buf.slice(pos, pos + need);
      return { kind: 'rgb', format: 'P6', width, height, rgb };
    } else {
      const need = pixels;
      if (buf.length - pos < need) throw new ImageError('PGM 像素数据不完整：需要 ' + need + ' 字节，剩余 ' + (buf.length - pos));
      const gray = buf.slice(pos, pos + need);
      return { kind: 'gray', format: 'P5', width, height, gray };
    }
  }

  function looksLikePNM(bytes, magic) {
    return bytes.length >= 2 && bytes[0] === 0x50 /* P */ && bytes[1] === magic;
  }

  // 浏览器原生格式（PNG/JPEG/...）解码为 RGBA
  async function decodeNativeRGBA(bytes) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      throw new ImageError('当前环境不支持原生图像解码，请使用约定的 PPM/PGM');
    }
    const blob = new Blob([bytes], { type: sniffMime(bytes) || 'application/octet-stream' });
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    return { kind: 'rgba', format: 'native', width: w, height: h, rgba: img.data };
  }

  function sniffMime(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
  }

  /**
   * 解码任意受支持图像。返回统一光栅：
   *   RGB 填充 -> {kind:'rgb', rgb}
   *   灰度键   -> {kind:'gray', gray}
   *   原生 RGBA-> {kind:'rgba', rgba}
   * 调用方负责按用途取通道。
   */
  async function decodeImage(bytes, path) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    try {
      // 约定格式优先按魔数识别
      if (looksLikePNM(bytes, 0x36 /* '6' */) || looksLikePNM(bytes, 0x35 /* '5' */)) {
        return parsePNM(bytes);
      }
      // 扩展名声明为 PNM 但魔数不对：交给 parsePNM 报明确错误
      if (/\.(ppm|pgm|pnm)$/i.test(path || '')) return parsePNM(bytes);
      return await decodeNativeRGBA(bytes);
    } catch (e) {
      if (e instanceof ImageError) throw e;
      throw new ImageError('图像解码失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  // 从任意光栅取第 i 像素的 RGB / 灰度 alpha
  function fillChannels(img, i) {
    if (img.kind === 'rgb') {
      const p = i * 3;
      return [img.rgb[p], img.rgb[p + 1], img.rgb[p + 2]];
    }
    // rgba（浏览器解码的 PNG 填充）：直接保留其 RGB
    const p = i * 4;
    return [img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]];
  }

  function keyAlpha(img, i) {
    if (img.kind === 'gray') return img.gray[i];
    if (img.kind === 'rgb') {
      const p = i * 3;
      // 容错：彩色“灰度键”按亮度线性化前的码值加权（约定素材本身为 P5 灰度）
      return (img.rgb[p] * 299 + img.rgb[p + 1] * 587 + img.rgb[p + 2] * 114 + 500) / 1000 | 0;
    }
    // rgba：优先 alpha 通道；若图本身是灰度不透明图，用亮度
    const p = i * 4;
    const a = img.rgba[p + 3];
    if (a < 255) return a;
    return (img.rgba[p] * 299 + img.rgba[p + 1] * 587 + img.rgba[p + 2] * 114 + 500) / 1000 | 0;
  }

  /**
   * 预乘反算：round-half-to-even(255*c/a)，精确整数比较，clamp 0..255。
   */
  function unpremultiplyExact(c, a) {
    if (a === 0) return 0;
    const num = 255 * c;
    const q = Math.floor(num / a);
    const rem = num - q * a;
    const twice = rem * 2;
    let out;
    if (twice < a) out = q;
    else if (twice > a) out = q + 1;
    else out = (q & 1) ? q + 1 : q; // 正中取偶
    if (out < 0) out = 0;
    if (out > 255) out = 255;
    return out;
  }

  /**
   * 合成一帧。
   * opts: {width,height, fill:img, key:img|null, paired:boolean, mode:'straight'|'premult'}
   * 未配键（paired=false 或 key=null）=> 整张 RGBA 0（透明黑）。
   * 返回 Uint8ClampedArray(width*height*4)
   */
  function compositeFrame(opts) {
    const { width, height, fill, key, mode } = opts;
    const out = new Uint8ClampedArray(width * height * 4); // 默认全 0
    const paired = opts.paired !== false && !!key;
    if (!paired) return out;

    const n = width * height;
    const premult = mode === 'premult';
    for (let i = 0; i < n; i++) {
      const [r, g, b] = fillChannels(fill, i);
      const a = keyAlpha(key, i) & 255;
      const o = i * 4;
      out[o + 3] = a;
      if (!premult) {
        // 直通：任何 alpha（含 0）都直接保留源 RGB
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
      } else if (a === 0) {
        // 预乘：a=0 时清空 RGB
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
      } else {
        out[o] = unpremultiplyExact(r, a);
        out[o + 1] = unpremultiplyExact(g, a);
        out[o + 2] = unpremultiplyExact(b, a);
      }
    }
    return out;
  }

  // ---------------- PNG 编码 ----------------
  const CRC_TABLE = (function () {
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
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u32be(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, false);
    return b;
  }

  function concat(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  function pngChunk(type, data) {
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
    const len = u32be(data.length);
    const crcInput = concat([typeBytes, data]);
    const crc = u32be(crc32(crcInput));
    return concat([len, typeBytes, data, crc]);
  }

  function addFilterRows(rgba, width, height) {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0; // filter: None
      raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    return raw;
  }

  async function deflateZlibWeb(raw) {
    if (typeof CompressionStream === 'undefined') {
      throw new ImageError('当前环境没有 CompressionStream，无法编码 PNG');
    }
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(raw);
    writer.close();
    const ab = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(ab);
  }

  /** 组装 PNG（idat 必须是 zlib 流）。 */
  function assemblePNG(width, height, idat) {
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width, false);
    dv.setUint32(4, height, false);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    return concat([
      sig,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
  }

  /** 浏览器/Node22 通用：异步编码 RGBA -> PNG bytes。 */
  async function encodePNG(width, height, rgba) {
    const raw = addFilterRows(rgba, width, height);
    const idat = await deflateZlibWeb(raw);
    return assemblePNG(width, height, idat);
  }

  /** Node 测试用：显式给 zlibDeflateSync。 */
  function encodePNGWithDeflate(width, height, rgba, deflateSync) {
    const raw = addFilterRows(rgba, width, height);
    const idat = deflateSync(raw);
    return assemblePNG(width, height, new Uint8Array(idat));
  }

  return {
    ImageError,
    parsePNM,
    decodeImage,
    decodeNativeRGBA,
    compositeFrame,
    unpremultiplyExact,
    fillChannels,
    keyAlpha,
    encodePNG,
    encodePNGWithDeflate,
    assemblePNG,
    addFilterRows,
    crc32,
    sniffMime,
  };
});
