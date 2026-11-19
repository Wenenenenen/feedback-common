// wav-codec.js — 纯手写 WAV PCM 解析/编码（无依赖）
// 支持 44.1/48kHz、16/24 位 PCM、单/双声道

export class WavError extends Error {}

function readU32(b, o) { return (b[o]) | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }
function readU16(b, o) { return b[o] | (b[o + 1] << 8); }

export function parseWav(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 44) throw new WavError('文件过小，不是完整 WAV（少于 44 字节）');
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) throw new WavError('缺少 RIFF 头，不是 WAV 文件');
  if (b[8] !== 0x57 || b[9] !== 0x41 || b[10] !== 0x56 || b[11] !== 0x45) throw new WavError('缺少 WAVE 标识');

  let pos = 12;
  let fmt = null;
  let dataView = null;
  while (pos + 8 <= b.length) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    const size = readU32(b, pos + 4);
    const bodyStart = pos + 8;
    const avail = Math.max(0, Math.min(size, b.length - bodyStart));
    if (id === 'fmt ') {
      if (avail < 16) throw new WavError('fmt 块不完整，文件可能已截断');
      fmt = {
        tag: readU16(b, bodyStart),
        channels: readU16(b, bodyStart + 2),
        rate: readU32(b, bodyStart + 4),
        bits: readU16(b, bodyStart + 14),
      };
    } else if (id === 'data') {
      if (avail < size) {
        throw new WavError(`data 块声明 ${size} 字节但文件只剩 ${avail} 字节，WAV 已截断`);
      }
      dataView = b.subarray(bodyStart, bodyStart + size);
    }
    pos = bodyStart + size + (size & 1);
    if (size === 0) break;
  }
  if (!fmt) throw new WavError('找不到 fmt 块');
  if (dataView === null) throw new WavError('找不到 data 块');

  if (fmt.tag !== 1) throw new WavError(`仅支持 PCM(format=1)，当前格式标记 ${fmt.tag}（浮点/压缩格式不支持）`);
  if (fmt.bits !== 16 && fmt.bits !== 24) throw new WavError(`仅支持 16/24 位 PCM，当前为 ${fmt.bits} 位`);
  if (fmt.channels !== 1 && fmt.channels !== 2) throw new WavError(`仅支持单声道或双声道，当前 ${fmt.channels} 声道`);
  if (fmt.rate !== 44100 && fmt.rate !== 48000) throw new WavError(`仅支持 44100/48000 Hz，当前采样率 ${fmt.rate} Hz`);

  const bytesPerFrame = (fmt.bits / 8) * fmt.channels;
  if (dataView.length % bytesPerFrame !== 0) {
    throw new WavError('data 长度与声道/位深不匹配，文件可能已截断');
  }
  const frames = dataView.length / bytesPerFrame;
  if (frames === 0) throw new WavError('data 块为空');
  if (frames > 60 * fmt.rate) throw new WavError(`音频长 ${(frames / fmt.rate).toFixed(2)} 秒，超过 60 秒上限`);

  // 交错样本 -> 每声道 Float32，范围 [-1, 1)
  const channels = [new Float32Array(frames)];
  if (fmt.channels === 2) channels.push(new Float32Array(frames));

  if (fmt.bits === 16) {
    const iv = new Int16Array(dataView.buffer, dataView.byteOffset, dataView.length >> 1);
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < fmt.channels; c++) channels[c][n] = iv[n * fmt.channels + c] / 32768;
    }
  } else {
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < fmt.channels; c++) {
        const o = (n * fmt.channels + c) * 3;
        let v = dataView[o] | (dataView[o + 1] << 8) | (dataView[o + 2] << 16);
        if (v & 0x800000) v -= 1 << 24;
        channels[c][n] = v / 8388608;
      }
    }
  }

  return { rate: fmt.rate, bits: fmt.bits, channels: fmt.channels, frames, samples: channels };
}

// 四舍五入（+0.5 向零取整语义）后限幅，按原位深编码
export function encodeWav(channels, rate, bits) {
  const ch = channels.length;
  const frames = channels[0].length;
  const blockAlign = (bits / 8) * ch;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646, false); // RIFF
  dv.setUint32(4, 36 + dataSize, true);
  dv.setUint32(8, 0x57415645, false); // WAVE
  dv.setUint32(12, 0x666d7420, false); // fmt
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  dv.setUint32(36, 0x64617461, false); // data
  dv.setUint32(40, dataSize, true);

  const maxI = bits === 16 ? 32767 : 8388607;
  const minI = -(maxI + 1);
  let o = 44;
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < ch; c++) {
      let x = channels[c][n];
      if (!(x > -1)) x = -1; // NaN / <=-1 保护
      if (x > 1) x = 1;
      let q = Math.round(x * maxI);
      if (q > maxI) q = maxI;
      else if (q < minI) q = minI;
      if (bits === 16) {
        u8[o++] = q & 0xff;
        u8[o++] = (q >> 8) & 0xff;
      } else {
        u8[o++] = q & 0xff;
        u8[o++] = (q >> 8) & 0xff;
        u8[o++] = (q >> 16) & 0xff;
      }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
