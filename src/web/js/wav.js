/*
 * WAV 读写：仅整数 PCM 16 / 24 bit。
 * 解析后样点以 Float32 保存；16/24-bit 整数在 [-1,1) 内的值可由 Float32 精确表示，
 * 因此后续旋转与量化不会引入额外的输入误差。
 */

export class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
  }
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const HEADER_BYTES = 44;

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * 解析 WAV。
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number,
 *            frames:number, duration:number, formatTag:number, channelMask:number|null,
 *            data:Float32Array[], peakPerChannel:number[], peak:number}}
 */
export function parseWav(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new WavError('不是有效的二进制文件');
  }
  if (arrayBuffer.byteLength < 44) {
    throw new WavError('文件太小，不是有效的 WAV');
  }

  const view = new DataView(arrayBuffer);
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') {
    throw new WavError('不是 RIFF/WAVE 文件');
  }

  let fmtOffset = -1;
  let fmtSize = -1;
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
      if (fmtOffset >= 0) throw new WavError('包含多个 fmt 块');
      fmtOffset = body;
      fmtSize = size;
    } else if (id === 'data') {
      if (dataOffset >= 0) throw new WavError('包含多个 data 块，无法确定音频数据');
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size & 1);
  }

  if (fmtOffset < 0) throw new WavError('缺少 fmt 块');
  if (fmtSize < 16) throw new WavError('fmt 块长度不足 16 字节');
  if (dataOffset < 0) throw new WavError('缺少 data 块');

  let formatTag = view.getUint16(fmtOffset, true);
  const channels = view.getUint16(fmtOffset + 2, true);
  const sampleRate = view.getUint32(fmtOffset + 4, true);
  const blockAlign = view.getUint16(fmtOffset + 12, true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);
  let channelMask = null;

  if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
    if (fmtSize < 40) throw new WavError('WAVE_FORMAT_EXTENSIBLE 的 fmt 块长度不足 40 字节');
    const cbSize = view.getUint16(fmtOffset + 16, true);
    if (cbSize < 22) throw new WavError('WAVE_FORMAT_EXTENSIBLE 的扩展信息不完整');
    formatTag = view.getUint16(fmtOffset + 24, true);
    channelMask = view.getUint32(fmtOffset + 20, true);
  }

  if (formatTag !== WAVE_FORMAT_PCM) {
    throw new WavError(`不是整数 PCM（格式 ${formatTag}），仅支持 16 / 24-bit PCM`);
  }
  if (bitsPerSample !== 16 && bitsPerSample !== 24) {
    throw new WavError(`不支持 ${bitsPerSample}-bit，仅支持 16 / 24-bit PCM`);
  }
  if (sampleRate !== 44100 && sampleRate !== 48000) {
    throw new WavError(`不支持 ${sampleRate} Hz，仅支持 44.1 kHz / 48 kHz`);
  }
  if (channels !== 4) {
    throw new WavError(`${channels} 声道：一阶 B-format 必须为 4 声道`);
  }
  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign !== channels * bytesPerSample) {
    throw new WavError(`块对齐 ${blockAlign} 字节与 4 声道 × ${bitsPerSample}-bit 不符`);
  }
  if (dataSize % blockAlign !== 0) {
    throw new WavError(`data 长度 ${dataSize} 不是整帧（每帧 ${blockAlign} 字节）`);
  }

  const frames = dataSize / blockAlign;
  const maxFrames = 60 * sampleRate;
  if (frames > maxFrames) {
    throw new WavError(
      `时长 ${(frames / sampleRate).toFixed(3)} s 超过 60 s 上限`,
    );
  }
  if (frames < 1) throw new WavError('音频为 0 帧');

  const data = Array.from({ length: channels }, () => new Float32Array(frames));
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
    formatTag,
    channelMask,
    data,
    peakPerChannel,
    peak,
  };
}

/**
 * 四声道平面样点 → 24-bit PCM WAV 字节。
 * 量化采用四舍五入到最近整数（.5 远离零），与参考实现的核对结果一致。
 * 调用前必须确认 |样点| < 1，本函数不做任何限幅。
 * @param {Float32Array[]} planes 4 个等长声道
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav24(planes, sampleRate) {
  const ints = planes.map((p) => {
    const out = new Int32Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = quantize24(p[i]);
    return out;
  });
  return encodeWav24FromInt(ints, sampleRate);
}

/** 浮点 → 24-bit 整数（.5 远离零）。 */
export function quantize24(v) {
  const x = v * 8388608;
  let q = x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
  if (q > 8388607) q = 8388607;
  if (q < -8388608) q = -8388608;
  return q;
}

/**
 * 已经是 24-bit 整数范围的 Int32 平面 → WAV 字节，不再做任何缩放的限幅。
 * @param {Int32Array[]} planes 4 个等长声道
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav24FromInt(planes, sampleRate) {
  if (planes.length !== 4) throw new WavError('导出必须为 4 声道');
  const frames = planes[0].length;
  for (const p of planes) {
    if (p.length !== frames) throw new WavError('四个声道的帧数不一致');
  }
  if (sampleRate !== 44100 && sampleRate !== 48000) {
    throw new WavError(`导出采样率 ${sampleRate} Hz 不受支持`);
  }

  const blockAlign = 4 * 3;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  const writeFourCC = (off, text) => {
    for (let i = 0; i < 4; i++) view.setUint8(off + i, text.charCodeAt(i));
  };
  writeFourCC(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCC(8, 'WAVE');
  writeFourCC(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, 4, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  writeFourCC(36, 'data');
  view.setUint32(40, dataSize, true);

  let p = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 4; ch++) {
      const q = planes[ch][i];
      const u = q < 0 ? q + 0x1000000 : q;
      view.setUint8(p, u & 0xff);
      view.setUint8(p + 1, (u >> 8) & 0xff);
      view.setUint8(p + 2, (u >> 16) & 0xff);
      p += 3;
    }
  }
  return buffer;
}

/** 24-bit 整数平面 → Float32 样点（精确）。 */
export function intToFloat(planes) {
  return planes.map((p) => {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = p[i] / 8388608;
    return out;
  });
}
