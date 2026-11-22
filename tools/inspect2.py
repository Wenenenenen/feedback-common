#!/usr/bin/env python3
"""Fixed PES PTS decode + per-packet PSI section decode + byte-level dup analysis."""
import sys


def crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def pts_from(b, i):
    return (((b[i] >> 1) & 7) << 30) | (b[i + 1] << 22) | (((b[i + 2] >> 1) & 0x7F) << 15) | \
           (b[i + 3] << 7) | ((b[i + 4] >> 1) & 0x7F)


def parse_pes(payload: bytes):
    if len(payload) < 9 or payload[0:3] != b"\x00\x00\x01":
        return None
    sid = payload[3]
    pts_dts = payload[7] >> 6
    hdr_len = payload[8]
    pts = dts = None
    p = 9
    if pts_dts in (2, 3) and p + 5 <= len(payload):
        pts = pts_from(payload, p)
        p += 5
        if pts_dts == 3 and p + 5 <= len(payload):
            dts = pts_from(payload, p)
    return {"stream_id": sid, "pts_dts_flags": pts_dts, "hdr_len": hdr_len, "pts": pts, "dts": dts}


def parse(path: str) -> None:
    raw = open(path, "rb").read()
    start = raw.find(0x47)
    print(f"=== {path.split('/')[-1]} ({len(raw)} bytes, sync@{start}) ===")
    off = start
    idx = 0
    prev_by_pid = {}
    while off + 188 <= len(raw):
        c = raw[off:off + 188]
        pid = ((c[1] & 0x1F) << 8) | c[2]
        pusi = (c[1] >> 6) & 1
        afc = (c[3] >> 4) & 3
        cc = c[3] & 0x0F
        pstart = 4 + (1 + c[4] if (afc & 0x2) else 0)
        payload = c[pstart:] if (afc & 0x1) else b""
        pes = parse_pes(payload) if (pusi and payload) else None
        notes = []
        if pes:
            notes.append(f"PES sid=0x{pes['stream_id']:02x} flags={pes['pts_dts_flags']} PTS={pes['pts']} DTS={pes['dts']}")
        # per-packet PSI (pusi sections)
        if pusi and payload and pid in (0, 256):
            pp = payload[0]
            s = 1 + pp
            if s + 3 <= len(payload) and payload[s] != 0xFF:
                tid = payload[s]
                slen = ((payload[s + 1] & 0x0F) << 8) | payload[s + 2]
                sec = payload[s:s + 3 + slen]
                if len(sec) == 3 + slen:
                    ok = crc32_mpeg(sec[:-4]) == int.from_bytes(sec[-4:], "big")
                    ver = sec[5] >> 1
                    notes.append(f"PSI tid=0x{tid:02x} ver={ver} len={slen} CRC={'OK' if ok else 'BAD'}")
                    if ok and tid == 0x02:
                        pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9]
                        pil = ((sec[10] & 0x0F) << 8) | sec[11]
                        j = 12 + pil
                        streams = []
                        while j < len(sec) - 4:
                            streams.append((sec[j], ((sec[j + 1] & 0x1F) << 8) | sec[j + 2]))
                            j += 5 + (((sec[j + 3] & 0x0F) << 8) | sec[j + 4])
                        notes.append(f"PMT pcr_pid={pcr_pid} streams={streams}")
                    if ok and tid == 0x00:
                        progs = []
                        j = 8
                        while j < len(sec) - 4 - 4:
                            progs.append(((sec[j] << 8) | sec[j + 1], ((sec[j + 2] & 0x1F) << 8) | sec[j + 3]))
                            j += 4
                        notes.append(f"PAT programs={progs}")
        # dup analysis vs previous packet of same PID
        if pid in prev_by_pid:
            pidx, pcc, pbytes = prev_by_pid[pid]
            if pcc == cc:
                kind = "EXACT-DUP" if pbytes == c else "SAME-CC-DIFF-CONTENT"
                notes.append(f"{kind} (vs #{pidx})")
        prev_by_pid[pid] = (idx, cc, bytes(c))
        print(f"#{idx:2d} PID={pid:4d} afc={afc} cc={cc:X} " + " | ".join(notes))
        off += 188
        idx += 1
    print()


for p in sys.argv[1:]:
    parse(p)
