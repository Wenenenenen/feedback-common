#!/usr/bin/env python3
"""Dump the box tree of an MP4 file (read-only inspection tool).

Usage: python -I box_dump.py <file.mp4>
"""
import struct
import sys

CONTAINERS = {
    "moov", "trak", "mdia", "minf", "stbl", "moof", "traf",
    "edts", "mvex", "dinf",
}


def read_boxes(f, end, depth=0):
    while f.tell() < end:
        start = f.tell()
        header = f.read(8)
        if len(header) < 8:
            raise SystemExit(f"truncated box header at {start}")
        size, btype = struct.unpack(">I4s", header)
        btype = btype.decode("latin1")
        hdr_len = 8
        if size == 1:
            ext = f.read(8)
            if len(ext) < 8:
                raise SystemExit(f"truncated largesize at {start}")
            size = struct.unpack(">Q", ext)[0]
            hdr_len = 16
        elif size == 0:
            size = end - start
        if start + size > end:
            raise SystemExit(f"box {btype} at {start} exceeds parent end {end}")
        print("  " * depth + f"{btype} @ {start} size={size}")
        if btype in CONTAINERS:
            read_boxes(f, start + size, depth + 1)
        f.seek(start + size)


def main():
    with open(sys.argv[1], "rb") as f:
        f.seek(0, 2)
        total = f.tell()
        f.seek(0)
        read_boxes(f, total)


if __name__ == "__main__":
    main()
