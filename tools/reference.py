#!/usr/bin/env python3
"""deep-interval-compositor 的 Python 参考实现（仅标准库，Float64 全精度）。

与 web/engine.js 独立编写、互不对抄，用于交叉核对：
  python3 -I tools/reference.py render   <scene.json> [-o out.json]
  python3 -I tools/reference.py inspect  <scene.json> <x> <y>
  python3 -I tools/reference.py validate <scene.json>

物理约定（视线沿 +z 由近及远）：
  事件同深度次序：体积结束 → holdout → 按 id 排列的表面 → 体积开始。
  积分段内活跃体积集合恒定：
      sigma = Σ sigma_i
      C     = Σ sigma_i·rgb_i / sigma
      T_out = T_in · exp(-sigma·dt)
      吸收份额（体积）= T_in·(1-exp(-sigma·dt))
      吸收份额（表面）= T_in·a
  holdout 把透射率置 0，自身不进 A/RGB。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from typing import Any


class ValidationError(Exception):
    def __init__(self, message: str, path: str | None = None):
        super().__init__(f"{message}（位置：{path}）" if path else message)
        self.path = path


# 层类型
V_VOLUME = "volume"
V_SURFACE = "surface"
V_HOLDOUT = "holdout"

# 事件次序码（数值即同深度先后）
E_END = 0
E_HOLDOUT = 1
E_SURFACE = 2
E_START = 3


@dataclass
class Layer:
    kind: str
    ident: int
    z0: float          # surface/holdout 的深度也放这里
    z1: float | None
    sigma: float       # surface 时存 a
    rgb: tuple[float, float, float] | None


@dataclass
class Pixel:
    x: int
    y: int
    layers: list[Layer] = field(default_factory=list)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_nonneg(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0


def validate_and_load(doc: Any) -> tuple[int, int, list[Pixel]]:
    if not isinstance(doc, dict):
        raise ValidationError("根节点必须是 JSON 对象", "$")
    if not _is_int(doc.get("width")) or doc["width"] <= 0:
        raise ValidationError("width 必须是正整数", "$.width")
    if not _is_int(doc.get("height")) or doc["height"] <= 0:
        raise ValidationError("height 必须是正整数", "$.height")
    w, h = doc["width"], doc["height"]
    if not isinstance(doc.get("pixels"), list):
        raise ValidationError("pixels 必须是数组", "$.pixels")

    pixels: list[Pixel] = []
    seen_pixels: set[int] = set()
    for pi, rec in enumerate(doc["pixels"]):
        pp = f"$.pixels[{pi}]"
        if not isinstance(rec, dict):
            raise ValidationError("像素记录必须是对象", pp)
        if not _is_int(rec.get("x")) or not (0 <= rec["x"] < w):
            raise ValidationError(f"x 必须是 [0, {w - 1}] 内的整数", f"{pp}.x")
        if not _is_int(rec.get("y")) or not (0 <= rec["y"] < h):
            raise ValidationError(f"y 必须是 [0, {h - 1}] 内的整数", f"{pp}.y")
        pidx = rec["y"] * w + rec["x"]
        if pidx in seen_pixels:
            raise ValidationError(
                f"像素坐标重复：({rec['x']},{rec['y']}) 出现了多次", pp)
        seen_pixels.add(pidx)
        if not isinstance(rec.get("layers"), list):
            raise ValidationError("layers 必须是数组", f"{pp}.layers")

        px = Pixel(rec["x"], rec["y"])
        seen: set[int] = set()
        for li, L in enumerate(rec["layers"]):
            lp = f"{pp}.layers[{li}]"
            if not isinstance(L, dict):
                raise ValidationError("层记录必须是对象", lp)
            if not _is_int(L.get("id")) or L["id"] < 0:
                raise ValidationError("id 必须是非负整数", f"{lp}.id")
            if L["id"] in seen:
                raise ValidationError(f"像素内 id 重复：{L['id']}", f"{lp}.id")
            seen.add(L["id"])
            typ = L.get("type")

            if typ == V_VOLUME:
                if not _is_int(L.get("z0")) or not _is_int(L.get("z1")):
                    raise ValidationError("volume 的 z0、z1 必须是整数", lp)
                if not L["z0"] < L["z1"]:
                    raise ValidationError("volume 要求 z0 < z1", lp)
                if not _is_nonneg(L.get("sigma")):
                    raise ValidationError("sigma 必须是有限非负数", f"{lp}.sigma")
                rgb = _check_rgb(L, lp)
                px.layers.append(Layer(V_VOLUME, L["id"], float(L["z0"]),
                                       float(L["z1"]), float(L["sigma"]), rgb))
            elif typ == V_SURFACE:
                if not _is_int(L.get("z")):
                    raise ValidationError("surface 的 z 必须是整数", f"{lp}.z")
                a = L.get("a")
                if not (isinstance(a, (int, float)) and not isinstance(a, bool)
                        and math.isfinite(a) and 0 <= a <= 1):
                    raise ValidationError("a 必须是 0 到 1 之间的有限数", f"{lp}.a")
                rgb = _check_rgb(L, lp)
                px.layers.append(Layer(V_SURFACE, L["id"], float(L["z"]),
                                       None, float(a), rgb))
            elif typ == V_HOLDOUT:
                if not _is_int(L.get("z")):
                    raise ValidationError("holdout 的 z 必须是整数", f"{lp}.z")
                px.layers.append(Layer(V_HOLDOUT, L["id"], float(L["z"]),
                                       None, 0.0, None))
            else:
                raise ValidationError(f"未知层类型：{typ!r}", f"{lp}.type")
        pixels.append(px)
    return w, h, pixels


def _check_rgb(L: dict, lp: str) -> tuple[float, float, float]:
    rgb = L.get("rgb")
    if not isinstance(rgb, list) or len(rgb) != 3:
        raise ValidationError("rgb 必须是长度 3 的数组", f"{lp}.rgb")
    for c, v in enumerate(rgb):
        if not _is_nonneg(v):
            raise ValidationError("rgb 分量必须是有限非负数", f"{lp}.rgb[{c}]")
    return float(rgb[0]), float(rgb[1]), float(rgb[2])


def _events(pixel: Pixel) -> list[tuple[float, int, int, Layer]]:
    """生成 (z, 次序码, id, layer) 事件列表。"""
    ev: list[tuple[float, int, int, Layer]] = []
    for L in pixel.layers:
        if L.kind == V_VOLUME:
            ev.append((L.z0, E_START, L.ident, L))
            ev.append((L.z1, E_END, L.ident, L))
        elif L.kind == V_SURFACE:
            ev.append((L.z0, E_SURFACE, L.ident, L))
        else:
            ev.append((L.z0, E_HOLDOUT, L.ident, L))
    ev.sort(key=lambda e: (e[0], e[1], e[2]))
    return ev


def composite_pixel(pixel: Pixel) -> dict[str, float]:
    """返回 r,g,b,A,T（线性预乘颜色 + 可见吸收份额之和 + 残余透射率）。"""
    T = 1.0
    r = g = b = A = 0.0
    active: list[Layer] = []
    prev_z: float | None = None

    def integrate(z0: float, z1: float) -> None:
        nonlocal T, r, g, b, A
        dt = z1 - z0
        if dt <= 0 or not active or T == 0.0:
            return
        sigma = sum(L.sigma for L in active)
        if sigma <= 0.0:
            return
        sr = sum(L.sigma * L.rgb[0] for L in active)
        sg = sum(L.sigma * L.rgb[1] for L in active)
        sb = sum(L.sigma * L.rgb[2] for L in active)
        trans = math.exp(-sigma * dt)
        absorb = T * (1.0 - trans)
        r += absorb * (sr / sigma)
        g += absorb * (sg / sigma)
        b += absorb * (sb / sigma)
        A += absorb
        T *= trans

    for z, code, _ident, L in _events(pixel):
        if prev_z is not None and z > prev_z:
            integrate(prev_z, z)
        if code == E_END:
            active = [x for x in active if x is not L]
        elif code == E_SURFACE:
            if T > 0.0:
                share = T * L.sigma          # L.sigma 槽位存的是 a
                r += share * L.rgb[0]
                g += share * L.rgb[1]
                b += share * L.rgb[2]
                A += share
                T *= 1.0 - L.sigma
        elif code == E_HOLDOUT:
            T = 0.0
        else:  # E_START
            active.append(L)
        prev_z = z

    return {"r": r, "g": g, "b": b, "A": A, "T": T}


def render(w: int, h: int, pixels: list[Pixel]) -> dict[str, Any]:
    grid: list[list[dict[str, float] | None]] = [[None] * w for _ in range(h)]
    for px in pixels:
        grid[px.y][px.x] = composite_pixel(px)
    out_pixels = []
    flat = []
    for y in range(h):
        for x in range(w):
            cell = grid[y][x]
            if cell is None:
                flat.extend([0.0, 0.0, 0.0, 0.0])
                continue
            flat.extend([cell["r"], cell["g"], cell["b"], cell["A"]])
            out_pixels.append({"x": x, "y": y, **cell})
    return {"width": w, "height": h, "pixels": out_pixels, "rgba64": flat}


def inspect(w: int, h: int, pixels: list[Pixel], x: int, y: int) -> dict[str, Any]:
    target = next((p for p in pixels if p.x == x and p.y == y), None)
    if target is None:
        target = Pixel(x, y)
    T = 1.0
    r = g = b = A = 0.0
    active: list[Layer] = []
    prev_z: float | None = None
    segments: list[dict[str, Any]] = []
    events_out: list[dict[str, Any]] = []

    def integrate(z0: float, z1: float) -> None:
        nonlocal T, r, g, b, A
        if not active:
            return
        dt = z1 - z0
        sigma = sum(L.sigma for L in active)
        sr = sum(L.sigma * L.rgb[0] for L in active)
        sg = sum(L.sigma * L.rgb[1] for L in active)
        sb = sum(L.sigma * L.rgb[2] for L in active)
        ids = sorted(L.ident for L in active)
        t_in = T
        if T == 0.0:
            # 透射已被 holdout 切断：后方一切不可见，不产生可检查段
            return
        if dt <= 0 or sigma <= 0.0:
            segments.append({
                "type": "volume-segment", "z0": int(z0), "z1": int(z1),
                "activeIds": ids, "sigma": sigma,
                "tIn": t_in, "tOut": t_in, "absorbShare": 0.0,
                "contribution": [0.0, 0.0, 0.0],
            })
            return
        trans = math.exp(-sigma * dt)
        absorb = T * (1.0 - trans)
        cr, cg, cb = absorb * (sr / sigma), absorb * (sg / sigma), absorb * (sb / sigma)
        r += cr; g += cg; b += cb; A += absorb; T *= trans
        segments.append({
            "type": "volume-segment", "z0": int(z0), "z1": int(z1),
            "activeIds": ids, "sigma": sigma,
            "tIn": t_in, "tOut": T, "absorbShare": absorb,
            "contribution": [cr, cg, cb],
        })

    for z, code, ident, L in _events(target):
        if prev_z is not None and z > prev_z:
            integrate(prev_z, z)
        t_before = T
        if code == E_END:
            active = [x for x in active if x is not L]
            events_out.append({"type": "volume-end", "id": ident, "z": int(z),
                               "tIn": t_before, "tOut": T})
        elif code == E_SURFACE:
            share = T * L.sigma
            cr = share * L.rgb[0]; cg = share * L.rgb[1]; cb = share * L.rgb[2]
            r += cr; g += cg; b += cb; A += share; T *= 1.0 - L.sigma
            events_out.append({
                "type": "surface", "id": ident, "z": int(z), "a": L.sigma,
                "rgb": list(L.rgb), "tIn": t_before, "tOut": T,
                "absorbShare": share, "contribution": [cr, cg, cb],
            })
        elif code == E_HOLDOUT:
            T = 0.0
            events_out.append({"type": "holdout", "id": ident, "z": int(z),
                               "tIn": t_before, "tOut": 0.0})
        else:
            active.append(L)
            events_out.append({"type": "volume-start", "id": ident, "z": int(z),
                               "tIn": t_before, "tOut": T})
        prev_z = z

    return {
        "x": x, "y": y, "layerCount": len(target.layers),
        "segments": segments, "events": events_out,
        "result": {"r": r, "g": g, "b": b, "A": A, "T": T},
    }


def load(path: str) -> tuple[int, int, list[Pixel]]:
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    return validate_and_load(doc)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="深度区间合成 Python 参考实现")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("render", "validate", "inspect"):
        p = sub.add_parser(name)
        p.add_argument("scene")
        if name == "inspect":
            p.add_argument("x", type=int)
            p.add_argument("y", type=int)
        if name == "render":
            p.add_argument("-o", "--out")
    args = ap.parse_args(argv)

    try:
        w, h, pixels = load(args.scene)
    except ValidationError as e:
        print(f"校验失败：{e}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as e:
        print(f"JSON 解析失败：{e.msg}（位置：第 {e.lineno} 行第 {e.colno} 列，"
              f"字符偏移 {e.pos}）", file=sys.stderr)
        return 2

    if args.cmd == "validate":
        print(f"校验通过：{w}x{h}，{len(pixels)} 个非空像素，"
              f"{sum(len(p.layers) for p in pixels)} 条层记录。")
    elif args.cmd == "render":
        result = render(w, h, pixels)
        text = json.dumps(result, ensure_ascii=False)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text)
        else:
            print(text)
    else:
        print(json.dumps(inspect(w, h, pixels, args.x, args.y),
                         ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
