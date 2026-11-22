// Clock unwrapping for PCR (42-bit, 27 MHz) and PTS/DTS (33-bit, 90 kHz).
//
// Unwrapping keeps BOTH the raw modular value and a monotonically-extended
// "unwrapped" value.  A jump that wraps forward through the modulus boundary
// is distinguished from a small backward step (PTS regression) and from an
// explicit discontinuity (handled by the caller via segment boundaries).

export const PCR_MOD = 2 ** 33 * 300; // 27 MHz units, ~25.77 h wrap period
export const PTS_MOD = 2 ** 33; // 90 kHz units, ~26.5 h wrap period

// A forward jump larger than this fraction of the modulus cannot plausibly be
// real clock progress in a capture window; smaller backward moves are regressions.
const WRAP_THRESHOLD_RATIO = 0.5;

export class ClockUnwrapper {
  // mod: modulus; threshold: absolute delta above which a jump is treated as a wrap
  constructor(mod, threshold = mod * WRAP_THRESHOLD_RATIO) {
    this.mod = BigInt(mod);
    this.threshold = BigInt(Math.floor(threshold));
    this.high = 0n; // accumulated multiple of mod
    this.lastRaw = null;
  }

  reset() {
    this.high = 0n;
    this.lastRaw = null;
  }

  // raw: bigint in [0, mod). Returns { raw, unwrapped, delta, kind }
  //   kind: 'first' | 'normal' | 'wrap' | 'regression'
  //   delta is signed bigint in raw units relative to the previous raw value
  //   (pre-unwrap), so a wrap shows a large negative raw delta but the unwrapped
  //   value keeps rising.
  push(rawInput) {
    const raw = BigInt(rawInput);
    if (this.lastRaw === null) {
      this.lastRaw = raw;
      return { raw, unwrapped: raw, delta: 0n, kind: "first" };
    }
    const prev = this.lastRaw;
    let delta = raw - prev;
    let kind = "normal";

    if (delta < -this.threshold) {
      // e.g. 0x1_FFFF_FFF0 -> 0x0000_0010: crossed the modulus boundary forward
      this.high += 1n;
      kind = "wrap";
    } else if (delta < 0n) {
      // small backward step without wrapping: genuine clock regression
      kind = "regression";
    } else if (delta > this.threshold) {
      // enormous forward jump without explicit discontinuity — treat as
      // regression-style anomaly rather than silently accumulating a wrap
      kind = "jump";
    }
    this.lastRaw = raw;
    return { raw, unwrapped: this.high * this.mod + raw, delta, kind };
  }
}

// Convert a 33-bit 90 kHz PTS to seconds (number; safe for realistic spans).
export function ptsToSeconds(pts) {
  return Number(pts) / 90000;
}

// Convert a 42-bit 27 MHz PCR to seconds.
export function pcrToSeconds(pcr27) {
  return Number(pcr27) / 27000000;
}

// Human-readable clock value with raw modular value and unwrapped seconds.
export function formatClock(value, mod, hz) {
  const v = BigInt(value);
  const m = BigInt(mod);
  const wraps = v / m;
  const raw = v % m;
  return {
    raw: raw.toString(),
    wraps: Number(wraps),
    seconds: Number(v) / hz,
  };
}
