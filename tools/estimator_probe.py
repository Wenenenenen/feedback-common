#!/usr/bin/env python3
"""Test classic sub-sample peak estimators against reference pair lags."""
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


def parab(x0, x1, x2):
    den = x0 - 2 * x1 + x2
    return 0.5 * (x0 - x2) / den if den != 0 else 0.0


def grandke(x0, x1, x2):
    a, b, c = max(x0, 1e-12), max(x1, 1e-12), max(x2, 1e-12)
    la, lb, lc = math.log(a), math.log(b), math.log(c)
    den = la - 2 * lb + lc
    return 0.5 * (la - lc) / den if den != 0 else 0.0


def quinn(x0, x1, x2):
    # Quinn's second estimator, applied to the correlation peak
    ap = (x0 - x1) / (x1 - x2) if x1 != x2 else 0.0
    am = (x2 - x1) / (x1 - x0) if x1 != x0 else 0.0

    def d(a):
        if a <= -1:
            return 0.0
        return a / (1 + a) - math.log(1 + a)

    dp, dm = d(ap), d(am)
    if dp > 0 and dm > 0:
        return dp if dp < dm else -dm
    return 0.0


def _sinc(v):
    if abs(v) < 1e-12:
        return 1.0
    return math.sin(math.pi * v) / (math.pi * v)


def sinc_fit(xm1, x0, xp1):
    # fit R(d)=sinc(1+d), sinc(d), sinc(1-d) scale; grid on d in (-1,1)
    best_d, best_e = 0.0, float("inf")
    N = 2001
    for q in range(N):
        d = -1.0 + 2.0 * q / (N - 1)
        s0 = _sinc(d)
        sp = _sinc(1 - d)
        sm = _sinc(1 + d)
        # best scale by LS
        a = (xm1 * sm + x0 * s0 + xp1 * sp) / (sm * sm + s0 * s0 + sp * sp)
        e = (xm1 - a * sm) ** 2 + (x0 - a * s0) ** 2 + (xp1 - a * sp) ** 2
        if e < best_e:
            best_e, best_d = e, d
    return best_d


def centroid3(x0, x1, x2):
    s = x0 + x1 + x2
    return (-x0 + x2) / s if s != 0 else 0.0


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
    ests = {"parab": parab, "grandke": grandke, "quinn": quinn,
            "sinc3": sinc_fit, "centroid": centroid3}
    rows = {k: [] for k in ests}
    for i in range(nch):
        for j in range(i + 1, nch):
            d = math.hypot(coords[j][0] - coords[i][0],
                           coords[j][1] - coords[i][1])
            ml = math.ceil(d * rate / c)
            r = gcc_curve(x[i], x[j], nfft)
            L = ml
            lags = list(range(-L, L + 1))
            vals = [r[k if k >= 0 else nfft + k] for k in lags]
            k0 = max(range(len(vals)), key=lambda k: vals[k])
            peak = lags[k0]
            x0, x1, x2 = vals[k0 - 1], vals[k0], vals[k0 + 1]
            target_frac = ref[(i, j)] - peak
            print("pair %d-%d intpeak=%d target_frac=%+.5f  vals=[%.4f %.4f %.4f]"
                  % (i, j, peak, target_frac, x0, x1, x2))
            for name, fn in ests.items():
                got = fn(x0, x1, x2)
                rows[name].append(got - target_frac)
    print()
    for name, errs in rows.items():
        print("%-9s max_abs=%.5f  rms=%.5f  %s"
              % (name, max(abs(e) for e in errs),
                 math.sqrt(sum(e * e for e in errs) / len(errs)),
                 " ".join("%+.4f" % e for e in errs)))


if __name__ == "__main__":
    main()
