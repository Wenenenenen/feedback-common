#!/usr/bin/env python3
"""最小 RGBA8 PNG 解码（仅支持本项目导出的 8-bit RGBA、filter 0/1/2/3/4）。
用标准库 zlib 解 IDAT，反选 PNG 行过滤器，输出原始 RGBA。"""
import struct
import sys
import zlib


def read_chunks(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "PNG 魔数错误"
    off = 8
    while off < len(data):
        (length,) = struct.unpack_from(">I", data, off)
        ctype = data[off + 4:off + 8]
        payload = data[off + 8:off + 8 + length]
        yield ctype, payload
        off += 12 + length


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def main(png_path, out_path):
    data = open(png_path, "rb").read()
    width = height = bit = color = None
    idat = bytearray()
    for ctype, payload in read_chunks(data):
        if ctype == b"IHDR":
            width, height, bit, color, comp, filt, inter = struct.unpack(">IIBBBBB", payload)
            assert bit == 8 and color == 6 and inter == 0, "仅支持 8-bit RGBA 无交错"
        elif ctype == b"IDAT":
            idat += payload
    raw = zlib.decompress(bytes(idat))
    bpp = 4
    stride = width * bpp
    out = bytearray(stride * height)
    pos = 0
    prev = bytearray(stride)
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        for x in range(stride):
            left = line[x - bpp] if x >= bpp else 0
            up = prev[x]
            up_left = prev[x - bpp] if x >= bpp else 0
            if ftype == 0:
                pass
            elif ftype == 1:
                line[x] = (line[x] + left) & 0xFF
            elif ftype == 2:
                line[x] = (line[x] + up) & 0xFF
            elif ftype == 3:
                line[x] = (line[x] + ((left + up) >> 1)) & 0xFF
            elif ftype == 4:
                line[x] = (line[x] + paeth(left, up, up_left)) & 0xFF
            else:
                raise ValueError(f"未知过滤器 {ftype}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    with open(out_path, "wb") as fh:
        fh.write(out)
    print(f"{width}x{height} -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
