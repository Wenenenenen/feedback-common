#!/usr/bin/env python3
"""Constraint solver: locate W,H / rect fields inside synthetic ODS & WDS payloads.
Read-only. python3 -I tools/solve.py"""

CANVAS_W, CANVAS_H = 128, 64

ODS1 = bytes.fromhex("01000002000100020002")
ODS2 = bytes.fromhex("01000000000000460001")
WDS = [
    ("e0w1 f=80", bytes.fromhex("0007008000001100040002010100")),
    ("e0w2 f=40", bytes.fromhex("0007004001020000020102010000")),
    ("e0w3 f=c0", bytes.fromhex("000800c0000009000200010082020000")),
    ("e4w  f=c0", bytes.fromhex("000700c000000a0046000100c046010000")),
]


def rle_variants(buf):
    """Return dict variant_name -> list of lines (list of palette idx)."""
    out = {}
    # V1 standard: 0000 EOL, 0001 EOB, 00 NN run8, 0002 LL HH run16, else pixel
    for name, eol, eob in (("std", 0, 1), ("swap", 1, 0)):
        lines = [[]]
        i = 0
        ok = True
        while i < len(buf):
            b = buf[i]
            if b != 0:
                lines[-1].append(b)
                i += 1
                continue
            if i + 1 >= len(buf):
                ok = False
                break
            b2 = buf[i + 1]
            if b2 == eol:
                lines.append([])
                i += 2
            elif b2 == eob:
                i += 2
                if i != len(buf):
                    ok = False
                break
            elif b2 == 2:
                if i + 3 >= len(buf):
                    ok = False
                    break
                run = buf[i + 2] | (buf[i + 3] << 8)
                lines[-1].extend([0] * run)
                i += 4
            else:
                lines[-1].extend([0] * b2)
                i += 2
        if ok:
            out[name] = [l for l in lines]
    # V3: implicit end (no EOB needed); 0000 EOL only
    lines = [[]]
    i = 0
    ok = True
    while i < len(buf):
        b = buf[i]
        if b != 0:
            lines[-1].append(b)
            i += 1
            continue
        if i + 1 >= len(buf):
            ok = False
            break
        b2 = buf[i + 1]
        if b2 == 0:
            lines.append([])
            i += 2
        elif b2 == 1:  # tolerate EOB
            i += 2
            if i != len(buf):
                ok = False
                break
        elif b2 == 2:
            if i + 3 >= len(buf):
                ok = False
                break
            run = buf[i + 2] | (buf[i + 3] << 8)
            lines[-1].extend([0] * run)
            i += 4
        else:
            lines[-1].extend([0] * b2)
            i += 2
    if ok:
        out["implicit"] = lines
    return out


print("=== ODS RLE scan: every start offset, every variant ===")
for tag, pl in (("ODS1", ODS1), ("ODS2", ODS2)):
    print(tag, pl.hex())
    for start in range(2, len(pl)):
        for name, lines in rle_variants(pl[start:]).items():
            total = sum(len(l) for l in lines)
            widths = {len(l) for l in lines}
            print(f"  start={start} {name:8s} lines={lines} total={total} linewidths={widths}")

print("\n=== ODS header field search: (W at i, H at j), u8/u16 BE/LE, must match a decoded pixel count ===")
for tag, pl in (("ODS1", ODS1), ("ODS2", ODS2)):
    counts = set()
    for start in range(2, len(pl)):
        for lines in rle_variants(pl[start:]).values():
            counts.add(sum(len(l) for l in lines))
    hits = []
    for i in range(0, len(pl) - 1):
        for j in range(0, len(pl) - 1):
            if i == j:
                continue
            for size in (1, 2):
                if max(i, j) + size > len(pl):
                    continue
                for endian in ("big", "little"):
                    w = int.from_bytes(pl[i:i + size], endian)
                    h = int.from_bytes(pl[j:j + size], endian)
                    if 1 <= w <= CANVAS_W and 1 <= h <= CANVAS_H and w * h in counts:
                        hits.append((i, j, size, endian, w, h, w * h))
    print(tag, "pixel-counts:", sorted(c for c in counts if c))
    for hit in sorted(set(hits)):
        print("  W@%d H@%d u%d %s -> %dx%d = %d" % (hit[0], hit[1], hit[2] * 8, hit[3], hit[4], hit[5], hit[6]))

print("\n=== WDS rect search after 4-byte (id16,flags16) prefix ===")
for tag, pl in WDS:
    print(tag, pl.hex())
    body = pl[4:]
    for size in (1, 2):
        for endian in ("big", "little"):
            # consecutive packed fields
            if len(body) >= 4 * size:
                vals = [int.from_bytes(body[k:k + size], endian) for k in range(0, 4 * size, size)]
                x, y, w, h = vals
                if w and h and x + w <= CANVAS_W and y + h <= CANVAS_H:
                    print(f"  packed u{size*8} {endian}: x={x} y={y} w={w} h={h} tail={body[4*size:].hex()}")
            # sliding window for 4 consecutive fields
            for base in range(0, len(body) - 4 * size + 1):
                vals = [int.from_bytes(body[base + k:base + k + size], endian) for k in range(0, 4 * size, size)]
                x, y, w, h = vals
                if w and h and x + w <= CANVAS_W and y + h <= CANVAS_H and not (x == 0 and y == 0 and w == 1):
                    print(f"  base={base} u{size*8} {endian}: x={x} y={y} w={w} h={h}")
