"""散射核加载与校验。

约定（见样本包 约定.txt）：
- 核 K 对 I 的结果为 Σ K[u,v]×I[x+u−ox, y+v−oy]，域外为零；
- 每核宽高 1..9，系数非负、总和至多 0.75，原点在核内；
- kernels.json 的 origin 为 [ox, oy]（x 原点, y 原点）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np


class KernelError(ValueError):
    pass


@dataclass(frozen=True)
class Kernel:
    name: str
    coeffs: np.ndarray          # shape (kh, kw)
    ox: int
    oy: int

    @property
    def shape(self):
        return self.coeffs.shape


def _parse_one(name: str, raw: dict) -> Kernel:
    if not isinstance(raw, dict) or "rows" not in raw or "origin" not in raw:
        raise KernelError(f"核 {name} 需要 rows 与 origin 字段")
    rows = raw["rows"]
    origin = raw["origin"]
    if not isinstance(rows, list) or not rows or not all(isinstance(r, list) and r for r in rows):
        raise KernelError(f"核 {name} 的 rows 必须是非空二维数组")
    kw = len(rows[0])
    if any(len(r) != kw for r in rows):
        raise KernelError(f"核 {name} 的 rows 各行长度不一致")
    kh = len(rows)
    if not (1 <= kh <= 9 and 1 <= kw <= 9):
        raise KernelError(f"核 {name} 宽高需在 1..9，收到 {kh}x{kw}")
    try:
        coeffs = np.array([[float(v) for v in r] for r in rows], dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise KernelError(f"核 {name} 含非数值系数") from exc
    if np.any(~np.isfinite(coeffs)) or np.any(coeffs < 0):
        raise KernelError(f"核 {name} 系数必须有限且非负")
    total = float(coeffs.sum())
    if total > 0.75 + 1e-12:
        raise KernelError(f"核 {name} 系数和 {total} 超过上限 0.75")
    if not isinstance(origin, list) or len(origin) != 2:
        raise KernelError(f"核 {name} origin 必须是 [ox, oy]")
    try:
        ox, oy = int(origin[0]), int(origin[1])
    except (TypeError, ValueError) as exc:
        raise KernelError(f"核 {name} origin 必须是整数") from exc
    if not (0 <= ox < kw and 0 <= oy < kh):
        raise KernelError(f"核 {name} 原点 ({ox},{oy}) 不在核内 (核 {kw}x{kh})")
    return Kernel(name=name, coeffs=coeffs, ox=ox, oy=oy)


def load_kernels(data: bytes) -> tuple[Kernel, Kernel]:
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise KernelError(f"kernels.json 解析失败：{exc}") from exc
    if not isinstance(raw, dict) or "front" not in raw or "back" not in raw:
        raise KernelError("kernels.json 必须包含 front 与 back 两个核")
    return _parse_one("front", raw["front"]), _parse_one("back", raw["back"])
