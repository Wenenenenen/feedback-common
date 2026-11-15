#!/usr/bin/env python3
"""独立 Python 参考实现，用于与浏览器端 JS 实现交叉核对。

只使用标准库；不复用页面里的任何代码，按 conventions.json 的文字规则
重新实现一遍，然后逐样点比较参考 WAV。

用法：python3 -I tests/crosscheck.py [样例目录]
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

SQRT2 = math.sqrt(2.0)
SCALE = 8388608


class CheckError(Exception):
    pass


def read_wav(path: Path):
    data = path.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise CheckError(f"{path.name}: 不是 RIFF/WAVE")
    pos = 12
    fmt = None
    payload = None
    while pos + 8 <= len(data):
        cid = data[pos : pos + 4]
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + size]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            payload = body
        pos += 8 + size + (size & 1)
    if fmt is None or payload is None:
        raise CheckError(f"{path.name}: 缺少 fmt/data")
    tag, channels, rate, _, align, bits = struct.unpack("<HHIIHH", fmt[:16])
    if tag == 0xFFFE and len(fmt) >= 40:
        tag = struct.unpack("<H", fmt[24:26])[0]
    if tag != 1 or bits not in (16, 24):
        raise CheckError(f"{path.name}: 只支持 16/24-bit PCM（tag={tag}, bits={bits}）")
    frames = len(payload) // align
    width = bits // 8
    planes = [[0] * frames for _ in range(channels)]
    for i in range(frames):
        base = i * align
        for ch in range(channels):
            off = base + ch * width
            if width == 2:
                v = struct.unpack_from("<h", payload, off)[0]
            else:
                b = payload[off : off + 3]
                v = b[0] | (b[1] << 8) | (b[2] << 16)
                if v >= 1 << 23:
                    v -= 1 << 24
            planes[ch][i] = v
    return {"rate": rate, "bits": bits, "frames": frames, "planes": planes}


def to_canonical_ints(wav, layout: str):
    """文件通道 → 规范序 [W,Y,Z,X] 的 24-bit 整数。"""
    order = wav["planes"]
    if layout == "ambix":
        w, y, z, x = order[0], order[1], order[2], order[3]
    elif layout == "fuma":
        w, x, y, z = order[0], order[1], order[2], order[3]
    else:
        raise CheckError(f"未知格式 {layout}")
    if wav["bits"] == 24:
        if layout != "fuma":
            return [w[:], y[:], z[:], x[:]]
    scale_in = float(1 << (wav["bits"] - 1))
    scale_out = 8388608.0
    def conv(p):
        return [v / scale_in * scale_out for v in p]
    wv, yv, zv, xv = conv(w), conv(y), conv(z), conv(x)
    if layout == "fuma":
        wv = [v * SQRT2 for v in wv]
    return [wv, yv, zv, xv]


def quat_from_euler_deg(yaw, pitch, roll):
    def axis(ax, ay, az, angle):
        s = math.sin(angle / 2)
        return [math.cos(angle / 2), ax * s, ay * s, az * s]

    qz = axis(0, 0, 1, math.radians(yaw))
    qy = axis(0, 1, 0, math.radians(pitch))
    qx = axis(1, 0, 0, math.radians(roll))

    def mul(a, b):
        aw, ax, ay, az = a
        bw, bx, by, bz = b
        return [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ]

    q = mul(mul(qz, qy), qx)
    n = math.sqrt(sum(c * c for c in q))
    return [c / n for c in q]


def normalize(q):
    n = math.sqrt(sum(c * c for c in q))
    if n == 0:
        raise CheckError("零四元数")
    return [c / n for c in q]


def align(quats):
    out = []
    for i, q in enumerate(quats):
        q = list(q)
        if i:
            d = sum(out[-1][k] * q[k] for k in range(4))
            if d < 0:
                q = [-c for c in q]
        out.append(q)
    return out


def slerp(a, b, t):
    d = max(-1.0, min(1.0, sum(a[k] * b[k] for k in range(4))))
    if d > 0.9999995:
        r = [a[k] + (b[k] - a[k]) * t for k in range(4)]
        n = math.sqrt(sum(c * c for c in r))
        return [c / n for c in r]
    th = math.acos(d)
    s = math.sin(th)
    return [(math.sin((1 - t) * th) * a[k] + math.sin(t * th) * b[k]) / s for k in range(4)]


def matrix_of(q):
    w, x, y, z = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def frames_and_quats(doc):
    kfs = doc["keyframes"] if isinstance(doc, dict) else doc
    frames = [k["frame"] for k in kfs]
    quats = align([normalize(k["q"]) for k in kfs])
    for a, b in zip(frames, frames[1:]):
        if b <= a:
            raise CheckError(f"关键帧未严格递增：{a} → {b}")
    return frames, quats


def rotation_at(frames, quats, f, last):
    if f <= frames[0]:
        return matrix_of(quats[0])
    if f >= frames[last]:
        return matrix_of(quats[last])
    lo = 0
    hi = last
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if frames[mid] <= f:
            lo = mid
        else:
            hi = mid
    span = frames[hi] - frames[lo]
    t = (f - frames[lo]) / span if span else 0.0
    return matrix_of(slerp(quats[lo], quats[hi], t))


def round_half_away(x):
    return int(math.floor(x + 0.5)) if x >= 0 else -int(math.floor(-x + 0.5))


def rotate_and_quantize(canonical, frames, quats):
    """规范序浮点 → 规范序 24-bit 整数（W,Y,Z,X）。"""
    w, y, z, x = canonical
    total = len(w)
    out = [[0] * total for _ in range(4)]
    last = len(frames) - 1
    for f in range(total):
        m = rotation_at(frames, quats, f, last)
        xv, yv, zv = x[f], y[f], z[f]
        out[0][f] = round_half_away(w[f])
        out[1][f] = round_half_away(m[1][0] * xv + m[1][1] * yv + m[1][2] * zv)
        out[2][f] = round_half_away(m[2][0] * xv + m[2][1] * yv + m[2][2] * zv)
        out[3][f] = round_half_away(m[0][0] * xv + m[0][1] * yv + m[0][2] * zv)
    return out


def sanity_static_frame(values, canonical_frames, samples_dir: Path):
    """用示例量化矩阵核对一声场快照（conventions.json 的 monitor_rows_wyzx）。

    监听解码不属于导出路径，这里只校验矩阵本身是 2×4 且形状正确。
    """
    rows = canonical_frames["monitor_rows_wyzx"]
    if len(rows) != 2 or any(len(r) != 4 for r in rows):
        raise CheckError("monitor_rows_wyzx 形状应为 2×4")
    return True


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "samples" / "extracted"
    if not root.is_dir():
        print(f"样例目录不存在：{root}", file=sys.stderr)
        return 2

    conventions = json.loads((root / "conventions.json").read_text(encoding="utf-8"))
    auto = json.loads((root / "automation.json").read_text(encoding="utf-8"))
    frames, quats = frames_and_quats(auto)

    failures = 0
    checks = 0

    def check(name, ok, detail=""):
        nonlocal failures, checks
        checks += 1
        if ok:
            print(f"  ok   {name}")
        else:
            failures += 1
            print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")

    print("== conventions.json ==")
    check("ambix 顺序 W Y Z X", conventions["formats"]["ambix"]["order"] == ["W", "Y", "Z", "X"])
    check("ambix 归一化 SN3D", conventions["formats"]["ambix"]["normalization"] == "sn3d")
    check("fuma 顺序 W X Y Z", conventions["formats"]["fuma"]["order"] == ["W", "X", "Y", "Z"])
    check("监听矩阵 2×4", sanity_static_frame(None, conventions, root))
    check("automation 关键帧数 6", len(frames) == 6, str(len(frames)))
    check("关键帧严格递增", all(b > a for a, b in zip(frames, frames[1:])))
    check("端点 0 与 240000", frames[0] == 0 and frames[-1] == 240000)

    print("\n== FuMa ↔ AmbiX 换算 ==")
    ambix = read_wav(root / "ambix-48000-24.wav")
    fuma = read_wav(root / "fuma-48000-24.wav")
    ca = to_canonical_ints(ambix, "ambix")
    cf = to_canonical_ints(fuma, "fuma")
    worst = 0
    for ch in range(4):
        for i in range(ambix["frames"]):
            worst = max(worst, abs(ca[ch][i] - cf[ch][i]))
    check("FuMa→规范序 与 AmbiX 一致（±2 整数单位）", worst <= 2, f"最大差 {worst}")

    print("\n== 参考自动旋转逐样点核对 ==")
    ref = read_wav(root / "reference-automated-48000-24.wav")
    limit = ambix["frames"] - 1
    over = [f for f in frames if f > limit]
    check("关键帧都在 [0, N-1] 内", not over, str(over))
    out = rotate_and_quantize(ca, frames, quats)
    worst = 0
    worst_at = None
    for ch in range(4):
        rp = ref["planes"][ch]
        for i in range(ref["frames"]):
            d = abs(out[ch][i] - rp[i])
            if d > worst:
                worst = d
                worst_at = (i, ch)
    check("最大逐样点差 ≤ 4 个 24-bit 整数单位", worst <= 4, f"最大差 {worst} @ {worst_at}")
    check("W 通道逐样点完全相同", all(out[0][i] == ref["planes"][0][i] for i in range(ref["frames"])))

    # 采样率与帧数保持不变（参考文件与输入一致）
    check("参考文件帧数一致", ref["frames"] == ambix["frames"])
    check("参考文件采样率一致", ref["rate"] == ambix["rate"])

    print("\n== 溢出样例 ==")
    overload = read_wav(root / "overload-48000-24.wav")
    co = to_canonical_ints(overload, "ambix")
    m = matrix_of(quat_from_euler_deg(45, 0, 0))
    xv, yv, zv = co[3][0], co[1][0], co[2][0]
    y45 = m[1][0] * xv + m[1][1] * yv + m[1][2] * zv
    peak45 = max(abs(y45), abs(xv)) / SCALE
    check("yaw=45° 时峰值 ≈ 1.131", abs(peak45 - 1.13137) < 0.001, f"峰值 {peak45:.6f}")
    check("yaw=45° 会阻止导出（>1）", peak45 > 1.0, f"峰值 {peak45:.6f}")

    m0 = matrix_of(quat_from_euler_deg(0, 0, 0))
    y0 = m0[1][0] * xv + m0[1][1] * yv + m0[1][2] * zv
    check("yaw=0 时峰值 0.8（不溢出）", abs(max(abs(y0), abs(xv)) / SCALE - 0.8) < 1e-6)

    print("\n== 44.1 kHz / 16-bit ==")
    a44 = read_wav(root / "ambix-44100-16.wav")
    check("44.1 kHz 采样率", a44["rate"] == 44100, str(a44["rate"]))
    check("16-bit 位深", a44["bits"] == 16, str(a44["bits"]))
    check("帧数 264600", a44["frames"] == 264600, str(a44["frames"]))

    print("\n== 无效 automation ==")
    for name in ("invalid-zero.json", "invalid-duplicate.json"):
        doc = json.loads((root / name).read_text(encoding="utf-8"))
        rejected = False
        try:
            fs, _ = frames_and_quats(doc)
            kq = doc["keyframes"]
            for k in kq:
                if all(v == 0 for v in k["q"]):
                    rejected = True
            if len(set(fs)) != len(fs):
                rejected = True
        except CheckError:
            rejected = True
        check(f"{name} 应被拒绝", rejected)

    print(f"\n{checks - failures}/{checks} 通过")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CheckError as exc:
        print(f"核对失败：{exc}", file=sys.stderr)
        sys.exit(1)
