#!/usr/bin/env python3
"""独立 Python 参考实现，用于与浏览器 JS 实现交叉核对。

只使用标准库。按矩阵定义逐点计算卷积（朴素实现），
并用 cases.json 的预期长度/峰值断言。

用法：python3 -I tests/crosscheck.py [样例目录]
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def read_wav(path: Path):
    data = path.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"{path}: 不是 RIFF/WAVE")
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
        raise ValueError(f"{path}: 缺少 fmt/data")
    tag, channels, rate, _, align, bits = struct.unpack("<HHIIHH", fmt[:16])
    if tag != 1 or bits not in (16, 24):
        raise ValueError(f"{path}: 只支持 16/24-bit PCM（tag={tag}, bits={bits}）")
    frames = len(payload) // align
    width = bits // 8
    scale = 1.0 / (1 << (bits - 1))
    channels_data = [[0.0] * frames for _ in range(channels)]
    for i in range(frames):
        base = i * align
        for ch in range(channels):
            off = base + ch * width
            if width == 2:
                v = struct.unpack_from("<h", payload, off)[0]
            else:
                b = payload[off : off + 3]
                v = int.from_bytes(b, "little")
                if v & 0x800000:
                    v -= 1 << 24
            channels_data[ch][i] = v * scale
    return rate, channels, channels_data


def convolve(x, h):
    n = len(x) + len(h) - 1
    y = [0.0] * n
    # 稀疏优化：跳过零抽头
    nz_h = [(j, v) for j, v in enumerate(h) if v != 0.0]
    for i, a in enumerate(x):
        if a == 0.0:
            continue
        for j, b in nz_h:
            y[i + j] += a * b
    return y


def add(a, b):
    n = max(len(a), len(b))
    out = [0.0] * n
    out[: len(a)] = a
    for i, v in enumerate(b):
        out[i] += v
    return out


def render(dry_l, dry_r, irs, predelay, wet):
    """irs 顺序 LL, LR, RL, RR（首字母=输出，次字母=输入）。"""
    wet_l = add(convolve(dry_l, irs[0]), convolve(dry_r, irs[1]))
    wet_r = add(convolve(dry_l, irs[2]), convolve(dry_r, irs[3]))
    max_ir = max(len(h) for h in irs)
    total = len(dry_l) + max_ir - 1 + predelay
    out_l = [0.0] * total
    out_r = [0.0] * total
    for t in range(total):
        out_l[t] = (1 - wet) * (dry_l[t] if t < len(dry_l) else 0.0)
        out_r[t] = (1 - wet) * (dry_r[t] if t < len(dry_r) else 0.0)
    for t, v in enumerate(wet_l):
        if t + predelay < total:
            out_l[t + predelay] += wet * v
    for t, v in enumerate(wet_r):
        if t + predelay < total:
            out_r[t + predelay] += wet * v
    return out_l, out_r


def non_zero(arr, eps=1e-12):
    return {i: round(v, 10) for i, v in enumerate(arr) if abs(v) > eps}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path("samples/extracted"))
    cases = json.loads((root / "cases.json").read_text(encoding="utf-8"))
    failures = 0

    # sparse
    rate, ch, dry = read_wav(root / "sparse/dry.wav")
    irs = [read_wav(root / f"sparse/{name}.wav")[2][0] for name in ("LL", "LR", "RL", "RR")]
    wet = cases["sparse"]["wet_ratio"]
    pd = cases["sparse"]["predelay_frames"]
    out_l, out_r = render(dry[0], dry[1], irs, pd, wet)
    expected_n = cases["sparse"]["expected_output_frames"]
    ok = len(out_l) == expected_n and len(out_r) == expected_n
    print(f"{'ok  ' if ok else 'FAIL'} sparse 输出长度 {len(out_l)}（期望 {expected_n}）")
    failures += 0 if ok else 1

    peak = max(max(map(abs, out_l)), max(map(abs, out_r)))
    ok = abs(peak - 0.24375) < 1e-12
    print(f"{'ok  ' if ok else 'FAIL'} sparse 峰值 {peak:.10f}（期望 0.24375）")
    failures += 0 if ok else 1

    nzl = non_zero(out_l)
    nzr = non_zero(out_r)
    exp_l = {
        0: 0.175, 37: 0.1625, 45: 0.040625, 293: 0.08125, 556: -0.08125,
        1023: -0.0875, 1060: -0.08125, 1061: -0.040625, 1316: -0.040625,
        2084: 0.0203125, 2086: 0.08125, 2597: -0.1625, 4098: 0.0875,
        4135: 0.08125, 4391: 0.040625, 5159: -0.0203125,
    }
    exp_r = {
        7: 0.0875, 40: -0.08125, 44: 0.121875, 172: 0.040625, 813: 0.040625,
        1063: 0.040625, 1836: -0.0203125, 2048: 0.175, 2085: 0.24375,
        2213: 0.08125, 4138: -0.040625, 4911: 0.0203125,
    }
    for name, actual, expected in (("L", nzl, exp_l), ("R", nzr, exp_r)):
        diffs = [
            (i, actual.get(i), v)
            for i, v in expected.items()
            if i not in actual or abs(actual[i] - v) > 1e-9
        ]
        extras = sorted(set(actual) - set(expected))
        ok = not diffs and not extras
        print(f"{'ok  ' if ok else 'FAIL'} sparse {name} 逐点核对（{len(expected)} 个非零点）"
              + ("" if ok else f" — 差异 {diffs[:3]} 多余 {extras[:3]}"))
        failures += 0 if ok else 1

    # clip：峰值与超限
    rate, ch, dry = read_wav(root / "clip/dry.wav")
    irs = [read_wav(root / f"clip/{name}.wav")[2][0] for name in ("LL", "LR", "RL", "RR")]
    out_l, out_r = render(dry[0], dry[1], irs, 0, 1.0)
    peak = max(max(map(abs, out_l)), max(map(abs, out_r)))
    over = sum(1 for v in out_l + out_r if abs(v) > 1.0)
    ok = abs(peak - cases["clip"]["expected_peak"]) < 1e-12 and len(out_l) == cases["clip"]["expected_output_frames"]
    print(f"{'ok  ' if ok else 'FAIL'} clip 峰值 {peak:.6f} / 长度 {len(out_l)}")
    failures += 0 if ok else 1
    ok = over == 8198
    print(f"{'ok  ' if ok else 'FAIL'} clip 超限样本 {over}（期望 8198）")
    failures += 0 if ok else 1

    # long：长度
    rate, ch, dry = read_wav(root / "long/dry.wav")
    irs = [read_wav(root / f"long/{name}.wav")[2][0] for name in ("LL", "LR", "RL", "RR")]
    total = len(dry[0]) + max(len(h) for h in irs) - 1
    ok = total == cases["long"]["expected_output_frames"]
    print(f"{'ok  ' if ok else 'FAIL'} long 输出长度 {total}（期望 {cases['long']['expected_output_frames']}）")
    failures += 0 if ok else 1

    # rate441：采样率一致
    rates = {read_wav(root / f"rate441/{n}.wav")[0] for n in ("dry", "LL", "LR", "RL", "RR")}
    ok = rates == {44100}
    print(f"{'ok  ' if ok else 'FAIL'} rate441 全部 44.1 kHz：{sorted(rates)}")
    failures += 0 if ok else 1

    print(f"\n{'全部通过' if failures == 0 else f'{failures} 项失败'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
