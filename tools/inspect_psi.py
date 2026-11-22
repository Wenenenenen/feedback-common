#!/usr/bin/env python3
"""Deeper PSI/PES inspection of sample TS files (throwaway analysis tool)."""
import sys


def crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def split_sections(buf: bytes):
    """Walk a reassembled PSI buffer and yield (pointer_looped, section_bytes, crc_ok)."""
    out = []
    i = 0
    if not buf:
        return out
    pptr = buf[0]
    i = 1 + pptr
    while i + 3 <= len(buf):
        if buf[i] == 0xFF:
            break
        table_id = buf[i]
        sec_len = ((buf[i + 1] & 0x0F) << 8) | buf[i + 2]
        end = i + 3 + sec_len
        if end > len(buf):
            out.append((table_id, buf[i:], None, "truncated"))
            break
        sec = buf[i:end]
        crc_calc = crc32_mpeg(sec[:-4])
        crc_got = int.from_bytes(sec[-4:], "big")
        out.append((table_id, sec, crc_calc == crc_got, f"calc={crc_calc:08x} got={crc_got:08x}"))
        i = end
    return out


def parse_pes(payload: bytes):
    if len(payload) < 9 or payload[0:3] != b"\x00\x00\x01":
        return None
    sid = payload[3]
    flags1 = payload[7]
    hdr_len = payload[8]
    pts = dts = None
    p = 9
    if hdr_len > 0 and p + 3 <= len(payload):
        pts_dts = payload[p] >> 6
        if pts_dts in (2, 3):
            pts = (((payload[p] >> 1) & 7) << 30) | (payload[p + 1] << 22) | \
                  (((payload[p + 2] >> 1) & 0x7F) << 15) | (payload[p + 3] << 7) | \
                  ((payload[p + 4] >> 1) & 0x7F)
            p += 5
            if pts_dts == 3 and p + 4 < len(payload):
                dts = (((payload[p] >> 1) & 7) << 30) | (payload[p + 1] << 22) | \
                      (((payload[p + 2] >> 1) & 0x7F) << 15) | (payload[p + 3] << 7) | \
                      ((payload[p + 4] >> 1) & 0x7F)
    return {"stream_id": sid, "hdr_len": hdr_len, "pts": pts, "dts": dts,
            "first16": payload[:16].hex()}


def parse(path: str) -> None:
    raw = open(path, "rb").read()
    start = raw.find(0x47)
    print(f"=== {path.split('/')[-1]} ({len(raw)} bytes, sync@{start}) ===")
    off = start
    idx = 0
    psi = {}  # pid -> byte buffer (payload units)
    while off + 188 <= len(raw):
        c = raw[off:off + 188]
        pid = ((c[1] & 0x1F) << 8) | c[2]
        pusi = (c[1] >> 6) & 1
        afc = (c[3] >> 4) & 3
        cc = c[3] & 0x0F
        payload = b""
        if afc & 0x1:
            pstart = 4
            if afc & 0x2:
                pstart = 5 + c[4]
            payload = c[pstart:]
        # PSI collection
        if pid in (0, 1) or (0x100 <= pid <= 0x1FF):
            psi.setdefault(pid, {})
            bucket = psi[pid]
            if pusi:
                bucket["buf"] = bytearray(payload)
                bucket["start_pkt"] = idx
            elif "buf" in bucket:
                bucket["buf"] += payload
        # PES
        pes = parse_pes(payload) if (pusi and payload) else None
        note = ""
        if pes:
            note = f"PES sid=0x{pes['stream_id']:02x} pts={pes['pts']} dts={pes['dts']} hdr={pes['hdr_len']} {pes['first16']}"
        print(f"#{idx:2d} PID={pid:4d} pusi={pusi} afc={afc} cc={cc:X} plen={len(payload):3d} {note}")
        off += 188
        idx += 1
    if off < len(raw):
        print(f"trailing {len(raw) - off} bytes: {raw[off:off+8].hex()}")
    print("-- PSI reassembly --")
    for pid, b in sorted(psi.items()):
        for table_id, sec, ok, detail in split_sections(bytes(b["buf"])):
            print(f"PID {pid} (start pkt #{b['start_pkt']}) table_id=0x{table_id:02x} sec_len={len(sec)} CRC={'OK' if ok else 'BAD'} {detail}")
            if ok and table_id == 0x00:
                tsid = (sec[3] << 8) | sec[4]
                ver = sec[5] >> 1
                cni = sec[5] & 1
                seg = sec[8]
                last = sec[9]
                print(f"   PAT tsid={tsid} ver={ver} cni={cni} section={seg}/{last}")
                j = 8
                while j < len(sec) - 4 - 4:
                    prog = (sec[j] << 8) | sec[j + 1]
                    p = ((sec[j + 2] & 0x1F) << 8) | sec[j + 3]
                    print(f"   program {prog} -> PID {p}")
                    j += 4
            elif ok and table_id == 0x02:
                pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9]
                pi_len = ((sec[10] & 0x0F) << 8) | sec[11]
                print(f"   PMT pcr_pid={pcr_pid} pinfo_len={pi_len} ver={sec[5] >> 1}")
                j = 12 + pi_len
                while j < len(sec) - 4:
                    stype = sec[j]
                    spid = ((sec[j + 1] & 0x1F) << 8) | sec[j + 2]
                    es_len = ((sec[j + 3] & 0x0F) << 8) | sec[j + 4]
                    print(f"   stream type=0x{stype:02x} PID={spid} es_info_len={es_len}")
                    j += 5 + es_len
    print()


for p in sys.argv[1:]:
    parse(p)
