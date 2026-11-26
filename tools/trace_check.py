#!/usr/bin/env python3
"""Hand-trace fixed-point biquad against ref.simulate on tiny signals."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from ref import round_half_even_div, simulate  # noqa: E402


def trace(sections, order, inputs):
    """Single-channel hand trace with printed state."""
    by_id = {s["id"]: s for s in sections}
    hist = {sid: [0, 0, 0, 0] for sid, _ in order}  # x1,x2,y1,y2
    outs = []
    for n, v in enumerate(inputs):
        line = [f"n={n} in={v}"]
        for sid, sh in order:
            sec = by_id[sid]
            x = round_half_even_div(v, 1 << sh)
            x1, x2, y1, y2 = hist[sid]
            acc = (sec["b"][0] * x + sec["b"][1] * x1 + sec["b"][2] * x2
                   - sec["a"][0] * y1 - sec["a"][1] * y2)
            y = round_half_even_div(acc, 16384)
            clipped = y < -32768 or y > 32767
            y = max(-32768, min(32767, y))
            hist[sid] = [x, x1, y, y1]
            line.append(f"[id{sid} sh{sh}] x={x} acc={acc} y={y}"
                        + (" CLIP" if clipped else ""))
            v = y
        outs.append(v)
        print("  ".join(line))
    return outs


# --- rounding unit checks --------------------------------------------------
cases = {
    # (numerator, divisor) -> expected banker's rounding
    (3, 2): 2, (-3, 2): -2, (5, 2): 2, (-5, 2): -2,
    (2, 2): 1, (-2, 2): -1, (1, 2): 0, (-1, 2): 0,
    (7, 4): 2, (-7, 4): -2, (6, 4): 2, (-6, 4): -2,
    (9, 4): 2, (-9, 4): -2, (10, 4): 2, (-10, 4): -2,
    (32767 * 16384, 16384): 32767,
}
for (v, d), exp in cases.items():
    got = round_half_even_div(v, d)
    assert got == exp, f"rhev({v},{d})={got} want {exp}"
print("rounding unit cases OK")

# --- biquad trace: section 1 from sample (b0=16384,b1=2048,a1=-4096) -------
sec1 = {"id": 1, "b": [16384, 2048, 0], "a": [-4096, 0],
        "gain": [0, 0], "limit": [0, 0]}
sec2 = {"id": 2, "b": [12288, 0, 0], "a": [0, 0],
        "gain": [0, 0], "limit": [0, 0]}
secs = [sec1, sec2]
inputs = [1, -1, 2, -2, 3, -3, 32767, -32768, 100, -100]
print("\n-- trace order (2 sh1),(1 sh0): pre-shift on sec2 --")
hand = trace(secs, [(2, 1), (1, 0)], inputs)

# cross-check with simulate()
final, clips, _ = simulate({s["id"]: s for s in secs},
                           [(2, 1), (1, 0)], len(inputs), 1, inputs)
assert final == hand, (final, hand)
print("\nsimulate matches hand trace; clips:", clips)

# --- saturation feeds history: force a clip then check next sample ---------
# b0 huge relative to Q14 scale: b0=16384 is unity, so use input extremes
big = {"id": 9, "b": [16384, 16384, 0], "a": [0, 0],
       "gain": [0], "limit": [0]}
print("\n-- saturation into history (b1=16384) --")
h2 = trace([big], [(9, 0)], [32767, 1, -32768, 1])
# n0: acc=32767*16384 -> y=32767 (no clip)
# n1: acc=1*16384 + 32767*16384 -> 32768 -> CLIP to 32767, stored y1=32767
# n2: acc=-32768*16384 + 1*16384 -> -32767
# n3: acc=1*16384 + (-32768)*16384 -> -32767
assert h2 == [32767, 32767, -32767, -32767], h2
print("saturation/history behavior OK:", h2)
