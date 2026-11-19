#!/usr/bin/env python3
"""Reference implementation of the homogeneous rasterization pipeline.

Run with: python3 -I raster_ref.py <input.json> [--check reference.json]
Pure Python, no graphics API / third-party packages.
"""
import json
import math
import sys

EPS_W = 1e-12
EPS_AREA = 1e-12

# Six clip planes in homogeneous clip space: -w<=x<=w, -w<=y<=w, 0<=z<=w
# Each plane gives a signed distance d so that inside <=> d >= 0.
PLANES = (
    ("left",   lambda v: v[0][3] + v[0][0]),          # w + x >= 0
    ("right",  lambda v: v[0][3] - v[0][0]),          # w - x >= 0
    ("bottom", lambda v: v[0][3] + v[0][1]),          # w + y >= 0
    ("top",    lambda v: v[0][3] - v[0][1]),          # w - y >= 0
    ("near",   lambda v: v[0][2]),                    # z >= 0
    ("far",    lambda v: v[0][3] - v[0][2]),          # w - z >= 0
)


def lerp(a, b, t):
    return a + (b - a) * t


def clip_polygon(poly):
    """Sutherland-Hodgman against six planes. Vertices are [x, rgb]."""
    for _, dist in PLANES:
        if not poly:
            break
        out = []
        n = len(poly)
        for i in range(n):
            cur = poly[i]
            prev = poly[i - 1]
            dc = dist(cur)
            dp = dist(prev)
            cur_in = dc >= 0.0
            prev_in = dp >= 0.0
            if cur_in:
                if not prev_in:
                    t = dp / (dp - dc)  # crossing prev -> cur
                    out.append([
                        [lerp(prev[0][k], cur[0][k], t) for k in range(4)],
                        [lerp(prev[1][k], cur[1][k], t) for k in range(3)],
                    ])
                out.append(cur)
            elif prev_in:
                t = dp / (dp - dc)
                out.append([
                    [lerp(prev[0][k], cur[0][k], t) for k in range(4)],
                    [lerp(prev[1][k], cur[1][k], t) for k in range(3)],
                ])
        poly = out
    return poly


def rasterize(scene):
    width = int(scene["width"])
    height = int(scene["height"])
    verts = scene["vertices"]
    tris = scene["triangles"]

    # framebuffer
    face = [-1] * (width * height)
    depth = [math.inf] * (width * height)
    rgb = [[0.0, 0.0, 0.0] for _ in range(width * height)]
    detail = [None] * (width * height)  # per-pixel inspector data
    coverage_count = [0] * (width * height)  # fragments passing edge tests

    stats = {
        "totalFaces": len(tris),
        "invalidFaces": 0,
        "degenerateFaces": 0,
        "clippedFaces": 0,
        "drawnFaces": 0,
        "emittedTriangles": 0,
        "coveredPixels": 0,
        "depthRejected": 0,
    }

    for face_id, tri in enumerate(tris):
        if len(tri) != 3 or any(
                (not isinstance(idx, int) or isinstance(idx, bool))
                or idx < 0 or idx >= len(verts) for idx in tri):
            stats["invalidFaces"] += 1
            continue

        orig = [[list(verts[idx]["x"]), list(verts[idx]["rgb"])] for idx in tri]
        clipped = clip_polygon([[list(p[0]), list(p[1])] for p in orig])

        if len(clipped) < 3 or any(p[0][3] <= EPS_W for p in clipped):
            stats["degenerateFaces"] += 1
            continue

        # triangle fan triangulation of the convex clipped polygon
        sub_tris = [(0, k, k + 1) for k in range(1, len(clipped) - 1)]
        screen_tris = []
        for sub in sub_tris:
            pts = []
            for vi in sub:
                p = clipped[vi]
                x, y, z, w = p[0]
                sx = (x / w + 1.0) * width / 2.0
                sy = (1.0 - y / w) * height / 2.0
                pts.append({
                    "sx": sx, "sy": sy, "z": z, "w": w,
                    "rgb": p[1], "clip": p[0],
                })
            a0, b0, c0 = pts
            area = ((b0["sx"] - a0["sx"]) * (c0["sy"] - a0["sy"])
                    - (b0["sy"] - a0["sy"]) * (c0["sx"] - a0["sx"]))
            if abs(area) <= EPS_AREA:
                continue  # zero-area fan slice; face degenerate only if all are
            if area < 0:
                pts[1], pts[2] = pts[2], pts[1]
                area = -area
            screen_tris.append((pts, area))

        if not screen_tris:
            stats["degenerateFaces"] += 1
            continue

        if len(clipped) != 3:
            stats["clippedFaces"] += 1
        stats["drawnFaces"] += 1

        for (a, b, c), area in screen_tris:
            stats["emittedTriangles"] += 1

            # edge setup with top-left fill rule
            edges = []
            for p, q in ((a, b), (b, c), (c, a)):
                dx = q["sx"] - p["sx"]
                dy = q["sy"] - p["sy"]
                include = dy < 0.0 or (dy == 0.0 and dx > 0.0)
                edges.append((p, q, dx, dy, include))

            minx = max(0, int(math.floor(min(p["sx"] for p in (a, b, c)))))
            maxx = min(width - 1, int(math.ceil(max(p["sx"] for p in (a, b, c)))))
            miny = max(0, int(math.floor(min(p["sy"] for p in (a, b, c)))))
            maxy = min(height - 1, int(math.ceil(max(p["sy"] for p in (a, b, c)))))

            inv_area = 1.0 / area
            for py in range(miny, maxy + 1):
                px05 = py + 0.5
                row = py * width
                for px in range(minx, maxx + 1):
                    qx = px + 0.5
                    inside = True
                    weights = []
                    for p, qp, dx, dy, include in edges:
                        e = dx * (px05 - p["sy"]) - dy * (qx - p["sx"])
                        if e < 0.0 or (e == 0.0 and not include):
                            inside = False
                            break
                        weights.append(e * inv_area)
                    if not inside:
                        continue
                    # weights correspond to edges ab, bc, ca -> bary for c, a, b
                    lam = [weights[1], weights[2], weights[0]]
                    tri_pts = [a, b, c]
                    # perspective-correct interpolation
                    inv_w = [lam[i] / tri_pts[i]["w"] for i in range(3)]
                    denom = sum(inv_w)
                    col = [
                        sum(inv_w[i] * tri_pts[i]["rgb"][ch] for i in range(3))
                        / denom for ch in range(3)
                    ]
                    pf_depth = sum(
                        lam[i] * tri_pts[i]["z"] / tri_pts[i]["w"]
                        for i in range(3)
                    )

                    idx = row + px
                    coverage_count[idx] += 1
                    if pf_depth < depth[idx]:
                        if depth[idx] == math.inf:
                            stats["coveredPixels"] += 1
                        else:
                            stats["depthRejected"] += 1
                        depth[idx] = pf_depth
                        face[idx] = face_id
                        rgb[idx] = col
                        detail[idx] = {
                            "face": face_id,
                            "baryClip": lam,          # weights of clipped tri verts
                            "baryOrig": None,         # filled in below
                            "depth": pf_depth,
                            "rgb": col,
                            "sample": [qx, px05],
                            "verts": [
                                {"sx": p["sx"], "sy": p["sy"],
                                 "clip": p["clip"], "rgb": p["rgb"]}
                                for p in (a, b, c)
                            ],
                        }
    stats["multiCoveredPixels"] = sum(1 for c in coverage_count if c > 1)
    return {
        "width": width, "height": height,
        "face": face, "depth": depth, "rgb": rgb,
        "coverage": coverage_count, "detail": detail, "stats": stats,
    }


def build_export(res):
    pixels = []
    for i in range(res["width"] * res["height"]):
        f = res["face"][i]
        if f < 0:
            pixels.append({"face": -1, "depth": None, "rgb": [0, 0, 0]})
        else:
            pixels.append({
                "face": f,
                "depth": res["depth"][i],
                "rgb": res["rgb"][i],
            })
    out = {"width": res["width"], "height": res["height"], "pixels": pixels}
    out["coverage"] = res["coverage"]
    return out


def main():
    scene_path = sys.argv[1]
    with open(scene_path, "r", encoding="utf-8") as f:
        scene = json.load(f)
    res = rasterize(scene)
    print(json.dumps(res["stats"], indent=2))
    if "--export" in sys.argv:
        out_path = sys.argv[sys.argv.index("--export") + 1]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(build_export(res), f)
        print("exported", out_path)
    if "--check" in sys.argv:
        ref_path = sys.argv[sys.argv.index("--check") + 1]
        with open(ref_path, "r", encoding="utf-8") as f:
            ref = json.load(f)
        checks = []

        # shared-edge: 16 covered, coverage exactly 1 per pixel
        if "shared-edge" in scene_path:
            r = ref["shared-edge"]
            checks.append(("shared-edge covered",
                           res["stats"]["coveredPixels"] == r["covered"],
                           (res["stats"]["coveredPixels"], r["covered"])))
            checks.append(("shared-edge max coverage==1",
                           max(res["coverage"]) == r["coverage_per_pixel"],
                           (max(res["coverage"]), r["coverage_per_pixel"])))

        if "perspective" in scene_path:
            p0 = res["detail"][0]
            r = ref["perspective_0_0"]
            ok_rgb = all(abs(p0["rgb"][i] - r["rgb"][i]) < 1e-12 for i in range(3))
            ok_d = abs(p0["depth"] - r["depth"]) < 1e-12
            checks.append(("perspective (0,0) rgb", ok_rgb, (p0["rgb"], r["rgb"])))
            checks.append(("perspective (0,0) depth", ok_d,
                           (p0["depth"], r["depth"])))

        if "equal-depth" in scene_path:
            owner = ref["equal-depth"]["overlap_owner"]
            owners = set(f for f in res["face"] if f >= 0)
            checks.append(("equal-depth only face 0 wins",
                           owners == {owner}, (sorted(owners), owner)))

        if "degenerate" in scene_path:
            checks.append(("degenerate ignored",
                           res["stats"]["degenerateFaces"]
                           == ref["degenerate"]["ignored"],
                           (res["stats"]["degenerateFaces"],
                            ref["degenerate"]["ignored"])))

        ok_all = True
        for name, ok, vals in checks:
            print(("PASS" if ok else "FAIL"), name, vals)
            ok_all = ok_all and ok
        sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
