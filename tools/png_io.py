"""Minimal PNG decoder (8-bit grayscale/RGB, non-interlaced) using only stdlib."""
import struct
import zlib


def read_png(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos = 8
    width = height = bit_depth = color_type = None
    idat = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", chunk)
            assert interlace == 0 and comp == 0 and filt == 0
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    assert bit_depth == 8
    raw = zlib.decompress(idat)
    stride = width * channels
    out = bytearray(stride * height)
    prev = bytearray(stride)
    i = 0
    for y in range(height):
        ft = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride
        if ft == 1:  # sub
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 255
        elif ft == 2:  # up
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif ft == 3:  # avg
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + (a + prev[x]) // 2) & 255
        elif ft == 4:  # paeth
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                if pa <= pb and pa <= pc:
                    pr = a
                elif pb <= pc:
                    pr = b
                else:
                    pr = c
                line[x] = (line[x] + pr) & 255
        assert ft in (0, 1, 2, 3, 4)
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return width, height, channels, bytes(out)
