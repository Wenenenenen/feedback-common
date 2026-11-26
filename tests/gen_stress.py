#!/usr/bin/env python3
"""满额压力用例：256x256、12 帧、高饱和率、掩膜、含同轴相反方向。标准库。"""
import json
import math
import os
import random
import struct
import sys

DIRS = [(5, 0), (-5, 0), (0, 5), (0, -5), (3, 4), (3, -4), (-3, 4), (-3, -4),
        (4, 3), (4, -3), (-4, 3), (-4, -3)]


def write_gray(path, w, h, vals):
    with open(path, 'wb') as f:
        f.write(f'P5\n{w} {h}\n65535\n'.encode())
        f.write(struct.pack('>' + 'H' * len(vals), *vals))


def write_mask(path, w, h, vals):
    with open(path, 'wb') as f:
        f.write(f'P5\n{w} {h}\n255\n'.encode())
        f.write(bytes(vals))


def gen(out_dir, w=256, h=256, n=12):
    rng = random.Random(777)
    os.makedirs(os.path.join(out_dir, 'frames'), exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'masks'), exist_ok=True)
    N = w * h
    chosen = DIRS[:n]
    gains = [4, 4, 4, 4, 8, 9, 2, 16, 5, 12, 3, 7][:n]
    offsets = [0, 0, 120, -80, 320, -140, 50, -200, 90, -60, 200, -300][:n]
    weights = [1, 1, 2, 1, 2, 1, 3, 1, 2, 1, 4, 2][:n]
    mask_flags = [False, True, False, False, True, False, False, True, False, False, True, False][:n]
    frames = [{'u': chosen[i][0], 'v': chosen[i][1], 'gain': gains[i],
               'offset': offsets[i], 'weight': weights[i], 'mask': mask_flags[i]} for i in range(n)]
    truth = []
    for px in range(N):
        s0 = rng.uniform(500, 40000)
        dop = rng.choice([0.0, rng.uniform(0, 0.4), rng.uniform(0.4, 0.95), 1.0])
        ang = rng.uniform(0, math.pi)
        pol = s0 * dop
        truth.append((s0, pol * math.cos(2 * ang), pol * math.sin(2 * ang)))
    sat = [0, 0]
    for i in range(n):
        u, v = chosen[i]
        g = gains[i] / 4.0
        vals = []
        for px in range(N):
            s0, s1, s2 = truth[px]
            p = offsets[i] + g * (s0 + (u * s1 + v * s2) / 5.0)
            if p >= 65535:
                vals.append(65535); sat[0] += 1
            elif p <= 0:
                vals.append(0); sat[1] += 1
            else:
                vals.append(min(65534, max(1, int(round(p + rng.gauss(0, 5))))))
        write_gray(os.path.join(out_dir, 'frames', f'{i:02d}.pgm'), w, h, vals)
        if mask_flags[i]:
            mv = [255 if rng.random() > 0.15 else 0 for _ in range(N)]
            write_mask(os.path.join(out_dir, 'masks', f'{i:02d}.pgm'), w, h, mv)
    with open(os.path.join(out_dir, 'case.json'), 'w', encoding='utf-8') as f:
        json.dump({'width': w, 'height': h, 'frames': frames}, f, ensure_ascii=False)
    print('stress case', w, 'x', h, n, 'frames, saturation upper/lower:', sat)


if __name__ == '__main__':
    gen(sys.argv[1])
