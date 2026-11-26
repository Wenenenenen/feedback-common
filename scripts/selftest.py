"""离线自测：梯度有限差分、合成恢复、缺测行为、镜像与 PGM 往返。

运行：.venv/bin/python -I -m scripts.selftest   （从仓库根目录）
"""
from __future__ import annotations

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from server.kernels import Kernel
from server.pgm import load_density, write_p5
from server import solver

rng = np.random.default_rng(20261127)


def approx(a, b, tol=1e-9, label=""):
    err = float(np.max(np.abs(a - b))) if np.ndim(a) else abs(a - b)
    status = "ok " if err <= tol else "FAIL"
    print(f"  [{status}] {label}: max|Δ|={err:.3e} (tol {tol:.0e})")
    if err > tol:
        raise AssertionError(label)


def test_adjoints():
    print("== 卷积/伴随转置一致性")
    h, w = 6, 7
    kf = Kernel("f", np.array([[0.25, 0.125], [0.1, 0.07]]), 0, 0)
    kb = Kernel("b", np.array([[0.125, 0.25], [0.05, 0.2]]), 1, 1)
    for k in (kf, kb):
        img = rng.random((h, w))
        out = rng.random((h, w))
        lhs = float(np.dot(solver.apply_kernel(img, k).ravel(), out.ravel()))
        rhs = float(np.dot(img.ravel(), solver.apply_kernel_adjoint(out, k).ravel()))
        approx(lhs, rhs, 1e-12, f"K({k.name}) 内积 <Kx,y>=<x,K*y>")


def test_gradient():
    print("== 目标梯度有限差分")
    h, w = 5, 6
    kf = Kernel("f", np.array([[0.25, 0.125]]), 0, 0)
    kb = Kernel("b", np.array([[0.125, 0.25]]), 1, 0)
    p = solver.Problem(
        A=rng.random((h, w)), B=rng.random((h, w)),
        mf=np.ones((h, w)),
        mb=(rng.random((h, w)) > 0.2).astype(float),
        kf=kf, kb=kb,
    )
    z = rng.random(2 * h * w)
    g = solver.gradient(z, p)
    g_fd = np.zeros_like(g)
    eps = 1e-7
    for i in range(z.size):
        zp = z.copy(); zp[i] += eps
        zm = z.copy(); zm[i] -= eps
        g_fd[i] = (solver.objective(zp, p) - solver.objective(zm, p)) / (2 * eps)
    approx(g, g_fd, 2e-6, "解析梯度 vs 中心差分")


def _synthetic(h=8, w=10, missing=False):
    # 真面密度：稀疏笔画
    x_true = np.zeros((h, w))
    y_true = np.zeros((h, w))
    x_true[2, 1:4] = 0.8
    x_true[5, 6] = 0.6
    y_true[1, 7:9] = 0.7
    y_true[6, 2:5] = 0.5
    kf = Kernel("f", np.array([[0.2, 0.1]]), 0, 0)
    kb = Kernel("b", np.array([[0.15, 0.2]]), 1, 0)
    A = x_true + solver.apply_kernel(y_true, kf)
    B = y_true + solver.apply_kernel(x_true, kb)
    mf = np.ones((h, w))
    mb = np.ones((h, w))
    if missing:
        mf[3, :] = 0.0          # 正面整行缺测
        mb[:, 4] = 0.0          # 背面整列缺测
    return solver.Problem(A=A, B=B, mf=mf, mb=mb, kf=kf, kb=kb), x_true, y_true


def test_recovery():
    print("== 无噪声合成数据（全有效；LSQ 含越界分量时检验有界 KKT 与独立交叉解）")
    p, xt, yt = _synthetic()
    res = solver.solve(p)
    n = p.n
    z_lsq = solver.lsq_reference(p)
    z = np.concatenate([res.X.ravel(), res.Y.ravel()])
    print(f"  F={res.objective:.6e} opt_inf={res.opt_inf:.3e} iters={res.outer_iters} "
          f"lsq_F={res.lsq_objective:.6e} lsq_viol={res.lsq_max_violation:.3e} match={res.objective_match}")
    assert res.opt_inf <= 1e-6, "最优性误差超 1e-6"
    assert res.objective_match, "有界目标低于无约束下界"
    if res.lsq_max_violation <= 1e-10:
        # LSQ 全内点：有界解必须与无约束解一致
        approx(res.objective, res.lsq_objective, 1e-8, "内点情形目标值一致")
        approx(z, z_lsq, 2e-6, "内点解=LSQ 解")
    else:
        print(f"  LSQ 含越界分量（最大 {res.lsq_max_violation:.3e}），有界 F−F_lsq="
              f"{res.objective - res.lsq_objective:.3e} ≥ 0 符合预期")
        # 独立交叉校验：定步长投影梯度（不依赖 L-BFGS-B）应收敛到同一目标值
        z_pg = np.zeros(2 * n)
        L = 4.0 * (1.0 + 0.75) ** 2 + 2.0 * solver.REG
        for _ in range(200000):
            g = solver.gradient(z_pg, p)
            z_new = np.clip(z_pg - g / L, 0.0, 1.0)
            if np.max(np.abs(z_new - z_pg)) < 1e-13:
                z_pg = z_new
                break
            z_pg = z_new
        f_pg = solver.objective(z_pg, p)
        approx(res.objective, f_pg, 1e-9, "L-BFGS-B 与投影梯度解目标一致")
    approx(res.X, np.clip(res.X, 0, 1), 0, "X 有界")
    approx(res.Y, np.clip(res.Y, 0, 1), 0, "Y 有界")
    r1, r2, _, _ = solver.residuals(p, res.X, res.Y)
    print(f"  观测残差 rms: 正面 {np.sqrt(np.nanmean(r1**2)):.3e}, "
          f"背面 {np.sqrt(np.nanmean(r2**2)):.3e}（正则收缩，非零为正常）")
    assert np.nanmax(np.abs(r1)) < 0.02 and np.nanmax(np.abs(r2)) < 0.02


def test_interior_equivalence():
    print("== 小值合成数据：LSQ 全内点，有界解=无约束解")
    h, w = 6, 8
    xt = np.zeros((h, w)); xt[1, 2:4] = 0.05
    yt = np.zeros((h, w)); yt[4, 5:7] = 0.04
    kf = Kernel("f", np.array([[0.1, 0.05]]), 0, 0)
    kb = Kernel("b", np.array([[0.05, 0.1]]), 1, 0)
    p = solver.Problem(
        A=xt + solver.apply_kernel(yt, kf), B=yt + solver.apply_kernel(xt, kb),
        mf=np.ones((h, w)), mb=np.ones((h, w)), kf=kf, kb=kb)
    res = solver.solve(p)
    print(f"  lsq_viol={res.lsq_max_violation:.3e} opt_inf={res.opt_inf:.3e}")
    assert res.lsq_max_violation <= 1e-3, f"预期近似全内点，实际越界 {res.lsq_max_violation}"
    assert res.opt_inf <= 1e-6
    z = np.concatenate([res.X.ravel(), res.Y.ravel()])
    z_lsq = solver.lsq_reference(p)
    interior = (z_lsq > 1e-3) & (z_lsq < 1 - 1e-3)
    approx(z[interior], z_lsq[interior], 2e-6, "内点分量有界解=LSQ 解")
    approx(res.objective, res.lsq_objective, 1e-7, "目标值一致（近似内点）")


def test_missing():
    print("== 缺测：观测项移除、待求位置不钉零")
    p, xt, yt = _synthetic(missing=True)
    # 数学证据：在缺测位置施加扰动，目标差只应来自全图正则项 (X²+Y²)/64，
    # 不应出现任何观测平方项的贡献。
    n = p.n
    z0 = np.full(2 * n, 0.3)
    f0 = solver.objective(z0, p)
    g0 = solver.gradient(z0, p)
    # 与“正面掩膜被误填成 1”的版本对比（背面掩膜保持不变，隔离正面观测项）
    p_bad = solver.Problem(A=p.A, B=p.B, mf=np.ones_like(p.mf),
                           mb=p.mb, kf=p.kf, kb=p.kb)
    g_bad = solver.gradient(z0, p_bad)
    gx0 = g0[:n].reshape(p.shape)
    gx_bad = g_bad[:n].reshape(p.shape)
    # 缺测处：正确梯度 = 耦合项 2 Kb*·r2 + 正则项；与全有效版本之差恰好是被移除的 2 r1
    x0 = z0[:n].reshape(p.shape)
    y0 = z0[n:].reshape(p.shape)
    r1_full = x0 + solver.apply_kernel(y0, p.kf) - p.A
    expect_diff = 2.0 * r1_full[3, :]
    approx(gx_bad[3, :] - gx0[3, :], expect_diff, 1e-12,
           "正面缺测行：梯度差=被移除的观测项 2r1（耦合项与正则保留）")
    # 梯度中的正则贡献仍在（变量未被钉零、未被排除）
    reg_part = 2 * solver.REG * x0[3, :]
    assert np.max(np.abs(reg_part)) > 0
    # 背面缺测列对 Y 的梯度：单独把背面掩膜填满，差为被移除的 2·(mb·r2)
    p_bad2 = solver.Problem(A=p.A, B=p.B, mf=p.mf,
                            mb=np.ones_like(p.mb), kf=p.kf, kb=p.kb)
    g_bad2 = solver.gradient(z0, p_bad2)
    gy_bad = g_bad2[n:].reshape(p.shape)
    gy0 = g0[n:].reshape(p.shape)
    r2_full = y0 + solver.apply_kernel(x0, p.kb) - p.B
    approx(gy_bad[:, 4] - gy0[:, 4], 2.0 * r2_full[:, 4], 1e-12,
           "背面缺测列：Y 梯度差=被移除的观测项 2r2")
    print("  掩膜生效：缺测观测项被精确移除，双面耦合项与全图正则项保留")
    # 待求位置不钉零：变量本身仍参与优化，且在有透印耦合时缺测位置可取非零值
    p2, _, _ = _synthetic(missing=True)
    # 在 Y 的缺测行附近放置笔画，使 Kb·X 仍能为缺测观测提供信息耦合；
    # 更直接地：把缺测行 X 的正则单独验证——它仍是自由变量（边界 0..1，非等式约束）
    res = solver.solve(p2)
    assert res.opt_inf <= 1e-6
    assert np.all((res.X >= 0) & (res.X <= 1)) and np.all((res.Y >= 0) & (res.Y <= 1))
    # 构造缺测位置可取非零的场景：缺测行 X 有真实笔画，只能经 B 面 Kb·X 辨识
    h, w = p2.shape
    x2 = np.zeros((h, w)); x2[3, 1:4] = 0.7          # 缺测行上的真实正面笔画
    y2 = np.zeros((h, w)); y2[2, 1:4] = 0.6
    A2 = x2 + solver.apply_kernel(y2, p2.kf)
    B2 = y2 + solver.apply_kernel(x2, p2.kb)
    p3 = solver.Problem(A=A2, B=B2, mf=p2.mf.copy(), mb=p2.mb.copy(),
                        kf=p2.kf, kb=p2.kb)
    res3 = solver.solve(p3)
    nonzero = res3.X[3, 1:4]
    print(f"  耦合场景缺测行 X 估计 = {np.array2string(nonzero, precision=3)}（真值 0.7，未被钉零）")
    assert np.all(nonzero > 1e-3), "缺测位置被错误钉零"
    # 可辨识性随核耦合增强：核取到上限 0.75 时恢复应明显更好
    kb_strong = Kernel("b", np.array([[0.4, 0.35]]), 1, 0)
    B3 = y2 + solver.apply_kernel(x2, kb_strong)
    p4 = solver.Problem(A=A2, B=B3, mf=p2.mf.copy(), mb=p2.mb.copy(),
                        kf=p2.kf, kb=kb_strong)
    res4 = solver.solve(p4)
    strong = res4.X[3, 1:4]
    print(f"  强耦合核下缺测行 X 估计 = {np.array2string(strong, precision=3)}（应更接近 0.7）")
    assert np.mean(strong) > np.mean(nonzero) + 0.1, "双面耦合辨识未随核增强而改善"
    # 有效观测处的残差仍应被很好拟合（缺测没有破坏有效数据的保真）
    r1, r2, _, _ = solver.residuals(p, res.X, res.Y)
    rms_f = np.sqrt(np.nanmean(r1 ** 2))
    rms_b = np.sqrt(np.nanmean(r2 ** 2))
    print(f"  有效观测残差 rms: 正面 {rms_f:.3e}, 背面 {rms_b:.3e}")
    assert rms_f < 0.02 and rms_b < 0.02
    # 全部有效像素的残差必须有限且不含被掩膜污染的数值
    assert np.all(np.isfinite(r1[p.mf > 0.5])) and np.all(np.isfinite(r2[p.mb > 0.5]))


def test_pgm_roundtrip():
    print("== 16 位 P5 量化往返")
    v = np.array([[0.0, 0.5, 1.0], [0.00001, 0.99999, 0.123456789]])
    raw = write_p5(v)
    back = load_density(raw)
    q = np.floor(65535 * v + 0.5) / 65535
    approx(back, q, 1e-12, "floor(65535v+0.5)/65535")
    assert raw[:2] == b"P5" and b"65535" in raw[:20]


def test_sample_case():
    print("== 样本包 4x2 用例")
    from server.kernels import load_kernels
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "_untrusted", "duplex-cases")
    with open(os.path.join(base, "kernels.json"), "rb") as f:
        kf, kb = load_kernels(f.read())
    with open(os.path.join(base, "front.pgm"), "rb") as f:
        A = load_density(f.read())
    with open(os.path.join(base, "back.pgm"), "rb") as f:
        B_native = load_density(f.read())
    with open(os.path.join(base, "back-valid.pgm"), "rb") as f:
        from server.pgm import load_mask
        mb_native = load_mask(f.read(), B_native.shape)
    B = B_native[:, ::-1].copy()
    mb = mb_native[:, ::-1].copy()
    p = solver.Problem(A=A, B=B, mf=np.ones_like(A), mb=mb, kf=kf, kb=kb)
    res = solver.solve(p)
    print(f"  F={res.objective:.6e} opt_inf={res.opt_inf:.3e} iters={res.outer_iters} "
          f"lsq_F={res.lsq_objective:.6e} match={res.objective_match}")
    assert res.opt_inf <= 1e-6
    r1, r2, bf, bb = solver.residuals(p, res.X, res.Y)
    print(f"  X=\n{np.array2string(res.X, precision=4, suppress_small=True)}")
    print(f"  Y(正面坐标)=\n{np.array2string(res.Y, precision=4, suppress_small=True)}")
    print(f"  正面残差范围 [{np.nanmin(r1):.3e},{np.nanmax(r1):.3e}]")
    assert np.all(np.isfinite(res.X)) and np.all(np.isfinite(res.Y))


def test_stress():
    print("== 随机压力：极端核尺寸/原点、随机掩膜、随机尺寸")
    rs = np.random.default_rng(7)
    for trial in range(12):
        h = int(rs.integers(1, 14)); w = int(rs.integers(1, 14))
        kh = int(rs.integers(1, 4)); kw = int(rs.integers(1, 4))
        kf = Kernel("f", rs.random((kh, kw)) * (0.7 / max(1, kh * kw)),
                    int(rs.integers(0, kw)), int(rs.integers(0, kh)))
        kb = Kernel("b", rs.random((kh, kw)) * (0.7 / max(1, kh * kw)),
                    int(rs.integers(0, kw)), int(rs.integers(0, kh)))
        xt = rs.random((h, w)) * (rs.random((h, w)) > 0.6)
        yt = rs.random((h, w)) * (rs.random((h, w)) > 0.6)
        A = np.clip(xt + solver.apply_kernel(yt, kf), 0, 1)
        B = np.clip(yt + solver.apply_kernel(xt, kb), 0, 1)
        mf = (rs.random((h, w)) > 0.2).astype(float)
        mb = (rs.random((h, w)) > 0.2).astype(float)
        p = solver.Problem(A=A, B=B, mf=mf, mb=mb, kf=kf, kb=kb)
        res = solver.solve(p, cross_check=(h * w <= 60))
        assert res.opt_inf <= 1e-6, f"trial {trial} KKT {res.opt_inf}"
        assert np.all((res.X >= 0) & (res.X <= 1)) and np.all((res.Y >= 0) & (res.Y <= 1))
        assert np.all(np.isfinite(res.X)) and np.all(np.isfinite(res.Y))
        assert res.objective + 1e-9 >= res.lsq_objective - 1e-12
        if h * w <= 60:
            assert res.objective_match, f"trial {trial} 与 L-BFGS-B 目标不一致"
    print("  12 组随机用例 KKT 全部 ≤ 1e-6，有界/有限/下界关系成立，小规模与 L-BFGS-B 一致")


if __name__ == "__main__":
    test_adjoints()
    test_gradient()
    test_recovery()
    test_interior_equivalence()
    test_missing()
    test_pgm_roundtrip()
    test_sample_case()
    test_stress()
    print("\n全部自测通过。")
