#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对比 LM 与 回溯线搜索 GN 的收敛速度。python3 -I 运行。"""
import math
import sys
import time

sys.path.insert(0, "tools")
from solver_proto import Model, cholesky_solve  # noqa: E402


def build():
    joints = []
    for i in range(32):
        ax = [[0, 0, 1], [0, 1, 0], [1, 0, 0]][i % 3]
        joints.append({"id": "j%02d" % i, "parent": None if i == 0 else "j%02d" % (i - 1),
                       "offset": [0.5, 0, 0], "axis": ax, "angle": 0, "min": -160, "max": 160,
                       "rest": 0, "locked": i % 7 == 0})
    eff = [{"id": "e%d" % k, "joint": "j%02d" % (3 + k * 3), "point": [0.2, 0, 0],
            "target": [0, 0, 0], "weight": 1 + 0.1 * k} for k in range(8)]
    return {"joints": joints, "effectors": eff, "regularization": 0.001,
            "positionTolerance": 0.01, "maxIterations": 2000}


def normal_equations(model, theta, mu=0.0):
    W, origin, axis_w, pts = model.fk(theta)
    nf = len(model.free)
    mm = 3 * len(model.effectors) + nf
    J = [[0.0] * nf for _ in range(mm)]
    r = [0.0] * mm
    for ei, e in enumerate(model.effectors):
        ws = math.sqrt(float(e["weight"]))
        p = pts[ei]
        for k in range(3):
            r[3 * ei + k] = ws * (p[k] - e["target"][k])
        for col, jidx in enumerate(model.free):
            if jidx not in model.anc[ei]:
                continue
            ax = axis_w[jidx]
            rel = [p[k] - origin[jidx][k] for k in range(3)]
            jac = [ax[1] * rel[2] - ax[2] * rel[1],
                   ax[2] * rel[0] - ax[0] * rel[2],
                   ax[0] * rel[1] - ax[1] * rel[0]]
            for k in range(3):
                J[3 * ei + k][col] = ws * jac[k]
    for col, jidx in enumerate(model.free):
        r[3 * len(model.effectors) + col] = math.sqrt(model.lam) * (theta[jidx] - model.rest[jidx])
        J[3 * len(model.effectors) + col][col] = math.sqrt(model.lam)
    A = [[0.0] * nf for _ in range(nf)]
    g = [0.0] * nf
    for a in range(nf):
        for row in range(mm):
            Ja = J[row][a]
            if Ja == 0.0:
                continue
            g[a] += Ja * r[row]
            for b in range(a, nf):
                Jb = J[row][b]
                if Jb:
                    A[a][b] += Ja * Jb
    for a in range(nf):
        for b in range(a):
            A[b][a] = A[a][b]
    if mu:
        for a in range(nf):
            A[a][a] += mu * max(A[a][a], 1e-12)
    return A, g


def project(model, theta, dx, alpha):
    trial = list(theta)
    for col, jidx in enumerate(model.free):
        trial[jidx] = min(max(theta[jidx] + alpha * dx[col], model.lo[jidx]), model.hi[jidx])
    return trial


def backtracking_gn(model, theta0, c1=1e-4, max_bt=12):
    theta = list(theta0)
    _, _, total, errs = model.costs(theta)
    for it in range(model.max_iter):
        if all(d < model.tol for d in errs):
            return theta, total, errs, it, "converged"
        A, g = normal_equations(model, theta)
        # 奇异性保护: 仅在 Cholesky 失败时加最小阻尼
        mu = 0.0
        while True:
            M = [row[:] for row in A]
            if mu:
                for a in range(len(M)):
                    M[a][a] += mu * max(A[a][a], 1e-12)
            try:
                dx = cholesky_solve(M, [-v for v in g])
                break
            except ValueError:
                mu = max(mu * 10, 1e-10)
                if mu > 1e12:
                    return theta, total, errs, it, "stalled"
        # Armijo 回溯; 目标下降量用线性预测 g.dx (注意 g=J'r, cost=|r|^2)
        pred = sum(g[a] * dx[a] for a in range(len(g)))
        if pred >= 0:
            return theta, total, errs, it, "stalled"
        alpha = 1.0
        accepted = False
        for _ in range(max_bt):
            trial = project(model, theta, dx, alpha)
            _, _, tt, te = model.costs(trial)
            if tt <= total + c1 * alpha * pred + 1e-15:
                theta, total, errs = trial, tt, te
                accepted = True
                break
            alpha *= 0.5
        if not accepted:
            return theta, total, errs, it, "stalled"
    return theta, total, errs, model.max_iter, "max_iterations"


def main():
    case = build()
    pose = {"j%02d" % i: ((i * 7) % 30) - 15 for i in range(32)}
    m = Model(case)
    thp = [math.radians(pose[j["id"]]) for j in m.joints]
    _, _, _, pts = m.fk(thp)
    for e, p in zip(case["effectors"], pts):
        e["target"] = p

    # 从可行姿态启动 (热启动场景)
    t0 = time.time()
    th, total, errs, it, st = backtracking_gn(Model(case), thp)
    print("BT-GN warm : status=%s iters=%4d maxerr=%.3e time=%.2fs" %
          (st, it, max(errs), time.time() - t0))

    # 从零位启动 (奇异, 预期停滞但要快)
    t0 = time.time()
    th, total, errs, it, st = backtracking_gn(Model(case), [0.0] * 32)
    print("BT-GN zero : status=%s iters=%4d maxerr=%.3e time=%.2fs" %
          (st, it, max(errs), time.time() - t0))

    # 连续追踪 12 步 x 0.5 度
    th = list(thp)
    t0 = time.time()
    worst = 0.0
    for step in range(1, 13):
        moving = {"j%02d" % i: ((i * 7) % 30) - 15 + step * 0.5 for i in range(32)}
        mm = Model(case)
        q = [math.radians(moving[j["id"]]) for j in mm.joints]
        _, _, _, pts = mm.fk(q)
        for e, p in zip(case["effectors"], pts):
            e["target"] = p
        th, total, errs, it, st = backtracking_gn(Model(case), th)
        worst = max(worst, max(errs))
        if st != "converged":
            print("  track step %d FAILED %s maxerr=%.4f iters=%d" % (step, st, max(errs), it))
    print("BT-GN track: 12 steps worst_maxerr=%.3e total_time=%.2fs" % (worst, time.time() - t0))


if __name__ == "__main__":
    main()
