"""星座图指纹：频谱峰 -> 成对指纹（参数严格遵循包内 说明.md 约定）。"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

NFFT = 512
HOP = 128
BIN_LO = 3
BIN_HI = 230
NEIGHBOR = 2
MAX_PEAKS_PER_FRAME = 4
PAIR_DF_MIN = 4
PAIR_DF_MAX = 24
MAX_PAIRS_PER_ANCHOR = 4
MIN_GLOBAL_MAX = 1e-5
THRESHOLD_DB = -40.0


def _window() -> np.ndarray:
    n = np.arange(NFFT)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * n / NFFT)


WINDOW = _window()


@dataclass
class Fingerprint:
    peaks: list[tuple[int, int, float]]          # (帧, 箱, 幅值)
    pairs: list[tuple[int, int, int, int, tuple[int, int, int]]]
    # 每条配对: (锚帧, 锚箱, 目标帧, 目标箱, 哈希(锚箱,目标箱,帧差))
    spectrogram: np.ndarray                      # 帧 x 257 幅值矩阵
    global_max: float
    n_frames: int

    @property
    def silent(self) -> bool:
        return self.global_max < MIN_GLOBAL_MAX or not self.peaks

    @property
    def n_pairs(self) -> int:
        return len(self.pairs)


def stft(x: np.ndarray) -> tuple[np.ndarray, int]:
    """只分析完整窗口。返回 (帧数 x 257 幅值矩阵, 帧数)。"""
    if len(x) < NFFT:
        return np.zeros((0, NFFT // 2 + 1), dtype=np.float64), 0
    n_frames = 1 + (len(x) - NFFT) // HOP
    # 逐帧加窗 rfft
    frames = np.lib.stride_tricks.sliding_window_view(x, NFFT)[::HOP][:n_frames]
    spec = np.abs(np.fft.rfft(frames * WINDOW, axis=1))
    return spec, n_frames


def extract_peaks(spec: np.ndarray) -> tuple[list[tuple[int, int, float]], float]:
    """每帧在箱 3..230 内取局部峰，阈值为全文件最大幅值 -40dB。"""
    if spec.shape[0] == 0:
        return [], 0.0
    global_max = float(spec.max())
    if global_max < MIN_GLOBAL_MAX:
        return [], global_max

    threshold = global_max * (10.0 ** (THRESHOLD_DB / 20.0))
    peaks: list[tuple[int, int, float]] = []
    n_frames = spec.shape[0]
    for f in range(n_frames):
        row = spec[f]
        candidates: list[tuple[int, float]] = []
        for b in range(BIN_LO, BIN_HI + 1):
            amp = row[b]
            if amp < threshold:
                continue
            is_peak = True
            for j in range(max(BIN_LO, b - NEIGHBOR), min(BIN_HI, b + NEIGHBOR) + 1):
                if j == b:
                    continue
                # 等值取较小箱：左侧必须严格更小，右侧允许相等
                if j < b and row[j] >= amp:
                    is_peak = False
                    break
                if j > b and row[j] > amp:
                    is_peak = False
                    break
            if is_peak:
                candidates.append((b, float(amp)))
        # 幅值降序、箱号升序，每帧最多 4 个
        candidates.sort(key=lambda t: (-t[1], t[0]))
        for b, amp in candidates[:MAX_PEAKS_PER_FRAME]:
            peaks.append((f, b, amp))
    return peaks, global_max


def build_pairs(
    peaks: list[tuple[int, int, float]],
) -> list[tuple[int, int, int, int, tuple[int, int, int]]]:
    """锚峰与后续 4..24 帧的峰配对，每锚最多 4 对。"""
    by_frame: dict[int, list[tuple[int, float]]] = {}
    for f, b, amp in peaks:
        by_frame.setdefault(f, []).append((b, amp))

    pairs: list[tuple[int, int, int, int, tuple[int, int, int]]] = []
    for af, ab, a_amp in peaks:
        candidates: list[tuple[int, int, int, float]] = []  # (帧差, 目标帧, 目标箱, 目标幅值)
        for df in range(PAIR_DF_MIN, PAIR_DF_MAX + 1):
            tf = af + df
            if tf not in by_frame:
                continue
            for tb, t_amp in by_frame[tf]:
                candidates.append((df, tf, tb, t_amp))
        # 时间差升序、目标幅值降序、目标箱号升序
        candidates.sort(key=lambda c: (c[0], -c[3], c[2]))
        for df, tf, tb, _ in candidates[:MAX_PAIRS_PER_ANCHOR]:
            pairs.append((af, ab, tf, tb, (ab, tb, df)))
    return pairs


def fingerprint(x: np.ndarray) -> Fingerprint:
    spec, n_frames = stft(x)
    peaks, global_max = extract_peaks(spec)
    pairs = build_pairs(peaks) if peaks else []
    return Fingerprint(
        peaks=peaks,
        pairs=pairs,
        spectrogram=spec,
        global_max=global_max,
        n_frames=n_frames,
    )
