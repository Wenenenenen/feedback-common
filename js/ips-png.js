/* PNG 解码（8 位 RGBA、非隔行）与 8 位索引 PNG 编码（固定 PLTE/tRNS）。
 * 不依赖 DOM（解码用 DecompressionStream，浏览器与 Node>=17 均可用）。 */
(function () {
  const IPS = (globalThis.IPS = globalThis.IPS || {});

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  async function inflate(data) {
    const ds = new DecompressionStream("deflate"); // zlib（RFC1950）格式
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 解码 8 位 RGBA PNG → {width, height, data: Uint8Array(RGBA)}
  // 校验：签名、bitdepth=8、colortype=6、非隔行；尺寸上限由调用方检查。
  IPS.decodePng = async function (buffer) {
    const d = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    for (let i = 0; i < 8; i++) {
      if (d[i] !== PNG_SIG[i]) throw new Error("不是 PNG 文件");
    }
    let pos = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let sawIhdr = false;
    while (pos + 12 <= d.length) {
      const len =
        ((d[pos] << 24) | (d[pos + 1] << 16) | (d[pos + 2] << 8) | d[pos + 3]) >>> 0;
      const type = String.fromCharCode(d[pos + 4], d[pos + 5], d[pos + 6], d[pos + 7]);
      const body = d.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") {
        const v = new DataView(d.buffer, d.byteOffset + pos + 8, 13);
        width = v.getUint32(0);
        height = v.getUint32(4);
        bitDepth = v.getUint8(8);
        colorType = v.getUint8(9);
        if (v.getUint8(10) !== 0 || v.getUint8(11) !== 0) throw new Error("不支持的 PNG 压缩/过滤方式");
        interlace = v.getUint8(12);
        sawIhdr = true;
      } else if (type === "IDAT") {
        idat.push(body.slice());
      } else if (type === "IEND") {
        break;
      }
      pos += 12 + len;
    }
    if (!sawIhdr) throw new Error("缺少 IHDR");
    if (bitDepth !== 8 || colorType !== 6) throw new Error("仅支持 8 位 RGBA PNG（bitdepth 8 / colortype 6）");
    if (interlace !== 0) throw new Error("不支持隔行扫描 PNG");
    if (width === 0 || height === 0) throw new Error("图片尺寸非法");

    let compressed;
    if (idat.length === 1) {
      compressed = idat[0];
    } else {
      let total = 0;
      for (const c of idat) total += c.length;
      compressed = new Uint8Array(total);
      let off = 0;
      for (const c of idat) { compressed.set(c, off); off += c.length; }
    }
    const raw = await inflate(compressed);
    const stride = width * 4;
    if (raw.length < (stride + 1) * height) throw new Error("PNG 数据长度不足");

    const out = new Uint8Array(width * height * 4);
    let prev = new Uint8Array(stride);
    let off = 0;
    for (let y = 0; y < height; y++) {
      const ft = raw[off++];
      const line = raw.subarray(off, off + stride);
      off += stride;
      const cur = out.subarray(y * stride, (y + 1) * stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let x = line[i];
        if (ft === 1) x = (x + a) & 255;
        else if (ft === 2) x = (x + b) & 255;
        else if (ft === 3) x = (x + ((a + b) >> 1)) & 255;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          x = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        } else if (ft !== 0) {
          throw new Error("未知 PNG 过滤类型 " + ft);
        }
        cur[i] = x;
      }
      prev = out.subarray(y * stride, (y + 1) * stride);
    }
    return { width, height, data: out };
  };

  // zlib 流（stored 块，不压缩；确定性输出）
  function deflateStored(data) {
    const nBlocks = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Uint8Array(2 + data.length + nBlocks * 5 + 4);
    let o = 0;
    out[o++] = 0x78;
    out[o++] = 0x01;
    let pos = 0;
    for (let i = 0; i < nBlocks; i++) {
      const len = Math.min(65535, data.length - pos);
      out[o++] = i === nBlocks - 1 ? 1 : 0;
      out[o++] = len & 255;
      out[o++] = (len >> 8) & 255;
      out[o++] = ~len & 255;
      out[o++] = (~len >> 8) & 255;
      out.set(data.subarray(pos, pos + len), o);
      o += len;
      pos += len;
    }
    const adler = IPS.adler32(data);
    out[o++] = (adler >>> 24) & 255;
    out[o++] = (adler >>> 16) & 255;
    out[o++] = (adler >>> 8) & 255;
    out[o++] = adler & 255;
    return out;
  }

  function chunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    v.setUint32(8 + body.length, IPS.crc32(out.subarray(4, 8 + body.length)));
    return out;
  }

  // 编码 8 位索引 PNG：所有图片共用同一 PLTE；tRNS 长度 = 槽数，为 [0,255,...]
  // indices: Uint8Array(width*height)；colors: [{r,g,b,a}]（槽 0 透明）
  IPS.encodeIndexedPng = function (width, height, indices, colors) {
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    ihdr[8] = 8; // bitdepth
    ihdr[9] = 3; // colortype: indexed
    // 10/11/12 = 0

    const plte = new Uint8Array(colors.length * 3);
    for (let i = 0; i < colors.length; i++) {
      plte[i * 3] = colors[i].r;
      plte[i * 3 + 1] = colors[i].g;
      plte[i * 3 + 2] = colors[i].b;
    }
    const trns = new Uint8Array(colors.length);
    trns[0] = 0;
    for (let i = 1; i < colors.length; i++) trns[i] = 255;

    const stride = width;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0; // filter: none
      raw.set(indices.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const idat = deflateStored(raw);

    const parts = [
      new Uint8Array(PNG_SIG),
      chunk("IHDR", ihdr),
      chunk("PLTE", plte),
      chunk("tRNS", trns),
      chunk("IDAT", idat),
      chunk("IEND", new Uint8Array(0)),
    ];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
})();
