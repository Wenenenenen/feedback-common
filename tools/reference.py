#!/usr/bin/env python3
"""Reference implementation of the clustered point-light inspector rules.

Pure stdlib. Run with: python3 -I tools/reference.py <case.json>
Prints a JSON summary of ground-truth clustering and shading values.
"""
import json
import math
import sys

EPS_PLANE = 1e-9
D2_FLOOR = 1e-4
D_ZERO = 1e-10


def build_case(d):
    W, H = d["width"], d["height"]
    ts = d["tile_size"]
    slices = d["slices"]
    near, far = d["near"], d["far"]
    fov = math.radians(d["fov_y"])
    tan_half = math.tan(fov / 2.0)
    aspect = W / H
    ntx = (W + ts - 1) // ts
    nty = (H + ts - 1) // ts

    # log depth edges, far belongs to the last slice
    edges = [near * (far / near) ** (k / slices) for k in range(slices + 1)]

    lights = []
    invalid = []
    for L in d["lights"]:
        if not (isinstance(L.get("radius"), (int, float)) and L["radius"] > 0):
            invalid.append(L.get("id"))
            continue
        lights.append(L)
    lights.sort(key=lambda L: L["id"])

    # cluster planes: six inward planes [nx,ny,nz,dd], normal normalized
    clusters = []
    for ty in range(nty):
        for tx in range(ntx):
            for s in range(slices):
                x0 = tx * ts
                x1 = min((tx + 1) * ts, W)
                y0 = ty * ts
                y1 = min((ty + 1) * ts, H)
                l = (2.0 * (x0 + 0.5) / W - 1.0) * tan_half * aspect
                r = (2.0 * (x1 - 1.0 + 0.5) / W - 1.0) * tan_half * aspect
                # y pixel 0 is top; b is the lower edge slope, t the upper
                b = (1.0 - 2.0 * (y1 - 1.0 + 0.5) / H) * tan_half
                t = (1.0 - 2.0 * (y0 + 0.5) / H) * tan_half
                zk, zk1 = edges[s], edges[s + 1]
                planes = []
                for n4 in (
                    (1.0, 0.0, -l, 0.0),
                    (-1.0, 0.0, r, 0.0),
                    (0.0, 1.0, -b, 0.0),
                    (0.0, -1.0, t, 0.0),
                    (0.0, 0.0, 1.0, -zk),
                    (0.0, 0.0, -1.0, zk1),
                ):
                    nx, ny, nz, dd = n4
                    inv = 1.0 / math.sqrt(nx * nx + ny * ny + nz * nz)
                    planes.append((nx * inv, ny * inv, nz * inv, dd * inv))
                clusters.append(
                    dict(tx=tx, ty=ty, s=s, planes=planes, members=[])
                )

    # conservative sphere test against every plane
    for L in lights:
        cx, cy, cz = L["position"]
        rad = L["radius"]
        for c in clusters:
            inside = True
            for nx, ny, nz, dd in c["planes"]:
                if nx * cx + ny * cy + nz * cz + dd < -rad - EPS_PLANE:
                    inside = False
                    break
            if inside:
                c["members"].append(L["id"])
    for c in clusters:
        c["members"].sort()

    # reconstruct view-space position of each pixel from depth
    depth = d["depth"]
    normals = d["normals"]
    albedo = d["albedo"]

    def pixel_cluster(px, py, z):
        tx = min(px // ts, ntx - 1)
        ty = min(py // ts, nty - 1)
        # left-closed right-open, far pinned to last slice
        s = slices - 1
        for k in range(slices):
            if z < edges[k + 1]:
                s = k
                break
        return ty * ntx * slices + tx * slices + s

    def shade(px, py, light_ids, count_evals=False):
        idx = py * W + px
        z = depth[idx]
        if z is None:
            return ([0.0, 0.0, 0.0], 0, 0, None) if count_evals else [0.0, 0.0, 0.0]
        x = (2.0 * (px + 0.5) / W - 1.0) * z * tan_half * aspect
        y = (1.0 - 2.0 * (py + 0.5) / H) * z * tan_half
        n = normals[idx]
        alb = albedo[idx]
        acc = [0.0, 0.0, 0]
        dist_tests = 0
        evals = 0
        for L in lights:
            if L["id"] not in light_ids:
                continue
            dist_tests += 1
            lx = L["position"][0] - x
            ly = L["position"][1] - y
            lz = L["position"][2] - z
            d2 = lx * lx + ly * ly + lz * lz
            r = L["radius"]
            if d2 >= r * r:
                continue
            evals += 1
            dist = math.sqrt(d2)
            if dist <= D_ZERO:
                continue
            nl = (n[0] * lx + n[1] * ly + n[2] * lz) / dist
            if nl <= 0.0:
                continue
            falloff = (1.0 - dist / r) ** 2 / max(d2, D2_FLOOR)
            for ch in range(3):
                acc[ch] += alb[ch] / math.pi * L["intensity"][ch] * nl * falloff
        cidx = pixel_cluster(px, py, z)
        if count_evals:
            return acc, dist_tests, evals, cidx
        return acc

    # clustered shading using built lists
    cluster_color = [None] * (W * H)
    cluster_evals = [0] * (W * H)
    cluster_tests = [0] * (W * H)
    pixel_cluster_idx = [None] * (W * H)
    for py in range(H):
        for px in range(W):
            i = py * W + px
            if depth[i] is None:
                cluster_color[i] = [0.0, 0.0, 0.0]
                continue
            cidx = pixel_cluster(px, py, depth[i])
            pixel_cluster_idx[i] = cidx
            ids = set(clusters[cidx]["members"])
            col, tests, evals, _ = shade(px, py, ids, True)
            cluster_color[i] = col
            cluster_tests[i] = tests
            cluster_evals[i] = evals

    # exhaustive ground truth: every valid light at every pixel
    all_ids = set(L["id"] for L in lights)
    ex_color = [None] * (W * H)
    ex_evals = [0] * (W * H)
    ex_tests = [0] * (W * H)
    max_err = 0.0
    for py in range(H):
        for px in range(W):
            i = py * W + px
            col, tests, evals, _ = shade(px, py, all_ids, True)
            ex_color[i] = col
            ex_tests[i] = tests
            ex_evals[i] = evals
            for ch in range(3):
                max_err = max(max_err, abs(col[ch] - cluster_color[i][ch]))

    counts = [len(c["members"]) for c in clusters]
    return {
        "dims": dict(W=W, H=H, tile_size=ts, slices=slices,
                     ntx=ntx, nty=nty, n_clusters=len(clusters)),
        "depth_edges": edges,
        "invalid_light_ids": invalid,
        "valid_light_count": len(lights),
        "cluster_counts": counts,
        "max_lights_per_cluster": max(counts) if counts else 0,
        "cluster_members": [c["members"] for c in clusters],
        "pixel_cluster": pixel_cluster_idx,
        "cluster_color": cluster_color,
        "exhaustive_color": ex_color,
        "cluster_evals": cluster_evals,
        "cluster_tests": cluster_tests,
        "exhaustive_evals": ex_evals,
        "exhaustive_tests": ex_tests,
        "max_abs_error": max_err,
        "total_cluster_tests": sum(cluster_tests),
        "total_exhaustive_tests": sum(ex_tests),
        "total_cluster_evals": sum(cluster_evals),
        "total_exhaustive_evals": sum(ex_evals),
    }


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        d = json.load(f)
    out = build_case(d)
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
