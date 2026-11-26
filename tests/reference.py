#!/usr/bin/env python3
"""独立参考实现：移动声源双耳校音。

刻意用与网页引擎不同的求根方式（在此用二分法；网页用二次方程 + 牛顿修正），
以便交叉核对。仅使用标准库。

约定（摘自 samples/moving-audio.zip/format.txt）：
- 空间三维整数坐标，每帧声速 1 个坐标单位；坐标为整数、绝对值 ≤ 1000000。
- 耳位在相邻关键点间线性插值，速度范数 ≤ 1/2。
- 对整数接收帧 t、每耳、每段解 t-u = ||S(u)-E(t)||，u∈[start,end) 且 u≤t。
- q = u - start + offset，floor(q) 与后一样本线性插值；后一样本越过本段引用末尾记 0。
- 每项乘 8/(8+d)，d=t-u；同耳求和后四舍五入（.5 远离零）并夹到 [-32768,32767]。
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

SPEED = 1.0  # 每帧 1 个坐标单位


# ── 场景加载 / 基础几何 ──────────────────────────────────────────────

def load_scene(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_wav_pcm16(path: Path) -> list[int]:
    data = Path(path).read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not RIFF/WAVE")
    pos = 12
    fmt = None
    pcm = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            pcm = body
            break
        pos += 8 + size + (size & 1)
    if fmt is None or pcm is None:
        raise ValueError("missing fmt/data")
    tag, ch, rate, _byte_rate, _align, bits = struct.unpack("<HHIIHH", fmt[:16])
    if (tag, ch, rate, bits) != (1, 1, 48000, 16):
        raise ValueError(f"unsupported WAV {tag} {ch}ch {rate}Hz {bits}bit")
    n = len(pcm) // 2
    return list(struct.unpack("<%dh" % n, pcm[:2 * n]))


def ear_position(ears: list[dict], side: str, t: float) -> tuple[float, float, float]:
    """耳位按关键点线性插值；t 超出 [0, frames] 时夹到端点。"""
    ts = [e["t"] for e in ears]
    if t <= ts[0]:
        p = ears[0][side]
        return (float(p[0]), float(p[1]), float(p[2]))
    if t >= ts[-1]:
        p = ears[-1][side]
        return (float(p[0]), float(p[1]), float(p[2]))
    lo, hi = 0, len(ts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if ts[mid] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = ts[lo], ts[hi]
    f = (t - t0) / (t1 - t0)
    a, b = ears[lo][side], ears[hi][side]
    return (
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
    )


def source_position(seg: dict, u: float) -> tuple[float, float, float]:
    s, e = seg["start"], seg["end"]
    f = (u - s) / (e - s)
    p0, p1 = seg["p0"], seg["p1"]
    return (
        p0[0] + (p1[0] - p0[0]) * f,
        p0[1] + (p1[1] - p0[1]) * f,
        p0[2] + (p1[2] - p0[2]) * f,
    )


def dist3(a, b) -> float:
    dx, dy, dz = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    return math.sqrt(dx * dx + dy * dy + dz * dz)


# ── 到达求解（二分） ─────────────────────────────────────────────────

def solve_arrival(seg: dict, ear_xyz, t: int, tol: float = 1e-12):
    """返回 (u, d) 或 None。半开：u∈[start,end)，t 为整数接收帧。"""
    s, e = seg["start"], seg["end"]
    lo = float(s)
    hi = float(e)

    def g(u: float) -> float:
        return u + dist3(source_position(seg, u), ear_xyz) - t

    g_lo = g(lo)
    g_hi_limit = hi + dist3(seg["p1"], ear_xyz) - t  # u→end 的极限
    if g_lo > 0.0 or g_hi_limit <= 0.0:
        return None
    # g 严格递增（斜率 ≥ 1/2）；u=start 处为 0 时包含，u=end 处为 0 时排除
    a, b = lo, hi
    for _ in range(200):
        mid = 0.5 * (a + b)
        if g(mid) <= 0.0:
            a = mid
        else:
            b = mid
        if b - a <= tol * max(1.0, abs(a)):
            break
    u = 0.5 * (a + b)
    if u < lo:
        u = lo
    if u >= hi:
        return None
    d = t - u
    if d < 0:
        d = 0.0
    return u, d


def sample_segment(wav: list[int], seg: dict, u: float) -> float:
    """段引用范围内 floor(q) 与后一样本插值；后一样本越过引用末尾记 0。"""
    start, end, offset = seg["start"], seg["end"], seg["offset"]
    ref_begin = offset
    ref_end = offset + (end - start)  # 半开
    q = u - start + offset
    k = math.floor(q)
    frac = q - k
    if k < ref_begin:
        # 数值上 u 略小于 start 时夹到首样本
        k = ref_begin
        frac = 0.0
    if k >= ref_end:
        return 0.0
    v0 = float(wav[k])
    v1 = float(wav[k + 1]) if (k + 1) < ref_end else 0.0
    return v0 + (v1 - v0) * frac


def contributions_at(scene: dict, wavs: list[list[int]], t: int, side: str):
    ear = ear_position(scene["ears"], side, float(t))
    out = []
    for ti, track in enumerate(scene["tracks"]):
        wav = wavs[ti]
        for si, seg in enumerate(track["segments"]):
            got = solve_arrival(seg, ear, t)
            if got is None:
                continue
            u, d = got
            gain = 8.0 / (8.0 + d)
            val = sample_segment(wav, seg, u)
            out.append({
                "track": ti,
                "segment": si,
                "u": u,
                "d": d,
                "gain": gain,
                "q": u - seg["start"] + seg["offset"],
                "value": val,
                "contrib": val * gain,
            })
    return out


def round_half_away(x: float) -> int:
    if x >= 0:
        return math.floor(x + 0.5)
    return math.ceil(x - 0.5)


def render(scene: dict, wavs: list[list[int]]):
    frames = scene["frames"]
    left = [0] * frames
    right = [0] * frames
    counts = {"left": [0] * frames, "right": [0] * frames}
    for t in range(frames):
        for side, arr in (("left", left), ("right", right)):
            total = 0.0
            for track_i, track in enumerate(scene["tracks"]):
                wav = wavs[track_i]
                ear = ear_position(scene["ears"], side, float(t))
                for seg in track["segments"]:
                    got = solve_arrival(seg, ear, t)
                    if got is None:
                        continue
                    u, d = got
                    total += sample_segment(wav, seg, u) * (8.0 / (8.0 + d))
                    counts[side][t] += 1
            arr[t] = max(-32768, min(32767, round_half_away(total)))
    return left, right, counts


def write_wav_stereo16(path: Path, left, right) -> None:
    frames = len(left)
    body = bytearray()
    for i in range(frames):
        body += struct.pack("<hh", left[i], right[i])
    data = bytes(body)
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 2, 48000, 48000 * 4, 4, 16)
    header += b"data" + struct.pack("<I", len(data))
    Path(path).write_bytes(header + data)


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("scene")
    ap.add_argument("--out", default=None)
    ap.add_argument("--arrivals", type=int, default=None, help="打印该帧左右耳到达")
    ap.add_argument("--frames", type=int, default=None, help="仅渲染前 N 帧")
    args = ap.parse_args()

    scene_path = Path(args.scene)
    scene = load_scene(scene_path)
    base = scene_path.parent
    wavs = [read_wav_pcm16(base / tr["wav"]) for tr in scene["tracks"]]
    if args.frames is not None:
        scene = dict(scene)
        scene["frames"] = min(scene["frames"], args.frames)

    left, right, counts = render(scene, wavs)
    print(f"frames={scene['frames']} 峰值 L={max(map(abs,left))} R={max(map(abs,right))}")
    nonz = sum(1 for i in range(len(left)) if left[i] or right[i])
    print(f"非零帧={nonz} 首非零={next((i for i in range(len(left)) if left[i] or right[i]), None)}")
    if args.arrivals is not None:
        t = args.arrivals
        for side in ("left", "right"):
            cs = contributions_at(scene, wavs, t, side)
            print(f"t={t} {side}: {len(cs)} 项")
            for c in cs[:20]:
                print("   track=%d seg=%d u=%.9f d=%.9f gain=%.9f q=%.9f val=%.6f" %
                      (c["track"], c["segment"], c["u"], c["d"], c["gain"], c["q"], c["value"]))
    if args.out:
        write_wav_stereo16(Path(args.out), left, right)
        print("写出", args.out)


if __name__ == "__main__":
    main()
