"""双面联合去透印拟合。

模型（约定.txt，X、Y 均为正面坐标，背面观测已在导入时镜像）：
    正面有效处残差  r1 = X + Kf·Y − A
    背面有效处残差  r2 = Y + Kb·X − B
最小化有界目标
    F(X,Y) = Σ Mf·r1² + Σ Mb·r2² + (1/64)·Σ(X²+Y²)，   X,Y ∈ [0,1]。

缺测位置仅从观测项（前两个和）中移除；正则项与待求变量仍覆盖全图，
缺测不会把对应位置钉为零。

数值方案（全部自行实现，仅依赖 numpy 与 scipy 的通用优化/线性代数工具，
不使用任何现成去透印工具）：
- 卷积与伴随：切片平移加权累加（零边界）；
- 无约束最小二乘：自写矩阵无关 CG 解正规方程 GᵀGz=Gᵀb，提供热启动与下界；
- 有界优化：自写投影牛顿-CG（活跃集投影 + CG 求子空间牛顿步 + 回溯线搜索），
  收敛判据为 KKT 投影梯度无穷范数 ≤ 1e-6；
- L-BFGS-B 作为独立交叉校验，比较两者目标值。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize

from .kernels import Kernel

REG = 1.0 / 64.0
TOL_OPT = 1e-6
BOUND_EPS = 1e-12


# ---------------------------------------------------------------- 卷积与伴随

def apply_kernel(img: np.ndarray, k: Kernel) -> np.ndarray:
    """相关运算：out[x,y] = Σ_{u,v} K[u,v]·img[x+u−ox, y+v−oy]，域外零。"""
    h, w = img.shape
    kh, kw = k.coeffs.shape
    out = np.zeros_like(img)
    for u in range(kw):
        shift_x = u - k.ox
        ox0 = max(0, shift_x)
        ox1 = min(w, w + shift_x)
        if ox0 >= ox1:
            continue
        ix0 = ox0 - shift_x
        ix1 = ox1 - shift_x
        for v in range(kh):
            c = k.coeffs[v, u]
            if c == 0.0:
                continue
            shift_y = v - k.oy
            oy0 = max(0, shift_y)
            oy1 = min(h, h + shift_y)
            if oy0 >= oy1:
                continue
            iy0 = oy0 - shift_y
            iy1 = oy1 - shift_y
            out[oy0:oy1, ox0:ox1] += c * img[iy0:iy1, ix0:ix1]
    return out


def apply_kernel_adjoint(out: np.ndarray, k: Kernel) -> np.ndarray:
    """apply_kernel 的转置：反向平移加权求和（零边界伴随）。"""
    h, w = out.shape
    kh, kw = k.coeffs.shape
    img = np.zeros_like(out)
    for u in range(kw):
        shift_x = u - k.ox
        ox0 = max(0, shift_x)
        ox1 = min(w, w + shift_x)
        if ox0 >= ox1:
            continue
        ix0 = ox0 - shift_x
        ix1 = ox1 - shift_x
        for v in range(kh):
            c = k.coeffs[v, u]
            if c == 0.0:
                continue
            shift_y = v - k.oy
            oy0 = max(0, shift_y)
            oy1 = min(h, h + shift_y)
            if oy0 >= oy1:
                continue
            iy0 = oy0 - shift_y
            iy1 = oy1 - shift_y
            img[iy0:iy1, ix0:ix1] += c * out[oy0:oy1, ox0:ox1]
    return img


# ---------------------------------------------------------------- 问题定义

@dataclass
class Problem:
    A: np.ndarray          # 正面观测（正面坐标）
    B: np.ndarray          # 背面观测（已左右镜像到正面坐标）
    mf: np.ndarray         # 正面有效掩膜 0/1
    mb: np.ndarray         # 背面有效掩膜（随观测一起镜像）
    kf: Kernel
    kb: Kernel

    @property
    def shape(self):
        return self.A.shape

    @property
    def n(self):
        return self.A.size


def _residuals_flat(z: np.ndarray, p: Problem):
    n = p.n
    x = z[:n].reshape(p.shape)
    y = z[n:].reshape(p.shape)
    r1 = p.mf * (x + apply_kernel(y, p.kf) - p.A)
    r2 = p.mb * (y + apply_kernel(x, p.kb) - p.B)
    return x, y, r1, r2


def objective(z: np.ndarray, p: Problem) -> float:
    _, _, r1, r2 = _residuals_flat(z, p)
    n = p.n
    x = z[:n]
    y = z[n:]
    return float(np.sum(r1 * r1) + np.sum(r2 * r2) + REG * (np.sum(x * x) + np.sum(y * y)))


def gradient(z: np.ndarray, p: Problem) -> np.ndarray:
    n = p.n
    x, y, r1, r2 = _residuals_flat(z, p)
    gx = 2.0 * (r1 + apply_kernel_adjoint(r2, p.kb) + REG * x)
    gy = 2.0 * (apply_kernel_adjoint(r1, p.kf) + r2 + REG * y)
    return np.concatenate([gx.ravel(), gy.ravel()])


def hess_matvec(v: np.ndarray, z: np.ndarray, p: Problem,
                free: np.ndarray | None = None) -> np.ndarray:
    """Hessian（与 z 无关，二次目标）作用于 v；free 给定时仅在自由子空间上。

    H = 2 GᵀG + 2·REG·I，G 为观测设计矩阵（掩膜已并入）。
    """
    n = p.n
    vv = v if free is None else v * free
    vx = vv[:n].reshape(p.shape)
    vy = vv[n:].reshape(p.shape)
    h1 = p.mf * (vx + apply_kernel(vy, p.kf))
    h2 = p.mb * (vy + apply_kernel(vx, p.kb))
    hx = 2.0 * (h1 + apply_kernel_adjoint(h2, p.kb) + REG * vx)
    hy = 2.0 * (apply_kernel_adjoint(h1, p.kf) + h2 + REG * vy)
    out = np.concatenate([hx.ravel(), hy.ravel()])
    return out if free is None else out * free


# ---------------------------------------------------------------- 无约束 CG

def _cg(matvec, b: np.ndarray, x0: np.ndarray | None = None,
        tol: float = 1e-12, maxiter: int | None = None) -> tuple[np.ndarray, int]:
    """矩阵无关共轭梯度（SPD 系统），tol 为相对残差（按 b 尺度）。"""
    n = b.size
    x = np.zeros(n) if x0 is None else x0.copy()
    r = b - matvec(x)
    b_scale = float(np.sqrt(np.sum(b * b))) + 1e-300
    p = r.copy()
    rs = float(np.sum(r * r))
    if np.sqrt(rs) <= tol * b_scale:
        return x, 0
    it = 0
    limit = maxiter or (4 * n)
    while it < limit:
        hp = matvec(p)
        p_hp = float(np.sum(p * hp))
        if p_hp <= 0.0:
            break
        alpha = rs / p_hp
        x += alpha * p
        r -= alpha * hp
        rs_new = float(np.sum(r * r))
        it += 1
        if np.sqrt(rs_new) <= tol * b_scale:
            break
        p = r + (rs_new / rs) * p
        rs = rs_new
    return x, it


def lsq_reference(p: Problem) -> np.ndarray:
    """无约束最小二乘解：CG 解 GᵀGz=Gᵀb（H 含 2REG 项，SPD，条件数有界）。"""
    n = p.n
    # 右端 = 2·Gᵀb：观测平方项的梯度在 z=0 处取负
    rhs_x = 2.0 * (p.mf * p.A + apply_kernel_adjoint(p.mb * p.B, p.kb))
    rhs_y = 2.0 * (apply_kernel_adjoint(p.mf * p.A, p.kf) + p.mb * p.B)
    rhs = np.concatenate([rhs_x.ravel(), rhs_y.ravel()])
    z, _ = _cg(lambda v: hess_matvec(v, np.zeros(2 * n), p), rhs, tol=1e-13)
    return z


# ---------------------------------------------------------------- 有界优化

def projected_gradient_inf(z: np.ndarray, g: np.ndarray) -> float:
    """KKT 最优性度量：逐分量投影梯度最大绝对值。

    内点取 |g|；z=0 取 max(0,−g)；z=1 取 max(0,g)。边界判定用小容差。
    """
    at_low = z <= BOUND_EPS
    at_high = z >= 1.0 - BOUND_EPS
    interior = ~(at_low | at_high)
    err = np.zeros_like(g)
    err[interior] = np.abs(g[interior])
    err[at_low] = np.maximum(0.0, -g[at_low])
    err[at_high] = np.maximum(0.0, g[at_high])
    return float(np.max(err))


def _project(z: np.ndarray) -> np.ndarray:
    return np.clip(z, 0.0, 1.0)


def projected_newton(p: Problem, z0: np.ndarray, tol: float = TOL_OPT,
                     max_outer: int = 200, cg_tol: float = 0.1,
                     verbose: bool = False) -> tuple[np.ndarray, int, list]:
    """投影牛顿-CG（Coleman-Li 风格的简化活跃集实现）。

    每次外迭代：
      1. 计算自由集（投影梯度非零的内点 + 已离开边界的分量）；
      2. 在自由子空间上用 CG 近似求解 H·d = −g（不精确牛顿）；
      3. 投影折线回溯，保证目标充分下降。
    """
    z = _project(z0.copy())
    n2 = z.size
    history = []
    for outer in range(max_outer):
        g = gradient(z, p)
        pg_inf = projected_gradient_inf(z, g)
        f = objective(z, p)
        history.append((outer, f, pg_inf))
        if verbose:
            print(f"    outer {outer:3d} F={f:.8e} pg={pg_inf:.3e}")
        if pg_inf <= tol:
            return z, outer, history
        # 自由集：不在边界上，或在边界但梯度指向可行域内部
        at_low = z <= BOUND_EPS
        at_high = z >= 1.0 - BOUND_EPS
        free = np.ones(n2, dtype=bool)
        free[at_low & (g >= 0.0)] = False
        free[at_high & (g <= 0.0)] = False
        if not np.any(free):
            return z, outer, history
        # 不精确牛顿：CG 解自由子空间 H d = -g
        rhs = np.where(free, -g, 0.0)
        d, cg_it = _cg(
            lambda v: hess_matvec(v, z, p, free), rhs,
            tol=cg_tol, maxiter=min(200, n2),
        )
        d = np.where(free, d, 0.0)
        # 负曲率/上升方向保护
        gd = float(np.sum(g * d))
        if gd >= 0.0:
            d = np.where(free, -g, 0.0)
            gd = float(np.sum(g * d))
        # 投影回溯（Armijo）
        step = 1.0
        for _ in range(60):
            z_try = _project(z + step * d)
            f_try = objective(z_try, p)
            if f_try <= f + 1e-4 * step * gd:
                z = z_try
                break
            step *= 0.5
        else:
            # 牛顿步失败：退化为投影梯度步
            z = _project(z - g / (4.0 * 1.75 ** 2 + 2.0 * REG))
    g = gradient(z, p)
    return z, max_outer, history


# ---------------------------------------------------------------- 总入口

@dataclass
class SolveResult:
    X: np.ndarray
    Y: np.ndarray
    objective: float
    opt_inf: float
    outer_iters: int
    lbfgs_objective: float
    lbfgs_opt_inf: float
    objective_match: bool
    lsq_objective: float
    lsq_max_violation: float
    method: str


def solve(p: Problem, cross_check: bool = True) -> SolveResult:
    n = p.n
    # 热启动：无约束最小二乘解裁剪到可行域
    z_lsq = lsq_reference(p)
    z0 = np.clip(z_lsq, 0.0, 1.0)

    z, iters, _ = projected_newton(p, z0, tol=TOL_OPT)
    g = gradient(z, p)
    opt_inf = projected_gradient_inf(z, g)
    f = objective(z, p)

    # 未达标时从不同初值再跑（投影梯度兜底）
    if opt_inf > TOL_OPT:
        for alt in (np.zeros(2 * n), np.full(2 * n, 0.5)):
            z2, it2, _ = projected_newton(p, alt, tol=TOL_OPT)
            f2 = objective(z2, p)
            if f2 < f:
                z, f, iters = z2, f2, it2
                g = gradient(z, p)
                opt_inf = projected_gradient_inf(z, g)
            if opt_inf <= TOL_OPT:
                break

    # 独立交叉校验：scipy L-BFGS-B（不同算法族），目标值应一致
    lbfgs_f = float("nan")
    lbfgs_pg = float("nan")
    match = True
    if cross_check:
        r = minimize(
            objective, z0, args=(p,), jac=gradient, method="L-BFGS-B",
            bounds=[(0.0, 1.0)] * (2 * n),
            options={"maxiter": 20000, "maxfun": 40000,
                     "ftol": 0.0, "gtol": 1e-10, "maxls": 40},
        )
        lbfgs_f = float(r.fun)
        lbfgs_pg = projected_gradient_inf(r.x, gradient(r.x, p))
        # 两算法目标值相对差异应在数值容差内（任一侧稍优都可接受）
        scale = max(1.0, abs(f), abs(lbfgs_f))
        match = abs(f - lbfgs_f) <= 1e-7 * scale

    f_lsq = objective(z_lsq, p)
    viol = float(max(0.0, -z_lsq.min(), z_lsq.max() - 1.0))

    return SolveResult(
        X=z[:n].reshape(p.shape).copy(),
        Y=z[n:].reshape(p.shape).copy(),
        objective=f,
        opt_inf=opt_inf,
        outer_iters=iters,
        lbfgs_objective=lbfgs_f,
        lbfgs_opt_inf=lbfgs_pg,
        objective_match=match,
        lsq_objective=f_lsq,
        lsq_max_violation=viol,
        method="projected-newton-cg (+L-BFGS-B cross-check)",
    )


def residuals(p: Problem, x: np.ndarray, y: np.ndarray):
    """返回 (正面残差, 背面残差, Kf·Y, Kb·X)，残差=预测−观测，缺测处为 nan。"""
    bleed_f = apply_kernel(y, p.kf)
    bleed_b = apply_kernel(x, p.kb)
    r1 = x + bleed_f - p.A
    r2 = y + bleed_b - p.B
    r1_out = np.where(p.mf > 0.5, r1, np.nan)
    r2_out = np.where(p.mb > 0.5, r2, np.nan)
    return r1_out, r2_out, bleed_f, bleed_b
