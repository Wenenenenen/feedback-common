#!/usr/bin/env python3
"""
flow-inbetween-review 的独立 Python 参考实现。

与 app/engine.js 用不同的数据结构（按目的像素累积 list，而非链表），
用于逐像素、逐字节交叉验证。规则严格照 format.txt：
  1. 往返：floor(坐标+0.5) 选最近像素；越界 / 对方 z=0 /
     任一轴两侧有符号位移相加绝对值 > 8（1/8 像素单位）=> 未通过
  2. a 投影 p+t*f/8，b 投影 p+(1-t)*f/8，双线性四邻 + 时间权重
  3. zmin + 容差层内优先往返通过者；RGB 归一化加权，半整数向上取
  4. 空洞取补洞前曼哈顿最近非空像素，同距取行列号最小，全空黑
用法：
  python3 -I reference.py --case <dir> --out <dir> --steps 0,1,32,64 --tol 10
目录需含 a.ppm b.ppm a.bin b.bin。
"""
import argparse
import math
import os
import struct
import sys


def parse_ppm(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    if not data.startswith(b'P6\n'):
        raise ValueError(f'{path}: 不是 P6\\n 开头')
    i = 3

    def read_num():
        nonlocal i
        start = i
        while i < len(data) and 0x30 <= data[i] <= 0x39:
            i += 1
        if i == start:
            raise ValueError(f'{path}: 文件头缺数值')
        return int(data[start:i])

    w = read_num()
    if data[i] != 0x20:
        raise ValueError(f'{path}: 宽高间必须是空格')
    i += 1
    h = read_num()
    if data[i] != 0x0a:
        raise ValueError(f'{path}: 高度后必须换行')
    i += 1
    mx = read_num()
    if mx != 255:
        raise ValueError(f'{path}: 仅支持 maxval=255')
    if data[i] != 0x0a:
        raise ValueError(f'{path}: maxval 后必须换行')
    i += 1
    need = w * h * 3
    if len(data) - i != need:
        raise ValueError(
            f'{path}: 数据长度错配，需 {need} 实际 {len(data) - i}（可能截断或多余）')
    return w, h, data[i:i + need]


def parse_bin(path, w, h):
    with open(path, 'rb') as fh:
        data = fh.read()
    n = w * h
    if len(data) != n * 6:
        raise ValueError(f'{path}: 应有 {n * 6} 字节，实际 {len(data)}')
    dx = [0] * n
    dy = [0] * n
    z = [0] * n
    for k in range(n):
        dx[k], dy[k], z[k] = struct.unpack_from('<hhH', data, k * 6)
    return dx, dy, z


def round_trip(dx, dy, z, odx, ody, oz, w, h):
    n = w * h
    ok = bytearray(n)
    for p in range(n):
        if z[p] == 0:
            continue
        px, py = p % w, p // w
        fx = px + dx[p] / 8.0
        fy = py + dy[p] / 8.0
        qx = math.floor(fx + 0.5)
        qy = math.floor(fy + 0.5)
        if not (0 <= qx < w and 0 <= qy < h):
            continue
        q = qy * w + qx
        if oz[q] == 0:
            continue
        if abs(dx[p] + odx[q]) > 8 or abs(dy[p] + ody[q]) > 8:
            continue
        ok[p] = 1
    return ok


def render(ds, n, tol):
    w, h = ds['w'], ds['h']
    N = w * h
    t = n / 64.0
    contribs = [[] for _ in range(N)]

    def project(side):
        dx, dy, z = ds['flow' + side]
        ok = ds['pass' + side]
        rgb = ds['rgb' + side]
        time_w = (1.0 - t) if side == 'A' else t
        step = t if side == 'A' else (1.0 - t)
        for p in range(N):
            if z[p] == 0:
                continue
            px, py = p % w, p // w
            fx = px + (dx[p] / 8.0) * step
            fy = py + (dy[p] / 8.0) * step
            x0, y0 = math.floor(fx), math.floor(fy)
            ax, ay = fx - x0, fy - y0
            wxs = (1.0 - ax, ax)
            wys = (1.0 - ay, ay)
            for jy in range(2):
                gy = y0 + jy
                if not (0 <= gy < h):
                    continue
                for jx in range(2):
                    gx = x0 + jx
                    if not (0 <= gx < w):
                        continue
                    bil = wxs[jx] * wys[jy]
                    if bil == 0.0:
                        continue
                    cw = bil * time_w
                    if cw == 0.0:
                        continue
                    d = gy * w + gx
                    contribs[d].append((side, p, z[p], cw, ok[p]))

    project('A')
    project('B')

    out = bytearray(N * 3)
    cls = bytearray(N)
    zmin_arr = [0] * N
    nonempty = [False] * N

    for d in range(N):
        cs = contribs[d]
        if not cs:
            continue
        nonempty[d] = True
        zmin = min(c[2] for c in cs)
        zmin_arr[d] = zmin
        zhi = min(65535, zmin + tol)
        layer = [c for c in cs if zmin <= c[2] <= zhi]
        passed = [c for c in layer if c[4]]
        chosen = passed if passed else layer
        rs = gs = bs = ws = 0.0
        for side, src, zv, cw, _ok in chosen:
            rgb = ds['rgbA'] if side == 'A' else ds['rgbB']
            rs += rgb[src * 3] * cw
            gs += rgb[src * 3 + 1] * cw
            bs += rgb[src * 3 + 2] * cw
            ws += cw
        o = d * 3
        out[o] = min(255, max(0, math.floor(rs / ws + 0.5)))
        out[o + 1] = min(255, max(0, math.floor(gs / ws + 0.5)))
        out[o + 2] = min(255, max(0, math.floor(bs / ws + 0.5)))
        cls[d] = 1 if passed else 2

    # 两遍曼哈顿距离变换，同距取行列号最小
    INF = 0x7fffffff
    label = [-1] * N
    dist = [INF] * N
    for d in range(N):
        if nonempty[d]:
            label[d], dist[d] = d, 0

    def relax(d, nb):
        if label[nb] < 0:
            return
        nd = dist[nb] + 1
        if nd < dist[d] or (nd == dist[d] and label[nb] < label[d]):
            dist[d], label[d] = nd, label[nb]

    for y in range(h):
        row = y * w
        for x in range(w):
            d = row + x
            if dist[d] == 0:
                continue
            if y > 0:
                relax(d, d - w)
            if x > 0:
                relax(d, d - 1)
    for y in range(h - 1, -1, -1):
        row = y * w
        for x in range(w - 1, -1, -1):
            d = row + x
            if dist[d] == 0:
                continue
            if y + 1 < h:
                relax(d, d + w)
            if x + 1 < w:
                relax(d, d + 1)

    fill_src = [-1] * N
    for d in range(N):
        if nonempty[d]:
            continue
        src = label[d]
        if src < 0:
            cls[d] = 4
            continue
        fill_src[d] = src
        o, s = d * 3, src * 3
        out[o] = out[s]
        out[o + 1] = out[s + 1]
        out[o + 2] = out[s + 2]
        cls[d] = 3

    return bytes(out), bytes(cls), zmin_arr, fill_src


def write_ppm(path, rgb, w, h):
    with open(path, 'wb') as fh:
        fh.write(f'P6\n{w} {h}\n255\n'.encode())
        fh.write(rgb)


def write_p5(path, cls, w, h):
    with open(path, 'wb') as fh:
        fh.write(f'P5\n{w} {h}\n255\n'.encode())
        fh.write(cls)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--case', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--steps', required=True, help='逗号分隔档位 0..64')
    ap.add_argument('--tol', type=int, default=0)
    args = ap.parse_args()

    cdir = args.case
    wa, ha, rgb_a = parse_ppm(os.path.join(cdir, 'a.ppm'))
    wb, hb, rgb_b = parse_ppm(os.path.join(cdir, 'b.ppm'))
    if (wa, ha) != (wb, hb):
        raise SystemExit('两帧尺寸不一致')
    w, h = wa, ha
    adx, ady, az = parse_bin(os.path.join(cdir, 'a.bin'), w, h)
    bdx, bdy, bz = parse_bin(os.path.join(cdir, 'b.bin'), w, h)

    ds = {
        'w': w, 'h': h, 'rgbA': rgb_a, 'rgbB': rgb_b,
        'flowA': (adx, ady, az), 'flowB': (bdx, bdy, bz),
        'passA': round_trip(adx, ady, az, bdx, bdy, bz, w, h),
        'passB': round_trip(bdx, bdy, bz, adx, ady, az, w, h),
    }
    os.makedirs(args.out, exist_ok=True)
    for tok in args.steps.split(','):
        n = int(tok)
        if n == 0:
            rgb, cls = rgb_a, bytes(w * h)
        elif n == 64:
            rgb, cls = rgb_b, bytes(w * h)
        else:
            rgb, cls, _zm, _fs = render(ds, n, args.tol)
        write_ppm(os.path.join(args.out, f'frame_{n:02d}.ppm'), rgb, w, h)
        write_p5(os.path.join(args.out, f'class_{n:02d}.p5'), cls, w, h)
    print('reference wrote', args.steps, 'tol', args.tol, 'to', args.out)


if __name__ == '__main__':
    main()
