#!/usr/bin/env python3
"""Spectral energy diagnostics for octave-error correction design."""
import sys, os
sys.path.insert(0, "/home/wendy/.local/lib/python3.12/site-packages")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from analyze_samples import read_wav


def fft_mag(seg):
    n = 1
    while n < len(seg) * 2:
        n *= 2
    sp = np.abs(np.fft.rfft(seg, n))
    freqs = np.fft.rfftfreq(n, 1.0 / rate)
    return freqs, sp


def band_energy(freqs, sp, f, frac=0.03):
    m = (freqs >= f * (1 - frac)) & (freqs <= f * (1 + frac))
    return float(np.sum(sp[m] ** 2)) if m.any() else 0.0


path = sys.argv[1]
rate, x = read_wav(path)
for ts in [float(a) for a in sys.argv[2:]]:
    Nw = round(rate * 0.08)
    c = int(ts * rate)
    seg = x[max(0, c - Nw // 2):c + Nw // 2]
    w = np.hanning(len(seg))
    freqs, sp = fft_mag(seg * w)
    m40 = freqs > 40
    peak_i = np.argmax(sp[m40])
    peak_f = freqs[m40][peak_i]
    # candidates from this segment's known structure: check harmonics of 330, 165, 110, 220, 196
    print(f"t={ts:.2f} spectralPeak={peak_f:.1f}Hz")
    for f0 in (60, 82.5, 110, 165, 196, 220, 330):
        e0 = band_energy(freqs, sp, f0)
        e2 = band_energy(freqs, sp, 2 * f0)
        e3 = band_energy(freqs, sp, 3 * f0)
        print(f"   f0={f0:6.1f} E(f0)={e0:10.1f} E(2f0)={e2:10.1f} E(3f0)={e3:10.1f} 2f/f0={ (e2/max(e0,1e-9)):8.2f}")
