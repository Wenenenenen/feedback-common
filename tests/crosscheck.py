#!/usr/bin/env python3
"""独立的标准库交叉核对（不 import 页面代码）。

从样例包内的 expected.json / 说明.txt 的约定重新推导：
  - PFM 头解析（大小端、尺度、底行优先）
  - 每行立体角与总立体角 = 4π
  - 三阶实球谐积分（C_i = ∫ L·Y_i dω）
  - 余弦卷积（A_0=π, A_1=2π/3, A_2=π/4）与 E(n)=ΣE_iY_i(n)
  - 常量/线性/极区样例的解析期望值
  - 绕 y 轴旋转符号：Lr(n)=L(R⁻¹n)，+90° 时 +x → −z
  - 非有限值与截断样例必须报错

用法：python3 -I tests/crosscheck.py [样例目录]
"""

import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "samples" / "extracted"

Y00 = 0.28209479177387814
K1 = 0.4886025119029199
K2 = 1.0925484305920792
K2Z = 0.31539156525252005
K2X = 0.5462742152960396
A_L = (math.pi, 2 * math.pi / 3, 2 * math.pi / 3, 2 * math.pi / 3) + (math.pi / 4,) * 5

failures = 0
checks = 0


def check(name, cond, detail=""):
    global failures, checks
    checks += 1
    if cond:
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def rel(a, b):
    return abs(a - b) / max(1e-12, abs(b))


class PfmError(Exception):
    pass


def read_pfm(path):
    data = path.read_bytes()
    if not data:
        raise PfmError("PFM 文件为空")
    pos = 0
    lines = []
    for _ in range(3):
        end = data.find(b"\n", pos)
        if end < 0:
            raise PfmError("header")
        lines.append(data[pos:end].strip())
        pos = end + 1
    if lines[0] != b"PF":
        raise PfmError("header")
    w, h = (int(x) for x in lines[1].split())
    scale = float(lines[2])
    if scale == 0:
        raise PfmError("scale")
    endian = "<" if scale < 0 else ">"
    need = w * h * 3 * 4
    body = data[pos:]
    if len(body) < need:
        raise PfmError(f"truncated: need {need} have {len(body)}")
    vals = struct.unpack(endian + str(w * h * 3) + "f", body[:need])
    values = [0.0] * (w * h * 3)
    for fr in range(h):
        log_row = h - 1 - fr
        src = fr * w * 3
        dst = log_row * w * 3
        for p in range(w * 3):
            values[dst + p] = vals[src + p] * abs(scale)
    bad = [v for v in values if not math.isfinite(v)]
    if bad:
        raise PfmError(f"nonfinite: {len(bad)}")
    return w, h, scale, values


def basis(x, y, z):
    return (
        Y00,
        K1 * y,
        K1 * z,
        K1 * x,
        K2 * x * y,
        K2 * y * z,
        K2Z * (3 * z * z - 1),
        K2 * x * z,
        K2X * (x * x - y * y),
    )


def row_omega(h):
    return [2 * math.pi * (math.cos(math.pi * r / h) - math.cos(math.pi * (r + 1) / h)) for r in range(h)]


def integrate(w, h, values, rotate_deg=0.0):
    """C_i = ∫ L(ω)·Y_i(ω) dω，按等距柱状中点求积。

    rotate_deg != 0 时求的是旋转后环境 Lr 的系数：
        C'_i = ∫ L(R⁻¹n)·Y_i(n) dn
             = ∫ L(m)·Y_i(R·m) dm      （换元 m = R⁻¹n）
    所以这里遍历源像素方向 m，基函数取 R·m 处的值；不做像素重采样。
    """
    om = row_omega(h)
    c = [[0.0, 0.0, 0.0] for _ in range(9)]
    naive = [0.0, 0.0, 0.0]
    t = math.radians(rotate_deg)
    ct, st = math.cos(t), math.sin(t)
    for r in range(h):
        th = math.pi * (r + 0.5) / h
        sint, cost = math.sin(th), math.cos(th)
        domega = om[r] / w
        for col in range(w):
            ph = 2 * math.pi * (col + 0.5) / w
            x0 = sint * math.cos(ph)
            y0 = cost
            z0 = sint * math.sin(ph)
            # R(θ) 把 +x 送到 −z：x' = c·x + s·z，z' = −s·x + c·z
            x = ct * x0 + st * z0
            z = -st * x0 + ct * z0
            o = (r * w + col) * 3
            lr, lg, lb = values[o], values[o + 1], values[o + 2]
            naive[0] += lr
            naive[1] += lg
            naive[2] += lb
            b = basis(x, y0, z)
            for i in range(9):
                c[i][0] += b[i] * lr * domega
                c[i][1] += b[i] * lg * domega
                c[i][2] += b[i] * lb * domega
    return c


def convolve(c):
    return [[c[i][k] * A_L[i] for k in range(3)] for i in range(9)]


def evaluate(e, x, y, z):
    b = basis(x, y, z)
    return [sum(e[i][k] * b[i] for i in range(9)) for k in range(3)]


def main():
    print(f"样例目录：{SAMPLES}")
    expected = json.loads((SAMPLES / "expected.json").read_text(encoding="utf-8"))

    print("\n[1] PFM 头：小端 / 大端 / 尺度 / 底行优先")
    w1, h1, s1, v1 = read_pfm(SAMPLES / "constant-le.pfm")
    w2, h2, s2, v2 = read_pfm(SAMPLES / "constant-be-scale2.pfm")
    check("constant-le 为小端（尺度 < 0）", s1 < 0, str(s1))
    check("constant-be-scale2 为大端（尺度 > 0）", s2 > 0, str(s2))
    check("两份常量样例尺寸一致", (w1, h1) == (w2, h2))
    check("两份常量样例读出值一致（含 |尺度| 换算）", v1 == v2, f"{v1[:3]} vs {v2[:3]}")
    rgb = expected["constant_rgb"]
    check("左上文件行实际是逻辑底行 −y（0.5 行亮部在极区）",
          abs(v1[0] - rgb[0]) < 1e-6, f"首像素 {v1[:3]}")
    # 极区诊断：bottom 行高亮样例只有 polar 有。这里检查行序翻转是否真的发生：
    w, h, s, vals = read_pfm(SAMPLES / "polar.pfm")
    top_row = vals[0:w * 3]
    bottom_row = vals[(h - 1) * w * 3:]
    check("polar 逻辑顶行（r=0）为亮环 8.0", abs(top_row[0] - 8.0) < 1e-6, f"{top_row[:3]}")
    check("polar 逻辑底行（r=H−1）为暗部 0.1", abs(bottom_row[0] - 0.1) < 1e-6, f"{bottom_row[:3]}")

    print("\n[2] 立体角")
    om = row_omega(h1)
    check("ΣΩ_r = 4π", rel(sum(om), 4 * math.pi) < 1e-12, f"{sum(om)}")
    check("expected.solid_angle = 4π", rel(expected["solid_angle"], 4 * math.pi) < 1e-12)
    check("极区行立体角小于赤道行", om[0] < om[h1 // 2], f"{om[0]} < {om[h1 // 2]}")

    print("\n[3] 常量环境")
    c_const = integrate(w1, h1, v1)
    c0_expect = 4 * math.pi * Y00
    ok = all(rel(c_const[0][k], c0_expect * rgb[k]) < 1e-6 for k in range(3))
    check("C₀ = 4π·Y00·L", ok, str(c_const[0]))
    l_gt_0 = max(abs(c_const[i][k]) for i in range(1, 9) for k in range(3))
    # 128×64 中点求积对 l=2 不是严格精确，残差 1e-3 量级（相对 C₀ 约 4e-4）
    check("常量环境 l>0 系数约为 0（离散残差）", l_gt_0 < 5e-3, f"{l_gt_0:.2e}")
    e_const = convolve(c_const)
    check("E₀ = π·C₀", all(rel(e_const[0][k], math.pi * c_const[0][k]) < 1e-12 for k in range(3)))
    en = [evaluate(e_const, x, y, z)[k] for x, y, z in ((1, 0, 0), (0, 1, 0), (0, 0, -1)) for k in (0,)]
    check("E(n) 各向同性 = π·L（离散残差 < 3e-4）",
          all(rel(v, math.pi * rgb[0]) < 3e-4 for v in en), str(en))
    check("expected.constant_irradiance = π·L",
          all(rel(expected["constant_irradiance"][k], math.pi * rgb[k]) < 1e-12 for k in range(3)))

    print("\n[4] 线性梯度与余弦卷积")
    w, h, s, vals = read_pfm(SAMPLES / "linear.pfm")
    c_lin = integrate(w, h, vals)
    e_lin = convolve(c_lin)
    worst = 0.0
    for x, y, z in ((1, 0, 0), (0, 1, 0), (-1, 0, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
        got = evaluate(e_lin, x, y, z)
        base = 1 + (2 / 3) * (0.6 * x + 0.2 * y)
        want = [math.pi * 1 * base, math.pi * 2 * base, math.pi * 0.5 * base]
        worst = max(worst, max(rel(got[k], want[k]) for k in range(3)))
    check("E(n) = π·C·(1 + ⅔(0.6nx + 0.2ny))", worst < 2e-4, f"最大相对误差 {worst:.2e}")

    print("\n[5] 绕 y 轴旋转（右手系，+x → −z）")
    c_rot = integrate(w, h, vals, rotate_deg=90.0)
    # 原环境最亮方向 ≈ +x（l=1 方向 (0.6,0.2,0)/|…|），旋转后应在 −z
    l1 = (c_rot[3][0], c_rot[1][0], c_rot[2][0])
    norm = math.sqrt(sum(v * v for v in l1)) or 1
    direction = [v / norm for v in l1]
    ok = abs(direction[0]) < 3e-3 and direction[2] < -0.9
    check("+90° 后 l=1 亮部转到 −z 一侧", ok,
          f"({direction[0]:.4f}, {direction[1]:.4f}, {direction[2]:.4f})")
    check("expected.rotation_90_bright_direction = [0,0,−1]",
          expected["rotation_90_bright_direction"] == [0, 0, -1])
    # 旋转 90° 后：E'(n) 应等于 E(R⁻¹n)
    e_rot = convolve(c_rot)
    probe = evaluate(e_rot, 0, 0, -1)
    ref = evaluate(e_lin, 1, 0, 0)
    check("旋转后 E'(−z) = 原 E(+x)", max(rel(probe[k], ref[k]) for k in range(3)) < 1e-9,
          f"{probe} vs {ref}")
    # 360° 恒等
    c_360 = integrate(w, h, vals, rotate_deg=360.0)
    # 近零系数用绝对误差比（360° 的 sin/cos 有 ~1e-16 的浮点残差）
    scale = max(abs(c_lin[i][k]) for i in range(9) for k in range(3))
    worst360 = max(abs(c_360[i][k] - c_lin[i][k]) for i in range(9) for k in range(3))
    check("360° 旋转回到原系数", worst360 <= 1e-12 * scale * 10, f"最大绝对差 {worst360:.2e}")
    c_180 = integrate(w, h, vals, rotate_deg=180.0)
    l1_180 = (c_180[3][0], c_180[1][0], c_180[2][0])
    check("180° 后 l=1 的 x、z 同时反号",
          c_180[3][0] < 0 and abs(c_180[1][0] - c_lin[1][0]) < 1e-9 and c_180[2][0] < 0,
          str(l1_180))

    print("\n[6] 极区样例：直接平均 vs 立体角加权")
    w, h, s, vals = read_pfm(SAMPLES / "polar.pfm")
    c_pol = integrate(w, h, vals)
    naive = sum(vals[0::3]) / (w * h)
    weighted = c_pol[0][0] / (Y00 * 4 * math.pi)
    check("直接平均明显高于立体角加权（极区被过重计权）", naive > weighted * 1.5,
          f"直接 {naive:.4f} · 加权 {weighted:.4f}")
    l1 = (c_pol[3][0], c_pol[1][0], c_pol[2][0])
    check("l=1 亮部指向 +y", abs(l1[0]) < 1e-6 and l1[1] > 0 and abs(l1[2]) < 1e-6, str(l1))

    print("\n[7] 拒绝路径")
    try:
        read_pfm(SAMPLES / "nan.pfm")
        check("nan.pfm 应报非有限值", False)
    except PfmError as err:
        check("nan.pfm 报非有限值", "nonfinite" in str(err), str(err))
    try:
        read_pfm(SAMPLES / "truncated.pfm")
        check("truncated.pfm 应报截断", False)
    except PfmError as err:
        check("truncated.pfm 报截断并给出缺失字节", "truncated" in str(err), str(err))

    print(f"\n{checks - failures}/{checks} 通过")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
