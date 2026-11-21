#!/usr/bin/env python3
"""Independent MVR1 decoder used only to cross-check src/mvr1.js.

Deliberately written from the spec text with no shared code, plain Python,
integer maths only.  Prints one JSON document on stdout.
"""
import json
import math
import sys


def r_u16(b, p):
    return b[p] | (b[p + 1] << 8)


def r_u32(b, p):
    return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)


def r_i16(b, p):
    v = b[p] | (b[p + 1] << 8)
    return v - 65536 if v >= 32768 else v


def r_i8(b, p):
    v = b[p]
    return v - 256 if v >= 128 else v


def bilinear(plane, pw, ph, x, y):
    """x, y are integer doubles in half-pixel units; sample is x/2, y/2."""
    # nearest integer neighbours to x/2, y/2 (floor of the exact rational)
    qx = math.floor(x / 2)
    qy = math.floor(y / 2)
    ax = (x % 2)
    ay = (y % 2)
    if ax < 0:
        ax += 2
    if ay < 0:
        ay += 2
    x0 = min(max(qx, 0), pw - 1)
    x1 = min(max(qx + 1, 0), pw - 1)
    y0 = min(max(qy, 0), ph - 1)
    y1 = min(max(qy + 1, 0), ph - 1)
    a = plane[y0 * pw + x0]
    b = plane[y0 * pw + x1]
    c = plane[y1 * pw + x0]
    d = plane[y1 * pw + x1]
    num = a * (2 - ax) * (2 - ay) + b * ax * (2 - ay) + c * (2 - ax) * ay + d * ax * ay
    return (num + 2) // 4


def pad(src, w, h, pw, ph):
    out = [0] * (pw * ph)
    for y in range(ph):
        sy = min(y, h - 1) * w
        for x in range(pw):
            out[y * pw + x] = src[sy + min(x, w - 1)]
    return out


def main(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'MVR1', 'bad magic'
    w, h, n, ki, qs = (r_u16(data, 4), r_u16(data, 6), r_u16(data, 8),
                       r_u16(data, 10), r_u16(data, 12))
    pw = (w + 7) // 8 * 8
    ph = (h + 7) // 8 * 8
    bw, bh = pw // 8, ph // 8
    pos = 14
    prev = None
    frames = []
    for fi in range(n):
        ftype = data[pos]
        pos += 1
        plen = r_u32(data, pos)
        pos += 4
        end = pos + plen
        assert data[pos - 4 - 1] == ftype
        pred = [0] * (pw * ph)
        rec = [0] * (pw * ph)
        vectors = []
        for by in range(bh):
            for bx in range(bw):
                dx = dy = 0
                if ftype == 1:
                    dx = r_i8(data, pos)
                    dy = r_i8(data, pos + 1)
                    pos += 2
                coef = [0] * 64
                ci = 0
                while ci < 64:
                    run = data[pos]
                    pos += 1
                    ci += run
                    if ci == 64:
                        break
                    coef[ci] = r_i16(data, pos)
                    pos += 2
                    ci += 1
                vectors.append([dx, dy] if ftype == 1 else None)
                for yy in range(8):
                    y = by * 8 + yy
                    for xx in range(8):
                        x = bx * 8 + xx
                        if ftype == 0:
                            p = 128
                        else:
                            p = bilinear(prev, pw, ph, x * 2 + dx, y * 2 + dy)
                        pred[y * pw + x] = p
                        v = p + coef[yy * 8 + xx] * qs
                        rec[y * pw + x] = 0 if v < 0 else (255 if v > 255 else v)
        assert pos <= end, 'block overrun'
        if pos < end:
            raise SystemExit('frame %d: %d stray bytes' % (fi, end - pos))
        frames.append({
            'type': ftype,
            'rec': rec,
            'pred': pred,
            'vectors': vectors,
            'crop': [rec[y * pw + x] for y in range(h) for x in range(w)],
        })
        prev = rec
    assert pos == len(data), 'trailing bytes'
    print(json.dumps({'w': w, 'h': h, 'n': n, 'pw': pw, 'ph': ph,
                      'ki': ki, 'qs': qs, 'frames': frames}))


if __name__ == '__main__':
    main(sys.argv[1])
