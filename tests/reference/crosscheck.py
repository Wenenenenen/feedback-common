#!/usr/bin/env python3
"""独立参照实现：用 Python 逐样本 NLMS 复算样例，与浏览器导出的结果对照。

刻意不复用前端代码，只按样例说明的数值约定重写一遍。用法：

    python3 -I tests/reference/crosscheck.py <cases.zip|解压目录> [<report.json>]

可以直接读样例压缩包，也可以读解压后的目录。
若给出 `report.json`（界面导出的滤波器 JSON），额外比对抽头与削波统计。
退出码 0 表示全部通过。
"""

import json
import math
import struct
import sys
import zipfile
from pathlib import Path

EPSILON = 1e-8
GATE = 1e-7


class CaseSource:
    """统一读取：zip 包内条目或磁盘文件。"""

    def __init__(self, root: Path):
        self.root = root
        self._zip = zipfile.ZipFile(root) if root.suffix.lower() == ".zip" else None

    def read_bytes(self, name: str) -> bytes:
        if self._zip is not None:
            try:
                return self._zip.read(name)
            except KeyError as error:
                raise FileNotFoundError(f"压缩包缺少 {name}") from error
        path = self.root / name
        if not path.exists():
            raise FileNotFoundError(f"目录缺少 {name}")
        return path.read_bytes()

    def read_json(self, name: str):
        return json.loads(self.read_bytes(name).decode("utf-8"))

    def read_wav(self, name: str):
        return decode(self.read_bytes(name), name)


def decode(data: bytes, label: str):
    """解析单声道整数 PCM WAV 并返回 (浮点样本, 采样率, 位深)。"""
    pos = 12
    fmt = None
    pcm = None
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + size]
        if chunk_id == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[:16])
        elif chunk_id == b"data":
            pcm = body
        pos += 8 + size + (size & 1)
    if fmt is None or pcm is None:
        raise ValueError(f"{label} 缺少 fmt 或 data 块")
    tag, channels, rate, _byte_rate, _align, bits = fmt
    if tag != 1 or channels != 1:
        raise ValueError(f"{label} 不是单声道整数 PCM")
    if bits == 16:
        raw = [struct.unpack("<h", pcm[2 * i : 2 * i + 2])[0] for i in range(len(pcm) // 2)]
        scale = 1.0 / 32768
    elif bits == 24:
        raw = []
        for i in range(len(pcm) // 3):
            value = int.from_bytes(pcm[3 * i : 3 * i + 3], "little")
            if value >= 1 << 23:
                value -= 1 << 24
            raw.append(value)
        scale = 1.0 / 8388608
    else:
        raise ValueError(f"{label} 位深 {bits} 不支持")
    return [value * scale for value in raw], rate, bits


def freeze_mask(ranges, total):
    mask = [False] * total
    for start, end in ranges:
        for index in range(max(0, start), min(total, end)):
            mask[index] = True
    return mask


def run_nlms(x, d, delay, taps, mu, leak, freeze):
    h = [0.0] * taps
    echo = []
    residual = []
    mask = freeze_mask(freeze, len(x))
    for n in range(len(x)):
        y = 0.0
        energy = 0.0
        for j in range(taps):
            index = n - delay - j
            if 0 <= index < len(x):
                u = x[index]
                y += h[j] * u
                energy += u * u
        e = d[n] - y
        echo.append(y)
        residual.append(e)
        if not mask[n] and energy >= GATE:
            factor = (mu * e) / (EPSILON + energy)
            for j in range(taps):
                index = n - delay - j
                h[j] = (1 - leak) * h[j] + (factor * x[index] if 0 <= index < len(x) else 0.0)
    return echo, residual, h


def quantize_24(value):
    limit = 1 - 2 ** -23
    clamped = min(limit, max(-1.0, value))
    scaled = clamped * 8388608
    rounded = math.floor(scaled + 0.5) if scaled >= 0 else -math.floor(-scaled + 0.5)
    return min(8388607, max(-8388608, rounded))


def rms(values):
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else 0.0


def check_tiny(source) -> list[str]:
    failures: list[str] = []
    x, _, _ = source.read_wav("tiny-x.wav")
    d, _, _ = source.read_wav("tiny-d.wav")
    cfg = source.read_json("tiny.json")
    expected = source.read_json("tiny-expected.json")
    freeze = [tuple(item) for item in cfg["freeze"]]
    echo, residual, taps = run_nlms(
        x, d, cfg["delay"], cfg["taps"], cfg["mu"], cfg["leak"], freeze
    )
    for i, value in enumerate(expected["echo"]):
        if value != echo[i]:
            failures.append(f"echo[{i}] 参照 {value!r} vs Python {echo[i]!r}")
    for i, value in enumerate(expected["residual"]):
        if value != residual[i]:
            failures.append(f"residual[{i}] 参照 {value!r} vs Python {residual[i]!r}")
    for i, value in enumerate(expected["h"]):
        if value != taps[i]:
            failures.append(f"h[{i}] 参照 {value!r} vs Python {taps[i]!r}")
    print(f"tiny 核对：{'逐位一致' if not failures else '不一致'}（{len(echo)} 帧，{len(taps)} 抽头）")
    return failures


def check_main(source, report_path: Path | None) -> list[str]:
    failures: list[str] = []
    x, rate, _ = source.read_wav("main-x.wav")
    d, _, _ = source.read_wav("main-d.wav")
    cfg = source.read_json("main.json")
    if not report_path:
        print("main 核对：未提供界面导出的 report.json，仅输出参照指标")
        echo, residual, taps = run_nlms(
            x, d, cfg["delay"], cfg["taps"], cfg["mu"], cfg["leak"], [tuple(item) for item in cfg["freeze"]]
        )
        print(f"  整体 d 均方 {rms(d) ** 2:.6f}，e 均方 {rms(residual) ** 2:.6f}")
        print(f"  收敛抽头 12={taps[12]:.6f}（真值 0.35）、40={taps[40]:.6f}（真值 0.30）")
        return failures

    report = json.loads(report_path.read_text(encoding="utf-8"))
    echo, residual, taps = run_nlms(
        x,
        d,
        report["parameters"]["delay"],
        report["parameters"]["taps"],
        report["parameters"]["mu"],
        report["parameters"]["leak"],
        [(item["start"], item["end"]) for item in report["freeze"]],
    )
    total = report["processedFrames"]
    for j, value in enumerate(report["taps"]):
        if value != taps[j]:
            failures.append(f"h[{j}] 界面 {value!r} vs Python {taps[j]!r}")
    below = sum(1 for value in residual[:total] if value < -1)
    above = sum(1 for value in residual[:total] if value > 1 - 2 ** -23)
    peak = max(abs(value) for value in residual[:total])
    reported = report["clipping"]
    if reported["frames"] != below + above:
        failures.append(f"削波帧数 界面 {reported['frames']} vs Python {below + above}")
    if abs(reported["peakAbs"] - peak) > 1e-12:
        failures.append(f"峰值 界面 {reported['peakAbs']} vs Python {peak}")
    print(f"main 核对：{len(report['taps'])} 个抽头逐位比对，{'一致' if not failures else '有差异'}")
    print(f"  削波 {below + above} 帧（低 {below} / 高 {above}），峰值 {peak:.6f}")
    # 区间能量交叉验证
    for interval in report["intervals"]:
        start, end = interval["start"], interval["end"]
        segment_residual = residual[start:end]
        segment_mic = d[start:end]
        expected_e = sum(v * v for v in segment_residual) / len(segment_residual)
        if abs(interval["residualMeanSquare"] - expected_e) > 1e-15:
            failures.append(f"区间 [{start},{end}) 的 e 均方与 Python 不符")
    return failures


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    source = CaseSource(Path(argv[1]))
    report = Path(argv[2]) if len(argv) > 2 else None
    failures = check_tiny(source)
    failures += check_main(source, report)
    if failures:
        print("失败项：")
        for item in failures[:20]:
            print("  -", item)
        return 1
    print("参照交叉验证通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
