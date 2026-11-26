#!/usr/bin/env python3
"""合成测试用例生成器（标准库），输出符合输入约定的 ZIP 目录。
覆盖：上/下饱和、增益偏移、权重、掩膜、重复方向帧、方向不足无解。
用法: python3 -I gen_cases.py <out_dir>
"""
import json
import math
import os
import random
import struct
import sys

DIRS = [(5, 0), (-5, 0), (0, 5), (0, -5), (3, 4), (3, -4), (-3, 4), (-3, -4),
        (4, 3), (4, -3), (-4, 3), (-4, -3)]


def write_gray_pgm(path, w, h, vals):
    with open(path, 'wb') as f:
        f.write(f'P5\n{w} {h}\n65535\n'.encode())
        f.write(struct.pack('>' + 'H' * len(vals), *vals))


def write_mask_pgm(path, w, h, vals):
    with open(path, 'wb') as f:
        f.write(f'P5\n{w} {h}\n255\n'.encode())
        f.write(bytes(vals))


def gen(out_dir):
    rng = random.Random(20261127)
    os.makedirs(os.path.join(out_dir, 'frames'), exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'masks'), exist_ok=True)
    w, h = 64, 48
    N = w * h
    n = 8
    # 选 8 个方向，其中含两对“同轴线相反方向”以及 (3,4)/(3,-4) 等
    chosen = [DIRS[i] for i in (0, 1, 2, 3, 4, 5, 8, 9)]
    gains = [4, 4, 4, 4, 8, 9, 2, 16]
    offsets = [0, 0, 120, -80, 320, -140, 50, -200]
    weights = [1, 1, 2, 1, 2, 1, 3, 1]
    mask_flags = [False, False, True, False, False, True, False, False]
    frames = []
    for i in range(n):
        u, v = chosen[i]
        frames.append({'u': u, 'v': v, 'gain': gains[i], 'offset': offsets[i],
                       'weight': weights[i], 'mask': mask_flags[i]})

    # 逐像素真实 Stokes：s0 >= sqrt(s1²+s2²)；部分像素完全偏振、部分接近无偏振
    truth = []
    for px in range(N):
        s0 = rng.uniform(800, 30000)
        dop = rng.choice([0.0, rng.uniform(0.0, 0.3), rng.uniform(0.3, 0.95), 1.0])
        ang = rng.uniform(0, math.pi)
        pol = s0 * dop
        s1 = pol * math.cos(2 * ang)
        s2 = pol * math.sin(2 * ang)
        truth.append((s0, s1, s2))

    images = []
    masks = []
    sat_counts = [0, 0]
    for i in range(n):
        u, v = chosen[i]
        g = gains[i] / 4.0
        vals = []
        for px in range(N):
            s0, s1, s2 = truth[px]
            p = offsets[i] + g * (s0 + (u * s1 + v * s2) / 5.0)
            # 小噪声（普通像素），饱和像素直接截断
            if p >= 65535:
                vals.append(65535)
                sat_counts[0] += 1
            elif p <= 0:
                vals.append(0)
                sat_counts[1] += 1
            else:
                noise = rng.gauss(0, 6.0)
                m = int(round(p + noise))
                vals.append(min(65534, max(1, m)))
        images.append(vals)
        if mask_flags[i]:
            mv = []
            for px in range(N):
                # 前 5 个像素：两个带掩膜帧全部掩掉（后续再令非掩膜帧饱和，确保无解）
                if px < 5:
                    mv.append(0)
                else:
                    mv.append(255 if rng.random() > 0.12 else 0)
            masks.append(mv)
        else:
            masks.append(None)

    # 制造一片上饱和区域：把一个亮斑在高增益帧(7, gain=16)推到 65535
    for py in range(10, 20):
        for pxx in range(10, 24):
            images[7][py * w + pxx] = 65535
    # 制造下饱和：帧 6 offset=50 gain=0.5，暗像素截断到 0
    for py in range(30, 40):
        for pxx in range(40, 56):
            images[6][py * w + pxx] = 0
    # 无解区域：像素 (44,5)-(44,9) 除帧 0、2 外全部上/下饱和，非饱和方向仅 2 个
    for pxx in range(5, 10):
        px = 44 * w + pxx
        for i in range(n):
            if i in (0, 2):
                continue
            images[i][px] = 65535 if i % 2 == 0 else 0
    # 前 5 个像素：带掩膜帧(2,5)已掩掉，再令非掩膜帧中仅帧 0、1 保持普通，
    # 其余全部饱和，使非饱和不同方向只有 2 个 -> 无解
    for px in range(5):
        for i in range(n):
            if mask_flags[i] or i in (0, 1):
                continue
            images[i][px] = 65535 if i % 2 == 0 else 0

    spec = {'width': w, 'height': h, 'frames': frames}
    with open(os.path.join(out_dir, 'case.json'), 'w', encoding='utf-8') as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)
    for i in range(n):
        write_gray_pgm(os.path.join(out_dir, 'frames', f'{i:02d}.pgm'), w, h, images[i])
        if mask_flags[i]:
            write_mask_pgm(os.path.join(out_dir, 'masks', f'{i:02d}.pgm'), w, h, masks[i])
    print('generated', out_dir, 'upper/lower saturation:', sat_counts)


if __name__ == '__main__':
    gen(sys.argv[1])
