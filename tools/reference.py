#!/usr/bin/env python3
"""独立参考实现：与 js/ 下的实现逐一对照。

- 跟踪：中位数筛离群、内点重估、轨迹累加、切镜（按约定逐字实现）
- 拟合：用不同的算法（稠密 KKT + 三态活跃集穷举之外，直接跑 dense projected
  gradient 与枚举活跃集）求每镜头每轴最优，生成对照数据
- 裁剪：独立写一遍双线性公式，导出裁后图 SHA-256

输出 tools/reference.json。运行：python3 tools/reference.py
"""
import base64
import hashlib
import json
import math
import os
import statistics
import sys
import zipfile

try:
    import numpy as np
except ImportError as e:
    print('需要 numpy:', e, file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, 'samples', 'stabilized-aperture-cases.zip')
OUT = os.path.join(ROOT, 'tools', 'reference.json')


def read_sample():
    with zipfile.ZipFile(SAMPLE) as z:
        names = z.namelist()
        manifest = json.loads(z.read('manifest.json'))
        frames = []
        for name in manifest['frames']:
            raw = z.read(name)
            assert raw[:2] == b'P6'
            parts = raw.split(b'\n', 3)
            w, h = map(int, parts[1].split())
            data = np.frombuffer(parts[3], np.uint8).reshape(h, w, 3)
            frames.append(data)
    return manifest, frames


def median_py(vals):
    return statistics.median(vals)


# ---------------------------------------------------------------- tracking

def track(man):
    n = len(man['frames'])
    cuts = set(man.get('cuts', []))
    th = man.get('threshold', 0)
    pairs = man['pairs']
    px = [0.0] * n
    py = [0.0] * n
    shots = []
    shot_start = 0
    shot = 0
    for t in range(1, n):
        if t in cuts:
            if t > shot_start:
                shots.append((shot_start, t))
                shot += 1
            shot_start = t
            px[t] = 0.0
            py[t] = 0.0
            continue
        pts = pairs[t]
        if not pts:
            if t > shot_start:
                shots.append((shot_start, t))
                shot += 1
            shot_start = t
            px[t] = 0.0
            py[t] = 0.0
            continue
        dx = [p[2] - p[0] for p in pts]
        dy = [p[3] - p[1] for p in pts]
        mx = median_py(dx)
        my = median_py(dy)
        inl = [(a, b) for a, b in zip(dx, dy) if abs(a - mx) <= th and abs(b - my) <= th]
        if len(inl) < 3:
            if t > shot_start:
                shots.append((shot_start, t))
                shot += 1
            shot_start = t
            px[t] = 0.0
            py[t] = 0.0
            continue
        mx2 = median_py([a for a, b in inl])
        my2 = median_py([b for a, b in inl])
        px[t] = px[t - 1] + mx2
        py[t] = py[t - 1] + my2
    shots.append((shot_start, n))
    return px, py, shots


# ---------------------------------------------------------------- QP

def dense_H(m, lam):
    H = np.eye(m)
    if lam != 0 and m >= 3:
        D = np.zeros((m - 2, m))
        for r in range(m - 2):
            D[r, r] = 1
            D[r, r + 1] = -2
            D[r, r + 2] = 1
        H = H + lam * (D.T @ D)
    return H, (None if lam == 0 or m < 3 else D)


def solve_axis_dense(p, lam, bound, pins):
    """三态活跃集：状态自由/上界/下界/固定；每步解 reduced dense 子问题。"""
    m = len(p)
    if m == 0:
        return np.zeros(0), 0.0
    p = np.asarray(p, dtype=float)
    H, D = dense_H(m, lam)
    b = np.zeros(m) if D is None else lam * (D.T @ (D @ p))
    u = np.zeros(m)
    state = np.zeros(m, dtype=int)  # 0 free, 1 upper, -1 lower, 2 pinned
    pinned_val = {}
    for pin in pins:
        state[pin['index']] = 2
        u[pin['index']] = pin['value']
        pinned_val[pin['index']] = pin['value']
    if bound == 0:
        return u, objective(p, u, lam)
    if m < 3:
        return u, objective(p, u, lam)
    # feasible start
    for i in range(m):
        if state[i] == 0:
            u[i] = min(bound, max(-bound, p[i]))
    for _ in range(1000 * max(1, m) + 100):
        # fixed part
        uf = np.zeros(m)
        for i in range(m):
            if state[i] == 2:
                uf[i] = pinned_val[i]
            elif state[i] == 1:
                uf[i] = bound
            elif state[i] == -1:
                uf[i] = -bound
        free = [i for i in range(m) if state[i] == 0]
        if free:
            Hf = H[np.ix_(free, free)]
            rhs = b[free] - H[np.ix_(free, [i for i in range(m)])] @ uf
            sol = np.linalg.solve(Hf, rhs)
            cand = uf.copy()
            cand[free] = sol
        else:
            cand = uf
        # bounds check on free
        blocked = None
        best = float('inf')
        sign = 0
        for i in free:
            if cand[i] > bound + 1e-12:
                denom = cand[i] - u[i]
                ratio = (bound - u[i]) / denom if denom > 0 else 0.0
                if ratio < best - 1e-15:
                    best, blocked, sign = ratio, i, 1
            elif cand[i] < -bound - 1e-12:
                denom = cand[i] - u[i]
                ratio = (-bound - u[i]) / denom if denom < 0 else 0.0
                if ratio < best - 1e-15:
                    best, blocked, sign = ratio, i, -1
        if blocked is not None:
            alpha = min(1.0, max(0.0, best))
            u = u + alpha * (cand - u)
            u[blocked] = bound if sign > 0 else -bound
            state[blocked] = sign
            for i in range(m):
                if state[i] == 0:
                    u[i] = min(bound, max(-bound, u[i]))
            continue
        u = cand
        g = H @ u - b
        worst = None
        worst_val = 0.0
        for i in range(m):
            if state[i] == 1 and g[i] > 1e-12 and g[i] > worst_val:
                worst, worst_val = i, g[i]
            elif state[i] == -1 and -g[i] > 1e-12 and -g[i] > worst_val:
                worst, worst_val = i, -g[i]
        if worst is None:
            return u, objective(p, u, lam)
        state[worst] = 0
    raise RuntimeError('active set did not converge')


def objective(p, u, lam):
    p = np.asarray(p); u = np.asarray(u)
    e = float(np.sum(u * u))
    if lam and len(p) >= 3:
        q = p - u
        d2 = q[:-2] - 2 * q[1:-1] + q[2:]
        e += lam * float(np.sum(d2 * d2))
    return e


def fit(px, py, shots, W, H, cropW, cropH, margin, lam, pins):
    bx = (W - cropW) / 2 - margin
    by = (H - cropH) / 2 - margin
    if bx < 0 or by < 0:
        return None
    ux = [0.0] * len(px)
    uy = [0.0] * len(py)
    for (s, e) in shots:
        pXs = px[s:e]
        pYs = py[s:e]
        pinX = [{'index': p['frame'] - s, 'value': p['x']} for p in pins if s <= p['frame'] < e]
        pinY = [{'index': p['frame'] - s, 'value': p['y']} for p in pins if s <= p['frame'] < e]
        uX, _ = solve_axis_dense(pXs, lam, bx, pinX)
        uY, _ = solve_axis_dense(pYs, lam, by, pinY)
        for i in range(e - s):
            ux[s + i] = uX[i]
            uy[s + i] = uY[i]
    return ux, uy


# ---------------------------------------------------------------- crop

def render_crop(src, cropW, cropH, ux, uy):
    H, W, _ = src.shape
    out = np.zeros((cropH, cropW, 3), np.uint8)
    baseX = (W - cropW) / 2 + ux
    baseY = (H - cropH) / 2 + uy
    xs = np.arange(cropW) + baseX
    ys = np.arange(cropH) + baseY
    for oy, sy in enumerate(ys):
        y0 = math.floor(sy)
        fy = sy - y0
        y0c = min(max(y0, 0), H - 1)
        y1c = min(max(y0 + 1, 0), H - 1)
        if y0 < 0: fy = 0.0
        if y0 > H - 1: fy = 0.0
        for ox, sx in enumerate(xs):
            x0 = math.floor(sx)
            fx = sx - x0
            x0c = min(max(x0, 0), W - 1)
            x1c = min(max(x0 + 1, 0), W - 1)
            if x0 < 0: fx = 0.0
            if x0 > W - 1: fx = 0.0
            for c in range(3):
                v = (src[y0c, x0c, c] * (1 - fx) * (1 - fy) + src[y0c, x1c, c] * fx * (1 - fy)
                     + src[y1c, x0c, c] * (1 - fx) * fy + src[y1c, x1c, c] * fx * fy)
                out[oy, ox, c] = int(math.floor(v + 0.5))
    return out


def sha(img):
    return hashlib.sha256(img.tobytes()).hexdigest()


# ---------------------------------------------------------------- cases

def synth_manifest(n, seed=7, cuts=None):
    """合成点对：缓慢正弦位移 + 少量离群点。"""
    rng = np.random.default_rng(seed)
    pairs = [[]]
    dxs = np.round(np.sin(np.arange(n) * 0.07) * 1.6, 3)
    dys = np.round(np.cos(np.arange(n) * 0.05) * 1.2, 3)
    for t in range(1, n):
        base = [[10, 10], [30, 12], [44, 30], [16, 26], [22, 18]]
        pts = []
        for (x, y) in base:
            pts.append([x, y, x + dxs[t], y + dys[t]])
        if t % 5 == 0:
            pts.append([5, 5, 5 + dxs[t] + 50.0, 5 + dys[t] - 40.0])  # 离群（背景）
        pairs.append(pts)
    return {
        'frames': [f'f{t:04d}.ppm' for t in range(n)],
        'pairs': pairs,
        'cuts': cuts or [],
        'threshold': 1.5,
        'crop': [56, 36],
        'margin': 1,
        'pins': [],
        'lambda': 25,
    }


def main():
    man, frames = read_sample()
    H, W = frames[0].shape[:2]
    px, py, shots = track(man)
    pins = man.get('pins', [])
    lam = man['lambda']
    cropW, cropH = man['crop']
    margin = man['margin']
    ux, uy = fit(px, py, shots, W, H, cropW, cropH, margin, lam, pins)

    cases = []
    cases.append({
        'name': 'sample-default',
        'manifest': man,
        'lambda': lam,
        'margin': margin,
        'pins': pins,
        'crop': [cropW, cropH],
        'p': [px, py],
        'shots': shots,
        'ux': ux,
        'uy': uy,
        'boundX': (W - cropW) / 2 - margin,
        'boundY': (H - cropH) / 2 - margin,
        'crops': [sha(render_crop(frames[t], cropW, cropH, ux[t], uy[t])) for t in range(len(frames))],
    })

    # 参数变体（与默认相同的点对/帧）
    variants = [
        {'lambda': 0, 'margin': 1, 'pins': [{'frame': 2, 'x': 0.25, 'y': -0.25}]},
        {'lambda': 1, 'margin': 0, 'pins': []},
        {'lambda': 10000, 'margin': 2, 'pins': [{'frame': 0, 'x': 1.5, 'y': -1.0}]},
        {'lambda': 3.5, 'margin': 0, 'pins': [{'frame': 1, 'x': -0.7, 'y': 0.3}, {'frame': 4, 'x': 0.5, 'y': 0.5}]},
    ]
    for i, over in enumerate(variants):
        m2 = dict(man)
        m2.update(over)
        lx, ly = over['lambda'], over['margin']
        px2, py2, sh2 = px, py, shots
        bx = (W - cropW) / 2 - ly
        by = (H - cropH) / 2 - ly
        ux2, uy2 = fit(px2, py2, sh2, W, H, cropW, cropH, ly, lx, over['pins'])
        cases.append({
            'name': f'variant-{i}',
            'lambda': lx,
            'margin': ly,
            'pins': over['pins'],
            'crop': [cropW, cropH],
            'p': [px2, py2],
            'shots': sh2,
            'ux': ux2,
            'uy': uy2,
            'boundX': bx,
            'boundY': by,
            'crops': [sha(render_crop(frames[t], cropW, cropH, ux2[t], uy2[t])) for t in range(len(frames))],
        })

    # 合成用例：镜头、离群、紧边界
    synth = [
        {'n': 24, 'cuts': [8, 17], 'lambda': 25, 'margin': 0, 'crop': [56, 36]},
        {'n': 40, 'cuts': [], 'lambda': 10000, 'margin': 1, 'crop': [52, 32]},
        {'n': 60, 'cuts': [20, 40], 'lambda': 0, 'margin': 2, 'crop': [48, 30],
         'pins': [{'frame': 5, 'x': 0.4, 'y': -0.4}, {'frame': 50, 'x': -0.2, 'y': 0.1}]},
    ]
    for i, s in enumerate(synth):
        m3 = synth_manifest(s['n'], seed=100 + i, cuts=s['cuts'])
        m3['lambda'] = s['lambda']
        m3['margin'] = s['margin']
        m3['crop'] = s['crop']
        m3['pins'] = s.get('pins', [])
        p3x, p3y, sh3 = track(m3)
        cw, ch = s['crop']
        ux3, uy3 = fit(p3x, p3y, sh3, W, H, cw, ch, s['margin'], s['lambda'], m3['pins'])
        cases.append({
            'name': f'synth-{i}',
            'manifest': m3,
            'lambda': s['lambda'],
            'margin': s['margin'],
            'pins': m3['pins'],
            'crop': s['crop'],
            'p': [p3x, p3y],
            'shots': sh3,
            'ux': ux3,
            'uy': uy3,
            'boundX': (W - cw) / 2 - s['margin'],
            'boundY': (H - ch) / 2 - s['margin'],
            'crops': [],
        })

    data = {
        'width': W,
        'height': H,
        'cases': cases,
    }
    with open(OUT, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f'wrote {OUT} with {len(cases)} cases')
    print('sample p:', [round(v, 6) for v in px])
    print('sample ux:', [round(v, 12) for v in ux])
    print('sample shots:', shots)


if __name__ == '__main__':
    main()
