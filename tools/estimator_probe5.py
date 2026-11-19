#!/usr/bin/env python3
"""Round 5: frequency-domain delay estimators (phase slope, weighted)."""
import json
import math
import sys

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk/tools")
from ref_gcc_pure import fft, read_wav  # noqa: E402

BASE = "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk"


def main():
    frames, rate, nch, _ = read_wav(BASE + "/sample-data/scene37.wav")
    geo = json.load(open(BASE + "/sample-data/scene37.json"))
    ref = {(d["i"], d["j"]): d["lag_samples"]
           for d in json.load(open(BASE + "/sample-data/scene37-pair-lags.json"))}
    coords, c = geo["coordinates_m"], geo["speed_m_s"]
    n = len(frames)
    nfft = 1
    while nfft < 2 * n - 1:
        nfft <<= 1
    win = [0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1)) for k in range(n)]
    means = [sum(frames[t][ch] for t in range(n)) / n for ch in range(nch)]
    specs = []
    powers = []
    for ch in range(nch):
        re = [(frames[t][ch] - means[ch]) * win[t] for t in range(n)]
        re += [0.0] * (nfft - n)
        im = [0.0] * nfft
        fft(re, im)
        specs.append((re, im))
        powers.append([re[k] ** 2 + im[k] ** 2 for k in range(nfft)])

    # inspect spectrum content first
    pwr = [sum(p[k] for p in powers) / nch for k in range(nfft // 2)]
    total = sum(pwr)
    cum = 0.0
    lo = hi = 0
    for k, p in enumerate(pwr):
        cum += p
        if lo == 0 and cum > 0.02 * total:
            lo = k
        if cum < 0.98 * total:
            hi = k
    print("energy 2%%-98%% bins: %d..%d  (%.0f..%.0f Hz)"
          % (lo, hi, lo * rate / nfft, hi * rate / nfft))

    methods = {}
    for i in range(nch):
        for j in range(i + 1, nch):
            ri, ii = specs[i]
            rj, ij = specs[j]
            # weighted phase slope: arg(conj( Xi ) Xj) vs omega, weight = mag
            rows = []
            for k in range(1, nfft // 2):
                ar = ri[k] * rj[k] + ii[k] * ij[k]
                ai = ri[k] * ij[k] - ii[k] * rj[k]
                mag = math.hypot(ar, ai)
                if mag <= 0:
                    continue
                ph = math.atan2(ai, ar)
                w = mag  # magnitude weight
                rows.append((k, ph, w))
            # 1) all-band weighted LS on unwrapped phase
            ph0 = rows[0][1]
            unw = []
            last = ph0
            for k, ph, w in rows:
                while ph - last > math.pi:
                    ph -= 2 * math.pi
                while ph - last < -math.pi:
                    ph += 2 * math.pi
                last = ph
                unw.append((k, ph, w))
            Sw = sum(w for _, _, w in unw)
            Sk = sum(k * w for k, _, w in unw)
            Sy = sum(ph * w for _, ph, w in unw)
            Skk = sum(k * k * w for k, _, w in unw)
            Sky = sum(k * ph * w for k, ph, w in unw)
            slope = (Sw * Sky - Sk * Sy) / (Sw * Skk - Sk * Sk)
            tau_phase = -slope * nfft / (2 * math.pi)  # samples
            methods.setdefault("phase_all", []).append(tau_phase - ref[(i, j)])

            # 2) energy-band only
            band = [t for t in unw if lo <= t[0] <= hi]
            Sw = sum(w for _, _, w in band)
            Sk = sum(k * w for k, _, w in band)
            Sy = sum(ph * w for _, ph, w in band)
            Skk = sum(k * k * w for k, _, w in band)
            Sky = sum(k * ph * w for k, ph, w in band)
            slope = (Sw * Sky - Sk * Sy) / (Sw * Skk - Sk * Sk)
            methods.setdefault("phase_band", []).append(
                -slope * nfft / (2 * math.pi) - ref[(i, j)])

            # 3) GCC-PHAT but delay from phase slope of whitened cross spec
            rows2 = []
            for k in range(1, nfft // 2):
                ar = ri[k] * rj[k] + ii[k] * ij[k]
                ai = ri[k] * ij[k] - ii[k] * rj[k]
                mag = math.hypot(ar, ai)
                if mag <= 1e-12:
                    continue
                ph = math.atan2(ai, ar)
                rows2.append((k, ph, 1.0))
            last = rows2[0][1]
            unw2 = []
            for k, ph, w in rows2:
                while ph - last > math.pi:
                    ph -= 2 * math.pi
                while ph - last < -math.pi:
                    ph += 2 * math.pi
                last = ph
                unw2.append((k, ph, w))
            Sw = len(unw2)
            Sk = sum(k for k, _, _ in unw2)
            Sy = sum(ph for _, ph, _ in unw2)
            Skk = sum(k * k for k, _, _ in unw2)
            Sky = sum(k * ph for k, ph, _ in unw2)
            slope = (Sw * Sky - Sk * Sy) / (Sw * Skk - Sk * Sk)
            methods.setdefault("phat_slope", []).append(
                -slope * nfft / (2 * math.pi) - ref[(i, j)])

    for name, errs in methods.items():
        print("%-12s max_abs=%.6f rms=%.6f %s"
              % (name, max(abs(e) for e in errs),
                 math.sqrt(sum(e * e for e in errs) / len(errs)),
                 " ".join("%+.5f" % e for e in errs)))


if __name__ == "__main__":
    main()
