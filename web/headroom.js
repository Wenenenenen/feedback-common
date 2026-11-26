// SOS headroom planner — core fixed-point logic, no DOM.
// Shared by the web workers and the Node cross-check harness.
'use strict';

const MAX_TOTAL_SHIFT = 12;
const MAX_STAGE_SHIFT = 3;
const Q14 = 1 << 14;
const CLIP_LO = -32768;
const CLIP_HI = 32767;

// v / d, nearest with ties to even; d is a power of two >= 1.
function roundHalfEvenDiv(v, d) {
  if (d === 1) return v;
  if (v >= 0) {
    const h = d >> 1;
    const q = Math.trunc(v / d);
    const r = v - q * d;
    if (r > h || (r === h && (q & 1) === 1)) return q + 1;
    return q;
  }
  return -roundHalfEvenDiv(-v, d);
}

function validatePlan(plan) {
  const errs = [];
  if (!plan || typeof plan !== 'object') {
    return ['方案必须是 JSON 对象'];
  }
  const { bands, sections } = plan;
  if (!Array.isArray(bands) || bands.length < 1 || bands.length > 32) {
    errs.push('bands 必须是 1 到 32 项的数组');
  } else {
    const seen = new Set();
    bands.forEach((f, i) => {
      if (!Number.isInteger(f) || f < 1 || f > 24000) {
        errs.push(`bands[${i}]=${f} 不是 1..24000 的整数`);
      }
      if (seen.has(f)) errs.push(`bands 存在重复频点 ${f}`);
      seen.add(f);
    });
    if (errs.length === 0) {
      for (let i = 1; i < bands.length; i++) {
        if (bands[i] <= bands[i - 1]) {
          errs.push('bands 必须按升序且互异');
          break;
        }
      }
    }
  }
  if (!Array.isArray(sections) || sections.length < 1
      || sections.length > 14) {
    errs.push('sections 必须是 1 到 14 段的数组');
    return errs;
  }
  const nb = Array.isArray(bands) ? bands.length : 0;
  const ids = new Set();
  sections.forEach((s, i) => {
    const tag = `sections[${i}]`;
    if (!s || typeof s !== 'object') {
      errs.push(`${tag} 不是对象`);
      return;
    }
    if (!Number.isInteger(s.id) || s.id < 0 || s.id > 65535) {
      errs.push(`${tag}.id=${s.id} 不是 0..65535 的整数`);
    } else if (ids.has(s.id)) {
      errs.push(`段 id ${s.id} 重复`);
    }
    ids.add(s.id);
    ['b', 'a'].forEach((k) => {
      const want = k === 'b' ? 3 : 2;
      if (!Array.isArray(s[k]) || s[k].length !== want
          || s[k].some((x) => !Number.isInteger(x)
              || x < -32768 || x > 32767)) {
        errs.push(`${tag}.${k} 必须是 ${want} 个有符号 16 位整数`);
      }
    });
    ['gain', 'limit'].forEach((k) => {
      if (!Array.isArray(s[k]) || s[k].length !== nb
          || s[k].some((x) => !Number.isInteger(x)
              || x < -8192 || x > 8192)) {
        errs.push(`${tag}.${k} 必须是与 bands 等长、取值 -8192..8192 的整数数组`);
      }
    });
  });
  return errs;
}

// Subset DP. Returns { order: [{id, shift}], total, prefixSum,
// bookByStage: Int32Array[stages][bands], marginByStage } or null.
function solvePlan(sections, bands) {
  const n = sections.length;
  const nb = bands.length;
  const size = 1 << n;
  const idxById = sections.map((s) => s.id);
  // expand sections in ascending id so equal-P ties land lex-smallest
  const orderIdx = sections.map((_, i) => i)
    .sort((p, q) => idxById[p] - idxById[q]);

  // subset gain sums: flat Int32Array size*nb
  const sumGain = new Int32Array(size * nb);
  for (let mask = 1; mask < size; mask++) {
    const lb = mask & -mask;
    const i = 31 - Math.clz32(lb);
    const prev = mask ^ lb;
    const gi = sections[i].gain;
    for (let b = 0; b < nb; b++) {
      sumGain[mask * nb + b] = sumGain[prev * nb + b] + gi[b];
    }
  }

  // R[i][s][b]
  const R = sections.map((s) => Array.from({ length: MAX_STAGE_SHIFT + 1 },
    (_, sh) => s.limit.map((lim, b) => lim - s.gain[b] + 256 * sh)));

  // dp state per (mask, total): { p, seq: Int8Array of section indices,
  // shifts parallel array }
  const dp = new Array(size);
  for (let m = 0; m < size; m++) dp[m] = new Array(MAX_TOTAL_SHIFT + 1).fill(null);
  dp[0][0] = { p: 0, seq: [], sh: [] };

  const book = new Int32Array(nb);
  for (let mask = 0; mask < size; mask++) {
    const base = mask * nb;
    const remaining = (size - 1) ^ mask;
    for (let total = 0; total <= MAX_TOTAL_SHIFT; total++) {
      const st = dp[mask][total];
      if (st === null) continue;
      for (let b = 0; b < nb; b++) {
        book[b] = sumGain[base + b] - 256 * total;
      }
      for (const i of orderIdx) {
        const bit = 1 << i;
        if ((remaining & bit) === 0) continue;
        const nmask = mask | bit;
        for (let s = 0; s <= MAX_STAGE_SHIFT; s++) {
          const nt = total + s;
          if (nt > MAX_TOTAL_SHIFT) break;
          const r = R[i][s];
          let ok = true;
          for (let b = 0; b < nb; b++) {
            if (book[b] > r[b]) { ok = false; break; }
          }
          if (!ok) continue;
          // prefix-sum objective: stage k contributes the cumulative
          // shift *after* this transition, i.e. nt
          const np = st.p + nt;
          const tgt = dp[nmask][nt];
          if (tgt === null || np < tgt.p
              || (np === tgt.p && lexSmaller(st, i, s, tgt, idxById))) {
            dp[nmask][nt] = {
              p: np,
              seq: st.seq.concat(i),
              sh: st.sh.concat(s),
            };
          }
        }
      }
    }
  }

  const full = size - 1;
  let bestTotal = -1;
  for (let t = 0; t <= MAX_TOTAL_SHIFT; t++) {
    if (dp[full][t] !== null) { bestTotal = t; break; }
  }
  if (bestTotal < 0) return null;
  const best = dp[full][bestTotal];

  // rebuild per-stage book vectors and margins
  const bookByStage = [];
  const marginByStage = [];
  let g = new Int32Array(nb);
  best.seq.forEach((i, k) => {
    const sh = best.sh[k];
    const ng = new Int32Array(nb);
    for (let b = 0; b < nb; b++) {
      ng[b] = g[b] + sections[i].gain[b] - 256 * sh;
    }
    const margin = new Int32Array(nb);
    for (let b = 0; b < nb; b++) {
      margin[b] = sections[i].limit[b] - ng[b];
    }
    bookByStage.push(ng);
    marginByStage.push(margin);
    g = ng;
  });

  return {
    order: best.seq.map((i, k) => ({ id: sections[i].id, shift: best.sh[k] })),
    total: bestTotal,
    prefixSum: best.p,
    bookByStage,
    marginByStage,
  };
}

function lexSmaller(st, newIdx, newSh, tgt, ids) {
  // candidate sequence = st.seq+[newIdx], compared on (id, shift) pairs
  const aSeq = st.seq;
  const aSh = st.sh;
  const bSeq = tgt.seq;
  const bSh = tgt.sh;
  for (let k = 0; k < aSeq.length; k++) {
    const ai = ids[aSeq[k]];
    const bi = ids[bSeq[k]];
    if (ai !== bi) return ai < bi;
    if (aSh[k] !== bSh[k]) return aSh[k] < bSh[k];
  }
  const an = ids[newIdx];
  const bn = ids[bSeq[aSeq.length]];
  if (an !== bn) return an < bn;
  return newSh < bSh[aSeq.length];
}

// Exact per-sample simulation.
// samples: Int16Array interleaved; returns { output: Int16Array,
// clips: Int32Array[stages][channels] }.
function simulate(sectionsById, order, frames, channels, samples, onProgress) {
  const stages = order.length;
  const clips = Array.from({ length: stages },
    () => new Int32Array(channels));
  const output = new Int16Array(frames * channels);
  // hist[stage][channel] = [x1, x2, y1, y2]
  const hist = Array.from({ length: stages },
    () => Array.from({ length: channels }, () => [0, 0, 0, 0]));
  const b0 = order.map((o) => sectionsById[o.id].b[0]);
  const b1 = order.map((o) => sectionsById[o.id].b[1]);
  const b2 = order.map((o) => sectionsById[o.id].b[2]);
  const a1 = order.map((o) => sectionsById[o.id].a[0]);
  const a2 = order.map((o) => sectionsById[o.id].a[1]);
  const sh = order.map((o) => o.shift);
  const div = sh.map((s) => 1 << s);

  const CHUNK = 4096;
  for (let base = 0; base < frames; base += CHUNK) {
    const end = Math.min(frames, base + CHUNK);
    for (let fr = base; fr < end; fr++) {
      for (let c = 0; c < channels; c++) {
        let v = samples[fr * channels + c];
        for (let st = 0; st < stages; st++) {
          const x = roundHalfEvenDiv(v, div[st]);
          const h = hist[st][c];
          const acc = b0[st] * x + b1[st] * h[0] + b2[st] * h[1]
            - a1[st] * h[2] - a2[st] * h[3];
          let y = roundHalfEvenDiv(acc, Q14);
          if (y < CLIP_LO) { y = CLIP_LO; clips[st][c]++; }
          else if (y > CLIP_HI) { y = CLIP_HI; clips[st][c]++; }
          // saturated value enters recursive history
          h[3] = h[2];
          h[2] = y;
          h[1] = h[0];
          h[0] = x;
          v = y;
        }
        output[fr * channels + c] = v;
      }
    }
    if (onProgress) onProgress(end / frames);
  }
  return { output, clips };
}

// Minimal PCM16 WAV parser: returns {channels, sampleRate, frames, samples}
function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read4 = (p) => String.fromCharCode(dv.getUint8(p),
    dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
  if (read4(0) !== 'RIFF' || read4(8) !== 'WAVE') {
    throw new Error('不是 WAVE 文件');
  }
  let pos = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= bytes.length) {
    const cid = read4(pos);
    const sz = dv.getUint32(pos + 4, true);
    pos += 8;
    if (cid === 'fmt ') {
      const comp = dv.getUint16(pos, true);
      const channels = dv.getUint16(pos + 2, true);
      const sampleRate = dv.getUint32(pos + 4, true);
      const bits = dv.getUint16(pos + 14, true);
      fmt = { comp, channels, sampleRate, bits };
    } else if (cid === 'data') {
      dataOff = pos;
      dataLen = sz;
    }
    pos += sz + (sz & 1);
  }
  if (!fmt) throw new Error('缺少 fmt 块');
  if (fmt.comp !== 1) throw new Error('仅支持无压缩 PCM');
  if (fmt.bits !== 16) throw new Error('仅支持 16 位 PCM');
  if (fmt.channels < 1 || fmt.channels > 2) {
    throw new Error('仅支持单声道或双声道');
  }
  if (fmt.sampleRate !== 48000) {
    throw new Error(`采样率须为 48000Hz，实际 ${fmt.sampleRate}Hz`);
  }
  const maxFrames = 120 * 48000;
  const frames = Math.min(
    Math.floor(dataLen / (2 * fmt.channels)), maxFrames);
  if (dataLen / (2 * fmt.channels) > maxFrames) {
    throw new Error('录音超过 120 秒上限');
  }
  const samples = new Int16Array(frames * fmt.channels);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = dv.getInt16(dataOff + i * 2, true);
  }
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    frames,
    samples,
  };
}

function buildWav(samples, channels, sampleRate) {
  const bytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buf);
  const put4 = (p, s) => {
    for (let i = 0; i < 4; i++) dv.setUint8(p + i, s.charCodeAt(i));
  };
  put4(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  put4(8, 'WAVE');
  put4(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  put4(36, 'data');
  dv.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(44 + i * 2, samples[i], true);
  }
  return new Uint8Array(buf);
}

const HEADROOM = {
  MAX_TOTAL_SHIFT, MAX_STAGE_SHIFT, Q14, CLIP_LO, CLIP_HI,
  roundHalfEvenDiv, validatePlan, solvePlan, lexSmaller,
  simulate, parseWav, buildWav,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HEADROOM;
}
if (typeof self !== 'undefined') {
  self.HEADROOM = HEADROOM;
}
