#!/usr/bin/env python3
"""用超密集中点采样独立检验解析积分（只用于小规模时间跨度）。"""
import bisect
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_oracle import build_evl
from ref_impl import parse, pixel_windows, MISSING, LO, HI  # noqa


def pixel_trajectory_fn(parsed, p):
    A = parsed["a"]
    ats = parsed["ats"]
    codes = parsed["codes"]
    ev = sorted((t, pol) for (t, idx, pol) in parsed["events"] if idx == p)
    ets = [t for t, _ in ev]
    epol = [d for _, d in ev]
    pref = [0]
    for d in epol:
        pref.append(pref[-1] + d)
    logs = [None if codes[a][p] == MISSING else codes[a][p] / 256 for a in range(A)]

    segs = []
    for k in range(A - 1):
        if logs[k] is None or logs[k + 1] is None:
            continue
        ta, tb = ats[k], ats[k + 1]
        lo = bisect.bisect_right(ets, ta)      # strict > ta
        hi = bisect.bisect_left(ets, tb)       # strict < tb
        N = pref[hi] - pref[lo]
        segs.append((ta, tb, logs[k], logs[k + 1], lo, hi, N))

    def value(t):
        for ta, tb, La, Lb, lo, hi, N in segs:
            if ta <= t <= tb:
                upto = bisect.bisect_right(ets, t, lo, hi)  # t 时刻事件已生效
                n = pref[upto] - pref[lo]
                L = La + n / 8 + (Lb - La - N / 8) * (t - ta) / (tb - ta)
                return 2.0 ** min(HI, max(LO, L))
        return None
    return value


def main():
    rng = random.Random(424242)
    worst = 0.0
    for case in range(8):
        w, h = 2, 2
        P = w * h
        A = rng.randint(2, 4)
        times = [0]
        for _ in range(A - 1):
            times.append(times[-1] + rng.choice([2, 5, 20, 100, 500]))
        codes = [[rng.choice([MISSING, -6144, -4000, 0, 1500, 2048,
                              rng.randint(-6144, 2048)]) for _ in range(P)] for _ in range(A)]
        tN = times[-1]
        events = []
        for _ in range(rng.randint(0, 40)):
            events.append((rng.randint(0, tN), rng.randrange(P), rng.choice([-1, 1])))
        data = build_evl(w, h, times, codes, events)
        parsed = parse(data)
        for p in range(P):
            fn = pixel_trajectory_fn(parsed, p)
            ws = rng.randint(0, max(0, tN // 2))
            we = ws + rng.randint(2, max(3, tN - ws + 2))
            we = min(we, tN + 50)
            if we <= ws:
                we = ws + 2
            lum_a, cov_a = pixel_windows(parsed, p, [[ws, we]])[0]
            M = 300_000
            dt = (we - ws) / M
            s = 0.0
            cnt = 0
            for i in range(M):
                t = ws + (i + 0.5) * dt
                v = fn(t)
                if v is not None:
                    s += v
                    cnt += 1
            dur = cnt * dt
            lum_d = (s * dt) / dur if dur > 0 else 0.0
            if lum_a == 0 and lum_d == 0:
                continue
            rel = abs(lum_a - lum_d) / max(abs(lum_d), 1e-30)
            worst = max(worst, rel)
            if rel > 5e-4:
                print(f"MISMATCH case{case} p{p} win[{ws},{we}] analytic={lum_a:.9g} dense={lum_d:.9g} rel={rel:.2e}")
                sys.exit(1)
    print(f"dense sampling cross-check OK, worst rel {worst:.2e}")


if __name__ == "__main__":
    main()
