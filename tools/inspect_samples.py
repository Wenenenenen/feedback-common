#!/usr/bin/env python3
"""Throwaway analyzer for understanding the sample TS files (not part of the app)."""
import sys


def crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            if crc & 0x80000000:
                crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFFFF
    return crc


def parse(path: str) -> None:
    with open(path, "rb") as f:
        raw = f.read()
    print(f"=== {path}  total {len(raw)} bytes ===")
    # find first sync byte
    start = raw.find(0x47)
    print(f"first sync at offset {start}")
    off = start
    idx = 0
    while off < len(raw):
        chunk = raw[off:off + 188]
        if len(chunk) < 188:
            print(f"packet #{idx} offset {off}: trailing partial packet, {len(chunk)} bytes, starts {chunk[:4].hex()}")
            break
        if chunk[0] != 0x47:
            print(f"packet #{idx} offset {off}: NO SYNC byte {chunk[0]:#x}")
            break
        tei = (chunk[1] >> 7) & 1
        pusi = (chunk[1] >> 6) & 1
        prio = (chunk[1] >> 5) & 1
        pid = ((chunk[1] & 0x1F) << 8) | chunk[2]
        tsc = (chunk[3] >> 6) & 3
        afc = (chunk[3] >> 4) & 3
        cc = chunk[3] & 0x0F
        line = f"#{idx:3d} off={off:6d} PID={pid:5d} pusi={pusi} afc={afc} cc={cc:X} tsc={tsc} tei={tei}"
        if afc & 0x2:  # adaptation field
            aflen = chunk[4]
            flags = chunk[5] if aflen > 0 else 0
            disc = (flags >> 7) & 1
            rai = (flags >> 6) & 1
            pcrflag = (flags >> 4) & 1
            line += f" aflen={aflen} disc={disc} rai={rai} pcr={pcrflag}"
            if pcrflag and aflen >= 7:
                base = ((chunk[6] << 25) | (chunk[7] << 17) | (chunk[8] << 9) |
                        (chunk[9] << 1) | (chunk[10] >> 7))
                ext = ((chunk[10] & 1) << 8) | chunk[11]
                pcr27 = base * 300 + ext
                line += f" PCR_base={base} ext={ext} pcr27={pcr27}"
        if pid in (0, 1, 256, 257, 258) or pusi:
            line += "  " + chunk[:16].hex()
        print(line)
        off += 188
        idx += 1
    print()


for p in sys.argv[1:]:
    parse(p)
