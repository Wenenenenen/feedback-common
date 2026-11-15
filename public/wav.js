/* wav.js — WAV 解码 / 编码（44.1k / 48k、16/24 位 PCM、单/双声道）与 smpl 循环标记。
 * 双模式：浏览器（全局 WAV）与 Node（module.exports）。
 *
 * 解码后每个声道是一个 Float32Array（归一化到 [-1, 1]）；
 * 24 位整数除以 2^23、16 位除以 2^15，均在 float32 中可精确表示，
 * 因此 F=0 时解码→编码可以做到逐字节还原。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.WAV = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const RATE_MIN = 44100;
  const RATE_MAX = 48000;
  const MAX_SECONDS = 60;
  const SUPPORTED_RATES = [44100, 48000];

  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    throw err;
  }

  function fourCC(dv, off) {
    return String.fromCharCode(
      dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3)
    );
  }

  /* 解析 smpl 数据块。非法结构返回空数组，不中断解码。 */
  function parseSmpl(dv, off, size, frames) {
    const loops = [];
    if (size < 36) return loops;
    const numLoops = dv.getUint32(off + 28, true);
    const available = Math.floor((size - 36) / 24);
    const count = Math.min(numLoops, available, 64);
    for (let i = 0; i < count; i++) {
      const p = off + 36 + i * 24;
      loops.push({
        cueId: dv.getUint32(p, true),
        type: dv.getUint32(p + 4, true),
        start: dv.getUint32(p + 8, true),
        endInclusive: dv.getUint32(p + 12, true),
        fraction: dv.getUint32(p + 16, true),
        playCount: dv.getUint32(p + 20, true),
        inRange: dv.getUint32(p + 12, true) < frames,
      });
    }
    return loops;
  }

  /**
   * 解码 WAV。
   * @param {ArrayBuffer} buffer 原始文件字节
   * @returns {{
   *   sampleRate:number, bits:number, channelCount:number, frames:number,
   *   duration:number, channels:Float32Array[], loops:Array, loop:Object|null,
   *   dataOffset:number, dataBytes:number, formatTag:number
   * }}
   */
  function decodeWav(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) {
      fail('NOT_WAV', '不是有效的 WAV 文件');
    }
    const dv = new DataView(buffer);
    if (fourCC(dv, 0) !== 'RIFF' || fourCC(dv, 8) !== 'WAVE') {
      fail('NOT_WAV', '不是有效的 WAV 文件（缺少 RIFF/WAVE 标志）');
    }
    const riffSize = dv.getUint32(4, true);
    if (riffSize + 8 > buffer.byteLength) {
      fail('TRUNCATED', 'WAV 文件不完整：文件被截断（声明长度 ' + (riffSize + 8) +
        ' 字节，实际仅 ' + buffer.byteLength + ' 字节）');
    }

    let fmt = null;
    let dataOffset = -1;
    let dataBytes = 0;
    let loops = [];
    let pos = 12;
    while (pos + 8 <= buffer.byteLength) {
      const id = fourCC(dv, pos);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (body + size > buffer.byteLength) {
        fail('TRUNCATED', 'WAV 文件不完整：' + id + ' 数据块声明 ' + size +
          ' 字节，但文件剩余仅 ' + (buffer.byteLength - body) + ' 字节（文件被截断）');
      }
      if (id === 'fmt ') {
        if (size < 16) fail('BAD_FORMAT', 'WAV 的 fmt 块长度异常');
        let formatTag = dv.getUint16(body, true);
        const channels = dv.getUint16(body + 2, true);
        const sampleRate = dv.getUint32(body + 4, true);
        const blockAlign = dv.getUint16(body + 12, true);
        const bits = dv.getUint16(body + 14, true);
        if (formatTag === 0xFFFE) {
          if (size < 40) fail('BAD_FORMAT', 'WAVE_FORMAT_EXTENSIBLE 头不完整');
          formatTag = dv.getUint16(body + 24, true);
        }
        fmt = { formatTag, channels, sampleRate, blockAlign, bits };
      } else if (id === 'data') {
        if (dataOffset < 0) {
          dataOffset = body;
          dataBytes = size;
        }
      } else if (id === 'smpl') {
        loops = parseSmpl(dv, body, size, 0xFFFFFFFF);
      }
      pos = body + size + (size & 1);
    }

    if (!fmt) fail('BAD_FORMAT', 'WAV 缺少 fmt 块');
    if (dataOffset < 0) fail('BAD_FORMAT', 'WAV 缺少 data 块');
    if (fmt.formatTag !== 1) {
      fail('BAD_FORMAT', '仅支持 16/24 位 PCM（当前 format tag = ' + fmt.formatTag + '）');
    }
    if (SUPPORTED_RATES.indexOf(fmt.sampleRate) < 0) {
      fail('BAD_RATE', '仅支持 44.1kHz / 48kHz 采样率（当前 ' + fmt.sampleRate + ' Hz）');
    }
    if (fmt.channels !== 1 && fmt.channels !== 2) {
      fail('BAD_CHANNELS', '仅支持单声道或双声道（当前 ' + fmt.channels + ' 声道）');
    }
    if (fmt.bits !== 16 && fmt.bits !== 24) {
      fail('BAD_BITS', '仅支持 16/24 位 PCM（当前 ' + fmt.bits + ' 位）');
    }

    const bytesPerSample = fmt.bits / 8;
    const frameBytes = bytesPerSample * fmt.channels;
    if (fmt.blockAlign !== frameBytes) {
      fail('BAD_FORMAT', 'WAV 的 block align 异常（' + fmt.blockAlign + '，应为 ' + frameBytes + '）');
    }
    if (dataBytes % frameBytes !== 0) {
      fail('TRUNCATED', 'WAV 的 data 块长度不是完整采样帧的整数倍（文件可能被截断）');
    }
    const frames = dataBytes / frameBytes;
    if (frames <= 0) fail('EMPTY', 'WAV 不包含音频采样');
    const duration = frames / fmt.sampleRate;
    if (duration > MAX_SECONDS) {
      fail('TOO_LONG', '素材最长 60 秒（当前 ' + duration.toFixed(3) + ' 秒）');
    }

    const channels = [];
    for (let c = 0; c < fmt.channels; c++) channels.push(new Float32Array(frames));
    if (fmt.bits === 16) {
      const scale = 1 / 32768;
      for (let i = 0; i < frames; i++) {
        const base = dataOffset + i * frameBytes;
        for (let c = 0; c < fmt.channels; c++) {
          channels[c][i] = dv.getInt16(base + c * 2, true) * scale;
        }
      }
    } else {
      const scale = 1 / 8388608;
      for (let i = 0; i < frames; i++) {
        const base = dataOffset + i * frameBytes;
        for (let c = 0; c < fmt.channels; c++) {
          const p = base + c * 3;
          let v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
          if (v & 0x800000) v -= 0x1000000;
          channels[c][i] = v * scale;
        }
      }
    }

    // 重新以真实帧数校验 smpl 循环区间
    for (const loop of loops) loop.inRange = loop.endInclusive < frames && loop.start <= loop.endInclusive;
    // 优先识别前向循环（type 0）
    const forward = loops.find((l) => l.type === 0 && l.inRange) || null;

    return {
      sampleRate: fmt.sampleRate,
      bits: fmt.bits,
      channelCount: fmt.channels,
      frames,
      duration,
      channels,
      loops,
      loop: forward,
      dataOffset,
      dataBytes,
      formatTag: fmt.formatTag,
    };
  }

  function clampInt16(v) {
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return v;
  }

  function clampInt24(v) {
    if (v > 8388607) return 8388607;
    if (v < -8388608) return -8388608;
    return v;
  }

  /**
   * 编码 WAV，可选写入 smpl 前向无限循环标记。
   * @param {{
   *   sampleRate:number, bits:number, channelData:Float32Array[],
   *   loop?:{start:number,endInclusive:number,playCount?:number}|null
   * }} opts
   * @returns {ArrayBuffer}
   */
  function encodeWav(opts) {
    const { sampleRate, bits, channelData } = opts;
    const channelCount = channelData.length;
    const frames = channelData[0].length;
    const bps = bits / 8;
    const frameBytes = bps * channelCount;
    const dataBytes = frames * frameBytes;
    const dataPad = dataBytes & 1;
    const loop = opts.loop || null;
    const smplBytes = loop ? 60 : 0;
    const riffSize = 4 + (8 + 16) + (8 + dataBytes + dataPad) + (loop ? 8 + smplBytes : 0);
    const buf = new ArrayBuffer(8 + riffSize);
    const dv = new DataView(buf);
    let p = 0;
    const writeCC = (s) => {
      for (let i = 0; i < 4; i++) dv.setUint8(p + i, s.charCodeAt(i));
      p += 4;
    };
    const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
    const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };

    writeCC('RIFF');
    u32(riffSize);
    writeCC('WAVE');

    writeCC('fmt ');
    u32(16);
    u16(1);                       // PCM
    u16(channelCount);
    u32(sampleRate);
    u32(sampleRate * frameBytes);
    u16(frameBytes);
    u16(bits);

    writeCC('data');
    u32(dataBytes);
    const dataStart = p;
    if (bits === 16) {
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channelCount; c++) {
          const v = clampInt16(Math.round(channelData[c][i] * 32768));
          dv.setInt16(p, v, true);
          p += 2;
        }
      }
    } else {
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channelCount; c++) {
          const v = clampInt24(Math.round(channelData[c][i] * 8388608));
          const u = v < 0 ? v + 0x1000000 : v;
          dv.setUint8(p, u & 0xFF);
          dv.setUint8(p + 1, (u >> 8) & 0xFF);
          dv.setUint8(p + 2, (u >> 16) & 0xFF);
          p += 3;
        }
      }
    }
    if (p - dataStart !== dataBytes) throw new Error('编码长度不一致');
    if (dataPad) { dv.setUint8(p, 0); p += 1; }

    if (loop) {
      writeCC('smpl');
      u32(smplBytes);
      u32(0);                                       // manufacturer
      u32(0);                                       // product
      u32(Math.round(1e9 / sampleRate));            // sample period (ns)
      u32(60);                                      // MIDI unity note
      u32(0);                                       // MIDI pitch fraction
      u32(0);                                       // SMPTE format
      u32(0);                                       // SMPTE offset
      u32(1);                                       // num sample loops
      u32(0);                                       // sampler data
      u32(0);                                       // cue point id
      u32(0);                                       // type 0 = forward
      u32(loop.start);
      u32(loop.endInclusive);
      u32(0);                                       // fraction
      u32(loop.playCount == null ? 0 : loop.playCount); // 0 = infinite
    }

    if (p !== buf.byteLength) throw new Error('WAV 编码长度不一致');
    return buf;
  }

  function formatBitsLabel(bits) {
    return bits + ' 位';
  }

  return {
    MAX_SECONDS,
    SUPPORTED_RATES,
    decodeWav,
    encodeWav,
    formatBitsLabel,
  };
});
