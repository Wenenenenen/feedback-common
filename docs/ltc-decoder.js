// LTC biphase-mark decoder — JS port of the validated Python prototype.
// Handles: polarity inversion, DC offset, modest noise, reverse-time audio,
// 25 fps non-drop-frame and 30000/1001 drop-frame. Frames that cannot be built
// from complete edges are dropped, leaving explicit gaps in the frame list.

export const SYNC_BITS = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

// Parse a 16-bit PCM WAV (mono or stereo). Returns
// { sampleRate, channels: Int16Array[], durationSec, numFrames }.
export function parseWav(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, false) !== 0x52494646 || // "RIFF"
      dv.getUint32(8, false) !== 0x57415645) { // "WAVE"
    throw new Error('不是有效的 WAV 文件');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1, dataLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = dv.getUint32(offset, false);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) { // "fmt "
      const audioFormat = dv.getUint16(body, true);
      const numChannels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitsPerSample = dv.getUint16(body + 14, true);
      if (audioFormat !== 1) throw new Error('仅支持未压缩 PCM（audioFormat=1）');
      if (bitsPerSample !== 16) throw new Error('仅支持 16 位 PCM');
      fmt = { numChannels, sampleRate, bitsPerSample };
    } else if (id === 0x64617461) { // "data"
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size & 1); // chunks are word-aligned
    if (dataOffset >= 0 && fmt) break;
  }
  if (!fmt) throw new Error('WAV 缺少 fmt 块');
  if (dataOffset < 0) throw new Error('WAV 缺少 data 块');
  const { numChannels, sampleRate, bitsPerSample } = fmt;
  if (numChannels < 1 || numChannels > 2) throw new Error('仅支持单声道或双声道');
  const totalSamples = Math.floor(dataLength / 2);
  const frames = Math.floor(totalSamples / numChannels);
  const pcm = new Int16Array(buffer, dataOffset, totalSamples);
  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    const ch = new Int16Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = pcm[i * numChannels + c];
    channels.push(ch);
  }
  return { sampleRate, channels, durationSec: frames / sampleRate, numFrames: frames,
           numChannels, bitsPerSample };
}

// Hysteresis Schmitt-trigger edge detection. Inversion only swaps high/low, so
// edge positions are polarity-independent; the percentile centre removes DC
// offset and the 30%-amplitude band rejects small noise.
export function findEdges(x) {
  const sorted = Array.from(x).sort((a, b) => a - b);
  const n = sorted.length;
  const p5 = sorted[Math.floor(n / 20)];
  const p95 = sorted[Math.floor((n * 19) / 20)];
  const amp = (p95 - p5) / 2 || 1;
  const centre = (p95 + p5) / 2;
  const hi = centre + 0.3 * amp;
  const lo = centre - 0.3 * amp;
  const edges = [];
  let high = x[0] > centre;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (high) {
      if (v < lo) { high = false; edges.push(i); }
    } else if (v > hi) { high = true; edges.push(i); }
  }
  return edges;
}

// Locate frame boundaries from the sync word's run of 24 consecutive short
// gaps (its twelve 1-bits). Forward frames show an L,S,S tail after the run;
// reverse-time audio mirrors it as an S,S lead before the run.
// Returns { bounds: number[] (edge indices), direction: 'fwd'|'rev' }.
export function findFrameBoundaries(edges, T) {
  const isShort = (g) => g >= 0.25 * T && g < 0.75 * T;
  const isLong = (g) => g >= 0.75 * T && g <= 1.4 * T;
  const m = edges.length;
  const fwd = [];
  const rev = [];
  let i = 1;
  while (i < m) {
    if (isShort(edges[i] - edges[i - 1])) {
      let j = i;
      while (j < m && isShort(edges[j] - edges[j - 1])) j++;
      if (j - i >= 20) {
        const runLo = i - 1;
        const runHi = j - 1;
        // forward: run then L,S,S -> boundary three gaps later
        if (runHi + 3 < m) {
          const t = [
            edges[runHi + 1] - edges[runHi],
            edges[runHi + 2] - edges[runHi + 1],
            edges[runHi + 3] - edges[runHi + 2],
          ];
          if (isLong(t[0]) && isShort(t[1]) && isShort(t[2])) fwd.push(runHi + 3);
        }
        // reverse: boundary edge b, then S,S into the run
        if (runLo - 3 >= 1) {
          const b = runLo - 3;
          const lead = [edges[b + 1] - edges[b], edges[b + 2] - edges[b + 1]];
          if (isShort(lead[0]) && isShort(lead[1])) rev.push(b);
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  if (fwd.length >= rev.length) {
    fwd.sort((a, b) => a - b);
    return { bounds: fwd, direction: 'fwd' };
  }
  rev.sort((a, b) => a - b);
  return { bounds: rev, direction: 'rev' };
}

// Decode biphase cells between two boundary edge indices.
// bit 0 = one long gap; bit 1 = two short gaps.
// Returns { bits: number[], ok: boolean }.
export function decodeBetween(edges, lo, hi, T) {
  const bits = [];
  let ok = true;
  let i = lo;
  while (i < hi) {
    if (i + 1 > hi) { ok = false; break; }
    const g = edges[i + 1] - edges[i];
    if (g >= 0.75 * T && g <= 1.4 * T) {
      bits.push(0); i += 1;
    } else if (g >= 0.25 * T && g < 0.75 * T) {
      if (i + 2 <= hi && edges[i + 2] - edges[i + 1] >= 0.25 * T &&
          edges[i + 2] - edges[i + 1] < 0.75 * T) {
        bits.push(1); i += 2;
      } else { ok = false; break; }
    } else {
      ok = false; break;
    }
  }
  return { bits, ok: ok && bits.length === 80 };
}

// Eight BCD digits occupy 8-bit-stride slots (the layout used by these streams,
// verified against the probe ground truth).
export function parseTimecode(bits) {
  const u = (base, width) => {
    let v = 0;
    for (let k = 0; k < width; k++) v |= bits[base + k] << k;
    return v;
  };
  const frame = u(0, 4) + 10 * u(8, 2);
  const second = u(16, 4) + 10 * u(24, 3);
  const minute = u(32, 4) + 10 * u(40, 3);
  const hour = u(48, 4) + 10 * u(56, 2);
  return { hour, minute, second, frame, dffBit: !!bits[6] };
}

export function validFrame(bits) {
  if (bits.length !== 80) return false;
  const { hour, minute, second, frame } = parseTimecode(bits);
  return hour <= 23 && minute <= 59 && second <= 59 && frame <= 29;
}

export function formatTimecode(tc, dropFrame) {
  const sep = dropFrame ? ';' : ':';
  const p = (v) => String(v).padStart(2, '0');
  return `${p(tc.hour)}:${p(tc.minute)}:${p(tc.second)}${sep}${p(tc.frame)}`;
}

// Full decode of one channel. `mode` is 'df30' or 'ndf25'.
// Returns { direction, bitPeriod, edges, bounds, frames: Frame[], gapRanges }.
// Frame = { label, startSample, endSample, hour, minute, second, frame,
//           dffBit, gapBefore: boolean }.
// gapRanges lists sample spans with no decodable frame (signal loss /
// insufficient edges), so the UI can show where the index has holes.
export function decodeChannel(samples, sampleRate, mode) {
  const T = sampleRate / (mode === 'df30' ? 2400 : 2000);
  const dropFrame = mode === 'df30';
  const edges = findEdges(samples);
  const { bounds, direction } = findFrameBoundaries(edges, T);
  const frames = [];
  const gapRanges = [];
  let prevEnd = null;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    let { bits, ok } = decodeBetween(edges, a, b, T);
    const startSample = edges[a];
    const endSample = edges[b];
    if (!ok) {
      // A boundary pair whose cells cannot be classified is a real hole.
      gapRanges.push([startSample, endSample]);
      continue;
    }
    if (direction === 'rev') bits = bits.slice().reverse();
    if (!validFrame(bits)) {
      gapRanges.push([startSample, endSample]);
      continue;
    }
    const tc = parseTimecode(bits);
    frames.push({
      label: formatTimecode(tc, dropFrame),
      startSample,
      endSample,
      hour: tc.hour,
      minute: tc.minute,
      second: tc.second,
      frame: tc.frame,
      dffBit: tc.dffBit,
      gapBefore: prevEnd !== null && startSample !== prevEnd,
    });
    prevEnd = endSample;
  }
  frames.sort((p, q) => p.startSample - q.startSample);
  // Mark gaps between adjacent successful frames (boundaries present but the
  // intervening frame failed, or un-decoded head/tail regions).
  for (let k = 1; k < frames.length; k++) {
    if (frames[k].startSample !== frames[k - 1].endSample) {
      frames[k].gapBefore = true;
      gapRanges.push([frames[k - 1].endSample, frames[k].startSample]);
    }
  }
  // de-duplicate overlapping/identical ranges and sort by start sample
  const merged = [];
  for (const [g0, g1] of gapRanges.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && g0 <= last[1]) last[1] = Math.max(last[1], g1);
    else merged.push([g0, g1]);
  }
  return { direction, bitPeriod: T, edges, bounds, frames, gapRanges: merged };
}

// Down-sample a channel to min/max envelope points for waveform drawing.
// Returns { min: Int32Array, max: Int32Array } with `buckets` columns.
export function buildEnvelope(samples, buckets) {
  const n = samples.length;
  const min = new Int32Array(buckets);
  const max = new Int32Array(buckets);
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.max(s + 1, Math.floor((b + 1) * per));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = s; i < e && i < n; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

// Label the kind of discontinuity between two consecutive decoded frames,
// accounting for direction, drop-frame skipped numbers and midnight wrap.
// `direction` is 'fwd' or 'rev' from the decoder. Reverse-time labels descend,
// so continuity and DF skips are mirrored and a midnight crossing runs in the
// opposite sense. Returns a human-readable string, or null when the pair is
// consistent with a single frame advance (DF skips are not timecode errors).
export function describeBreak(prev, next, mode, direction = 'fwd') {
  const fps = mode === 'df30' ? 30 : 25;
  const toCount = (f) =>
    ((f.hour * 60 + f.minute) * 60 + f.second) * fps + f.frame;
  const a = toCount(prev);
  const b = toCount(next);
  if (direction === 'rev') {
    // labels descend; a wrap means the count jumps upward (00:00:00 -> 23:59:59)
    if (b > a) return '过午夜回绕（倒放）';
    const delta = a - b;
    if (delta === 1) return null;
    if (mode === 'df30' && (delta === 2 || delta === 3)) {
      return '丢帧计数跳号（倒放，跳过中间帧号）';
    }
    return `时间码断点（倒放，标签计数差 ${delta}）`;
  }
  // forward: midnight wrap rolls the count down from 23:59:59 to 00:00:00
  if (b < a) return '过午夜回绕';
  const delta = b - a;
  if (delta === 1) return null;
  if (mode === 'df30') {
    const crossedMinute = next.second === 0 && prev.second === 59;
    if (delta === 2 || (delta === 3 && crossedMinute && next.minute % 10 !== 0)) {
      return '丢帧计数跳号（跳过中间帧号）';
    }
  }
  return `时间码断点（标签计数差 ${delta}）`;
}
