#!/usr/bin/env python3
"""Reference implementation of the packet-audio playout rules (约定.txt).

Run with: python3 -I reference.py <input.json> <delay_ms> <zero|repeat_decay>
Also supports self-check mode against *-expected.json files.
"""
import base64
import hashlib
import json
import sys

U16 = 1 << 16
U32 = 1 << 32
FRAMES = 480
DECAY = 0.8


def u16(x):
    return x % U16


def u32(x):
    return x % U32


def is_uint(x, bits):
    return isinstance(x, int) and not isinstance(x, bool) and 0 <= x < (1 << bits)


def analyze(doc, delay_ms, policy):
    rate = doc["rate"]
    channels = doc["channels"]
    fpp = doc["frames_per_packet"]
    anchor_seq = doc["anchor_seq"]
    anchor_ts = doc["anchor_ts"]
    origin_us = doc["origin_us"]
    total = doc["total_packets"]
    raw_packets = doc["packets"]

    expect_pcm_bytes = fpp * channels * 2

    # Stable sort by (arrival_us, input index).
    order = sorted(range(len(raw_packets)),
                   key=lambda i: (raw_packets[i]["arrival_us"], i))

    # Per-packet verdicts, keyed by packet id (falls back to index).
    verdicts = []
    # slot -> packet record that occupies it
    slot_owner = [None] * total

    for ordinal, idx in enumerate(order):
        p = raw_packets[idx]
        pid = p.get("id", f"#{idx}")
        arrival = p["arrival_us"]
        reasons = []

        # ---- validation ----
        if not is_uint(arrival, 64):
            reasons.append("arrival_us 不是非负整数")
        seq = p.get("seq")
        ts = p.get("timestamp")
        if not is_uint(seq, 16):
            reasons.append("seq 不是 16 位无符号整数")
        if not is_uint(ts, 32):
            reasons.append("timestamp 不是 32 位无符号整数")
        pcm_ok = False
        pcm_bytes = b""
        try:
            pcm_bytes = base64.b64decode(p.get("pcm_b64", ""), validate=True)
            pcm_ok = len(pcm_bytes) == expect_pcm_bytes
            if not pcm_ok:
                reasons.append(
                    f"PCM 长度 {len(pcm_bytes)} ≠ {expect_pcm_bytes} 字节")
        except Exception:
            reasons.append("pcm_b64 不是合法 base64")

        slot = None
        expected_ts = None
        if is_uint(seq, 16):
            slot = u16(seq - anchor_seq)
            if slot >= total:
                reasons.append(f"槽位 {slot} ≥ total_packets {total}")
            expected_ts = u32(anchor_ts + fpp * (slot if slot < total else slot))
            if is_uint(ts, 32) and slot < total and ts != expected_ts:
                reasons.append(
                    f"timestamp {ts} ≠ 期望值 {expected_ts}（槽 {slot}）")

        valid = not reasons
        v = {
            "id": pid,
            "input_index": idx,
            "arrival_us": arrival,
            "seq": seq,
            "timestamp": ts,
            "slot": slot if (valid or slot is not None) else slot,
            "status": None,
            "reason": None,
            "deadline_us": None,
        }

        if not valid:
            v["status"] = "invalid"
            v["reason"] = "；".join(reasons)
            verdicts.append(v)
            continue

        # ---- duplicate? ----
        deadline = origin_us + delay_ms * 1000 + 10000 * slot
        v["deadline_us"] = deadline
        if slot_owner[slot] is not None:
            owner = slot_owner[slot]
            v["status"] = "duplicate"
            v["reason"] = (
                f"槽 {slot} 已被 {owner['id']} 占用"
                f"（同 seq={u16(anchor_seq + slot)}）")
            verdicts.append(v)
            continue

        # ---- occupy slot, then accept vs late (inclusive deadline) ----
        slot_owner[slot] = {"id": pid, "packet": p, "pcm": pcm_bytes,
                            "arrival_us": arrival}
        if arrival <= deadline:
            v["status"] = "accepted"
            v["reason"] = (f"arrival {arrival} ≤ deadline {deadline}"
                           f"（恰好在截止时刻也算接收）")
        else:
            v["status"] = "late"
            v["reason"] = f"arrival {arrival} > deadline {deadline}，迟到不参与播放"
        verdicts.append(v)

    # ---- slots ----
    slots = []
    pcm = bytearray(fpp * channels * 2 * total)
    last_good = None  # (pcm bytes, slot index)
    miss_run = 0
    for k in range(total):
        deadline = origin_us + delay_ms * 1000 + 10000 * k
        owner = slot_owner[k]
        accepted = owner is not None and owner["arrival_us"] <= deadline
        if accepted:
            src = owner["id"]
            chunk = owner["pcm"]
            pcm[k * len(chunk):(k + 1) * len(chunk)] = chunk
            last_good = chunk
            miss_run = 0
        else:
            src = None
            off = k * expect_pcm_bytes
            if policy == "zero":
                # pcm region already zero
                miss_run += 1
            else:  # repeat_decay
                if last_good is None:
                    miss_run += 1  # stays zero
                else:
                    miss_run += 1
                    factor = DECAY ** miss_run
                    base = last_good
                    for s in range(fpp * channels):
                        pos = 2 * s
                        sample = int.from_bytes(base[pos:pos + 2], "little",
                                                signed=True)
                        mag = round(abs(sample) * factor)
                        out = mag if sample >= 0 else -mag
                        # clamp to int16
                        out = max(-32768, min(32767, out))
                        pcm[off + pos:off + pos + 2] = out.to_bytes(
                            2, "little", signed=True)
        slots.append({"slot": k, "deadline_us": deadline, "source": src})

    return {
        "verdicts": verdicts,
        "slots": slots,
        "pcm": bytes(pcm),
        "rate": rate,
        "channels": channels,
    }


def main():
    if len(sys.argv) != 4:
        print("usage: reference.py <input.json> <delay_ms> <zero|repeat_decay>")
        sys.exit(2)
    doc = json.load(open(sys.argv[1]))
    delay = int(sys.argv[2])
    policy = sys.argv[3]
    result = analyze(doc, delay, policy)
    print(hashlib.sha256(result["pcm"]).hexdigest())
    from collections import Counter
    print(Counter(v["status"] for v in result["verdicts"]))


if __name__ == "__main__":
    main()
