import os, json, sys

d = sys.argv[1]
spec = json.load(open(os.path.join(d, "groups.json")))


def read(p):
    b = open(os.path.join(d, p), "rb").read()
    pos = 0

    def tok():
        nonlocal pos
        while b[pos] in b" \t\n\r#":
            if b[pos] == ord("#"):
                while b[pos] not in b"\n\r":
                    pos += 1
            else:
                pos += 1
        s = pos
        while b[pos] not in b" \t\n\r":
            pos += 1
        return b[s:pos]

    m = tok(); w = int(tok()); h = int(tok()); mx = int(tok()); pos += 1
    return w, h, mx, b[pos:]


bgs, obs, masks = [], [], []
for g in spec["groups"]:
    w, h, _, bgd = read(g["background"])
    _, _, _, obd = read(g["observed"])
    _, _, _, msd = read(g["valid"])
    bgs.append(bgd); obs.append(obd); masks.append(msd)

p = 2 * w + 2


def comp(a, f, b):
    return (a * f + (255 - a) * b + 127) // 255


sols = 0
for a in range(256):
    lo = [0] * 3; hi = [255] * 3; ok = True
    for gi in range(len(bgs)):
        for c in range(3):
            vals = [f for f in range(256) if comp(a, f, bgs[gi][3 * p + c]) == obs[gi][3 * p + c]]
            if not vals:
                ok = False; break
            lo[c] = max(lo[c], vals[0]); hi[c] = min(hi[c], vals[-1])
            if lo[c] > hi[c]:
                ok = False; break
        if not ok:
            break
    if ok:
        sols += 1
print("python brute feasible A count for p=2 (x=2,y=2):", sols)
print("group0 b/o:", list(bgs[0][3 * p:3 * p + 3]), list(obs[0][3 * p:3 * p + 3]))
print("raster sizes:", [len(x) for x in bgs], "dims", w, h)

# also solve EVERY pixel with brute and count statuses
feas = nosol = unmeas = 0
n = w * h
for pp in range(n):
    active = gi_list = [gi for gi in range(len(bgs)) if masks[gi][pp] != 0]
    if not active:
        unmeas += 1; continue
    found = False
    for a in range(256):
        lo = [0] * 3; hi = [255] * 3; ok = True
        for gi in active:
            for c in range(3):
                vals = [f for f in range(256) if comp(a, f, bgs[gi][3 * pp + c]) == obs[gi][3 * pp + c]]
                if not vals:
                    ok = False; break
                lo[c] = max(lo[c], vals[0]); hi[c] = min(hi[c], vals[-1])
                if lo[c] > hi[c]:
                    ok = False; break
            if not ok:
                break
        if ok:
            found = True; break
    if found: feas += 1
    else: nosol += 1
print("full-image brute:", feas, nosol, unmeas)
