#!/usr/bin/env python3
"""Generate deterministic PGM + region test cases for cross-validation.

Run with -I so the untrusted samples directory can never shadow stdlib modules.
Output lands in tests/cases/<name>/ with gray.pgm, region.json and manifest.json.
"""
import json
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'tests', 'cases')


def write_pgm(path, w, h, rng, maxval=65535):
    with open(path, 'wb') as f:
        f.write(f'P5\n{w} {h}\n{maxval}\n'.encode('ascii'))
        for _ in range(w * h):
            f.write(struct.pack('>H', rng.randrange(0, maxval + 1)))


def convex_ring(n, cx, cy, rx, ry, rng, scale=16):
    pts = []
    for i in range(n):
        a = 2 * 3.141592653589793 * i / n + rng.uniform(-0.2, 0.2)
        rr = rng.uniform(0.7, 1.0)
        x = int((cx + rx * rr * __import__('math').cos(a)) * scale)
        y = int((cy + ry * rr * __import__('math').sin(a)) * scale)
        pts.append([x, y])
    return pts


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    rng = random.Random(20261127)

    def case(name, w, h, region, gray_rng=None):
        d = os.path.join(OUT, name)
        os.makedirs(d, exist_ok=True)
        gr = gray_rng or random.Random(hash(name) & 0xffffffff)
        write_pgm(os.path.join(d, 'gray.pgm'), w, h, gr)
        with open(os.path.join(d, 'region.json'), 'w') as f:
            json.dump(region, f)
        manifest.append(name)

    # 1. axis-aligned region covering full and partial cells, with a hole
    case('aligned_hole', 8, 6, {
        'outer': rect(16, 16, 7 * 16, 5 * 16),
        'holes': [rect(3 * 16, 2 * 16, 5 * 16, 4 * 16)],
    })

    # 2. subpixel diagonal quadrilateral inside one image
    case('diagonal_small', 6, 5, {
        'outer': [[7, 9], [71, 13], [80, 60], [11, 66]], 'holes': []})

    # 3. region extending well beyond the image on every side
    case('overflow', 4, 4, {
        'outer': [[-40, -30], [90, -10], [110, 80], [-20, 95]], 'holes': []})

    # 4. triangle with vertices on pixel corners and mid-edges
    case('triangle', 5, 5, {
        'outer': [[0, 0], [5 * 16, 2 * 16 + 8], [8, 5 * 16]], 'holes': []})

    # 5. multiple holes, slanted outer, some vertices outside
    case('multi_hole', 12, 9, {
        'outer': [[-20, 30], [150, 10], [200, 120], [40, 150]],
        'holes': [
            convex_ring(5, 3.2, 2.6, 1.1, 0.9, rng),
            convex_ring(6, 8.4, 6.1, 1.3, 1.0, rng),
        ],
    })

    # 6. thin slanted strip (the motivating jumpy-centroid case)
    case('thin_strip', 10, 3, {
        'outer': [[16, 20], [9 * 16, 21], [9 * 16, 26], [16, 25]], 'holes': []})

    # 7. region entirely outside the image -> zero mass
    case('all_outside', 4, 4, {
        'outer': rect(20 * 16, 20 * 16, 24 * 16, 24 * 16), 'holes': []})

    # 8. region covering the whole image exactly
    case('full_cover', 6, 4, {
        'outer': rect(0, 0, 6 * 16, 4 * 16), 'holes': []})

    # 9-16. randomized convex polygons with 0-3 holes, varied sizes
    for k in range(8):
        w = rng.randrange(4, 18)
        h = rng.randrange(4, 18)
        n = rng.randrange(3, 9)
        outer = convex_ring(n, w / 2, h / 2, w * 0.75, h * 0.75, rng)
        # let some vertices wander outside the image
        if k % 2 == 0:
            outer = [[x + rng.randrange(-40, 40), y + rng.randrange(-40, 20)] for x, y in outer]
        holes = []
        nh = rng.randrange(0, 3)
        for _ in range(nh):
            hc = convex_ring(rng.randrange(3, 6),
                             rng.uniform(w * 0.3, w * 0.7),
                             rng.uniform(h * 0.3, h * 0.7),
                             rng.uniform(0.4, 1.0), rng.uniform(0.4, 1.0), rng)
            holes.append(hc)
        # random holes may violate containment; keep only cases the validator
        # accepts (verified later in JS), otherwise drop the holes
        case(f'random_{k}', w, h, {'outer': outer, 'holes': holes},
             gray_rng=random.Random(9000 + k))

    # 17. larger image for performance: 256x256, many-sided slanted polygon
    big_rng = random.Random(4242)
    big_outer = convex_ring(64, 128, 128, 120, 110, big_rng)
    case('perf_256', 256, 256, {'outer': big_outer, 'holes': []},
         gray_rng=random.Random(7777))

    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print('\n'.join(manifest))


if __name__ == '__main__':
    main()
