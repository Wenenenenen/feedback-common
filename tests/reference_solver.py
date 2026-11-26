#!/usr/bin/env python3
"""独立参考求解器 v2：枚举饱和帧主动集 + 锥边界黄金分割精确搜索，仅用标准库。
与 JS 实现完全独立：JS 用迭代主动集，这里枚举全部饱和帧子集。
用法: python3 -I reference_solver.py <case_dir> <out.json>
"""
import json
import math
import os
import sys


def read_pgm_gray(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:2] == b'P5'
    pos = 2
    toks = []
    while len(toks) < 3:
        while data[pos] in b' \t\n\r\x0b\x0c':
            pos += 1
        start = pos
        while data[pos] not in b' \t\n\r\x0b\x0c':
            pos += 1
        toks.append(int(data[start:pos]))
    pos += 1
    w, h, mx = toks
    assert mx == 65535
    vals = [(data[pos + 2 * i] << 8) | data[pos + 2 * i + 1] for i in range(w * h)]
    return w, h, vals


def read_pgm_mask(path, w, h):
    with open(path, 'rb') as f:
        data = f.read()
    pos = 2
    toks = []
    while len(toks) < 3:
        while data[pos] in b' \t\n\r\x0b\x0c':
            pos += 1
        start = pos
        while data[pos] not in b' \t\n\r\x0b\x0c':
            pos += 1
        toks.append(int(data[start:pos]))
    pos += 1
    assert toks[:2] == [w, h] and toks[2] == 255
    return list(data[pos:pos + w * h])


def solve3(H, rhs):
    a = [list(row) for row in H]
    b = list(rhs)
    for i in range(3):
        piv = max(range(i, 3), key=lambda r: abs(a[r][i]))
        if abs(a[piv][i]) < 1e-14:
            return None
        a[i], a[piv] = a[piv], a[i]
        b[i], b[piv] = b[piv], b[i]
        for r in range(i + 1, 3):
            f = a[r][i] / a[i][i]
            for c in range(i, 3):
                a[r][c] -= f * a[i][c]
            b[r] -= f * b[i]
    x = [0.0, 0.0, 0.0]
    for i in range(2, -1, -1):
        x[i] = (b[i] - sum(a[i][j] * x[j] for j in range(i + 1, 3))) / a[i][i]
    return x


def main():
    case_dir, out_path = sys.argv[1], sys.argv[2]
    with open(os.path.join(case_dir, 'case.json'), encoding='utf-8') as f:
        spec = json.load(f)
    w, h = spec['width'], spec['height']
    frames = spec['frames']
    n = len(frames)
    images, masks = [], []
    for i in range(n):
        pw, ph, vals = read_pgm_gray(os.path.join(case_dir, 'frames', f'{i:02d}.pgm'))
        assert (pw, ph) == (w, h)
        images.append(vals)
        if frames[i].get('mask', False):
            masks.append(read_pgm_mask(os.path.join(case_dir, 'masks', f'{i:02d}.pgm'), w, h))
        else:
            masks.append(None)

    g = [fr['gain'] / 4.0 for fr in frames]
    a1 = [g[i] * frames[i]['u'] / 5.0 for i in range(n)]
    a2 = [g[i] * frames[i]['v'] / 5.0 for i in range(n)]
    off = [float(fr['offset']) for fr in frames]
    wt = [float(fr['weight']) for fr in frames]

    pixels = [None] * (w * h)
    objectives = [None] * (w * h)

    for px in range(w * h):
        idx, kind, ms = [], [], []
        dirs = set()
        for i in range(n):
            if masks[i] is not None and masks[i][px] != 255:
                continue
            m = images[i][px]
            if m == 0:
                k = 1
            elif m == 65535:
                k = 2
            else:
                k = 0
                dirs.add((frames[i]['u'], frames[i]['v']))
            idx.append(i)
            kind.append(k)
            ms.append(m)
        if len(dirs) < 3:
            continue
        K = len(idx)
        b = []
        for t in range(K):
            fi = idx[t]
            if kind[t] == 0:
                b.append(ms[t] - off[fi])
            elif kind[t] == 1:
                b.append(-off[fi])
            else:
                b.append(65535.0 - off[fi])

        def full_obj(x):
            tot = 0.0
            for t in range(K):
                fi = idx[t]
                ax = g[fi] * x[0] + a1[fi] * x[1] + a2[fi] * x[2]
                if kind[t] == 0:
                    r = ax - b[t]
                elif kind[t] == 1:
                    r = max(0.0, ax + off[fi])
                else:
                    r = min(0.0, ax + off[fi] - 65535.0)
                tot += wt[fi] * r * r
            return tot

        sat = [t for t in range(K) if kind[t] != 0]
        best = [None, float('inf')]
        GR = (math.sqrt(5.0) - 1.0) / 2.0

        def boundary_solve(active_mask):
            # x = s0(1,cosθ,sinθ)；对 θ 做全局粗扫 + 每格黄金分割
            NTH = 128
            cell = math.pi / NTH
            coarse = []
            for q in range(NTH):
                th = cell * (q + 0.5)
                ct, st = math.cos(th), math.sin(th)
                num = den = 0.0
                for t in range(K):
                    if not (active_mask & (1 << t)):
                        continue
                    fi = idx[t]
                    alpha = g[fi] + a1[fi] * ct + a2[fi] * st
                    num += wt[fi] * alpha * b[t]
                    den += wt[fi] * alpha * alpha
                s0 = max(0.0, num / den) if den > 0 else 0.0
                obj = 0.0
                for t in range(K):
                    if not (active_mask & (1 << t)):
                        continue
                    fi = idx[t]
                    alpha = g[fi] + a1[fi] * ct + a2[fi] * st
                    rr = s0 * alpha - b[t]
                    obj += wt[fi] * rr * rr
                coarse.append((obj, q))
            coarse.sort()
            # 在最优的 3 个粗格内做黄金分割
            for _, q in coarse[:3]:
                lo, hi = cell * q, cell * (q + 1)
                c = hi - GR * (hi - lo)
                d = lo + GR * (hi - lo)

                def ftheta(th):
                    ct2, st2 = math.cos(th), math.sin(th)
                    num2 = den2 = 0.0
                    for t in range(K):
                        if not (active_mask & (1 << t)):
                            continue
                        fi = idx[t]
                        al = g[fi] + a1[fi] * ct2 + a2[fi] * st2
                        num2 += wt[fi] * al * b[t]
                        den2 += wt[fi] * al * al
                    s0v = max(0.0, num2 / den2) if den2 > 0 else 0.0
                    o = 0.0
                    for t in range(K):
                        if not (active_mask & (1 << t)):
                            continue
                        fi = idx[t]
                        al = g[fi] + a1[fi] * ct2 + a2[fi] * st2
                        rr = s0v * al - b[t]
                        o += wt[fi] * rr * rr
                    return o, s0v

                fc, sc = ftheta(c)
                fd, sd = ftheta(d)
                for _ in range(60):
                    if fc < fd:
                        hi, d, fd, sd = d, c, fc, sc
                        c = hi - GR * (hi - lo)
                        fc, sc = ftheta(c)
                    else:
                        lo, c, fc, sc = c, d, fc, fd
                        d = lo + GR * (hi - lo)
                        fd, sd = ftheta(d)
                th = (lo + hi) / 2.0
                _, s0f = ftheta(th)
                yield [s0f, s0f * math.cos(th), s0f * math.sin(th)]

        def feasible(x, active_mask):
            for t in sat:
                if not (active_mask & (1 << t)):
                    continue
                fi = idx[t]
                ax = g[fi] * x[0] + a1[fi] * x[1] + a2[fi] * x[2]
                if kind[t] == 1 and ax + off[fi] < -1e-7:
                    return False
                if kind[t] == 2 and ax + off[fi] - 65535.0 > 1e-7:
                    return False
            return True

        base = 0
        for t in range(K):
            if kind[t] == 0:
                base |= (1 << t)
        for sub in range(1 << len(sat)):
            mask = base
            for j, t in enumerate(sat):
                if sub & (1 << j):
                    mask |= (1 << t)
            H = [[0.0] * 3 for _ in range(3)]
            rhs = [0.0, 0.0, 0.0]
            for t in range(K):
                if not (mask & (1 << t)):
                    continue
                fi = idx[t]
                cvec = (g[fi], a1[fi], a2[fi])
                for r2 in range(3):
                    for c2 in range(3):
                        H[r2][c2] += wt[fi] * cvec[r2] * cvec[c2]
                    rhs[r2] += wt[fi] * cvec[r2] * b[t]
            xi = solve3(H, rhs)
            cands = []
            if xi is not None and xi[0] > math.hypot(xi[1], xi[2]):
                cands.append(xi)
            cands.extend(boundary_solve(mask))
            for xc in cands:
                if not feasible(xc, mask):
                    continue
                o = full_obj(xc)
                if o < best[1]:
                    best = [xc, o]

        assert best[0] is not None
        pixels[px] = best[0]
        objectives[px] = best[1]

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'width': w, 'height': h, 'pixels': pixels,
                   'objective': objectives}, f)
    print('wrote', out_path, 'solved:', sum(1 for p in pixels if p is not None),
          '/', w * h)


if __name__ == '__main__':
    main()
