#!/usr/bin/env python3
"""Independent reference for EVL1 reconstruction / LUM1 export.

Reads untrusted sample data: run with `python3 -I tools/ref_impl.py <file.evl>`.
This script is deliberately simple and scalar; it is the oracle used to
cross-check the browser/JS implementation.
"""
import struct
import sys
import math
import json

LO, HI = -24.0, 8.0
MISSING = -32768


class EVLError(Exception):
    def __init__(self, offset, field, msg):
        super().__init__(f"offset={offset} field={field}: {msg}")
        self.offset = offset
        self.field = field


def parse(path_or_bytes):
    if isinstance(path_or_bytes, (bytes, bytearray)):
        b = bytes(path_or_bytes)
    else:
        with open(path_or_bytes, "rb") as f:
            b = f.read()
    n = len(b)

    def need(off, size, field):
        if off + size > n:
            # first field that cannot be read fully starts at `off`
            raise EVLError(off, field, "truncated field")

    if n < 4:
        raise EVLError(0, "magic", "truncated magic")
    if b[0:4] != b"EVL1":
        raise EVLError(0, "magic", "bad magic")
    need(4, 2, "width")
    w = struct.unpack_from("<H", b, 4)[0]
    if not (1 <= w <= 512):
        raise EVLError(4, "width", f"width {w} out of range")
    need(6, 2, "height")
    h = struct.unpack_from("<H", b, 6)[0]
    if not (1 <= h <= 384):
        raise EVLError(6, "height", f"height {h} out of range")
    need(8, 4, "anchor_count")
    a = struct.unpack_from("<I", b, 8)[0]
    if not (2 <= a <= 12):
        raise EVLError(8, "anchor_count", f"anchor count {a} out of range")
    need(12, 4, "event_count")
    e = struct.unpack_from("<I", b, 12)[0]
    if e > 4_000_000:
        raise EVLError(12, "event_count", f"event count {e} over cap")

    pcount = w * h
    pos = 16
    ats = []
    # anchor-major codes
    codes = []  # list per anchor of list codes
    for ai in range(a):
        need(pos, 4, f"anchor[{ai}].t")
        t = struct.unpack_from("<I", b, pos)[0]
        if ai > 0 and t <= ats[-1]:
            raise EVLError(pos, f"anchor[{ai}].t", "anchor ts not strictly increasing")
        ats.append(t)
        pos += 4
        row = []
        for j in range(pcount):
            need(pos, 2, f"anchor[{ai}].code[{j}]")
            c = struct.unpack_from("<h", b, pos)[0]
            if c != MISSING and not (-6144 <= c <= 2048):
                raise EVLError(pos, f"anchor[{ai}].code[{j}]", f"bad code {c}")
            row.append(c)
            pos += 2
        codes.append(row)

    events = []  # (t, idx, pol)
    prev_t = None
    t0, t1 = ats[0], ats[-1]
    for i in range(e):
        need(pos, 4, f"event[{i}].t")
        t = struct.unpack_from("<I", b, pos)[0]
        if not (t0 <= t <= t1):
            raise EVLError(pos, f"event[{i}].t", f"event t {t} outside anchors [{t0},{t1}]")
        if prev_t is not None and t < prev_t:
            raise EVLError(pos, f"event[{i}].t", "event ts decreasing")
        prev_t = t
        pos += 4
        need(pos, 4, f"event[{i}].word")
        word = struct.unpack_from("<I", b, pos)[0]
        idx = word & 0x7FFFFFFF
        pol = 1 if (word >> 31) else -1
        if idx >= pcount:
            raise EVLError(pos, f"event[{i}].idx", f"pixel idx {idx} >= {pcount}")
        pos += 4
        events.append((t, idx, pol))

    if pos < n:
        raise EVLError(pos, "trailing", f"{n - pos} trailing byte(s)")
    return {"w": w, "h": h, "a": a, "e": e, "ats": ats, "codes": codes, "events": events}


def pixel_events(parsed, p):
    ev = [(t, pol) for (t, idx, pol) in parsed["events"] if idx == p]
    ev.sort()  # stable enough; input nondecreasing
    return ev


def merged_in_segment(ev, ta, tb):
    """strict ta < t < tb; merge same timestamp polarity sum."""
    agg = {}
    for t, pol in ev:
        if ta < t < tb:
            agg[t] = agg.get(t, 0) + pol
    return sorted(agg.items())


def clamped_integral(z0, beta, u, v):
    """Integral from u to v of 2^clamp(z0+beta*x, LO, HI), x local."""
    if v <= u:
        return 0.0
    cuts = [u, v]
    if beta != 0.0:
        for bound in (LO, HI):
            x = (bound - z0) / beta
            if u < x < v:
                cuts.append(x)
    cuts = sorted(set(cuts))
    total = 0.0
    for x0, x1 in zip(cuts[:-1], cuts[1:]):
        if x1 <= x0:
            continue
        xm = (x0 + x1) * 0.5
        z = z0 + beta * xm
        if z <= LO:
            total += (x1 - x0) * (2.0 ** LO)
        elif z >= HI:
            total += (x1 - x0) * (2.0 ** HI)
        else:
            a = z0 + beta * x0
            d = x1 - x0
            if beta == 0.0:
                integ = (2.0 ** a) * d
            else:
                # 始终使用 expm1 稳定形式，避免小斜率端点相消
                integ = (2.0 ** a) * math.expm1(beta * math.log(2.0) * d) / (beta * math.log(2.0))
            total += integ
    return total


def pixel_windows(parsed, p, windows, codes_override=None):
    w = parsed["w"]
    A = parsed["a"]
    ats = parsed["ats"]
    codes = parsed["codes"]
    ev = pixel_events(parsed, p)
    # per anchor validity/log
    logs = []
    for ai in range(A):
        c = codes[ai][p] if codes_override is None else codes_override[ai]
        logs.append(None if c == MISSING else c / 256.0)

    # runs of consecutive valid anchors length>=2
    runs = []
    i = 0
    while i < A:
        if logs[i] is None:
            i += 1
            continue
        j = i
        while j + 1 < A and logs[j + 1] is not None:
            j += 1
        if j > i:
            runs.append((i, j))
        i = j + 1

    out = []
    for ws, we in windows:
        length = we - ws
        cov_dur = 0.0
        integ = 0.0
        for i0, i1 in runs:
            T0, T1 = ats[i0], ats[i1]
            lo = max(ws, T0)
            hi = min(we, T1)
            if hi <= lo:
                continue
            cov_dur += hi - lo
            # build intervals for run
            for k in range(i0, i1):
                ta, tb = ats[k], ats[k + 1]
                La, Lb = logs[k], logs[k + 1]
                mer = merged_in_segment(ev, ta, tb)
                N = sum(d for _, d in mer)
                beta = (Lb - La - N / 8.0) / (tb - ta)
                n = 0
                q = ta
                z0 = La
                bounds = [t for t, _ in mer] + [tb]
                for t, d in mer:
                    end = t
                    # interval [q,end] z0 at q
                    a0 = max(lo, q)
                    a1 = min(hi, end)
                    if a1 > a0:
                        integ += clamped_integral(z0, beta, a0 - q, a1 - q)
                    n += d
                    q = t
                    z0 = La + n / 8.0 + beta * (t - ta)
                # final interval [q,tb]
                a0 = max(lo, q)
                a1 = min(hi, tb)
                if a1 > a0:
                    integ += clamped_integral(z0, beta, a0 - q, a1 - q)
        if cov_dur <= 0:
            out.append((0.0, 0.0))
        else:
            out.append((integ / cov_dur, cov_dur / length))
    return out


def write_lum1(path, w, h, results_for_window):
    """results_for_window: list of (lum,cov) row-major pixel pairs -> interleaved."""
    with open(path, "wb") as f:
        f.write(b"LUM1")
        f.write(struct.pack("<HH", w, h))
        for lum, cov in results_for_window:
            f.write(struct.pack("<ff", lum, cov))


def main():
    path = sys.argv[1]
    parsed = parse(path)
    print("header:", {k: parsed[k] for k in ("w", "h", "a", "e")})
    print("anchor ts:", parsed["ats"])
    wins = json.loads(sys.argv[2]) if len(sys.argv) > 2 else [[1000, 15000], [12000, 27000], [25000, 35000]]
    P = parsed["w"] * parsed["h"]
    for wi, win in enumerate(wins):
        lums = []
        covs = []
        for p in range(P):
            lum, cov = pixel_windows(parsed, p, [win])[0]
            lums.append(lum)
            covs.append(cov)
        print(f"window {wi} {win}: lum[min/max]={min(lums):.6g}/{max(lums):.6g} "
              f"cov[min/max]={min(covs):.6g}/{max(covs):.6g} "
              f"lum@0={lums[0]:.9g} cov@0={covs[0]:.9g}")


if __name__ == "__main__":
    main()
