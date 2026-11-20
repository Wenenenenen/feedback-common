#!/usr/bin/env python3
"""说明.txt 的独立 Python 参考实现，用于与 JS 核心对拍。只读样例路径。"""
import json
import math
import struct
import sys

FACE_ORDER = ("px", "nx", "py", "ny", "pz", "nz")


def face_uv_to_dir(face, u, v):
    table = {
        "px": (1, -v, -u),
        "nx": (-1, -v, u),
        "py": (u, 1, v),
        "ny": (u, -1, -v),
        "pz": (u, -v, 1),
        "nz": (-u, -v, -1),
    }
    x, y, z = table[face]
    l = math.hypot(x, y, z)
    return (x / l, y / l, z / l)


def dir_to_face_uv(d):
    # 按绝对值最大坐标选面，并列按 px,nx,py,ny,pz,nz 顺序；符号须与面一致。
    x, y, z = d
    candidates = (
        ("px", abs(x), x >= 0),
        ("nx", abs(x), x < 0),
        ("py", abs(y), y >= 0),
        ("ny", abs(y), y < 0),
        ("pz", abs(z), z >= 0),
        ("nz", abs(z), z < 0),
    )
    best_face, best_m = None, -1.0
    for name, mag, sign_ok in candidates:
        if sign_ok and mag >= best_m:
            best_m, best_face = mag, name
    x, y, z = d
    # 严格由方向表反解，d=面方向/L 先求 L：
    #  px (1,-v,-u) L=1/x  u=-z/x v=-y/x ; nx (-1,-v,u) L=-1/x u=-z/x v=y/x
    #  py (u,1,v)  L=1/y  u=x/y  v=z/y   ; ny (u,-1,-v) L=-1/y u=-x/y v=z/y
    #  pz (u,-v,1) L=1/z  u=x/z  v=-y/z  ; nz (-u,-v,-1) L=-1/z u=x/z v=y/z
    if best_face == "px":
        u, v = -z / x, -y / x
    elif best_face == "nx":
        u, v = -z / x, y / x
    elif best_face == "py":
        u, v = x / y, z / y
    elif best_face == "ny":
        u, v = -x / y, z / y
    elif best_face == "pz":
        u, v = x / z, -y / z
    else:
        u, v = x / z, y / z
    u = min(1.0, max(-1.0, u))
    v = min(1.0, max(-1.0, v))
    return best_face, u, v


def texel_center_uv(n, col, row):
    return -1 + 2 * (col + 0.5) / n, -1 + 2 * (row + 0.5) / n


def radical_inverse_2(i):
    result, bit = 0.0, 0.5
    while i > 0:
        if i & 1:
            result += bit
        i >>= 1
        bit *= 0.5
    return result


class CubeEnv:
    def __init__(self, size, faces):
        self.n = size
        # 存成扁平 list 行优先 RGB
        self.faces = {f: [c for triple in faces[f] for c in triple] for f in FACE_ORDER}
        self.center_dirs = {}
        for f in FACE_ORDER:
            arr = [None] * (size * size)
            for row in range(size):
                for col in range(size):
                    u, v = texel_center_uv(size, col, row)
                    arr[row * size + col] = face_uv_to_dir(f, u, v)
            self.center_dirs[f] = arr

    def texel(self, face, row, col):
        o = (row * self.n + col) * 3
        a = self.faces[face]
        return [a[o], a[o + 1], a[o + 2]]

    def sample_nearest_dir(self, d):
        face, u, v = dir_to_face_uv(d)
        # 与 JS Math.round（正数半入）保持一致：floor(x+0.5)。
        col = math.floor(((u + 1) * self.n) / 2 - 0.5 + 0.5)
        row = math.floor(((v + 1) * self.n) / 2 - 0.5 + 0.5)
        col = min(self.n - 1, max(0, col))
        row = min(self.n - 1, max(0, row))
        return self.texel(face, row, col)

    def sample_bilinear_dir(self, d):
        face, u, v = dir_to_face_uv(d)
        px = ((u + 1) * self.n) / 2 - 0.5
        py = ((v + 1) * self.n) / 2 - 0.5
        x0, y0 = math.floor(px), math.floor(py)
        tx, ty = px - x0, py - y0
        weights = (
            (1 - tx) * (1 - ty),
            tx * (1 - ty),
            (1 - tx) * ty,
            tx * ty,
        )
        corners = ((x0, y0), (x0 + 1, y0), (x0, y0 + 1), (x0 + 1, y0 + 1))
        acc = [0.0, 0.0, 0.0]
        for (col, row), w in zip(corners, weights):
            if 0 <= col < self.n and 0 <= row < self.n:
                val = self.texel(face, row, col)
            else:
                # 仅夹越界坐标，另一坐标保持，取边/角纹素中心方向重选面。
                edge_col = min(self.n - 1, max(0, col)) if (col < 0 or col >= self.n) else col
                edge_row = min(self.n - 1, max(0, row)) if (row < 0 or row >= self.n) else row
                nd = self.center_dirs[face][edge_row * self.n + edge_col]
                val = self.sample_nearest_dir(nd)
            for k in range(3):
                acc[k] += w * val[k]
        return acc


def local_frame(d):
    a = (0, 0, 1) if abs(d[2]) < 0.999 else (0, 1, 0)

    def cross(p, q):
        return (
            p[1] * q[2] - p[2] * q[1],
            p[2] * q[0] - p[0] * q[2],
            p[0] * q[1] - p[1] * q[0],
        )

    def norm(x):
        l = math.hypot(*x)
        return (x[0] / l, x[1] / l, x[2] / l)

    t = norm(cross(a, d))
    b = cross(d, t)
    return t, b


def sample_lobe(d, n_exp, i, s):
    xi1 = (i + 0.5) / s
    xi2 = radical_inverse_2(i)
    cos_theta = (1 - xi1) ** (1 / (n_exp + 1))
    phi = 2 * math.pi * xi2
    sin_theta = math.sqrt(max(0.0, 1 - cos_theta * cos_theta))
    t, b = local_frame(d)
    omega = (
        t[0] * sin_theta * math.cos(phi) + b[0] * sin_theta * math.sin(phi) + d[0] * cos_theta,
        t[1] * sin_theta * math.cos(phi) + b[1] * sin_theta * math.sin(phi) + d[1] * cos_theta,
        t[2] * sin_theta * math.cos(phi) + b[2] * sin_theta * math.sin(phi) + d[2] * cos_theta,
    )
    l = math.hypot(*omega)
    return (omega[0] / l, omega[1] / l, omega[2] / l)


def bake_texel(env, out_dir, r, s):
    if r == 0:
        return env.sample_bilinear_dir(out_dir)
    n_exp = max(0.0, 2 / (r * r) - 2)
    acc = [0.0, 0.0, 0.0]
    for i in range(s):
        omega = sample_lobe(out_dir, n_exp, i, s)
        val = env.sample_bilinear_dir(omega)
        for k in range(3):
            acc[k] += val[k]
    return [x / s for x in acc]


def bake(env_path, out_n, roughnesses, samples):
    with open(env_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    env = CubeEnv(data["size"], data["faces"])
    result = {}
    for r in roughnesses:
        per_face = {}
        for f in FACE_ORDER:
            buf = []
            for row in range(out_n):
                for col in range(out_n):
                    u, v = texel_center_uv(out_n, col, row)
                    d = face_uv_to_dir(f, u, v)
                    val = bake_texel(env, d, r, samples)
                    # 模拟 JS 端 Float32 存储
                    buf.extend(struct.unpack("3f", struct.pack("3f", *val)))
            per_face[f] = buf
        result[f"{r}"] = per_face
    return result


if __name__ == "__main__":
    env_path, out_path, out_n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    res = bake(env_path, out_n, [0, 0.25, 0.5, 1.0], 256)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(res, fh)
