#!/usr/bin/env python3
"""
crosscheck.py — 与网页实现完全独立的 Python 参考实现（仅标准库）。
用 `python3 -I crosscheck.py <样例目录> <reference.json>` 运行：
  1) 自带矩阵求逆 / A^T A 特征值 / SDF / CSG / 球步进；
  2) 对样例目录全部场景逐条射线求交；
  3) 与 reference.json 的期望 t / normal / leaf / status 比对；
  4) 同时与 JS 实现导出的结果文件（若提供）逐条比对。
路径全部来自命令行参数，不依赖 cwd。
"""
import argparse
import json
import math
import os
import sys

T_MAX = 20.0
HIT_EPS = 1e-4
GRAD_EPS = 1e-5


# ---------- 线性代数（独立实现，4x4 行主序） ----------
def mat_inverse(m):
    a = m[:]
    inv = [0.0] * 16
    for i in range(4):
        inv[4 * i + i] = 1.0
    scale = max(abs(v) for v in a)
    tol = scale * 1e-12
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(a[4 * r + col]))
        if abs(a[4 * piv + col]) <= tol:
            return None
        if piv != col:
            for k in range(4):
                a[4 * col + k], a[4 * piv + k] = a[4 * piv + k], a[4 * col + k]
                inv[4 * col + k], inv[4 * piv + k] = inv[4 * piv + k], inv[4 * col + k]
        diag = a[4 * col + col]
        for k in range(4):
            a[4 * col + k] /= diag
            inv[4 * col + k] /= diag
        for r in range(4):
            if r == col:
                continue
            f = a[4 * r + col]
            for k in range(4):
                a[4 * r + k] -= f * a[4 * col + k]
                inv[4 * r + k] -= f * inv[4 * col + k]
    return inv


def apply_affine(m, p):
    x, y, z = p
    return [
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
    ]


def jacobi_eigen3(s):
    a = s[:]
    for _ in range(100):
        offs = [(abs(a[1]), 0, 1), (abs(a[2]), 0, 2), (abs(a[5]), 1, 2)]
        mx, p, q = max(offs)
        if mx < 1e-15:
            break
        apq = a[3 * p + q]
        phi = 0.5 * math.atan2(2.0 * apq, a[4 * q] - a[4 * p])
        c, sn = math.cos(phi), math.sin(phi)
        for k in range(3):
            akp, akq = a[3 * k + p], a[3 * k + q]
            a[3 * k + p] = c * akp - sn * akq
            a[3 * k + q] = sn * akp + c * akq
        for k in range(3):
            apk, aqk = a[3 * p + k], a[3 * q + k]
            a[3 * p + k] = c * apk - sn * aqk
            a[3 * q + k] = sn * apk + c * aqk
    return [a[0], a[4], a[8]]


def min_singular(m):
    alin = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
    b = [0.0] * 9
    for i in range(3):
        for j in range(3):
            b[3 * i + j] = sum(alin[3 * k + i] * alin[3 * k + j] for k in range(3))
    lam = min(jacobi_eigen3(b))
    return math.sqrt(max(lam, 0.0))


# ---------- 场景准备 ----------
def prepare(nodes):
    out = {}
    for nid, node in nodes.items():
        inv, sig = None, 1.0
        if "matrix" in node:
            inv = mat_inverse(node["matrix"])
            sig = min_singular(node["matrix"])
        out[nid] = (node, inv, sig)
    return out


def local_dist(node, p):
    x, y, z = p
    kind = node["kind"]
    if kind == "sphere":
        return math.hypot(x, y, z) - node["radius"]
    if kind == "box":
        h = node["half_size"]
        q = [abs(x) - h[0], abs(y) - h[1], abs(z) - h[2]]
        outside = math.hypot(max(q[0], 0.0), max(q[1], 0.0), max(q[2], 0.0))
        inside = min(max(q[0], q[1], q[2]), 0.0)
        return outside + inside
    if kind == "torus":
        radial = math.hypot(x, z) - node["major"]
        return math.hypot(radial, y) - node["minor"]
    raise ValueError(kind)


def field(prepared, nid, p):
    """返回 (保守距离, 叶id, 反向标志)。相等取左，差集右枝 negated 翻转。"""
    node, inv, sig = prepared[nid]
    lp = apply_affine(inv, p) if inv else p
    if "left" not in node:
        return local_dist(node, lp) * sig, nid, False
    da, la, na = field(prepared, node["left"], lp)
    db, lb, nb = field(prepared, node["right"], lp)
    kind = node["kind"]
    if kind == "union":
        d, leaf, neg = (da, la, na) if da <= db else (db, lb, nb)
    elif kind == "intersection":
        d, leaf, neg = (da, la, na) if da >= db else (db, lb, nb)
    else:
        nbd = -db
        if da >= nbd:
            d, leaf, neg = da, la, na
        else:
            d, leaf, neg = nbd, lb, not nb
    return d * sig, leaf, neg


def dist_only(prepared, root, p):
    return field(prepared, root, p)[0]


def normal(prepared, root, p):
    x, y, z = p
    e = GRAD_EPS
    gx = dist_only(prepared, root, [x + e, y, z]) - dist_only(prepared, root, [x - e, y, z])
    gy = dist_only(prepared, root, [x, y + e, z]) - dist_only(prepared, root, [x, y - e, z])
    gz = dist_only(prepared, root, [x, y, z + e]) - dist_only(prepared, root, [x, y, z - e])
    nrm = math.hypot(gx, gy, gz)
    if nrm == 0.0:
        return [0.0, 0.0, 0.0]
    return [gx / nrm, gy / nrm, gz / nrm]


def trace(prepared, root, ray, max_steps=512):
    d = ray["direction"]
    ln = math.hypot(*d)
    d = [v / ln for v in d]
    o = ray["origin"]
    t = 0.0
    samples = []
    last = None
    for step in range(1, max_steps + 1):
        p = [o[i] + d[i] * t for i in range(3)]
        dist, leaf, neg = field(prepared, root, p)
        last = (dist, leaf, neg)
        samples.append((step, t, dist, leaf, neg))
        if abs(dist) <= HIT_EPS:
            return {
                "status": "hit", "t": t, "point": p, "leaf": leaf,
                "negated": neg, "distance": dist,
                "normal": normal(prepared, root, p), "steps": step,
                "samples": samples,
            }
        t += abs(dist)
        if t > T_MAX:
            return {"status": "miss", "t": T_MAX, "steps": step, "samples": samples}
    return {"status": "iteration_limit", "t": t, "steps": max_steps,
            "lastDistance": last[0], "samples": samples}


def near(a, b, tol):
    return abs(a - b) <= tol


def scene_is_evaluable(scene):
    """只对结构完整、矩阵可逆、无环的场景做数值求交。"""
    nodes = scene.get("nodes")
    root = scene.get("root")
    if not isinstance(nodes, dict) or root not in nodes:
        return False
    for node in nodes.values():
        if "matrix" in node and mat_inverse(node["matrix"]) is None:
            return False
        if node.get("kind") in ("union", "intersection", "difference"):
            if node.get("left") not in nodes or node.get("right") not in nodes:
                return False
    # 无环检查（三色 DFS）
    state = {}
    stack = [(root, 0)]
    while stack:
        nid, phase = stack.pop()
        node = nodes[nid]
        if phase == 1:
            state[nid] = 2
            continue
        if state.get(nid) == 1:
            return False
        if state.get(nid) == 2:
            continue
        state[nid] = 1
        stack.append((nid, 1))
        if "left" in node:
            stack.append((node["left"], 0))
            stack.append((node["right"], 0))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("case_dir")
    ap.add_argument("reference")
    ap.add_argument("--js-results", default=None, help="JS 实现导出的命中 JSON（可选）")
    args = ap.parse_args()

    with open(args.reference, encoding="utf-8") as fh:
        reference = json.load(fh)

    failures = 0
    total = 0
    own_results = {}
    for fname in sorted(os.listdir(args.case_dir)):
        if not fname.endswith(".json") or fname in ("reference.json",):
            continue
        with open(os.path.join(args.case_dir, fname), encoding="utf-8") as fh:
            scene = json.load(fh)
        if "nodes" not in scene or not scene_is_evaluable(scene):
            continue
        prepared = prepare(scene["nodes"])
        scene_key = fname[:-5]
        own_results[scene_key] = {}
        for ray in scene["rays"]:
            total += 1
            res = trace(prepared, scene["root"], ray)
            own_results[scene_key][ray["id"]] = res
            exp = reference.get(scene_key, {}).get(ray["id"])
            if exp is None:
                continue
            want_status = exp.get("status", "hit")
            if res["status"] != want_status:
                failures += 1
                print(f"FAIL {scene_key}/{ray['id']}: status {res['status']} != {want_status}")
                continue
            if want_status == "hit":
                if not near(res["t"], exp["t"], 2e-3):
                    failures += 1
                    print(f"FAIL {scene_key}/{ray['id']}: t {res['t']} != {exp['t']}")
                if all(near(res["normal"][i], exp["normal"][i], 1e-2) for i in range(3)) is False:
                    failures += 1
                    print(f"FAIL {scene_key}/{ray['id']}: normal {res['normal']} != {exp['normal']}")
                if "leaf" in exp and res["leaf"] != exp["leaf"]:
                    failures += 1
                    print(f"FAIL {scene_key}/{ray['id']}: leaf {res['leaf']} != {exp['leaf']}")

    # 与 JS 实现结果互验
    if args.js_results and os.path.exists(args.js_results):
        with open(args.js_results, encoding="utf-8") as fh:
            js = json.load(fh)
        js_rays = js.get("results", js)
        for scene_key, rays in own_results.items():
            for rid, res in rays.items():
                js_res = js_rays.get(scene_key, {}).get(rid) if isinstance(js_rays, dict) else None
                if js_res is None:
                    continue
                total += 1
                if js_res["status"] != res["status"]:
                    failures += 1
                    print(f"MISMATCH {scene_key}/{rid}: JS {js_res['status']} vs Py {res['status']}")
                elif res["status"] == "hit":
                    if not near(js_res["t"], res["t"], 1e-6):
                        failures += 1
                        print(f"MISMATCH {scene_key}/{rid}: t {js_res['t']} vs {res['t']}")
                    if js_res.get("leaf") != res["leaf"]:
                        failures += 1
                        print(f"MISMATCH {scene_key}/{rid}: leaf {js_res.get('leaf')} vs {res['leaf']}")

    print(f"\nPython 独立实现：{total} 项检查，{failures} 项失败")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
