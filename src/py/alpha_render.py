#!/usr/bin/env python3
"""CPU 软件光栅化参考实现（纯标准库）。

规范来源：samples/extracted/说明.txt
- 右手世界坐标，透视相机由 position/target/up/fov_y/near/far 定义
- 相机空间视锥六平面 Sutherland-Hodgman 裁剪（正确处理相机后方顶点）
- 屏幕空间有向边函数 + 左上规则（共享边只归属一次）
- 透视正确的逐顶点 RGBA 插值（非预乘线性颜色）
- 每像素保留全部 alpha>0 片元（含不透明面之后），按 (深度, id) 排序
- 线性空间前向后 premultiplied over 合成，sRGB 传递函数编码 8-bit PNG

本模块同时被 CLI（render/check）与 HTTP 服务以 `python3 -I` 方式调用，
仅依赖标准库。
"""

from __future__ import annotations

import bisect
import json
import math
import struct
import zlib
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# 常量与误差边界
# ---------------------------------------------------------------------------

DEPTH_EPS = 1e-9          # 同深度判定（相对），最小真实深度间隔约 0.009，远大于此
EDGE_EPS = 1e-12          # 边函数贴边判定（相对面积），用于吸收浮点零残差
SRGB_ALPHA = 0.055
SRGB_PHI = 12.92


class ValidationError(ValueError):
    """场景输入不合法；调用方应保留上一帧。"""


# ---------------------------------------------------------------------------
# 小型向量工具（全部基于 tuple，避免额外依赖）
# ---------------------------------------------------------------------------

def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def vadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def vscale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def vnorm(a):
    n = math.sqrt(vdot(a, a))
    if n == 0.0:
        raise ValidationError("零长度向量无法构成相机基向量")
    return (a[0] / n, a[1] / n, a[2] / n)


def vlerp(a, b, t):
    return (
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    )


# ---------------------------------------------------------------------------
# 场景校验
# ---------------------------------------------------------------------------

def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _is_seq3(obj):
    return isinstance(obj, (list, tuple)) and len(obj) == 3


def _as_vec3(obj, name):
    if not _is_seq3(obj) or not all(_is_num(v) for v in obj):
        raise ValidationError(f"{name} 必须是 3 个有限数字")
    return (float(obj[0]), float(obj[1]), float(obj[2]))


def _as_rgba(obj, name):
    if not (isinstance(obj, (list, tuple)) and len(obj) == 4) or not all(_is_num(v) for v in obj):
        raise ValidationError(f"{name} 必须是 4 个有限数字")
    vals = [float(v) for v in obj]
    for i, v in enumerate(vals):
        if v < 0.0 or v > 1.0:
            raise ValidationError(f"{name} 分量超出 [0,1]")
    return vals


def validate_scene(obj: Any) -> dict:
    """完整校验场景 JSON；失败抛 ValidationError，成功返回规范化 dict。"""
    if not isinstance(obj, dict):
        raise ValidationError("场景根必须是对象")
    if obj.get("version") != 1:
        raise ValidationError("version 必须为 1")

    width = obj.get("width")
    height = obj.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise ValidationError("width/height 必须为正整数")

    cam_raw = obj.get("camera")
    if not isinstance(cam_raw, dict):
        raise ValidationError("缺少 camera")
    position = _as_vec3(cam_raw.get("position"), "camera.position")
    target = _as_vec3(cam_raw.get("target"), "camera.target")
    up = _as_vec3(cam_raw.get("up"), "camera.up")
    fov = cam_raw.get("fov_y_degrees")
    near = cam_raw.get("near")
    far = cam_raw.get("far")
    if not _is_num(fov) or not (0.0 < float(fov) < 180.0):
        raise ValidationError("fov_y_degrees 必须在 (0,180) 内")
    if not _is_num(near) or not _is_num(far):
        raise ValidationError("near/far 必须为数字")
    near, far = float(near), float(far)
    if not (0.0 < near < far):
        raise ValidationError("必须满足 0 < near < far")
    if vdot(vsub(target, position), vsub(target, position)) == 0.0:
        raise ValidationError("position 与 target 重合")

    bg = _as_rgb01(obj.get("background_linear_rgb"), "background_linear_rgb")

    tris_raw = obj.get("triangles")
    if not isinstance(tris_raw, list) or len(tris_raw) == 0:
        raise ValidationError("triangles 必须是非空数组")

    seen_ids = set()
    tris = []
    for ti, tri in enumerate(tris_raw):
        if not isinstance(tri, dict):
            raise ValidationError(f"triangles[{ti}] 必须是对象")
        tid = tri.get("id")
        if not isinstance(tid, int) or isinstance(tid, bool) or tid < 0:
            raise ValidationError(f"triangles[{ti}].id 必须是非负整数")
        if tid in seen_ids:
            raise ValidationError(f"三角形 id {tid} 重复，拒绝整个场景")
        seen_ids.add(tid)
        verts_raw = tri.get("vertices")
        if not isinstance(verts_raw, list) or len(verts_raw) != 3:
            raise ValidationError(f"三角形 {tid} 必须恰有 3 个顶点")
        verts = []
        for vi, v in enumerate(verts_raw):
            if not isinstance(v, dict):
                raise ValidationError(f"三角形 {tid} 顶点 {vi} 必须是对象")
            pos = _as_vec3(v.get("position"), f"三角形 {tid} 顶点 {vi}.position")
            rgba = _as_rgba(v.get("rgba"), f"三角形 {tid} 顶点 {vi}.rgba")
            verts.append({"position": pos, "rgba": rgba})
        tris.append({"id": tid, "vertices": verts})

    return {
        "version": 1,
        "width": width,
        "height": height,
        "camera": {
            "position": position,
            "target": target,
            "up": up,
            "fov_y_degrees": float(fov),
            "near": near,
            "far": far,
        },
        "background_linear_rgb": bg,
        "triangles": tris,
    }


def _as_rgb01(obj, name):
    if not _is_seq3(obj) or not all(_is_num(v) for v in obj):
        raise ValidationError(f"{name} 必须是 3 个有限数字")
    vals = [float(v) for v in obj]
    for v in vals:
        if v < 0.0 or v > 1.0:
            raise ValidationError(f"{name} 分量超出 [0,1]")
    return vals


def validate_camera_override(cam: dict, base: dict) -> dict:
    """校验相机移动后的参数；结构与场景 camera 相同。"""
    if not isinstance(cam, dict):
        raise ValidationError("camera 必须是对象")
    position = _as_vec3(cam.get("position"), "camera.position")
    target = _as_vec3(cam.get("target"), "camera.target")
    up = _as_vec3(cam.get("up"), "camera.up")
    fov = cam.get("fov_y_degrees")
    near = cam.get("near")
    far = cam.get("far")
    if not _is_num(fov) or not (0.0 < float(fov) < 180.0):
        raise ValidationError("fov_y_degrees 必须在 (0,180) 内")
    near, far = float(near), float(far)
    if not (0.0 < near < far):
        raise ValidationError("必须满足 0 < near < far")
    if vdot(vsub(target, position), vsub(target, position)) == 0.0:
        raise ValidationError("position 与 target 重合")
    return {
        "position": position, "target": target, "up": up,
        "fov_y_degrees": float(fov), "near": near, "far": far,
    }


# ---------------------------------------------------------------------------
# 相机
# ---------------------------------------------------------------------------

@dataclass
class Camera:
    position: tuple
    right: tuple
    up: tuple
    forward: tuple
    tan_half: float
    near: float
    far: float


def build_camera(cam: dict) -> Camera:
    forward = vnorm(vsub(cam["target"], cam["position"]))
    right = vnorm(vcross(forward, vnorm(cam["up"])))
    up = vcross(right, forward)
    return Camera(
        position=cam["position"],
        right=right,
        up=up,
        forward=forward,
        tan_half=math.tan(math.radians(cam["fov_y_degrees"]) * 0.5),
        near=cam["near"],
        far=cam["far"],
    )


def to_camera(camera: Camera, world_pos):
    d = vsub(world_pos, camera.position)
    return (vdot(d, camera.right), vdot(d, camera.up), vdot(d, camera.forward))


# ---------------------------------------------------------------------------
# 视锥裁剪（相机空间，Sutherland-Hodgman，六平面）
# 平面内函数 s(v) >= 0 表示在内侧
# ---------------------------------------------------------------------------

def _frustum_planes(camera: Camera):
    t = camera.tan_half
    return (
        ("near",   lambda v: v[2] - camera.near),
        ("far",    lambda v: camera.far - v[2]),
        ("left",   lambda v: v[0] + v[2] * t),
        ("right",  lambda v: v[2] * t - v[0]),
        ("bottom", lambda v: v[1] + v[2] * t),
        ("top",    lambda v: v[2] * t - v[1]),
    )


def _clip_polygon(poly, plane_fn):
    if not poly:
        return []
    out = []
    s = poly[-1]
    ds = plane_fn(s["cam"])
    for e in poly:
        de = plane_fn(e["cam"])
        s_in, e_in = ds >= 0.0, de >= 0.0
        if e_in:
            if not s_in:
                t = ds / (ds - de)
                out.append({
                    "cam": vlerp(s["cam"], e["cam"], t),
                    "rgba": [s["rgba"][i] + (e["rgba"][i] - s["rgba"][i]) * t for i in range(4)],
                })
            out.append(e)
        elif s_in:
            t = ds / (ds - de)
            out.append({
                "cam": vlerp(s["cam"], e["cam"], t),
                "rgba": [s["rgba"][i] + (e["rgba"][i] - s["rgba"][i]) * t for i in range(4)],
            })
        s, ds = e, de
    return out


def clip_triangle(camera: Camera, tri):
    """返回裁剪后的屏幕三角形列表（扇形三角化），元素为 dict。"""
    poly = []
    for v in tri["vertices"]:
        poly.append({"cam": to_camera(camera, v["position"]), "rgba": list(v["rgba"])})
    for _, plane_fn in _frustum_planes(camera):
        poly = _clip_polygon(poly, plane_fn)
        if not poly:
            return []
    return poly  # 调用方统一投影并扇形三角化


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class Fragment:
    id: int
    depth: float
    rgba: list            # 非预乘线性 RGBA
    comp: list = field(default_factory=list)  # 该层合成后的直线线性 RGB


@dataclass
class Framebuffer:
    width: int
    height: int
    background: list
    linear: list          # 每像素 3 个 float（最终直线线性 RGB）
    rgb8: bytearray       # 每像素 3 字节 sRGB
    fragments: list       # 每像素 list[Fragment]


# ---------------------------------------------------------------------------
# 深度排序：严格同深度按 id（带相对容差吸收 ULP 抖动）
# ---------------------------------------------------------------------------

def _depth_cmp(a: Fragment, b: Fragment):
    scale = max(1.0, abs(a.depth), abs(b.depth))
    if abs(a.depth - b.depth) <= DEPTH_EPS * scale:
        return -1 if a.id < b.id else (1 if a.id > b.id else 0)
    return -1 if a.depth < b.depth else 1


# ---------------------------------------------------------------------------
# 光栅化单个分带
# ---------------------------------------------------------------------------

def render_band(scene: dict, size: int, camera: dict, y0: int, y1: int) -> dict:
    """渲染 [y0, y1) 行分带。返回紧凑 SoA 结构，供主进程合并。

    返回:
      y0,y1,width
      linear: Float32 可用的 list[float]，每像素 3
      rgb8: bytearray，每像素 3
      frag: dict of SoA 数组（pixels 用分带内局部索引）
    """
    from functools import cmp_to_key

    cam = build_camera(camera)
    w = h = size
    band_h = y1 - y0
    n = w * band_h
    background = scene["background_linear_rgb"]
    linear = [0.0] * (n * 3)
    rgb8 = bytearray(n * 3)
    frag_pixel = []     # 分带内像素索引
    frag_id = []
    frag_depth = []
    frag_rgba = []      # 每片元 4 float
    frag_comp = []      # 每片元 3 float（合成后直线 RGB）
    frag_start = [0] * (n + 1)  # 每个像素在数组中的起止（先计数后填充）

    tan_half = cam.tan_half

    # 1) 裁剪 + 投影，生成屏幕三角形（保留原 id）
    screen_tris = []
    for tri in scene["triangles"]:
        poly = clip_triangle(cam, tri)
        if len(poly) < 3:
            continue
        proj = []
        for v in poly:
            cx, cy, cz = v["cam"]
            inv_z = 1.0 / cz
            sx = (cx * inv_z / tan_half + 1.0) * 0.5 * w
            sy = (1.0 - cy * inv_z / tan_half) * 0.5 * h
            proj.append({"sx": sx, "sy": sy, "inv_z": inv_z, "z": cz, "rgba": v["rgba"]})
        for k in range(1, len(proj) - 1):
            screen_tris.append((tri["id"], proj[0], proj[k], proj[k + 1]))

    # 2) 先统计每像素片元数（分配紧凑存储）
    counts = [0] * n

    cover_lists = [None] * n  # 延迟到有覆盖时才建 list

    for tid, a, b, c in screen_tris:
        ax, ay = a["sx"], a["sy"]
        bx, by = b["sx"], b["sy"]
        cx, cy = c["sx"], c["sy"]
        area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if area2 == 0.0:
            continue
        # 统一到有向面积为正（屏幕坐标 +y 向下）
        if area2 < 0.0:
            b, c = c, b
            bx, by = b["sx"], b["sy"]
            cx, cy = c["sx"], c["sy"]
            area2 = -area2

        xmin = max(0, int(math.floor(min(ax, bx, cx))))
        xmax = min(w - 1, int(math.ceil(max(ax, bx, cx))) - 1)
        ymin = max(y0, int(math.floor(min(ay, by, cy))))
        ymax = min(y1 - 1, int(math.ceil(max(ay, by, cy))) - 1)
        if xmin > xmax or ymin > ymax:
            continue

        # 三条边：(a,b),(b,c),(c,a)，边函数 (b-a) x (p-a)
        edges = (
            (ax, ay, bx - ax, by - ay),
            (bx, by, cx - bx, cy - by),
            (cx, cy, ax - cx, ay - cy),
        )
        snap_tol = EDGE_EPS * area2

        for y in range(ymin, ymax + 1):
            py = y + 0.5
            # 行首（x=xmin）三条边的边函数值，之后 x 方向增量步进
            e_row = [
                dx * (py - ey) - dy * ((xmin + 0.5) - ex)
                for (ex, ey, dx, dy) in edges
            ]
            for x in range(xmin, xmax + 1):
                inside = True
                ws = [0.0, 0.0, 0.0]
                for ei in range(3):
                    e = e_row[ei]
                    # 浮点残差对称 snap 到 0，保证共享边严格命中左上规则
                    if -snap_tol <= e <= snap_tol:
                        e = 0.0
                    if e < 0.0:
                        inside = False
                        break
                    if e == 0.0:
                        dx, dy = edges[ei][2], edges[ei][3]
                        # 左上规则：dy<0 为水平上边；dy==0 且 dx>0 为左边
                        if not (dy < 0.0 or (dy == 0.0 and dx > 0.0)):
                            inside = False
                            break
                    ws[ei] = e
                # x 步进：e(x+1)-e(x) = -dy
                for ei in range(3):
                    e_row[ei] -= edges[ei][3]
                if not inside:
                    continue
                # ws: E_ab, E_bc, E_ca；重心权重：w_a=E_bc, w_b=E_ca, w_c=E_ab
                w_a = ws[1] / area2
                w_b = ws[2] / area2
                w_c = ws[0] / area2
                # 透视正确插值
                denom = w_a * a["inv_z"] + w_b * b["inv_z"] + w_c * c["inv_z"]
                depth = 1.0 / denom
                if depth < cam.near or depth > cam.far:
                    continue
                la = w_a * a["inv_z"] / denom
                lb = w_b * b["inv_z"] / denom
                lc = w_c * c["inv_z"] / denom
                ca, cb, cc = a["rgba"], b["rgba"], c["rgba"]
                r0 = la * ca[0] + lb * cb[0] + lc * cc[0]
                r1 = la * ca[1] + lb * cb[1] + lc * cc[1]
                r2 = la * ca[2] + lb * cb[2] + lc * cc[2]
                alpha = la * ca[3] + lb * cb[3] + lc * cc[3]
                if alpha <= 0.0:
                    continue  # alpha 为 0 不列入
                li = (y - y0) * w + x
                counts[li] += 1
                if cover_lists[li] is None:
                    cover_lists[li] = []
                cover_lists[li].append(Fragment(id=tid, depth=depth, rgba=[r0, r1, r2, alpha]))

    # 3) 填充每像素起止偏移
    offset = 0
    for i in range(n):
        frag_start[i] = offset
        offset += counts[i]
    frag_start[n] = offset
    frag_pixel = [0] * offset
    frag_id = [0] * offset
    frag_depth = [0.0] * offset
    frag_rgba = [0.0] * (offset * 4)
    frag_comp = [0.0] * (offset * 3)

    # 4) 逐像素排序、合成、编码
    cmp_key = cmp_to_key(_depth_cmp)
    for i in range(n):
        frags = cover_lists[i]
        if not frags:
            lr, lg, lb = background
            linear[i * 3:i * 3 + 3] = lr, lg, lb
            r8, g8, b8 = srgb_encode_byte(lr), srgb_encode_byte(lg), srgb_encode_byte(lb)
            rgb8[i * 3:i * 3 + 3] = bytes((r8, g8, b8))
            continue
        frags.sort(key=cmp_key)
        # 前→后预乘合成：acc_rgb 为已累积的预乘颜色，acc_a 为累积不透明度
        acc_r, acc_g, acc_b, acc_a = 0.0, 0.0, 0.0, 0.0
        base = frag_start[i]
        for k, fr in enumerate(frags):
            r, g, b, alpha = fr.rgba
            keep = 1.0 - acc_a
            acc_r += keep * r * alpha
            acc_g += keep * g * alpha
            acc_b += keep * b * alpha
            acc_a += keep * alpha
            # 该层之后的合成值（剩余透明度透出背景）
            slot = base + k
            frag_pixel[slot] = i
            frag_id[slot] = fr.id
            frag_depth[slot] = fr.depth
            frag_rgba[slot * 4:slot * 4 + 4] = fr.rgba
            remain = 1.0 - acc_a
            frag_comp[slot * 3:slot * 3 + 3] = (
                acc_r + remain * background[0],
                acc_g + remain * background[1],
                acc_b + remain * background[2],
            )
        remain = 1.0 - acc_a
        acc_r += remain * background[0]
        acc_g += remain * background[1]
        acc_b += remain * background[2]
        linear[i * 3:i * 3 + 3] = acc_r, acc_g, acc_b
        rgb8[i * 3:i * 3 + 3] = bytes((
            srgb_encode_byte(acc_r),
            srgb_encode_byte(acc_g),
            srgb_encode_byte(acc_b),
        ))

    return {
        "y0": y0, "y1": y1, "width": w,
        "linear": linear,
        "rgb8": bytes(rgb8),
        "frag_start": frag_start,
        "frag_pixel": frag_pixel,
        "frag_id": frag_id,
        "frag_depth": frag_depth,
        "frag_rgba": frag_rgba,
        "frag_comp": frag_comp,
    }


# ---------------------------------------------------------------------------
# 整帧渲染（单进程；CLI 与测试使用）
# ---------------------------------------------------------------------------

def render_frame(scene: dict, size: int | None = None, camera_override: dict | None = None) -> Framebuffer:
    scene = validate_scene(scene)
    size = size or scene["width"]
    if not isinstance(size, int) or size <= 0:
        raise ValidationError("输出尺寸必须为正整数")
    cam = validate_camera_override(camera_override or scene["camera"], scene["camera"])
    band = render_band(scene, size, cam, 0, size)

    fb = Framebuffer(
        width=size, height=size,
        background=scene["background_linear_rgb"],
        linear=band["linear"],
        rgb8=bytearray(band["rgb8"]),
        fragments=[[] for _ in range(size * size)],
    )
    start = band["frag_start"]
    for p in range(size * size):
        s0, s1 = start[p], start[p + 1]
        for slot in range(s0, s1):
            fb.fragments[p].append(Fragment(
                id=band["frag_id"][slot],
                depth=band["frag_depth"][slot],
                rgba=band["frag_rgba"][slot * 4:slot * 4 + 4],
                comp=band["frag_comp"][slot * 3:slot * 3 + 3],
            ))
    return fb


def inspect_pixel(fb: Framebuffer, x: int, y: int) -> dict:
    if not (0 <= x < fb.width and 0 <= y < fb.height):
        raise ValidationError("像素坐标越界")
    p = y * fb.width + x
    return {
        "x": x, "y": y,
        "linear_rgb": fb.linear[p * 3:p * 3 + 3],
        "png_rgb8": list(fb.rgb8[p * 3:p * 3 + 3]),
        "hits": [
            {
                "id": f.id,
                "depth": f.depth,
                "rgba": f.rgba,
                "composite_linear_rgb": f.comp,
            }
            for f in fb.fragments[p]
        ],
    }


# ---------------------------------------------------------------------------
# sRGB 编码与 PNG 输出
# ---------------------------------------------------------------------------

def srgb_encode(c: float) -> float:
    c = min(1.0, max(0.0, c))
    if c <= 0.0031308:
        return c * SRGB_PHI
    return 1.055 * (c ** (1.0 / 2.4)) - SRGB_ALPHA


# 精确 sRGB 字节查找表。threshold[b] = 使公式舍入结果首次达到 b 的最小线性值，
# 由 sRGB 传递函数反解得到；编码用 bisect_left，与逐像素公式严格一致。
def _build_srgb_thresholds():
    thr = [0.0] * 256
    for b in range(1, 256):
        s = (b - 0.5) / 255.0          # 舍入边界：编码值 >= b 当且仅当 sRGB 值 >= 该边界
        if s <= 0.04045:
            thr[b] = s / SRGB_PHI
        else:
            u = (s + SRGB_ALPHA) / 1.055
            thr[b] = u ** 2.4
    return thr


_SRGB_THRESHOLDS = _build_srgb_thresholds()


def srgb_encode_byte(c: float) -> int:
    if c <= 0.0:
        return 0
    if c >= 1.0:
        return 255
    # 首个阈值 > c 的下标 - 1，即 c 落在哪一档
    idx = bisect.bisect_right(_SRGB_THRESHOLDS, c) - 1
    return 255 if idx > 255 else (0 if idx < 0 else idx)


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    chunk = tag + data
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)


def write_png(path: str, rgb8: bytearray | bytes, width: int, height: int) -> None:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = bytearray()
    row_bytes = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0
        raw.extend(rgb8[y * row_bytes:(y + 1) * row_bytes])
    png = b"\x89PNG\r\n\x1a\n"
    png += _png_chunk(b"IHDR", ihdr)
    png += _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += _png_chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def png_bytes(rgb8: bytearray | bytes, width: int, height: int) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = bytearray()
    row_bytes = width * 3
    for y in range(height):
        raw.append(0)
        raw.extend(rgb8[y * row_bytes:(y + 1) * row_bytes])
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _png_chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main(argv=None) -> int:
    import argparse
    import sys
    import time

    ap = argparse.ArgumentParser(description="CPU 软件光栅化参考台")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("render", help="渲染场景为 PNG")
    pr.add_argument("scene")
    pr.add_argument("--size", type=int, default=None)
    pr.add_argument("--out", default=None)

    pc = sub.add_parser("check", help="对照 expected.json 校验全部参考像素")
    pc.add_argument("scene")
    pc.add_argument("--expected", required=True)
    pc.add_argument("--name", default=None)

    args = ap.parse_args(argv)

    with open(args.scene, "r", encoding="utf-8") as f:
        scene_obj = json.load(f)

    t0 = time.perf_counter()
    fb = render_frame(scene_obj, getattr(args, "size", None))
    elapsed = time.perf_counter() - t0

    if args.cmd == "render":
        base = args.out or args.scene.rsplit(".", 1)[0]
        out_png = base + f".{fb.width}.png"
        write_png(out_png, fb.rgb8, fb.width, fb.height)
        print(f"wrote {out_png} in {elapsed:.3f}s")
        return 0

    with open(args.expected, "r", encoding="utf-8") as f:
        expected = json.load(f)
    import os
    key = args.name or os.path.basename(args.scene)
    entries = expected.get(key)
    if entries is None:
        print(f"expected.json 中没有 {key}")
        return 2
    failures = check_entries(fb, entries)
    if failures:
        print(f"FAIL {key}: {len(failures)} 项不符")
        for line in failures[:20]:
            print("  " + line)
        return 1
    print(f"PASS {key}: {len(entries)} 个参考像素全部符合（{elapsed:.3f}s）")
    return 0


def check_entries(fb: Framebuffer, entries: list) -> list:
    """对照 expected 条目列表，返回失败说明（空列表=全部通过）。"""
    failures = []
    for e in entries:
        got = inspect_pixel(fb, e["x"], e["y"])
        tag = f"({e['x']},{e['y']})"
        if len(got["hits"]) != len(e["hits"]):
            failures.append(f"{tag} 片元数 {len(got['hits'])} != {len(e['hits'])}")
            continue
        ok = True
        for k, (gh, eh) in enumerate(zip(got["hits"], e["hits"])):
            if gh["id"] != eh["id"]:
                failures.append(f"{tag} 片元{k} id {gh['id']} != {eh['id']}")
                ok = False
                break
            if abs(gh["depth"] - eh["depth"]) > 1e-6:
                failures.append(
                    f"{tag} 片元{k}({gh['id']}) depth {gh['depth']:.10f} != {eh['depth']:.10f}")
                ok = False
                break
            for ch in range(4):
                if abs(gh["rgba"][ch] - eh["rgba"][ch]) > 1e-6:
                    failures.append(f"{tag} 片元{k}({gh['id']}) rgba 通道{ch} 超差")
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        for ch in range(3):
            if abs(got["linear_rgb"][ch] - e["linear_rgb"][ch]) > 1e-6:
                failures.append(f"{tag} linear 通道{ch} 超差: {got['linear_rgb']} vs {e['linear_rgb']}")
                ok = False
                break
        if not ok:
            continue
        for ch in range(3):
            if abs(got["png_rgb8"][ch] - e["png_rgb8"][ch]) > 1:
                failures.append(f"{tag} png 通道{ch} 超差: {got['png_rgb8']} vs {e['png_rgb8']}")
                break
    return failures


if __name__ == "__main__":
    raise SystemExit(_main())
