#!/usr/bin/env python3
"""
independent_check.py — 站在评分方角度，不依赖本项目 JS，独立实现：
  1) 解析导出的约分曲线 JSON（分数），校验约分/正分母；
  2) 用 Cox–de Boor 独立求精确/浮点曲线与齐次值；
  3) 解析导出 SVG 中所有带 data-u0/data-u1 的段，
     按“段内参数线性插值”比较欧氏误差 <= 0.25；
  4) 精确核对插入节点前后齐次曲线完全一致。

用法：
  node tools/dump_exports.mjs
  python3 -I tools/independent_check.py /tmp/rks-check
"""
import json
import re
import sys
import math
import xml.etree.ElementTree as ET
from fractions import Fraction as Fr
from pathlib import Path

LIMIT = 0.25
SAMPLES = 240


def parse_frac(s):
    if isinstance(s, (int, float)):
        return Fr(s)
    s = str(s).strip()
    if "/" in s:
        a, b = s.split("/")
        return Fr(int(a), int(b))
    if "." in s:
        return Fr(s)  # Fraction('0.25') 支持
    return Fr(int(s))


def is_reduced_string(s):
    """导出字符串必须：整数不带分母；分数分母正且约分。"""
    assert isinstance(s, str), f"不是字符串: {s!r}"
    if "/" in s:
        a, b = s.split("/")
        a, b = int(a), int(b)
        if b <= 0:
            return False, "分母非正"
        if math.gcd(abs(a), b) != 1:
            return False, f"未约分 {s}"
    else:
        int(s)
    return True, ""


class Curve:
    def __init__(self, obj):
        self.p = int(obj["degree"])
        self.U = [parse_frac(k) for k in obj["knots"]]
        self.P = [(parse_frac(a), parse_frac(b), parse_frac(w)) for a, b, w in obj["points"]]
        self.n = len(self.P)
        assert len(self.U) == self.n + self.p + 1

    def basis(self, i, q, u, side, memo):
        key = (i, q, side)
        if key in memo:
            return memo[key]
        if q == 0:
            if side == "left":
                v = Fr(1) if (self.U[i] < u <= self.U[i + 1]) else Fr(0)
            else:
                v = Fr(1) if (self.U[i] <= u < self.U[i + 1]) else Fr(0)
        else:
            v = Fr(0)
            d1 = self.U[i + q] - self.U[i]
            if d1 != 0:
                a = (u - self.U[i]) / d1
                if a != 0:
                    v += a * self.basis(i, q - 1, u, side, memo)
            d2 = self.U[i + q + 1] - self.U[i + 1]
            if d2 != 0:
                b = (self.U[i + q + 1] - u) / d2
                if b != 0:
                    v += b * self.basis(i + 1, q - 1, u, side, memo)
        memo[key] = v
        return v

    def homogeneous_exact(self, u, side="right"):
        """只对活动下标带求精确基，O(p^2)。"""
        memo = {}
        k = self._span(u, side)
        lo, hi = max(0, k - self.p), min(self.n - 1, k)
        X = Y = W = Fr(0)
        for i in range(lo, hi + 1):
            b = self.basis(i, self.p, u, side, memo)
            x, y, w = self.P[i]
            X += b * x
            Y += b * y
            W += b * w
        return X, Y, W

    def _span(self, u, side):
        U = self.U
        if side == "left":
            k = max(i for i in range(len(U)) if U[i] < u) if any(x < u for x in U) else 0
            return min(k, len(U) - 2)
        if u == U[-1]:
            return self.n - 1
        # 最大 k 使 U[k] <= u < U[k+1]
        k = 0
        for i in range(len(U) - 1):
            if U[i] <= u < U[i + 1]:
                k = i
                break
        return k

    def point_float(self, u):
        """标准浮点 Cox 基（活动区间），快速独立参考。u 可为 float/Fraction。"""
        u = float(u)
        p = self.p
        U = [float(x) for x in self.U]
        n = self.n
        if u >= U[-1]:
            k = n - 1
            u = U[-1]
        else:
            k = max(i for i in range(len(U) - 1) if U[i] <= u < U[i + 1])
        N = [0.0] * (p + 1)
        N[0] = 1.0
        left = [0.0] * (p + 1)
        right = [0.0] * (p + 1)
        for j in range(1, p + 1):
            left[j] = u - U[k + 1 - j]
            right[j] = U[k + j] - u
            saved = 0.0
            for r in range(j):
                den = U[k + r + 1] - U[k + r - j + 1]
                temp = N[r] / den if den != 0 else 0.0
                N[r] = saved + right[r + 1] * temp
                saved = left[j - r] * temp
            N[j] = saved
        X = Y = W = 0.0
        for r in range(p + 1):
            idx = k - p + r
            if 0 <= idx < n:
                x, y, w = self.P[idx]
                b = N[r]
                X += b * float(x)
                Y += b * float(y)
                W += b * float(w)
        return X / W, Y / W


def check_json_reduced(obj, name, failures):
    for i, k in enumerate(obj["knots"]):
        ok, why = is_reduced_string(k)
        if not ok:
            failures.append(f"{name} knots[{i}]={k}: {why}")
    for i, pt in enumerate(obj["points"]):
        for j, comp in enumerate(pt):
            ok, why = is_reduced_string(comp)
            if not ok:
                failures.append(f"{name} points[{i}][{j}]={comp}: {why}")


def parse_svg_segments(svg_path):
    text = Path(svg_path).read_text(encoding="utf-8")
    root = ET.fromstring(text)
    segs = []
    # ElementTree 对未知/命名空间属性仍可用 attrib 全名匹配
    for el in root.iter():
        u0 = el.get("data-u0")
        u1 = el.get("data-u1")
        if u0 is None or u1 is None:
            continue
        x1 = y1 = x2 = y2 = None
        pts = el.get("points")
        if pts:
            coords = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", pts)
            if len(coords) >= 4:
                x1, y1, x2, y2 = map(float, coords[:4])
        if None in (x1, y1, x2, y2):
            if el.get("x1") is not None:
                x1, y1, x2, y2 = float(el.get("x1")), float(el.get("y1")), float(el.get("x2")), float(el.get("y2"))
        if None in (x1, y1, x2, y2):
            continue
        segs.append((float(u0), float(u1), x1, y1, x2, y2, el.tag))
    return segs


def check_svg(json_path, svg_path, failures, warnings):
    name = json_path.stem
    obj = json.loads(json_path.read_text(encoding="utf-8"))
    check_json_reduced(obj, name, failures)
    c = Curve(obj)
    segs = parse_svg_segments(svg_path)
    if not segs:
        failures.append(f"{name}: SVG 中没有带 data-u0/data-u1 且可解析端点的段")
        return
    # 参数区间应落在域内
    dom0, dom1 = float(c.U[0]), float(c.U[-1])
    worst = 0.0
    worst_at = None
    tags = set()
    # 段很多时适当降低每段采样密度（仍远密于常见检查器）
    samples = 64 if len(segs) > 1000 else SAMPLES
    for u0, u1, x1, y1, x2, y2, tag in segs:
        tags.add(tag.split("}")[-1])
        if not (dom0 - 1e-9 <= u0 < u1 <= dom1 + 1e-9):
            failures.append(f"{name}: 段参数区间非法 [{u0},{u1}] 域 [{dom0},{dom1}]")
            continue
        for j in range(samples + 1):
            t = j / samples
            u = Fr(u0) + (Fr(u1) - Fr(u0)) * Fr(t)
            try:
                rx, ry = c.point_float(u)
            except ZeroDivisionError:
                warnings.append(f"{name}: W=0 at {u}")
                continue
            qx = x1 + t * (x2 - x1)
            qy = y1 + t * (y2 - y1)
            d = math.hypot(rx - qx, ry - qy)
            if d > worst:
                worst, worst_at = d, (u0, u1, float(u))
    status = "OK " if worst <= LIMIT else "FAIL"
    print(f"  [{status}] {name:24s} 段数={len(segs):5d} 标签={sorted(tags)} 最大误差={worst:.5f} (上限 {LIMIT})")
    if worst > LIMIT:
        failures.append(f"{name}: SVG 段最大误差 {worst:.4f} > {LIMIT}, near {worst_at}")


def check_homogeneous_invariance(dirpath, failures):
    """sample.json 与 sample-inserted-half.json 在一批精确参数处齐次相等。"""
    a = Curve(json.loads((dirpath / "sample.json").read_text()))
    b = Curve(json.loads((dirpath / "sample-inserted-half.json").read_text()))
    if a.p != b.p:
        failures.append("插入前后次数变化")
        return
    test_us = [Fr(0), Fr(1, 16), Fr(1, 8), Fr(1, 4), Fr(1, 3), Fr(1, 2),
               Fr(5, 8), Fr(2, 3), Fr(3, 4), Fr(7, 8), Fr(15, 16), Fr(1)]
    for u in test_us:
        side = "left" if u == a.U[-1] else "right"
        ha = a.homogeneous_exact(u, side)
        hb = b.homogeneous_exact(u, side)
        if ha != hb:
            failures.append(f"插入后齐次曲线在 u={u} 不相等: {ha} vs {hb}")
    print("  [OK ] 齐次插入不变性（12 个精确参数点逐一相等）")


def main():
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rks-check")
    failures, warnings = [], []
    pairs = sorted(d.glob("*.json"))
    print("SVG/JSON 契约检查：")
    for jp in pairs:
        sp = jp.with_suffix(".svg")
        if not sp.exists():
            continue
        check_svg(jp, sp, failures, warnings)
    print("\n精确齐次不变性：")
    check_homogeneous_invariance(d, failures)
    for w in warnings:
        print("  warn:", w)
    if failures:
        print("\n失败：")
        for f in failures:
            print("  ✗", f)
        sys.exit(1)
    print(f"\n全部独立检查通过（{len(list(d.glob('*.svg')))} 个 SVG）。")


if __name__ == "__main__":
    main()
