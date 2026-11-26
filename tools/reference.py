#!/usr/bin/env python3
"""Independent reference implementation of clipped raster moments.

Strategy differs from the JS engine on purpose: every pixel cell is clipped
exactly against every ring with Sutherland-Hodgman (Fraction arithmetic), ring
pieces are combined by the even-odd rule, then Green's theorem gives each
cell's geometric moments. No sampling of any kind.
"""
import argparse
import json
import sys
from fractions import Fraction


def read_pgm(path):
    with open(path, 'rb') as f:
        data = f.read()
    pos = 0

    def token():
        nonlocal pos
        while pos < len(data) and data[pos:pos + 1] in (b' ', b'\t', b'\n', b'\r'):
            pos += 1
        if data[pos:pos + 1] == b'#':
            while pos < len(data) and data[pos:pos + 1] not in (b'\n', b'\r'):
                pos += 1
            return token()
        start = pos
        while pos < len(data) and data[pos:pos + 1] not in (b' ', b'\t', b'\n', b'\r', b'#'):
            pos += 1
        return data[start:pos].decode('ascii')

    magic = token()
    assert magic == 'P5'
    w, h, maxval = int(token()), int(token()), int(token())
    pos += 1  # single separating whitespace
    bps = 2 if maxval >= 256 else 1
    gray = []
    for i in range(w * h):
        if bps == 1:
            gray.append(data[pos])
            pos += 1
        else:
            gray.append((data[pos] << 8) | data[pos + 1])
            pos += 2
    return w, h, gray


def clip_poly(poly, lo_x, hi_x, lo_y, hi_y):
    """Sutherland-Hodgman against an axis-aligned cell. Fraction points."""
    def keep(p, side):
        x, y = p
        if side == 0: return x >= lo_x
        if side == 1: return x <= hi_x
        if side == 2: return y >= lo_y
        return y <= hi_y

    def inter(s, e, side):
        sx, sy = s
        ex, ey = e
        if side == 0: t = (lo_x - sx) / (ex - sx); return (lo_x, sy + t * (ey - sy))
        if side == 1: t = (hi_x - sx) / (ex - sx); return (hi_x, sy + t * (ey - sy))
        if side == 2: t = (lo_y - sy) / (ey - sy); return (sx + t * (ex - sx), lo_y)
        t = (hi_y - sy) / (ey - sy)
        return (sx + t * (ex - sx), hi_y)

    cur = poly
    for side in range(4):
        if not cur:
            return []
        nxt = []
        n = len(cur)
        for i in range(n):
            s, e = cur[i - 1], cur[i]
            sin, ein = keep(s, side), keep(e, side)
            if ein and not sin:
                nxt.append(inter(s, e, side))
                nxt.append(e)
            elif ein:
                nxt.append(e)
            elif sin:
                nxt.append(inter(s, e, side))
        cur = nxt
    return cur


def dedupe(poly):
    out = []
    for p in poly:
        if not out or out[-1] != p:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def poly_moments(poly):
    m = {k: Fraction(0) for k in ('M00', 'M10', 'M01', 'M20', 'M02', 'M11')}
    n = len(poly)
    if n < 3:
        return m
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[(i + 1) % n]
        cr = xi * yj - xj * yi
        if cr == 0:
            continue
        m['M00'] += cr / 2
        m['M10'] += cr * (xi + xj) / 6
        m['M01'] += cr * (yi + yj) / 6
        m['M20'] += cr * (xi * xi + xi * xj + xj * xj) / 12
        m['M02'] += cr * (yi * yi + yi * yj + yj * yj) / 12
        m['M11'] += cr * (xi * yj + 2 * xi * yi + 2 * xj * yj + xj * yi) / 24
    return m


def ring_containing(polys, px, py):
    """How many of the given polygons contain point (px, py), boundary included."""
    count = 0
    for poly in polys:
        n = len(poly)
        inside = False
        for i in range(n):
            x1, y1 = poly[i - 1]
            x2, y2 = poly[i]
            if (y1 > py) != (y2 > py):
                xint = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
                if px < xint:
                    inside = not inside
        count += 1 if inside else 0
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pgm')
    ap.add_argument('region')
    args = ap.parse_args()
    w, h, gray = read_pgm(args.pgm)
    with open(args.region) as f:
        region = json.load(f)
    rings = [region['outer']] + region.get('holes', [])
    rings = [
        [ (Fraction(x, 16), Fraction(y, 16)) for x, y in ring ]
        for ring in rings
    ]

    totals = {k: Fraction(0) for k in ('M00', 'M10', 'M01', 'M20', 'M02', 'M11')}
    cells = []
    outer_ring = rings[0]
    hole_rings = rings[1:]
    for r in range(h):
        for c in range(w):
            # Clip every ring to the cell. The cell's region membership is
            # then decided by even-odd containment: inside the outer ring and
            # inside an even number (0, 2, ...) of hole rings.
            outer_piece = dedupe(clip_poly(
                outer_ring, Fraction(c), Fraction(c + 1),
                Fraction(r), Fraction(r + 1)))
            if len(outer_piece) < 3:
                continue
            hole_pieces = []
            for ring in hole_rings:
                piece = dedupe(clip_poly(
                    ring, Fraction(c), Fraction(c + 1),
                    Fraction(r), Fraction(r + 1)))
                if len(piece) >= 3:
                    hole_pieces.append(piece)

            # Exact area combination (no point sampling): outer piece minus
            # the hole pieces crossing this cell. Each clipped piece is
            # orientation-normalized by its signed area.
            cell_m = {k: Fraction(0) for k in totals}
            om = poly_moments(outer_piece)
            sgn = 1 if om['M00'] > 0 else -1
            for k in totals:
                cell_m[k] += sgn * om[k]
            for hp in hole_pieces:
                hm = poly_moments(hp)
                sgn = 1 if hm['M00'] > 0 else -1
                for k in totals:
                    cell_m[k] -= sgn * hm[k]
            area = cell_m['M00']
            if area <= 0:
                continue
            g = gray[r * w + c]
            for k in totals:
                totals[k] += g * cell_m[k]
            cells.append({
                'r': r, 'c': c, 'g': g,
                'area': str(area),
                'M00': str(cell_m['M00']),
                'M10': str(cell_m['M10']),
                'M01': str(cell_m['M01']),
                'M20': str(cell_m['M20']),
                'M02': str(cell_m['M02']),
                'M11': str(cell_m['M11']),
            })

    out = {'totals': {k: str(v) for k, v in totals.items()}, 'cells': cells}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == '__main__':
    main()
