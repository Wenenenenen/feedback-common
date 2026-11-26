#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate binary PDQ fixtures + an independent-expected manifest.

Outputs:
  test/fixtures/<name>.pdq + <name>.expected.json   named scenarios
  test/vectors/manifest.json                          many randomized cases

Run: python3 -I tools/gen_fixtures.py
"""
import os
import sys
import json
import base64
import struct
import zlib
import random

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import pdq_reference as R  # noqa: E402

FIX = os.path.join(ROOT, "test", "fixtures")
VEC = os.path.join(ROOT, "test", "vectors")
os.makedirs(FIX, exist_ok=True)
os.makedirs(VEC, exist_ok=True)


def pack_record(anchor, rel_start, count, mask, bitfn, crc_mode="ok"):
    nset = bin(mask).count("1")
    bits = []
    for t in range(count):
        for r, ch in enumerate([c for c in range(8) if (mask >> c) & 1]):
            bits.append(int(bitfn(t, ch, r)))
    plen = (len(bits) + 7) // 8
    payload = bytearray(plen)
    for i, b in enumerate(bits):
        payload[i >> 3] |= (b & 1) << (i & 7)
    ts = (anchor + rel_start) & 0xFFFFFFFF
    head = struct.pack("<IHB", ts, count, mask)
    rec = bytearray(head + bytes(payload))
    crc = zlib.crc32(bytes(rec)) & 0xFFFFFFFF
    if crc_mode == "bad":
        crc ^= 0xDEADBEEF
    elif crc_mode == "flip":
        # flip one payload bit but keep a stale (now wrong) crc
        if plen:
            rec[7] ^= 0x01
    rec += struct.pack("<I", crc)
    return bytes(rec)


def build_file(anchor, total, ch, D, records, magic=b"PDQ1", header_extra=None):
    out = bytearray(magic + struct.pack("<IIBB", anchor & 0xFFFFFFFF, total, ch, D))
    for rec in records:
        out += rec
    if header_extra:
        out += header_extra
    return bytes(out)


def expected_for(data):
    res = R.decode_all(data)
    p = res["parse"]
    return {
        "header": {k: p.get(k) for k in ("anchor", "totalTicks", "channels", "D", "headerOk", "headerError")},
        "truncated": p["truncated"],
        "recordCount": len(p["records"]),
        "badCrc": [r["index"] for r in p["records"] if not r["crcOk"]],
        "adopted": [r["adopted"] for r in p["records"]],
        "recordOffsets": [r["offset"] for r in p["records"]],
        "pcm": res.get("pcm"),
        "affected": res.get("affected"),
        "intervals": res.get("intervals"),
        "frames": res.get("frames"),
    }


def write_named(name, data):
    with open(os.path.join(FIX, name + ".pdq"), "wb") as f:
        f.write(data)
    with open(os.path.join(FIX, name + ".expected.json"), "w", encoding="utf-8") as f:
        json.dump(expected_for(data), f, ensure_ascii=False)
    print("fixture", name, len(data), "bytes")


# ---------------------------------------------------------------------------
# Named scenarios
# ---------------------------------------------------------------------------

def named_cases():
    # 1) holes, 4ch D64, strategic single holes + runs crossing packet bounds
    D = 64
    total = D * 8  # 8 frames, 512 ticks
    anchor = 0x12345679  # odd anchor -> non trivial absolute phase

    def bits_good(t, ch, r):
        return ((t * 7 + ch * 13 + (t // D)) % 5) < 2

    # record A: ticks 0..255 all ch ; record B: 256..511 all ch, but we will
    # craft holes by NOT covering selected ticks via narrower records is hard
    # (records are dense rectangles). Instead build dense records then overlay
    # is additive only; to leave holes we simply make records cover subranges.
    recs = []
    # cover 0..199 all channels
    recs.append(pack_record(anchor, 0, 200, 0x0F, bits_good))
    # cover 205..300 (hole 200..204) all channels
    recs.append(pack_record(anchor, 205, 96, 0x0F, bits_good))
    # per-channel tails to create channel-specific holes
    for ch in range(4):
        start = 301 + ch * 3
        recs.append(pack_record(anchor, start, total - start, 1 << ch, bits_good))
    data = build_file(anchor, total, 4, D, recs)
    write_named("holes-4ch-d64", data)

    # 2) bad crc must not overwrite a good packet; later good retransmit wins
    D2 = 32
    total2 = D2 * 6
    a2 = 0xFFFFFFF4  # near wrap, even? F4 -> even
    recs2 = []
    # good base covering all, bit pattern 0
    recs2.append(pack_record(a2, 0, total2, 0x03, lambda t, c, r: 0))
    # bad-crc retransmit trying to set pattern 1 (must be discarded -> stays 0)
    recs2.append(pack_record(a2, 10, 40, 0x03, lambda t, c, r: 1, crc_mode="bad"))
    # flipped-payload record (crc stale) also discarded
    recs2.append(pack_record(a2, 60, 20, 0x03, lambda t, c, r: 1, crc_mode="flip"))
    # good retransmit at 12..30 sets 1 -> last good wins there
    recs2.append(pack_record(a2, 12, 18, 0x03, lambda t, c, r: 1))
    write_named("bad-crc-overwrite", build_file(a2, total2, 2, D2, recs2))

    # 3) out-of-timestamp-order overlap + wrap
    D3 = 64
    total3 = D3 * 4
    a3 = 0xFFFFFFF0
    recs3 = []
    # late file record covers start 128..255 first in file with zeros
    recs3.append(pack_record(a3, 128, 128, 0x01, lambda t, c, r: 0))
    # earlier time range but later in file, overlaps 128..200 with ones -> wins
    recs3.append(pack_record(a3, 64, 137, 0x01, lambda t, c, r: 1))  # 64..200
    write_named("overlap-outoforder", build_file(a3, total3, 1, D3, recs3))

    # 4) rounding tie search for D64: find a fully covered grid with a tie
    tie_data = find_tie_case()
    write_named("tie-rounding-d64", tie_data)

    # 5) truncation variants of the holes file
    full_holes = open(os.path.join(FIX, "holes-4ch-d64.pdq"), "rb").read()
    # cut exactly at start of last record: find its offset from expected
    exp = expected_for(full_holes)
    last_off = exp["recordOffsets"][-1]
    write_named("trunc-midbody", full_holes[: last_off + 5])   # 5 bytes into record
    write_named("trunc-header", full_holes[: last_off + 3])   # partial 7-byte head
    write_named("trunc-atrecord", full_holes[:last_off])      # boundary: no partial
    write_named("trunc-onebyte", full_holes[:-3])             # cut CRC short

    # 6) demo copy as a named fixture
    demo_src = os.path.join(ROOT, "samples", "demo.pdq")
    if os.path.exists(demo_src):
        write_named("demo", open(demo_src, "rb").read())


def find_tie_case():
    D = 64
    total = D * 3
    anchor = 0
    rng = random.Random(20240521)
    for _ in range(4000):
        bits = [rng.randrange(2) for _ in range(total)]
        # one dense mono record
        data = build_file(anchor, total, 1, D, [
            pack_record(anchor, 0, total, 0x01, lambda t, c, r, b=bits: b[t])
        ])
        res = R.decode_all(data)
        pcm = res["pcm"][0]
        sums = None
        # recompute sums to detect exact half ties
        grid = R.build_channel_grid(data, res["parse"], 0)
        _, _, sums = R.decimate_channel(grid, anchor, D)
        if any((abs(s) % 8) == 4 for s in sums):
            return data
    # fallback: return any (unit tests still cover tie function directly)
    return build_file(anchor, total, 1, D, [
        pack_record(anchor, 0, total, 0x01, lambda t, c, r: (t // 40) & 1)
    ])


# ---------------------------------------------------------------------------
# Randomized manifest
# ---------------------------------------------------------------------------

def random_manifest(n=400):
    rng = random.Random(987654321)
    cases = []
    for ci in range(n):
        D = rng.choice([32, 64])
        C = rng.choice([1, 1, 2, 2, 4])
        nframes = rng.randint(2, 10)
        total = D * nframes
        anchor = rng.choice([0, 1, 0xFFFFFFF0, 0xFFFFFFFF, rng.randrange(1 << 32)])
        nrec = rng.randint(1, 14)
        recs = []
        for _ in range(nrec):
            # sometimes legal in-range, occasionally push boundaries
            cnt = rng.randint(1, max(2, D * 3))
            rel = rng.randint(0, max(0, total - 1))
            if rel + cnt > total:
                cnt = max(1, total - rel)
            if cnt <= 0:
                rel = 0
                cnt = rng.randint(1, min(D, total))
            mask = rng.randint(1, (1 << C) - 1)
            mode = rng.random()
            crc_mode = "ok"
            if mode < 0.12:
                crc_mode = "bad"
            elif mode < 0.18:
                crc_mode = "flip"

            def fn(t, ch, r, seed=ci * 100000 + len(recs) * 7919):
                v = (t * 1103515245 + ch * 12345 + seed) & 0x7fffffff
                return (v >> 16) & 1
            recs.append(pack_record(anchor, rel, cnt, mask, fn, crc_mode))
        data = build_file(anchor, total, C, D, recs)

        # 15% truncate at a random point after header
        trunc = rng.random() < 0.18
        if trunc and len(data) > 20:
            cut = rng.randint(14, len(data) - 1)
            data = data[:cut]

        exp = expected_for(data)
        cases.append({
            "name": "rand-%04d" % ci,
            "pdqBase64": base64.b64encode(data).decode("ascii"),
            "expected": exp,
        })
    with open(os.path.join(VEC, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f)
    print("manifest", len(cases), "random cases")


if __name__ == "__main__":
    named_cases()
    random_manifest()
