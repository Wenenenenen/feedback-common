/*!
 * Tiny PCM16 WAV encoder (dependency-free, UMD).
 * The preview player and the downloaded WAV both consume the very same
 * interleaved Int16Array, so a selection is sample-for-sample the matching
 * slice of the full track.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDQWav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Encode an interleaved PCM16 sample array as a standard RIFF WAV.
  function encodeInterleaved(samples, sampleRate, channels) {
    if (!(samples instanceof Int16Array)) samples = new Int16Array(samples);
    channels = channels || 1;
    sampleRate = sampleRate || 48000;
    var dataLen = samples.length * 2;
    var buf = new ArrayBuffer(44 + dataLen);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    function fourcc(off, s) {
      u8[off] = s.charCodeAt(0);
      u8[off + 1] = s.charCodeAt(1);
      u8[off + 2] = s.charCodeAt(2);
      u8[off + 3] = s.charCodeAt(3);
    }

    fourcc(0, 'RIFF');
    dv.setUint32(4, 36 + dataLen, true);
    fourcc(8, 'WAVE');
    fourcc(12, 'fmt ');
    dv.setUint32(16, 16, true);              // PCM fmt chunk size
    dv.setUint16(20, 1, true);               // PCM format
    dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * 2, true); // byte rate
    dv.setUint16(32, channels * 2, true);    // block align
    dv.setUint16(34, 16, true);              // bits per sample
    fourcc(36, 'data');
    dv.setUint32(40, dataLen, true);

    var off = 44;
    for (var i = 0; i < samples.length; i++) {
      dv.setInt16(off, samples[i], true);
      off += 2;
    }
    return buf;
  }

  // Interleave per-channel Int16Array planes for frames [f0,f1).
  function interleaveSlice(planes, channels, f0, f1) {
    var frames = f1 - f0;
    var out = new Int16Array(frames * channels);
    var k = 0;
    for (var f = f0; f < f1; f++) {
      for (var c = 0; c < channels; c++) out[k++] = planes[c][f];
    }
    return out;
  }

  // Byte-exact slice of an existing interleaved array (a view, no copy of
  // values). Encoding this yields exactly the corresponding byte range of the
  // full-track WAV data chunk.
  function interleavedViewSlice(fullInterleaved, channels, f0, f1) {
    return fullInterleaved.subarray(f0 * channels, f1 * channels);
  }

  function wavDataBytes(wavBuffer) {
    return new Uint8Array(wavBuffer, 44, wavBuffer.byteLength - 44);
  }

  return {
    encodeInterleaved: encodeInterleaved,
    interleaveSlice: interleaveSlice,
    interleavedViewSlice: interleavedViewSlice,
    wavDataBytes: wavDataBytes
  };
});
