/*
 * 旁链压缩校验 DSP 核心 —— 严格按 samples/sidechain-dynamics-cases.zip 内《约定.json》实现。
 * 浏览器（window.SidechainDSP）与 Node（module.exports）双端可用。
 */
(function (global) {
  'use strict';

  var PARAM_RANGES = {
    threshold_db: [-60, 0],
    ratio: [1, 20],
    knee_db: [0, 24],
    attack_ms: [0, 200],
    release_ms: [0, 2000],
    lookahead_ms: [0, 20],
    makeup_db: [-12, 12],
    mix: [0, 1]
  };

  /**
   * 解码 WAV（仅 PCM 16/24 位、单/双声道、44.1/48 kHz）。
   * 截断文件直接抛错，绝不静默补齐。
   * 返回 { name, sampleRate, channels, bits, frames, data: Float64Array[ch] }，
   * 采样按 2^(bits-1) 归一化。
   */
  function decodeWav(buf, name) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    function fail(msg) { throw new Error(name + '：' + msg); }
    if (dv.byteLength < 12) fail('文件太小，不是有效的 WAV');
    if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) {
      fail('不是 RIFF/WAVE 文件');
    }
    var fmt = null, dataOff = -1, dataSize = 0;
    var pos = 12;
    while (pos + 8 <= dv.byteLength) {
      var id = dv.getUint32(pos, false);
      var size = dv.getUint32(pos + 4, true);
      var body = pos + 8;
      if (id === 0x666d7420) { // 'fmt '
        if (body + 16 > dv.byteLength) fail('fmt 块被截断');
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true)
        };
        if (fmt.format === 0xfffe) { // WAVE_FORMAT_EXTENSIBLE
          if (body + 40 > dv.byteLength) fail('fmt 扩展块被截断');
          fmt.format = dv.getUint16(body + 24, true); // SubFormat 前 2 字节
        }
      } else if (id === 0x64617461) { // 'data'
        dataOff = body;
        dataSize = size;
        if (body + size > dv.byteLength) {
          fail('文件被截断（data 块声明 ' + size + ' 字节，实际仅剩 ' +
               (dv.byteLength - body) + ' 字节），已拒绝，不做静默补齐');
        }
      }
      pos = body + size + (size & 1);
    }
    if (!fmt) fail('缺少 fmt 块');
    if (dataOff < 0) fail('缺少 data 块');
    if (fmt.format !== 1) fail('仅支持 PCM 整型（format=' + fmt.format + '），不支持浮点/压缩格式');
    if (fmt.channels !== 1 && fmt.channels !== 2) fail('仅支持单声道或双声道（当前 ' + fmt.channels + ' 声道）');
    if (fmt.sampleRate !== 44100 && fmt.sampleRate !== 48000) {
      fail('仅支持 44.1/48 kHz（当前 ' + fmt.sampleRate + ' Hz）');
    }
    if (fmt.bits !== 16 && fmt.bits !== 24) fail('仅支持 16/24 位 PCM（当前 ' + fmt.bits + ' 位）');

    var bps = fmt.bits / 8;
    var frames = Math.floor(dataSize / (bps * fmt.channels));
    if (frames === 0) fail('data 块为空');
    var norm = Math.pow(2, fmt.bits - 1);
    var data = [];
    for (var c = 0; c < fmt.channels; c++) data.push(new Float64Array(frames));
    var o = dataOff;
    for (var i = 0; i < frames; i++) {
      for (var ch = 0; ch < fmt.channels; ch++) {
        var v;
        if (fmt.bits === 16) {
          v = dv.getInt16(o, true);
        } else {
          v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);
          if (v & 0x800000) v -= 0x1000000;
        }
        data[ch][i] = v / norm;
        o += bps;
      }
    }
    return {
      name: name,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bits: fmt.bits,
      frames: frames,
      data: data
    };
  }

  /**
   * 按约定公式处理。
   * mainData / keyData: Float64Array 数组（每声道一条）；无外部旁链时 keyData 传 null。
   * 检测算到 N+L-1；输出恰为主轨 N 帧，不整体移位。
   * 返回 { g: Float64Array(N+L), y: Float64Array[ch](N), L }。
   */
  function process(mainData, keyData, sr, N, p) {
    var L = Math.floor(p.lookahead_ms * sr / 1000 + 0.5);
    var total = N + L;
    var det = keyData || mainData;
    var kd = det[0].length;
    var kc = det.length;
    var aA = p.attack_ms === 0 ? 0 : Math.exp(-1 / (sr * p.attack_ms / 1000));
    var aR = p.release_ms === 0 ? 0 : Math.exp(-1 / (sr * p.release_ms / 1000));
    var T = p.threshold_db, R = p.ratio, W = p.knee_db;
    var slope = 1 / R - 1;
    var g = new Float64Array(total);
    var prev = 0;
    for (var n = 0; n < total; n++) {
      var d = 0;
      if (n < kd) {
        for (var c = 0; c < kc; c++) {
          var v = Math.abs(det[c][n]);
          if (v > d) d = v;
        }
      }
      var x = 20 * Math.log10(Math.max(d, 1e-12));
      var t = x - T;
      var q;
      if (W === 0) {
        q = Math.min(0, slope * t);
      } else if (t <= -W / 2) {
        q = 0;
      } else if (t >= W / 2) {
        q = slope * t;
      } else {
        var u = t + W / 2;
        q = slope * u * u / (2 * W);
      }
      var a = q < prev ? aA : aR;
      prev = a * prev + (1 - a) * q;
      g[n] = prev;
    }
    var ch = mainData.length;
    var y = [];
    for (c = 0; c < ch; c++) y.push(new Float64Array(N));
    var mix = p.mix, mk = p.makeup_db;
    for (n = 0; n < N; n++) {
      var f = (1 - mix) + mix * Math.pow(10, (g[n + L] + mk) / 20);
      for (c = 0; c < ch; c++) y[c][n] = mainData[c][n] * f;
    }
    return { g: g, y: y, L: L };
  }

  /** 量化前（混合后）逐声道削波采样数：|y| > 1。 */
  function clipCounts(y) {
    var counts = [];
    for (var c = 0; c < y.length; c++) {
      var n = 0;
      var ch = y[c];
      for (var i = 0; i < ch.length; i++) {
        if (Math.abs(ch[i]) > 1) n++;
      }
      counts.push(n);
    }
    return counts;
  }

  /** 四舍五入、半值远离 0。 */
  function roundHalfAway(x) {
    return x < 0 ? -Math.round(-x) : Math.round(x);
  }

  /**
   * 编码 24 位 PCM WAV：量化乘 2^23，半值远离 0 取整，再饱和到有符号 24 位。
   * 不归一化、不加限幅器。采样率/声道数与主轨一致。
   */
  function encodeWav24(y, sr) {
    var ch = y.length;
    var N = y[0].length;
    var dataSize = N * ch * 3;
    var buf = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i); }
    str(0, 'RIFF');
    dv.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);            // PCM
    dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * 3, true);  // byte rate
    dv.setUint16(32, ch * 3, true);       // block align
    dv.setUint16(34, 24, true);
    str(36, 'data');
    dv.setUint32(40, dataSize, true);
    var o = 44;
    for (var i = 0; i < N; i++) {
      for (var c = 0; c < ch; c++) {
        var s = roundHalfAway(y[c][i] * 8388608);
        if (s > 8388607) s = 8388607;
        else if (s < -8388608) s = -8388608;
        if (s < 0) s += 0x1000000;
        u8[o] = s & 0xff;
        u8[o + 1] = (s >> 8) & 0xff;
        u8[o + 2] = (s >> 16) & 0xff;
        o += 3;
      }
    }
    return buf;
  }

  /**
   * 增益 CSV：每 floor(sr/100) 帧取一点并包含 N-1。
   * 列 frame,time_seconds,gain_db；gain_db = g[n+L]，不含 makeup。
   */
  function gainCsv(g, L, sr, N) {
    var step = Math.floor(sr / 100);
    var lines = ['frame,time_seconds,gain_db'];
    for (var f = 0; f < N; f += step) {
      lines.push(f + ',' + (f / sr) + ',' + g[f + L]);
    }
    if ((N - 1) % step !== 0) {
      lines.push((N - 1) + ',' + ((N - 1) / sr) + ',' + g[N - 1 + L]);
    }
    return lines.join('\n') + '\n';
  }

  var api = {
    PARAM_RANGES: PARAM_RANGES,
    decodeWav: decodeWav,
    process: process,
    clipCounts: clipCounts,
    encodeWav24: encodeWav24,
    gainCsv: gainCsv
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SidechainDSP = api;
})(typeof window !== 'undefined' ? window : globalThis);
