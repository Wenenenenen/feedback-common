/*
 * wav-codec.js — PCM16 WAV 解码 / 编码（无依赖 UMD）
 * 只做样本级精确读写，不引入任何音频库。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CCL = root.CCL || {};
    Object.assign(root.CCL, { WAV: api });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 解码 WAV ArrayBuffer。
   * 返回 { sampleRate, channels, bitsPerSample, frames, dataView? , channelData:Int16Array[] }
   * 仅支持 PCM / PCM_EXTENSIBLE 的 16-bit；声道数不限制（应用层再要求双声道）。
   */
  function decodeWav(buffer) {
    // 统一复制成 offset=0 的 Uint8Array，避免 DataView 相对偏移问题。
    let bytes;
    if (buffer instanceof Uint8Array) bytes = buffer.slice();
    else bytes = new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 44) throw new Error('WAV 文件过短');

    function fourcc(off) {
      return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    }
    if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WAVE') {
      throw new Error('不是 RIFF/WAVE 文件');
    }

    let audioFormat = 0, numChannels = 0, sampleRate = 0, bitsPerSample = 0;
    let dataBytes = null;
    let dataOffset = -1;

    let off = 12;
    while (off + 8 <= bytes.length) {
      const id = fourcc(off);
      const size = dv.getUint32(off + 4, true);
      let body = off + 8;
      const end = body + size;
      if (end > bytes.length) {
        // 有些文件 size 字段不规范；data chunk 到文件尾仍可救。
        if (id === 'data') {
          dataOffset = body;
          dataBytes = bytes.subarray(body, bytes.length);
          break;
        }
        break;
      }
      if (id === 'fmt ') {
        audioFormat = dv.getUint16(body + 0, true);
        numChannels = dv.getUint16(body + 2, true);
        sampleRate = dv.getUint32(body + 4, true);
        bitsPerSample = dv.getUint16(body + 14, true);
        if (audioFormat === 0xFFFE && size >= 40) {
          // WAVEFORMATEXTENSIBLE：SubFormat 前两字节是真正的 format tag。
          audioFormat = dv.getUint16(body + 24, true);
        }
      } else if (id === 'data') {
        // 若有多个 data chunk（罕见），记录第一个；下面统一处理。
        if (dataOffset < 0) {
          dataOffset = body;
          dataBytes = bytes.subarray(body, end);
        }
      }
      off = end + (size & 1); // chunk 按字对齐
    }

    if (!numChannels) throw new Error('缺少 fmt chunk');
    if (dataOffset < 0 || !dataBytes) throw new Error('缺少 data chunk');
    if (audioFormat !== 1) throw new Error('仅支持 PCM 编码（format=1），当前 ' + audioFormat);
    if (bitsPerSample !== 16) throw new Error('仅支持 16-bit PCM，当前 ' + bitsPerSample + '-bit');

    const frameBytes = numChannels * 2;
    const frames = Math.floor(dataBytes.length / frameBytes);
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(new Int16Array(frames));

    // 直接按小端读取，避免对 bytes.buffer 对齐/偏移的假设。
    let p = dataBytes.byteOffset;
    const base = bytes.buffer;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        channelData[ch][i] = dv.getInt16(p, true);
        p += 2;
      }
    }
    return {
      sampleRate,
      channels: numChannels,
      bitsPerSample: 16,
      frames,
      length: frames,
      channelData,
    };
  }

  /**
   * 把平面 Int16 声道编码成标准 44 字节头 PCM16 WAV。
   * start/end 为左闭右开帧区间；缺省整段。返回 Uint8Array。
   */
  function encodeWav16(channelData, sampleRate, start, end) {
    const chs = channelData.length;
    const total = channelData[0].length;
    const s = start == null ? 0 : Math.max(0, start | 0);
    const e = end == null ? total : Math.min(total, end | 0);
    if (!(e >= s)) throw new Error('导出区间为空');
    const frames = e - s;
    const dataSize = frames * chs * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);

    writeAscii(u8, 0, 'RIFF');
    dv.setUint32(4, 36 + dataSize, true);
    writeAscii(u8, 8, 'WAVE');
    writeAscii(u8, 12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);                 // PCM
    dv.setUint16(22, chs, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * chs * 2, true);
    dv.setUint16(32, chs * 2, true);
    dv.setUint16(34, 16, true);
    writeAscii(u8, 36, 'data');
    dv.setUint32(40, dataSize, true);

    let p = 44;
    for (let i = s; i < e; i++) {
      for (let ch = 0; ch < chs; ch++) {
        dv.setInt16(p, channelData[ch][i], true);
        p += 2;
      }
    }
    return u8;
  }

  function writeAscii(u8, off, str) {
    for (let i = 0; i < str.length; i++) u8[off + i] = str.charCodeAt(i);
  }

  /** 触发浏览器下载（Node 下不可用，忽略）。 */
  function downloadBytes(bytes, filename, mime) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
    const blob = new Blob([bytes], { type: mime || 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 2000);
    return true;
  }

  return { decodeWav, encodeWav16, downloadBytes };
});
