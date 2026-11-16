#!/usr/bin/env python3
"""Protype: verify UV audit math against samples/extracted/expected.json.
Run: python3 -I tools/proto_verify.py <path-to-audit.json> <path-to-expected.json>
"""
import json
import math
import sys

EPS_DEG = 1e-12
EPS_OVL = 1e-8
EPS_BOUND = 1e-10


def cross2(a, b):
    return a[0] * b[1] - a[1] * b[0]


def sub(a, b):
    return [a[0] - b[0], a[1] - b[1]]


def tri_area_signed(p, q, r):
    return cross2(sub(q, p), sub(r, p)) * 0.5


def face_metrics(v, idx, uv):
    a = v[idx[0]]
    b = v[idx[1]]
    c = v[idx[2]]
    e1 = [b[i] - a[i] for i in range(3)]
    e2 = [c[i] - a[i] for i in range(3)]
    cr = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ]
    area3 = 0.5 * math.sqrt(sum(x * x for x in cr))
    p0, p1, p2 = uv
    signed_uv = tri_area_signed(p0, p1, p2)
    area_uv = abs(signed_uv)
    degenerate = area3 <= EPS_DEG or area_uv <= EPS_DEG
    mirrored = signed_uv < 0
    outside = any(not (0.0 <= u <= 1.0 and 0.0 <= w <= 1.0) for u, w in uv)
    res = {
        "area3": area3,
        "area_uv": area_uv,
        "degenerate": degenerate,
        "mirrored": mirrored,
        "outside": outside,
    }
    if degenerate:
        return res
    res["area_ratio"] = area_uv / area3
    # orthonormal basis on the 3D face plane
    n = [x / (2 * area3) for x in cr]  # unit normal
    l1 = math.sqrt(sum(x * x for x in e1))
    ux = [x / l1 for x in e1]
    uy = [n[1] * ux[2] - n[2] * ux[1],
          n[2] * ux[0] - n[0] * ux[2],
          n[0] * ux[1] - n[1] * ux[0]]
    # 2D coords of edges in plane
    x1 = [sum(ux[i] * e1[i] for i in range(3)), sum(uy[i] * e1[i] for i in range(3))]
    x2 = [sum(ux[i] * e2[i] for i in range(3)), sum(uy[i] * e2[i] for i in range(3))]
    # UV edge vectors
    d1 = sub(p1, p0)
    d2 = sub(p2, p0)
    det = x1[0] * x2[1] - x1[1] * x2[0]
    j00 = (d1[0] * x2[1] - d2[0] * x1[1]) / det
    j01 = (d2[0] * x1[0] - d1[0] * x2[0]) / det
    j10 = (d1[1] * x2[1] - d2[1] * x1[1]) / det
    j11 = (d2[1] * x1[0] - d1[1] * x2[0]) / det
    # SVD of 2x2 J
    jtj00 = j00 * j00 + j10 * j10
    jtj01 = j00 * j01 + j10 * j11
    jtj11 = j01 * j01 + j11 * j11
    tr = jtj00 + jtj11
    disc = max(0.0, 0.25 * (tr * tr) - (jtj00 * jtj11 - jtj01 * jtj01))
    l_hi = math.sqrt(0.5 * tr + math.sqrt(disc))
    l_lo = math.sqrt(max(0.0, 0.5 * tr - math.sqrt(disc)))
    res["sv"] = [l_hi, l_lo]
    res["stretch"] = l_hi / l_lo if l_lo > EPS_DEG else math.inf
    return res


def clip_polygon(subject, clip):
    """Sutherland-Hodgman; clip is CCW triangle."""
    out = subject
    for i in range(3):
        a = clip[i]
        b = clip[(i + 1) % 3]
        edge = sub(b, a)
        if not out:
            return []
        inp = out
        out = []
        prev = inp[-1]
        prev_in = cross2(edge, sub(prev, a)) >= -EPS_BOUND
        for cur in inp:
            cur_in = cross2(edge, sub(cur, a)) >= -EPS_BOUND
            if cur_in != prev_in:
                pe = sub(cur, prev)
                t = cross2(sub(a, prev), edge) / cross2(pe, edge)
                out.append([prev[0] + t * pe[0], prev[1] + t * pe[1]])
            if cur_in:
                out.append(cur)
            prev, prev_in = cur, cur_in
    return out


def poly_area(poly):
    if len(poly) < 3:
        return 0.0
    s = 0.0
    for i in range(len(poly)):
        s += cross2(poly[i], poly[(i + 1) % len(poly)])
    return abs(s) * 0.5


def overlap_pairs(faces_uv, valid):
    n = len(faces_uv)
    res = []
    oriented = []
    for i in range(n):
        t = faces_uv[i]
        if valid[i] and tri_area_signed(t[0], t[1], t[2]) < 0:
            t = [t[0], t[2], t[1]]
        oriented.append(t)
    for i in range(n):
        if not valid[i]:
            continue
        for j in range(i + 1, n):
            if not valid[j]:
                continue
            poly = clip_polygon(oriented[i], oriented[j])
            area = poly_area(poly)
            if area > EPS_OVL:
                res.append((i, j, area))
    return res


def build_mask(faces_uv, valid, size=256):
    mask = [[0] * size for _ in range(size)]
    n = len(faces_uv)
    oriented = []
    for i in range(n):
        t = faces_uv[i]
        if valid[i] and tri_area_signed(t[0], t[1], t[2]) < 0:
            t = [t[0], t[2], t[1]]
        oriented.append(t)
    for r in range(size):
        for c in range(size):
            px = (c + 0.5) / size
            py = 1.0 - (r + 0.5) / size
            interior = 0
            boundary_min = None
            for i in range(n):
                if not valid[i]:
                    continue
                t = oriented[i]
                d0 = cross2(sub(t[1], t[0]), sub((px, py), t[0]))
                d1 = cross2(sub(t[2], t[1]), sub((px, py), t[1]))
                d2 = cross2(sub(t[0], t[2]), sub((px, py), t[2]))
                if d0 > EPS_BOUND and d1 > EPS_BOUND and d2 > EPS_BOUND:
                    interior += 1
                elif d0 >= -EPS_BOUND and d1 >= -EPS_BOUND and d2 >= -EPS_BOUND:
                    if boundary_min is None or i < boundary_min:
                        boundary_min = i
            count = interior + (1 if boundary_min is not None else 0)
            if count >= 2:
                mask[r][c] = 1
    return mask


def main():
    data = json.load(open(sys.argv[1]))
    expected = json.load(open(sys.argv[2]))
    v = data["vertices"]
    metrics = [face_metrics(v, f, uv) for f, uv in zip(data["faces"], data["uv"])]
    valid = [not m["degenerate"] for m in metrics]
    print("degenerate:", [i for i, m in enumerate(metrics) if m["degenerate"]])
    print("mirrored:", [i for i, m in enumerate(metrics) if m.get("mirrored")])
    print("outside:", [i for i, m in enumerate(metrics) if m.get("outside")])
    for k in ("face0", "face2"):
        idx = int(k[4:])
        m = metrics[idx]
        exp = expected[k]
        print(k, "ratio", m["area_ratio"], "exp", exp["area_ratio"],
              "sv", m["sv"], "exp", exp["singular_values"],
              "stretch", m["stretch"], "exp", exp["stretch_ratio"])
    ovl = overlap_pairs(data["uv"], valid)
    print("overlaps:", ovl)
    print("expected:", expected["overlaps"])
    mask = build_mask(data["uv"], valid)
    covered = sum(sum(row) for row in mask)
    print("mask covered px:", covered)


if __name__ == "__main__":
    main()
