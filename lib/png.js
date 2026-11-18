// 极简 PNG 编解码，零第三方依赖。
// 编码：16 位 RGB（color type 2, bit depth 16），每行 filter 0。
// 解码：支持 8/16 位、灰度/真彩/带 Alpha（本项目只用到 16 位 RGB），
//       实现全部 5 种行滤波；读到未知关键块直接报错。
// zlib：浏览器走原生 CompressionStream/DecompressionStream，Node 走 node:zlib。

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
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlibDeflate(data) {
  if (typeof globalThis.CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate'); // W3C 'deflate' = zlib(RFC1950)
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { deflateSync } = await import('node:zlib');
  return deflateSync(data);
}

async function zlibInflate(data) {
  if (typeof globalThis.DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateSync } = await import('node:zlib');
  return inflateSync(data);
}

function chunk(type, body) {
  const len = body.length;
  const out = new Uint8Array(len + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(len + 8, crc32(out.subarray(4, len + 8)));
  return out;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// rgb16: 交织的 Uint16Array（每像素 R,G,B 三个 16 位样本）
export async function encodePng16(width, height, rgb16) {
  if (rgb16.length !== width * height * 3) throw new Error('PNG 编码输入尺寸不匹配');
  const rowBytes = 1 + width * 6;
  const raw = new Uint8Array(rowBytes * height);
  let p = 0;
  let s = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width * 3; x++) {
      const v = rgb16[s++];
      raw[p++] = v >> 8;
      raw[p++] = v & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = await zlibDeflate(raw);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const PAETH = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// 返回 { width, height, depth, channels, data: Uint16Array 交织 }
// 灰度会扩成三通道；Alpha 直接丢弃（参考图均为 RGB）。
export async function decodePng(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('PNG 签名错误');

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];
  while (off < buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    const body = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== dv.getUint32(off + 8 + len)) {
      throw new Error(`PNG ${type} 块 CRC 校验失败`);
    }
    if (type === 'IHDR') {
      const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = bv.getUint32(0);
      height = bv.getUint32(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new Error('暂不支持压缩/滤波/隔行扩展的 PNG');
      }
    } else if (type === 'IDAT') {
      idatParts.push(new Uint8Array(body));
    } else if (type === 'IEND') {
      break;
    } else if (type.charCodeAt(0) < 97) {
      throw new Error(`遇到未知关键块 ${type}`);
    }
    off += 12 + len;
  }

  const srcChannels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  if (![1, 2, 4, 6].includes(colorType)) throw new Error(`不支持的 PNG color type ${colorType}`);
  if (![8, 16].includes(bitDepth)) throw new Error(`仅支持 8/16 位 PNG，收到 ${bitDepth} 位`);

  const inflated = await zlibInflate(concat(idatParts));
  const bps = bitDepth / 8; // 每样本字节数
  const stride = width * srcChannels * bps;
  const unfiltered = new Uint8Array(stride * height);
  let inOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[inOff++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const raw = inflated[inOff++];
      const a = i >= srcChannels * bps ? unfiltered[rowStart + i - srcChannels * bps] : 0;
      const b = y > 0 ? unfiltered[prevStart + i] : 0;
      const c = y > 0 && i >= srcChannels * bps ? unfiltered[prevStart + i - srcChannels * bps] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + PAETH(a, b, c); break;
        default: throw new Error(`非法 PNG 行滤波类型 ${filter}`);
      }
      unfiltered[rowStart + i] = v & 0xff;
    }
  }

  const outChannels = 3;
  const data = new Uint16Array(width * height * outChannels);
  const srcCh = srcChannels >= 3 ? srcChannels : 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < 3; ch++) {
        const srcChIdx = srcChannels >= 3 ? ch : 0;
        const pos = (y * width + x) * srcCh * bps + srcChIdx * bps;
        const v = bps === 2 ? (unfiltered[pos] << 8) | unfiltered[pos + 1] : unfiltered[pos];
        data[(y * width + x) * 3 + ch] = bps === 1 ? v * 257 : v;
      }
    }
  }
  return { width, height, depth: bitDepth, channels: 3, data };
}
