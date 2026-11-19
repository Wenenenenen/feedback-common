#!/usr/bin/env python3
"""Independent cross-checks for raster_ref.py.

Rasterization is verified against NDC-space point-in-convex-polygon tests
(independently written), and interpolated values are recomputed with an
independent determinant formulation. Run: python3 -I verify_independent.py <case.json>
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import raster_ref as rr


def ndc_of(px, py, w, h):
    return (2.0 * (px + 0.5) / w - 1.0, 1.0 - 2.0 * (py + 0.5) / h)


def point_in_poly_2d(pt, poly_ndc):
    """Return ('in'|'edge'|'out') for a convex ordered polygon."""
    signs = []
    n = len(poly_ndc)
    for i in range(n):
        ax, ay = poly_ndc[i]
        bx, by = poly_ndc[(i + 1) % n]
        cross = (bx - ax) * (pt[1] - ay) - (by - ay) * (pt[0] - ax)
        if cross != 0.0:
            signs.append(1 if cross > 0 else -1)
    if not signs:
        return "edge"
    if all(s > 0 for s in signs) or all(s < 0 for s in signs):
        return "in" if len(signs) == n else "edge"
    return "out"


def independent_bary(px, py, tri):
    """Screen-space barycentrics via 2x2 determinants, independent code path."""
    a, b, c = tri
    qx, qy = px + 0.5, py + 0.5
    det = (b["sx"] - a["sx"]) * (c["sy"] - a["sy"]) - \
          (b["sy"] - a["sy"]) * (c["sx"] - a["sx"])
    assert det > 0, "tri must be CCW"
    m00 = c["sy"] - a["sy"]
    m01 = a["sx"] - c["sx"]
    m10 = a["sy"] - b["sy"]
    m11 = b["sx"] - a["sx"]
    dx = qx - a["sx"]
    dy = qy - a["sy"]
    lb = (m00 * dx + m01 * dy) / det
    lc = (m10 * dx + m11 * dy) / det
    la = 1.0 - lb - lc
    return la, lb, lc


def build_screen_tris(clipped, w, h):
    screen_tris = []
    for k in range(1, len(clipped) - 1):
        pts = []
        for vi in (0, k, k + 1):
            x, y, z, ww = clipped[vi][0]
            pts.append({
                "sx": (x / ww + 1) * w / 2,
                "sy": (1 - y / ww) * h / 2,
                "z": z, "w": ww, "rgb": clipped[vi][1],
            })
        area = ((pts[1]["sx"] - pts[0]["sx"]) * (pts[2]["sy"] - pts[0]["sy"])
                - (pts[1]["sy"] - pts[0]["sy"]) * (pts[2]["sx"] - pts[0]["sx"]))
        if abs(area) <= rr.EPS_AREA:
            continue
        if area < 0:
            pts[1], pts[2] = pts[2], pts[1]
        screen_tris.append(pts)
    return screen_tris


def main():
    scene = json.load(open(sys.argv[1], encoding="utf-8"))
    res = rr.rasterize(scene)
    w, h = res["width"], res["height"]
    failures = []

    verts = scene["vertices"]
    for face_id, tri in enumerate(scene["triangles"]):
        if len(tri) != 3 or any(
                (not isinstance(i, int) or isinstance(i, bool))
                or i < 0 or i >= len(verts) for i in tri):
            continue
        poly = [[list(verts[i]["x"]), list(verts[i]["rgb"])] for i in tri]
        clipped = rr.clip_polygon(poly)
        if len(clipped) < 3 or any(p[0][3] <= rr.EPS_W for p in clipped):
            continue
        poly_ndc = [(p[0][0] / p[0][3], p[0][1] / p[0][3]) for p in clipped]

        # clipping invariants
        for p in clipped:
            for name, dist in rr.PLANES:
                if dist(p) < -1e-12:
                    failures.append(f"face {face_id}: clipped vertex outside {name}")
            if p[0][3] <= rr.EPS_W:
                failures.append(f"face {face_id}: non-positive w survived")

        screen_tris = build_screen_tris(clipped, w, h)

        for py in range(h):
            for px in range(w):
                idx = py * w + px
                ndc = ndc_of(px, py, w, h)
                kind = point_in_poly_2d(ndc, poly_ndc)
                covered_here = res["face"][idx] == face_id

                if kind == "in" and res["face"][idx] < 0:
                    failures.append(
                        f"face {face_id}: MISSING strictly-inside pixel ({px},{py})")
                if covered_here and kind == "out":
                    failures.append(
                        f"face {face_id}: pixel ({px},{py}) outside polygon filled")
                if not covered_here:
                    continue

                for tri_pts in screen_tris:
                    la, lb, lc = independent_bary(px, py, tri_pts)
                    if min(la, lb, lc) < -1e-9:
                        continue
                    lam = (la, lb, lc)
                    iw = [lam[i] / tri_pts[i]["w"] for i in range(3)]
                    den = sum(iw)
                    for ch in range(3):
                        val = sum(iw[i] * tri_pts[i]["rgb"][ch]
                                  for i in range(3)) / den
                        if abs(val - res["rgb"][idx][ch]) > 1e-10:
                            failures.append(
                                f"face {face_id} ({px},{py}) ch{ch} rgb mismatch")
                    d = sum(lam[i] * tri_pts[i]["z"] / tri_pts[i]["w"]
                            for i in range(3))
                    if abs(d - res["depth"][idx]) > 1e-10:
                        failures.append(
                            f"face {face_id} ({px},{py}) depth mismatch")
                    if not (0.0 <= d <= 1.0 + 1e-12):
                        failures.append(
                            f"face {face_id} ({px},{py}) depth {d} outside [0,1]")
                    break

    # shared-edge rule: each geometric edge may only fill a pixel once per
    # overlapping geometry, but equal-depth duplicate faces may cover twice
    # while the framebuffer is still written exactly once.
    writes = sum(1 for f in res["face"] if f >= 0)
    if writes != res["stats"]["coveredPixels"]:
        failures.append("covered-pixel stat inconsistent with framebuffer")

    for idx, d in enumerate(res["depth"]):
        if res["face"][idx] >= 0 and not math.isfinite(d):
            failures.append(f"pixel {idx} has face but non-finite depth")

    if failures:
        print(f"FAIL {sys.argv[1]}: {len(failures)} failures")
        for f in failures[:20]:
            print(" -", f)
        sys.exit(1)
    print(f"PASS {sys.argv[1]}: {res['stats']['coveredPixels']} covered pixels, "
          f"all containment/value/depth invariants hold")


if __name__ == "__main__":
    main()
