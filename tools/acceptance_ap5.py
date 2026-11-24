#!/usr/bin/env python3
"""
acceptance_ap5.py — 针对验收难点 5：
三次极端权重曲线（x=[0,100,0,0], w=[1,100,1,1e6]），两端重合、中点贴近，
但 u=1/50 附近有 >1 的窄峰。读取导出 SVG 的 data-u0/data-u1 与端点字符串，
用独立 Fraction Cox 求值，检查 u=1/50 与密集分数样点的参数线性插值误差 <=0.25。
"""
import re
import sys
import math
from fractions import Fraction as Fr
from pathlib import Path
import xml.etree.ElementTree as ET

SVG = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rks-check/ap5-spike.svg")
LIMIT = Fr("0.25")

# 独立参考曲线（与导出 JSON 同源数据；这里直接按验收描述构造精确 Fraction）
p = 3
U = [Fr(0)] * 4 + [Fr(1)] * 4
W = [Fr(1), Fr(100), Fr(1), Fr(1_000_000)]
X = [Fr(0), Fr(100 * 100), Fr(0), Fr(0)]  # 齐次 X=x*w
Y = [Fr(0), Fr(0), Fr(0), Fr(0)]


def basis(i, q, u, memo, side="right"):
    k = (i, q)
    if k in memo:
        return memo[k]
    if q == 0:
        if side == "left":
            v = Fr(1) if U[i] < u <= U[i + 1] else Fr(0)
        else:
            v = Fr(1) if U[i] <= u < U[i + 1] else Fr(0)
    else:
        v = Fr(0)
        d1 = U[i + q] - U[i]
        if d1:
            a = (u - U[i]) / d1
            if a:
                v += a * basis(i, q - 1, u, memo, side)
        d2 = U[i + q + 1] - U[i + 1]
        if d2:
            b = (U[i + q + 1] - u) / d2
            if b:
                v += b * basis(i + 1, q - 1, u, memo, side)
    memo[k] = v
    return v


def ref_x(u):
    side = "left" if u == U[-1] else "right"
    memo = {}
    Xh = Wh = Fr(0)
    for i in range(4):
        b = basis(i, p, u, memo, side)
        Xh += b * X[i]
        Wh += b * W[i]
    return Xh / Wh


# 解析 SVG 段
root = ET.fromstring(SVG.read_text())
segs = []
for el in root.iter():
    if el.get("data-u0") is None:
        continue
    pts = [Fr(v) for v in re.findall(r"[-+]?\d+\.?\d*", el.get("points"))]
    u0, u1 = Fr(el.get("data-u0")), Fr(el.get("data-u1"))
    segs.append((u0, u1, pts[0], pts[2]))  # y 全 0，只看 x


def seg_x_at(s, u):
    u0, u1, x0, x1 = s
    t = (u - u0) / (u1 - u0)
    return x0 + t * (x1 - x0), t


def find_seg(u):
    for s in segs:
        if s[0] <= u <= s[1]:
            return s
    return None


fails = 0
# 1) 点名 u=1/50
u = Fr(1, 50)
s = find_seg(u)
assert s is not None, "u=1/50 不属于任何导出段"
sx, t = seg_x_at(s, u)
rx = ref_x(u)
err = abs(float(sx - rx))
print(f"u=1/50 ref={float(rx):.6f} seg={float(sx):.6f} err={err:.6f} segment=[{float(s[0]):.8f},{float(s[1]):.8f}]")
if not (abs(sx - rx) <= LIMIT):
    fails += 1
    print("  ✗ u=1/50 超差")
if float(rx) <= 1:
    print("  ! 参考 x(0.02) 未超过 1，与验收描述不符（仍继续）")

# 2) 密集分数样点（2001 点，Fraction 精确参考 + 精确端点）
worst = Fr(0)
worst_u = None
for k in range(2001):
    u = Fr(k, 2000)
    s = find_seg(u)
    if s is None:
        continue
    sx, _ = seg_x_at(s, u)
    rx = ref_x(u)
    e = abs(sx - rx)
    if e > worst:
        worst, worst_u = e, u
print(f"密集 2001 分数样点最大精确误差={float(worst):.6f} at u={worst_u} (上限 0.25), 段数={len(segs)}")
if worst > LIMIT:
    fails += 1

# 3) 专门在窄峰区域 [0, 1/20] 用更密的分数分母扫描
worst2 = Fr(0)
for k in range(0, 5001):
    u = Fr(k, 100000)  # 步长 1e-5
    s = find_seg(u)
    if s is None:
        continue
    sx, _ = seg_x_at(s, u)
    e = abs(sx - ref_x(u))
    worst2 = max(worst2, e)
print(f"窄峰区 5001 点最大误差={float(worst2):.6f}")
if worst2 > LIMIT:
    fails += 1

print("AP5", "PASS" if fails == 0 else "FAIL")
sys.exit(1 if fails else 0)
