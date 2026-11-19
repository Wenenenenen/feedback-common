/*
 * wav.js — 把引擎输出的交错 int16 PCM 封装成精确长度的 WAV（PCM s16le）
 */

/**
 * @param {Uint8Array} pcm       引擎输出的原始 PCM 字节
 * @param {number} sampleRate    采样率
 * @param {number} channels      声道数
 * @returns {Blob} WAV 文件 Blob
 */
export function buildWavBlob(pcm, sampleRate, channels) {
  const dataLen = pcm.length;
  const buffer = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  const u32 = (off, v) => dv.setUint32(off, v >>> 0, true);
  const u16 = (off, v) => dv.setUint16(off, v, true);

  writeStr(0, "RIFF");
  u32(4, 36 + dataLen);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  u32(16, 16); // PCM fmt chunk 大小
  u16(20, 1); // PCM 格式
  u16(22, channels);
  u32(24, sampleRate);
  u32(28, sampleRate * channels * 2); // 字节率
  u16(32, channels * 2); // 块对齐
  u16(34, 16); // 位深
  writeStr(36, "data");
  u32(40, dataLen);

  new Uint8Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

/** 供核对：WAV data 段字节数（= 槽数 × 480 × channels × 2） */
export function expectedWavSize(slots, framesPerPacket, channels) {
  return 44 + slots * framesPerPacket * channels * 2;
}
