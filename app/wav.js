/* WAV 解析、节拍脉冲 WAV 生成与网格 JSON 导出，全部纯手写无依赖。 */
(function (root) {
  'use strict';

  var SR = 48000;
  var FRAME_SAMPLES = 240; // 5ms

  function WavError(msg) { this.name = 'WavError'; this.message = msg; }
  WavError.prototype = Object.create(Error.prototype);

  /**
   * 解析 48kHz/16bit/单声道 PCM WAV。
   * 返回 { samples:Int16Array, sampleCount, frameCount }
   * 严格校验格式，拒绝压缩格式与多声道。
   */
  function parseWav(buf) {
    if (!(buf instanceof ArrayBuffer) && !(buf instanceof Uint8Array)) {
      throw new WavError('WAV 数据类型错误');
    }
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    if (bytes.length < 44) throw new WavError('文件过小，不是合法 WAV');
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
      throw new WavError('缺少 RIFF 头');
    }
    if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) {
      throw new WavError('缺少 WAVE 标识');
    }
    var fmt = null, dataBytes = null;
    var p = 12;
    while (p + 8 <= bytes.length) {
      var id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      var sz = dv.getUint32(p + 4, true);
      if (p + 8 + sz > bytes.length) throw new WavError('chunk 长度越界');
      if (id === 'fmt ') {
        if (sz < 16) throw new WavError('fmt chunk 过短');
        fmt = {
          tag: dv.getUint16(p + 8, true),
          channels: dv.getUint16(p + 10, true),
          rate: dv.getUint32(p + 12, true),
          bits: dv.getUint16(p + 22, true)
        };
      } else if (id === 'data') {
        dataBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + p + 8, sz);
      }
      p += 8 + sz + (sz & 1);
    }
    if (!fmt) throw new WavError('缺少 fmt chunk');
    if (!dataBytes) throw new WavError('缺少 data chunk');
    if (fmt.tag !== 1) throw new WavError('仅支持 PCM 格式（format tag=1），当前为 ' + fmt.tag);
    if (fmt.channels !== 1) throw new WavError('仅支持单声道，当前声道数 ' + fmt.channels);
    if (fmt.rate !== SR) throw new WavError('仅支持 48000Hz，当前 ' + fmt.rate);
    if (fmt.bits !== 16) throw new WavError('仅支持 16 位，当前 ' + fmt.bits);
    if (dataBytes.length % 2 !== 0) throw new WavError('data 长度不是偶数');
    var samples = new Int16Array(dataBytes.byteLength / 2);
    // 小端 16 位拷贝；对齐时可直接走 Int16Array 视图
    var src16 = new Int16Array(dataBytes.buffer, dataBytes.byteOffset, samples.length);
    samples.set(src16);
    return {
      samples: samples,
      sampleCount: samples.length,
      frameCount: Math.floor(samples.length / FRAME_SAMPLES)
    };
  }

  /** 由 Int16Array 打包为 16bit 单声道 PCM WAV（Uint8Array）。 */
  function buildWav(samples) {
    var dataSize = samples.length * 2;
    var out = new ArrayBuffer(44 + dataSize);
    var u8 = new Uint8Array(out);
    var dv = new DataView(out);
    var tag = [0x52, 0x49, 0x46, 0x46];
    for (var i = 0; i < 4; i++) u8[i] = tag[i];
    dv.setUint32(4, 36 + dataSize, true);
    u8[8] = 0x57; u8[9] = 0x41; u8[10] = 0x56; u8[11] = 0x45;
    u8[12] = 0x66; u8[13] = 0x6d; u8[14] = 0x74; u8[15] = 0x20;
    dv.setUint32(16, 16, true);      // fmt chunk size
    dv.setUint16(20, 1, true);       // PCM
    dv.setUint16(22, 1, true);       // mono
    dv.setUint32(24, SR, true);
    dv.setUint32(28, SR * 2, true);  // byte rate
    dv.setUint16(32, 2, true);       // block align
    dv.setUint16(34, 16, true);      // bits
    u8[36] = 0x64; u8[37] = 0x61; u8[38] = 0x74; u8[39] = 0x61;
    dv.setUint32(40, dataSize, true);
    new Int16Array(out, 44, samples.length).set(samples);
    return u8;
  }

  /**
   * 逐样本对齐的节拍 WAV：正拍样本=12000，反拍=6000，其余 0。
   * 与原声等长（48kHz 单声道 16bit）。
   */
  function buildClickTrack(sampleCount, beats, frameCount) {
    var out = new Int16Array(sampleCount);
    for (var b = 0; b < beats.length; b++) {
      var rec = beats[b];
      var onIdx = rec.frame * FRAME_SAMPLES;
      if (onIdx < sampleCount) out[onIdx] = 12000;
      var offFrame = rec.frame + (rec.swing === 0 ? rec.period / 2 : 2 * rec.period / 3);
      var offIdx = offFrame * FRAME_SAMPLES;
      if (offIdx < sampleCount) out[offIdx] = 6000;
    }
    return out;
  }

  /** 规范导出 JSON：{score, beats:[...]}，未匹配字段为 null。 */
  function buildGridJson(score, beats) {
    return JSON.stringify({
      score: score,
      beats: beats.map(function (r) {
        return {
          frame: r.frame,
          period: r.period,
          swing: r.swing,
          onMatch: r.onMatch,
          offMatch: r.offMatch,
          onScore: r.onScore,
          offScore: r.offScore,
          penalty: r.penalty
        };
      })
    }, null, 2);
  }

  var api = {
    SR: SR,
    FRAME_SAMPLES: FRAME_SAMPLES,
    parseWav: parseWav,
    buildWav: buildWav,
    buildClickTrack: buildClickTrack,
    buildGridJson: buildGridJson,
    WavError: WavError
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OnsetWav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
