// 纯 JS：ZIP 读取（store / deflate）、WAV 编解码。不依赖第三方库。
// 浏览器与 Node 共用：解压走平台 DecompressionStream('deflate-raw')。

// ---------------------------------------------------------------------------
// DecompressionStream 封装
// ---------------------------------------------------------------------------

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前环境不支持 DecompressionStream，无法解压 deflate 条目');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/**
 * 打开 ZIP，只建中央目录索引；条目内容按需解压。
 * 返回 { names(), has(name), extract(name), findBasename(name) }，
 * extract 返回 Promise<Uint8Array>。
 */
export async function openZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) throw new Error('ZIP 文件过小');
  let eocd = -1;
  const minPos = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let p = bytes.byteLength - 22; p >= minPos; p--) {
    if (dv.getUint32(p, true) === SIG_EOCD) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 中央目录结尾（EOCD）');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset >= bytes.byteLength) throw new Error('ZIP 中央目录偏移越界');

  const index = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.byteLength || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error('ZIP 中央目录损坏');
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const rawSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    index.set(name, { flags, method, compSize, rawSize, localOff });
  }

  async function extract(name) {
    const ent = index.get(name);
    if (!ent) throw new Error(`压缩包里没有 ${name}`);
    if (ent.flags & 1) throw new Error(`ZIP 条目已加密，无法读取：${name}`);
    const off = ent.localOff;
    if (off + 30 > bytes.byteLength || dv.getUint32(off, true) !== SIG_LOCAL) {
      throw new Error(`ZIP 条目头损坏：${name}`);
    }
    const lNameLen = dv.getUint16(off + 26, true);
    const lExtraLen = dv.getUint16(off + 28, true);
    const start = off + 30 + lNameLen + lExtraLen;
    if (start + ent.compSize > bytes.byteLength) throw new Error(`ZIP 条目越界：${name}`);
    const comp = bytes.subarray(start, start + ent.compSize);
    let data;
    if (ent.method === 0) {
      data = comp.slice();
    } else if (ent.method === 8) {
      data = await inflateRaw(comp);
    } else {
      throw new Error(`ZIP 条目压缩方法 ${ent.method} 不支持：${name}`);
    }
    if (ent.rawSize !== data.byteLength) {
      throw new Error(`ZIP 条目长度不符：${name}（期望 ${ent.rawSize}，实得 ${data.byteLength}）`);
    }
    return data;
  }

  return {
    names: () => Array.from(index.keys()),
    has: (name) => index.has(name),
    extract,
    findBasename(base) {
      for (const name of index.keys()) {
        const cut = name.lastIndexOf('/');
        if ((cut < 0 ? name : name.slice(cut + 1)) === base) return name;
      }
      return null;
    },
  };
}

/** 一次解出全部条目（测试与小型包用）。 */
export async function unzip(bytes) {
  const zip = await openZip(bytes);
  const out = [];
  for (const name of zip.names()) out.push({ name, data: await zip.extract(name) });
  return out;
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

const u16 = (dv, off) => dv.getUint16(off, true);
const u32 = (dv, off) => dv.getUint32(off, true);

/**
 * 解析并校验 WAV 头。要求双声道、44100Hz、16 位整数 PCM。
 * 返回 {sampleRate, channels, frames, dataOff, dataLen}。
 */
export function parseWavHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44) throw new Error('WAV 文件过小');
  if (u32(dv, 0) !== 0x46464952 /* RIFF */) throw new Error('不是 RIFF/WAV 文件');
  if (u32(dv, 8) !== 0x45564157 /* WAVE */) throw new Error('RIFF 类型不是 WAVE');
  let p = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (p + 8 <= bytes.byteLength) {
    const id = u32(dv, p);
    const size = u32(dv, p + 4);
    const body = p + 8;
    if (id === 0x20746d66 /* 'fmt ' */) {
      if (size < 16) throw new Error('fmt 块过短');
      fmt = {
        format: u16(dv, body),
        channels: u16(dv, body + 2),
        sampleRate: u32(dv, body + 4),
        blockAlign: u16(dv, body + 12),
        bits: u16(dv, body + 14),
      };
    } else if (id === 0x61746164 /* 'data' */) {
      dataOff = body;
      dataLen = Math.min(size, bytes.byteLength - body);
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV 缺少 fmt 块');
  if (dataOff < 0) throw new Error('WAV 缺少 data 块');
  if (fmt.format !== 1 && fmt.format !== 0xfffe) {
    throw new Error(`WAV 编码 ${fmt.format} 不是整数 PCM`);
  }
  if (fmt.channels !== 2) throw new Error(`WAV 声道数为 ${fmt.channels}，要求双声道`);
  if (fmt.bits !== 16) throw new Error(`WAV 位深为 ${fmt.bits}，要求 16 位`);
  if (fmt.sampleRate !== 44100) throw new Error(`WAV 采样率为 ${fmt.sampleRate}，要求 44100`);
  if (fmt.blockAlign !== 4) throw new Error(`WAV 块对齐为 ${fmt.blockAlign}，要求 4`);
  return { sampleRate: fmt.sampleRate, channels: 2, frames: Math.floor(dataLen / 4), dataOff, dataLen };
}

/**
 * 把 WAV 的 PCM 数据逐帧打包进 keys（左高 16 位）与 valid 位图。
 * valid 位图按 badL / badR 的半开区间清零对应声道位。
 * @returns {number} 实际写入帧数
 */
export function packWavInto(bytes, header, keys, valid, badL, badR) {
  const frames = header.frames;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = header.dataOff;
  for (let i = 0; i < frames; i++, o += 4) {
    const l = dv.getInt16(o, true);
    const r = dv.getInt16(o + 2, true);
    keys[i] = (((l & 0xffff) << 16) | (r & 0xffff)) >>> 0;
  }
  valid.fill(3, 0, frames);
  // 位图约定：bit0 = 左有效，bit1 = 右有效。左坏清 bit0，右坏清 bit1。
  for (const [s, e] of badL) {
    for (let i = s; i < e; i++) valid[i] &= 0xfe;
  }
  for (const [s, e] of badR) {
    for (let i = s; i < e; i++) valid[i] &= 0xfd;
  }
  return frames;
}

/** 编码 44 字节头 + 交错 PCM（L/R 等长）。 */
export function encodeWav(L, R, sampleRate = 44100) {
  const frames = L.length;
  if (R.length !== frames) throw new Error('左右声道长度不一致');
  const dataBytes = frames * 4;
  const out = new Uint8Array(44 + dataBytes);
  const dv = new DataView(out.buffer);
  const put = (off, str) => { for (let i = 0; i < 4; i++) out[off + i] = str.charCodeAt(i); };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(out.buffer, 44, frames * 2);
  for (let i = 0, j = 0; i < frames; i++, j += 2) {
    pcm[j] = L[i];
    pcm[j + 1] = R[i];
  }
  return out;
}
