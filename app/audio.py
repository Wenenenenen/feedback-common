"""WAV 读取与校验。约定：16kHz、16 位、单声道 PCM，x = PCM / 32768。"""
from __future__ import annotations

import wave

import numpy as np

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
CHANNELS = 1
REF_MIN_SECONDS = 0.25
REF_MAX_SECONDS = 20.0
QUERY_MIN_SECONDS = 0.25
QUERY_MAX_SECONDS = 8.0
MAX_LIBRARY_FILES = 8
MAX_UPLOAD_BYTES = 16000 * 2 * 20 + 4096  # 20s 16bit 单声道 + 头部余量


class AudioFormatError(ValueError):
    """输入音频不符合 16kHz/16bit/单声道 PCM WAV 约定。"""


def read_wav(path: str) -> np.ndarray:
    """读取 WAV 并返回 float64 一维数组，取值约在 [-1, 1]。"""
    try:
        w = wave.open(path, "rb")
    except (wave.Error, EOFError) as e:
        raise AudioFormatError(f"无法解析为 WAV 文件：{e}") from e
    with w:
        if w.getnchannels() != CHANNELS:
            raise AudioFormatError(f"只支持单声道 WAV，当前声道数={w.getnchannels()}")
        if w.getsampwidth() != SAMPLE_WIDTH:
            raise AudioFormatError(f"只支持 16 位 PCM，当前位宽={w.getsampwidth() * 8}")
        if w.getframerate() != SAMPLE_RATE:
            raise AudioFormatError(f"只支持 {SAMPLE_RATE}Hz 采样率，当前={w.getframerate()}")
        if w.getcomptype() != "NONE":
            raise AudioFormatError("只支持未压缩 PCM WAV")
        n = w.getnframes()
        raw = w.readframes(n)
    if len(raw) < 2:
        raise AudioFormatError("音频文件为空或无有效采样")
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    return pcm / 32768.0


def check_duration(x: np.ndarray, kind: str) -> None:
    """kind: 'reference' 或 'query'，按包内约定校验长度。"""
    seconds = len(x) / SAMPLE_RATE
    lo = QUERY_MIN_SECONDS
    hi = REF_MAX_SECONDS if kind == "reference" else QUERY_MAX_SECONDS
    if not (lo <= seconds <= hi):
        label = "库文件" if kind == "reference" else "查询"
        raise AudioFormatError(
            f"{label}长度需在 {lo:g}~{hi:g} 秒之间，当前为 {seconds:.3f} 秒"
        )
