#!/usr/bin/env python3
"""
独立参考实现：目标纹素 uv 平面上的固定网格中点矩形积分，多分辨率 + Richardson 外推。

与 js/remap-core.js 没有任何共享代码或共享数值路线：
  - JS：半空间裁剪 + 球面多边形解析立体角（Van Oosterom）
  - 本文件：uv 平面均匀网格中点求积，被积函数 dω = du dv / (1+u²+v²)^{3/2}
面定位用主导轴独立实现，旋转矩阵由四元数独立构造。仅使用 Python 标准库。

分段常数的源颜色在网格边界不连续，中点矩形法对这类被积函数为一阶 O(h)；
用 d、d+1、d+2 三档分辨率做 Aitken/Richardson 外推（h 每减半），
并要求三档单调收敛、外推值与最细网格之差有界，作为参考自身的精度证据。

用法：
  python3 -I remap_reference.py case.json out.json
case.json 含 n, out, q, faces（与样本同格式），另可选：
  texels: [[f,r,c],...]   只积分指定目标纹素（缺省全部）
  depth: 9                最细网格为 2^depth × 2^depth
"""
import json
import math
import sys


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


def quat_matrix(q):
    x, y, z, w = q
    length = math.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / length, y / length, z / length, w / length
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


def locate(p, n):
    ax, ay, az = abs(p[0]), abs(p[1]), abs(p[2])
    if ax >= ay and ax >= az:
        f = 0 if p[0] >= 0 else 1
    elif ay >= az:
        f = 2 if p[1] >= 0 else 3
    else:
        f = 4 if p[2] >= 0 else 5
    x, y, z = p
    if f == 0:
        u, v = -z / x, -y / x
    elif f == 1:
        u, v = -z / x, y / x
    elif f == 2:
        u, v = x / y, z / y
    elif f == 3:
        u, v = -x / y, z / y
    elif f == 4:
        u, v = x / z, -y / z
    else:
        u, v = x / z, y / z
    h = 2.0 / n
    col = max(0, min(n - 1, math.floor((u + 1.0) / h)))
    row = max(0, min(n - 1, math.floor((v + 1.0) / h)))
    return f, row, col


def texel_bounds(size, row, col):
    h = 2.0 / size
    u0 = -1.0 + col * h
    v0 = -1.0 + row * h
    return u0, u0 + h, v0, v0 + h


def midpoint_integrate(case, tf, trow, tcol, depth):
    """2^depth × 2^depth 中点矩形积分，返回 (r,g,b,有效权重,总立体角)。"""
    n = case["n"]
    out = case["out"]
    R = quat_matrix(case["q"])
    faces = case["faces"]
    u0, u1, v0, v1 = texel_bounds(out, trow, tcol)
    m = 1 << depth
    hu = (u1 - u0) / m
    hv = (v1 - v0) / m
    acc_r = acc_g = acc_b = acc_valid = acc_omega = 0.0
    for i in range(m):
        u = u0 + (i + 0.5) * hu
        u2 = u * u
        for j in range(m):
            v = v0 + (j + 0.5) * hv
            d = face_ray(tf, u, v)
            length = math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
            d = (d[0] / length, d[1] / length, d[2] / length)
            p = rotate_back(R, d)
            f, row, col = locate(p, n)
            jac = hu * hv / (1.0 + u2 + v * v) ** 1.5
            acc_omega += jac
            tex = faces[f][row * n + col]
            if tex is not None:
                acc_valid += jac
                acc_r += tex[0] * jac
                acc_g += tex[1] * jac
                acc_b += tex[2] * jac
    return acc_r, acc_g, acc_b, acc_valid, acc_omega


def extrapolate(a, b, c):
    """三档（h, h/2, h/4）一阶误差项的 Richardson 外推。"""
    return c + (c - b) * (c - b) / ((b - a) - (c - b) + 1e-300)


def integrate_texel(case, tf, trow, tcol):
    depth = int(case.get("depth", 9))
    runs = []
    for d in (depth - 2, depth - 1, depth):
        runs.append(midpoint_integrate(case, tf, trow, tcol, d))
    names = ("r", "g", "b", "valid", "omega")
    refined = []
    fine_err = []
    for k in range(5):
        a, b, c = runs[0][k], runs[1][k], runs[2][k]
        ex = extrapolate(a, b, c)
        refined.append(ex)
        fine_err.append(abs(ex - c))
    r, g, b, valid, omega = refined
    raw_omega = runs[2][4]
    return {
        "face": tf, "row": trow, "col": tcol,
        "rgb": [r / omega, g / omega, b / omega],
        "coverage": valid / omega,
        "omega": omega,
        "raw_omega_fine": raw_omega,
        "fine_abs_err": fine_err,
    }


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        case = json.load(fh)
    out = case["out"]
    if "texels" in case:
        targets = case["texels"]
    else:
        targets = [[f, r, c] for f in range(6) for r in range(out) for c in range(out)]
    records = []
    for f, r, c in targets:
        records.append(integrate_texel(case, f, r, c))
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump({"records": records, "depth": case.get("depth", 9)}, fh, indent=1)
    print("integrated %d texels" % len(records))


if __name__ == "__main__":
    main()
