#!/usr/bin/env python3
"""Find which pipeline detail reproduces the reference pair-lag file."""
import json
import math
import struct
import sys
import wave

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk/tools")
from ref_gcc_pure import fft, read_wav  # noqa: E402

BASE = "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk"


def ifft_real(re, im):
    n = len(re)
    rre = re[:]
    iim = [-v for v in im]
    fft(rre, iim)
    return [v / n for v in rre]


def gcc(xi, xj, max_lag, nfft_mode, win_mode, interp_mode):
    n = len(xi)
    if nfft_mode == "pow2_2n-1":
        nfft = 1
        while nfft < 2 * n - 1:
            nfft <<= 1
    elif nfft_mode == "2n":
        nfft = 2 * n
    elif nfft_mode == "pow2_2n":
        nfft = 1
        while nfft < 2 * n:
            nfft <<= 1
    if win_mode == "sym":
        win = [0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1)) for k in range(n)]
    else:  # periodic
        win = [0.5 - 0.5 * math.cos(2 * math.pi * k / n) for k in range(n)]
    a = [xi[k] * win[k] for k in range(n)]
    b = [xj[k] * win[k] for k in range(n)]
    ra, ia = [0.0] * nfft, [0.0] * nfft
    rb, ib = [0.0] * nfft, [0.0] * nfft
    for k in range(n):
        ra[k], rb[k] = a[k], b[k]
    fft(ra, ia)
    fft(rb, ib)
    cr, ci = [0.0] * nfft, [0.0] * nfft
    for k in range(nfft):
        ar = ra[k] * rb[k] + ia[k] * ib[k]
        ai = ra[k] * ib[k] - ia[k] * rb[k]
        mag = math.hypot(ar, ai)
        norm = max(mag, 1e-12)
        cr[k], ci[k] = ar / norm, ai / norm
    r = ifft_real(cr, ci)
    L = max_lag
    lags = list(range(-L, L + 1))
    vals = [r[k if k >= 0 else nfft + k] for k in lags]
    k0 = max(range(len(vals)), key=lambda k: vals[k])
    peak = lags[k0]
    if interp_mode == "parab":
        delta = 0.0
        if 0 < k0 < len(vals) - 1:
            x0, x1, x2 = vals[k0 - 1], vals[k0], vals[k0 + 1]
            den = x0 - 2 * x1 + x2
            if den != 0:
                delta = 0.5 * (x0 - x2) / den
    else:  # none
        delta = 0.0
    return peak + delta


def main():
    frames, rate, nch, _ = read_wav(BASE + "/sample-data/scene37.wav")
    geo = json.load(open(BASE + "/sample-data/scene37.json"))
    ref = {(d["i"], d["j"]): d["lag_samples"]
           for d in json.load(open(BASE + "/sample-data/scene37-pair-lags.json"))}
    coords, c = geo["coordinates_m"], geo["speed_m_s"]
    n = len(frames)
    means = [sum(frames[t][ch] for t in range(n)) / n for ch in range(nch)]
    dc = [[frames[t][ch] - means[ch] for t in range(n)] for ch in range(nch)]
    variants = []
    for nf in ("pow2_2n-1", "2n", "pow2_2n"):
        for wm in ("sym", "per"):
            for ip in ("parab", "none"):
                variants.append((nf, wm, ip))
    print("%-12s %-4s %-6s  max_abs_err  per-pair err" % ("nfft", "win", "interp"))
    for nf, wm, ip in variants:
        errs = []
        for i in range(nch):
            for j in range(i + 1, nch):
                d = math.hypot(coords[j][0] - coords[i][0],
                               coords[j][1] - coords[i][1])
                ml = math.ceil(d * rate / c)
                got = gcc(dc[i], dc[j], ml, nf, wm, ip)
                errs.append(got - ref[(i, j)])
        worst = max(abs(e) for e in errs)
        print("%-12s %-4s %-6s  %.5f      %s"
              % (nf, wm, ip, worst,
                 " ".join("%+.4f" % e for e in errs)))


if __name__ == "__main__":
    main()
