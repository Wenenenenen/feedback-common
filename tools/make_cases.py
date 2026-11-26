#!/usr/bin/env python3
"""Synthetic stress cases for the headroom planner (generated, trusted)."""
import json
import os
import random
import struct

OUT = os.path.join(os.path.dirname(__file__), "cases")
os.makedirs(OUT, exist_ok=True)


def write_wav(path, frames, channels, sr=48000, gen=None):
    n = frames * channels
    if gen is None:
        vals = [0] * n
    else:
        vals = [gen(i) for i in range(n)]
    data = struct.pack("<%dh" % n, *[max(-32768, min(32767, v)) for v in vals])
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(data),
                         b"WAVE", b"fmt ", 16, 1, channels, sr,
                         sr * channels * 2, channels * 2, 16,
                         b"data", len(data))
    with open(path, "wb") as f:
        f.write(header + data)


def save(name, plan, wav):
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False)
    print("wrote", name)


# Case A: infeasible — a single section whose own gain-256*3 exceeds its
# limit at every band, so no shift in [0,3] and no ordering can save it.
save("infeasible", {
    "bands": [100, 1000],
    "sections": [
        {"id": 7, "b": [16384, 0, 0], "a": [0, 0],
         "gain": [400, 400], "limit": [-500, -500]},
    ],
}, None)

# Case B: shifts required — gains positive, tight limits force right shifts
save("needshift", {
    "bands": [200, 2000],
    "sections": [
        {"id": 10, "b": [16384, 0, 0], "a": [0, 0],
         "gain": [600, 600], "limit": [200, 200]},
        {"id": 11, "b": [16384, 0, 0], "a": [0, 0],
         "gain": [600, 600], "limit": [400, 400]},
        {"id": 12, "b": [16384, 0, 0], "a": [0, 0],
         "gain": [600, 600], "limit": [600, 600]},
    ],
}, None)

# Case C: full 14 sections / 32 bands, perf tests.
# C1 loose limits -> guaranteed feasible (any order, shift 0 passes because
#     each limit >= running positive book; constructed accordingly).
# C2 random tight limits -> possibly infeasible, stresses pruning either way.
random.seed(42)
bands = sorted(random.sample(range(1, 24001), 32))


def rand_coeffs():
    return {
        "b": [random.randint(-16384, 16384),
              random.randint(-8192, 8192),
              random.randint(-4096, 4096)],
        "a": [random.randint(-8192, 8192),
              random.randint(-4096, 4096)],
    }


# C1: build gains so cumulative sum stays positive-ish, limits always above it
secs_easy = []
running = [0] * len(bands)
for k in range(14):
    c = rand_coeffs()
    g = [random.randint(0, 300) for _ in bands]
    running = [running[b] + g[b] for b in range(len(bands))]
    lim = [running[b] + random.randint(0, 128) for b in range(len(bands))]
    c.update(id=200 + k, gain=g, limit=lim)
    secs_easy.append(c)
save("full14_easy", {"bands": bands, "sections": secs_easy}, None)

# C2: fully random tight ledger
secs_tight = []
for k in range(14):
    c = rand_coeffs()
    c.update(
        id=300 + k,
        gain=[random.randint(-512, 768) for _ in bands],
        limit=[random.randint(-256, 2048) for _ in bands],
    )
    secs_tight.append(c)
save("full14_tight", {"bands": bands, "sections": secs_tight}, None)

# WAVs for clipping / rounding simulation
# stereo, 1 second; includes negatives, ramps and full-scale extremes
def gen_mix(i):
    fr, ch = divmod(i, 2)
    t = fr
    if t < 8:
        v = [1, -1, 2, -2, 3, -3, 4, -4][t]  # tiny values: half-even on /2
    elif t < 16:
        v = (t - 12) * 10000  # large swings -> saturation with high b0
    elif t < 24:
        v = 32767 if (t % 2 == 0) else -32768
    else:
        v = int(20000 * ((-1) ** t))
    return v + ch

write_wav(os.path.join(OUT, "mix.wav"), 48000, 2, gen=gen_mix)

# simple mono wav for basic checks
write_wav(os.path.join(OUT, "mono.wav"), 4800, 1,
          gen=lambda i: ((i * 37) % 2001) - 1000)
print("wavs written")
