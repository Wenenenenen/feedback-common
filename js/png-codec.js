/**
 * 最小 PNG 编解码器：仅支持本任务需要的 8 位灰度（color type 0）与 RGB（color type 2）、
 * 非交错、无 ancillary 块。Node 22 与现代浏览器共用 CompressionStream/DecompressionStream
 * （'deflate' 即 RFC1950 zlib 封装，正是 PNG IDAT 的格式）。
 */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crcTable();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type, body) {
  const len = u32(body.length);
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + body.length);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(body, 8);
  const crc = crc32(new Uint8Array(out.buffer, 4, 4 + body.length));
  out.set(u32(crc), 8 + body.length);
  return out;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, cc) {
  const p = a + b - cc;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - cc);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return cc;
}

/**
 * 解码 8 位灰度/RGB PNG。
 * @returns {{width:number,height:number,channels:number,data:Uint8Array}}
 */
export async function decodePng(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('不是有效的 PNG 文件（签名错误）');
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw new Error('PNG 结构损坏：块头不完整');
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const bodyStart = pos + 8;
    if (bodyStart + len + 4 > bytes.length) throw new Error(`PNG 结构损坏：${type} 块越界`);
    const body = bytes.subarray(bodyStart, bodyStart + len);
    if (type === 'IHDR') {
      ihdr = parseIhdr(body);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'PLTE' || type === 'tRNS' || type === 'acTL' || type === 'fcTL') {
      throw new Error(`不支持的 PNG 特性块 ${type}（仅 8 位灰度/RGB、非交错）`);
    }
    pos = bodyStart + len + 4;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG（当前位深 ${bitDepth}）`);
  if (colorType !== 0 && colorType !== 2) {
    throw new Error(`仅支持灰度(0)或RGB(2) PNG（当前 color type ${colorType}）`);
  }
  if (interlace !== 0) throw new Error('不支持交错 PNG');
  const channels = colorType === 0 ? 1 : 3;
  const raw = await inflate(concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new Error(`PNG 解压数据长度异常：期望 ${expected}，实际 ${raw.length}`);
  }
  const data = new Uint8Array(stride * height);
  const bpp = channels;
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcStart = y * (stride + 1) + 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const cur = raw[srcStart + x];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`不支持的 PNG 行滤波器 ${filter}`);
      }
      row[x] = v & 255;
    }
    data.set(row, y * stride);
    prevRow = row;
  }
  return { width, height, channels, data };
}

function parseIhdr(body) {
  if (body.length !== 13) throw new Error('IHDR 长度异常');
  const dv = new DataView(body.buffer, body.byteOffset, 13);
  return {
    width: dv.getUint32(0),
    height: dv.getUint32(4),
    bitDepth: body[8],
    colorType: body[9],
    compression: body[10],
    filter: body[11],
    interlace: body[12],
  };
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

/**
 * 编码 8 位 PNG（自适应行滤波）。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} data 长度 width*height*channels，取值 0..255
 * @param {1|3} channels
 * @returns {Promise<Uint8Array>}
 */
export async function encodePng(width, height, data, channels) {
  if (channels !== 1 && channels !== 3) throw new Error('仅支持灰度(1)或RGB(3)');
  const stride = width * channels;
  if (data.length !== stride * height) throw new Error('编码数据尺寸与宽高不匹配');
  const bpp = channels;
  const raw = new Uint8Array((stride + 1) * height);
  const prevRow = new Uint8Array(stride);
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const src = data.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestCost = Infinity;
    for (let f = 0; f < 4; f++) {
      let cost = 0;
      const cand = candidates[f];
      for (let x = 0; x < stride; x++) {
        // 预测子基于原始（=无损重建）相邻像素，而非滤波字节
        const a = x >= bpp ? src[x - bpp] : 0;
        const b = prevRow[x];
        const c = x >= bpp ? prevRow[x - bpp] : 0;
        let v;
        switch (f) {
          case 0: v = src[x]; break;
          case 1: v = src[x] - a; break;
          case 2: v = src[x] - b; break;
          case 3: v = src[x] - ((a + b) >> 1); break;
        }
        cand[x] = v & 255;
        cost += cand[x] < 128 ? cand[x] : 256 - cand[x];
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
      }
    }
    // Paeth（第 5 种）单独参与比较
    const paethRow = new Uint8Array(stride);
    let paethCost = 0;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? src[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      const v = src[x] - paeth(a, b, c);
      paethRow[x] = v & 255;
      paethCost += paethRow[x] < 128 ? paethRow[x] : 256 - paethRow[x];
    }
    const rowStart = y * (stride + 1);
    if (paethCost < bestCost) {
      raw[rowStart] = 4;
      raw.set(paethRow, rowStart + 1);
    } else {
      raw[rowStart] = best;
      raw.set(candidates[best], rowStart + 1);
    }
    prevRow.set(src); // 下一行的预测基准是无损重建行（即原始行）
  }
  const compressed = await deflate(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [
    new Uint8Array(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ];
  return concat(parts);
}
