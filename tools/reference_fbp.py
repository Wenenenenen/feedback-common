#!/usr/bin/env python3
"""Reference implementation of the parallel-beam Ram-Lak FBP convention in
_case_data/README.txt. Run with: python3 -I reference_fbp.py <case_dir> [out_dir]
Pure stdlib (struct/json/array) so it can run under -I next to untrusted data.
"""
import json
import math
import os
import struct
import sys


def load_case(case_dir, json_name):
    with open(os.path.join(case_dir, json_name), "r", encoding="utf-8") as f:
        meta = json.load(f)
    D = int(meta["detectors"])
    angles = [float(v) for v in meta["angles"]]
    offset = [float(v) for v in meta["offset"]]
    ds = float(meta["ds"])
    W = int(meta["width"])
    H = int(meta["height"])
    ps = float(meta["pixel_size"])
    if not (len(angles) == len(offset)):
        raise ValueError("angles/offset length mismatch")
    if D > 257 or len(angles) > 180 or W > 256 or H > 256:
        raise ValueError("spec limit exceeded")
    raw_path = os.path.join(case_dir, meta["data"])
    with open(raw_path, "rb") as f:
        raw = f.read()
    n = len(raw) // 4
    if n != len(angles) * D:
        raise ValueError("raw float count %d != angles*detectors %d"
                         % (n, len(angles) * D))
    p = list(struct.unpack("<%df" % n, raw))
    sino = [p[r * D:(r + 1) * D] for r in range(len(angles))]
    return meta, D, angles, offset, ds, W, H, ps, sino


def sort_angles(angles, offset, sino):
    # reject exact duplicates (after sort, any equal pair)
    order = sorted(range(len(angles)), key=lambda i: angles[i])
    sa = [angles[i] for i in order]
    so = [offset[i] for i in order]
    sp = [sino[i] for i in order]
    for a, b in zip(sa, sa[1:]):
        if a == b:
            raise ValueError("duplicate angle rejected: %r" % a)
    return sa, so, sp


def angle_weights(angles):
    """Circular distance on period pi; weight = half sum of the two adjacent
    gaps. Single angle gets weight pi."""
    n = len(angles)
    if n == 1:
        return [math.pi]
    w = [0.0] * n
    for i in range(n):
        prev = angles[(i - 1) % n]
        nxt = angles[(i + 1) % n]
        gap_lo = (angles[i] - prev) % math.pi
        gap_hi = (nxt - angles[i]) % math.pi
        w[i] = 0.5 * (gap_lo + gap_hi)
    return w


def ramlak_kernel(D, ds):
    """h[0]=1/(4 ds^2); even n!=0 -> 0; odd n -> -1/(pi^2 n^2 ds^2).
    Returned indexed n = 0..D-1 (symmetric, h[-n]=h[n])."""
    h = [0.0] * D
    h[0] = 0.25 / (ds * ds)
    c = -1.0 / (math.pi * math.pi * ds * ds)
    for n in range(1, D):
        if n % 2 == 1:
            h[n] = c / (n * n)
    return h


def filter_row(p, h, ds):
    """q[k] = ds * sum_j h[k-j] p[j], full linear convolution (no circular
    wrap) evaluated at detector indices k in 0..D-1. The kernel is symmetric,
    h[-n] = h[n], so every j in 0..D-1 contributes via h[|k-j|]."""
    D = len(p)
    q = [0.0] * D
    for k in range(D):
        acc = 0.0
        for j in range(D):
            acc += h[abs(k - j)] * p[j]
        q[k] = ds * acc
    return q


def interp0(q, t):
    """q(t): linear interpolation between adjacent detector samples;
    0 outside [0, D-1] (no extrapolation)."""
    D = len(q)
    if t < 0.0 or t > D - 1:
        return 0.0
    k = int(math.floor(t))
    if k == D - 1:
        return q[D - 1]
    f = t - k
    return q[k] * (1.0 - f) + q[k + 1] * f


def backproject(rows_q, angles, offsets, weights, ds, W, H, ps,
                extra_offset=0.0):
    """f(x,y) = sum_theta weight * q((x cos + y sin)/ds + (D-1)/2
    + offset[row] + extra_offset)."""
    D = len(rows_q[0])
    out = [[0.0] * W for _ in range(H)]
    cx = (W - 1) / 2.0
    cy = (H - 1) / 2.0
    base = (D - 1) / 2.0
    for row in range(H):
        y = (cy - row) * ps
        for col in range(W):
            x = (col - cx) * ps
            acc = 0.0
            for i, theta in enumerate(angles):
                t = ((x * math.cos(theta) + y * math.sin(theta)) / ds
                     + base + offsets[i] + extra_offset)
                acc += weights[i] * interp0(rows_q[i], t)
            out[row][col] = acc
    return out


def reconstruct(case_dir, json_name, filtered=True, extra_offset=0.0,
                W=None, H=None, ps=None):
    (meta, D, angles, offset, ds, W0, H0, ps0, sino) = load_case(
        case_dir, json_name)
    W = W0 if W is None else W
    H = H0 if H is None else H
    ps = ps0 if ps is None else ps
    sa, so, sp = sort_angles(angles, offset, sino)
    w = angle_weights(sa)
    if filtered:
        h = ramlak_kernel(D, ds)
        rows_q = [filter_row(p, h, ds) for p in sp]
    else:
        rows_q = [list(p) for p in sp]
    img = backproject(rows_q, sa, so, w, ds, W, H, ps, extra_offset)
    return img, (sa, so, sp, w, rows_q, meta)


def main():
    case_dir = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else case_dir
    os.makedirs(out_dir, exist_ok=True)

    # ---- impulse exact check ----
    img, _ = reconstruct(case_dir, "impulse.json", filtered=True)
    got = img[0]
    with open(os.path.join(case_dir, "impulse-expected.json")) as f:
        exp = json.load(f)["ram_lak_reconstruction"]
    print("impulse row:", got)
    print("expected   :", exp)
    ok = all(abs(a - b) <= 1e-12 for a, b in zip(got, exp))
    print("IMPULSE MATCH:", ok)

    # ---- duplicate angle rejection ----
    try:
        reconstruct(case_dir, "duplicate-angle.json")
        print("DUPLICATE CHECK: FAILED (no rejection)")
    except ValueError as e:
        print("DUPLICATE CHECK: rejected ->", e)

    # ---- phantom: filtered and unfiltered ----
    for tag, filtered in (("ramlak", True), ("unfilt", False)):
        img, aux = reconstruct(case_dir, "phantom.json", filtered=filtered)
        flat = [v for row in img for v in row]
        path = os.path.join(out_dir, "phantom-%s-ref.raw" % tag)
        with open(path, "wb") as f:
            f.write(struct.pack("<%df" % len(flat), *flat))
        # float64 sidecar for strict cross-language arithmetic comparison
        with open(os.path.join(out_dir, "phantom-%s-ref.f64" % tag), "wb") as f:
            f.write(struct.pack("<%dd" % len(flat), *flat))
        print("phantom %s: min=%.6f max=%.6f sum=%.6f -> %s"
              % (tag, min(flat), max(flat), sum(flat), path))


if __name__ == "__main__":
    main()
