// wav.js — WAV 解析、float32 多声道 WAV 写出、ZIP 读取（浏览器 / Node 通用）

// ---------- 16bit 单声道 PCM 解析，PCM 以 32768 归一 ----------
function parseMonoPcm16(buffer) {
  const dv = new DataView(buffer);
  const readStr = (o, l) => {
    let s = '';
    for (let i = 0; i < l; i++) s += String.fromCharCode(dv.getUint8(o + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw err('BAD_WAV', '不是合法的 RIFF/WAVE 文件');
  }
  let off = 12;
  let fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buffer.byteLength) {
    const id = readStr(off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        tag: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw err('BAD_WAV', '缺少 fmt 块');
  if (dataOff < 0) throw err('BAD_WAV', '缺少 data 块');
  if (fmt.tag !== 1) throw err('BAD_WAV', '仅支持 PCM（formatTag=1），当前 ' + fmt.tag);
  if (fmt.channels !== 1) throw err('BAD_WAV', '仅支持单声道，当前 ' + fmt.channels + ' 声道');
  if (fmt.bits !== 16) throw err('BAD_WAV', '仅支持 16 位 PCM，当前 ' + fmt.bits + ' 位');
  if (fmt.sampleRate !== 48000) throw err('BAD_WAV', '仅支持 48kHz，当前 ' + fmt.sampleRate + 'Hz');
  const nFrames = Math.floor(dataLen / 2);
  if (nFrames > 48000 * 15) throw err('BAD_WAV', '音频超过 15 秒上限（' + nFrames + ' 帧）');
  const samples = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    samples[i] = dv.getInt16(dataOff + i * 2, true) / 32768;
  }
  return { sampleRate: fmt.sampleRate, samples, nFrames };
}

// ---------- float32 多声道 WAV 写出（声道按数值 id 升序，交错排列）----------
function writeFloatWav(channels, sampleRate) {
  const nCh = channels.length;
  const nFrames = channels[0].length;
  for (const c of channels) {
    if (c.length !== nFrames) throw err('BAD_WAV', '各声道长度不一致');
  }
  const dataBytes = nFrames * nCh * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  dv.setUint32(16, 16, true);          // fmt 块大小
  dv.setUint16(20, 3, true);           // IEEE float
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nCh * 4, true); // 字节率
  dv.setUint16(32, nCh * 4, true);     // 块对齐
  dv.setUint16(34, 32, true);          // 32 位
  ws(36, 'data');
  dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let f = 0; f < nFrames; f++) {
    for (let ch = 0; ch < nCh; ch++) {
      dv.setFloat32(o, channels[ch][f], true);
      o += 4;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- 极简 ZIP 读取（stored / deflate，含 data descriptor）----------
async function readZipEntries(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  // 定位 EOCD（从尾部扫描签名 0x06054b50）
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw err('BAD_ZIP', '未找到 ZIP 中央目录');
  const total = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  let p = cdOff;
  for (let k = 0; k < total; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw err('BAD_ZIP', '中央目录结构损坏');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = bytesToStr(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 本地头定位数据
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw err('BAD_ZIP', '本地文件头损坏: ' + name);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    let dOff = localOff + 30 + lNameLen + lExtraLen;
    let dLen = compSize;
    const flags = dv.getUint16(localOff + 6, true);
    if (flags & 0x08) {
      // data descriptor：本地头中长度为 0，扫描后续的 PK\x07\x08 签名定位
      let q = dOff;
      let found = -1;
      while (q + 16 <= buffer.byteLength) {
        if (dv.getUint32(q, true) === 0x08074b50) { found = q; break; }
        q++;
      }
      if (found < 0) throw err('BAD_ZIP', '压缩包 data descriptor 解析失败: ' + name);
      dLen = found - dOff;
    }
    let raw = u8.subarray(dOff, dOff + dLen);
    let out;
    if (method === 0) {
      out = raw.slice();
    } else if (method === 8) {
      out = await inflateRaw(raw);
    } else {
      throw err('BAD_ZIP', '不支持的 ZIP 压缩方式 ' + method + '（' + name + '）');
    }
    entries.set(name.split('/').pop(), out); // 扁平化：只取文件名
  }
  return entries;
}

async function inflateRaw(u8) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Node 回退（理论上 Node 18+ 已内置 DecompressionStream）
  const zlib = require('zlib');
  return new Promise((resolve, reject) =>
    zlib.inflateRaw(Buffer.from(u8), (e, r) => e ? reject(e) : resolve(new Uint8Array(r))));
}

function bytesToStr(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
function err(code, message) { const e = new Error(message); e.code = code; return e; }

const wavApi = { parseMonoPcm16, writeFloatWav, readZipEntries, err };
if (typeof module !== 'undefined' && module.exports) module.exports = wavApi;
if (typeof window !== 'undefined') window.SimplexWav = wavApi;
