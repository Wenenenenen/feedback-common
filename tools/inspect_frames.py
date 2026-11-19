#!/usr/bin/env python3
"""Deeper per-frame inspection of edge-case segments (not part of the web app)."""
import sys, os
sys.path.insert(0, "/home/wendy/.local/lib/python3.12/site-packages")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wave
import numpy as np
from analyze_samples import read_wav, cmndf


def local_minima(dp, tlo, thi):
    out = []
    for t in range(max(2, tlo), min(thi, len(dp) - 1)):
        if dp[t] <= dp[t - 1] and dp[t] <= dp[t + 1]:
            out.append((t, dp[t]))
    return out


path = sys.argv[1]
rate, x = read_wav(path)
H = rate // 100
for win_ms in (40, 80):
    Nw = round(rate * win_ms / 1000)
    half = Nw // 2
    tmax = int(rate / 60) + 2
    tlo = max(2, int(rate / 1000) - 3)
    print(f"##### window={win_ms}ms Nw={Nw}")
    centers = [float(a) for a in sys.argv[2:]] or [c / rate for c in range(0, len(x), H * 10)]
    for ts in centers:
        c = int(round(ts * rate))
        lo, hi = c - half, c + half
        seg = np.zeros(Nw)
        sl = x[max(lo, 0):min(hi, len(x))]
        seg[max(0, -lo):max(0, -lo) + len(sl)] = sl
        rms = np.sqrt(np.mean(seg ** 2))
        dp = cmndf(seg, tmax, W=Nw - tmax)
        mins = sorted(local_minima(dp, tlo, tmax), key=lambda z: z[1])[:6]
        desc = " ".join(f"{rate/t:7.2f}Hz(d'={v:.3f})" for t, v in mins)
        print(f" t={ts:5.2f} rms={rms:.4f}  {desc}")
