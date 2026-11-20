#!/usr/bin/env python3
"""Inspect grayscale PNGs: size, bit depth, value stats, corner values."""
import struct
import sys
import zlib


def read_png(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    pos = 8
    width = height = bitd = ctype = None
    idat = b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype_chunk = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype_chunk == b"IHDR":
            width, height, bitd, ctype, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", chunk)
        elif ctype_chunk == b"IDAT":
            idat += chunk
        elif ctype_chunk == b"IEND":
            break
    raw = zlib.decompress(idat)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    bpp = max(1, (bitd * channels) // 8) if bitd >= 8 else 1
    stride = (width * channels * bitd + 7) // 8
    out = bytearray()
    prev = bytearray(stride)
    p = 0
    for _ in range(height):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            x = line[i]
            if ft == 1:
                x = (x + a) & 255
            elif ft == 2:
                x = (x + b) & 255
            elif ft == 3:
                x = (x + ((a + b) >> 1)) & 255
            elif ft == 4:
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                x = (x + pr) & 255
            line[i] = x
        out += line
        prev = line
    # decode samples
    vals = []
    if bitd == 16:
        for i in range(0, len(out), 2):
            vals.append((out[i] << 8) | out[i + 1])
    elif bitd == 8:
        vals = list(out)
    else:
        # sub-byte: expand
        per = 8 // bitd
        mask = (1 << bitd) - 1
        expanded = []
        for byte in out:
            for k in range(per):
                expanded.append((byte >> (8 - bitd * (k + 1))) & mask)
        vals = expanded
    rows = []
    for r in range(height):
        rows.append(vals[r * width * channels:(r + 1) * width * channels])
    return width, height, bitd, ctype, rows


def main():
    for path in sys.argv[1:]:
        w, h, bitd, ctype, rows = read_png(path)
        flat = [v for row in rows for v in row[:w]]
        uniq = sorted(set(flat))
        print(f"== {path}")
        print(f"   size={w}x{h} bitdepth={bitd} colortype={ctype}")
        print(f"   min={min(flat)} max={max(flat)} unique_count={len(uniq)}")
        if len(uniq) <= 16:
            print(f"   uniq={uniq}")
        print(f"   corners TL={rows[0][0]} TR={rows[0][w-1]} "
              f"BR={rows[h-1][w-1]} BL={rows[h-1][0]}")
        # center 2x2 for small images
        if w <= 12 and h <= 12:
            for r in range(h):
                print("   row", r, rows[r][:w])


if __name__ == "__main__":
    main()
