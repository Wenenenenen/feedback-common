#!/usr/bin/env python3
"""Reference implementation for the SOS headroom planner (fixed-point Q14).

Reads a plan JSON + 16-bit PCM WAV, finds the best (order, per-section
pre-shift) arrangement under the ledger constraints, then runs an exact
per-sample fixed-point simulation with round-half-to-even and saturated
values feeding back into the recursive history.

Run with: python3 -I ref.py <plan.json> <input.wav> [out_prefix]
"""
import json
import struct
import sys

MAX_TOTAL_SHIFT = 12
MAX_STAGE_SHIFT = 3
Q14 = 1 << 14
CLIP_LO, CLIP_HI = -32768, 32767


def round_half_even(v):
    """Round to nearest, ties to even, for any integer numerator v over 2."""
    # v / 2 with banker's rounding; works for negative v as well.
    q = v >> 1
    if (v & 1) and (q & 1):
        q += 1
    return q


def round_half_even_div(v, d):
    """v / d, round half to even; d is a power of two >= 1."""
    if d == 1:
        return v
    neg = v < 0
    n = -v if neg else v
    half = d >> 1
    q, r = divmod(n, d)
    if r > half or (r == half and (q & 1)):
        q += 1
    return -q if neg else q


def read_wav(path):
    with open(path, "rb") as f:
        buf = f.read()
    assert buf[0:4] == b"RIFF" and buf[8:12] == b"WAVE", "not a WAVE file"
    pos = 12
    fmt = None
    data = None
    while pos + 8 <= len(buf):
        cid, csz = struct.unpack_from("<4sI", buf, pos)
        pos += 8
        body = buf[pos:pos + csz]
        if cid == b"fmt ":
            (comp, ch, sr, _br, _ba, bps) = struct.unpack_from("<HHIIHH", body, 0)
            fmt = dict(comp=comp, channels=ch, sample_rate=sr, bits=bps)
        elif cid == b"data":
            data = body
        pos += csz + (csz & 1)
    assert fmt is not None and data is not None, "missing fmt/data chunks"
    assert fmt["comp"] == 1 and fmt["bits"] == 16, "only PCM16 supported"
    ch = fmt["channels"]
    assert 1 <= ch <= 2
    frames = len(data) // (2 * ch)
    samples = struct.unpack("<%dh" % (frames * ch), data[: frames * 2 * ch])
    return fmt, frames, list(samples)


def write_wav(path, fmt, interleaved):
    ch = fmt["channels"]
    sr = fmt["sample_rate"]
    data = struct.pack("<%dh" % len(interleaved), *interleaved)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(data), b"WAVE", b"fmt ", 16,
        1, ch, sr, sr * ch * 2, ch * 2, 16, b"data", len(data),
    )
    with open(path, "wb") as f:
        f.write(header + data)


def best_plan(sections, bands):
    """Subset DP over (used_mask, total_shift).

    The cumulative book vector at a state depends only on the mask and the
    total shift: book[b] = sumGain[mask][b] - 256*total. Each state is
    evaluated once; we keep the best (prefix-sum of cumulative shifts,
    lex-smallest (id, shift) sequence) via back-pointers.
    """
    n = len(sections)
    nb = len(bands)
    size = 1 << n
    # sections explored in ascending id order for lex-tie handling
    order_idx = sorted(range(n), key=lambda i: sections[i]["id"])

    gain = [s["gain"] for s in sections]
    limit = [s["limit"] for s in sections]

    # subset gain sums
    sum_gain = [[0] * nb for _ in range(size)]
    for mask in range(1, size):
        lb = mask & -mask
        i = lb.bit_length() - 1
        prev = mask ^ lb
        pg = sum_gain[prev]
        gi = gain[i]
        sum_gain[mask] = [pg[b] + gi[b] for b in range(nb)]

    # R[i][s][b] = limit_i[b] - gain_i[b] + 256*s; transition ok iff
    # current book vector <= R entrywise.
    R = [[[limit[i][b] - gain[i][b] + 256 * s for b in range(nb)]
          for s in range(MAX_STAGE_SHIFT + 1)] for i in range(n)]

    INF = float("inf")
    # state (mask, total) -> (best P, sequence of (section_index, shift))
    dp = [[None] * (MAX_TOTAL_SHIFT + 1) for _ in range(size)]
    dp[0][0] = (0, [])

    for mask in range(size):
        sg = sum_gain[mask]
        for total in range(MAX_TOTAL_SHIFT + 1):
            st = dp[mask][total]
            if st is None:
                continue
            p_cur, seq = st
            book = [sg[b] - 256 * total for b in range(nb)]
            remaining = (size - 1) ^ mask
            for i in order_idx:
                bit = 1 << i
                if not (remaining & bit):
                    continue
                nmask = mask | bit
                for s in range(0, MAX_STAGE_SHIFT + 1):
                    nt = total + s
                    if nt > MAX_TOTAL_SHIFT:
                        break
                    r = R[i][s]
                    ok = True
                    for b in range(nb):
                        if book[b] > r[b]:
                            ok = False
                            break
                    if not ok:
                        continue
                    np_ = p_cur + nt
                    nseq = seq + [(i, s)]
                    tgt = dp[nmask][nt]
                    # lexicographic rule operates on (id, shift) pairs,
                    # not on array positions
                    nkey = [[sections[j]["id"], sh] for j, sh in nseq]
                    if tgt is None or np_ < tgt[0] or (
                            np_ == tgt[0] and
                            nkey < [[sections[j]["id"], sh]
                                    for j, sh in tgt[1]]):
                        dp[nmask][nt] = (np_, nseq)

    full = size - 1
    best_total = None
    for total in range(MAX_TOTAL_SHIFT + 1):
        if dp[full][total] is not None:
            best_total = total
            break
    if best_total is None:
        return None
    p_best, seq_idx = dp[full][best_total]
    seq = [(sections[i]["id"], s) for (i, s) in seq_idx]
    return {"total": best_total, "psum": p_best, "seq": seq}


def simulate(sections_by_id, order, frames, channels, samples):
    """Exact device simulation. samples is interleaved per-frame.

    Returns (final interleaved output, clips[stage][channel],
             stage_outputs) where stage_outputs keeps every stage's
             per-channel output arrays for cross-checking subranges.
    """
    n = len(order)
    clips = [[0] * channels for _ in range(n)]
    # per stage, per channel: x1,x2,y1,y2
    hist = [[[0, 0, 0, 0] for _ in range(channels)] for _ in range(n)]
    stage_out = [
        [[0] * frames for _c in range(channels)] for _st in range(n)
    ]

    for fr in range(frames):
        for c in range(channels):
            v = samples[fr * channels + c]
            for st, (sid, sh) in enumerate(order):
                sec = sections_by_id[sid]
                x = round_half_even_div(v, 1 << sh)
                x1, x2, y1, y2 = hist[st][c]
                acc = (sec["b"][0] * x + sec["b"][1] * x1
                       + sec["b"][2] * x2
                       - sec["a"][0] * y1 - sec["a"][1] * y2)
                y = round_half_even_div(acc, Q14)
                if y < CLIP_LO:
                    y = CLIP_LO
                    clips[st][c] += 1
                elif y > CLIP_HI:
                    y = CLIP_HI
                    clips[st][c] += 1
                # saturated value enters the recursive history
                hist[st][c] = [x, x1, y, y1]
                stage_out[st][c][fr] = y
                v = y
    final = [0] * (frames * channels)
    for fr in range(frames):
        for c in range(channels):
            final[fr * channels + c] = stage_out[-1][c][fr]
    return final, clips, stage_out


def main():
    plan_path, wav_path = sys.argv[1], sys.argv[2]
    out_prefix = sys.argv[3] if len(sys.argv) > 3 else "/tmp/refout"
    with open(plan_path, "rb") as f:
        plan = json.loads(f.read().decode("utf-8"))
    sections = plan["sections"]
    bands = plan["bands"]
    by_id = {s["id"]: s for s in sections}

    best = best_plan(sections, bands)
    if best is None:
        print("NO SOLUTION")
        return
    order = best["seq"]
    print("order (id, shift):", order)
    print("total shift:", best["total"], "prefix sum:", best["psum"])

    # per-stage ledger margins
    gcur = [0] * len(bands)
    id_to_idx = {s["id"]: k for k, s in enumerate(sections)}
    print("\nstage margins (per band):")
    cum_shift = 0
    for st, (sid, sh) in enumerate(order):
        i = id_to_idx[sid]
        cum_shift += sh
        gcur = [gcur[b] + sections[i]["gain"][b] - 256 * sh
                for b in range(len(bands))]
        margins = [sections[i]["limit"][b] - gcur[b]
                   for b in range(len(bands))]
        print(f"  stage {st}: id={sid} sh={sh} cum={cum_shift} "
              f"book={gcur} margin={margins}")

    fmt, frames, samples = read_wav(wav_path)
    print("\nwav:", fmt, "frames:", frames)
    final, clips, stage_out = simulate(by_id, order, frames,
                                       fmt["channels"], samples)
    print("clips per stage/channel:", clips)
    print("first 12 final samples:", final[:12])
    write_wav(out_prefix + ".wav", fmt, final)
    print("wrote", out_prefix + ".wav")


if __name__ == "__main__":
    main()
