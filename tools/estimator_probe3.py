#!/usr/bin/env python3
"""Round 3: local dense-FFT peak around integer maximum."""
import json
import math
import sys

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk/tools")
from ref_gcc_pure import fft, read_wav  # noqa: E402

BASE = "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk"


def ifft_real(re, im):
    n = len(re)
    rre, iim = re[:], [-v for v in im]
    fft(rre, iim)
    return [v / n for v in rre]


def gcc_curve(xi, xj, nfft):
    n = len(xi)
    ra, ia, rb, ib = [0.0] * nfft, [0.0] * nfft, [0.0] * nfft, [0.0] * nfft
    ra[:n], rb[:n] = xi, xj
    fft(ra, ia)
    fft(rb, ib)
    cr, ci = [0.0] * nfft, [0.0] * nfft
    for k in range(nfft):
        ar = ra[k] * rb[k] + ia[k] * ib[k]
        ai = ra[k] * ib[k] - ia[k] * rb[k]
        norm = max(math.hypot(ar, ai), 1e-12)
        cr[k], ci[k] = ar / norm, ai / norm
    return ifft_real(cr, ci)


def main():
    frames, rate, nch, _ = read_wav(BASE + "/sample-data/scene37.wav")
    geo = json.load(open(BASE + "/sample-data/scene37.json"))
    ref = {(d["i"], d["j"]): d["lag_samples"]
           for d in json.load(open(BASE + "/sample-data/scene37-pair-lags.json"))}
    coords, c = geo["coordinates_m"], geo["speed_m_s"]
    n = len(frames)
    win = [0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1)) for k in range(n)]
    means = [sum(frames[t][ch] for t in range(n)) / n for ch in range(nch)]
    x = [[(frames[t][ch] - means[ch]) * win[t] for t in range(n)]
         for ch in range(nch)]
    nfft0 = 1
    while nfft0 < 2 * n - 1:
        nfft0 <<= 1

    # integer peaks from base FFT
    base_peaks = {}
    for i in range(nch):
        for j in range(i + 1, nch):
            r = gcc_curve(x[i], x[j], nfft0)
            d = math.hypot(coords[j][0] - coords[i][0],
                           coords[j][1] - coords[i][1])
            ml = math.ceil(d * rate / c)
            lags = list(range(-ml, ml + 1))
            vals = [r[k if k >= 0 else nfft0 + k] for k in lags]
            k0 = max(range(len(vals)), key=lambda k: vals[k])
            base_peaks[(i, j)] = lags[k0]

    for factor in (2, 4, 8, 16):
        nfft = nfft0 * factor
        errs = []
        for i in range(nch):
            for j in range(i + 1, nch):
                r = gcc_curve(x[i], x[j], nfft)
                ip = base_peaks[(i, j)]
                # search only within +/-2 base samples of the integer peak
                lo = (ip - 2) * factor
                hi = (ip + 2) * factor
                best_k, best_v = lo, r[lo if lo >= 0 else nfft + lo]
                for k in range(lo, hi + 1):
                    v = r[k if k >= 0 else nfft + k]
                    if v > best_v:
                        best_v, best_k = v, k
                got = best_k / factor
                errs.append(got - ref[(i, j)])
        print("localfft x%-2d max_abs=%.6f rms=%.6f %s"
              % (factor, max(abs(e) for e in errs),
                 math.sqrt(sum(e * e for e in errs) / len(errs)),
                 " ".join("%+.5f" % e for e in errs)))

    # also: parabolic refinement AFTER local fft x16
    factor = 16
    nfft = nfft0 * factor
    errs = []
    for i in range(nch):
        for j in range(i + 1, nch):
            r = gcc_curve(x[i], x[j], nfft)
            ip = base_peaks[(i, j)]
            lo = (ip - 2) * factor
            hi = (ip + 2) * factor
            best_k, best_v = lo, r[lo if lo >= 0 else nfft + lo]
            for k in range(lo, hi + 1):
                v = r[k if k >= 0 else nfft + k]
                if v > best_v:
                    best_v, best_k = v, k
            vm = r[best_k - 1 if best_k - 1 >= 0 else nfft + best_k - 1]
            v0 = r[best_k if best_k >= 0 else nfft + best_k]
            vp = r[best_k + 1 if best_k + 1 >= 0 else nfft + best_k + 1]
            den = vm - 2 * v0 + vp
            delta = (0.5 * (vm - vp) / den) / factor if den != 0 else 0.0
            got = best_k / factor + delta
            errs.append(got - ref[(i, j)])
    print("fft16+parab  max_abs=%.6f rms=%.6f %s"
          % (max(abs(e) for e in errs),
             math.sqrt(sum(e * e for e in errs) / len(errs)),
             " ".join("%+.5f" % e for e in errs)))


if __name__ == "__main__":
    main()
