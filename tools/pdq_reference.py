#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Independent reference implementation for the PDQ1 / PDM-decimation reel.

This module is deliberately written from 约定.txt only, and is used as the
oracle that the JavaScript engine is cross-checked against.

All integers little-endian. See 约定.txt for the normative rules.

CLI:
    python3 pdq_reference.py <file.pdq> [out.json] [--pcm out.pcm]

It prints / writes a JSON object with records, truncation info, per-channel
PCM (post rounding+clamp), per-frame affected flags and maximal half-open
affected frame intervals.
"""
import struct
import zlib
import json
import sys
import os

MAGIC = b"PDQ1"
HEADER_LEN = 14
RECORD_HEAD_LEN = 7
CRC_LEN = 4


def crc32_ieee(buf, start=0, end=None):
    if end is None:
        end = len(buf)
    return zlib.crc32(memoryview(buf)[start:end]) & 0xFFFFFFFF


def round_half_even_div(num, den):
    """round(num/den) to nearest, ties to even. den>0, num any int."""
    if den <= 0:
        raise ValueError("den must be positive")
    if num < 0:
        return -round_half_even_div(-num, den)
    q, r = divmod(num, den)
    twice = 2 * r
    if twice < den:
        return q
    if twice > den:
        return q + 1
    # exact tie -> choose the even neighbour (q and q+1)
    return q if (q & 1) == 0 else q + 1


def parse(data):
    """Parse header + walk records. Does not decode audio.

    Returns a dict. Never raises on malformed/truncated input; structural
    problems are recorded. `records` contains every fully-present record in
    file order with crc/legal/adopted flags. `truncated` describes the first
    record whose declared bytes are not fully present.
    """
    out = {
        "headerOk": False,
        "headerError": None,
        "anchor": None,
        "totalTicks": None,
        "channels": None,
        "D": None,
        "fileSize": len(data),
        "records": [],
        "truncated": None,
        "trailingBytes": 0,
    }
    if len(data) < HEADER_LEN:
        out["headerError"] = (
            "header-truncated: need %d bytes, have %d" % (HEADER_LEN, len(data))
        )
        # The record area would start at offset 14; point at EOF/14.
        out["truncated"] = {
            "recordIndex": 0,
            "offset": min(len(data), HEADER_LEN),
            "have": len(data),
            "need": HEADER_LEN,
            "stage": "header",
        }
        return out
    if data[0:4] != MAGIC:
        out["headerError"] = "bad-magic: expected PDQ1, got %r" % (data[0:4],)
        return out
    anchor, total_ticks, channels, D = struct.unpack_from("<IIBB", data, 4)
    out.update(
        anchor=anchor,
        totalTicks=total_ticks,
        channels=channels,
        D=D,
    )
    problems = []
    if D not in (32, 64):
        problems.append("D-not-32-or-64")
    if total_ticks <= 0:
        problems.append("totalTicks-not-positive")
    elif D in (32, 64) and total_ticks % D != 0:
        problems.append("totalTicks-not-multiple-of-D")
    if channels < 1 or channels > 8:
        problems.append("channels-out-of-range-1..8")
    out["headerProblems"] = problems
    out["headerOk"] = len(problems) == 0

    size = len(data)
    p = HEADER_LEN
    idx = 0
    while True:
        if p == size:
            break
        if size - p < RECORD_HEAD_LEN:
            out["truncated"] = {
                "recordIndex": idx,
                "offset": p,
                "have": size - p,
                "need": RECORD_HEAD_LEN,
                "stage": "record-header",
            }
            out["trailingBytes"] = size - p
            break
        start_ts, count, mask = struct.unpack_from("<IHB", data, p)
        nset = bin(mask).count("1")
        payload_bits = count * nset
        payload_len = (payload_bits + 7) // 8
        total_len = RECORD_HEAD_LEN + payload_len + CRC_LEN
        if size - p < total_len:
            out["truncated"] = {
                "recordIndex": idx,
                "offset": p,
                "have": size - p,
                "need": total_len,
                "stage": "record-body",
                "declaredCount": count,
                "declaredMask": mask,
                "payloadLength": payload_len,
            }
            out["trailingBytes"] = size - p
            break

        crc_stored = struct.unpack_from("<I", data, p + RECORD_HEAD_LEN + payload_len)[0]
        crc_calc = crc32_ieee(data, p, p + RECORD_HEAD_LEN + payload_len)
        crc_ok = crc_stored == crc_calc

        rel = ((start_ts - anchor) & 0xFFFFFFFF) if anchor is not None else None
        legal = True
        errors = []
        if count == 0:
            legal = False
            errors.append("zero-count")
        if mask == 0:
            legal = False
            errors.append("zero-mask")
        if channels is not None and channels <= 8:
            high = mask & ~((1 << channels) - 1)
            if high:
                legal = False
                errors.append("mask-bit-beyond-channels:0x%02x" % high)
        if rel is not None and total_ticks is not None:
            # rel is unsigned mod 2^32; range check rel+count <= totalTicks
            if count and rel + count > total_ticks:
                legal = False
                errors.append(
                    "record-out-of-range: rel=%d count=%d end=%d total=%d"
                    % (rel, count, rel + count, total_ticks)
                )

        adopted = bool(crc_ok and legal and out["headerOk"])
        out["records"].append(
            {
                "index": idx,
                "offset": p,
                "startTimestamp": start_ts,
                "relStart": rel,
                "count": count,
                "mask": mask,
                "channelRanks": [b for b in range(8) if (mask >> b) & 1],
                "payloadBits": payload_bits,
                "payloadLength": payload_len,
                "crcStored": crc_stored,
                "crcCalc": crc_calc,
                "crcOk": crc_ok,
                "legal": legal,
                "errors": errors,
                "adopted": adopted,
            }
        )
        p += total_len
        idx += 1

    out["consumedBytes"] = p
    return out


def bit_at(data, rec, bit_index):
    payload_start = rec["offset"] + RECORD_HEAD_LEN
    byte = data[payload_start + (bit_index >> 3)]
    return (byte >> (bit_index & 7)) & 1


def build_channel_grid(data, parsed, ch):
    """Return Int8 list-like of length totalTicks: 0 = missing, +1/-1 = real."""
    T = parsed["totalTicks"]
    grid = bytearray(T)  # we store codes: 0 missing, 2 -> -1, 3 -> +1
    for rec in parsed["records"]:
        if not rec["adopted"]:
            continue
        if not ((rec["mask"] >> ch) & 1):
            continue
        ranks = rec["channelRanks"]
        rank = ranks.index(ch)
        nset = len(ranks)
        r0 = rec["relStart"]
        count = rec["count"]
        for t in range(count):
            j = t * nset + rank
            b = bit_at(data, rec, j)
            grid[r0 + t] = 3 if b else 2
    return grid


def grid_value(code, t, anchor):
    if t < 0:
        return 0
    if code == 3:
        return 1
    if code == 2:
        return -1
    # missing -> absolute phase parity fill
    return 1 if ((anchor + t) & 1) else -1


def decimate_channel(grid, anchor, D):
    """Literal three cascaded length-D moving sums + exact rounding.

    Returns pcm list and affected-frame list and per-frame exact sum.
    """
    T = len(grid)
    nframes = T // D
    K = 3 * (D - 1)

    # Build value array x[t] for t>=0 with fills; keep missing bool.
    x = [0] * T
    missing = bytearray(T)
    for t in range(T):
        code = grid[t]
        if code == 0:
            missing[t] = 1
            x[t] = 1 if ((anchor + t) & 1) else -1
        elif code == 3:
            x[t] = 1
        else:
            x[t] = -1

    # Three boxcar passes, each an independent running sum.
    def boxcar(a):
        n = len(a)
        y = [0] * n
        run = 0
        for t in range(n):
            run += a[t]
            if t - D >= 0:
                run -= a[t - D]
            y[t] = run
        return y

    y1 = boxcar(x)
    y2 = boxcar(y1)
    y3 = boxcar(y2)

    scale_num = 32768
    den = D * D * D
    pcm = [0] * nframes
    affected = [0] * nframes
    sums = [0] * nframes
    for f in range(nframes):
        T_out = (f + 1) * D - 1
        s = y3[T_out]
        sums[f] = s
        v = round_half_even_div(s * scale_num, den)
        if v > 32767:
            v = 32767
        elif v < -32768:
            v = -32768
        pcm[f] = v
        left = T_out - K
        l0 = left if left > 0 else 0
        if any(missing[l0:T_out + 1]):
            affected[f] = 1
    return pcm, affected, sums


def intervals_from_flags(flags):
    """Maximal runs of True -> half-open [start,end) frame pairs."""
    ivs = []
    i = 0
    n = len(flags)
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i + 1
        while j < n and flags[j]:
            j += 1
        ivs.append([i, j])
        i = j
    return ivs


def decode_all(data):
    parsed = parse(data)
    result = {"parse": parsed}
    if not parsed["headerOk"] and parsed["headerError"]:
        return result
    ch = parsed["channels"]
    D = parsed["D"]
    anchor = parsed["anchor"]
    pcm_by_ch = []
    aff_by_ch = []
    iv_by_ch = []
    for c in range(ch):
        grid = build_channel_grid(data, parsed, c)
        pcm, aff, sums = decimate_channel(grid, anchor, D)
        pcm_by_ch.append(pcm)
        aff_by_ch.append(aff)
        iv_by_ch.append(intervals_from_flags(aff))
    result["pcm"] = pcm_by_ch
    result["affected"] = aff_by_ch
    result["intervals"] = iv_by_ch
    result["frames"] = (parsed["totalTicks"] // D) if D in (32, 64) else None
    return result


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    in_path = argv[1]
    out_json = None
    out_pcm = None
    if len(argv) >= 3 and not argv[2].startswith("--"):
        out_json = argv[2]
    if "--pcm" in argv:
        out_pcm = argv[argv.index("--pcm") + 1]
    with open(in_path, "rb") as fh:
        data = fh.read()
    res = decode_all(data)
    if out_pcm and "pcm" in res:
        ch = res["parse"]["channels"]
        frames = res["frames"]
        inter = bytearray()
        for f in range(frames):
            for c in range(ch):
                inter += struct.pack("<h", res["pcm"][c][f])
        with open(out_pcm, "wb") as fh:
            fh.write(inter)
    payload = {
        "header": {
            k: res["parse"].get(k)
            for k in ("anchor", "totalTicks", "channels", "D", "fileSize", "headerOk")
        },
        "truncated": res["parse"]["truncated"],
        "recordCount": len(res["parse"]["records"]),
        "badCrc": [r["index"] for r in res["parse"]["records"] if not r["crcOk"]],
        "rejected": [
            {"index": r["index"], "offset": r["offset"], "errors": r["errors"]}
            for r in res["parse"]["records"]
            if not r["adopted"] and r["crcOk"]
        ],
        "intervals": res.get("intervals"),
        "frames": res.get("frames"),
        # full arrays included for vector comparisons
        "pcm": res.get("pcm"),
        "affected": res.get("affected"),
        "records": res["parse"]["records"],
    }
    text = json.dumps(payload, ensure_ascii=False)
    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote", out_json)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
