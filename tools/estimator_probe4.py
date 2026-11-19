#!/usr/bin/env python3
"""Round 4: windowed estimators (3/5/7/9 points) x parab/sinc/centroid."""
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


def fit_sinc(vals, half):
    # R(k-d) ~ a*sinc(k-d), k in [-half, half]; golden search on d
    ks = list(range(-half, half + 1))

    def amp2(d):
        num = den = 0.0
        for k in ks:
            s = _sinc(k - d)
            num += vals[k + half] * s
            den += s * s
        return num * num / den if den > 0 else 0.0

    lo, hi = -1.0, 1.0
    gr = (math.sqrt(5) + 1) / 2
    for _ in range(60):
        m1 = hi - (hi - lo) / gr
        m2 = lo + (hi - lo) / gr
        if amp2(m1) > amp2(m2):
            hi = m2
        else:
            lo = m1
    return 0.5 * (lo + hi)


def fit_parab_ls(vals, half):
    # LS quadratic on window, vertex offset in sample units
    ks = list(range(-half, half + 1))
    S1 = sum(ks)
    S2 = sum(k * k for k in ks)
    S3 = sum(k ** 3 for k in ks)
    S4 = sum(k ** 4 for k in ks)
    Sy = sum(vals)
    Sxy = sum(ks[t] * vals[t] for t in range(len(ks)))
    Sx2y = sum(ks[t] * ks[t] * vals[t] for t in range(len(ks)))
    M = [[len(ks), S1, S2], [S1, S2, S3], [S2, S3, S4]]

    def det3(a):
        return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
                - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))

    D = det3(M)
    Mb = [[Sy, M[0][1], M[0][2]], [Sxy, M[1][1], M[1][2]],
          [Sx2y, M[2][1], M[2][2]]]
    Mc = [[M[0][0], M[0][1], Sy], [M[1][0], M[1][1], Sxy],
          [M[2][0], M[2][1], Sx2y]]
    b = det3(Mb) / D
    cq = det3(Mc) / D
    d = -b / (2 * cq) if cq != 0 else 0.0
    return d if -1 <= d <= 1 else 0.0


def centroid(vals, half):
    ks = list(range(-half, half + 1))
    # use values shifted positive (peak centered windows can go negative)
    vmin = min(vals)
    w = [v - vmin for v in vals]
    s = sum(w)
    return sum(ks[t] * w[t] for t in range(len(ks))) / s if s > 0 else 0.0


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
    x = [[(frames[t][ch] - means[ch]) * win[t] for t in range(n)]
         for ch in range(nch)]
    peaks = {}
    curves = {}
    for i in range(nch):
        for j in range(i + 1, nch):
            r = gcc_curve(x[i], x[j], nfft)
            d = math.hypot(coords[j][0] - coords[i][0],
                           coords[j][1] - coords[i][1])
            ml = math.ceil(d * rate / c)
            lags = list(range(-ml, ml + 1))
            vals = [r[k if k >= 0 else nfft + k] for k in lags]
            k0 = max(range(len(vals)), key=lambda k: vals[k])
            peaks[(i, j)] = lags[k0]
            # full curve indexed by integer lag
            curves[(i, j)] = {lag: r[lag if lag >= 0 else nfft + lag]
                              for lag in lags}
    for half in (1, 2, 3, 4):
        for kind in ("parab", "sinc", "centroid"):
            errs = []
            for i in range(nch):
                for j in range(i + 1, nch):
                    ip = peaks[(i, j)]
                    curve = curves[(i, j)]
                    h = half
                    while h > 0 and any(ip + k not in curve
                                        for k in range(-h, h + 1)):
                        h -= 1
                    window = [curve[ip + k] for k in range(-h, h + 1)]
                    if h == 0:
                        errs.append(ip - ref[(i, j)])
                        continue
                    if kind == "parab":
                        if h == 1:
                            x0, x1, x2 = window
                            den = x0 - 2 * x1 + x2
                            d = 0.5 * (x0 - x2) / den if den != 0 else 0.0
                        else:
                            d = fit_parab_ls(window, h)
                    elif kind == "sinc":
                        d = fit_sinc(window, h)
                    else:
                        d = centroid(window, h)
                    errs.append(ip + d - ref[(i, j)])
            print("half=%d %-9s max_abs=%.6f rms=%.6f %s"
                  % (half, kind, max(abs(e) for e in errs),
                     math.sqrt(sum(e * e for e in errs) / len(errs)),
                     " ".join("%+.5f" % e for e in errs)))


if __name__ == "__main__":
    main()
