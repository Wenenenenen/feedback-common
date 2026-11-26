#!/usr/bin/env python3
# 独立 Python oracle：严格按 约定.txt 实现，用于跨语言逐码核对 JS 输出。
# 用法：python3 -I tools/py_oracle.py <repo-root>
import json, sys, wave, struct, math, os

root = sys.argv[1] if len(sys.argv) > 1 else "."
wav_path = os.path.join(root, "samples", "loop.wav")
settings = json.load(open(os.path.join(root, "samples", "settings.json"), encoding="utf-8"))

w = wave.open(wav_path, "rb")
assert w.getnchannels() == 2 and w.getframerate() == 48000 and w.getsampwidth() == 2
N = w.getnframes()
raw = w.readframes(N)
w.close()
vals = struct.unpack("<%dh" % (2 * N), raw)
L = [vals[2 * i] for i in range(N)]
R = [vals[2 * i + 1] for i in range(N)]

GAIN_MAX = 65536

def K_of(a, b, c, d, j):
    B = -a + c
    C = 2 * a - 5 * b + 4 * c - d
    D = -a + 3 * b - 3 * c + d
    return 128 * b + 16 * B * j + 4 * C * j * j + D * j * j * j

def rhe(t):
    # round t / 2^23, ties to even, exact integer
    neg = t < 0
    x = -t if neg else t
    D = 1 << 23
    q, rem = divmod(x, D)
    half = 1 << 22
    if rem > half or (rem == half and (q & 1)):
        q += 1
    return -q if neg else q

def cap_K(K, C):
    A = abs(K)
    if A == 0:
        return GAIN_MAX
    T = (2 * C + 1) * (1 << 22)
    if C & 1:
        g = (T - 1) // A
    else:
        g = T // A
    return min(GAIN_MAX, g)

def cyc(i):
    return i % N

n = 4 * N
caps = [0] * n
KsL = [0] * n
KsR = [0] * n
C = int(settings["ceiling"])
for i in range(N):
    aL, bL, cL, dL = L[cyc(i - 1)], L[i], L[cyc(i + 1)], L[cyc(i + 2)]
    aR, bR, cR, dR = R[cyc(i - 1)], R[i], R[cyc(i + 1)], R[cyc(i + 2)]
    for j in range(4):
        k = 4 * i + j
        kL = K_of(aL, bL, cL, dL, j)
        kR = K_of(aR, bR, cR, dR, j)
        KsL[k], KsR[k] = kL, kR
        caps[k] = min(cap_K(kL, C), cap_K(kR, C))

up = int(settings["up"]); down = int(settings["down"])
locks = settings.get("locks", [])
hi = caps[:]
for pair in locks:
    f, g = int(pair[0]), int(pair[1])
    hi[f] = min(hi[f], g)

# doubled-array min-plus propagation
m = 2 * n
work = hi + hi
for t in range(1, m):
    work[t] = min(work[t], work[t - 1] + up)
gains = [0] * n
for k in range(n):
    gains[k] = work[k + n]
work = hi + hi
for t in range(m - 2, -1, -1):
    work[t] = min(work[t], work[t + 1] + down)
for k in range(n):
    gains[k] = min(gains[k], work[k])

# compare gains/caps with JS dump
js = json.load(open("/tmp/ccl-default-gains.json"))
gain_diff = sum(1 for i in range(n) if js["gains"][i] != gains[i])
cap_diff = sum(1 for i in range(n) if js["caps"][i] != caps[i])
print("gain diffs vs JS:", gain_diff, " cap diffs:", cap_diff)
assert gain_diff == 0 and cap_diff == 0

# output codes
outL = [rhe(KsL[k] * gains[k]) for k in range(n)]
outR = [rhe(KsR[k] * gains[k]) for k in range(n)]
assert max(abs(x) for x in outL) <= C and max(abs(x) for x in outR) <= C

# read JS-exported WAV
ww = wave.open("/tmp/ccl-default-js.wav", "rb")
assert ww.getframerate() == 192000 and ww.getnchannels() == 2 and ww.getsampwidth() == 2
assert ww.getnframes() == n
raw2 = ww.readframes(n)
ww.close()
codes = struct.unpack("<%dh" % (2 * n), raw2)
mm = 0
for k in range(n):
    if codes[2 * k] != outL[k] or codes[2 * k + 1] != outR[k]:
        mm += 1
print("WAV code mismatches vs Python oracle:", mm)
assert mm == 0

# cyclic slew check
sv = 0
for k in range(n):
    nx = (k + 1) % n
    if gains[nx] - gains[k] > up or gains[k] - gains[nx] > down:
        sv += 1
assert sv == 0
print("PYTHON ORACLE FULL MATCH: n=%d peaks L=%d R=%d" % (n, max(map(abs, outL)), max(map(abs, outR))))
