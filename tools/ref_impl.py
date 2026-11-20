#!/usr/bin/env python3
# Reference implementation of the elliptic-footprint sampler spec (cases-extracted/说明.txt).
# Stdlib only. Run with: python3 -I ref_impl.py <case.json> <texture.png>
import json, math, struct, sys, zlib


# ---------- minimal PNG decoder (8-bit, non-interlaced, color type 2/6) ----------
def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, width, height, bit_depth, color_type, idat = 8, 0, 0, 0, 0, b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(">IIBBBBB", chunk)
            assert bit_depth == 8 and interlace == 0 and comp == 0 and filt == 0
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    channels = {2: 3, 6: 4}[color_type]
    raw = zlib.decompress(idat)
    stride = width * channels
    out = bytearray(width * height * channels)
    prev = bytearray(stride)
    i = 0
    for y in range(height):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if f == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b, c = prev[x], prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return width, height, channels, bytes(out)


# ---------- color space ----------
def srgb_to_linear(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c):
    if c <= 0.0031308:
        v = 12.92 * c
    else:
        v = 1.055 * c ** (1 / 2.4) - 0.055
    return max(0, min(255, round(v * 255.0)))


# ---------- addressing ----------
def wrap_index(i, n, mode):
    if mode == "repeat":
        return i % n
    if mode == "mirror":
        m = i % (2 * n)
        return m if m < n else 2 * n - 1 - m
    return min(max(i, 0), n - 1)  # clamp


def texel_linear(pixels, tw, th, ch, i, j, mode):
    ii, jj = wrap_index(i, tw, mode), wrap_index(j, th, mode)
    k = (jj * tw + ii) * ch
    r = srgb_to_linear(pixels[k])
    g = srgb_to_linear(pixels[k + 1])
    b = srgb_to_linear(pixels[k + 2])
    a = pixels[k + 3] / 255.0 if ch == 4 else 1.0
    return r, g, b, a


# ---------- core math ----------
def project(H, X, Y):
    a = H[0] * X + H[1] * Y + H[2]
    b = H[3] * X + H[4] * Y + H[5]
    w = H[6] * X + H[7] * Y + H[8]
    return a, b, w


def jacobian(H, X, Y, a, b, w):
    w2 = w * w
    dsdx = (H[0] * w - a * H[6]) / w2
    dsdy = (H[1] * w - a * H[7]) / w2
    dtdx = (H[3] * w - b * H[6]) / w2
    dtdy = (H[4] * w - b * H[7]) / w2
    return dsdx, dsdy, dtdx, dtdy


def solve_c(dsdx, dsdy, dtdx, dtdy, aniso):
    c00 = dsdx * dsdx + dsdy * dsdy + 0.25
    c01 = dsdx * dtdx + dsdy * dtdy
    c11 = dtdx * dtdx + dtdy * dtdy + 0.25
    tr, det = c00 + c11, c00 * c11 - c01 * c01
    half = tr * 0.5
    disc = math.sqrt(max(0.0, half * half - det))
    lam_max, lam_min = half + disc, half - disc
    lam_min_limited = max(lam_min, lam_max / (aniso * aniso))
    # eigenvector of lambda_max for symmetric [[c00,c01],[c01,c11]]
    if abs(c01) > 1e-12:
        ex, ey = c01, lam_max - c00
        n = math.hypot(ex, ey)
        ex, ey = ex / n, ey / n
    else:
        ex, ey = (1.0, 0.0) if c00 >= c11 else (0.0, 1.0)
    return c00, c01, c11, lam_max, lam_min, lam_min_limited, ex, ey


def nearest(pixels, tw, th, ch, s, t, mode):
    return texel_linear(pixels, tw, th, ch, math.floor(s), math.floor(t), mode)


def bilinear(pixels, tw, th, ch, s, t, mode):
    i0, j0 = math.floor(s - 0.5), math.floor(t - 0.5)
    u, v = s - (i0 + 0.5), t - (j0 + 0.5)
    acc_r = acc_g = acc_b = acc_a = 0.0
    for dj, wy in ((0, 1 - v), (1, v)):
        for di, wx in ((0, 1 - u), (1, u)):
            r, g, b, a = texel_linear(pixels, tw, th, ch, i0 + di, j0 + dj, mode)
            wgt = wx * wy
            acc_r += wgt * r * a
            acc_g += wgt * g * a
            acc_b += wgt * b * a
            acc_a += wgt * a
    if acc_a <= 0:
        return 0.0, 0.0, 0.0, 0.0
    return acc_r / acc_a, acc_g / acc_a, acc_b / acc_a, acc_a


def elliptic(pixels, tw, th, ch, s, t, lam_max, lam_min_l, ex, ey, mode):
    # Inverse of the LIMITED covariance C' via its eigenbasis:
    # C'^-1 = v_max v_max^T / lam_max + v_min v_min^T / lam_min_limited
    vx, vy = -ey, ex  # minor-axis eigenvector
    inv00 = ex * ex / lam_max + vx * vx / lam_min_l
    inv01 = ex * ey / lam_max + vx * vy / lam_min_l
    inv11 = ey * ey / lam_max + vy * vy / lam_min_l
    r_max = math.sqrt(lam_max)
    x0, x1 = math.floor(s - r_max), math.ceil(s + r_max)
    y0, y1 = math.floor(t - r_max), math.ceil(t + r_max)
    acc_r = acc_g = acc_b = acc_a = wsum = 0.0
    contribs = []
    for j in range(y0, y1 + 1):
        for i in range(x0, x1 + 1):
            dx = i + 0.5 - s
            dy = j + 0.5 - t
            q = inv00 * dx * dx + 2 * inv01 * dx * dy + inv11 * dy * dy
            if q < 1.0:
                wgt = math.exp(-2 * q) - math.exp(-2)
                r, g, b, a = texel_linear(pixels, tw, th, ch, i, j, mode)
                acc_r += wgt * r * a
                acc_g += wgt * g * a
                acc_b += wgt * b * a
                acc_a += wgt * a
                wsum += wgt
                contribs.append((i, j, q, wgt))
    if wsum <= 0:
        return (0.0, 0.0, 0.0, 0.0), contribs, 0.0
    out = (acc_r / wsum / (acc_a / wsum) if acc_a > 0 else 0.0,
           acc_g / wsum / (acc_a / wsum) if acc_a > 0 else 0.0,
           acc_b / wsum / (acc_a / wsum) if acc_a > 0 else 0.0,
           acc_a / wsum)
    return out, contribs, wsum


def render(case, pixels, tw, th, ch, method):
    W, H, Hm, mode, aniso = case["width"], case["height"], case["H"], case["address"], case["anisotropy"]
    out = [[None] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            X, Y = x + 0.5, y + 0.5
            a, b, w = project(Hm, X, Y)
            if w <= 1e-6:
                out[y][x] = (0.0, 0.0, 0.0, 0.0, True)
                continue
            s, t = a / w, b / w
            if method == "nearest":
                r, g, bl, al = nearest(pixels, tw, th, ch, s, t, mode)
            elif method == "bilinear":
                r, g, bl, al = bilinear(pixels, tw, th, ch, s, t, mode)
            else:
                dsdx, dsdy, dtdx, dtdy = jacobian(Hm, X, Y, a, b, w)
                c00, c01, c11, lmax, lmin, lmin_l, ex, ey = solve_c(dsdx, dsdy, dtdx, dtdy, aniso)
                (r, g, bl, al), _, _ = elliptic(pixels, tw, th, ch, s, t,
                                                 lmax, lmin_l, ex, ey, mode)
            out[y][x] = (r, g, bl, al, False)
    return out


if __name__ == "__main__":
    case_path, tex_path = sys.argv[1], sys.argv[2]
    case = json.load(open(case_path))
    tw, th, ch, pixels = read_png(tex_path)
    img = render(case, pixels, tw, th, ch, "elliptic")
    ref = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None
    if ref:
        worst = 0.0
        for row in ref:
            if row["case"] != case.get("index", -1) and f"case-{row['case']}.json" not in case_path:
                continue
            x, y = row["pixel"]
            got = img[y][x]
            for k in range(4):
                worst = max(worst, abs(got[k] - row["linearRGBA"][k]))
        print(f"{case_path}: worst abs diff = {worst:.3e}")
