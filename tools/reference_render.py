#!/usr/bin/env python3
"""Reference implementation of the Gaussian surfel projector spec (说明.txt).

Run with: python3 -I tools/reference_render.py <case.json> [px py]
Used only to validate the in-page JavaScript math; not part of the web page.
"""
import json
import math
import sys


def mat4_mul(a, b):
    """Row-major 4x4 multiply a*b."""
    out = [0.0] * 16
    for r in range(4):
        for c in range(4):
            out[r * 4 + c] = sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
    return out


def apply_affine(m, p):
    x, y, z = p
    return (
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
    )


def mat3_from4(m):
    return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]


def mat3_mul(a, b):
    out = [0.0] * 9
    for r in range(3):
        for c in range(3):
            out[r * 3 + c] = sum(a[r * 3 + k] * b[k * 3 + c] for k in range(3))
    return out


def mat3_vec(a, v):
    return [sum(a[r * 3 + k] * v[k] for k in range(3)) for r in range(3)]


def mat3_transpose(a):
    return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]


def cov3_from_list(vals):
    """Accept full row-major 3x3 (9 values)."""
    if len(vals) == 9:
        return [float(x) for x in vals]
    raise ValueError("unsupported covariance layout")


def is_spd(cov, eps=1e-10):
    """Sylvester criterion (leading principal minors > 0)."""
    a, b, c, d, e, f, g, h, i = cov
    m1 = a
    m2 = a * e - b * d
    m3 = (a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g))
    return m1 > eps and m2 > eps and m3 > eps


def build_splats(case, enabled=None):
    """Project every point of every enabled instance into camera space."""
    cam = case["camera"]
    view = cam["view"]
    R = mat3_from4(view)
    splats = []
    errors = []
    for inst in case["instances"]:
        if enabled is not None and not enabled.get(inst["id"], True):
            continue
        M = mat4_mul(view, inst["matrix"])
        A = mat3_from4(M)
        t = [M[3], M[7], M[11]]
        for pt in inst["points"]:
            label = f"{inst['id']}/{pt['id']}"
            cov_local = cov3_from_list(pt["covariance"])
            if not is_spd(cov_local):
                errors.append((label, "local covariance not SPD"))
                continue
            mean_cam = [
                A[0] * pt["mean"][0] + A[1] * pt["mean"][1] + A[2] * pt["mean"][2] + t[0],
                A[3] * pt["mean"][0] + A[4] * pt["mean"][1] + A[5] * pt["mean"][2] + t[1],
                A[6] * pt["mean"][0] + A[7] * pt["mean"][1] + A[8] * pt["mean"][2] + t[2],
            ]
            cov_cam = mat3_mul(mat3_mul(A, cov_local), mat3_transpose(A))
            if not is_spd(cov_cam, eps=1e-12):
                errors.append((label, "camera covariance not SPD after transform"))
                continue
            splats.append({
                "instance": inst["id"],
                "id": pt["id"],
                "label": label,
                "mean_cam": mean_cam,
                "cov_cam": cov_cam,
                "color": pt["color"],
                "opacity": pt["opacity"],
            })
    return splats, errors


def project_splat(s, cam):
    x, y, z = s["mean_cam"]
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    near, far = cam["near"], cam["far"]
    if not (near <= z <= far):
        s["cull"] = f"center z={z:.6g} outside [{near},{far}]"
        return False
    u = fx * x / z + cx
    v = cy - fy * y / z
    # J = [[fx/z, 0, -fx*x/z^2],[0, -fy/z, fy*y/z^2]]
    j00 = fx / z
    j02 = -fx * x / (z * z)
    j11 = -fy / z
    j12 = fy * y / (z * z)
    cov = s["cov_cam"]
    # J * cov
    jc00 = j00 * cov[0] + j02 * cov[6]
    jc01 = j00 * cov[1] + j02 * cov[7]
    jc02 = j00 * cov[2] + j02 * cov[8]
    jc10 = j11 * cov[3] + j12 * cov[6]
    jc11 = j11 * cov[4] + j12 * cov[7]
    jc12 = j11 * cov[5] + j12 * cov[8]
    c00 = jc00 * j00 + jc02 * j02 + 0.25
    c01 = jc00 * 0 + jc01 * j11 + jc02 * j12
    c11 = jc10 * 0 + jc11 * j11 + jc12 * j12 + 0.25
    s["z"] = z
    s["u"] = u
    s["v"] = v
    s["C"] = [c00, c01, c01, c11]
    return True


def eval_pixel(splats, px, py, cam, background):
    """Full per-pixel trace; no early termination."""
    entries = []
    for s in splats:
        if "C" not in s:
            entries.append({"label": s["label"], "cull": s.get("cull", "not projected")})
            continue
        du = px + 0.5 - s["u"]
        dv = py + 0.5 - s["v"]
        c00, c01, _, c11 = s["C"]
        det = c00 * c11 - c01 * c01
        inv00 = c11 / det
        inv01 = -c01 / det
        inv11 = c00 / det
        q = inv00 * du * du + 2 * inv01 * du * dv + inv11 * dv * dv
        e = {"label": s["label"], "instance": s["instance"], "id": s["id"],
             "z": s["z"], "u": s["u"], "v": s["v"], "q": q,
             "color": s["color"], "opacity": s["opacity"], "C": s["C"]}
        if q > 9:
            e["skip"] = f"q={q:.6f}>9"
            entries.append(e)
            continue
        alpha = min(0.99, s["opacity"] * math.exp(-q / 2))
        e["alpha"] = alpha
        entries.append(e)
    order = sorted(
        [e for e in entries if "alpha" in e],
        key=lambda e: (e["z"], e["id"]),
    )
    T = 1.0
    rgb = [0.0, 0.0, 0.0]
    wsum = 0.0
    dsum = 0.0
    for e in order:
        w = T * e["alpha"]
        e["T_before"] = T
        e["w"] = w
        for k in range(3):
            rgb[k] += w * e["color"][k]
        wsum += w
        dsum += w * e["z"]
        T *= 1 - e["alpha"]
        e["T_after"] = T
    for k in range(3):
        rgb[k] += T * background[k]
    depth = dsum / wsum if wsum > 0 else None
    pick = max(order, key=lambda e: e["w"]) if order else None
    if pick is not None:
        top = [e for e in order if e["w"] == pick["w"]]
        pick = sorted(top, key=lambda e: e["id"])[0]
    return {
        "entries": entries,
        "order": order,
        "T_final": T,
        "linearRGB": rgb,
        "expectedDepth": depth,
        "pick": pick["label"] if pick else None,
    }


def render(case, enabled=None):
    splats, errors = build_splats(case, enabled)
    for s in splats:
        project_splat(s, case["camera"])
    w, h = case["width"], case["height"]
    bg = case["background"]
    buckets = [[[] for _ in range(w)] for _ in range(h)]
    for s in splats:
        if "C" not in s:
            continue
        c00, c01, _, c11 = s["C"]
        rx = 3.0 * math.sqrt(c00)
        ry = 3.0 * math.sqrt(c11)
        x0 = max(0, math.floor(s["u"] - 0.5 - rx))
        x1 = min(w - 1, math.ceil(s["u"] - 0.5 + rx))
        y0 = max(0, math.floor(s["v"] - 0.5 - ry))
        y1 = min(h - 1, math.ceil(s["v"] - 0.5 + ry))
        det = c00 * c11 - c01 * c01
        inv00, inv01, inv11 = c11 / det, -c01 / det, c00 / det
        for py in range(y0, y1 + 1):
            dv = py + 0.5 - s["v"]
            for px in range(x0, x1 + 1):
                du = px + 0.5 - s["u"]
                q = inv00 * du * du + 2 * inv01 * du * dv + inv11 * dv * dv
                if q <= 9:
                    buckets[py][px].append((s, q))
    buf = [[None] * w for _ in range(h)]
    for py in range(h):
        for px in range(w):
            buf[py][px] = composite(buckets[py][px], px, py, bg)
    return splats, errors, buf


def composite(hits, px, py, background):
    order = sorted(hits, key=lambda sq: (sq[0]["z"], sq[0]["id"]))
    entries = []
    T = 1.0
    rgb = [0.0, 0.0, 0.0]
    wsum = dsum = 0.0
    for s, q in order:
        alpha = min(0.99, s["opacity"] * math.exp(-q / 2))
        w = T * alpha
        entries.append({"label": s["label"], "id": s["id"], "z": s["z"],
                        "q": q, "alpha": alpha, "T_before": T, "w": w,
                        "color": s["color"], "u": s["u"], "v": s["v"], "C": s["C"]})
        for k in range(3):
            rgb[k] += w * s["color"][k]
        wsum += w
        dsum += w * s["z"]
        T *= 1 - alpha
    for k in range(3):
        rgb[k] += T * background[k]
    depth = dsum / wsum if wsum > 0 else None
    pick = None
    if entries:
        top = max(e["w"] for e in entries)
        pick = sorted((e for e in entries if e["w"] == top),
                      key=lambda e: e["id"])[0]["label"]
    return {"entries": entries, "T_final": T, "linearRGB": rgb,
            "expectedDepth": depth, "pick": pick}


def brute_region(case, x0, y0, x1, y1, enabled=None):
    """Brute-force reference over a pixel region (every splat at every pixel)."""
    splats, errors = build_splats(case, enabled)
    for s in splats:
        project_splat(s, case["camera"])
    out = {}
    for py in range(y0, y1 + 1):
        for px in range(x0, x1 + 1):
            out[(px, py)] = eval_pixel(splats, px, py, case["camera"], case["background"])
    return out


def cross_check(case, region=8):
    import time
    t0 = time.perf_counter()
    splats, errors, buf = render(case)
    dt = time.perf_counter() - t0
    w, h = case["width"], case["height"]
    x0, y0 = max(0, w // 2 - region), max(0, h // 2 - region)
    x1, y1 = min(w - 1, w // 2 + region), min(h - 1, h // 2 + region)
    brute = brute_region(case, x0, y0, x1, y1)
    bad = 0
    for (px, py), ref in brute.items():
        got = buf[py][px]
        if (abs(got["T_final"] - ref["T_final"]) > 1e-12
                or any(abs(a - b) > 1e-12 for a, b in zip(got["linearRGB"], ref["linearRGB"]))
                or got["pick"] != ref["pick"]):
            bad += 1
            print("MISMATCH", px, py, got, ref)
    print(f"bbox render {dt*1000:.1f} ms; cross-check region {x0},{y0}-{x1},{y1}: "
          f"{len(brute)} pixels, mismatches={bad}, errors={errors}")
    return bad


def main():
    case = json.load(open(sys.argv[1]))
    if len(sys.argv) >= 3 and sys.argv[2] == "--check":
        sys.exit(1 if cross_check(case) else 0)
    splats, errors, buf = render(case)
    print(f"splats={len(splats)} errors={errors}")
    for s in splats:
        if "C" in s:
            print(f"  {s['label']}: cam_mean={[round(v,6) for v in s['mean_cam']]} "
                  f"u={s['u']:.6f} v={s['v']:.6f} C={[round(x,6) for x in s['C']]}")
        else:
            print(f"  {s['label']}: CULLED {s.get('cull')}")
    if len(sys.argv) >= 4:
        px, py = int(sys.argv[2]), int(sys.argv[3])
    else:
        px, py = case["width"] // 2, case["height"] // 2
    tr = buf[py][px]
    print(f"linearRGB={tr['linearRGB']} depth={tr['expectedDepth']} pick={tr['pick']}")
    for e in tr["entries"]:
        print(f"  {e['label']:20s} z={e['z']:.6f} q={e['q']:.6f} "
              f"alpha={e['alpha']:.6f} T-={e['T_before']:.6f} w={e['w']:.6f}")
    skipped = [e for e in tr["entries"] if "alpha" not in e]
    for e in skipped:
        print(f"  {e['label']:20s} skipped: {e.get('skip') or e.get('cull')}")


if __name__ == "__main__":
    main()
