// WAV 解析与导出：仅支持 PCM 整数 16/24 位、单/双声道、8k–192k。
// 解码统一输出 Float64（每声道一个 Float64Array，取值范围 [-1, 1)）。

export class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
  }
}

function readAscii(bytes, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

function u16(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}
function u32(bytes, off) {
  return (
    bytes[off] |
    (bytes[off + 1] << 8) |
    (bytes[off + 2] << 16) |
    (bytes[off + 3] << 24)
  ) >>> 0;
}

/**
 * 解析 WAV 文件字节。
 * @returns {{rate:number, bits:number, channels:number, frames:number,
 *            channelData:Float64Array[], bytes:Uint8Array}}
 */
export function decodeWav(bytes) {
  if (bytes.length < 44) {
    throw new WavError('文件过小，不是完整的 WAV 文件（少于 44 字节）');
  }
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new WavError('不是 RIFF/WAVE 格式文件');
  }

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = readAscii(bytes, off, 4);
    const chunkLen = u32(bytes, off + 4);
    const body = off + 8;
    if (body + chunkLen > bytes.length) {
      if (id === 'data') {
        // data 块声明长度超过文件实际内容：截断文件，给明确提示
        throw new WavError(
          `WAV 文件被截断：data 块声明 ${chunkLen} 字节，文件实际只剩 ${bytes.length - body} 字节`
        );
      }
      throw new WavError(`WAV 文件被截断：${id} 块超出文件末尾`);
    }
    if (id === 'fmt ') {
      if (chunkLen < 16) throw new WavError('fmt 块长度异常');
      fmt = {
        tag: u16(bytes, body),
        channels: u16(bytes, body + 2),
        rate: u32(bytes, body + 4),
        blockAlign: u16(bytes, body + 12),
        bits: u16(bytes, body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = chunkLen;
    }
    off = body + chunkLen + (chunkLen & 1); // 块按字对齐
  }

  if (!fmt) throw new WavError('缺少 fmt 块，无法识别音频参数');
  if (dataOffset < 0) throw new WavError('缺少 data 块，文件中没有音频数据');

  if (fmt.tag !== 1) {
    const names = {
      2: 'MS ADPCM 压缩格式',
      3: '32 位浮点（IEEE float）',
      6: 'A-law 压缩',
      7: 'μ-law 压缩',
      17: 'IMA ADPCM 压缩',
      65534: 'WAVE_FORMAT_EXTENSIBLE 扩展格式',
    };
    const tagName = names[fmt.tag] ? `${names[fmt.tag]}（format tag=${fmt.tag}）`
      : `非 PCM 格式（format tag=${fmt.tag}）`;
    throw new WavError(`不支持${tagName}；本工具只接受无压缩 PCM 整数（16/24 位）WAV`);
  }
  if (fmt.bits !== 16 && fmt.bits !== 24) {
    throw new WavError(
      `不支持 ${fmt.bits} 位位深；本工具只接受 16 位或 24 位整数 PCM WAV`
    );
  }
  if (fmt.channels !== 1 && fmt.channels !== 2) {
    throw new WavError(`不支持 ${fmt.channels} 声道；本工具只接受单声道或双声道`);
  }
  if (fmt.rate < 8000 || fmt.rate > 192000) {
    throw new WavError(`不支持采样率 ${fmt.rate} Hz；允许范围为 8000–192000 Hz`);
  }
  const expectAlign = fmt.channels * (fmt.bits / 8);
  if (fmt.blockAlign !== expectAlign) {
    throw new WavError(
      `块对齐字段异常（blockAlign=${fmt.blockAlign}，按参数应为 ${expectAlign}），文件可能已损坏`
    );
  }

  const bytesPerSample = fmt.bits / 8;
  const frameBytes = expectAlign;
  const usable = Math.min(dataLength, bytes.length - dataOffset);
  const frames = Math.floor(usable / frameBytes);
  if (frames === 0) throw new WavError('data 块中没有完整的音频帧');

  const channelData = [];
  for (let c = 0; c < fmt.channels; c++) {
    channelData.push(new Float64Array(frames));
  }

  if (fmt.bits === 16) {
    for (let n = 0; n < frames; n++) {
      const base = dataOffset + n * frameBytes;
      for (let c = 0; c < fmt.channels; c++) {
        const p = base + c * 2;
        let v = bytes[p] | (bytes[p + 1] << 8);
        if (v & 0x8000) v |= 0xffff0000;
        channelData[c][n] = v / 32768;
      }
    }
  } else {
    // 24 位小端有符号整数
    for (let n = 0; n < frames; n++) {
      const base = dataOffset + n * frameBytes;
      for (let c = 0; c < fmt.channels; c++) {
        const p = base + c * 3;
        let v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        if (v & 0x800000) v |= 0xff000000;
        channelData[c][n] = v / 8388608;
      }
    }
  }

  return {
    rate: fmt.rate,
    bits: fmt.bits,
    channels: fmt.channels,
    frames,
    channelData,
    bytes,
    truncated: usable < dataLength,
  };
}

/** 四舍五入到最近整数，0.5 朝远离 0 的方向（对应“四舍五入后限幅，不加抖动”）。 */
function roundHalfAway(x) {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

function clampInt(v, bits) {
  const max = (1 << (bits - 1)) - 1; // 16 位: 32767；24 位: 8388607
  const min = -(1 << (bits - 1));    // 16 位: -32768；24 位: -8388608
  if (v > max) return max;
  if (v < min) return min;
  return v;
}

/**
 * 导出 PCM WAV。位深与输入一致；四舍五入后限幅，不加抖动。
 * @param {Float64Array[]} channelData 每声道浮点样本
 */
export function encodeWav(channelData, rate, bits) {
  const channels = channelData.length;
  const frames = channelData[0].length;
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataLength = frames * blockAlign;
  const out = new Uint8Array(44 + dataLength);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, 0x52494646, false); // RIFF
  dv.setUint32(4, 36 + dataLength, true);
  dv.setUint32(8, 0x57415645, false); // WAVE
  dv.setUint32(12, 0x666d7420, false); // fmt
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  dv.setUint32(36, 0x64617461, false); // data
  dv.setUint32(40, dataLength, true);

  let p = 44;
  if (bits === 16) {
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < channels; c++) {
        const v = clampInt(roundHalfAway(channelData[c][n] * 32768), 16);
        dv.setInt16(p, v, true);
        p += 2;
      }
    }
  } else {
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < channels; c++) {
        const v = clampInt(roundHalfAway(channelData[c][n] * 8388608), 24);
        // 24 位小端
        out[p] = v & 0xff;
        out[p + 1] = (v >> 8) & 0xff;
        out[p + 2] = (v >> 16) & 0xff;
        p += 3;
      }
    }
  }
  return out;
}

export function downloadBlob(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
