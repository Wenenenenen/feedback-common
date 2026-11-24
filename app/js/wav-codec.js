// wav-codec.js — 最小 WAV(PCM16 单声道)解析与补零渲染导出
// 只支持本任务约定的 48kHz / 单声道 / 16 位 PCM; 其它格式明确报错。

export const SAMPLE_RATE = 48000;

/**
 * 解析 WAV 文件为 { name, samples: Int16Array, frames, sampleRate }
 */
export function parseWav(buffer, name) {
  const dv = new DataView(buffer);
  const readStr = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error(`${name}: 不是 WAV/RIFF 文件`);
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= dv.byteLength) {
    const id = readStr(off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        tag: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { off: body, size };
    }
    off = body + size + (size % 2); // 块按字对齐
  }
  if (!fmt || !data) throw new Error(`${name}: 缺少 fmt/data 块`);
  if (fmt.tag !== 1) throw new Error(`${name}: 仅支持 PCM 格式(格式码 ${fmt.tag})`);
  if (fmt.channels !== 1) throw new Error(`${name}: 仅支持单声道(当前 ${fmt.channels} 声道)`);
  if (fmt.bits !== 16) throw new Error(`${name}: 仅支持 16 位 PCM(当前 ${fmt.bits} 位)`);
  if (fmt.sampleRate !== SAMPLE_RATE) {
    throw new Error(`${name}: 采样率必须为 ${SAMPLE_RATE}Hz(当前 ${fmt.sampleRate}Hz)`);
  }
  const frames = Math.floor(data.size / 2);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(data.off + i * 2, true);
  return { name, samples, frames, sampleRate: fmt.sampleRate };
}

/**
 * 按选择清单渲染交付轨: 长度为 totalFrames, 未覆盖处补零, 区间重叠以报错拦截
 * @param {Array<{take:number, src:number, dst:number, len:number}>} chosen
 * @param {Map<number, Int16Array>} takeSamples 轨号 -> 采样
 * @param {number} totalFrames
 */
export function renderMix(chosen, takeSamples, totalFrames) {
  const out = new Int16Array(totalFrames);
  for (const c of chosen) {
    const src = takeSamples.get(c.take);
    if (!src) throw new Error(`缺少源轨 t${c.take} 的音频`);
    if (c.src + c.len > src.length) {
      throw new Error(`候选源区间超出 t${c.take}.wav 长度`);
    }
    if (c.dst + c.len > totalFrames) {
      throw new Error('候选目标区间超出交付总帧数');
    }
    for (let i = 0; i < c.len; i++) {
      if (out[c.dst + i] !== 0) {
        throw new Error('交付区间重叠, 渲染中止');
      }
      out[c.dst + i] = src[c.src + i];
    }
  }
  return out;
}

/** Int16Array -> WAV Blob(48kHz 单声道 16 位) */
export function encodeWav(samples) {
  const bytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buf);
  const wStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  wStr(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  wStr(8, 'WAVE');
  wStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // 单声道
  dv.setUint32(24, SAMPLE_RATE, true);
  dv.setUint32(28, SAMPLE_RATE * 2, true); // 字节率
  dv.setUint16(32, 2, true); // 块对齐
  dv.setUint16(34, 16, true); // 位深
  wStr(36, 'data');
  dv.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * 降采样峰值包络, 供波形绘制: 返回 { min: Float32Array, max: Float32Array }
 * 每像素一个 min/max 对; buckets 为期望桶数。
 */
export function peakEnvelope(samples, buckets) {
  const n = samples.length;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  min.fill(1);
  max.fill(-1);
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(n, Math.ceil((b + 1) * per));
    let lo = 1;
    let hi = -1;
    for (let i = s; i < e; i++) {
      const v = samples[i] / 32768;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (e <= s) { lo = 0; hi = 0; }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}
