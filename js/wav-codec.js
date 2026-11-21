/*
 * WAV 编解码：仅支持 PCM（16-bit）单声道/双声道 WAV 的解析与写出。
 * 浏览器与 Node 通用（挂到 globalThis.WM 命名空间）。
 */
(function (global) {
  'use strict';

  var WM = global.WM || (global.WM = {});

  function readAscii(view, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  }

  /**
   * 解析 ArrayBuffer 形式的 WAV。
   * 返回 { sampleRate, channels, bitsPerSample, samples: Float32Array[channels], length }
   * 采样值归一化到 [-1, 1]。
   */
  function decodeWav(buffer) {
    var view = new DataView(buffer);
    if (buffer.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
      throw new Error('不是合法的 WAV（RIFF/WAVE）文件');
    }
    var off = 12;
    var fmt = null;
    var dataChunk = null;
    while (off + 8 <= buffer.byteLength) {
      var id = readAscii(view, off, 4);
      var size = view.getUint32(off + 4, true);
      var body = off + 8;
      if (id === 'fmt ') {
        fmt = {
          formatTag: view.getUint16(body, true),
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          bitsPerSample: view.getUint16(body + 14, true),
          extBody: new DataView(buffer, body, Math.min(size, buffer.byteLength - body))
        };
      } else if (id === 'data') {
        dataChunk = { off: body, size: Math.min(size, buffer.byteLength - body) };
      }
      off = body + size + (size & 1); // 块按字对齐
    }
    if (!fmt || !dataChunk) throw new Error('WAV 缺少 fmt 或 data 块');

    // WAVE_FORMAT_EXTENSIBLE (0xFFFE)：检查子格式是否为 PCM
    if (fmt.formatTag === 0xfffe) {
      var subFmt = fmt.extBody.getUint16(24, true);
      if (subFmt !== 1) throw new Error('仅支持 PCM，当前为扩展非 PCM 格式');
    } else if (fmt.formatTag !== 1) {
      throw new Error('仅支持 PCM 格式（format tag=1），当前为 ' + fmt.formatTag);
    }
    if (fmt.bitsPerSample !== 16) throw new Error('仅支持 16-bit PCM，当前为 ' + fmt.bitsPerSample + '-bit');
    if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error('仅支持单声道或双声道，当前声道数 ' + fmt.channels);

    var ch = fmt.channels;
    var n = Math.floor(dataChunk.size / (2 * ch));
    var samples = [];
    for (var c = 0; c < ch; c++) samples.push(new Float32Array(n));
    var p = dataChunk.off;
    for (var i = 0; i < n; i++) {
      for (var c2 = 0; c2 < ch; c2++) {
        var v = view.getInt16(p, true);
        p += 2;
        samples[c2][i] = v < 0 ? v / 32768 : v / 32767;
      }
    }
    return {
      sampleRate: fmt.sampleRate,
      channels: ch,
      bitsPerSample: 16,
      length: n,
      samples: samples
    };
  }

  function clamp16(x) {
    var v = Math.round(x * 32768);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    return v;
  }

  /**
   * 按给定声道数/采样率写出 16-bit PCM WAV（ArrayBuffer）。
   * samples 为 Float32Array 数组，长度必须一致。
   */
  function encodeWav(samples, sampleRate) {
    var ch = samples.length;
    var n = samples[0].length;
    var dataBytes = n * ch * 2;
    var buf = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buf);
    var p = 0;
    function putStr(s) { for (var i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); }
    function putU32(v) { view.setUint32(p, v >>> 0, true); p += 4; }
    function putU16(v) { view.setUint16(p, v & 0xffff, true); p += 2; }

    putStr('RIFF'); putU32(36 + dataBytes); putStr('WAVE');
    putStr('fmt '); putU32(16); putU16(1); putU16(ch);
    putU32(sampleRate); putU32(sampleRate * ch * 2); putU16(ch * 2); putU16(16);
    putStr('data'); putU32(dataBytes);
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < ch; c++) view.setInt16(p + (i * ch + c) * 2, clamp16(samples[c][i]), true);
    }
    return buf;
  }

  WM.decodeWav = decodeWav;
  WM.encodeWav = encodeWav;
})(typeof globalThis !== 'undefined' ? globalThis : this);
