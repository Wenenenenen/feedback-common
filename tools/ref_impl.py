import json, math, sys

def load(path):
    with open(path) as f:
        return json.load(f)

def validate(d):
    errs = []
    W, H = d['width'], d['height']
    if not (isinstance(W, int) and isinstance(H, int) and W > 0 and H > 0):
        errs.append('width/height 必须为正整数')
    if W > 513 or H > 385:
        errs.append('尺寸超过 513x385 上限')
    dep = d['depth']
    if len(dep) != W * H:
        errs.append(f'深度数量 {len(dep)} != {W}*{H}={W*H}')
    for i, v in enumerate(dep):
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            errs.append(f'深度[{i}] 非有限数'); break
        if v < 0.0 or v > 1.0:
            errs.append(f'深度[{i}]={v} 超出 [0,1]'); break
    if d.get('mode') not in ('standard', 'reversed'):
        errs.append('mode 必须是 standard/reversed')
    M = d['view_projection']
    if len(M) != 16 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in M):
        errs.append('view_projection 必须是 16 个有限数')
    else:
        det = mat4_det(M)
        if abs(det) < 1e-12:
            errs.append('view_projection 奇异 (det=%g)' % det)
    for j, b in enumerate(d.get('boxes', [])):
        lo, hi = b['min'], b['max']
        if len(lo) != 3 or len(hi) != 3:
            errs.append(f'box[{j}] min/max 必须是 3 维')
        elif any(not (math.isfinite(a) and math.isfinite(c)) for a, c in zip(lo, hi)):
            errs.append(f'box[{j}] 含非有限数')
        elif any(lo[k] > hi[k] for k in range(3)):
            errs.append(f'box[{j}] min 分量大于 max')
    if len(d.get('boxes', [])) > 2000:
        errs.append('boxes 超过 2000 个')
    return errs

def mat4_det(m):
    a = [m[0:4], m[4:8], m[8:12], m[12:16]]
    def det3(b):
        return (b[0][0]*(b[1][1]*b[2][2]-b[1][2]*b[2][1])
              - b[0][1]*(b[1][0]*b[2][2]-b[1][2]*b[2][0])
              + b[0][2]*(b[1][0]*b[2][1]-b[1][1]*b[2][0]))
    return sum(((-1) ** c) * a[0][c] *
               det3([row[:c] + row[c+1:] for row in a[1:]]) for c in range(4))

def build_pyramid(depth, W, H, mode):
    levels = [(W, H, depth[:])]
    w, h, cur = W, H, depth
    while w > 1 or h > 1:
        nw, nh = math.ceil(w / 2), math.ceil(h / 2)
        nxt = [0.0] * (nw * nh)
        for ny in range(nh):
            for nx in range(nw):
                vals = []
                for dy in (0, 1):
                    for dx in (0, 1):
                        cx, cy = 2 * nx + dx, 2 * ny + dy
                        if cx < w and cy < h:
                            vals.append(cur[cy * w + cx])
                nxt[ny * nw + nx] = max(vals) if mode == 'standard' else min(vals)
        levels.append((nw, nh, nxt))
        w, h, cur = nw, nh, nxt
    return levels

def corners(b):
    lo, hi = b['min'], b['max']
    return [(lo[0] if sx == 0 else hi[0],
             lo[1] if sy == 0 else hi[1],
             lo[2] if sz == 0 else hi[2])
            for sz in (0, 1) for sy in (0, 1) for sx in (0, 1)]

def mul(M, p):
    x, y, z = p
    return (M[0]*x + M[1]*y + M[2]*z + M[3],
            M[4]*x + M[5]*y + M[6]*z + M[7],
            M[8]*x + M[9]*y + M[10]*z + M[11],
            M[12]*x + M[13]*y + M[14]*z + M[15])

def node_cover(levels, L, nx, ny):
    # 底向上对齐：沿子节点 2x2 分组一路映射到叶像素
    x0c, y0c = nx, ny
    x1c, y1c = nx + 1, ny + 1
    for k in range(L, 0, -1):
        w, h, _ = levels[k - 1]
        x0c, y0c = 2 * x0c, 2 * y0c
        x1c, y1c = min(2 * x1c, w), min(2 * y1c, h)
    return x0c, y0c, x1c, y1c

def query_pyramid(levels, x0, y0, x1, y1, mode):
    visited, used_vals = [], []
    top = len(levels) - 1
    def recurse(L, nx, ny):
        w, h, data = levels[L]
        cx0, cy0, cx1, cy1 = node_cover(levels, L, nx, ny)
        if cx1 <= x0 or cx0 >= x1 or cy1 <= y0 or cy0 >= y1:
            return
        val = data[ny * w + nx]
        visited.append({'level': L, 'x': nx, 'y': ny, 'value': val})
        full = cx0 >= x0 and cx1 <= x1 and cy0 >= y0 and cy1 <= y1
        if full or L == 0:
            used_vals.append(val)  # 完全包含则消费，边界下降到叶
            return
        cw, ch = levels[L - 1][0], levels[L - 1][1]
        for ddy in (0, 1):
            for ddx in (0, 1):
                cnx, cny = 2 * nx + ddx, 2 * ny + ddy
                if cnx < cw and cny < ch:
                    recurse(L - 1, cnx, cny)
    recurse(top, 0, 0)
    agg = max(used_vals) if mode == 'standard' else min(used_vals)
    return agg, visited

def query_exhaustive(depth, W, x0, y0, x1, y1, mode):
    vals = [depth[py * W + px] for py in range(y0, y1) for px in range(x0, x1)]
    return (max(vals) if mode == 'standard' else min(vals)), len(vals)

def cull(d):
    W, H, mode, M = d['width'], d['height'], d['mode'], d['view_projection']
    levels = build_pyramid(d['depth'], W, H, mode)
    results, tot_pyr, tot_exh = [], 0, 0
    for b in d['boxes']:
        cs = [mul(M, p) for p in corners(b)]
        # 先保护：相机内部/跨近裁面盒（透视下其角点可能同时落在多裁面外）
        if any(w <= 1e-9 for _, _, _, w in cs):
            results.append({'id': b['id'], 'status': 'visible', 'reason': 'w<=1e-9'}); continue
        # 跨近面 = 角点同时分布在近面两侧（只在一侧的盒由 outside 规则处理）
        if mode == 'standard':
            near_cross = (any(z < 0 for _, _, z, _ in cs) and
                          any(z >= 0 for _, _, z, _ in cs))
        else:
            near_cross = (any(z > w for _, _, z, w in cs) and
                          any(z <= w for _, _, z, w in cs))
        if near_cross:
            results.append({'id': b['id'], 'status': 'visible', 'reason': 'near-cross'}); continue
        # 再做完全同侧剔除（此时所有角 w>0 且都在近面内侧）
        planes = [0] * 6
        for x, y, z, w in cs:
            planes[0] += (x < -w); planes[1] += (x > w)
            planes[2] += (y < -w); planes[3] += (y > w)
            planes[4] += (z < 0);  planes[5] += (z > w)
        if any(c == 8 for c in planes):
            results.append({'id': b['id'], 'status': 'outside'}); continue
        ndc = [(x/w, y/w, z/w) for x, y, z, w in cs]
        pxs = [(nx + 1) * W / 2 for nx, _, _ in ndc]
        pys = [(1 - ny) * H / 2 for _, ny, _ in ndc]
        x0, x1 = math.floor(min(pxs)), math.ceil(max(pxs))
        y0, y1 = math.floor(min(pys)), math.ceil(max(pys))
        x0c, y0c = max(0, x0), max(0, y0)
        x1c, y1c = min(W, x1), min(H, y1)
        nd = (min(nz for _, _, nz in ndc) if mode == 'standard'
              else max(nz for _, _, nz in ndc))
        rect = [x0c, y0c, x1c, y1c]
        if x1c <= x0c or y1c <= y0c:
            results.append({'id': b['id'], 'status': 'visible', 'reason': 'empty-rect',
                            'rect': rect, 'near_depth': nd}); continue
        agg, visited = query_pyramid(levels, x0c, y0c, x1c, y1c, mode)
        exh, npix = query_exhaustive(d['depth'], W, x0c, y0c, x1c, y1c, mode)
        tot_pyr += len(visited); tot_exh += npix
        occ = (nd > agg + 1e-6) if mode == 'standard' else (nd < agg - 1e-6)
        results.append({'id': b['id'], 'status': 'occluded' if occ else 'visible',
                        'rect': rect, 'near_depth': nd, 'agg': agg, 'exh': exh,
                        'mismatch': agg != exh, 'pyr_visits': len(visited),
                        'exh_pixels': npix})
    return results, levels, tot_pyr, tot_exh

if __name__ == '__main__':
    d = load(sys.argv[1])
    errs = validate(d)
    if errs:
        print('VALIDATION ERRORS:'); [print(' -', e) for e in errs]; sys.exit(0)
    res, levels, tp, te = cull(d)
    print('pyramid sizes:', [[w, h] for w, h, _ in levels])
    for r in res: print(r)
    print('total pyramid visits:', tp, ' exhaustive pixel reads:', te)
