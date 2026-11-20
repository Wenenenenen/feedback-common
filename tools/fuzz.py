#!/usr/bin/env python3
"""Differential fuzz: DDA grid walk vs exhaustive analytic enumeration.

Miss reason taxonomy:
  near / far / max-distance / off-screen : ray-level clip failures
  empty-depth / backface / graze / source-only : per-cell outcomes
A "graze" cell: ray enters the cell's projection cone with positive parameter
length, but its depth-slab intersection is empty or a single point (<=1e-9).
"""
import json
import math
import random

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate as V

BASE = "/home/wendy/jianzhi/feedback-tasks/screen-ray-slab-tracer/sample-data"


def clip_span(o, d, cam, epsilon, max_distance):
    s = V.Bound(epsilon, max_distance)
    tags = {"lo": "epsilon", "hi": "maxDistance"}
    lo0 = s.lo
    if V.apply_linear(s, o[2] - cam["near"], d[2], False) is None:
        return None, None, "near"
    if s.lo != lo0:
        tags["lo"] = "near"
    hi0 = s.hi
    if V.apply_linear(s, cam["far"] - o[2], -d[2], False) is None:
        return None, None, "far"
    if s.hi != hi0:
        tags["hi"] = "far"
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    W, H = cam["W"], cam["H"]
    bounds = [
        (fx * o[0] + cx * o[2], fx * d[0] + cx * d[2], False),
        (-(fx * o[0] + (cx - W) * o[2]), -(fx * d[0] + (cx - W) * d[2]), True),
        (cy * o[2] - fy * o[1], cy * d[2] - fy * d[1], False),
        (-((cy - H) * o[2] - fy * o[1]), -((cy - H) * d[2] - fy * d[1]), True),
    ]
    for a, b, strict in bounds:
        lo0, hi0 = s.lo, s.hi
        if V.apply_linear(s, a, b, strict) is None:
            return None, None, "off-screen"
        if s.lo != lo0:
            tags["lo"] = "screen"
        if s.hi != hi0:
            tags["hi"] = "screen"
    return (s.lo, s.hi), tags, None


def cone_interval(o, d, i, j, cam, tlo, thi):
    """Projection-cone-only interval (no depth slab)."""
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    span = V.Bound(tlo, thi)
    for a, b, strict in (
        (fx * o[0] + (cx - i) * o[2], fx * d[0] + (cx - i) * d[2], False),
        (-(fx * o[0] + (cx - i - 1) * o[2]), -(fx * d[0] + (cx - i - 1) * d[2]), True),
        ((cy - j) * o[2] - fy * o[1], (cy - j) * d[2] - fy * d[1], False),
        (-((cy - j - 1) * o[2] - fy * o[1]), -((cy - j - 1) * d[2] - fy * d[1]), True),
    ):
        if V.apply_linear(span, a, b, strict) is None:
            return None
    if span.hi - span.lo <= V.EPS_LEN:
        return None
    return span.lo, span.hi


def project_at(o, d, t, cam):
    x, y, z = o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t
    return cam["fx"] * x / z + cam["cx"], cam["cy"] - cam["fy"] * y / z


def dda_cells(o, d, span, cam):
    """Walk every cell whose cone intersects the ray over span with positive
    parameter length, including off-screen entry/exit cells. Exact t-at-boundary
    solves; simultaneous crossings move diagonally (half-open semantics)."""
    t0, t1 = span
    W, H = cam["W"], cam["H"]
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    u0, v0 = project_at(o, d, t0, cam)
    u1, v1 = project_at(o, d, t1, cam)
    su = 0 if u1 == u0 else (1 if u1 > u0 else -1)
    sv = 0 if v1 == v0 else (1 if v1 > v0 else -1)
    # clip guarantees the open span (t0,t1) projects inside the screen rect;
    # an out-of-range floor at t0 is the exact-boundary entry artifact.
    i, j = math.floor(u0), math.floor(v0)
    i = min(max(i, 0), W - 1)
    j = min(max(j, 0), H - 1)
    out = []
    tcur = t0
    guard = 0
    while tcur < t1:
        guard += 1
        assert guard < 100000
        tV = math.inf
        tH = math.inf
        if su != 0:
            k = i + 1 if su > 0 else i
            a = fx * o[0] + (cx - k) * o[2]
            b = fx * d[0] + (cx - k) * d[2]
            if b != 0:
                t = -a / b
                if t > tcur:
                    tV = t
        if sv != 0:
            k = j + 1 if sv > 0 else j
            a = (cy - k) * o[2] - fy * o[1]
            b = (cy - k) * d[2] - fy * d[1]
            if b != 0:
                t = -a / b
                if t > tcur:
                    tH = t
        tend = min(tV, tH, t1)
        if 0 <= i < W and 0 <= j < H and tend > tcur:
            out.append((i, j, tcur, tend))
        if tV == tH:
            i += su
            j += sv
        elif tV < tH:
            i += su
        else:
            j += sv
        tcur = tend
        if i < -2 or i > W + 1 or j < -2 or j > H + 1:
            break
    return out


def classify_cell(o, d, i, j, cam, scene, span, source):
    if source == [i, j]:
        return {"pixel": [i, j], "status": "source-skip"}
    depth = scene["depth"][j * scene["width"] + i]
    if depth is None:
        return {"pixel": [i, j], "status": "empty-depth"}
    n = scene["normal"][j * scene["width"] + i]
    nd = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]
    if nd >= 0:
        return {"pixel": [i, j], "status": "backface", "nDotD": nd}
    iv = V.cell_interval(o, d, i, j, cam, depth, scene["thickness"],
                         span[0], span[1])
    if iv is not None:
        return {"pixel": [i, j], "status": "candidate",
                "enter": iv[0], "exit": iv[1]}
    cone = cone_interval(o, d, i, j, cam, span[0], span[1])
    if cone is not None:
        return {"pixel": [i, j], "status": "graze",
                "coneEnter": cone[0], "coneExit": cone[1]}
    return {"pixel": [i, j], "status": "miss"}


def trace(scene, ray, mode):
    cam = dict(scene["camera"])
    W, H = scene["width"], scene["height"]
    cam["W"], cam["H"] = W, H
    d, _ = V.normalize(ray["direction"])
    o = ray["origin"]
    span, tags, fail = clip_span(o, d, cam, scene["epsilon"], scene["maxDistance"])
    if fail:
        return {"id": ray.get("id"), "reason": fail, "candidates": [],
                "cells": [], "span": None, "spanTags": None}
    source = ray.get("sourcePixel")
    if mode == "dda":
        enum = [(i, j) for (i, j, _, _) in dda_cells(o, d, span, cam)]
    else:
        # Exhaustive reference: analytic cone test on every cell, keeping
        # exactly those whose projection cone intersects with positive length.
        enum = [(i, j) for j in range(H) for i in range(W)
                if cone_interval(o, d, i, j, cam, span[0], span[1]) is not None]
    cells = [classify_cell(o, d, i, j, cam, scene, span, source)
             for i, j in enum]
    cands = sorted(
        (c for c in cells if c["status"] == "candidate"),
        key=lambda c: (c["enter"], c["pixel"][1], c["pixel"][0]),
    )
    result = {"id": ray.get("id"), "candidates": cands, "cells": cells,
              "span": list(span), "spanTags": tags}
    if cands:
        result["hit"] = cands[0]
        result["reason"] = "hit"
        result["reasonFactors"] = ["hit"]
    else:
        statuses = {c["status"] for c in cells}
        factors = set(statuses)
        if tags and tags["hi"] != "maxDistance":
            factors.add(tags["hi"])
        if not statuses:
            primary = "off-screen" if not (tags and tags["hi"] in ("near", "far")) \
                else tags["hi"]
        elif statuses <= {"graze", "source-skip"} and "graze" in statuses:
            primary = "graze"
        elif statuses <= {"source-skip"}:
            primary = "source-only"
        elif statuses <= {"source-skip", "empty-depth"}:
            primary = "empty-depth"
        elif "backface" in statuses:
            primary = "backface"
        elif "graze" in statuses:
            primary = "graze"
        elif tags and tags["hi"] == "near":
            primary = "near"
        elif tags and tags["hi"] == "far":
            primary = "far"
        elif tags and tags["hi"] == "screen":
            primary = "off-screen"
        else:
            primary = "max-distance"
        result["reason"] = primary
        result["reasonFactors"] = sorted(factors)
    return result


def random_ray(rng, cam, W, H):
    kind = rng.randrange(7)
    if kind == 0:
        u = rng.randrange(W) + 0.5
        v = rng.randrange(H) + 0.5
        z = rng.uniform(0.5, 10)
        o = [(u - cam["cx"]) * z / cam["fx"], (cam["cy"] - v) * z / cam["fy"], z]
        d = [rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0.0, 1.5)]
    elif kind == 1:
        o = [rng.uniform(-12, -3), rng.uniform(-6, 6), rng.uniform(1, 8)]
        d = [rng.uniform(0.5, 1.5), rng.uniform(-1, 1), rng.uniform(-0.5, 1)]
    elif kind == 2:
        o = [rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(2, 8)]
        d = [rng.uniform(-1, 1), rng.uniform(-1, 1), -rng.uniform(0.2, 1.2)]
    elif kind == 3:
        k = rng.randrange(W)
        z = rng.uniform(1, 6)
        o = [(k - cam["cx"]) * z / cam["fx"], 0.0, z]
        d = [0.0, 0.0, 1.0]
    elif kind == 4:
        o = [rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(2, 6)]
        d = [rng.choice([-1, 1]), rng.uniform(-0.2, 0.2), rng.uniform(-1e-5, 1e-5)]
    elif kind == 5:
        o = [0.0, 0.0, rng.uniform(1, 5)]
        d = [rng.choice([-0.3, 0.3]), rng.choice([-0.3, 0.3]), 1.0]
    else:  # exactly through an integer pixel corner
        ci = rng.randrange(2, W - 2)
        cj = rng.randrange(2, H - 2)
        z = rng.uniform(2, 6)
        o = [(ci - cam["cx"]) * z / cam["fx"],
             (cam["cy"] - cj) * z / cam["fy"], z]
        d = [rng.choice([-1.0, 1.0]), rng.choice([-1.0, 1.0]), rng.uniform(0.2, 1.2)]
    ray = {"id": f"r{rng.randrange(10**9)}", "origin": o, "direction": d}
    if rng.random() < 0.1:
        ray["sourcePixel"] = [rng.randrange(W), rng.randrange(H)]
    return ray


def fuzz(scene, n, seed):
    rng = random.Random(seed)
    cam = scene["camera"]
    W, H = scene["width"], scene["height"]
    bad = 0
    reasons = {}
    for _ in range(n):
        ray = random_ray(rng, cam, W, H)
        a = trace(scene, ray, "exhaustive")
        b = trace(scene, ray, "dda")
        reasons[a["reason"]] = reasons.get(a["reason"], 0) + 1
        # Compare as pixel-keyed maps: traversal order is not part of the spec
        # (diagonal corner crossings legitimately interleave the two axes).
        ma = {(c["pixel"][0], c["pixel"][1]): c for c in a["cells"]}
        mb = {(c["pixel"][0], c["pixel"][1]): c for c in b["cells"]}
        pa, pb = set(ma), set(mb)
        if pa != pb:
            bad += 1
            if bad <= 3:
                print("CELL MISMATCH", ray)
                print(" only-ex:", sorted(pa - pb), "only-dda:", sorted(pb - pa))
            continue
        for key in sorted(pa):
            ca, cb = ma[key], mb[key]
            if ca["status"] != cb["status"]:
                bad += 1
                if bad <= 3:
                    print("STATUS MISMATCH", ray["id"], ca, cb)
                break
            if ca["status"] == "candidate":
                if (abs(ca["enter"] - cb["enter"]) > 1e-9 or
                        abs(ca["exit"] - cb["exit"]) > 1e-9):
                    bad += 1
                    if bad <= 3:
                        print("INTERVAL MISMATCH", ray["id"], ca, cb)
                    break
        if a["reason"] != b["reason"]:
            bad += 1
            if bad <= 3:
                print("REASON MISMATCH", ray["id"], a["reason"], b["reason"])
    print(f"scene {W}x{H}: {n} rays, mismatches={bad}, reasons={reasons}")
    return bad


def graze_checks(scene):
    cam = scene["camera"]
    # 1) projected ray exactly through an integer pixel corner (cone graze only)
    W = scene["width"]
    idx = next(k for k, z in enumerate(scene["depth"]) if z == 3)
    j, i = divmod(idx, W)
    z = 4.0
    o = [(i - cam["cx"]) * z / cam["fx"], (cam["cy"] - j) * z / cam["fy"], z]
    d = V.normalize([1.0, 1.0, 0.8])[0]
    r = trace(scene, {"id": "graze-corner", "origin": o, "direction": list(d)},
              "exhaustive")
    grazes = [c["pixel"] for c in r["cells"] if c["status"] == "graze"]
    print("corner-graze reason:", r["reason"], "grazed cells:", grazes[:6],
          "cands:", len(r["candidates"]))
    # 2) slab tangent: clip ray so its z-span ends exactly on a slab front face
    o2 = [0, 0, 2.9]
    d2 = V.normalize([0.3, 0, 0.1])[0]
    sc = dict(scene)
    sc["maxDistance"] = 0.1 / d2[2]
    r2 = trace(sc, {"id": "graze-slab", "origin": o2, "direction": list(d2)},
               "exhaustive")
    print("slab-graze reason:", r2["reason"], "cands:", len(r2["candidates"]),
          "graze cells:",
          [c["pixel"] for c in r2["cells"] if c["status"] == "graze"][:6])


def main():
    with open(BASE + "/scene.json") as f:
        small = json.load(f)
    with open(BASE + "/capacity.json") as f:
        big = json.load(f)
    total_bad = fuzz(small, 4000, 1234) + fuzz(big, 4000, 5678)
    graze_checks(small)
    for ray in small["rays"]:
        r = trace(small, ray, "dda")
        print(ray["id"], "->", r["reason"],
              "hit:", r["hit"]["pixel"] if r.get("hit") else None,
              "cands:", len(r["candidates"]),
              "walked:", len(r["cells"]))
    print("FUZZ", "PASS" if total_bad == 0 else "FAIL")


if __name__ == "__main__":
    main()
