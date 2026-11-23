#!/usr/bin/env python3
"""
独立解析参考：与 js/remap-core.js 数学原理相同（半空间裁剪 + 球面多边形立体角），
但用 Python 从零独立转写，无任何共享代码；并额外输出逐源纹素权重表，
供跨语言贡献级比对（验证跨面 / 顶角份额不重不漏）。

立体角公式仍用 Van Oosterom 的球面三角形式，但多边形面积改用
逐边向量混合积的另一种组织方式书写，避免与 JS 逐字同构。
另外提供中点积分路线 remap_reference.py 作为方法论不同的独立旁证。

用法：
  python3 -I analytic_reference.py case.json out.json
"""
import json
import math
import sys

FACE_AXIS = (0, 0, 1, 1, 2, 2)
FACE_SIGN = (1, -1, 1, -1, 1, -1)
EPS = 1e-14


def vadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def vscale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def vnorm(p):
    l = math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) or 1.0
    return (p[0] / l, p[1] / l, p[2] / l)


def face_ray(f, u, v):
    if f == 0:
        return (1.0, -v, -u)
    if f == 1:
        return (-1.0, -v, u)
    if f == 2:
        return (u, 1.0, v)
    if f == 3:
        return (u, -1.0, -v)
    if f == 4:
        return (u, -v, 1.0)
    return (-u, -v, -1.0)


def project(f, p):
    x, y, z = p
    if f == 0:
        return (-z / x, -y / x)
    if f == 1:
        return (-z / x, y / x)
    if f == 2:
        return (x / y, z / y)
    if f == 3:
        return (-x / y, z / y)
    if f == 4:
        return (x / z, -y / z)
    return (x / z, y / z)


def face_planes(f):
    axis = FACE_AXIS[f]
    s = FACE_SIGN[f]
    out = []
    for j in range(3):
        if j == axis:
            continue
        n1 = [0.0, 0.0, 0.0]
        n2 = [0.0, 0.0, 0.0]
        n1[axis] = s
        n1[j] = -1.0
        n2[axis] = s
        n2[j] = 1.0
        out.append((tuple(n1), tuple(n2)))
    return [n for pair in out for n in pair]


def dedup3(pts):
    out = []
    for p in pts:
        if not out or math.dist(p, out[-1]) > EPS:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) <= EPS:
        out.pop()
    return out


def clip3(poly, normal):
    if len(poly) < 3:
        return poly
    out = []
    prev = poly[-1]
    dp = vdot(normal, prev)
    for cur in poly:
        dc = vdot(normal, cur)
        if dc >= 0.0:
            if dp < 0.0:
                t = dp / (dp - dc)
                out.append(vadd(prev, vscale(vsub(cur, prev), t)))
            out.append(cur)
        elif dp >= 0.0:
            t = dp / (dp - dc)
            out.append(vadd(prev, vscale(vsub(cur, prev), t)))
        prev, dp = cur, dc
    return dedup3(out)


def dedup2(pts):
    out = []
    for p in pts:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > EPS:
            out.append(p)
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= EPS:
        out.pop()
    return out


def clip2(poly, dist):
    if len(poly) < 3:
        return poly
    out = []
    prev = poly[-1]
    dp = dist(prev)
    for cur in poly:
        dc = dist(cur)
        if dc >= 0.0:
            if dp < 0.0:
                t = dp / (dp - dc)
                out.append((prev[0] + t * (cur[0] - prev[0]),
                            prev[1] + t * (cur[1] - prev[1])))
            out.append(cur)
        elif dp >= 0.0:
            t = dp / (dp - dc)
            out.append((prev[0] + t * (cur[0] - prev[0]),
                        prev[1] + t * (cur[1] - prev[1])))
        prev, dp = cur, dc
    return dedup2(out)


def tri_sa(a, b, c):
    # Van Oosterom & Strackee，atan2 形式
    return 2.0 * math.atan2(vdot(a, vcross(b, c)),
                            1.0 + vdot(a, b) + vdot(b, c) + vdot(c, a))


def poly_sa(pts):
    if len(pts) < 3:
        return 0.0
    total = 0.0
    a = pts[0]
    for i in range(1, len(pts) - 1):
        total += tri_sa(a, pts[i], pts[i + 1])
    return abs(total)


def quat_matrix(q):
    x, y, z, w = q
    l = math.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / l, y / l, z / l, w / l
    x2, y2, z2 = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return (
        (1 - 2 * (y2 + z2), 2 * (xy - wz), 2 * (xz + wy)),
        (2 * (xy + wz), 1 - 2 * (x2 + z2), 2 * (yz - wx)),
        (2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (x2 + y2)),
    )


def rotate_back(R, p):
    return (
        R[0][0] * p[0] + R[1][0] * p[1] + R[2][0] * p[2],
        R[0][1] * p[0] + R[1][1] * p[1] + R[2][1] * p[2],
        R[0][2] * p[0] + R[1][2] * p[1] + R[2][2] * p[2],
    )


def texel_bounds(size, row, col):
    h = 2.0 / size
    return -1.0 + col * h, -1.0 + (col + 1) * h, -1.0 + row * h, -1.0 + (row + 1) * h


def texel_corners(f, size, row, col):
    u0, u1, v0, v1 = texel_bounds(size, row, col)
    return [vnorm(face_ray(f, u, v)) for (u, v) in
            ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]


def texel_sa(f, size, row, col):
    return poly_sa(texel_corners(f, size, row, col))


def resample_texel(case, tf, trow, tcol):
    n = case["n"]
    out = case["out"]
    R = quat_matrix(case["q"])
    faces = case["faces"]
    omega_t = texel_sa(tf, out, trow, tcol)
    corners = [vnorm(rotate_back(R, p)) for p in texel_corners(tf, out, trow, tcol)]

    contributions = []
    weight_sum = 0.0
    valid_weight = 0.0
    numer = [0.0, 0.0, 0.0]

    for f in range(6):
        poly = corners
        for normal in face_planes(f):
            poly = clip3(poly, normal)
            if len(poly) < 3:
                break
        if len(poly) < 3:
            continue
        uv = [project(f, vnorm(p)) for p in poly]
        uv = clip2(clip2(clip2(clip2(uv, lambda p: p[0] + 1.0),
                               lambda p: 1.0 - p[0]),
                         lambda p: p[1] + 1.0),
                   lambda p: 1.0 - p[1])
        if len(uv) < 3:
            continue
        us = [p[0] for p in uv]
        vs = [p[1] for p in uv]
        h = 2.0 / n
        c0 = max(0, int(math.floor((min(us) + 1.0) / h - 1e-12)))
        c1 = min(n - 1, int(math.floor((max(us) + 1.0) / h + 1e-12)))
        r0 = max(0, int(math.floor((min(vs) + 1.0) / h - 1e-12)))
        r1 = min(n - 1, int(math.floor((max(vs) + 1.0) / h + 1e-12)))
        for c in range(c0, c1 + 1):
            gu0, gu1 = -1.0 + c * h, -1.0 + (c + 1) * h
            col_poly = clip2(clip2(uv, lambda p: p[0] - gu0), lambda p: gu1 - p[0])
            if len(col_poly) < 3:
                continue
            for r in range(r0, r1 + 1):
                gv0, gv1 = -1.0 + r * h, -1.0 + (r + 1) * h
                cell = clip2(clip2(col_poly, lambda p: p[1] - gv0), lambda p: gv1 - p[1])
                if len(cell) < 3:
                    continue
                pts = [vnorm(face_ray(f, q[0], q[1])) for q in cell]
                w = poly_sa(pts)
                if not (w > 0.0) or not math.isfinite(w):
                    continue
                weight_sum += w
                tex = faces[f][r * n + c]
                missing = tex is None
                if not missing:
                    valid_weight += w
                    numer[0] += tex[0] * w
                    numer[1] += tex[1] * w
                    numer[2] += tex[2] * w
                contributions.append({
                    "face": f, "row": r, "col": c,
                    "weight": w, "missing": missing,
                })

    contributions.sort(key=lambda k: -k["weight"])
    return {
        "face": tf, "row": trow, "col": tcol,
        "omegaT": omega_t,
        "weightSum": weight_sum,
        "rgb": [numer[0] / omega_t, numer[1] / omega_t, numer[2] / omega_t],
        "coverage": valid_weight / omega_t,
        "contributions": contributions,
    }


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        case = json.load(fh)
    out = case["out"]
    if "texels" in case:
        targets = case["texels"]
    else:
        targets = [[f, r, c] for f in range(6) for r in range(out) for c in range(out)]
    records = [resample_texel(case, f, r, c) for (f, r, c) in targets]
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump({"records": records}, fh)
    print("analytic reference: %d texels" % len(records))


if __name__ == "__main__":
    main()
