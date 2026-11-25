#!/usr/bin/env python3
"""生成随机 EVL1 用例与 Python 独立参考结果，供 Node 交叉验证。

用法: python3 -I tools/gen_oracle.py
输出: tools/generated/<case>.evl, oracle.json
"""
import json
import os
import random
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ref_impl import parse, pixel_windows, MISSING  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated")
os.makedirs(OUT, exist_ok=True)


def build_evl(w, h, anchor_times, codes, events):
    """codes: A x P list[int]; events: [(t,idx,pol)] (will be sorted by t)."""
    A = len(anchor_times)
    P = w * h
    events = sorted(events, key=lambda e: e[0])
    b = bytearray()
    b += b"EVL1"
    b += struct.pack("<HHII", w, h, A, len(events))
    for a in range(A):
        b += struct.pack("<I", anchor_times[a])
        for p in range(P):
            b += struct.pack("<h", codes[a][p])
    for t, idx, pol in events:
        word = idx & 0x7FFFFFFF
        if pol > 0:
            word |= 0x80000000
        b += struct.pack("<II", t, word)
    return bytes(b)


def gen_valid_case(rng, ci):
    w = rng.choice([1, 2, 3, 5, 8, 16])
    h = rng.choice([1, 2, 3, 4, 7])
    P = w * h
    A = rng.randint(2, 6)
    # anchor times: sometimes tiny gaps (steep), sometimes huge
    times = [rng.randint(0, 100)]
    for _ in range(A - 1):
        gap = rng.choice([1, 2, 3, rng.randint(5, 40), rng.randint(100, 5000),
                          rng.randint(100000, 4000000)])
        times.append(times[-1] + gap)
    # keep within u32
    if times[-1] > 4_200_000_000:
        scale = 4_000_000_000 / times[-1]
        times = [int(t * scale) for t in times]
        for i in range(1, A):
            if times[i] <= times[i - 1]:
                times[i] = times[i - 1] + 1

    codes = []
    for a in range(A):
        row = []
        for p in range(P):
            r = rng.random()
            if r < 0.18:
                row.append(MISSING)
            elif r < 0.30:
                row.append(rng.choice([-6144, -6143, -6145 + 1, 2048, 2047, -3276 + 0]))
            else:
                # quantized valid codes
                row.append(rng.randint(-6144, 2048))
        codes.append(row)

    t0, tN = times[0], times[-1]
    E = rng.randint(0, 220)
    events = []
    for _ in range(E):
        mode = rng.random()
        if mode < 0.15:
            t = rng.choice(times)  # events exactly at anchor times
        elif mode < 0.4:
            t = rng.randint(t0, tN) if tN > t0 else t0
        else:
            t = rng.randint(t0, tN)
        idx = rng.randrange(P)
        pol = rng.choice([-1, 1, 1, -1])
        events.append((t, idx, pol))
    # add same-timestamp clusters for one pixel
    for _ in range(rng.randint(1, 6)):
        t = rng.randint(t0, tN)
        idx = rng.randrange(P)
        for _ in range(rng.randint(2, 5)):
            events.append((t, idx, rng.choice([-1, 1])))

    data = build_evl(w, h, times, codes, events)
    parsed = parse(data)  # self-check

    # windows: cover edge cases
    span = max(1, tN - t0)
    windows = []
    kinds = ci % 7
    windows.append([t0, tN])
    windows.append([max(0, t0 - span // 2), t0 + max(1, span // 3)])  # starts before
    windows.append([tN - max(1, span // 4), tN + span // 2 + 2])      # ends after
    windows.append([rng.randint(t0, tN), min(4_294_967_295, rng.randint(t0, tN) + 1)])  # 1us maybe
    a = rng.randint(t0, tN)
    b = rng.randint(t0, tN)
    if a == b:
        b = min(4_294_967_295, a + rng.randint(1, 50))
    if a > b:
        a, b = b, a
    if a == b:
        b = a + 1
    windows.append([a, b])
    # overlap-ish random
    for _ in range(2):
        a = rng.randint(0, max(1, tN))
        b = a + rng.randint(1, max(2, span))
        b = min(b, 4_294_967_295)
        windows.append([a, b])

    expected = []
    for wi, win in enumerate(windows):
        rows = []
        for p in range(P):
            lum, cov = pixel_windows(parsed, p, [win])[0]
            rows.append([lum, cov])
        expected.append(rows)

    fn = f"rand_{ci:03d}.evl"
    with open(os.path.join(OUT, fn), "wb") as f:
        f.write(data)
    return {"file": fn, "windows": windows, "expected": expected,
            "w": w, "h": h, "kind": kinds}


def malformed_cases():
    cases = []

    def add(name, blob, off):
        cases.append({"name": name, "b64": __import__("base64").b64encode(blob).decode(),
                      "offset": off})

    add("empty", b"", 0)
    add("three-bytes", b"EVL", 0)
    add("bad-magic", b"XXXX" + b"\0" * 20, 0)
    add("width-trunc-1", b"EVL1\x20", 4)
    add("height-trunc", b"EVL1" + struct.pack("<H", 1) + b"\0", 6)
    add("anchorcount-trunc", b"EVL1" + struct.pack("<HH", 1, 1) + b"\0\0", 8)
    hdr_full16 = b"EVL1" + struct.pack("<HHII", 1, 1, 2, 0)
    add("eventcount-trunc", hdr_full16[:14], 12)
    add("width-zero", b"EVL1" + struct.pack("<HHII", 0, 1, 2, 0), 4)
    add("width-too-big", b"EVL1" + struct.pack("<HHII", 513, 1, 2, 0), 4)
    add("height-zero", b"EVL1" + struct.pack("<HHII", 1, 0, 2, 0), 6)
    add("height-too-big", b"EVL1" + struct.pack("<HHII", 1, 385, 2, 0), 6)
    add("anchors-too-few", b"EVL1" + struct.pack("<HHII", 1, 1, 1, 0), 8)
    add("anchors-too-many", b"EVL1" + struct.pack("<HHII", 1, 1, 13, 0), 8)
    add("events-too-many", b"EVL1" + struct.pack("<HHII", 1, 1, 2, 4_000_001), 12)

    # P=1,A=2,E=0: header16 + each anchor 6 => total 28
    def anchors_blob(t0, c0, t1, c1):
        b = bytearray(hdr_full16)
        b += struct.pack("<Ih", t0, c0)
        b += struct.pack("<Ih", t1, c1)
        return bytes(b)

    add("anchor-time-equal", anchors_blob(10, 0, 10, 0), 22)
    add("anchor-time-decrease", anchors_blob(20, 0, 10, 0), 22)
    add("bad-code-high", anchors_blob(0, 30000, 10, 0), 20)
    add("bad-code-low", anchors_blob(0, -7000, 10, 0), 20)
    # truncate second code byte of first anchor: len 21
    add("code-trunc", anchors_blob(0, 0, 10, 0)[:21], 20)
    # truncate second anchor time mid-field: first anchor ends 22; len 24 -> time field at22 incomplete
    add("anchor-time-trunc", anchors_blob(0, 0, 10, 0)[:24], 22)

    # events: P=1,A=2 times [10,100], 2 event slots => header says E=2
    base = bytearray()
    base += b"EVL1" + struct.pack("<HHII", 1, 1, 2, 2)
    base += struct.pack("<Ih", 10, 0)
    base += struct.pack("<Ih", 100, 0)  # pos 22..27
    assert len(base) == 28
    ev0 = struct.pack("<II", 50, 0)       # offset28 time, 32 word
    ev1 = struct.pack("<II", 60, 0)       # offset36
    add("event-time-before", bytes(base + struct.pack("<II", 9, 0)), 28)
    add("event-time-after", bytes(base + struct.pack("<II", 101, 0)), 28)
    add("event-time-u32-out", bytes(base + struct.pack("<II", 5000, 0)), 28)
    add("event-bad-idx", bytes(base + struct.pack("<II", 50, 1)), 32)  # idx1 >= P1
    add("event-word-trunc", bytes(base + ev0)[:33], 32)
    add("event-time-trunc", bytes(base + ev0)[:30], 28)
    add("two-events-decrease", bytes(base + ev0 + struct.pack("<II", 40, 0)), 36)
    add("two-events-bad-word2", bytes(base + ev0 + struct.pack("<II", 60, 0x7FFFFFFF)), 40)
    # valid event at anchor time should parse OK (no error) -> offset None marker
    add("valid-at-anchor", bytes(base + struct.pack("<II", 10, 0) + struct.pack("<II", 100, 0)), None)
    # trailing
    good = anchors_blob(0, 0, 100, 0)
    add("trailing-one", good + b"\x00", len(good))
    add("trailing-three", good + b"ABC", len(good))
    return cases


def main():
    rng = random.Random(20261126)
    cases = []
    # sample case
    sample_path = os.path.join(os.path.dirname(OUT), "..", "samples", "extracted", "turntable.evl")
    sample_path = os.path.abspath(sample_path)
    with open(sample_path, "rb") as f:
        sdata = f.read()
    sp = parse(sdata)
    swins = [[1000, 15000], [12000, 27000], [25000, 35000], [0, 36000], [5000, 5001]]
    sexp = [[list(x) for x in [pixel_windows(sp, p, [w])[0] for p in range(sp["w"] * sp["h"])]]
            for w in swins]
    with open(os.path.join(OUT, "sample.evl"), "wb") as f:
        f.write(sdata)
    cases.append({"file": "sample.evl", "windows": swins, "expected": sexp,
                  "w": sp["w"], "h": sp["h"]})

    for ci in range(70):
        cases.append(gen_valid_case(rng, ci))

    oracle = {"valid": cases, "malformed": malformed_cases()}
    with open(os.path.join(OUT, "oracle.json"), "w") as f:
        json.dump(oracle, f)
    print(f"wrote {len(cases)} valid cases and {len(oracle['malformed'])} malformed cases to {OUT}")


if __name__ == "__main__":
    main()
