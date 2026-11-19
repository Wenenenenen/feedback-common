#!/usr/bin/env python3
"""Pure-Python reference of the GCC-PHAT bearing pipeline (no numpy).

Run: python3 -I tools/ref_gcc_pure.py <wav> <json> [start] [end]
Mirrors 约定.txt exactly so the JS port can be checked line-for-line.
"""
import json
import math
import struct
import sys
import wave


def read_wav(path):
    w = wave.open(path, "rb")
    nch, sw, rate, nframes, *_ = w.getparams()
    raw = w.readframes(nframes)
    w.close()
    if sw == 2:
        vals = struct.unpack("<%dh" % (nframes * nch), raw)
        scale = 32768.0
    elif sw == 3:
        vals = []
        for k in range(nframes * nch):
            b0, b1, b2 = raw[3 * k], raw[3 * k + 1], raw[3 * k + 2]
            s = b0 | (b1 << 8) | (b2 << 16)
            if s & 0x800000:
                s -= 1 << 24
            vals.append(s)
        scale = 8388608.0
    else:
        raise ValueError("unsupported sample width %d" % sw)
    frames = [[vals[t * nch + ch] / scale for ch in range(nch)]
              for t in range(nframes)]
    return frames, rate, nch, sw * 8


def fft(re, im):
    """In-place iterative radix-2 DIT FFT."""
    n = len(re)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    length = 2
    while length <= n:
        ang = -2 * math.pi / length
        wr, wi = math.cos(ang), math.sin(ang)
        half = length >> 1
        for i in range(0, n, length):
            cr, ci = 1.0, 0.0
            for k in range(half):
                a = i + k
                b = a + half
                tr = cr * re[b] - ci * im[b]
                ti = cr * im[b] + ci * re[b]
                re[b] = re[a] - tr
                im[b] = im[a] - ti
                re[a] += tr
                im[a] += ti
                nwr = cr * wr - ci * wi
                ci = cr * wi + ci * wr
                cr = nwr
        length <<= 1


def ifft_real(re, im):
    """Real part of IFFT via conj(FFT(conj(X)))/N."""
    n = len(re)
    rre = re[:]
    iim = [-v for v in im]
    fft(rre, iim)
    return [v / n for v in rre]


def gcc_phat(xi, xj, max_lag):
    n = len(xi)
    nfft = 1
    while nfft < 2 * n - 1:
        nfft <<= 1
    re_i, im_i = [0.0] * nfft, [0.0] * nfft
    re_j, im_j = [0.0] * nfft, [0.0] * nfft
    for k in range(n):
        re_i[k] = xi[k]
        re_j[k] = xj[k]
    fft(re_i, im_i)
    fft(re_j, im_j)
    cr, ci = [0.0] * nfft, [0.0] * nfft
    for k in range(nfft):
        # conj(Xi) * Xj
        a = re_i[k] * re_j[k] + im_i[k] * im_j[k]
        b = re_i[k] * im_j[k] - im_i[k] * re_j[k]
        mag = math.hypot(a, b)
        norm = max(mag, 1e-12)
        cr[k] = a / norm
        ci[k] = b / norm
    r = ifft_real(cr, ci)
    L = min(max_lag, n - 1)
    lags = list(range(-L, L + 1))
    vals = [r[k if k >= 0 else nfft + k] for k in lags]
    k0 = max(range(len(vals)), key=lambda k: vals[k])
    peak = lags[k0]
    delta = 0.0
    if 0 < k0 < len(vals) - 1:
        a, b, cc = vals[k0 - 1], vals[k0], vals[k0 + 1]
        denom = a - 2 * b + cc
        if denom != 0.0:
            delta = 0.5 * (a - cc) / denom
    return lags, vals, peak + delta, vals[k0]


def fit_bearing(pairs, coords, c):
    B, tau, W = [], [], []
    for p in pairs:
        d = [coords[p["j"]][0] - coords[p["i"]][0],
             coords[p["j"]][1] - coords[p["i"]][1]]
        B.append(d)
        tau.append(p["tau_s"])
        W.append(p.get("weight", 1.0))
    # SVD-ish rank check: 2x2 Gram matrix of weighted baselines
    g00 = sum(W[k] * B[k][0] ** 2 for k in range(len(B)))
    g01 = sum(W[k] * B[k][0] * B[k][1] for k in range(len(B)))
    g11 = sum(W[k] * B[k][1] ** 2 for k in range(len(B)))
    tr = g00 + g11
    det = g00 * g11 - g01 * g01
    disc = max(0.0, (0.5 * tr) ** 2 - det)
    l1 = 0.5 * tr + math.sqrt(disc)
    l2 = 0.5 * tr - math.sqrt(disc)
    span2d = l1 > 0 and l2 > 1e-12 * l1

    def cost(theta):
        ux, uy = math.cos(theta), math.sin(theta)
        s = 0.0
        for k in range(len(B)):
            e = tau[k] + (B[k][0] * ux + B[k][1] * uy) / c
            s += W[k] * e * e
        return s

    step = math.radians(0.1)
    best_t, best_c = 0.0, float("inf")
    m = 3600
    for q in range(m):
        t = q * step
        v = cost(t)
        if v < best_c:
            best_c, best_t = v, t
    lo, hi = best_t - step, best_t + step
    gr = (math.sqrt(5) + 1) / 2
    for _ in range(60):
        m1 = hi - (hi - lo) / gr
        m2 = lo + (hi - lo) / gr
        if cost(m1) < cost(m2):
            hi = m2
        else:
            lo = m1
    theta = 0.5 * (lo + hi)
    deg = math.degrees(theta) % 360.0
    ux, uy = math.cos(theta), math.sin(theta)
    sse = 0.0
    for k in range(len(B)):
        e = tau[k] + (B[k][0] * ux + B[k][1] * uy) / c
        sse += W[k] * e * e
    wsum = sum(W)
    rms_s = math.sqrt(sse / wsum)
    return deg, rms_s, span2d, (l1, l2), sse


def main():
    wav_path, json_path = sys.argv[1], sys.argv[2]
    frames, rate, nch, bits = read_wav(wav_path)
    with open(json_path) as f:
        geo = json.load(f)
    coords, c = geo["coordinates_m"], geo["speed_m_s"]
    assert nch == len(coords)
    s = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    e = int(sys.argv[4]) if len(sys.argv) > 4 else len(frames)
    n = e - s
    win = [0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1))
           for k in range(n)] if n > 1 else [1.0]
    x = []
    for ch in range(nch):
        mean = sum(frames[s + t][ch] for t in range(n)) / n
        x.append([(frames[s + t][ch] - mean) * win[t] for t in range(n)])
    print("file=%s rate=%d bits=%d ch=%d frames=%d interval=[%d,%d) N=%d"
          % (wav_path, rate, bits, nch, len(frames), s, e, n))
    for ch in range(nch):
        seg = [frames[s + t][ch] for t in range(n)]
        pk = max(abs(v) for v in seg)
        rms = math.sqrt(sum(v * v for v in seg) / n)
        print("  ch%d peak=%.5f rms=%.6f" % (ch, pk, rms))

    pairs = []
    for i in range(nch):
        for j in range(i + 1, nch):
            dx = coords[j][0] - coords[i][0]
            dy = coords[j][1] - coords[i][1]
            d = math.hypot(dx, dy)
            max_lag = math.ceil(d * rate / c)
            _, vals, refined, pk = gcc_phat(x[i], x[j], max_lag)
            pairs.append({"i": i, "j": j, "tau_s": refined / rate,
                          "lag_samples": refined, "weight": 1.0})
            print("  pair %d-%d d=%.4fm maxlag=±%d lag=%+.4f samp "
                  "(%+.3f us) gcc_peak=%.4f"
                  % (i, j, d, max_lag, refined, refined / rate * 1e6, pk))

    deg, rms_s, span2d, sv, sse = fit_bearing(pairs, coords, c)
    print("weighted-baseline Gram eigenvalues: %.3e %.3e span2d=%s"
          % (sv[0], sv[1], span2d))
    print("BEARING=%.4f deg  rms_resid=%.3f us (%.4f samples) sse=%.3e"
          % (deg, rms_s * 1e6, rms_s * rate, sse))
    if "expected_bearing_deg" in geo:
        diff = abs((deg - geo["expected_bearing_deg"] + 180) % 360 - 180)
        print("expected=%s delta=%.4f deg"
              % (geo["expected_bearing_deg"], diff))


if __name__ == "__main__":
    main()
