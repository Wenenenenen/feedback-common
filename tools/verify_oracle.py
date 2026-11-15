import json, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, 'samples', 'extracted')

def srgb_to_lin(c):
    x = c / 255.0
    return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4

def lin_to_srgb8(x):
    x = max(0.0, min(1.0, x))
    v = 1.055 * (x ** (1 / 2.4)) - 0.055 if x > 0.0031308 else 12.92 * x
    return int(round(v * 255))

def homography(src, dst):
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    n = 8
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        d = M[c][c]
        M[c] = [v / d for v in M[c]]
        for r in range(n):
            if r != c:
                f = M[r][c]
                M[r] = [a - f * bb for a, bb in zip(M[r], M[c])]
    return [row[-1] for row in M]

def apply_h(H, x, y):
    w = H[6] * x + H[7] * y + 1
    return (H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w

def edge_info(quad):
    lines = []
    n = len(quad)
    area2 = sum(quad[i][0] * quad[(i + 1) % n][1] - quad[(i + 1) % n][0] * quad[i][1] for i in range(n))
    s = 1 if area2 > 0 else -1
    cx = sum(p[0] for p in quad) / n
    cy = sum(p[1] for p in quad) / n
    for i in range(n):
        x1, y1 = quad[i]; x2, y2 = quad[(i + 1) % n]
        a = y2 - y1; b = x1 - x2; c = x2 * y1 - x1 * y2
        norm = math.hypot(a, b)
        a, b, c = a / norm, b / norm, c / norm
        if (a * cx + b * cy + c) * s < 0:
            a, b, c = -a, -b, -c
        lines.append((a, b, c))  # interior => ax+by+c >= 0
    return lines

def weights_at(p, quads, feather):
    raws = []
    for q in quads:
        ds = [a * p[0] + b * p[1] + c for a, b, c in edge_info(q)]
        inside = all(d >= -1e-9 for d in ds)
        raws.append(min(1.0, max(0.0, min(ds)) / feather) if inside else 0.0)
    total = sum(raws)
    if total <= 0:
        cov = [w > 0 for w in raws]
        if not any(cov):
            return [0.0] * len(raws)
        k = sum(cov)
        return [(1.0 / k) if c else 0.0 for c in cov]
    if sum(1 for w in raws if w > 0) == 1:
        return [1.0 if w > 0 else 0.0 for w in raws]
    return [w / total for w in raws]

def inv3(m):
    def det(a):
        return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
                - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    d = det(m)
    out = [[0] * 3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            minor = [[m[r][c2] for c2 in range(3) if c2 != j] for r in range(3) if r != i]
            cof = ((-1) ** (i + j)) * (minor[0][0] * minor[1][1] - minor[0][1] * minor[1][0])
            out[j][i] = cof / d
    return out

cfg = json.load(open(os.path.join(SAMPLES, 'overlap.json')))
quads = [p['quad'] for p in cfg['projectors']]
feather = cfg['feather']
ora = json.load(open(os.path.join(SAMPLES, 'oracle.json')))
print('gray linear  ref', ora['gray_linear'], ' ours', srgb_to_lin(128))
print('half sRGB8   ref', ora['half_weight_gray_srgb'], ' ours', lin_to_srgb8(0.5 * srgb_to_lin(128)))
ok = True
for probe in ora['probes']:
    w = weights_at(probe['p'], quads, feather)
    match = all(abs(a - b) < 1e-9 for a, b in zip(w, probe['weights']))
    ok &= match
    print('p=', probe['p'], 'ref=', probe['weights'], 'ours=', [round(x, 6) for x in w], 'OK' if match else 'MISMATCH')

pc = json.load(open(os.path.join(SAMPLES, 'perspective.json')))
for pr in pc['projectors']:
    W, Hh = pr['size']; q = pr['quad']
    src = [(0, 0), (W, 0), (W, Hh), (0, Hh)]
    H = homography(src, q)
    err = max(math.hypot(apply_h(H, *s)[0] - d[0], apply_h(H, *s)[1] - d[1]) for s, d in zip(src, q))
    print(pr['id'], 'homography max corner residual:', err)
    Mi = inv3([H[0:3], H[3:6], [H[6], H[7], 1.0]])
    for pt in [(128, 64), (4, 5)]:
        x, y, z = (sum(Mi[i][j] * (pt + (1,))[j] for j in range(3)) for i in range(3))
        print('   surface', pt, '-> framebuffer', round(x / z, 3), round(y / z, 3))

# edge case: all-zero-sum with two coverers (both raw weights exactly 0 on boundary line)
w = weights_at((128, 0), quads, feather)
print('boundary point (128,0) equal-split weights:', w)
print('RESULT:', 'PASS' if ok else 'FAIL')
