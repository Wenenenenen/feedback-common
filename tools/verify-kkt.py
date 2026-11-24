#!/usr/bin/env python3
"""对 JS 求解器（js/qp.js）在大尺寸问题上的结果做独立最优性核验。

- 用稠密 numpy 复算 H、b，检查 KKT 残差；
- 再用投影梯度（FISTA 风格）基线的代价对比，确认 JS 解不劣于基线。

JS 侧导出待检问题与解（node tools/kkt-export.js > 文件），本脚本读取后核验。
运行：python3 tools/verify-kkt.py [cases.json]
"""
import json
import math
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_cases(path=None):
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    # 现场生成
    out = subprocess.run(
        ['node', os.path.join(ROOT, 'tools', 'kkt-export.js')],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def build_H(m, lam):
    H = np.eye(m)
    if lam != 0 and m >= 3:
        D = np.zeros((m - 2, m))
        for r in range(m - 2):
            D[r, r] = 1
            D[r, r + 1] = -2
            D[r, r + 2] = 1
        H = H + lam * (D.T @ D)
    return H


def kkt(H, b, u, bound, pinned):
    m = len(u)
    g = H @ u - b
    worst = 0.0
    where = -1
    for i in range(m):
        if i in pinned:
            continue
        if u[i] >= bound - 1e-9:
            v = max(0.0, g[i])
        elif u[i] <= -bound + 1e-9:
            v = max(0.0, -g[i])
        else:
            v = abs(g[i])
        if v > worst:
            worst, where = v, i
    return worst, where


def objective(p, u, lam):
    e = float(np.sum(u * u))
    if lam and len(p) >= 3:
        q = p - u
        d2 = q[:-2] - 2 * q[1:-1] + q[2:]
        e += lam * float(np.sum(d2 * d2))
    return e


def banded_mv(v, lam):
    """H v 的五对角乘（避免构造稠密矩阵）。"""
    m = len(v)
    out = v.copy()
    if lam and m >= 3:
        # D^T D v
        a = v[:-2] - 2 * v[1:-1] + v[2:]
        w = np.zeros(m)
        w[:-2] += a
        w[1:-1] += -2 * a
        w[2:] += a
        out = out + lam * w
    return out


def banded_b(p, lam):
    m = len(p)
    if not lam or m < 3:
        return np.zeros(m)
    a = p[:-2] - 2 * p[1:-1] + p[2:]
    w = np.zeros(m)
    w[:-2] += a
    w[1:-1] += -2 * a
    w[2:] += a
    return lam * w


def projected_gradient(p, lam, bound, pinned, iters=6000):
    m = len(p)
    u = np.zeros(m)
    for i, v in pinned.items():
        u[i] = v
    b = banded_b(p, lam)
    # 五对角 Gershgorin 上界
    d = np.ones(m)
    if lam and m >= 3:
        d = d + lam * np.array([1 if i in (0, m - 1) and m > 3 else 4 if i in (1, m - 2) and m > 3 else 6 for i in range(m)]) if m > 3 else d + lam * 4
    L = float(np.max(d) + 2 * lam * 2 + 2 * lam) if lam else 1.0
    step = 1.0 / max(1e-9, L)
    idx = list(pinned.keys())
    for _ in range(iters):
        g = banded_mv(u, lam) - b
        new = np.clip(u - step * g, -bound, bound)
        if idx:
            new[idx] = [pinned[i] for i in idx]
        delta = float(np.max(np.abs(new - u)))
        u = new
        if delta < 1e-14:
            break
    return u


def main():
    data = load_cases(sys.argv[1] if len(sys.argv) > 1 else None)
    worst_kkt = 0.0
    worst_cost_gap = 0.0
    for c in data['cases']:
        p = np.array(c['p'], dtype=float)
        lam = c['lambda']
        bound = c['bound']
        u = np.array(c['u'], dtype=float)
        pinned = {int(k): float(v) for k, v in c['pins'].items()}
        m = len(p)
        H = build_H(m, lam)
        # b = lam D^T D p
        if lam and m >= 3:
            D = np.zeros((m - 2, m))
            for r in range(m - 2):
                D[r, r] = 1
                D[r, r + 1] = -2
                D[r, r + 2] = 1
            b = lam * (D.T @ (D @ p))
        else:
            b = np.zeros(m)
        w, where = kkt(H, b, u, bound, pinned)
        worst_kkt = max(worst_kkt, w)
        # 可行性
        viol = max(0.0, float(np.max(np.abs(u) - bound)))
        pinned_err = max([abs(u[i] - v) for i, v in pinned.items()] or [0.0])
        cost = objective(p, u, lam)
        pg = projected_gradient(p, lam, bound, pinned)
        pg_cost = objective(p, pg, lam)
        rel = (cost - pg_cost) / max(1.0, abs(cost))
        worst_cost_gap = max(worst_cost_gap, rel)
        status = 'OK' if w <= 1e-7 and viol <= 1e-9 and pinned_err <= 1e-9 and rel <= 1e-9 else 'FAIL'
        print(f"  [{status}] {c['name']:<22} m={m:<5} λ={lam:<7} "
              f"KKT={w:.2e} 越界={viol:.1e} 锁点误差={pinned_err:.1e} 相对代价差={rel:.2e}")
    print(f"\n最大 KKT 残差 {worst_kkt:.3e}；最大相对代价差 {worst_cost_gap:.3e}（应 ≤ 0 或极小）")
    if worst_kkt > 1e-7 or worst_cost_gap > 1e-9:
        print('KKT 核验未通过')
        sys.exit(1)
    print('KKT 核验全部通过')


if __name__ == '__main__':
    main()
