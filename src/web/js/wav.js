/*
 * WAV 读写：仅支持 PCM 16/24 bit。
 * 解析结果中的样点以 Float64 保存，避免在卷积前引入额外量化误差。
 */

export class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
  }
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * 解析 WAV 文件。
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number,
 *            frames:number, duration:number, data:Float64Array[],
 *            peakPerChannel:number[], peak:number}}
 */
export function parseWav(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new WavError('不是有效的二进制文件');
  }
  if (arrayBuffer.byteLength < 12) {
    throw new WavError('文件太小，不是有效的 WAV');
  }

  const view = new DataView(arrayBuffer);
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') {
    throw new WavError('不是 RIFF/WAVE 文件');
  }

  let fmt = null;
  let dataOffset = -1;
  let dataSize = -1;
  let offset = 12;

  while (offset + 8 <= view.byteLength) {
    const id = readFourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength) {
      throw new WavError(`“${id}”块被截断（声明 ${size} 字节，文件不足）`);
    }
    if (id === 'fmt ') {
      if (fmt) throw new WavError('包含多个 fmt 块');
      fmt = { offset: body, size };
    } else if (id === 'LIST' || id === 'INFO') {
      // LIST/INFO 块的第一个四字节是子类型；WAV 解析不需要，安全跳过
    } else if (id === 'data') {
      if (dataOffset >= 0) throw new WavError('包含多个 data 块，无法确定音频数据');
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size & 1);
  }

  if (!fmt) throw new WavError('缺少 fmt 块');
  if (fmt.size < 16) throw new WavError('fmt 块长度不足 16 字节');
  if (dataOffset < 0) throw new WavError('缺少 data 块');

  let audioFormat = view.getUint16(fmt.offset, true);
  const channels = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const blockAlign = view.getUint16(fmt.offset + 12, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);

  if (audioFormat === WAVE_FORMAT_EXTENSIBLE) {
    if (fmt.size < 40) throw new WavError('WAVE_FORMAT_EXTENSIBLE 的 fmt 块长度不足');
    const cbSize = view.getUint16(fmt.offset + 16, true);
    if (cbSize < 22) throw new WavError('WAVE_FORMAT_EXTENSIBLE 的扩展信息不完整');
    audioFormat = view.getUint16(fmt.offset + 24, true);
  }

  if (audioFormat !== WAVE_FORMAT_PCM) {
    throw new WavError(
      `不是整数 PCM（格式 ${audioFormat}），仅支持 16/24 bit PCM`,
    );
  }
  if (bitsPerSample !== 16 && bitsPerSample !== 24) {
    throw new WavError(`不支持 ${bitsPerSample} bit 位深，仅支持 16/24 bit PCM`);
  }
  if (channels < 1) throw new WavError('声道数为 0');
  if (sampleRate < 1) throw new WavError('采样率无效');
  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign !== channels * bytesPerSample) {
    throw new WavError(
      `块对齐 ${blockAlign} 字节与 ${channels} 声道 × ${bitsPerSample} bit 不符`,
    );
  }
  if (dataSize % blockAlign !== 0) {
    throw new WavError(
      `data 字节数 ${dataSize} 不是整帧（每帧 ${blockAlign} 字节）`,
    );
  }

  const frames = dataSize / blockAlign;
  const data = Array.from({ length: channels }, () => new Float64Array(frames));
  const peakPerChannel = new Array(channels).fill(0);

  if (bitsPerSample === 16) {
    const scale = 1 / 32768;
    for (let i = 0, p = dataOffset; i < frames; i++, p += blockAlign) {
      for (let ch = 0; ch < channels; ch++) {
        const v = view.getInt16(p + ch * 2, true) * scale;
        data[ch][i] = v;
        const a = v < 0 ? -v : v;
        if (a > peakPerChannel[ch]) peakPerChannel[ch] = a;
      }
    }
  } else {
    const scale = 1 / 8388608;
    for (let i = 0, p = dataOffset; i < frames; i++, p += blockAlign) {
      for (let ch = 0; ch < channels; ch++) {
        const q = p + ch * 3;
        let v = view.getUint8(q) | (view.getUint8(q + 1) << 8) | (view.getUint8(q + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        const f = v * scale;
        data[ch][i] = f;
        const a = f < 0 ? -f : f;
        if (a > peakPerChannel[ch]) peakPerChannel[ch] = a;
      }
    }
  }

  const peak = peakPerChannel.reduce((m, v) => (v > m ? v : m), 0);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    frames,
    duration: frames / sampleRate,
    data,
    peakPerChannel,
    peak,
  };
}

const clamp24 = (q) => (q > 0x7fffff ? 0x7fffff : q < -0x800000 ? -0x800000 : q);

/**
 * 统计量化前峰值与超限样本（|x| > 1），并编码 24-bit PCM WAV。
 * 限幅只发生在编码阶段，输入数组不会被修改。
 * @param {Float64Array[]} channels 长度一致的双声道数组
 * @param {number} sampleRate
 */
export function encodeWav24(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length !== 2) {
    throw new WavError('导出需要双声道数据');
  }
  const frames = channels[0].length;
  if (channels[1].length !== frames) throw new WavError('双声道长度不一致');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new WavError('采样率无效');

  const dataBytes = frames * 2 * 3;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * 3, true);
  view.setUint16(32, 2 * 3, true);
  view.setUint16(34, 24, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let peak = 0;
  const peakPerChannel = [0, 0];
  const overPerChannel = [0, 0];
  let clampCount = 0;

  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 2; ch++) {
      let x = channels[ch][i];
      if (!Number.isFinite(x)) x = 0;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
      if (a > peakPerChannel[ch]) peakPerChannel[ch] = a;
      if (a > 1) overPerChannel[ch]++;

      let q = Math.round(x * 8388608);
      if (q > 0x7fffff || q < -0x800000) {
        q = clamp24(q);
        clampCount++;
      }
      if (q < 0) q += 0x1000000;
      view.setUint8(p, q & 0xff);
      view.setUint8(p + 1, (q >> 8) & 0xff);
      view.setUint8(p + 2, (q >> 16) & 0xff);
      p += 3;
    }
  }

  return {
    buffer,
    frames,
    sampleRate,
    peak,
    peakPerChannel,
    overPerChannel,
    overCount: overPerChannel[0] + overPerChannel[1],
    clampCount,
  };
}
