"""线性 16 位 P5 读写。

约定：密度 = 像素值 / maxval；大端字节序；掩膜非零即有效。
仅接受 P5，maxval < 65536。所有解析在内存中完成，不触碰磁盘路径。
"""
from __future__ import annotations

import numpy as np


class PgmError(ValueError):
    pass


def _read_token(buf: bytes, pos: int) -> tuple[bytes, int]:
    """读取一个 PNM token，跳过空白和 # 注释。"""
    n = len(buf)
    while pos < n:
        c = buf[pos]
        if c in b" \t\n\r\x0b\x0c":
            pos += 1
        elif c == ord("#"):
            while pos < n and buf[pos] not in b"\n\r":
                pos += 1
        else:
            start = pos
            while pos < n and buf[pos] not in b" \t\n\r\x0b\x0c":
                pos += 1
            return buf[start:pos], pos
    raise PgmError("P5 头部不完整")


def parse_p5(data: bytes) -> tuple[np.ndarray, int]:
    """解析 P5 字节流，返回 (float64 二维数组, maxval)。密度需由调用方除以 maxval。"""
    magic, pos = _read_token(data, 0)
    if magic != b"P5":
        raise PgmError(f"仅支持 P5 二进制灰度，收到 {magic!r}")
    w_tok, pos = _read_token(data, pos)
    h_tok, pos = _read_token(data, pos)
    mv_tok, pos = _read_token(data, pos)
    try:
        width, height, maxval = int(w_tok), int(h_tok), int(mv_tok)
    except ValueError as exc:
        raise PgmError("P5 头部尺寸/maxval 不是整数") from exc
    if width <= 0 or height <= 0:
        raise PgmError("P5 尺寸必须为正")
    if not (1 <= maxval < 65536):
        raise PgmError(f"P5 maxval 需在 1..65535，收到 {maxval}")
    # 头部后恰好一个空白符，随后是光栅数据
    if pos >= len(data) or data[pos] not in b" \t\n\r\x0b\x0c":
        raise PgmError("P5 头部格式错误")
    pos += 1
    bytes_per_sample = 1 if maxval < 256 else 2
    need = width * height * bytes_per_sample
    raster = data[pos:pos + need]
    if len(raster) != need:
        raise PgmError(f"P5 光栅数据不足：需要 {need} 字节，实际 {len(raster)}")
    if bytes_per_sample == 1:
        raw = np.frombuffer(raster, dtype=np.uint8)
    else:
        # PNM 16 位统一为大端
        raw = np.frombuffer(raster, dtype=">u2").astype(np.uint16)
    img = raw.reshape(height, width).astype(np.float64)
    return img, maxval


def load_density(data: bytes) -> np.ndarray:
    img, maxval = parse_p5(data)
    return img / maxval


def load_mask(data: bytes, shape: tuple[int, int]) -> np.ndarray:
    img, maxval = parse_p5(data)
    if img.shape != shape:
        raise PgmError(f"掩膜尺寸 {img.shape} 与图像尺寸 {shape} 不一致")
    return (img > 0).astype(np.float64)


def write_p5(density: np.ndarray) -> bytes:
    """按 floor(65535*v + 0.5) 量化为大端 16 位 P5。"""
    if density.ndim != 2:
        raise PgmError("仅支持二维数组")
    if np.any(~np.isfinite(density)):
        raise PgmError("导出数据含非有限值")
    q = np.floor(65535.0 * density + 0.5)
    q = np.clip(q, 0, 65535).astype(np.uint16)
    h, w = density.shape
    header = f"P5\n{w} {h}\n65535\n".encode("ascii")
    return header + q.astype(">u2").tobytes()
