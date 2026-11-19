/*
 * dsp.js — 重叠 MDCT 变换 / 四频带量化 / WAV / 系数 ZIP 的纯实现。
 * 按 samples 包内《约定.txt》实现：
 *   w[n] = sin(pi*(n+0.5)/(2N))
 *   C[b,k] = sum_n x[bN+n]*w[n]*cos(pi/N*(n+0.5+N/2)*(k+0.5))
 *   反变换块 = (2/N)*w[n]*sum_k C[b,k]*cos(同上)，bN 处重叠相加，截取 [N, N+L)
 *   K = ceil(L/N)+1，前补 N 个零，后补至 (K+1)*N
 * 只使用基础 FFT（自实现）与逐点运算，不调用任何完整 MDCT/编解码器接口。
 * 同时兼容浏览器（window.MDCTDSP）与 Node（module.exports），便于离线校验。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  root.MDCTDSP = lib;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------------- 基础 FFT ----------------
  // 计算 X[k] = sum_n x[n] * exp(sign * 2*pi*i*n*k/N)，N 须为 2 的幂。
  function fft(re, im, sign) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = sign * 2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // ---------------- MDCT 表 ----------------
  const VALID_N = [128, 256, 512];
  const tableCache = new Map();

  function getTables(N) {
    if (!VALID_N.includes(N)) throw new Error('非法半窗长 N=' + N + '（仅支持 128/256/512）');
    if (tableCache.has(N)) return tableCache.get(N);
    const twoN = 2 * N;
    const w = new Float64Array(twoN);
    for (let n = 0; n < twoN; n++) w[n] = Math.sin(Math.PI * (n + 0.5) / twoN);
    // 预旋转 exp(i*pi*n/(2N))
    const preC = new Float64Array(twoN), preS = new Float64Array(twoN);
    for (let n = 0; n < twoN; n++) {
      const a = Math.PI * n / twoN;
      preC[n] = Math.cos(a); preS[n] = Math.sin(a);
    }
    // 后旋转 exp(i*pi*n0*(k+0.5)/N)，n0 = 0.5 + N/2
    const n0 = 0.5 + N / 2;
    const postC = new Float64Array(N), postS = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const a = Math.PI * n0 * (k + 0.5) / N;
      postC[k] = Math.cos(a); postS[k] = Math.sin(a);
    }
    const t = {
      N, w, preC, preS, postC, postS,
      re: new Float64Array(twoN), im: new Float64Array(twoN), // 复用暂存
    };
    tableCache.set(N, t);
    return t;
  }

  // 正变换一块：seg[off .. off+2N) -> out[0..N)
  // C[k] = Re{ exp(i*pi*n0*(k+0.5)/N) * FFT_{2N}[ x*w*exp(i*pi*n/(2N)) ] }
  function mdctBlock(seg, off, N, out, T) {
    const { w, preC, preS, postC, postS, re, im } = T;
    const twoN = 2 * N;
    for (let n = 0; n < twoN; n++) {
      const v = seg[off + n] * w[n];
      re[n] = v * preC[n];
      im[n] = v * preS[n];
    }
    fft(re, im, 1);
    for (let k = 0; k < N; k++) out[k] = postC[k] * re[k] - postS[k] * im[k];
  }

  // 反变换一块：coeff[0..N) -> out[0..2N)（已乘窗、已乘 2/N，未做重叠相加）
  function imdctBlock(coeff, N, out, T) {
    const { w, preC, preS, postC, postS, re, im } = T;
    const twoN = 2 * N;
    for (let k = 0; k < N; k++) {
      re[k] = coeff[k] * postC[k];
      im[k] = coeff[k] * postS[k];
    }
    re.fill(0, N); im.fill(0, N);
    fft(re, im, 1);
    const s = 2 / N;
    for (let n = 0; n < twoN; n++) out[n] = s * w[n] * (preC[n] * re[n] - preS[n] * im[n]);
  }

  function frameCount(L, N) { return Math.ceil(L / N) + 1; } // K

  // 单声道正变换：x 长 L，返回 { coeff: Float64Array(K*N), K }
  function analyzeChannel(x, N) {
    const L = x.length, K = frameCount(L, N), T = getTables(N);
    const padded = new Float64Array((K + 1) * N); // 前 N 个零，尾部自动补零
    padded.set(x, N);
    const coeff = new Float64Array(K * N);
    const tmp = new Float64Array(N);
    for (let b = 0; b < K; b++) {
      mdctBlock(padded, b * N, N, tmp, T);
      coeff.set(tmp, b * N);
    }
    return { coeff, K };
  }

  // 单声道反变换 + 重叠相加 + 截取 [N, N+L)，返回长度恰为 L 的重建
  function synthesizeChannel(coeff, N, L) {
    const K = coeff.length / N, T = getTables(N);
    const acc = new Float64Array((K + 1) * N);
    const tmp = new Float64Array(2 * N);
    for (let b = 0; b < K; b++) {
      imdctBlock(coeff.subarray(b * N, b * N + N), N, tmp, T);
      const off = b * N;
      for (let n = 0; n < 2 * N; n++) acc[off + n] += tmp[n];
    }
    return acc.slice(N, N + L);
  }

  // ---------------- 量化 ----------------
  function bandOf(k, N) { return Math.min(3, Math.floor(4 * k / N)); }

  // q = sign(C)*floor(|C|/step + 0.5)；任一 q 越出 [-32768,32767] 记入 overflow（按频带），不截断
  function quantize(coeff, N, steps) {
    const q = new Int32Array(coeff.length);
    const overflow = new Map(); // band -> {count, maxAbs}
    for (let i = 0; i < coeff.length; i++) {
      const band = bandOf(i % N, N);
      const v = Math.sign(coeff[i]) * Math.floor(Math.abs(coeff[i]) / steps[band] + 0.5);
      q[i] = v;
      if (v < -32768 || v > 32767) {
        const e = overflow.get(band) || { count: 0, maxAbs: 0 };
        e.count++;
        e.maxAbs = Math.max(e.maxAbs, Math.abs(v));
        overflow.set(band, e);
      }
    }
    return { q, overflow };
  }

  function dequantize(q, N, steps) {
    const out = new Float64Array(q.length);
    for (let i = 0; i < q.length; i++) out[i] = q[i] * steps[bandOf(i % N, N)];
    return out;
  }

  // ---------------- 指标 ----------------
  function metrics(x, y) {
    let sx = 0, se = 0;
    for (let i = 0; i < x.length; i++) {
      sx += x[i] * x[i];
      const d = x[i] - y[i];
      se += d * d;
    }
    return {
      mse: se / x.length,               // 误差能量（均方差）
      signalEnergy: sx,
      errorEnergy: se,
      snr: se === 0 ? Infinity : 10 * Math.log10(sx / se),
      lossless: se === 0,               // 含静音零误差情形
    };
  }

  // ---------------- WAV ----------------
  const VALID_RATES = [44100, 48000];

  function parseWav(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 12 ||
        dv.getUint32(0, false) !== 0x52494646 || // 'RIFF'
        dv.getUint32(8, false) !== 0x57415645)   // 'WAVE'
      throw new Error('不是有效的 RIFF/WAVE 文件');
    let fmt = null, dataOff = -1, dataLen = 0;
    let off = 12;
    while (off + 8 <= buf.byteLength) {
      const id = dv.getUint32(off, false);
      const size = dv.getUint32(off + 4, true);
      const body = off + 8;
      if (id === 0x666d7420) { // 'fmt '
        if (body + 16 > buf.byteLength) throw new Error('fmt 块不完整');
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          rate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
        };
      } else if (id === 0x64617461) { // 'data'
        dataOff = body;
        dataLen = Math.min(size, buf.byteLength - body);
      }
      off = body + size + (size & 1);
    }
    if (!fmt) throw new Error('缺少 fmt 块');
    if (dataOff < 0) throw new Error('缺少 data 块');
    if (fmt.format !== 1) throw new Error('仅支持未压缩 PCM（format=' + fmt.format + '）');
    if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error('仅支持单声道/双声道（当前 ' + fmt.channels + ' 声道）');
    if (!VALID_RATES.includes(fmt.rate)) throw new Error('仅支持 44.1/48 kHz（当前 ' + fmt.rate + ' Hz）');
    if (fmt.bits !== 16 && fmt.bits !== 24) throw new Error('仅支持 16/24 位 PCM（当前 ' + fmt.bits + ' 位）');
    const bytesPer = fmt.bits / 8;
    const frames = Math.floor(dataLen / (bytesPer * fmt.channels));
    if (frames < 1) throw new Error('没有可用的采样数据');
    if (frames > fmt.rate * 15) throw new Error('超过 15 秒上限（' + (frames / fmt.rate).toFixed(2) + ' s）');
    const norm = Math.pow(2, fmt.bits - 1);
    const data = [];
    for (let c = 0; c < fmt.channels; c++) data.push(new Float64Array(frames));
    let p = dataOff;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < fmt.channels; c++) {
        let v;
        if (fmt.bits === 16) {
          v = dv.getInt16(p, true); p += 2;
        } else {
          v = (dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16));
          if (v & 0x800000) v -= 0x1000000;
          p += 3;
        }
        data[c][i] = v / norm;
      }
    }
    return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, frames, data };
  }

  // 24 位 PCM WAV 导出：先限制到 [-1, 1-2^-23]，乘 2^23 后远离零舍入
  function encodeWav24(channelData, rate) {
    const ch = channelData.length, frames = channelData[0].length;
    const dataLen = frames * ch * 3;
    const buf = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(buf);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);            // PCM
    dv.setUint16(22, ch, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * ch * 3, true);
    dv.setUint16(32, ch * 3, true);
    dv.setUint16(34, 24, true);
    wstr(36, 'data'); dv.setUint32(40, dataLen, true);
    const maxV = 1 - Math.pow(2, -23);
    let p = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) {
        let v = channelData[c][i];
        if (v > maxV) v = maxV; else if (v < -1) v = -1;
        const s = Math.sign(v) * Math.round(Math.abs(v) * 8388608); // 远离零舍入
        dv.setUint8(p, s & 0xff);
        dv.setUint8(p + 1, (s >> 8) & 0xff);
        dv.setUint8(p + 2, (s >> 16) & 0xff);
        p += 3;
      }
    }
    return buf;
  }

  // ---------------- ZIP（store 写出 / store+deflate 读入） ----------------
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const te = new TextEncoder();
  const td = new TextDecoder();

  // 以 store（不压缩）方式打包，返回 Uint8Array
  function zipStore(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = te.encode(f.name);
      const crc = crc32(f.data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true); // UTF-8 名称
      head.setUint16(8, 0, true);      // store
      head.setUint16(10, 0, true); head.setUint16(12, 0x0021, true); // 固定时间戳
      head.setUint32(14, crc, true);
      head.setUint32(18, f.data.length, true);
      head.setUint32(22, f.data.length, true);
      head.setUint16(26, name.length, true);
      head.setUint16(28, 0, true);
      parts.push(new Uint8Array(head.buffer), name, f.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, 0, true); cen.setUint16(14, 0x0021, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, f.data.length, true);
      cen.setUint32(24, f.data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    let cdLen = 0;
    for (const c of central) cdLen += c.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdLen, true);
    eocd.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdLen + 22);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(new Uint8Array(eocd.buffer), p);
    return out;
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 解包 ZIP，返回 Map<name, Uint8Array>；结构损坏即抛错
  async function unzip(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP（找不到目录结尾记录）');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = new Map();
    for (let e = 0; e < count; e++) {
      if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50)
        throw new Error('ZIP 中央目录损坏');
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const compLen = dv.getUint32(p + 20, true);
      const rawLen = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (localOff + 30 > bytes.length || dv.getUint32(localOff, true) !== 0x04034b50)
        throw new Error('ZIP 本地文件头损坏（' + name + '）');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (dataOff + compLen > bytes.length) throw new Error('ZIP 数据越界（' + name + '）');
      const comp = bytes.subarray(dataOff, dataOff + compLen);
      let raw;
      if (method === 0) raw = comp.slice();
      else if (method === 8) raw = await inflateRaw(comp);
      else throw new Error('不支持的 ZIP 压缩方式 ' + method + '（' + name + '）');
      if (raw.length !== rawLen) throw new Error('解压长度不符（' + name + '）');
      if (crc32(raw) !== crc) throw new Error('CRC 校验失败（' + name + '）');
      out.set(name, raw);
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  // ---------------- 系数包 ----------------
  // header.json: version=1, rate, channels, frames=L, N, blocks=K, storage, steps
  // coefficients.bin 顺序：块 -> 声道 -> k
  function packCoefficients(opts) {
    const { rate, channels, frames, N, blocks, storage, steps } = opts;
    const header = {
      version: 1, rate, channels, frames, N, blocks, storage,
      steps: steps.slice(0, 4),
    };
    const per = storage === 'float32le' ? 4 : 2;
    const bin = new ArrayBuffer(blocks * channels * N * per);
    const dv = new DataView(bin);
    let p = 0;
    for (let b = 0; b < blocks; b++) {
      for (let c = 0; c < channels; c++) {
        for (let k = 0; k < N; k++) {
          const idx = b * N + k;
          if (storage === 'float32le') {
            dv.setFloat32(p, opts.coeff[c][idx], true); p += 4;
          } else {
            dv.setInt16(p, opts.quant[c][idx], true); p += 2;
          }
        }
      }
    }
    return zipStore([
      { name: 'header.json', data: te.encode(JSON.stringify(header)) },
      { name: 'coefficients.bin', data: new Uint8Array(bin) },
    ]);
  }

  // 解析并校验系数包；任何不符即抛错（明确拒绝）
  async function unpackCoefficients(buf) {
    let files;
    try {
      files = await unzip(buf);
    } catch (e) {
      throw new Error('系数文件损坏：' + e.message);
    }
    const hBytes = files.get('header.json');
    const cBytes = files.get('coefficients.bin');
    if (!hBytes || !cBytes) throw new Error('系数文件损坏：缺少 header.json 或 coefficients.bin');
    let h;
    try { h = JSON.parse(td.decode(hBytes)); }
    catch (e) { throw new Error('系数文件损坏：header.json 不是合法 JSON'); }
    // 约定：版本、采样率、N、L 先检查
    if (h.version !== 1) throw new Error('不支持的版本 version=' + JSON.stringify(h.version) + '（仅支持 1）');
    if (!VALID_RATES.includes(h.rate)) throw new Error('非法采样率 rate=' + JSON.stringify(h.rate));
    if (!VALID_N.includes(h.N)) throw new Error('非法半窗长 N=' + JSON.stringify(h.N));
    if (!Number.isInteger(h.frames) || h.frames < 1 || h.frames > h.rate * 15)
      throw new Error('非法帧数 frames=' + JSON.stringify(h.frames));
    if (h.channels !== 1 && h.channels !== 2) throw new Error('非法声道数 channels=' + JSON.stringify(h.channels));
    const expectBlocks = frameCount(h.frames, h.N);
    if (h.blocks !== expectBlocks)
      throw new Error('块数不符：header.blocks=' + JSON.stringify(h.blocks) + '，按 frames/N 应为 ' + expectBlocks);
    if (h.storage !== 'float32le' && h.storage !== 'int16le')
      throw new Error('非法存储格式 storage=' + JSON.stringify(h.storage));
    if (!Array.isArray(h.steps) || h.steps.length !== 4 || !h.steps.every(s => typeof s === 'number' && isFinite(s) && s > 0))
      throw new Error('非法量化步长 steps（须为四个正数）');
    const per = h.storage === 'float32le' ? 4 : 2;
    const expectLen = h.blocks * h.channels * h.N * per;
    if (cBytes.length !== expectLen)
      throw new Error('系数数据长度不符：实际 ' + cBytes.length + ' 字节，应为 ' + expectLen + ' 字节');
    const dv = new DataView(cBytes.buffer, cBytes.byteOffset, cBytes.byteLength);
    const coeff = [];
    for (let c = 0; c < h.channels; c++) coeff.push(new Float64Array(h.blocks * h.N));
    let p = 0;
    for (let b = 0; b < h.blocks; b++) {
      for (let c = 0; c < h.channels; c++) {
        for (let k = 0; k < h.N; k++) {
          const idx = b * h.N + k;
          if (h.storage === 'float32le') { coeff[c][idx] = dv.getFloat32(p, true); p += 4; }
          else {
            const q = dv.getInt16(p, true); p += 2;
            coeff[c][idx] = q * h.steps[bandOf(k, h.N)];
          }
        }
      }
    }
    return { header: h, coeff };
  }

  return {
    fft, getTables, mdctBlock, imdctBlock,
    frameCount, analyzeChannel, synthesizeChannel,
    bandOf, quantize, dequantize, metrics,
    parseWav, encodeWav24,
    crc32, zipStore, unzip,
    packCoefficients, unpackCoefficients,
    VALID_N, VALID_RATES,
  };
});
