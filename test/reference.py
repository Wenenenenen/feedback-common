#!/usr/bin/env python3
"""独立参考实现：严格按 约定.txt 渲染工程，输出双声道 PCM16（用于与 JS 核心对拍）。

用法: python3 -I reference.py <project_dir> <out.wav>
project_dir 内含 project.json 与其引用的 wav。
"""
import json
import struct
import sys
import wave

TURN = 36000


def round_half_even(x: float) -> int:
    import math
    f = math.floor(x)
    d = x - f
    if d > 0.5:
        return f + 1
    if d < 0.5:
        return f
    return f if f % 2 == 0 else f + 1


def load_wav(path):
    with wave.open(path, 'rb') as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == 48000
        n = w.getnframes()
        data = w.readframes(n)
    return list(struct.unpack('<%dh' % n, data))


def track_angle(frames, angs, n):
    if n >= frames[-1]:
        return angs[-1]
    lo, hi = 0, len(frames) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if frames[mid] <= n:
            lo = mid
        else:
            hi = mid - 1
    f0, f1 = frames[lo], frames[lo + 1]
    a0, a1 = angs[lo], angs[lo + 1]
    return a0 + (a1 - a0) * ((n - f0) / (f1 - f0))


def lookup(angles, a):
    m = len(angles)
    if a < angles[0]:
        a0 = angles[-1] - TURN
        a1 = angles[0]
        return m - 1, 0, (a - a0) / (a1 - a0)
    lo, hi = 0, m - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if angles[mid] <= a:
            lo = mid
        else:
            hi = mid - 1
    if angles[lo] == a:
        return lo, lo, 1
    if lo == m - 1:
        a0 = angles[lo]
        a1 = angles[0] + TURN
        return lo, 0, (a - a0) / (a1 - a0)
    a0, a1 = angles[lo], angles[lo + 1]
    return lo, lo + 1, (a - a0) / (a1 - a0)


def render_ear(samples, frames, angs, angles, taps, delays, L, out):
    N = len(samples)
    for n in range(N):
        ang = track_angle(frames, angs, n)
        a = ang % TURN
        ia, ib, w = lookup(angles, a)
        d256 = delays[ia] + (delays[ib] - delays[ia]) * w
        ds = d256 / 256
        intd = int(ds // 1)
        frac = ds - intd
        x = samples[n]
        if x == 0:
            continue
        base = n + intd
        ha = taps[ia]
        hb = taps[ib]
        if frac == 0:
            for k in range(L):
                h = ha[k] + (hb[k] - ha[k]) * w
                out[base + k] += x * h
        else:
            g0 = 1 - frac
            g1 = frac
            for k in range(L):
                h = ha[k] + (hb[k] - ha[k]) * w
                c = x * h
                out[base + k] += c * g0
                out[base + k + 1] += c * g1


def main():
    proj_dir, out_path = sys.argv[1], sys.argv[2]
    with open(proj_dir + '/project.json') as f:
        proj = json.load(f)
    bank = proj['bank']
    angles = bank['angles']
    L = len(bank['left'][0])
    taps_l = [[t / 32768 for t in row] for row in bank['left']]
    taps_r = [[t / 32768 for t in row] for row in bank['right']]
    dl = bank['left_delay']
    dr = bank['right_delay']

    sources = []
    for s in proj['sources']:
        samples = load_wav(proj_dir + '/' + s['wav'])
        frames = [p[0] for p in s['track']]
        angs = [p[1] for p in s['track']]
        sources.append((samples, frames, angs))

    max_n = max(len(s[0]) for s in sources)
    total = max_n + L + 255
    left = [0.0] * total
    right = [0.0] * total
    for samples, frames, angs in sources:
        render_ear(samples, frames, angs, angles, taps_l, dl, L, left)
        render_ear(samples, frames, angs, angles, taps_r, dr, L, right)

    def q(buf):
        out = []
        for v in buf:
            r = round_half_even(v)
            out.append(max(-32768, min(32767, r)))
        return out

    ql, qr = q(left), q(right)
    with wave.open(out_path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        inter = bytearray()
        for i in range(total):
            inter += struct.pack('<hh', ql[i], qr[i])
        w.writeframes(bytes(inter))
    print('total frames:', total)


if __name__ == '__main__':
    main()
