#!/usr/bin/env python3
"""Brute-force field layout inference for the synthetic PGS subset. Read-only. python3 -I tools/infer.py"""
import glob
import os

TYPES = {0x14: "PDS", 0x15: "WDS", 0x16: "PCS", 0x17: "ODS", 0x80: "END"}


def segments(path):
    data = open(path, "rb").read()
    off = 0
    while off + 13 <= len(data):
        pts = int.from_bytes(data[off + 2:off + 6], "big")
        stype = data[off + 10]
        slen = int.from_bytes(data[off + 11:off + 13], "big")
        yield off, stype, pts, data[off + 13:off + 13 + slen]
        off += 13 + slen


def rle_decode(buf, enforce_eol):
    """Standard PGS RLE. Returns (pixels_per_line, indices) or None."""
    lines = [[]]
    i = 0
    n = len(buf)
    while i < n:
        b = buf[i]
        if b != 0:
            lines[-1].append(b)
            i += 1
            continue
        if i + 1 >= n:
            return None
        b2 = buf[i + 1]
        if b2 == 0:
            lines.append([])
            i += 2
        elif b2 == 1:
            i += 2
            if i != n:
                return None
            lines = [l for l in lines if l is not None]
            return lines
        elif b2 == 2:
            if i + 3 >= n:
                return None
            run = (buf[i + 3] << 8) | buf[i + 2]
            lines[-1].extend([0] * run)
            i += 4
        else:
            lines[-1].extend([0] * b2)
            i += 2
    return None  # no EOB


def infer_ods(payload, name):
    print(f"  ODS {name} payload={payload.hex()}")
    found = []
    for h in range(4, 9):
        if h >= len(payload):
            continue
        rle = rle_decode(payload[h:], True)
        if rle is None:
            rle = rle_decode(payload[h:], False)
        if rle is None:
            continue
        total = sum(len(l) for l in rle)
        widths = {len(l) for l in rle}
        for ws in range(1, 3):
            for hs in range(1, 3):
                for wi in range(0, h - ws):
                    hi = wi + ws
                    if hi + hs > h:
                        continue
                    for endian in ("big", "little"):
                        w = int.from_bytes(payload[wi:wi + ws], endian)
                        hh = int.from_bytes(payload[hi:hi + hs], endian)
                        if w > 0 and hh > 0 and w * hh == total and widths <= {w}:
                            found.append((h, wi, ws, hi, hs, endian, w, hh, total, rle))
    for f in found:
        print("   MATCH header=%d W@%d(%d,%s) H@%d(%d) -> %dx%d pixels=%d lines=%s"
              % (f[0], f[1], f[2], f[5], f[3], f[4], f[6], f[7], f[8], f[9]))
    if not found:
        print("    no exact match; dumping all RLE attempts:")
        for h in range(4, 9):
            r = rle_decode(payload[h:], True) or rle_decode(payload[h:], False)
            if r is not None:
                print(f"      hdr={h} lines={r}")


def infer_wds(payload):
    print(f"  WDS payload={payload.hex()}")
    # enumerate: id width 1/2 at offset0, then 4 rect fields each u8/u16 BE/LE at every start
    for idw in (1, 2):
        for endian in ("big", "little"):
            wid = int.from_bytes(payload[0:idw], endian)
            rest = payload[idw:]
            for rw in (1, 2):
                # fields packed, possibly 1 flag byte somewhere: try raw packed 4 fields first
                if len(rest) == 4 * rw:
                    vals = [int.from_bytes(rest[i:i + rw], endian) for i in range(0, len(rest), rw)]
                    x, y, w, h = vals
                    if w and h and x + w <= 128 and y + h <= 64:
                        print(f"   MATCH id={wid} ({idw}B {endian}) rect u{rw*8} {endian}: x={x} y={y} w={w} h={h}")
            # try with a 1-byte flag after id
            if len(rest) - 1 >= 8:
                flag = rest[0]
                body = rest[1:]
                for rw in (1, 2):
                    if len(body) >= 4 * rw:
                        vals = [int.from_bytes(body[i:i + rw], endian) for i in range(0, 4 * rw, rw)]
                        x, y, w, h = vals
                        if w and h and x + w <= 128 and y + h <= 64:
                            print(f"   MATCH id={wid} flag=0x{flag:02x} rect u{rw*8} {endian}: x={x} y={y} w={w} h={h} tail={body[4*rw:].hex()}")
                # flag after rect
                tail_len = len(body)
                for rw in (1, 2):
                    if tail_len - 1 >= 4 * rw:
                        vals = [int.from_bytes(body[i:i + rw], endian) for i in range(0, 4 * rw, rw)]
                        x, y, w, h = vals
                        if w and h and x + w <= 128 and y + h <= 64:
                            print(f"   MATCH id={wid} rect u{rw*8} {endian}: x={x} y={y} w={w} h={h} flag/tail=0x{body[4*rw:].hex()}")


for path in sorted(glob.glob("samples/extracted/*.sup")):
    print("=== ", os.path.basename(path))
    for off, stype, pts, pl in segments(path):
        if stype == 0x17:
            infer_ods(pl, f"@0x{off:x}")
        elif stype == 0x15:
            infer_wds(pl)
