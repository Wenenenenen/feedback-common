#!/usr/bin/env python3
"""Read-only segment walker for the synthetic PGS subset. Run with: python3 -I tools/dump.py <file.sup>"""
import sys

TYPES = {0x14: "PDS", 0x15: "WDS", 0x16: "PCS", 0x17: "ODS", 0x80: "END"}


def walk(path):
    data = open(path, "rb").read()
    off = 0
    idx = 0
    while off + 13 <= len(data):
        magic = data[off:off + 2]
        if magic != b"PG":
            print(f"[{idx}] offset=0x{off:x} BAD MAGIC {magic.hex()}")
            return
        pts = int.from_bytes(data[off + 2:off + 6], "big")
        dts = int.from_bytes(data[off + 6:off + 10], "big")
        stype = data[off + 10]
        slen = int.from_bytes(data[off + 11:off + 13], "big")
        payload = data[off + 13:off + 13 + slen]
        name = TYPES.get(stype, f"0x{stype:02x}")
        print(f"[{idx}] off=0x{off:<6x} {name:3s} pts={pts:>6} dts={dts:>6} len={slen:>3} payload={payload.hex()}")
        off += 13 + slen
        idx += 1
    print(f"end=0x{off:x} file_size={len(data)} trailing={len(data) - off}")


if __name__ == "__main__":
    walk(sys.argv[1])
