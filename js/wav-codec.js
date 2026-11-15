// WAV (PCM) 解析与 24 位 PCM 打包。
// 仅依赖 DataView / Uint8Array，浏览器与 Node 均可使用。
// 支持：16/24 位 PCM、单/双声道、44.1k/48k（WAVE_FORMAT_EXTENSIBLE 中的 PCM 也识别）。

export class WavFormatError extends Error {}

const PCM_FORMAT = 0x0001;
// WAVE_FORMAT_EXTENSIBLE 的 SubFormat GUID 前两字节为 PCM 格式码，
// 其后固定为 MEDIASUBTYPE_PCM 的剩余 GUID 字节。
const PCM_SUBFORMAT_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/**
 * 解析 WAV 文件，返回交错样本拆分后的 planar Float32Array。
 * @param {ArrayBuffer} buffer
 */
export function parseWav(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) throw new WavFormatError('文件过短，不是合法 WAV');
  if (fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    throw new WavFormatError('缺少 RIFF/WAVE 标识');
  }

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  let p = 12;
  while (p + 8 <= view.buffer.byteLength) {
    const id = fourcc(view, p);
    const size = view.getUint32(p + 4, true);
    const body = p + 8;
    if (body + size > buffer.byteLength) throw new WavFormatError(`块 ${id} 长度超出文件`);
    if (id === 'fmt ') {
      if (size < 16) throw new WavFormatError('fmt 块过短');
      fmt = parseFmt(view, body, size);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
      break; // 样本数据取第一个 data 块
    }
    p = body + size + (size & 1); // 块按字对齐
  }

  if (!fmt) throw new WavFormatError('未找到 fmt 块');
  if (dataOffset < 0) throw new WavFormatError('未找到 data 块');
  if (fmt.audioFormat !== PCM_FORMAT) {
    throw new WavFormatError(`仅支持整数 PCM，当前格式码 ${fmt.audioFormat}`);
  }
  if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 24) {
    throw new WavFormatError(`仅支持 16/24 位 PCM，当前为 ${fmt.bitsPerSample} 位`);
  }
  if (fmt.channels !== 1 && fmt.channels !== 2) {
    throw new WavFormatError(`仅支持单/双声道，当前为 ${fmt.channels} 声道`);
  }
  if (fmt.sampleRate !== 44100 && fmt.sampleRate !== 48000) {
    throw new WavFormatError(`仅支持 44.1k/48k 采样率，当前为 ${fmt.sampleRate} Hz`);
  }

  const { channels, bitsPerSample, sampleRate } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const frames = Math.floor(dataLength / blockAlign);
  if (frames === 0) throw new WavFormatError('data 块中没有样本');

  const planar = [];
  for (let c = 0; c < channels; c++) planar.push(new Float32Array(frames));

  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < channels; c++) {
      const off = dataOffset + (n * channels + c) * bytesPerSample;
      let v;
      if (bitsPerSample === 16) {
        v = view.getInt16(off, true) / 32768;
      } else {
        v = readInt24(view, off) / 8388608;
      }
      planar[c][n] = v;
    }
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    frames,
    duration: frames / sampleRate,
    planar,
  };
}

function parseFmt(view, body, size) {
  const audioFormatRaw = view.getUint16(body, true);
  const channels = view.getUint16(body + 2, true);
  const sampleRate = view.getUint32(body + 4, true);
  const bitsPerSample = view.getUint16(body + 14, true);

  let audioFormat = audioFormatRaw;
  if (audioFormatRaw === 0xfffe) {
    // WAVE_FORMAT_EXTENSIBLE：SubFormat 从 body+24 开始
    if (size < 40) throw new WavFormatError('EXTENSIBLE fmt 块过短');
    audioFormat = view.getUint16(body + 24, true);
    for (let i = 0; i < PCM_SUBFORMAT_TAIL.length; i++) {
      if (view.getUint8(body + 26 + i) !== PCM_SUBFORMAT_TAIL[i]) {
        throw new WavFormatError('EXTENSIBLE 子格式不是 PCM');
      }
    }
  }
  return { audioFormat, channels, sampleRate, bitsPerSample };
}

function readInt24(view, off) {
  const b0 = view.getUint8(off);
  const b1 = view.getUint8(off + 1);
  const b2 = view.getUint8(off + 2);
  let v = b0 | (b1 << 8) | (b2 << 16);
  if (v & 0x800000) v -= 0x1000000; // 符号扩展
  return v;
}

function fourcc(view, off) {
  return String.fromCharCode(
    view.getUint8(off),
    view.getUint8(off + 1),
    view.getUint8(off + 2),
    view.getUint8(off + 3),
  );
}

/**
 * 将 planar Float32 样本打包为同采样率/声道/帧数的 24 位 PCM WAV。
 * 不做限幅处理；仅在量化越界时夹取到 24 位码值范围（正常交付增益下不会触发）。
 * @returns {Uint8Array}
 */
export function encodeWav24(sampleRate, channels, planar, frames) {
  const bytesPerSample = 3;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  writeFourcc(out, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourcc(out, 8, 'WAVE');
  writeFourcc(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  writeFourcc(out, 36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < channels; c++) {
      let code = Math.round(planar[c][n] * 8388608);
      if (code > 8388607) code = 8388607;
      if (code < -8388608) code = -8388608;
      if (code < 0) code += 0x1000000;
      out[off++] = code & 0xff;
      out[off++] = (code >> 8) & 0xff;
      out[off++] = (code >> 16) & 0xff;
    }
  }
  return out;
}

function writeFourcc(out, off, text) {
  for (let i = 0; i < 4; i++) out[off + i] = text.charCodeAt(i);
}
