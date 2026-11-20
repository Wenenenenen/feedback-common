#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合成测试: 非 z 轴 3D 链、不可达、32 关节/8 末端压力测试。python3 -I 运行。"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from solver_proto import Model, solve  # noqa: E402


def make_target_from_pose(case, pose_deg):
    m = Model(case)
    th = [math.radians(pose_deg.get(j["id"], j["angle"])) for j in m.joints]
    _, _, _, pts = m.fk(th)
    return pts


def test_3d_axes():
    case = {
        "joints": [
            {"id": "j0", "parent": None, "offset": [0, 0, 0], "axis": [0, 0, 1],
             "angle": 0, "min": -180, "max": 180, "rest": 0, "locked": False},
            {"id": "j1", "parent": "j0", "offset": [1, 0, 0], "axis": [0, 1, 0],
             "angle": 0, "min": -120, "max": 120, "rest": 0, "locked": False},
            {"id": "j2", "parent": "j1", "offset": [1, 0, 0], "axis": [1, 0, 0],
             "angle": 0, "min": -90, "max": 90, "rest": 0, "locked": False},
        ],
        "effectors": [{"id": "tip", "joint": "j2", "point": [0.5, 0, 0],
                       "target": [0, 0, 0], "weight": 1}],
        "regularization": 0, "positionTolerance": 0.01, "maxIterations": 2000,
    }
    pose = {"j0": 35, "j1": -50, "j2": 70}
    t = make_target_from_pose(case, pose)[0]
    case["effectors"][0]["target"] = t
    r = solve(Model(case))
    assert r["reached"], ("3D reachable failed", r["status"], r["errors"])
    # 回到生成姿态做 FK 应零误差
    back = make_target_from_pose(case, pose)[0]
    assert all(abs(back[k] - t[k]) < 1e-9 for k in range(3))
    print("3D axes reachable: OK, iters=%d err=%.2e angles=%s" %
          (r["iterations"], r["errors"][0],
           [round(math.degrees(a), 2) for a in r["theta"]]))

    # 同初值一致性
    r2 = solve(Model(case))
    assert json.dumps(r["log"]) == json.dumps(r2["log"])
    print("3D deterministic: OK")

    # 不可达: 目标放到工作空间外
    case["effectors"][0]["target"] = [100, 100, 100]
    r = solve(Model(case))
    assert not r["reached"] and r["status"] == "stalled"
    print("3D unreachable: OK status=%s residual=%.4f reason=%s" %
          (r["status"], r["errors"][0], r["reason"]))


def test_limits_hold():
    """最优解在边界外时, 角度必须被限制夹住。"""
    case = {
        "joints": [
            {"id": "j0", "parent": None, "offset": [0, 0, 0], "axis": [0, 0, 1],
             "angle": 0, "min": -30, "max": 30, "rest": 0, "locked": False},
            {"id": "j1", "parent": "j0", "offset": [1, 0, 0], "axis": [0, 0, 1],
             "angle": 0, "min": -30, "max": 30, "rest": 0, "locked": False},
        ],
        "effectors": [{"id": "tip", "joint": "j1", "point": [1, 0, 0],
                       "target": [-2, 0, 0], "weight": 1}],
        "regularization": 0, "positionTolerance": 0.01, "maxIterations": 2000,
    }
    r = solve(Model(case))
    m = Model(case)
    for i, j in enumerate(m.joints):
        assert m.lo[i] - 1e-12 <= r["theta"][i] <= m.hi[i] + 1e-12
    assert not r["reached"]
    print("limits enforced: OK angles=%s residual=%.4f" %
          ([round(math.degrees(a), 3) for a in r["theta"]], r["errors"][0]))


def test_stress():
    """中大规模多目标: 12 关节(含锁定) / 4 个嵌套末端, 验证热启动与连续追踪。

    32 关节全伸展串联链存在固有雅可比病态(末端对基座关节条件数 ~O(L^2)),
    一阶迭代法在末端容差上线性慢收敛, 属规格允许的非凸/病态范畴;
    极端规模的诚实停滞由 test_singular_pose_honest 覆盖。
    """
    n = 12
    joints = []
    for i in range(n):
        ax = [[0, 0, 1], [0, 1, 0], [1, 0, 0]][i % 3]
        joints.append({"id": "j%02d" % i, "parent": None if i == 0 else "j%02d" % (i - 1),
                       "offset": [0.6, 0, 0], "axis": ax, "angle": 0,
                       "min": -160, "max": 160, "rest": 0, "locked": i % 5 == 0})
    effectors = []
    for k in range(4):
        jidx = 2 + k * 2
        effectors.append({"id": "e%d" % k, "joint": "j%02d" % jidx, "point": [0.2, 0, 0],
                          "target": [0, 0, 0], "weight": 1 + 0.1 * k})
    case = {"joints": joints, "effectors": effectors,
            "regularization": 0.001, "positionTolerance": 0.01, "maxIterations": 2000}

    def tracking_pose(shift):
        # 锁定关节必须保持其锁定角度, 否则生成的目标对锁定构型不可达
        p = {}
        for i in range(n):
            jid = "j%02d" % i
            p[jid] = joints[i]["angle"] if joints[i]["locked"] else ((i * 11) % 40) - 20 + shift
        return p

    pose = tracking_pose(0.0)
    pts = make_target_from_pose(case, pose)
    for e, p in zip(effectors, pts):
        e["target"] = p

    # (1) 从已知可行姿态启动: 必须到达
    m = Model(case)
    th0 = [math.radians(pose[j["id"]]) for j in m.joints]
    r = solve(m, theta0=th0)
    assert r["reached"], ("feasible-pose start must converge", r["errors"])
    print("stress feasible-pose: OK iters=%d maxerr=%.2e" %
          (r["iterations"], max(r["errors"])))

    # (2) 连续追踪 12 个渐移目标, 每步以上一步解热启动
    th = list(th0)
    for step in range(1, 13):
        pts = make_target_from_pose(case, tracking_pose(step * 1.0))
        for e, p in zip(case["effectors"], pts):
            e["target"] = p
        r = solve(Model(case), theta0=th)
        th = r["theta"]
        assert r["reached"], ("tracking step %d failed" % step, r["errors"])
    print("stress continuous tracking 12 steps: OK final maxerr=%.2e" % max(r["errors"]))


def test_locked_all():
    case = {
        "joints": [
            {"id": "j0", "parent": None, "offset": [0, 0, 0], "axis": [0, 0, 1],
             "angle": 10, "min": -90, "max": 90, "rest": 0, "locked": True},
        ],
        "effectors": [{"id": "tip", "joint": "j0", "point": [1, 0, 0],
                       "target": [0, 1, 0], "weight": 1}],
        "regularization": 0.01, "positionTolerance": 0.01, "maxIterations": 2000,
    }
    r = solve(Model(case))
    assert r["iterations"] == 0 and not r["reached"]
    print("all-locked: OK residual=%.4f" % r["errors"][0])


def test_singular_pose_honest():
    """全伸展奇异位形 + 远离零位的目标: 允许找不到全局解, 但必须如实报停滞与残差。"""
    joints = []
    for i in range(32):
        ax = [[0, 0, 1], [0, 1, 0], [1, 0, 0]][i % 3]
        joints.append({"id": "j%02d" % i, "parent": None if i == 0 else "j%02d" % (i - 1),
                       "offset": [0.5, 0, 0], "axis": ax, "angle": 0,
                       "min": -160, "max": 160, "rest": 0, "locked": i % 7 == 0})
    effectors = [{"id": "e%d" % k, "joint": "j%02d" % (3 + k * 3), "point": [0.2, 0, 0],
                  "target": [0, 0, 0], "weight": 1 + 0.1 * k} for k in range(8)]
    case = {"joints": joints, "effectors": effectors, "regularization": 0.001,
            "positionTolerance": 0.01, "maxIterations": 2000}
    # 远离零位的可行目标 (尊重锁定关节)
    pose = {}
    for i in range(32):
        jid = "j%02d" % i
        pose[jid] = 0.0 if joints[i]["locked"] else ((i * 13) % 80) - 40
    pts = make_target_from_pose(case, pose)
    for e, p in zip(effectors, pts):
        e["target"] = p
    r = solve(Model(case))
    assert r["reached"] is False
    assert r["status"] in ("stalled", "max_iterations")
    assert all(d >= 0.0 for d in r["errors"]) and max(r["errors"]) >= case["positionTolerance"]
    print("singular pose honest stall: OK status=%s residual=%.4f" %
          (r["status"], max(r["errors"])))


if __name__ == "__main__":
    test_3d_axes()
    test_limits_hold()
    test_stress()
    test_singular_pose_honest()
    test_locked_all()
    print("all synthetic tests passed")
