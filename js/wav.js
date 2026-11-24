// wav.js — 严格解析 48kHz / 双声道 / 16-bit PCM WAV（RIFF/WAVE，小端）
// 只接受 audioFormat=1（PCM），跳过 LIST/fact 等非 data 块；多个 data 块拼接。

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BITS_PER_SAMPLE = 16;
export const MAX_SOURCES = 8;
export const MAX_FRAMES_PER_SOURCE = 10 * 60 * SAMPLE_RATE; // 10 分钟 = 28,800,000 帧

export class WavFormatError extends Error {}

function ascii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * 解析 WAV 字节。
 * @returns {{ name:string, sampleRate:number, channels:number, bitsPerSample:number,
 *             frames:Int16Array[], frameCount:number }}
 *   frames[ch] 为每声道独立的 Int16Array（长度 frameCount）。
 */
export function parseWav(buffer, name) {
  if (buffer.byteLength < 44) throw new WavFormatError('文件过小，不是完整 WAV');
  const view = new DataView(buffer);
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
    throw new WavFormatError('缺少 RIFF/WAVE 标识');
  }

  let fmt = null;
  const dataChunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > buffer.byteLength) {
      throw new WavFormatError(`块 ${id.trim()} 长度超出文件范围`);
    }
    if (id === 'fmt ') {
      if (size < 16) throw new WavFormatError('fmt 块过短');
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataChunks.push({ offset: body, size });
    }
    offset = body + size + (size & 1); // 块按字对齐，奇数补一个填充字节
  }

  if (!fmt) throw new WavFormatError('缺少 fmt 块');
  if (fmt.audioFormat !== 1) throw new WavFormatError(`仅支持 PCM（audioFormat=1），当前为 ${fmt.audioFormat}`);
  if (fmt.channels !== CHANNELS) throw new WavFormatError(`仅支持双声道，当前为 ${fmt.channels} 声道`);
  if (fmt.sampleRate !== SAMPLE_RATE) throw new WavFormatError(`仅支持 ${SAMPLE_RATE} Hz，当前为 ${fmt.sampleRate} Hz`);
  if (fmt.bitsPerSample !== BITS_PER_SAMPLE) throw new WavFormatError(`仅支持 16 位 PCM，当前为 ${fmt.bitsPerSample} 位`);
  if (dataChunks.length === 0) throw new WavFormatError('缺少 data 块');

  const totalDataBytes = dataChunks.reduce((a, c) => a + c.size, 0);
  if (totalDataBytes % 4 !== 0) throw new WavFormatError('data 长度不是完整双声道帧的整数倍');
  const frameCount = totalDataBytes / 4;
  if (frameCount === 0) throw new WavFormatError('data 块为空');
  if (frameCount > MAX_FRAMES_PER_SOURCE) {
    throw new WavFormatError(`长度 ${frameCount} 帧（${(frameCount / SAMPLE_RATE).toFixed(1)} 秒）超过 10 分钟上限`);
  }

  // 多个 data 块复制进一块连续缓冲（实际文件几乎只有一个 data 块）
  const pcm = new Int16Array(new ArrayBuffer(totalDataBytes));
  let copied = 0;
  for (const c of dataChunks) {
    pcm.set(new Int16Array(buffer, c.offset, c.size / 2), copied / 2);
    copied += c.size;
  }

  // 拆成每声道独立数组，金字塔按声道存储
  const left = new Int16Array(frameCount);
  const right = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    left[i] = pcm[i * 2];
    right[i] = pcm[i * 2 + 1];
  }
  return { name, sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE, frames: [left, right], frameCount };
}
