#!/usr/bin/env python3
"""Probe FFT-size / refinement variants against reference pair lags."""
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


def next_pow2(x):
    p = 1
    while p < x:
        p <<= 1
    return p


def gcc(xi, xj, max_lag, nfft, interp):
    n = len(xi)
    ra, ia = [0.0] * nfft, [0.0] * nfft
    rb, ib = [0.0] * nfft, [0.0] * nfft
    for k in range(n):
        ra[k], rb[k] = xi[k], xj[k]
    fft(ra, ia)
    fft(rb, ib)
    cr, ci = [0.0] * nfft, [0.0] * nfft
    for k in range(nfft):
        ar = ra[k] * rb[k] + ia[k] * ib[k]
        ai = ra[k] * ib[k] - ia[k] * rb[k]
        norm = max(math.hypot(ar, ai), 1e-12)
        cr[k], ci[k] = ar / norm, ai / norm
    r = ifft_real(cr, ci)
    L = max_lag
    lags = list(range(-L, L + 1))
    vals = [r[k if k >= 0 else nfft + k] for k in lags]
    k0 = max(range(len(vals)), key=lambda k: vals[k])
    peak = lags[k0]
    if interp == "parab":
        delta = 0.0
        if 0 < k0 < len(vals) - 1:
            x0, x1, x2 = vals[k0 - 1], vals[k0], vals[k0 + 1]
            den = x0 - 2 * x1 + x2
            if den != 0:
                delta = 0.5 * (x0 - x2) / den
    elif interp == "none":
        delta = 0.0
    elif interp == "parab5":
        # least-squares parabola on 5 points, offset measured in sample units
        if k0 < 2 or k0 > len(vals) - 3:
            x0, x1, x2 = vals[k0 - 1], vals[k0], vals[k0 + 1]
            den = x0 - 2 * x1 + x2
            return peak + (0.5 * (x0 - x2) / den if den != 0 else 0.0)
        xs = [-2, -1, 0, 1, 2]
        ys = vals[k0 - 2:k0 + 3]
        sx = sum(xs)
        sx2 = sum(t * t for t in xs)
        sx3 = sum(t ** 3 for t in xs)
        sx4 = sum(t ** 4 for t in xs)
        sy = sum(ys)
        sxy = sum(xs[t] * ys[t] for t in range(5))
        sx2y = sum(xs[t] * xs[t] * ys[t] for t in range(5))
        # normal equations for y = a + b x + c x^2
        m = [[5, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]]
        rhs = [sy, sxy, sx2y]
        # 3x3 solve (symmetric small system, Cramer)
        def det3(a):
            return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
                    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
        d0 = det3(m)
        mb = [rhs[:], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]]
        mc = [[m[0][0], m[0][1], rhs[0]],
              [m[1][0], m[1][1], rhs[1]],
              [m[2][0], m[2][1], rhs[2]]]
        b = det3(mb) / d0
        c = det3(mc) / d0
        delta = -b / (2 * c) if c != 0 else 0.0
        if not (-2 <= delta <= 2):
            delta = 0.0
    elif interp == "cosine":
        if 0 < k0 < len(vals) - 1:
            x0, x1, x2 = vals[k0 - 1], vals[k0], vals[k0 + 1]
            denom = x0 - 2 * x1 + x2
            if denom != 0:
                delta = (x0 - x2) / (2 * denom)
        else:
            delta = 0.0
    elif interp == "gauss":
        if 0 < k0 < len(vals) - 1:
            x0, x1, x2 = max(vals[k0 - 1], 1e-12), max(vals[k0], 1e-12), \
                max(vals[k0 + 1], 1e-12)
            a_, b_, c_ = math.log(x0), math.log(x1), math.log(x2)
            den = a_ - 2 * b_ + c_
            delta = 0.5 * (a_ - c_) / den if den != 0 else 0.0
        else:
            delta = 0.0
    return peak + delta


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
    sizes = {"n->pow2": next_pow2(n), "2n-1->pow2": next_pow2(2 * n - 1),
             "4n->pow2": next_pow2(4 * n), "8n->pow2": next_pow2(8 * n)}
    print("%-12s %-7s max_err  per-pair" % ("nfft", "interp"))
    for sname, nfft in sizes.items():
        for ip in ("parab", "none", "parab5"):
            errs = []
            for i in range(nch):
                for j in range(i + 1, nch):
                    d = math.hypot(coords[j][0] - coords[i][0],
                                   coords[j][1] - coords[i][1])
                    ml = math.ceil(d * rate / c)
                    got = gcc(x[i], x[j], ml, nfft, ip)
                    errs.append(got - ref[(i, j)])
            print("%-12s %-7s %.5f  %s"
                  % (sname, ip, max(abs(e) for e in errs),
                     " ".join("%+.4f" % e for e in errs)))


if __name__ == "__main__":
    main()
