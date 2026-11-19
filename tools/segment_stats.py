#!/usr/bin/env python3
"""RMS / zero-crossing / spectral-flatness statistics per reference segment."""
import sys, os, json
sys.path.insert(0, "/home/wendy/.local/lib/python3.12/site-packages")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from analyze_samples import read_wav

path, refpath = sys.argv[1], sys.argv[2]
rate, x = read_wav(path)
ref = json.load(open(refpath))
segs = ref["segments"] if isinstance(ref, dict) and "segments" in ref else None
H = rate // 100
Nw = round(rate * 0.04)
half = Nw // 2

rms_all = []
for c in range(0, len(x), H):
    seg = x[max(0, c - half):min(len(x), c + half)]
    rms_all.append(np.sqrt(np.mean(seg ** 2)))
rms_all = np.array(rms_all)

if segs:
    for s in segs:
        t0, t1 = s["start_frame"] / rate, s["end_frame"] / rate
        i0, i1 = int(t0 * 100), int(t1 * 100)
        r = rms_all[i0:i1]
        # spectral flatness on a mid-segment frame
        cm = (s["start_frame"] + s["end_frame"]) // 2
        seg = x[max(0, cm - Nw // 2):min(len(x), cm + Nw // 2)] * np.hanning(min(len(x), Nw) if cm + Nw // 2 <= len(x) and cm - Nw // 2 >= 0 else len(seg))
        n = 1
        while n < len(seg) * 2:
            n *= 2
        sp = np.abs(np.fft.rfft(seg, n))[1:]
        sp = sp[sp > 1e-12]
        sfm = np.exp(np.mean(np.log(sp))) / np.mean(sp)
        zcr = np.mean(np.abs(np.diff(np.sign(seg))) > 0)
        print(f"{s['kind']:18s} {t0:4.2f}-{t1:4.2f} rms[min/med/max]={r.min():.4f}/{np.median(r):.4f}/{r.max():.4f} SFM={sfm:.3f} ZCR={zcr:.3f}")
else:
    print("glide file: rms min/med/max", rms_all.min(), np.median(rms_all), rms_all.max())
    # track frequency via simple d' global min for sanity vs reference
    from analyze_samples import cmndf
    refpts = ref
    errs = []
    for p in refpts[::25]:
        c = p["center_frame"]
        Nw80 = round(rate * 0.08)
        seg = np.zeros(Nw80)
        sl = x[max(0, c - Nw80 // 2):min(len(x), c + Nw80 // 2)]
        seg[:len(sl)] = sl
        dp = cmndf(seg, int(rate / 60), W=Nw80 - int(rate / 60))
        tlo, thi = int(rate / 1000), int(rate / 60)
        tau = tlo + int(np.argmin(dp[tlo:thi]))
        est = rate / tau
        errs.append(1200 * np.log2(est / p["hz"]))
    print("raw-YIN cents error vs glide ref: median", np.median(np.abs(errs)), "max", np.max(np.abs(errs)))
