// Minimal RIFF/WAVE PCM decoder for the supported inputs:
// 44.1k or 48 kHz, 16- or 24-bit, mono PCM, <= 60 s.
// Returns Float64 samples in [-1, 1]. Throws with a readable message on
// unsupported files.

export const SUPPORTED_RATES = [44100, 48000];
export const SUPPORTED_BITS = [16, 24];
export const MAX_DURATION_S = 60;

function readAscii(dv, off, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

export function decodeWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 44 || readAscii(dv, 0, 4) !== "RIFF" || readAscii(dv, 8, 4) !== "WAVE") {
    throw new Error("不是 WAV (RIFF/WAVE) 文件");
  }
  let off = 12;
  let fmt = null;
  let dataChunk = null;
  while (off + 8 <= dv.byteLength) {
    const id = readAscii(dv, off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        formatTag: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataChunk = { off: body, size };
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error("缺少 fmt 块");
  if (fmt.formatTag !== 1) throw new Error(`仅支持无压缩 PCM（format tag=1），当前为 ${fmt.formatTag}`);
  if (fmt.channels !== 1) throw new Error(`仅支持单声道文件，当前声道数=${fmt.channels}`);
  if (!SUPPORTED_RATES.includes(fmt.sampleRate)) {
    throw new Error(`仅支持 ${SUPPORTED_RATES.join("/")} Hz，当前采样率=${fmt.sampleRate}`);
  }
  if (!SUPPORTED_BITS.includes(fmt.bitsPerSample)) {
    throw new Error(`仅支持 ${SUPPORTED_BITS.join("/")} 位 PCM，当前位深=${fmt.bitsPerSample}`);
  }
  if (!dataChunk) throw new Error("缺少 data 块");

  const bytesPerSample = fmt.bitsPerSample / 8;
  const n = Math.floor(dataChunk.size / bytesPerSample);
  const duration = n / fmt.sampleRate;
  if (duration > MAX_DURATION_S + 1e-6) {
    throw new Error(`时长 ${duration.toFixed(2)}s 超过 ${MAX_DURATION_S}s 上限`);
  }
  const samples = new Float64Array(n);
  if (fmt.bitsPerSample === 16) {
    for (let i = 0; i < n; i++) {
      samples[i] = dv.getInt16(dataChunk.off + i * 2, true) / 32768;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = dataChunk.off + i * 3;
      let v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
      if (v & 0x800000) v -= 1 << 24;
      samples[i] = v / (1 << 23);
    }
  }
  return {
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    samples,
    duration,
  };
}
