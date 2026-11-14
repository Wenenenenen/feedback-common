// 纯 JavaScript PNG 编码器：8-bit RGB，无外部依赖。
// 压缩使用 zlib 流（CMF/FLG 头 + stored deflate 块 + Adler32），
// 所有主流浏览器与系统看图器均支持。

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
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(view, offset, value) {
  view.setUint32(offset, value >>> 0, false);
}

function chunk(tag, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  u32be(dv, 0, data.length);
  out.set(tag, 4);
  out.set(data, 8);
  u32be(dv, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// zlib(RFC1950) + 仅 stored(BTYPE=00) deflate 块
function zlibStored(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  const dv = new DataView(out.buffer);
  out[0] = 0x78; // CM=8, CINFO=7（32K 窗口）
  out[1] = 0x01; // FCHECK 使 (CMF*256+FLG) % 31 == 0
  let o = 2;
  for (let pos = 0; pos < data.length; pos += 65535) {
    const chunkLen = Math.min(65535, data.length - pos);
    const last = pos + chunkLen >= data.length ? 1 : 0;
    out[o++] = last;
    dv.setUint16(o, chunkLen, true); o += 2;
    dv.setUint16(o, chunkLen ^ 0xffff, true); o += 2;
    out.set(data.subarray(pos, pos + chunkLen), o);
    o += chunkLen;
  }
  u32be(dv, o, adler32(data));
  return out;
}

export function encodePng(rgb8, width, height) {
  if (rgb8.length !== width * height * 3)
    throw new Error('PNG 输入尺寸与宽高不匹配');
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  // 10..12 = 0（压缩/滤波/隔行）

  const rowBytes = width * 3;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (rowBytes + 1);
    raw[dst] = 0; // filter type 0
    raw.set(rgb8.subarray(y * rowBytes, (y + 1) * rowBytes), dst + 1);
  }
  const idat = zlibStored(raw);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(new TextEncoder().encode('IHDR'), ihdr),
    chunk(new TextEncoder().encode('IDAT'), idat),
    chunk(new TextEncoder().encode('IEND'), new Uint8Array(0)),
  ]);
}
