// Temporal continuity stage: per-frame candidates are combined across frames
// with a Viterbi-style shortest-path search over a log-frequency state grid,
// plus an explicit silence/noise gate. Unvoiced frames are never forced to
// carry a pitch (the unvoiced state is always available).

import { HOP_MS, analyzeFrame, rmsLevel, spectralFlatness, zeroCrossingRate } from "./pitch.js";

// Fixed MIDI-style log grid covering the search range. States are semitone
// fractions; the grid is fine enough (1/4 semitone) to preserve glides and
// vibrato while keeping the lattice small.
const GRID_STEP_SEMITONES = 0.25;

function buildGrid(fMin, fMax) {
  const mMin = 69 + 12 * Math.log2(fMin / 440);
  const mMax = 69 + 12 * Math.log2(fMax / 440);
  const grid = [];
  for (let m = Math.ceil(mMin / GRID_STEP_SEMITONES) * GRID_STEP_SEMITONES; m <= mMax; m += GRID_STEP_SEMITONES) {
    grid.push(440 * Math.pow(2, (m - 69) / 12));
  }
  return grid;
}

// Build the list of center frames per the spec: 0, H, 2H, ... while < L.
export function centerFrames(totalSamples, sampleRate) {
  const H = Math.round(sampleRate / 100);
  const frames = [];
  for (let c = 0; c < totalSamples; c += H) frames.push(c);
  return { hop: H, frames };
}

function extractWindow(samples, center, windowLen) {
  const half = windowLen >> 1;
  const lo = center - half;
  const hi = lo + windowLen;
  const seg = new Float64Array(windowLen);
  const srcLo = Math.max(0, lo);
  const srcHi = Math.min(samples.length, hi);
  if (srcHi > srcLo) seg.set(samples.subarray(srcLo, srcHi), srcLo - lo);
  return seg;
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

// Adaptive silence/noise gate from the file's own level distribution.
// voicedThreshold (0..1) is the user control: higher = stricter voicing.
// The gate is expressed as a fraction of the frame's own energy (RMS^2),
// so it works even when a file contains no silence at all.
export function computeGate(frameInfo, voicedThreshold) {
  const energy = frameInfo.map((f) => f.rms * f.rms).sort((a, b) => a - b);
  const q = (p) => energy[Math.min(energy.length - 1, Math.max(0, Math.floor(p * energy.length)))];
  const eMin = Math.max(q(0.05), 1e-10);
  const eHigh = Math.max(q(0.9), eMin * 10);
  // user threshold 0.1..0.9 maps onto energy fractions ~0.5% .. 25%
  const t = Math.min(1, Math.max(0, (voicedThreshold - 0.1) / 0.8));
  const frac = 0.005 * Math.pow(50, t); // 0.005 .. 0.25
  const energyGate = frac * eHigh;
  return { eMin, eHigh, energyGate, levelGate: Math.sqrt(energyGate) };
}

function observationScore(frame, stateHz) {
  // distance of the state to the frame's nearest candidate, weighted by the
  // candidate's periodicity score (deep d' dip -> small cost). Candidates the
  // spectral stage flagged as subharmonics carry a large extra penalty.
  let best = Infinity;
  for (const c of frame.candidates) {
    if (c.hz <= 0) continue;
    const cents = 1200 * Math.log2(c.hz / stateHz);
    let cost = (cents * cents) / (35 * 35) + c.periodScore * 3.0;
    if (c.shadowed) cost += 4.0;
    if (cost < best) best = cost;
  }
  // also allow the frame's primary even if it was pruned from the candidate list
  if (frame.primary) {
    const cents = 1200 * Math.log2(frame.primary.hz / stateHz);
    const cost = (cents * cents) / (35 * 35) + frame.primary.periodScore * 3.0;
    if (cost < best) best = cost;
  }
  return best === Infinity ? 6 : best;
}

// Main entry. Returns one result record per center frame. `onProgress` may be
// async; the tracker yields periodically so the browser UI stays responsive.
export async function trackPitch(samples, sampleRate, params, onProgress) {
  const { windowMs, fMin, fMax, voicedThreshold } = params;
  const windowLen = Math.round((sampleRate * windowMs) / 1000);
  const { hop, frames } = centerFrames(samples.length, sampleRate);
  const grid = buildGrid(fMin, fMax);

  // ---- pass 1: per-frame acoustic analysis ----
  const info = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const seg = extractWindow(samples, frames[i], windowLen);
    info[i] = analyzeFrame(seg, sampleRate, { windowMs, fMin, fMax, yinThreshold: params.yinThreshold });
    if (onProgress && i % 20 === 19) {
      await onProgress(0.5 * (i / frames.length), `分析第 ${i + 1}/${frames.length} 帧`);
      await yieldToUI();
    }
  }
  const gate = computeGate(info, voicedThreshold);

  // ---- voicing gating ----
  // A frame is eligible for pitch only when its level clears the gate AND its
  // texture is tonal (low spectral flatness / moderate zero crossings) AND its
  // best candidate shows real periodicity.
  const eligible = info.map((f) => {
    const levelOk = f.rms * f.rms >= gate.energyGate;
    const tonal = f.sfm < 0.4 || f.zcr < 0.4;
    const periodic = f.primary !== null && f.primary.periodScore < 0.5;
    return levelOk && tonal && periodic;
  });

  // ---- pass 2: Viterbi over log-frequency grid + unvoiced state ----
  const S = grid.length;
  const U = S; // index of the unvoiced state
  const STAY_UNVOICED = 0.05;
  const ENTER_VOICED = 1.2;
  const ENTER_UNVOICED = 0.6;
  const UNVOICED_OBS = 0.4;

  let prev = new Float64Array(S + 1);
  let back = new Array(frames.length);
  for (let s = 0; s < S; s++) prev[s] = eligible[0] ? observationScore(info[0], grid[s]) : 1e6;
  prev[U] = eligible[0] ? 1e6 : UNVOICED_OBS;

  for (let i = 1; i < frames.length; i++) {
    const cur = new Float64Array(S + 1);
    const bt = new Int32Array(S + 1);
    const frame = info[i];
    for (let s = 0; s < S; s++) {
      if (!eligible[i]) {
        cur[s] = 1e6;
        bt[s] = -1;
        continue;
      }
      const obs = observationScore(frame, grid[s]);
      // transitions from voiced states
      let best = Infinity, bestJ = -1;
      for (let j = 0; j < S; j++) {
        if (prev[j] >= 1e6) continue;
        const semis = (GRID_STEP_SEMITONES * (s - j));
        const trans = (semis * semis) / (3.0 * 3.0); // ~3 semitones per 10ms is cheap
        const v = prev[j] + trans;
        if (v < best) { best = v; bestJ = j; }
      }
      const fromU = prev[U] + ENTER_VOICED;
      if (fromU < best) { best = fromU; bestJ = U; }
      cur[s] = best + obs;
      bt[s] = bestJ;
    }
    // unvoiced state
    if (eligible[i]) {
      cur[U] = 1e6;
      bt[U] = -1;
    } else {
      const fromU = prev[U] + STAY_UNVOICED;
      let bestV = Infinity, bestJ = -1;
      for (let j = 0; j < S; j++) {
        if (prev[j] >= 1e6) continue;
        const v = prev[j] + ENTER_UNVOICED;
        if (v < bestV) { bestV = v; bestJ = j; }
      }
      if (fromU <= bestV) { cur[U] = fromU; bt[U] = U; }
      else { cur[U] = bestV; bt[U] = bestJ; }
    }
    prev = cur;
    back[i] = bt;
    if (onProgress && i % 50 === 49) {
      await onProgress(0.5 + 0.5 * (i / frames.length), `连续性跟踪 ${i + 1}/${frames.length}`);
      await yieldToUI();
    }
  }

  // ---- backtrack ----
  const path = new Int32Array(frames.length);
  let last = 0;
  for (let s = 1; s <= S; s++) if (prev[s] < prev[last]) last = s;
  for (let i = frames.length - 1; i >= 0; i--) {
    path[i] = last;
    if (i > 0) {
      const b = back[i][last];
      if (b >= 0) last = b;
      else last = U; // unreachable voiced state: treat as unvoiced
    }
  }

  // ---- assemble records ----
  const results = frames.map((center, i) => {
    const state = path[i];
    const voiced = state !== U && eligible[i];
    const f = info[i];
    let hz = null, confidence = 0;
    if (voiced) {
      // Prefer the frame's octave-corrected primary; only use a nearby grid
      // candidate when the primary sits far from the chosen track state.
      const stateHz = grid[state];
      let nearest = f.primary;
      if (f.primary) {
        const primaryCents = Math.abs(1200 * Math.log2(f.primary.hz / stateHz));
        if (primaryCents > 150) {
          let bestCents = Infinity;
          for (const c of f.candidates) {
            const cc = Math.abs(1200 * Math.log2(c.hz / stateHz));
            if (cc < bestCents) { bestCents = cc; nearest = c; }
          }
        }
      } else {
        let bestCents = Infinity;
        for (const c of f.candidates) {
          const cc = Math.abs(1200 * Math.log2(c.hz / stateHz));
          if (cc < bestCents) { bestCents = cc; nearest = c; }
        }
      }
      hz = nearest ? nearest.hz : stateHz;
      const ps = nearest ? nearest.periodScore : (f.primary ? f.primary.periodScore : 0.5);
      // confidence: periodicity dominated, discounted by gate margin
      const gateMargin = Math.min(1, f.rms / Math.max(gate.levelGate * 1.5, 1e-6));
      confidence = Math.max(0, Math.min(1, (1 - ps) * (0.6 + 0.4 * gateMargin)));
    } else {
      confidence = Math.max(0, 1 - (f.primary ? f.primary.periodScore : 1)) * 0.25;
    }
    return {
      centerFrame: center,
      timeS: center / sampleRate,
      hz,
      confidence,
      voiced,
      rms: f.rms,
      sfm: f.sfm,
      zcr: f.zcr,
      candidates: f.candidates,
      primary: f.primary,
      periodScore: f.primary ? f.primary.periodScore : null,
      dp: f.dp,
      lagLo: f.lagLo,
      lagHi: f.lagHi,
    };
  });

  return {
    hop,
    windowMs,
    windowLen,
    gate,
    frames: results,
  };
}

// Note naming per spec: m = 69 + 12 log2(f/A4), nearest = floor(m+0.5),
// cents = 100*(m-nearest), MIDI 60 = C4.
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteFromHz(hz, a4) {
  if (hz == null || !Number.isFinite(hz)) return { note: null, midi: null, cents: null };
  const m = 69 + 12 * Math.log2(hz / a4);
  const nearest = Math.floor(m + 0.5);
  const cents = 100 * (m - nearest);
  const name = NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
  return { note: name, midi: nearest, cents };
}
