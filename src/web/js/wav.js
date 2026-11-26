/*
 * wav.js — 48kHz 立体声 PCM16 WAV 编码与区域切取，用于导出与试听。
 * 导出与试听必须与“当前全轨”采样完全一致：二者都从同一份 render 结果切片/编码。
 */

/** 把左右声道的 Int16Array 编码为 48kHz 立体声 PCM16 WAV 的 ArrayBuffer。 */
export function encodeStereo16(left, right, start = 0, end = left.length) {
  const n = Math.max(0, end - start);
  const dataBytes = n * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 2, true); // stereo
  dv.setUint32(24, 48000, true);
  dv.setUint32(28, 48000 * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  writeStr(36, "data");
  dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    dv.setInt16(o, left[start + i], true);
    dv.setInt16(o + 2, right[start + i], true);
    o += 4;
  }
  return buffer;
}

/** 仅切取区间，返回可交给 AudioBuffer.copyToChannel 的交错 Float32（-1..1）。 */
export function sliceSelections(left, right, start, end) {
  const n = Math.max(0, end - start);
  const interleaved = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    interleaved[2 * i] = left[start + i] / 32768;
    interleaved[2 * i + 1] = right[start + i] / 32768;
  }
  return interleaved;
}
