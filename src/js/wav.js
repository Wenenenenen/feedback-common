/*
 * WAV 读写（RIFF/WAVE）。
 *
 * 读：整数 PCM 16/24/32 位与 IEEE float 32/64 位，多声道解交织为逐声道 Float64Array。
 * 写：48 kHz 单声道 IEEE float32（导出用）。
 * 输入一律按不可信数据校验：块边界、帧对齐、声道数上限、重复块、截断数据。
 * 浏览器（全局 SHMWav）与 Node（module.exports）共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SHMWav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FMT_PCM = 1;
  const FMT_FLOAT = 3;
  const FMT_EXTENSIBLE = 0xfffe;
  const MAX_CHANNELS = 16;

  function ascii(b, o, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }

  /*
   * 解析 WAV。返回 {format, channels, sampleRate, bitsPerSample, frames, data: Float64Array[]}。
   * 抛出带中文原因的错误。
   */
  function decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 12) throw new Error('文件过短，不是 WAV');
    if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') {
      throw new Error('不是 RIFF/WAVE 文件');
    }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const riffSize = dv.getUint32(4, true);
    if (riffSize + 8 > b.length + 1 && riffSize + 8 !== b.length) {
      // RIFF 声明比实际长：只影响尾部，允许但由 data 块校验兜底
    }
    let fmt = null;
    let dataOff = -1;
    let dataLen = 0;
    let pos = 12;
    const seen = new Set();
    while (pos + 8 <= b.length) {
      const id = ascii(b, pos, 4);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (body + size > b.length) {
        if (id === 'data') throw new Error('data 块被截断（声明 ' + size + ' 字节，实际不足）');
        break;
      }
      if (id === 'fmt ') {
        if (seen.has('fmt ')) throw new Error('fmt 块重复');
        seen.add('fmt ');
        if (size < 16) throw new Error('fmt 块过短');
        let format = dv.getUint16(body, true);
        const channels = dv.getUint16(body + 2, true);
        const sampleRate = dv.getUint32(body + 4, true);
        const byteRate = dv.getUint32(body + 8, true);
        const blockAlign = dv.getUint16(body + 12, true);
        const bits = dv.getUint16(body + 14, true);
        if (format === FMT_EXTENSIBLE) {
          if (size < 40) throw new Error('WAVE_FORMAT_EXTENSIBLE 的 fmt 块过短');
          // SubFormat GUID 的前两字节即实际格式
          format = dv.getUint16(body + 24, true);
        }
        fmt = { format, channels, sampleRate, byteRate, blockAlign, bits };
      } else if (id === 'data') {
        if (seen.has('data')) throw new Error('data 块重复');
        seen.add('data');
        dataOff = body;
        dataLen = size;
      }
      pos = body + size + (size & 1);
    }
    if (!fmt) throw new Error('缺少 fmt 块');
    if (dataOff < 0) throw new Error('缺少 data 块');
    if (seen.has('data') && dataLen === 0) throw new Error('data 块为空');
    if (!(fmt.channels >= 1 && fmt.channels <= MAX_CHANNELS)) {
      throw new Error('声道数 ' + fmt.channels + ' 不在 1–' + MAX_CHANNELS + ' 范围');
    }
    if (!(fmt.sampleRate > 0)) throw new Error('采样率无效');
    const bytesPer = fmt.bits >> 3;
    if (![16, 24, 32, 64].includes(fmt.bits)) {
      throw new Error('位深 ' + fmt.bits + ' 不受支持（仅 16/24/32 位整数或 32/64 位浮点）');
    }
    const integers = fmt.format === FMT_PCM;
    const floats = fmt.format === FMT_FLOAT;
    if (!integers && !floats) throw new Error('编码格式 0x' + fmt.format.toString(16) + ' 不受支持');
    if (floats && fmt.bits === 16) throw new Error('16 位浮点 WAV 不受支持');
    if (integers && fmt.bits === 64) throw new Error('64 位整数 WAV 不受支持');
    const frameBytes = bytesPer * fmt.channels;
    if (fmt.blockAlign !== frameBytes) {
      throw new Error('blockAlign(' + fmt.blockAlign + ') 与声道×位深不符');
    }
    if (fmt.byteRate !== fmt.sampleRate * frameBytes) {
      throw new Error('byteRate 与采样率×帧字节数不符');
    }
    if (dataLen % frameBytes !== 0) {
      throw new Error('data 长度不是整帧（' + dataLen + ' 字节 / 每帧 ' + frameBytes + '）');
    }
    const frames = dataLen / frameBytes;
    if (frames < 1) throw new Error('采集数据为空');
    const chans = [];
    for (let c = 0; c < fmt.channels; c++) chans.push(new Float64Array(frames));
    let p = dataOff;
    if (integers && fmt.bits === 16) {
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++, p += 2) {
          chans[c][i] = dv.getInt16(p, true) / 32768;
        }
      }
    } else if (integers && fmt.bits === 24) {
      const scale = 1 / 8388608;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++, p += 3) {
          let v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
          if (v & 0x800000) v -= 0x1000000;
          chans[c][i] = v * scale;
        }
      }
    } else if (integers && fmt.bits === 32) {
      const scale = 1 / 2147483648;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++, p += 4) {
          chans[c][i] = dv.getInt32(p, true) * scale;
        }
      }
    } else if (floats && fmt.bits === 32) {
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++, p += 4) {
          const v = dv.getFloat32(p, true);
          if (!Number.isFinite(v)) throw new Error('浮点样本含 NaN/Inf（帧 ' + i + '）');
          chans[c][i] = v;
        }
      }
    } else if (floats && fmt.bits === 64) {
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++, p += 8) {
          const v = dv.getFloat64(p, true);
          if (!Number.isFinite(v)) throw new Error('浮点样本含 NaN/Inf（帧 ' + i + '）');
          chans[c][i] = v;
        }
      }
    }
    return {
      format: floats ? 'float' : 'int',
      encoding: fmt.format,
      channels: fmt.channels,
      sampleRate: fmt.sampleRate,
      bitsPerSample: fmt.bits,
      frames,
      data: chans,
    };
  }

  /*
   * 单声道 IEEE float32 WAV。samples 可为 Float32Array/Float64Array/普通数组。
   */
  function encodeFloat32Mono(samples, sampleRate) {
    const n = samples.length;
    const dataBytes = n * 4;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const tag = (o, s) => { for (let i = 0; i < 4; i++) u8[o + i] = s.charCodeAt(i); };
    tag(0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, FMT_FLOAT, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 32, true);
    tag(36, 'data');
    dv.setUint32(40, dataBytes, true);
    let off = 44;
    for (let i = 0; i < n; i++, off += 4) dv.setFloat32(off, samples[i], true);
    return new Uint8Array(buf);
  }

  return { decode, encodeFloat32Mono, FMT_PCM, FMT_FLOAT, MAX_CHANNELS };
});
