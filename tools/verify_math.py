"""Verify rotation integration / projection math against sample probes.

Pure stdlib. Run from repo root with:
    python3 -I tools/verify_math.py samples/extracted
"""
import json
import math
import struct
import sys
from pathlib import Path


def mat_identity():
    return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]


def mat_mul(a, b):
    return [
        [sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)]
        for i in range(3)
    ]


def mat_vec(a, v):
    return [sum(a[i][k] * v[k] for k in range(3)) for i in range(3)]


def skew(w):
    return [
        [0.0, -w[2], w[1]],
        [w[2], 0.0, -w[0]],
        [-w[1], w[0], 0.0],
    ]


def rodrigues(w, dt):
    """Exp(so3(w) * dt)."""
    ang = math.sqrt(sum(c * c for c in w)) * dt
    if abs(ang) < 1e-15:
        s = skew([c * dt for c in w])
        return [[(1.0 if i == j else 0.0) + s[i][j] for j in range(3)]
                for i in range(3)]
    k = [c / (ang / dt) for c in w]
    K = skew(k)
    c, s = math.cos(ang), math.sin(ang)
    out = mat_identity()
    for i in range(3):
        for j in range(3):
            out[i][j] += s * K[i][j] + (1.0 - c) * sum(
                K[i][m] * K[m][j] for m in range(3)
            )
    return out


def interp_gyro(gyro, t):
    ts = [g[0] for g in gyro]
    if t <= ts[0]:
        return gyro[0][1:]
    if t >= ts[-1]:
        return gyro[-1][1:]
    for i in range(len(ts) - 1):
        if ts[i] <= t <= ts[i + 1]:
            u = (t - ts[i]) / (ts[i + 1] - ts[i])
            return [gyro[i][k] + (gyro[i + 1][k] - gyro[i][k]) * u
                    for k in range(1, 4)]
    raise RuntimeError("unreachable")


def delta_rotation(gyro, t0, t1, substep=1e-5):
    """R with right-side increments: R <- R @ Exp(w dt), from t0 to t1."""
    if t0 == t1:
        return mat_identity()
    direction = 1.0 if t1 > t0 else -1.0
    lo, hi = sorted((t0, t1))
    bounds = [lo] + [g[0] for g in gyro if lo < g[0] < hi] + [hi]
    R = mat_identity()
    for a, b in zip(bounds[:-1], bounds[1:]):
        wa = interp_gyro(gyro, a)
        wb = interp_gyro(gyro, b)
        if all(abs(wa[k] - wb[k]) < 1e-15 for k in range(3)):
            dR = rodrigues(wa, (b - a) * direction)
        else:
            span = b - a
            wmid = [(wa[k] + wb[k]) * 0.5 for k in range(3)]
            n = max(1, math.ceil(
                math.sqrt(sum(c * c for c in wmid)) * span / substep))
            dR = mat_identity()
            for k in range(n):
                tm = a + span * (k + 0.5) / n
                dR = mat_mul(
                    dR, rodrigues(interp_gyro(gyro, tm), direction * span / n))
        R = mat_mul(R, dR)
    return R


def row_time(params, y, height):
    ratio = y / (height - 1)
    if params["direction"] == "up":
        ratio = 1.0 - ratio
    return params["start"] + params["readout"] * ratio


def forward_project(params, height, x, y, t_ref):
    t = row_time(params, y, height)
    Q = delta_rotation(params["gyro"], t_ref, t)
    ray = [
        (x - params["cx"]) / params["fx"],
        (y - params["cy"]) / params["fy"],
        1.0,
    ]
    r = mat_vec(Q, ray)
    return (
        params["fx"] * r[0] / r[2] + params["cx"],
        params["fy"] * r[1] / r[2] + params["cy"],
        t,
    )


def inverse_map(params, height, xp, yp, t_ref):
    """Find raw (x, y) whose forward projection lands on (xp, yp)."""
    ray_ref = [
        (xp - params["cx"]) / params["fx"],
        (yp - params["cy"]) / params["fy"],
        1.0,
    ]

    def raw_at(y):
        t = row_time(params, y, height)
        Q = delta_rotation(params["gyro"], t_ref, t)
        r = mat_vec([[Q[j][i] for j in range(3)] for i in range(3)], ray_ref)
        return params["fx"] * r[0] / r[2] + params["cx"], \
            params["fy"] * r[1] / r[2] + params["cy"]

    lo, hi = -float(height), 2.0 * float(height)
    if (raw_at(lo)[1] - lo) * (raw_at(hi)[1] - hi) > 0:
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if raw_at(mid)[1] - mid > 0:
            lo = mid
        else:
            hi = mid
    y = 0.5 * (lo + hi)
    x, _ = raw_at(y)
    return x, y


def png_size(path):
    with open(path, "rb") as f:
        sig = f.read(8)
        assert sig == b"\x89PNG\r\n\x1a\n"
        length = struct.unpack(">I", f.read(4))[0]
        chunk = f.read(4)
        assert chunk == b"IHDR"
        width, height = struct.unpack(">II", f.read(8))
    return width, height


def main():
    data_dir = Path(sys.argv[1])
    ok = True
    for name in ["still", "down", "up", "partial"]:
        params = json.loads((data_dir / f"{name}.json").read_text())
        probes = json.loads((data_dir / f"{name}-probes.json").read_text())
        width, height = png_size(data_dir / f"{name}.png")
        print(f"== {name} ({width}x{height}) ==")
        t_first = params["gyro"][0][0]
        t_last = params["gyro"][-1][0]
        ref_covered = t_first <= params["t_ref"] <= t_last
        for px, py, ex, ey in probes:
            fx, fy, t = forward_project(
                params, height, float(px), float(py), params["t_ref"])
            covered = ref_covered and t_first <= t <= t_last
            err = math.hypot(fx - ex, fy - ey)
            print(f"  ({px:3d},{py:3d}) t={t:.6f} covered={covered} "
                  f"got=({fx:.12f},{fy:.12f}) err={err:.2e}")
            if err > 1e-9:
                ok = False
            inv = inverse_map(params, height, fx, fy, params["t_ref"])
            if inv is None:
                print("    inverse: no bracket")
                ok = False
            else:
                rerr = math.hypot(inv[0] - px, inv[1] - py)
                if rerr > 1e-7:
                    print(f"    inverse roundtrip err={rerr:.2e}")
                    ok = False

    params = json.loads((data_dir / "partial.json").read_text())
    h = png_size(data_dir / "partial.png")[1]
    valid = [y for y in range(h)
             if params["gyro"][0][0] <= row_time(params, y, h)
             <= params["gyro"][-1][0]]
    print("partial valid row range:", valid[0], "..", valid[-1])
    print("ALL OK" if ok else "MISMATCH")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
