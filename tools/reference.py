#!/usr/bin/env python3
"""Independent reference implementation of the room early-reflection spec.

Uses Fraction for every geometric predicate (no float in geometry). Written
separately from app/engine.js so agreement is meaningful, not copied logic.
Run: python3 -I tools/reference.py
"""
import json
import sys
from fractions import Fraction
from pathlib import Path

WALL_AXIS = (0, 0, 1, 1, 2, 2)
WALL_SIGN = (0, 1, 0, 1, 0, 1)
NAMES = ('x0', 'x1', 'y0', 'y1', 'z0', 'z1')


def fold(x: Fraction, L: int) -> Fraction:
    p = 2 * L
    m = x % p
    return m if m <= L else p - m


def reflect(c, L, sign):
    return -c if sign == 0 else 2 * L - c


def sequences(order):
    out = [()]

    def dfs(seq):
        if len(seq) == order:
            return
        last = seq[-1] if seq else -1
        for w in range(6):
            if w == last:
                continue
            nxt = seq + (w,)
            out.append(nxt)
            dfs(nxt)

    dfs(())
    return out


def build(S, R, size, seq):
    img = list(R)
    for w in reversed(seq):
        a = WALL_AXIS[w]
        img[a] = reflect(img[a], size[a], WALL_SIGN[w])

    crosses = []  # (t, axis, cell)
    for a in range(3):
        L = size[a]
        sv, rv = S[a], img[a]
        dv = rv - sv
        if dv == 0:
            continue
        lo, hi = (sv, rv) if sv < rv else (rv, sv)
        # strict lo < m*L < hi
        import math
        m0 = math.floor(lo / L) + 1
        m1 = math.ceil(hi / L) - 1
        for m in range(m0, m1 + 1):
            crosses.append((Fraction(m * L - sv, dv), a, m))

    crosses.sort(key=lambda c: c[0])
    for i in range(1, len(crosses)):
        if crosses[i - 1][0] == crosses[i][0]:
            return None  # edge / corner hit

    actual = tuple(2 * a + (m % 2) for _, a, m in crosses)
    if actual != tuple(seq):
        return None

    verts = [tuple(Fraction(v) for v in S)]
    for t, axis, cell in crosses:
        v = []
        for a in range(3):
            if a == axis:
                v.append(fold(Fraction(cell * size[a]), size[a]))
            else:
                v.append(fold(Fraction(S[a]) + t * (img[a] - S[a]), size[a]))
        for a in range(3):
            if a != axis and not (0 < v[a] < size[a]):
                return None
        verts.append(tuple(v))
    verts.append(tuple(Fraction(v) for v in R))

    length = sum((img[a] - S[a]) ** 2 for a in range(3)) ** 0.5
    return verts, length


def slab(p: Fraction, d: Fraction, lo: int, hi: int):
    if d == 0:
        return (Fraction(0), Fraction(1)) if lo <= p <= hi else None
    t0 = (Fraction(lo) - p) / d
    t1 = (Fraction(hi) - p) / d
    if t0 > t1:
        t0, t1 = t1, t0
    if t1 < 0 or t0 > 1:
        return None
    return (max(t0, Fraction(0)), min(t1, Fraction(1)))


def blockage(verts, boxes):
    for s in range(len(verts) - 1):
        P, Q = verts[s], verts[s + 1]
        D = tuple(q - p for p, q in zip(P, Q))
        best = None
        for bi, b in enumerate(boxes):
            enter, exit_ = Fraction(0), Fraction(1)
            ok = True
            for a in range(3):
                iv = slab(P[a], D[a], b['min'][a], b['max'][a])
                if iv is None:
                    ok = False
                    break
                enter = max(enter, iv[0])
                exit_ = min(exit_, iv[1])
            if ok and enter <= exit_:
                if best is None or enter < best[1]:
                    best = (bi, enter)
        if best:
            return s, best[0]
    return None


def solve(room):
    size = room['size']
    boxes = [{'min': b['min'], 'max': b['max']} for b in room['boxes']]
    seqs = sequences(room['order'])
    result = {}
    for si, S in enumerate(room['sources']):
        for ri, R in enumerate(room['receivers']):
            rows = []
            for seq in seqs:
                built = build(S, R, size, seq)
                if built is None:
                    continue
                verts, length = built
                blk = blockage(verts, boxes)
                rows.append({
                    'walls': [NAMES[w] for w in seq],
                    'verts': [[str(x) for x in v] for v in verts],
                    'length': length,
                    'blocked': blk,
                })
            rows.sort(key=lambda r: r['length'])
            result[(si, ri)] = rows
    return result


if __name__ == '__main__':
    room_path = Path(__file__).resolve().parent.parent / 'samples' / 'extracted' / 'room.json'
    room = json.loads(room_path.read_text())
    res = solve(room)
    for key, rows in sorted(res.items()):
        print(key, len(rows), 'paths', sum(1 for r in rows if r['blocked']), 'blocked')
        for r in rows:
            print(' ', r['walls'], f"{r['length']:.4f}", r['blocked'])
