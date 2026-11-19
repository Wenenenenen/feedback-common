// Difference function + cumulative mean normalized difference (YIN-style),
// candidate analysis, and per-frame pitch/voicing decisions.
//
// Conventions (per the task spec):
//   d(tau)   = sum_j (x[j] - x[j+tau])^2, fixed comparison length W, zero pad
//   d'(0)    = 1
//   d'(tau)  = tau * d(tau) / sum_{k=1..tau} d(k)
//   when the denominator is 0 the candidate does not represent voicing
// Frames are centered on center frames 0, H, 2H, ... (H = rate/100 -> 10 ms),
// window length round(rate*window_ms/1000), zero-padded past file edges.

import { autocorrelation, magnitudeSpectrum } from "./fft.js";

export const HOP_MS = 10;

// Difference function for tau = 0..maxLag with fixed comparison length W.
// d(tau) = r0 + r0' - 2 r(tau); with fixed W the two energy terms are each
// computed over exactly W samples.
export function differenceFunction(seg, maxLag, W) {
  const n = seg.length;
  if (W + maxLag > n) throw new Error("window too short for requested lag range");
  const ac = autocorrelation(seg, maxLag);
  const d = new Float64Array(maxLag + 1);
  // energies over the two W-length windows
  let eA = 0, eB = 0;
  for (let j = 0; j < W; j++) {
    eA += seg[j] * seg[j];
    eB += seg[j + maxLag] * seg[j + maxLag];
  }
  d[0] = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    // r(tau) over j = 0..W-1: full autocorrelation includes j up to n-1-tau;
    // subtract the tail j = W .. n-1-tau
    let tail = 0;
    for (let j = W; j <= n - 1 - tau; j++) tail += seg[j] * seg[j + tau];
    d[tau] = eA + eB - 2 * (ac[tau] - tail);
    if (d[tau] < 0) d[tau] = 0; // numerical floor
  }
  return d;
}

// Cumulative mean normalized difference. Frames whose running energy is zero
// are marked non-voiced via `valid`.
export function cumulativeMeanNormalized(d) {
  const maxLag = d.length - 1;
  const dp = new Float64Array(maxLag + 1);
  const valid = new Uint8Array(maxLag + 1);
  dp[0] = 1;
  let cum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    cum += d[tau];
    if (cum > 0) {
      dp[tau] = Math.max(0, (tau * d[tau]) / cum);
      valid[tau] = 1;
    } else {
      dp[tau] = 1; // denominator 0: candidate cannot represent voicing
      valid[tau] = 0;
    }
  }
  return { dp, valid };
}

// Parabolic interpolation around a discrete minimum -> fractional lag.
function refineLag(dp, tau) {
  const a = dp[tau - 1], b = dp[tau], c = dp[tau + 1];
  const denom = a - 2 * b + c;
  if (denom <= 0) return { lag: tau, value: b };
  const shift = 0.5 * (a - c) / denom;
  if (!Number.isFinite(shift) || Math.abs(shift) > 1) return { lag: tau, value: b };
  const value = b - 0.25 * (a - c) * shift;
  return { lag: tau + shift, value };
}

// Local minima of d' within [lagLo, lagHi], strongest first.
export function findCandidates(dp, valid, lagLo, lagHi, maxCandidates = 6) {
  const cands = [];
  for (let tau = Math.max(2, lagLo); tau <= Math.min(lagHi, dp.length - 2); tau++) {
    if (!valid[tau]) continue;
    if (dp[tau] <= dp[tau - 1] && dp[tau] <= dp[tau + 1]) {
      const r = refineLag(dp, tau);
      cands.push({ lag: r.lag, periodScore: r.value, tau });
    }
  }
  cands.sort((a, b) => a.periodScore - b.periodScore);
  return cands.slice(0, maxCandidates);
}

// Energy in a +/- frac band around frequency f from a magnitude spectrum.
function bandEnergy(freqs, mag, f, frac) {
  const lo = f * (1 - frac), hi = f * (1 + frac);
  let e = 0;
  for (let k = 0; k < mag.length; k++) {
    if (freqs[k] >= lo && freqs[k] <= hi) e += mag[k] * mag[k];
  }
  return e;
}

// Octave / subharmonic correction using spectral harmonic evidence.
// YIN's deepest d' dip can land at a subharmonic (tau doubled, f0 halved) when
// the fundamental is weak or missing. For each candidate we measure spectral
// energy at f0, 2f0 and 3f0; a lower-frequency candidate whose own band has no
// real energy while a near-octave higher candidate shows strong harmonics is a
// spurious subharmonic, not the fundamental.
export function spectralOctaveCheck(candidates, seg, sampleRate, range) {
  if (candidates.length === 0) return { chosen: null, scored: [], shadowed: [] };
  const { freqs, mag } = magnitudeSpectrum(seg, sampleRate);
  const scored = candidates.map((c) => {
    const hz = sampleRate / c.lag;
    return { ...c, hz, ...harmonicEvidence(freqs, mag, hz) };
  });
  const inRange = scored.filter((c) => c.hz >= range.fMin && c.hz <= range.fMax);
  const pool = (inRange.length ? inRange : scored).sort((a, b) => a.lag - b.lag);

  // Reference level: strongest spectral component among the candidates'
  // fundamental bands and low harmonics. Using an overall spectral reference
  // (not the max fundamental alone) keeps missing-fundamental frames working:
  // there the true f0 band is inherently empty.
  const eRef = Math.max(
    1e-12,
    ...pool.flatMap((c) => [c.e0, c.e2, c.e3])
  );
  const shadowed = new Set(); // holds candidate objects (lag identity)
  for (let i = 0; i < pool.length; i++) {
    const hi = pool[i];
    if (hi.periodScore > 0.5) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const lo = pool[j];
      const ratio = lo.lag / hi.lag;
      // integer subharmonic relation: lo sits n octaves/12ths below hi.
      // n=2 uses a deliberately wide 1.8..2.3 window because parabolic
      // interpolation and inharmonicity move discrete dips off the exact 2x
      // ratio; f0-only-3rd-harmonic ghosts (no intermediate dip) use n=3.
      let harmonic = 0;
      if (ratio >= 1.8 && ratio <= 2.3) harmonic = 2;
      else if (ratio >= 2.7 && ratio <= 3.3) harmonic = 3;
      else for (let n = 4; n <= 5; n++) {
        if (ratio >= n * 0.9 && ratio <= n * 1.1) { harmonic = n; break; }
      }
      if (!harmonic) continue;
      // The lower pitch is real when its own fundamental band carries a
      // meaningful share of the dominant spectral energy.
      const lowerHasFundamental = lo.e0 > 0.02 * eRef;
      if (lowerHasFundamental) continue;
      // Coincidence guard: when the higher candidate has a strong fundamental
      // comparable in level to its own harmonics (a normal tone), it cannot be
      // a mere harmonic of the lower candidate. A genuinely missing fundamental
      // is dwarfed by its own 2nd/3rd harmonic and so bypasses this guard.
      // The reference is the higher candidate's *2nd* harmonic specifically:
      // a 3rd-harmonic-only tone has no 2nd-harmonic energy either.
      const higherHasStrongFundamental = hi.e0 > 0.2 * Math.max(hi.e2, 1e-12);
      if (higherHasStrongFundamental) continue;
      // lo's empty fundamental band must be explained by a matching strong
      // harmonic of the higher pitch (2nd for an octave ghost, 3rd for a
      // 12th ghost, either for the widened window).
      const evidence = harmonic === 3 ? hi.e3 : Math.max(hi.e2, hi.e3);
      const explained = evidence > 200 * Math.max(lo.e0, 1e-12) && evidence > 0.05 * eRef;
      if (explained) shadowed.add(lo);
    }
  }
  const viable = pool.filter((c) => !shadowed.has(c));
  viable.sort((a, b) => a.periodScore - b.periodScore);
  return { chosen: viable[0] || pool[0], scored, shadowed: [...shadowed] };
}

function harmonicEvidence(freqs, mag, f0) {
  return {
    e0: bandEnergy(freqs, mag, f0, 0.03),
    e2: bandEnergy(freqs, mag, 2 * f0, 0.03),
    e3: bandEnergy(freqs, mag, 3 * f0, 0.03),
  };
}

export function rmsLevel(seg) {
  let s = 0;
  for (let i = 0; i < seg.length; i++) s += seg[i] * seg[i];
  return Math.sqrt(s / seg.length);
}

// Spectral flatness (Wiener entropy): 0 = tonal, near 1 = noise-like.
export function spectralFlatness(seg, sampleRate) {
  const { mag } = magnitudeSpectrum(seg, sampleRate);
  let logSum = 0, sum = 0, k = 0;
  const floor = 1e-12;
  for (let i = 1; i < mag.length; i++) {
    const v = Math.max(mag[i], floor);
    logSum += Math.log(v);
    sum += v;
    k++;
  }
  if (k === 0 || sum <= 0) return 1;
  const geo = Math.exp(logSum / k);
  return geo / (sum / k);
}

// Zero-crossing rate.
export function zeroCrossingRate(seg) {
  let z = 0;
  for (let i = 1; i < seg.length; i++) {
    if ((seg[i - 1] >= 0) !== (seg[i] >= 0)) z++;
  }
  return z / (seg.length - 1);
}

// Analyze one window. Returns raw candidates plus acoustic measures; the
// temporal stage makes the final voiced/pitch decision.
export function analyzeFrame(seg, sampleRate, params) {
  const { windowMs, fMin, fMax, yinThreshold } = params;
  const maxLag = Math.floor(sampleRate / fMin);
  const W = seg.length - maxLag; // fixed comparison length
  const d = differenceFunction(seg, maxLag, W);
  const { dp, valid } = cumulativeMeanNormalized(d);
  const lagLo = Math.max(2, Math.floor(sampleRate / fMax) - 2);
  const lagHi = Math.min(maxLag, Math.ceil(sampleRate / fMin) + 1);
  const candidates = findCandidates(dp, valid, lagLo, lagHi, 8);
  const { chosen, scored, shadowed } = spectralOctaveCheck(candidates, seg, sampleRate, { fMin, fMax });

  const rms = rmsLevel(seg);
  const sfm = spectralFlatness(seg, sampleRate);
  const zcr = zeroCrossingRate(seg);

  // YIN threshold rule: first dip under threshold scanning short lags first,
  // but skip candidates shadowed as subharmonics by the spectral octave check.
  const shadowedLags = new Set(shadowed.map((c) => c.lag));
  let thresholdPick = null;
  const sorted = [...scored].sort((a, b) => a.lag - b.lag);
  for (const c of sorted) {
    if (c.hz < fMin || c.hz > fMax) continue;
    if (shadowedLags.has(c.lag)) continue;
    if (c.periodScore <= yinThreshold) {
      thresholdPick = c;
      break;
    }
  }
  const primary = thresholdPick || chosen || null;

  return {
    rms,
    sfm,
    zcr,
    candidates: scored.map((c) => ({
      hz: c.hz,
      lag: c.lag,
      periodScore: c.periodScore,
      shadowed: shadowedLags.has(c.lag),
      e0: c.e0,
      e2: c.e2,
      e3: c.e3,
    })),
    primary: primary
      ? { hz: primary.hz, lag: primary.lag, periodScore: primary.periodScore }
      : null,
    dp, // full d' curve for the hover inspector
    lagLo,
    lagHi,
  };
}
