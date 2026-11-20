#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
铰链骨架逆运动学求解器原型（仅用标准库，-I 运行）。

模型:
  W_j = W_parent * T(offset_j) * R(axis_j, angle_j)          根父矩阵为单位阵
  末端世界点 p_e = W_joint * point_e
  cost = sum_e w_e * |p_e - target_e|^2
         + lambda * sum_j (theta_j - rest_j)^2               弧度, 含锁定常量项

方法: Levenberg-Marquardt 阻尼高斯-牛顿, 盒约束投影 (角度 clamp 到 [min,max]),
      自实现 Cholesky 求解。无随机量, 同一初值结果逐位一致。
用法: python3 -I solver_proto.py <case.json> [known-pose.json]
"""
import json
import math
import sys


# ---------------- 基础线性代数 (3x4 齐次变换 / 小型稠密矩阵) ----------------

def identity():
    return [[1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0]]


def mat_mul(a, b):
    c = [[0.0] * 4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            s = 0.0
            for k in range(4):
                s += a[i][k] * b[k][j]
            c[i][j] = s
    return c


def translation(v):
    m = identity()
    m[0][3], m[1][3], m[2][3] = float(v[0]), float(v[1]), float(v[2])
    return m


def rotation(axis, ang):
    """Rodrigues, axis 为单位向量, ang 弧度。"""
    x, y, z = axis
    c, s = math.cos(ang), math.sin(ang)
    C = 1.0 - c
    return [
        [c + x * x * C,     x * y * C - z * s, x * z * C + y * s, 0.0],
        [y * x * C + z * s, c + y * y * C,     y * z * C - x * s, 0.0],
        [z * x * C - y * s, z * y * C + x * s, c + z * z * C,     0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def transform_point(m, p):
    x, y, z = p
    return [
        m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
        m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
        m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3],
    ]


def rotate_vector(m, v):
    x, y, z = v
    return [
        m[0][0] * x + m[0][1] * y + m[0][2] * z,
        m[1][0] * x + m[1][1] * y + m[1][2] * z,
        m[2][0] * x + m[2][1] * y + m[2][2] * z,
    ]


# ---------------- 模型与正向运动学 ----------------

class Model:
    def __init__(self, case):
        self.raw = case
        joints = case["joints"]
        by_id = {j["id"]: j for j in joints}
        # 拓扑排序: 父在子前
        ordered = []
        seen = set()

        def visit(jid):
            if jid in seen:
                return
            j = by_id[jid]
            if j["parent"] is not None:
                visit(j["parent"])
            seen.add(jid)
            ordered.append(j)

        for j in joints:
            visit(j["id"])
        self.joints = ordered
        self.n = len(ordered)
        self.index = {j["id"]: i for i, j in enumerate(ordered)}
        self.effectors = case["effectors"]
        self.lam = float(case.get("regularization", 0.0))
        self.tol = float(case.get("positionTolerance", 0.01))
        self.max_iter = int(case.get("maxIterations", 2000))
        self.theta = [math.radians(float(j["angle"])) for j in ordered]
        self.rest = [math.radians(float(j["rest"])) for j in ordered]
        self.lo = [math.radians(float(j["min"])) for j in ordered]
        self.hi = [math.radians(float(j["max"])) for j in ordered]
        self.locked = [bool(j["locked"]) for j in ordered]
        self.free = [i for i in range(self.n) if not self.locked[i]]
        # 每个末端的祖先关节集合 (含自身挂载关节)
        self.anc = []
        for e in self.effectors:
            k = self.index[e["joint"]]
            s = set()
            while True:
                s.add(k)
                pj = self.joints[k]["parent"]
                if pj is None:
                    break
                k = self.index[pj]
            self.anc.append(s)

    def fk(self, theta=None):
        """返回每个关节的世界矩阵 W、关节原点/世界轴、每个末端世界点。"""
        if theta is None:
            theta = self.theta
        W = [None] * self.n
        origin = [None] * self.n
        axis_w = [None] * self.n
        for i, j in enumerate(self.joints):
            p = j["parent"]
            Wp = identity() if p is None else W[self.index[p]]
            M = mat_mul(Wp, translation(j["offset"]))      # 旋转前的局部帧
            R = rotation(j["axis"], theta[i])
            W[i] = mat_mul(M, R)
            origin[i] = [M[0][3], M[1][3], M[2][3]]
            axis_w[i] = rotate_vector(M, j["axis"])
        pts = []
        for e in self.effectors:
            pts.append(transform_point(W[self.index[e["joint"]]], e["point"]))
        return W, origin, axis_w, pts

    def costs(self, theta=None):
        _, _, _, pts = self.fk(theta)
        pos = 0.0
        errs = []
        for e, p in zip(self.effectors, pts):
            d = math.sqrt(sum((p[k] - e["target"][k]) ** 2 for k in range(3)))
            errs.append(d)
            pos += float(e["weight"]) * d * d
        reg = self.lam * sum((theta[i] - self.rest[i]) ** 2 for i in range(self.n))
        return pos, reg, pos + reg, errs


# ---------------- Cholesky 求解 (A x = b, A 对称正定) ----------------

def cholesky_solve(A, b):
    n = len(A)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                v = A[i][i] - s
                if v <= 1e-14:
                    raise ValueError("not SPD")
                L[i][j] = math.sqrt(v)
            else:
                L[i][j] = (A[i][j] - s) / L[j][j]
    y = [0.0] * n
    for i in range(n):
        y[i] = (b[i] - sum(L[i][k] * y[k] for k in range(i))) / L[i][i]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        x[i] = (y[i] - sum(L[k][i] * x[k] for k in range(i + 1, n))) / L[i][i]
    return x


# ---------------- LM 求解 ----------------

FTOL = 1e-12          # 相对代价变化低于此值视为停滞
GTOL = 1e-10          # 自由变量梯度范数低于此值视为驻点
MU_INIT = 1e-3
MU_DOWN = 0.5
MU_UP = 4.0
MU_MAX = 1e12
MU_MIN = 1e-14


def solve(model, theta0=None, record_log=True):
    theta = list(model.theta if theta0 is None else theta0)
    for i in model.free:
        theta[i] = min(max(theta[i], model.lo[i]), model.hi[i])

    if not model.free:
        pos, reg, total, errs = model.costs(theta)
        reached = all(d < model.tol for d in errs)
        return {
            "theta": theta, "status": "converged" if reached else "stalled",
            "reason": "all joints locked; no degrees of freedom",
            "iterations": 0, "reached": reached, "errors": errs,
            "positionCost": pos, "regCost": reg, "totalCost": total,
            "log": [_log_row(0, errs, pos, reg, total, 0.0, 0.0)],
        }

    pos, reg, total, errs = model.costs(theta)
    mu = MU_INIT
    log = [_log_row(0, errs, pos, reg, total, mu, 0.0)] if record_log else []
    prev_total = total
    status, reason = "max_iterations", "reached maxIterations without meeting tolerance"

    for it in range(1, model.max_iter + 1):
        W, origin, axis_w, pts = model.fk(theta)
        nf = len(model.free)
        m = 3 * len(model.effectors) + nf
        # 残差 r 与雅可比 J (稠密, m 行 nf 列)
        J = [[0.0] * nf for _ in range(m)]
        r = [0.0] * m
        for ei, e in enumerate(model.effectors):
            wsqrt = math.sqrt(float(e["weight"]))
            p = pts[ei]
            for k in range(3):
                r[3 * ei + k] = wsqrt * (p[k] - e["target"][k])
            for col, jidx in enumerate(model.free):
                if jidx not in model.anc[ei]:
                    continue
                ax = axis_w[jidx]
                rel = [p[k] - origin[jidx][k] for k in range(3)]
                jac = [
                    ax[1] * rel[2] - ax[2] * rel[1],
                    ax[2] * rel[0] - ax[0] * rel[2],
                    ax[0] * rel[1] - ax[1] * rel[0],
                ]
                for k in range(3):
                    J[3 * ei + k][col] = wsqrt * jac[k]
        for col, jidx in enumerate(model.free):
            r[3 * len(model.effectors) + col] = math.sqrt(model.lam) * (theta[jidx] - model.rest[jidx])
            J[3 * len(model.effectors) + col][col] = math.sqrt(model.lam)

        # JtJ, Jtr
        n = nf
        JtJ = [[0.0] * n for _ in range(n)]
        Jtr = [0.0] * n
        for a in range(n):
            for row in range(m):
                Ja = J[row][a]
                if Ja == 0.0:
                    continue
                Jtr[a] += Ja * r[row]
                for b in range(a, n):
                    Jb = J[row][b]
                    if Jb:
                        JtJ[a][b] += Ja * Jb
        for a in range(n):
            for b in range(a):
                JtJ[b][a] = JtJ[a][b]

        # 投影梯度停滞检测: 对每个自由变量, 若在边界且梯度指向界外则该分量可活动度为 0
        gnorm = 0.0
        for col, jidx in enumerate(model.free):
            g = Jtr[col]                       # = 1/2 * d cost/d theta
            at_lo = theta[jidx] <= model.lo[jidx] + 1e-13
            at_hi = theta[jidx] >= model.hi[jidx] - 1e-13
            active = (not at_lo or g < 0.0) and (not at_hi or g > 0.0)
            if active:
                gnorm = max(gnorm, abs(g))
        if gnorm <= GTOL:
            status = "stalled"
            reason = "projected gradient near zero: constrained local minimum (target unreachable from this pose under joint limits)"
            break

        # 阻尼求解 + 接受/拒绝
        accepted = False
        step_norm = 0.0
        while mu <= MU_MAX:
            A = [row[:] for row in JtJ]
            for a in range(n):
                A[a][a] += mu * max(JtJ[a][a], 1e-12)
            try:
                dx = cholesky_solve(A, [-v for v in Jtr])
            except ValueError:
                mu *= MU_UP
                continue
            trial = list(theta)
            for col, jidx in enumerate(model.free):
                trial[jidx] = min(max(theta[jidx] + dx[col], model.lo[jidx]), model.hi[jidx])
            step_norm = math.sqrt(sum((trial[i] - theta[i]) ** 2 for i in model.free))
            _, _, trial_total, trial_errs = model.costs(trial)
            if trial_total < total:
                rel_change = (total - trial_total) / max(1.0, abs(total))
                theta = trial
                pos, reg, total, errs = model.costs(theta)
                mu = max(MU_MIN, mu * MU_DOWN)
                accepted = True
                if record_log:
                    log.append(_log_row(it, errs, pos, reg, total, mu, step_norm))
                # 停止判定
                reached = all(d < model.tol for d in errs)
                if reached and rel_change <= FTOL:
                    status, reason = "converged", "all effector errors below tolerance and cost change below threshold"
                    mu = MU_MAX * 10  # 跳出内层
                    break
                if step_norm <= 1e-13 and rel_change <= FTOL:
                    status, reason = "stalled", "step size underflow; no further descent"
                    mu = MU_MAX * 10
                    break
                break
            mu *= MU_UP

        if status in ("converged", "stalled"):
            break
        if not accepted:
            status, reason = "stalled", "no descent direction found (local minimum or target unreachable under joint limits)"
            break
        prev_total = total

    reached = all(d < model.tol for d in errs)
    if not reached and status == "converged":
        status = "stalled"
    return {
        "theta": theta, "status": status, "reason": reason,
        "iterations": log[-1]["iteration"] if record_log else it,
        "reached": reached, "errors": errs,
        "positionCost": pos, "regCost": reg, "totalCost": total, "log": log,
    }


def _log_row(it, errs, pos, reg, total, mu, step):
    return {
        "iteration": it,
        "effectorErrors": [round(d, 10) for d in errs],
        "positionCost": pos, "regCost": reg, "totalCost": total,
        "mu": mu, "stepNorm": step,
    }


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        case = json.load(f)
    model = Model(case)
    res = solve(model)
    print("status   :", res["status"], "-", res["reason"])
    print("reached  :", res["reached"], " iterations:", res["iterations"])
    print("errors   :", [round(d, 6) for d in res["errors"]])
    print("cost pos/reg/total: %.6g / %.6g / %.6g" % (res["positionCost"], res["regCost"], res["totalCost"]))
    print("angles(deg):", [round(math.degrees(res["theta"][i]), 4) for i in range(model.n)])
    # 确定性: 同初值再跑一次, 逐位比较
    res2 = solve(Model(case))
    same = json.dumps(res["log"], sort_keys=True) == json.dumps(res2["log"], sort_keys=True)
    print("deterministic repeat identical:", same)
    if len(sys.argv) > 2:
        with open(sys.argv[2], "r", encoding="utf-8") as f:
            poses = json.load(f)
        for name, pose in poses.items():
            if not all(jid in model.index for jid in pose):
                continue
            th = [math.radians(float(j["angle"])) for j in model.joints]
            for jid, deg in pose.items():
                th[model.index[jid]] = math.radians(deg)
            _, _, _, pts = model.fk(th)
            print("FK check", name)
            for e, p in zip(model.effectors, pts):
                d = math.sqrt(sum((p[k] - e["target"][k]) ** 2 for k in range(3)))
                print("  %s p=%s target=%s err=%.3e" % (e["id"], [round(v, 6) for v in p], e["target"], d))


if __name__ == "__main__":
    main()
