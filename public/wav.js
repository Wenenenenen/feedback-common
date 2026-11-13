/* wav.js — WAV 解码（PCM 16/24 位、IEEE float32，单/双声道）与 16 位立体声编码。
 * 双模式：浏览器/Worker（全局 WAV）与 Node（module.exports）。 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.WAV = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_SECONDS = 180;       // 单轨最长 3 分钟
  const RATES = [44100, 48000];  // 支持的采样率

  /* 解码 WAV，返回 {sampleRate, channels, bits, duration, mono(Float32Array)}。
   * 立体声取双声道均值。不满足约束时抛出中文错误信息。 */
  function decodeWav(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 44 ||
        dv.getUint32(0, false) !== 0x52494646 || // 'RIFF'
        dv.getUint32(8, false) !== 0x57415645) { // 'WAVE'
      throw new Error('不是有效的 WAV 文件');
    }
    let fmt = null, dataOff = -1, dataLen = 0;
    let off = 12;
    while (off + 8 <= buf.byteLength) {
      const id = dv.getUint32(off, false);
      const size = dv.getUint32(off + 4, true);
      const body = off + 8;
      if (id === 0x666d7420) { // 'fmt '
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
        };
        if (fmt.format === 0xfffe && size >= 40) { // WAVE_FORMAT_EXTENSIBLE → 取子格式
          fmt.format = dv.getUint16(body + 24, true);
        }
      } else if (id === 0x64617461) { // 'data'
        dataOff = body; dataLen = Math.min(size, buf.byteLength - body);
      }
      off = body + size + (size & 1);
    }
    if (!fmt) throw new Error('WAV 缺少 fmt 块');
    if (dataOff < 0) throw new Error('WAV 缺少 data 块');
    if (RATES.indexOf(fmt.sampleRate) < 0) {
      throw new Error('仅支持 44.1kHz / 48kHz 采样率（当前 ' + fmt.sampleRate + ' Hz）');
    }
    if (fmt.channels !== 1 && fmt.channels !== 2) {
      throw new Error('仅支持单声道或双声道（当前 ' + fmt.channels + ' 声道）');
    }
    const isFloat = fmt.format === 3;
    const isPcm = fmt.format === 1;
    if (!((isPcm && (fmt.bits === 16 || fmt.bits === 24)) || (isFloat && fmt.bits === 32))) {
      throw new Error('仅支持 16/24 位 PCM（当前 format=' + fmt.format + ', ' + fmt.bits + ' 位）');
    }
    const bytesPerSample = fmt.bits / 8;
    const frameBytes = bytesPerSample * fmt.channels;
    const frames = Math.floor(dataLen / frameBytes);
    const duration = frames / fmt.sampleRate;
    if (duration > MAX_SECONDS + 0.5) {
      throw new Error('单轨最长 3 分钟（当前 ' + duration.toFixed(1) + ' 秒）');
    }
    const mono = new Float32Array(frames);
    const ch = fmt.channels;
    for (let i = 0; i < frames; i++) {
      const base = dataOff + i * frameBytes;
      let acc = 0;
      for (let c = 0; c < ch; c++) {
        const p = base + c * bytesPerSample;
        let v;
        if (isFloat) {
          v = dv.getFloat32(p, true);
        } else if (fmt.bits === 16) {
          v = dv.getInt16(p, true) / 32768;
        } else { // 24 位小端符号扩展
          const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
          let x = b0 | (b1 << 8) | (b2 << 16);
          if (x & 0x800000) x -= 0x1000000;
          v = x / 8388608;
        }
        acc += v;
      }
      mono[i] = acc / ch;
    }
    return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, duration, mono };
  }

  /* 编码 48kHz（或指定率）16 位立体声 WAV。 */
  function encodeWav16Stereo(left, right, sampleRate) {
    const n = left.length;
    const dataLen = n * 2 * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(buf);
    const w32 = (o, v) => dv.setUint32(o, v, false);
    const w32le = (o, v) => dv.setUint32(o, v, true);
    const w16le = (o, v) => dv.setUint16(o, v, true);
    w32(0, 0x52494646); w32le(4, 36 + dataLen); w32(8, 0x57415645);
    w32(12, 0x666d7420); w32le(16, 16);
    w16le(20, 1); w16le(22, 2); w32le(24, sampleRate);
    w32le(28, sampleRate * 4); w16le(32, 4); w16le(34, 16);
    w32(36, 0x64617461); w32le(40, dataLen);
    let o = 44;
    for (let i = 0; i < n; i++) {
      let l = Math.max(-1, Math.min(1, left[i]));
      let r = Math.max(-1, Math.min(1, right[i]));
      dv.setInt16(o, Math.round(l * 32767), true); o += 2;
      dv.setInt16(o, Math.round(r * 32767), true); o += 2;
    }
    return buf;
  }

  return { decodeWav, encodeWav16Stereo, MAX_SECONDS };
});
