#!/usr/bin/env python3
"""Analytic slab tracer validation against packaged reference.json.

Ray p(t) = origin + t*normalize(direction), t in [epsilon, maxDistance],
camera looks down +z, projection u = fx*x/z + cx, v = cy - fy*y/z.
Cell (i,j): u in [i,i+1), v in [j,j+1). Slab: z in [depth, depth+thickness].
All cell-cone inequalities are solved as linear constraints on t (valid z>0).
A candidate counts only when the intersected interval length > 1e-9 and
normal . direction < 0. Hit = candidate with smallest enter; ties by (y,x).
"""
import json
import math
import sys

EPS_LEN = 1e-9


def normalize(v):
    n = math.sqrt(sum(c * c for c in v))
    return [c / n for c in v], n


class Bound:
    __slots__ = ("lo", "hi", "lo_strict", "hi_strict")

    def __init__(self, lo, hi, lo_strict=False, hi_strict=False):
        self.lo = lo
        self.hi = hi
        self.lo_strict = lo_strict
        self.hi_strict = hi_strict


def apply_linear(span, a, b, strict_positive):
    """Constrain a + b*t > 0 (strict) or >= 0 (non-strict)."""
    if abs(b) < 1e-30:
        if a > 0 or (not strict_positive and a == 0):
            return span
        return None
    r = -a / b
    if b > 0:  # t >= r (or > r)
        if r > span.lo or (r == span.lo and strict_positive):
            span.lo = r
            span.lo_strict = strict_positive
    else:  # b < 0 -> t <= r (or < r)
        if r < span.hi or (r == span.hi and strict_positive):
            span.hi = r
            span.hi_strict = strict_positive
    if span.hi < span.lo:
        return None
    return span


def cell_interval(o, d, i, j, cam, depth, thickness, tlo, thi):
    """Intersection of ray with cell (i,j) projection cone and depth slab."""
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    ox, oy, oz = o
    dx, dy, dz = d
    span = Bound(tlo, thi)

    # u >= i : fx*x + (cx-i)*z >= 0
    a = fx * ox + (cx - i) * oz
    b = fx * dx + (cx - i) * dz
    if apply_linear(span, a, b, False) is None:
        return None
    # u < i+1 : -(fx*x + (cx-(i+1))*z) > 0
    a = -(fx * ox + (cx - i - 1) * oz)
    b = -(fx * dx + (cx - i - 1) * dz)
    if apply_linear(span, a, b, True) is None:
        return None
    # v >= j : (cy-j)*z - fy*y >= 0
    a = (cy - j) * oz - fy * oy
    b = (cy - j) * dz - fy * dy
    if apply_linear(span, a, b, False) is None:
        return None
    # v < j+1 : -((cy-j-1)*z - fy*y) > 0
    a = -((cy - j - 1) * oz - fy * oy)
    b = -((cy - j - 1) * dz - fy * dy)
    if apply_linear(span, a, b, True) is None:
        return None
    # depth <= z <= depth+thickness
    if apply_linear(span, oz - depth, dz, False) is None:  # z - depth >= 0
        return None
    if apply_linear(span, (depth + thickness) - oz, -dz, False) is None:
        return None
    if span.hi - span.lo <= EPS_LEN:
        return None
    return span.lo, span.hi


def global_t_span(o, d, cam, epsilon, max_distance):
    lo, hi = epsilon, max_distance
    near, far = cam["near"], cam["far"]
    # near <= z(t) <= far
    s = Bound(lo, hi)
    if apply_linear(s, o[2] - near, d[2], False) is None:
        return None
    if apply_linear(s, far - o[2], -d[2], False) is None:
        return None
    return s.lo, s.hi


def project(o, d, t):
    x = o[0] + d[0] * t
    y = o[1] + d[1] * t
    z = o[2] + d[2] * t
    return cam_proj(x, y, z)


def cam_proj(x, y, z):
    return fx_g * x / z + cx_g, cy_g - fy_g * y / z


def trace_exhaustive(scene, ray):
    global fx_g, fy_g, cx_g, cy_g
    cam = scene["camera"]
    fx_g, fy_g, cx_g, cy_g = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    W, H = scene["width"], scene["height"]
    thickness = scene["thickness"]
    raw_dir = ray["direction"]
    d, _ = normalize(raw_dir)
    o = ray["origin"]
    tspan = global_t_span(o, d, cam, scene["epsilon"], scene["maxDistance"])
    candidates = []
    if tspan is not None:
        tlo, thi = tspan
        for j in range(H):
            for i in range(W):
                idx = j * W + i
                depth = scene["depth"][idx]
                if depth is None:
                    continue
                if ray.get("sourcePixel") == [i, j]:
                    continue
                n = scene["normal"][idx]
                if n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= 0:
                    continue
                iv = cell_interval(o, d, i, j, cam, depth, thickness, tlo, thi)
                if iv is None:
                    continue
                candidates.append({"pixel": [i, j], "enter": iv[0], "exit": iv[1]})
    candidates.sort(key=lambda c: (c["enter"], c["pixel"][1], c["pixel"][0]))
    hit = candidates[0] if candidates else None
    return {"id": ray["id"], "hit": hit, "candidates": candidates}


def main(path, ref_path):
    with open(path) as f:
        scene = json.load(f)
    with open(ref_path) as f:
        ref = json.load(f)
    ok = True
    for ray, want in zip(scene["rays"], ref):
        got = trace_exhaustive(scene, ray)
        problems = []
        if got["hit"] is None and want["hit"] is None:
            pass
        elif got["hit"] is None or want["hit"] is None:
            problems.append(f"hit {got['hit']} != {want['hit']}")
        else:
            if got["hit"]["pixel"] != want["hit"]["pixel"]:
                problems.append(f"pixel {got['hit']['pixel']} != {want['hit']['pixel']}")
            for k in ("enter", "exit"):
                if abs(got["hit"][k] - want["hit"][k]) > 1e-9:
                    problems.append(f"{k} {got['hit'][k]} != {want['hit'][k]}")
        if len(got["candidates"]) != len(want["candidates"]):
            problems.append(
                f"candidate count {len(got['candidates'])} != {len(want['candidates'])}"
            )
        else:
            for c1, c2 in zip(got["candidates"], want["candidates"]):
                if c1["pixel"] != c2["pixel"]:
                    problems.append(f"cand pixel {c1['pixel']} != {c2['pixel']}")
                for k in ("enter", "exit"):
                    if abs(c1[k] - c2[k]) > 1e-9:
                        problems.append(f"cand {k} {c1[k]} != {c2[k]}")
        status = "OK " if not problems else "FAIL"
        print(ray["id"], status, f"cands={len(got['candidates'])}", "; ".join(problems))
        if problems:
            ok = False
    print("ALL MATCH" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    base = "/home/wendy/jianzhi/feedback-tasks/screen-ray-slab-tracer/sample-data"
    scene_path = sys.argv[1] if len(sys.argv) > 1 else base + "/scene.json"
    ref = sys.argv[2] if len(sys.argv) > 2 else base + "/reference.json"
    sys.exit(main(scene_path, ref))
