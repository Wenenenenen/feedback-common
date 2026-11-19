#!/usr/bin/env python3 -I
"""
独立参考实现：与 js/engine.js 不同语言、独立编写的连续 SAT。
用法：python3 -I tests/reference.py
读取 samples/extracted 的数据，输出与 JS 引擎结果的逐项比对。
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "..", "samples", "extracted")
EPS = 1e-12


def center(b):
    n = len(b["vertices"])
    sx = sum(v[0] for v in b["vertices"]) / n
    sy = sum(v[1] for v in b["vertices"]) / n
    return [b["position"][0] + sx, b["position"][1] + sy]


def world_verts(b, t):
    px = b["position"][0] + b["velocity"][0] * t
    py = b["position"][1] + b["velocity"][1] * t
    return [[v[0] + px, v[1] + py] for v in b["vertices"]]


def project(verts, ux, uy):
    ds = [x * ux + y * uy for x, y in verts]
    return min(ds), max(ds)


def axes_of(b):
    # CCW 边 (p1-p0) 的外法线 (ey, -ex)
    out = []
    vs = b["vertices"]
    for i in range(len(vs)):
        x0, y0 = vs[i]
        x1, y1 = vs[(i + 1) % len(vs)]
        ex, ey = x1 - x0, y1 - y0
        nx, ny = ey, -ex
        l = math.hypot(nx, ny)
        out.append((nx / l, ny / l))
    return out


def mask_ok(a, b):
    return ((a["mask"] >> b["layer"]) & 1) and ((b["mask"] >> a["layer"]) & 1)


def detect(a, b, dt):
    """返回 (tEnter, tExit, start_overlap, normal) 或 None。"""
    wa0 = world_verts(a, 0.0)
    wb0 = world_verts(b, 0.0)
    rvx = b["velocity"][0] - a["velocity"][0]
    rvy = b["velocity"][1] - a["velocity"][1]

    # 轴序列：A 的边然后 B 的边
    seq = [(a["id"], i, u) for i, u in enumerate(axes_of(a))] + \
          [(b["id"], i, u) for i, u in enumerate(axes_of(b))]

    global_lo, global_hi = -math.inf, math.inf
    start_overlap = True
    per_axis = []

    for owner, edge, (ux, uy) in seq:
        amin, amax = project(wa0, ux, uy)
        bmin, bmax = project(wb0, ux, uy)
        l0 = bmin - amax
        h0 = bmax - amin
        s = rvx * ux + rvy * uy
        if not (l0 <= EPS and h0 >= -EPS):
            start_overlap = False

        if abs(s) <= EPS:
            if l0 > EPS or h0 < -EPS:
                return None
            if abs(l0) <= EPS and abs(h0) <= EPS:
                lo, hi = 0.0, 0.0
            else:
                lo, hi = -math.inf, math.inf
        else:
            # 解 l0+s t <= 0 与 h0+s t >= 0
            t1, t2 = -l0 / s, -h0 / s
            lo, hi = min(t1, t2), max(t1, t2)

        per_axis.append((owner, edge, ux, uy, l0, h0, s, lo, hi))
        global_lo = max(global_lo, lo)
        global_hi = min(global_hi, hi)

    if global_lo > global_hi + EPS:
        return None

    t_enter = max(global_lo, 0.0)
    t_exit = min(global_hi, dt)
    if t_enter > t_exit + EPS:
        return None

    # 进入轴选择
    enter = None
    if start_overlap:
        best = math.inf
        for idx, (_, _, _, _, l0, h0, _, _, _) in enumerate(per_axis):
            depth = min(-l0, h0)
            if depth < best - EPS:
                best = depth
                enter = idx
    else:
        for idx, (_, _, _, _, _, _, _, lo, _) in enumerate(per_axis):
            if math.isfinite(lo) and abs(lo - global_lo) <= EPS:
                enter = idx
                break

    ux, uy = per_axis[enter][2], per_axis[enter][3]
    ca, cb = center(a), center(b)
    d = (ca[0] - cb[0]) * ux + (ca[1] - cb[1]) * uy
    if abs(d) <= EPS:
        sign = 1.0 if (ux > EPS or (abs(ux) <= EPS and uy > EPS)) else -1.0
    else:
        sign = 1.0 if d > 0 else -1.0
    normal = [ux * sign, uy * sign]

    return t_enter, t_exit, start_overlap, normal


def run_scene(scene):
    bodies = sorted(scene["bodies"], key=lambda x: x["id"])
    out = []
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            a, b = bodies[i], bodies[j]
            if not mask_ok(a, b):
                continue
            r = detect(a, b, scene["dt"])
            if r is not None:
                out.append((a["id"], b["id"]) + r)
    return out


def main():
    failures = 0

    cases = json.load(open(os.path.join(SAMPLES, "cases.json"), encoding="utf-8"))
    print("== cases.json 期望值 ==")
    for c in cases:
        got = run_scene(c)
        if "expected" in c:
            exp = c["expected"]
            ok = len(got) == len(exp)
            if ok:
                got_map = {(g[0], g[1]): g for g in got}
                for e in exp:
                    g = got_map[(e["a"], e["b"])]
                    ok = ok and abs(g[2] - e["tEnter"]) <= 1e-9
                    ok = ok and abs(g[3] - e["tExit"]) <= 1e-9
                    ok = ok and g[4] == e["startOverlap"]
                    ok = ok and abs(g[5][0] - e["normal"][0]) <= 1e-8
                    ok = ok and abs(g[5][1] - e["normal"][1]) <= 1e-8
            elif c["expected"] == [] and got == []:
                ok = True
            print(("  OK " if ok else "  FAIL ") + c["name"])
            if not ok:
                failures += 1
                print("   got:", got)
        else:
            et = c["expected_times"]
            ok = len(got) == 1 and abs(got[0][2] - et[0]) <= 1e-9 and abs(got[0][3] - et[1]) <= 1e-9
            print(("  OK " if ok else "  FAIL ") + c["name"])
            if not ok:
                failures += 1

    print("== stress.json 全量交叉比对（与 JS 输出文件）==")
    stress = json.load(open(os.path.join(SAMPLES, "stress.json"), encoding="utf-8"))
    py_res = run_scene(stress)
    js_path = os.path.join(HERE, "js_results.json")
    if not os.path.exists(js_path):
        print("  跳过：先运行 node tests/dump_js.js 生成 JS 结果")
    else:
        js = json.load(open(js_path, encoding="utf-8"))
        js_map = {(r["a"], r["b"]): r for r in js}
        py_map = {(g[0], g[1]): g for g in py_res}
        if set(js_map) != set(py_map):
            print("  FAIL 接触对集合不同")
            print("   仅 JS:", list(set(js_map) - set(py_map))[:5])
            print("   仅 Py:", list(set(py_map) - set(js_map))[:5])
            failures += 1
        else:
            diffs = 0
            for k, g in py_map.items():
                r = js_map[k]
                if (abs(g[2] - r["tEnter"]) > 1e-9 or abs(g[3] - r["tExit"]) > 1e-9 or
                        g[4] != r["startOverlap"] or
                        abs(g[5][0] - r["normal"][0]) > 1e-8 or
                        abs(g[5][1] - r["normal"][1]) > 1e-8):
                    diffs += 1
                    if diffs <= 3:
                        print("  DIFF", k, "py=", g[2:], "js=", r["tEnter"], r["tExit"],
                              r["startOverlap"], r["normal"])
            print(("  OK " if diffs == 0 else "  FAIL ") +
                  str(len(py_map)) + " 对全部一致" if diffs == 0
                  else "  " + str(diffs) + " 对不一致")
            failures += diffs

    print("\n" + ("Python 参考实现全部吻合 ✓" if failures == 0 else str(failures) + " 处不一致 ✗"))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
