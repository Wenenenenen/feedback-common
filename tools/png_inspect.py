#!/usr/bin/env python3
"""Minimal read-only PNG inspector (8-bit grayscale / palette / RGB), stdlib only."""
import struct, zlib, sys, os


def read_png(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos = 8
    width = height = bit_depth = color_type = None
    idat = b""
    palette = None
    trns = None
    while pos < len(data):
        length, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", chunk)
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"PLTE":
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif ctype == b"tRNS":
            trns = chunk
    raw = zlib.decompress(idat)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    bpp = max(1, channels * bit_depth // 8)
    stride = (width * channels * bit_depth + 7) // 8
    out = bytearray()
    prev = bytearray(stride)
    p = 0
    for _ in range(height):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if ftype == 1:
                line[i] = (line[i] + a) & 255
            elif ftype == 2:
                line[i] = (line[i] + b) & 255
            elif ftype == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif ftype == 4:
                x = a + b - c
                pa, pb, pc = abs(x - a), abs(x - b), abs(x - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out += line
        prev = line
    return width, height, bit_depth, color_type, bytes(out), palette, trns


def main():
    for path in sys.argv[1:]:
        w, h, bd, ct, px, pal, trns = read_png(path)
        cname = {0: "gray", 2: "rgb", 3: "palette", 4: "gray+alpha", 6: "rgba"}[ct]
        print(f"== {os.path.basename(path)}  {w}x{h} bit={bd} type={cname}")
        if ct == 0 and bd == 8:
            vals = sorted(set(px))
            print("   unique values:", vals[:40], ("..." if len(vals) > 40 else ""))
            for y in range(h):
                row = px[y * w:(y + 1) * w]
                print("  ", y, " ".join(str(v) for v in row))
        elif ct == 3:
            vals = sorted(set(px))
            print("   palette entries used:", vals)
            for v in vals:
                print("    idx", v, "rgb", pal[v] if pal else None,
                      "alpha", trns[v] if trns and v < len(trns) else 255)
            for y in range(h):
                row = px[y * w:(y + 1) * w]
                print("  ", y, " ".join(str(v) for v in row))
        else:
            print("   (raw dump skipped, bytes=%d)" % len(px))


if __name__ == "__main__":
    main()
