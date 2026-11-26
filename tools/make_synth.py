#!/usr/bin/env python3
# Generates synthetic P6/P5 datasets for stress-testing the solver.
# Run: python3 -I make_synth.py <out_dir> <w> <h> <ngroups>
import json, os, random, sys


def write_pnm(path, magic, w, h, data):
    with open(path, "wb") as f:
        f.write(("%s\n%d %d\n255\n" % (magic, w, h)).encode())
        f.write(bytes(data))


def comp(a, f, b):
    return (a * f + (255 - a) * b + 127) // 255


def main():
    out, w, h, ng = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    os.makedirs(out, exist_ok=True)
    rng = random.Random(42)
    n = w * h
    # ground-truth straight RGBA
    truth = []
    for p in range(n):
        a = rng.randrange(256)
        f = [rng.randrange(256) for _ in range(3)]
        truth.append((a, f))
    bgs, obs_all, masks = [], [], []
    for g in range(ng):
        bg = [rng.randrange(256) for _ in range(3 * n)]
        ob = [0] * (3 * n)
        mask = [255] * n
        for p in range(n):
            a, f = truth[p]
            for c in range(3):
                ob[3 * p + c] = comp(a, f[c], bg[3 * p + c])
        # mask out a deterministic region on even groups -> unmeasured only where ALL masks off
        if g % 2 == 0:
            for y in range(h):
                for x in range(w):
                    if x == 0 and y == 0:
                        mask[y * w + x] = 0
        bgs.append(bg); obs_all.append(ob); masks.append(mask)
    # corner pixel: mask out every group -> unmeasured
    for g in range(ng):
        masks[g][0] = 0
    # another pixel: corrupt observation badly on every group -> no solution
    bad = 1 if n > 1 else 0
    for g in range(ng):
        for c in range(3):
            obs_all[g][3 * bad + c] = 255 - obs_all[g][3 * bad + c]
    spec = {"groups": []}
    for g in range(ng):
        write_pnm(os.path.join(out, "bg%d.ppm" % g), "P6", w, h, bgs[g])
        write_pnm(os.path.join(out, "obs%d.ppm" % g), "P6", w, h, obs_all[g])
        write_pnm(os.path.join(out, "valid%d.pgm" % g), "P5", w, h, masks[g])
        spec["groups"].append({
            "background": "bg%d.ppm" % g,
            "observed": "obs%d.ppm" % g,
            "valid": "valid%d.pgm" % g,
        })
    with open(os.path.join(out, "groups.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f)
    print("wrote", out, w, h, ng)


if __name__ == "__main__":
    main()
