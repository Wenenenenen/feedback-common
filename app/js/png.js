// 自实现 PNG 编解码：仅支持约定要求的 8 位 RGB(2) / RGBA(6)、非隔行 PNG。
// zlib/deflate 借助运行时内置的 CompressionStream/DecompressionStream，
// PNG 签名、分块、CRC32、滤波器反算均为手写，不使用任何现成图像/配准接口。

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

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

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// 返回 { width, height, channels, data: Uint8ClampedArray(RGBA) }
export async function decodePng(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('不是有效的 PNG 文件（签名错误）');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw new Error('PNG 结构损坏：分块长度越界');
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const start = pos + 8;
    if (start + len + 4 > bytes.length) throw new Error('PNG 结构损坏：分块内容越界');
    const chunk = bytes.subarray(start, start + len);
    if (type === 'IHDR') {
      const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      const compression = chunk[10];
      const filter = chunk[11];
      interlace = chunk[12];
      if (compression !== 0 || filter !== 0) throw new Error('不支持的 PNG 压缩/滤波方式');
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    pos = start + len + 4;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8 位 PNG，当前位深为 ' + bitDepth);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error('仅支持 8 位 RGB 或 RGBA PNG，color type=' + colorType + ' 不在范围内');
  }
  if (interlace !== 0) throw new Error('不支持 Adam7 隔行扫描 PNG');
  if (width < 1 || height < 1 || width > 1024 || height > 1024) {
    throw new Error(`PNG 尺寸 ${width}x${height} 超出支持范围（单边 1..1024）`);
  }
  const srcCh = colorType === 2 ? 3 : 4;
  const raw = await inflate(concat(idat));
  const stride = width * srcCh;
  const expected = height * (stride + 1);
  if (raw.length !== expected) throw new Error('PNG 解压后尺寸与 IHDR 不符');

  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rp++];
    const line = new Uint8Array(raw.buffer, raw.byteOffset + rp, stride);
    const recon = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawX = line[x];
      const a = x >= srcCh ? recon[x - srcCh] : 0;
      const b = prev[x];
      const c = x >= srcCh ? prev[x - srcCh] : 0;
      let v;
      switch (filterType) {
        case 0: v = rawX; break;
        case 1: v = rawX + a; break;
        case 2: v = rawX + b; break;
        case 3: v = rawX + ((a + b) >> 1); break;
        case 4: v = rawX + paeth(a, b, c); break;
        default: throw new Error('PNG 含未知滤波器类型 ' + filterType);
      }
      recon[x] = v & 255;
    }
    const rowOut = y * width * 4;
    if (srcCh === 4) {
      out.set(recon, rowOut);
    } else {
      for (let x = 0; x < width; x++) {
        out[rowOut + x * 4] = recon[x * 3];
        out[rowOut + x * 4 + 1] = recon[x * 3 + 1];
        out[rowOut + x * 4 + 2] = recon[x * 3 + 2];
        out[rowOut + x * 4 + 3] = 255;
      }
    }
    prev.set(recon);
    rp += stride;
  }
  return { width, height, channels: 4, data: out };
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
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

// data: Uint8ClampedArray/Uint8Array，RGBA，长度 = width*height*4
export async function encodePng(width, height, data) {
  if (data.length !== width * height * 4) throw new Error('编码数据尺寸不匹配');
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 滤波器 0 (None)
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = await deflate(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Uint8Array.from(PNG_SIG);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  return concat(parts);
}
