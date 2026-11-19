#!/usr/bin/env python3
"""Diagnose GCC curves at several FFT sizes around pair 0-1's peak."""
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


frames, rate, nch, _ = read_wav(BASE + "/sample-data/scene37.wav")
geo = json.load(open(BASE + "/sample-data/scene37.json"))
coords, c = geo["coordinates_m"], geo["speed_m_s"]
n = len(frames)
win = [0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1)) for k in range(n)]
means = [sum(frames[t][ch] for t in range(n)) / n for ch in range(nch)]
x = [[(frames[t][ch] - means[ch]) * win[t] for t in range(n)]
     for ch in range(nch)]

for pair in ((0, 1), (0, 4)):
    i, j = pair
    print("=== pair %d-%d, reference lag=%.5f ===" % (i, j, {
        (d["i"], d["j"]): d["lag_samples"]
        for d in json.load(open(BASE + "/sample-data/scene37-pair-lags.json"))
    }[(i, j)]))
    nfft0 = 1
    while nfft0 < 2 * n - 1:
        nfft0 <<= 1
    r0 = gcc_curve(x[i], x[j], nfft0)
    print("NFFT=%d (base):" % nfft0)
    for k in range(-16, 18):
        idx = k if k >= 0 else nfft0 + k
        print("  lag=%+3d  R=%.5f" % (k, r0[idx]))
    nfft = nfft0 * 4
    r4 = gcc_curve(x[i], x[j], nfft)
    print("NFFT=%d (x4), values near -13..-14 base samples:" % nfft)
    for q in range(-15 * 4, -11 * 4 + 1):
        idx = q if q >= 0 else nfft + q
        print("  lag=%+.3f  R=%.5f" % (q / 4, r4[idx]))
