/*
 * 试听与 WAV 导出：二者必须来自同一份逐样本 PCM。
 * 采样率固定 48kHz，16 位单声道，块 = 连续 256 采样。
 */
(function (global) {
  'use strict';

  const SAMPLE_RATE = 48000;
  const BLOCK_SAMPLES = 256;

  /*
   * 按轨拼装一段零基半开采样区间 [start, end) 的 PCM16。
   * getBlock(blockId) 返回 Int16Array / Uint8Array / null（未定/矛盾）。
   * fillSilenceUnresolved=true 时，未定块位置补静音；否则保留 null 标记。
   * 返回 { pcm: Int16Array, unresolved: [{blockId, sampleRanges}] }
   */
  function buildTrackPcm(model, trackIndex, start, end, getBlock, fillSilenceUnresolved) {
    const bpt = model.blocksPerTrack;
    const base = trackIndex * bpt;
    const length = end - start;
    const pcm = new Int16Array(length);
    const unresolved = [];

    const firstBlock = Math.floor(start / BLOCK_SAMPLES);
    const lastBlock = Math.floor((end - 1) / BLOCK_SAMPLES);

    for (let lb = firstBlock; lb <= lastBlock; lb++) {
      const blockStart = lb * BLOCK_SAMPLES;
      const blockEnd = blockStart + BLOCK_SAMPLES;
      const copyStart = Math.max(start, blockStart);
      const copyEnd = Math.min(end, blockEnd);
      if (copyEnd <= copyStart) continue;
      const off = copyStart - blockStart;
      const len = copyEnd - copyStart;
      const dstOff = copyStart - start;
      const blockId = base + lb;
      const block = getBlock(blockId);

      if (!block) {
        unresolved.push({
          blockId,
          sampleRange: [copyStart, copyEnd],
        });
        if (!fillSilenceUnresolved) continue; // 保持零（静音）
        continue;
      }
      pcm.set(block.subarray(off, off + len), dstOff);
    }
    return { pcm, unresolved };
  }

  function pcmToWavBytes(pcm16) {
    const n = pcm16.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);            // PCM
    dv.setUint16(22, 1, true);            // 单声道
    dv.setUint32(24, SAMPLE_RATE, true);
    dv.setUint32(28, SAMPLE_RATE * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++, o += 2) dv.setInt16(o, pcm16[i], true);
    return new Uint8Array(buf);
  }

  /* 试听：直接使用与导出完全相同的 Int16Array，声卡重采样不影响逐样本一致性 */
  function playPcm(ctx, pcm16) {
    const ab = ctx.createBuffer(1, pcm16.length, SAMPLE_RATE);
    ab.copyToChannel(pcm16, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(ctx.destination);
    src.start();
    return src;
  }

  function blockBytesToInt16(bytes) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
  }

  global.ParityAudio = {
    SAMPLE_RATE,
    BLOCK_SAMPLES,
    buildTrackPcm,
    pcmToWavBytes,
    playPcm,
    blockBytesToInt16,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ParityAudio;
})(typeof window !== 'undefined' ? window : globalThis);
