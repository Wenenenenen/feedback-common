#!/usr/bin/env python3
# Reference straight-alpha recovery, used only to validate the math.
# Run with: python3 -I reference_solve.py <data_dir> [tolerance]
import json, os, sys, math


def read_pnm(path):
    with open(path, "rb") as f:
        data = f.read()
    pos = 0

    def token():
        nonlocal pos
        while True:
            # skip whitespace
            while pos < len(data) and data[pos] in b" \t\n\r":
                pos += 1
            if pos < len(data) and data[pos] == ord("#"):
                while pos < len(data) and data[pos] not in b"\n\r":
                    pos += 1
                continue
            start = pos
            while pos < len(data) and data[pos] not in b" \t\n\r":
                pos += 1
            return data[start:pos]

    magic = token()
    w = int(token()); h = int(token()); mx = int(token())
    pos += 1  # single whitespace after maxval
    if mx != 255:
        raise ValueError("only 8-bit (maxval 255) supported: %s" % path)
    if magic == b"P6":
        ch = 3
    elif magic == b"P5":
        ch = 1
    else:
        raise ValueError("bad magic %s in %s" % (magic, path))
    need = w * h * ch
    pix = data[pos:pos + need]
    if len(pix) != need:
        raise ValueError("trusted raster in %s" % path)
    return w, h, ch, pix


def composite(a, f, b):
    return (a * f + (255 - a) * b + 127) // 255


def f_interval(a, b, o, t):
    """F values in 0..255 with |composite(a,F,b)-o| <= t. Returns (lo,hi) or None."""
    lo_b, hi_b = max(0, o - t), min(255, o + t)
    if a == 0:
        p = composite(0, 0, b)
        return (0, 255) if lo_b <= p <= hi_b else None
    k = (255 - a) * b
    num_lo = 255 * lo_b - k - 127
    num_hi = 255 * (hi_b + 1) - 1 - k - 127
    flo = max(0, math.ceil(num_lo / a))
    fhi = min(255, num_hi // a)
    if flo > fhi:
        return None
    return flo, fhi


def f_interval_bruteforce(a, b, o, t):
    out = []
    for f in range(256):
        if abs(composite(a, f, b) - o) <= t:
            out.append(f)
    return (out[0], out[-1]) if out else None


def solve_pixel(obs, tol):
    """obs: list of (b3, o3, valid3) tuples. Returns (status, solution, feasible_list)."""
    groups = [g for g in obs if g is not None]
    if not groups:
        return 0, None, []  # unmeasured
    feasible = []
    for a in range(256):
        intervals = []
        ok = True
        for b3, o3, _ in groups:
            for c in range(3):
                iv = f_interval(a, b3[c], o3[c], tol)
                if iv is None:
                    ok = False
                    break
                intervals.append(iv)
            if not ok:
                break
        if not ok:
            continue
        # intersect per channel
        lo = [0, 0, 0]; hi = [255, 255, 255]
        for i, (l, h) in enumerate(intervals):
            c = i % 3
            lo[c] = max(lo[c], l); hi[c] = min(hi[c], h)
        if all(lo[c] <= hi[c] for c in range(3)):
            feasible.append((a, tuple(lo), tuple(hi)))
    if not feasible:
        return 2, None, []  # no solution
    a, lo, hi = feasible[0]  # smallest A; smallest F via lo
    return 1, (a, lo[0], lo[1], lo[2]), feasible


def main():
    data_dir = sys.argv[1]
    tol = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    do_brute = len(sys.argv) <= 3 or sys.argv[3] != "--no-brute"
    with open(os.path.join(data_dir, "groups.json"), encoding="utf-8") as f:
        spec = json.load(f)
    groups = []
    for g in spec["groups"]:
        w, h, ch, bg = read_pnm(os.path.join(data_dir, g["background"]))
        w2, h2, ch2, ob = read_pnm(os.path.join(data_dir, g["observed"]))
        if (w, h) != (w2, h2) or ch != 3 or ch2 != 3:
            raise SystemExit("size/magic mismatch")
        if "valid" in g and g["valid"]:
            _, _, chv, vd = read_pnm(os.path.join(data_dir, g["valid"]))
            if chv != 1:
                raise SystemExit("mask must be P5")
        else:
            vd = bytes([255]) * (w * h)
        groups.append((w, h, bg, ob, vd, g.get("background"), g.get("observed")))

    w, h = groups[0][0], groups[0][1]
    n = w * h
    counts = {0: 0, 1: 0, 2: 0}
    worst_err = 0
    mismatch_checks = 0
    special = {}
    for p in range(n):
        pixel_groups = []
        for (_, _, bg, ob, vd, _, _) in groups:
            if vd[p] != 0:
                pixel_groups.append((
                    tuple(bg[3 * p + c] for c in range(3)),
                    tuple(ob[3 * p + c] for c in range(3)),
                    True,
                ))
            else:
                pixel_groups.append(None)
        status, sol, feasible = solve_pixel(pixel_groups, tol)
        counts[status] += 1
        if p in (0, 1):
            special[p] = (status, sol, len(feasible))
        # validate interval math against brute force on every (A,group,channel)
        if do_brute:
            for a in range(256):
                for g in pixel_groups:
                    if g is None:
                        continue
                    b3, o3, _ = g
                    for c in range(3):
                        iv1 = f_interval(a, b3[c], o3[c], tol)
                        iv2 = f_interval_bruteforce(a, b3[c], o3[c], tol)
                        mismatch_checks += 1
                        if iv1 != iv2:
                            raise AssertionError(("interval mismatch", p, a, b3[c], o3[c], iv1, iv2))
        if status == 1:
            a, r, gg, b = sol
            for (_, _, bg, ob, vd, _, _) in groups:
                if vd[p] == 0:
                    continue
                for c in range(3):
                    f = (r, gg, b)[c]
                    pred = composite(a, f, bg[3 * p + c])
                    err = pred - ob[3 * p + c]
                    worst_err = max(worst_err, abs(err))
                    if abs(err) > tol:
                        raise AssertionError(("tol violated", p, err))
    print("size=%dx%d groups=%d tol=%d" % (w, h, len(groups), tol))
    print("status counts: feasible=%d no_solution=%d unmeasured=%d" % (counts[1], counts[2], counts[0]))
    if special:
        print("special pixels:", special)
    if do_brute:
        print("interval-vs-brute-force checks: %d (all matched)" % mismatch_checks)
    print("worst |pred-obs| among delivered pixels: %d" % worst_err)


if __name__ == "__main__":
    main()
