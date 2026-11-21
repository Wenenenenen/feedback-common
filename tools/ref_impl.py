#!/usr/bin/env python3
"""Reference implementation of the scale-normalized LoG blob convention.

Run with -I and explicit paths; this script is kept outside the data dir.
"""
import argparse
import json
import math
import struct


def load_raw(path, dtype, count):
    with open(path, "rb") as f:
        buf = f.read()
    if dtype == "f32":
        assert len(buf) == count * 4
        return list(struct.unpack("<%df" % count, buf))
    if dtype == "u8":
        assert len(buf) == count
        return list(buf)
    raise ValueError(dtype)


def gauss_axis(sigma, spacing):
    r = math.ceil(3.0 * sigma / spacing)
    g = [math.exp(-((i * spacing) ** 2) / (2.0 * sigma * sigma))
         for i in range(-r, r + 1)]
    s = sum(g)
    g = [v / s for v in g]
    # second-order kernel D = (r^2/sigma^4 - 1/sigma^2) G, zero-DC corrected
    d = []
    for i, gv in zip(range(-r, r + 1), g):
        rr = i * spacing
        d.append((rr * rr / sigma ** 4 - 1.0 / sigma ** 2) * gv)
    ds = sum(d)
    d = [dv - ds * gv for dv, gv in zip(d, g)]
    return r, g, d


def convolve_valid(img, mask, w, h, kx, ky):
    """Separable convolution; output valid only where full footprint is in
    bounds and every footprint pixel is inside the mask."""
    rx, gx, dx = kx
    ry, gy, dy = ky
    out = [0.0] * (w * h)
    valid = [False] * (w * h)
    tmp = [0.0] * (w * h)
    # vertical kernel (y axis), horizontal kernel (x axis)
    terms = (((ry, dy), (rx, gx)), ((ry, gy), (rx, dx)))
    for k1, k2 in terms:
        r1, k_vert = k1   # y axis kernel
        r2, k_horz = k2   # x axis kernel
        # pass 1: vertical into tmp
        for row in range(h):
            for col in range(w):
                acc = 0.0
                ok = True
                if row - r1 < 0 or row + r1 >= h:
                    ok = False
                else:
                    for i, kv in enumerate(k_vert):
                        acc += kv * img[(row - r1 + i) * w + col]
                tmp[row * w + col] = acc if ok else 0.0
        # pass 2: horizontal
        for row in range(h):
            for col in range(w):
                if col - r2 < 0 or col + r2 >= w:
                    continue
                # full rectangular footprint must be inside mask
                fr0, fr1 = row - r1, row + r1
                fc0, fc1 = col - r2, col + r2
                if fr0 < 0 or fr1 >= h or fc0 < 0 or fc1 >= w:
                    continue
                m_ok = True
                for rr in range(fr0, fr1 + 1):
                    base = rr * w
                    for cc in range(fc0, fc1 + 1):
                        if not mask[base + cc]:
                            m_ok = False
                            break
                    if not m_ok:
                        break
                if not m_ok:
                    continue
                acc = 0.0
                base = row * w
                for j, kh in enumerate(k_horz):
                    acc += kh * tmp[base + (col - r2 + j)]
                out[base + col] += acc
                valid[base + col] = True
    return out, valid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    args = ap.parse_args()
    dd = args.data_dir
    with open(dd + "/image.json") as f:
        meta = json.load(f)
    w, h = meta["w"], meta["h"]
    dx, dy = meta["dx"], meta["dy"]
    sigma0, ratio, levels = meta["sigma0"], meta["ratio"], meta["levels"]
    thr = meta["threshold"]
    n = w * h
    img = load_raw(dd + "/spots.f32", "f32", n)
    try:
        mraw = load_raw(dd + "/mask.u8", "u8", n)
        mask = [bool(v) for v in mraw]
    except FileNotFoundError:
        mask = [True] * n

    volumes = []
    for k in range(levels):
        sigma = sigma0 * ratio ** k
        kx = gauss_axis(sigma, dx)
        ky = gauss_axis(sigma, dy)
        conv, valid = convolve_valid(img, mask, w, h, kx, ky)
        resp = [-sigma * sigma * conv[i] for i in range(n)]
        volumes.append((resp, valid, sigma))
        print("level %d sigma=%.4f rx=%d ry=%d nvalid=%d"
              % (k, sigma, kx[0], ky[0], sum(valid)))

    def at(k, r, c):
        resp, valid, _ = volumes[k]
        if r < 0 or r >= h or c < 0 or c >= w or not valid[r * w + c]:
            return None
        return resp[r * w + c]

    peaks = []
    for k in range(1, levels - 1):
        resp, valid, sigma = volumes[k]
        for r in range(h):
            for c in range(w):
                idx = r * w + c
                if not valid[idx]:
                    continue
                v0 = resp[idx]
                # gather 26 neighbours, all must be valid
                neigh = []
                ok = True
                for dk in (-1, 0, 1):
                    for dr in (-1, 0, 1):
                        for dc in (-1, 0, 1):
                            if dk == 0 and dr == 0 and dc == 0:
                                continue
                            nv = at(k + dk, r + dr, c + dc)
                            if nv is None:
                                ok = False
                                break
                            neigh.append((nv, dk, dr, dc))
                        if not ok:
                            break
                    if not ok:
                        break
                if not ok:
                    continue
                kind = "bright" if v0 > 0 else ("dark" if v0 < 0 else None)
                if kind is None:
                    continue
                det0 = v0 if kind == "bright" else -v0
                if det0 < thr:
                    continue
                # lexicographically-smallest argmax in 3x3x3
                is_peak = True
                for nv, dk, dr, dc in neigh:
                    nd = nv if kind == "bright" else -nv
                    if nd > det0 or (nd == det0 and (dk, dr, dc) < (0, 0, 0)):
                        is_peak = False
                        break
                if is_peak:
                    peaks.append((k, r, c, v0, kind))

    print("\n%d raw peaks" % len(peaks))
    for k, r, c, v0, kind in peaks:
        # 3D quadratic refinement on detection volume (R bright, -R dark)
        s0 = v0 if kind == "bright" else -v0

        def sgn(dk, dr, dc):
            v = at(k + dk, r + dr, c + dc)
            return v if kind == "bright" else -v
        gz = (sgn(1, 0, 0) - sgn(-1, 0, 0)) / 2.0
        gy = (sgn(0, 1, 0) - sgn(0, -1, 0)) / 2.0
        gx = (sgn(0, 0, 1) - sgn(0, 0, -1)) / 2.0
        hzz = sgn(1, 0, 0) - 2 * s0 + sgn(-1, 0, 0)
        hyy = sgn(0, 1, 0) - 2 * s0 + sgn(0, -1, 0)
        hxx = sgn(0, 0, 1) - 2 * s0 + sgn(0, 0, -1)
        hzy = (sgn(1, 1, 0) - sgn(1, -1, 0) - sgn(-1, 1, 0) + sgn(-1, -1, 0)) / 4.0
        hzx = (sgn(1, 0, 1) - sgn(1, 0, -1) - sgn(-1, 0, 1) + sgn(-1, 0, -1)) / 4.0
        hyx = (sgn(0, 1, 1) - sgn(0, 1, -1) - sgn(0, -1, 1) + sgn(0, -1, -1)) / 4.0
        H = [[hzz, hzy, hzx], [hzy, hyy, hyx], [hzx, hyx, hxx]]
        g = [gz, gy, gx]
        # solve H delta = -g via Gaussian elimination
        A = [row[:] + [-g[i]] for i, row in enumerate(H)]
        singular = False
        for i in range(3):
            piv = max(range(i, 3), key=lambda q: abs(A[q][i]))
            if abs(A[piv][i]) < 1e-12:
                singular = True
                break
            A[i], A[piv] = A[piv], A[i]
            for q in range(i + 1, 3):
                f = A[q][i] / A[i][i]
                for t in range(i, 4):
                    A[q][t] -= f * A[i][t]
        refined = False
        delta = [0.0, 0.0, 0.0]
        if not singular:
            # negative definite? Sylvester: D1<0, D2>0, D3<0
            d1 = H[0][0]
            d2 = H[0][0] * H[1][1] - H[0][1] ** 2
            d3 = (H[0][0] * (H[1][1] * H[2][2] - H[1][2] ** 2)
                  - H[0][1] * (H[0][1] * H[2][2] - H[1][2] * H[0][2])
                  + H[0][2] * (H[0][1] * H[1][2] - H[1][1] * H[0][2]))
            neg_def = d1 < 0 and d2 > 0 and d3 < 0
            for i in (2, 1, 0):
                s = A[i][3]
                for j in range(i + 1, 3):
                    s -= A[i][j] * delta[j]
                delta[i] = s / A[i][i]
            if neg_def and all(abs(d) <= 1.0 for d in delta):
                refined = True
        center_val = v0 if kind == "bright" else -v0
        rresp = center_val + 0.5 * (gz * delta[0] + gy * delta[1] + gx * delta[2])
        rk = k + delta[0]
        rr_ = r + delta[1]
        cc_ = c + delta[2]
        sigma_r = sigma0 * ratio ** rk
        print("%s k=%d row=%d col=%d resp=%.4f refined=%s" % (kind, k, r, c, v0, refined))
        if refined:
            print("   phys=(%.3f, %.3f) sigma=%.3f resp_r=%.4f delta=(%.3f,%.3f,%.3f)"
                  % (cc_ * dx, rr_ * dy, sigma_r,
                     rresp if kind == "bright" else -rresp,
                     delta[0], delta[1], delta[2]))
        else:
            print("   phys=(%.3f, %.3f) sigma=%.3f"
                  % (c * dx, r * dy, sigma))


if __name__ == "__main__":
    main()
