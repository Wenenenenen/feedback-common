#!/usr/bin/env python3
"""Analyze sample WAVs to understand signal structure (not part of the web app)."""
import sys, wave, struct
sys.path.insert(0, "/home/wendy/.local/lib/python3.12/site-packages")
import numpy as np


def read_wav(path):
    with wave.open(path, "rb") as w:
        nch, sw, rate, n, _, _ = w.getparams()
        raw = w.readframes(n)
    assert nch == 1
    if sw == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        i = (b[:, 2].astype(np.int32) << 16) | (b[:, 1].astype(np.int32) << 8) | b[:, 0].astype(np.int32)
        i = np.where(i & 0x800000, i - (1 << 24), i)
        x = i / float(1 << 23)
    else:
        raise ValueError(sw)
    return rate, x


def cmndf(x, tau_max, W=None):
    """d'(tau) with fixed comparison length W (zero-padded), per task convention."""
    N = len(x)
    if W is None:
        W = N - tau_max
    taus = np.arange(tau_max + 1)
    d = np.empty(tau_max + 1)
    d[0] = 0.0
    xp = np.concatenate([x, np.zeros(tau_max)])
    for t in taus[1:]:
        diff = xp[:W] - xp[t:t + W]
        d[t] = float(np.dot(diff, diff))
    cum = np.cumsum(d)
    with np.errstate(divide="ignore", invalid="ignore"):
        dprime = np.where(cum > 0, taus * d / np.where(cum == 0, 1, cum), 1.0)
    dprime[0] = 1.0
    return dprime


def analyze(path):
    rate, x = read_wav(path)
    print(f"== {path} rate={rate} N={len(x)} dur={len(x)/rate:.3f}s")
    H = rate // 100
    win_ms = 80
    Nw = round(rate * win_ms / 1000)
    half = Nw // 2
    # global stats
    print(f"global rms={np.sqrt(np.mean(x**2)):.4f} peak={np.max(np.abs(x)):.4f}")
    # per frame RMS and candidate info at a few positions
    for c in range(0, len(x), H * 20):
        lo, hi = c - half, c + half
        seg = x[max(lo, 0):max(hi, 0)] if hi > 0 else np.array([0.0])
        if lo < 0:
            seg = np.concatenate([np.zeros(-lo), seg])
        if hi > len(x):
            seg = np.concatenate([seg, np.zeros(hi - len(x))])
        rms = np.sqrt(np.mean(seg ** 2))
        tmax = int(rate / 60)
        dp = cmndf(seg, tmax, W=Nw - tmax)
        tlo = max(1, int(rate // 1000) - 2)
        thi = int(rate // 60) + 1
        region = dp[tlo:thi]
        tmin = tlo + int(np.argmin(region))
        print(f"  t={c/rate:5.2f}s rms={rms:.4f} bestTau={tmin} ({rate/tmin:7.2f}Hz) d'min={dp[tmin]:.3f}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyze(p)
