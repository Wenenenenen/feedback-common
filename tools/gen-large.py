#!/usr/bin/env python3
"""生成 1800 帧、累计 ≤ 2500 万像素的合成样本 ZIP（用于端到端/性能验证）。

横纵位移按不同周期变化，每隔若干帧加固定偏移；在 900 帧处硬切为两个镜头，
因此两镜头各自平滑；部分镜头边界达到饱和。

运行：python3 tools/gen-large.py [输出路径]
默认输出 test-output/large-1800.zip。
"""
import json
import math
import os
import sys
import zipfile

W, H = 154, 88
N = 1800
assert W * H * N <= 25_000_000, '像素预算超限'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'test-output', 'large-1800.zip')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# 硬切点：两个镜头，两侧独立平滑
CUTS = [900]
# 每帧的整体平移（相机抖动）：两个不同周期 + 固定偏移台阶
def shift(t):
    sec = 0 if t < 900 else 1
    dx = 6.0 * math.sin(t * 0.021) + 3.0 * math.sin(t * 0.11) + (0.0 if sec == 0 else 2.5)
    dy = 4.0 * math.cos(t * 0.017) + 2.0 * math.sin(t * 0.09) + (0.0 if sec == 1 else -2.0)
    # 周期性固定偏移，制造贴界
    if t % 50 < 6:
        dx += 6.0
    if t % 70 < 5:
        dy -= 5.0
    return dx, dy


# 背景纹理（横向与纵向斜率不同的彩色坡度 + 一些结构），用于确认取样正确
def make_frame(dx, dy):
    rows = bytearray(W * H * 3)
    ix = int(round(dx))
    iy = int(round(dy))
    o = 0
    for y in range(H):
        baseG = ((y * 3) % 256)
        for x in range(W):
            sx = x + ix
            sy = y + iy
            r = (sx * 5 + sy * 2) % 256
            g = (baseG + sx * 3) % 256
            b = (sy * 7 + 40) % 256
            rows[o] = r
            rows[o + 1] = g
            rows[o + 2] = b
            o += 3
    return bytes(rows)


# 点对：点坐标随画幅内容平移；离群点（跟到背景上）偶尔出现
BASE_PTS = [(12 + (k % 8) * 17, 8 + (k // 8) * 10) for k in range(48)]


def main():
    names = []
    pairs = [[]]
    prev = shift(0)
    frames = []
    for t in range(N):
        names.append(f'frames/{t:04d}.ppm')
        frames.append((shift(t),))
    # 逐帧差：pairs[t] 描述 t-1 → t
    for t in range(1, N):
        if t in CUTS:
            pairs.append([])
            continue
        dx0, dy0 = shift(t - 1)
        dx1, dy1 = shift(t)
        pts = []
        for (x, y) in BASE_PTS:
            pts.append([x, y, x + (dx1 - dx0), y + (dy1 - dy0)])
        # 每 11 帧一个背景离群点（位移差很大）
        if t % 11 == 0:
            pts.append([5, 5, 5 + 70, 5 - 55])
        pairs.append(pts)

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for t in range(N):
            dx, dy = shift(t)
            z.writestr(names[t], f'P6\n{W} {H}\n255\n'.encode() + make_frame(dx, dy))
        man = {
            'frames': names,
            'pairs': pairs,
            'cuts': CUTS,
            'threshold': 1.5,
            'crop': [140, 70],
            'margin': 1,
            'pins': [],
            'lambda': 25,
        }
        z.writestr('manifest.json', json.dumps(man))
        z.writestr('说明.txt', '1800 帧合成样本，154×88，累计 24.4 M 像素，900 帧硬切为两镜头。')
    size = os.path.getsize(OUT)
    print(f'wrote {OUT} ({size / 1e6:.1f} MB), {N} frames, {W}×{H}, {W*H*N/1e6:.2f} M px, cuts={CUTS}')


if __name__ == '__main__':
    main()
