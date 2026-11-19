#!/usr/bin/env python3
"""Round 2: analytic sinc fit, fine grid, dense-FFT peak."""
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


def _sinc(v):
    if abs(v) < 1e-12:
        return 1.0
    return math.sin(math.pi * v) / (math.pi * v)


def sinc_grid(xm1, x0, xp1, ngrid):
    best_d, best_e = 0.0, float("inf")
    for q in range(ngrid):
        d = -1.0 + 2.0 * q / (ngrid - 1)
        s0, sp, sm = _sinc(d), _sinc(1 - d), _sinc(1 + d)
        a = (xm1 * sm + x0 * s0 + xp1 * sp) / (sm * sm + s0 * s0 + sp * sp)
        e = (xm1 - a * sm) ** 2 + (x0 - a * s0) ** 2 + (xp1 - a * sp) ** 2
        if e < best_e:
            best_e, best_d = e, d
    return best_d


def sinc_analytic(xm1, x0, xp1):
    # Maximize LS scale amplitude a(d)=dot(r,s(d))/dot(s,s); equivalently
    # maximize dot(r,s)^2 / dot(s,s). Golden section on d in (-1,1).
    def amp2(d):
        s0, sp, sm = _sinc(d), _sinc(1 - d), _sinc(1 + d)
        dot = xm1 * sm + x0 * s0 + xp1 * sp
        ss = sm * sm + s0 * s0 + sp * sp
        return dot * dot / ss

    lo, hi = -1.0, 1.0
    gr = (math.sqrt(5) + 1) / 2
    for _ in range(80):
        m1 = hi - (hi - lo) / gr
        m2 = lo + (hi - lo) / gr
        if amp2(m1) > amp2(m2):
            hi = m2
        else:
            lo = m1
    return 0.5 * (lo + hi)


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

    nfft = 1
    while nfft < 2 * n - 1:
        nfft <<= 1
    curves = {}
    pair_meta = []
    for i in range(nch):
        for j in range(i + 1, nch):
            d = math.hypot(coords[j][0] - coords[i][0],
                           coords[j][1] - coords[i][1])
            ml = math.ceil(d * rate / c)
            r = gcc_curve(x[i], x[j], nfft)
            curves[(i, j)] = (r, ml)
            pair_meta.append((i, j, ml))

    def peak3(r, nfft, ml):
        L = ml
        lags = list(range(-L, L + 1))
        vals = [r[k if k >= 0 else nfft + k] for k in lags]
        k0 = max(range(len(vals)), key=lambda k: vals[k])
        return lags[k0], vals[k0 - 1], vals[k0], vals[k0 + 1]

    rows = {}
    for i, j, ml in pair_meta:
        r = curves[(i, j)][0]
        peak, xm, x0, xp = peak3(r, nfft, ml)
        target = ref[(i, j)]
        rows[(i, j)] = {"peak": peak, "target": target,
                        "grid2001": peak + sinc_grid(xm, x0, xp, 2001),
                        "grid20001": peak + sinc_grid(xm, x0, xp, 20001),
                        "analytic": peak + sinc_analytic(xm, x0, xp)}

    # Dense FFT peak at several oversampling factors
    for factor in (4, 16):
        nfft2 = nfft * factor
        for i, j, ml in pair_meta:
            r = gcc_curve(x[i], x[j], nfft2)
            L = ml * factor
            lags_f = [k / factor for k in range(-L, L + 1)]
            vals = [r[k if k >= 0 else nfft2 + k] for k in range(-L, L + 1)]
            k0 = max(range(len(vals)), key=lambda k: vals[k])
            rows[(i, j)]["fft%d" % factor] = lags_f[k0]

    names = ["grid2001", "grid2001", "grid20001", "analytic", "fft4", "fft16"]
    seen = set()
    for nm in names:
        if nm in seen:
            continue
        seen.add(nm)
        errs = [rows[p][nm] - rows[p]["target"] for p in rows]
        print("%-10s max_abs=%.6f rms=%.6f %s"
              % (nm, max(abs(e) for e in errs),
                 math.sqrt(sum(e * e for e in errs) / len(errs)),
                 " ".join("%+.5f" % e for e in errs)))


if __name__ == "__main__":
    main()
