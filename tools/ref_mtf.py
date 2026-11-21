#!/usr/bin/env python3
"""Reference implementation of the slanted-edge MTF convention in 约定.txt.

Usage: python3 -I ref_mtf.py <image.u16> <chart.json>
Read-only; paths passed as arguments so nothing is imported from the data dir.
"""
import array
import json
import math
import sys

BIN_MIN, BIN_MAX, BIN_W = -12.0, 12.0, 0.25
N_BINS = int((BIN_MAX - BIN_MIN) / BIN_W)  # 96
F_STEP, F_MAX = 0.005, 0.5


def load(path_u16, path_json):
    meta = json.load(open(path_json))
    w, h = meta["w"], meta["h"]
    data = array.array("H")
    data.frombytes(open(path_u16, "rb").read())
    if len(data) != w * h:
        raise ValueError("size mismatch")
    return data, w, h, meta["rois"]


def robust_line(xs, ys):
    """Fit y = a*x + b robustly; returns (a, b, inlier_mask)."""
    n = len(xs)
    order = sorted(range(n), key=lambda i: xs[i])
    # initial slope from median of pairwise slopes between far-apart ranks
    half = n // 2
    slopes = [
        (ys[order[i + half]] - ys[order[i]]) / (xs[order[i + half]] - xs[order[i]])
        for i in range(n - half)
        if xs[order[i + half]] != xs[order[i]]
    ]
    a0 = sorted(slopes)[len(slopes) // 2] if slopes else 0.0
    b0 = sorted(ys[i] - a0 * xs[i] for i in range(n))[n // 2]
    for _ in range(8):
        res = [ys[i] - (a0 * xs[i] + b0) for i in range(n)]
        mad = sorted(abs(r) for r in res)[n // 2]
        tol = max(2.5 * 1.4826 * mad, 0.75)
        mask = [abs(r) <= tol for r in res]
        nin = sum(mask)
        if nin < 8:
            break
        sx = sum(xs[i] for i in range(n) if mask[i])
        sy = sum(ys[i] for i in range(n) if mask[i])
        sxx = sum(xs[i] ** 2 for i in range(n) if mask[i])
        sxy = sum(xs[i] * ys[i] for i in range(n) if mask[i])
        den = nin * sxx - sx * sx
        if den == 0:
            break
        a = (nin * sxy - sx * sy) / den
        b = (sy - a * sx) / nin
        if abs(a - a0) < 1e-9 and abs(b - b0) < 1e-9:
            a0, b0 = a, b
            break
        a0, b0 = a, b
    return a0, b0, mask


def find_edge(data, w, h, rx, ry, rw, rh):
    """Locate one dominant straight edge inside an ROI.

    Returns a dict with geometry + per-profile fit points and inlier flags,
    or {"valid": False, "reason": ...}.
    """
    def px(x, y):
        return data[y * w + x]

    roi_vals = [px(x, y) for y in range(ry, ry + rh) for x in range(rx, rx + rw)]
    dark = float(sorted(roi_vals)[len(roi_vals) // 20])
    bright = float(sorted(roi_vals)[len(roi_vals) - 1 - len(roi_vals) // 20])
    if bright - dark < max(1000.0, 0.1 * max(1.0, bright)):
        return {"valid": False, "reason": "对比度不足，无法识别边缘"}
    mid = 0.5 * (dark + bright)

    # mean |gradient| picks the edge orientation
    gx = gy = 0.0
    cnt = 0
    for y in range(ry + 1, ry + rh - 1):
        for x in range(rx + 1, rx + rw - 1):
            gx += abs(px(x + 1, y) - px(x - 1, y))
            gy += abs(px(x, y + 1) - px(x, y - 1))
            cnt += 1
    vertical = gx >= gy

    points = []  # (profile_index, crossing position)
    if vertical:
        for y in range(ry, ry + rh):
            prev = px(rx, y)
            for x in range(rx + 1, rx + rw):
                cur = px(x, y)
                if (prev - mid) * (cur - mid) < 0:
                    t = (mid - prev) / (cur - prev)
                    points.append((float(y), float(x - 1) + t))
                    break
                prev = cur
    else:
        for x in range(rx, rx + rw):
            prev = px(x, ry)
            for y in range(ry + 1, ry + rh):
                cur = px(x, y)
                if (prev - mid) * (cur - mid) < 0:
                    t = (mid - prev) / (cur - prev)
                    points.append((float(x), float(y - 1) + t))
                    break
                prev = cur

    if len(points) < 8:
        return {"valid": False, "reason": "可识别的边缘剖面过少"}

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    a, b, inliers = robust_line(xs, ys)
    if sum(inliers) < 8:
        return {"valid": False, "reason": "主直边拟合内点不足"}

    # slope: minor axis component / major axis component
    if vertical:
        slope = a  # dx/dy
        # tangent along +y: (a, 1)
        tx, ty = a, 1.0
    else:
        slope = a  # dy/dx
        tx, ty = 1.0, a
    norm = math.hypot(tx, ty)
    tx, ty = tx / norm, ty / norm
    nx, ny = -ty, tx  # left normal

    # orient normal to the bright side: compare mean levels a few px either
    # side of the line (1.5 px still sits inside the transition region)
    xc = 0.5 * (rx + rx + rw - 1)
    yc = 0.5 * (ry + ry + rh - 1)

    def side_mean(sign):
        vals = []
        for step in (3.5, 5.0, 6.5):
            xi = int(round(xc + sign * step * nx))
            yi = int(round(yc + sign * step * ny))
            if 0 <= xi < w and 0 <= yi < h:
                v = px(xi, yi)
                if v != 32768:
                    vals.append(v)
        return sum(vals) / len(vals) if vals else None

    m_plus, m_minus = side_mean(1.0), side_mean(-1.0)
    if m_plus is not None and m_minus is not None and m_plus < m_minus:
        nx, ny = -nx, -ny

    if not (0.03 <= abs(slope) <= 0.5):
        return {
            "valid": False,
            "reason": f"边缘斜率|{slope:.3f}|超出[0.03,0.5]，亚像素分箱不成立",
            "slope": slope,
            "points": points,
            "inliers": inliers,
            "vertical": vertical,
        }

    # points store (independent_coord, dependent_coord): for a vertical edge
    # that is (y, x(y)), for a horizontal edge (x, y(x)); the line point must
    # use the same axes, then convert to image (x, y) below.
    x0_ind = xs[0]
    y0_dep = a * x0_ind + b
    if vertical:
        line_xy = (y0_dep, x0_ind)
    else:
        line_xy = (x0_ind, y0_dep)

    return {
        "valid": True,
        "vertical": vertical,
        "slope": slope,
        # unit normal + a point on the line in image pixel-center coords
        "normal": (nx, ny),
        "line_point": line_xy,
        "a": a,
        "b": b,
        "points": points,
        "inliers": inliers,
        "dark": dark,
        "bright": bright,
    }


def esf_lsf_mtf(data, w, h, roi, edge):
    rx, ry, rw, rh = roi
    nx, ny = edge["normal"]
    # a point on the line, in pixel-center coordinates
    px0, py0 = edge["line_point"]

    sums = [0.0] * N_BINS
    counts = [0] * N_BINS
    # sample every image pixel within +-12 px (normal distance) of the fitted
    # line, clipping to the image; ROI defines the edge, the band defines ESF
    pad = int(math.ceil(BIN_MAX)) + 1
    x0 = max(0, rx - pad)
    x1 = min(w, rx + rw + pad)
    y0 = max(0, ry - pad)
    y1 = min(h, ry + rh + pad)
    for y in range(y0, y1):
        for x in range(x0, x1):
            v = data[y * w + x]
            if v == 32768:  # chart background outside target patches
                continue
            d = (x - px0) * nx + (y - py0) * ny
            k = int(math.floor((d - BIN_MIN) / BIN_W))
            if 0 <= k < N_BINS:
                sums[k] += v
                counts[k] += 1

    esf = [math.nan] * N_BINS
    for k in range(N_BINS):
        if counts[k]:
            esf[k] = sums[k] / counts[k]

    # missing-bin rules: no head/tail gaps, interior runs <= 2
    first = next((k for k in range(N_BINS) if counts[k] > 0), None)
    last = next((k for k in range(N_BINS - 1, -1, -1) if counts[k] > 0), None)
    if first is None or first != 0 or last != N_BINS - 1:
        return None, "法向分箱首尾缺箱，边缘未充分覆盖[-12,12)像素"
    run = 0
    for k in range(N_BINS):
        if counts[k] == 0:
            run += 1
            if run > 2:
                return None, "法向分箱内部连续缺箱超过两个"
        else:
            run = 0
    # linear fill of interior gaps
    k = 1
    while k < N_BINS - 1:
        if counts[k] == 0:
            j = k
            while j < N_BINS and counts[j] == 0:
                j += 1
            left, right = k - 1, j
            for m in range(k, j):
                t = (m - left) / (right - left)
                esf[m] = esf[left] + t * (esf[right] - esf[left])
            k = j
        else:
            k += 1

    # LSF via central difference, endpoints dropped -> 94 samples
    lsf = [(esf[k + 1] - esf[k - 1]) / (2 * BIN_W) for k in range(1, N_BINS - 1)]
    n_lsf = len(lsf)
    hann = [0.5 * (1 - math.cos(2 * math.pi * i / (n_lsf - 1))) for i in range(n_lsf)]
    win = [lsf[i] * hann[i] for i in range(n_lsf)]

    n_freq = int(F_MAX / F_STEP) + 1  # 101
    mtf = []
    dc = sum(win)
    for j in range(n_freq):
        f = j * F_STEP
        re = sum(win[i] * math.cos(-2 * math.pi * f * i * BIN_W) for i in range(n_lsf))
        im = sum(win[i] * math.sin(-2 * math.pi * f * i * BIN_W) for i in range(n_lsf))
        mag = math.hypot(re, im)
        if j == 0:
            comp = 1.0
        else:
            omega = 2 * math.pi * f * BIN_W
            comp = omega / math.sin(omega)
        mtf.append(abs(mag / dc) * comp)

    def crossing(level):
        for j in range(1, n_freq):
            if mtf[j - 1] >= level and mtf[j] < level:
                f0, f1 = (j - 1) * F_STEP, j * F_STEP
                m0, m1 = mtf[j - 1], mtf[j]
                return f0 + (level - m0) * (f1 - f0) / (m1 - m0)
        return None

    return {
        "esf": esf,
        "lsf": lsf,
        "mtf": mtf,
        "mtf50": crossing(0.5),
        "mtf10": crossing(0.1),
        "bin_centers": [BIN_MIN + BIN_W * (k + 0.5) for k in range(N_BINS)],
        "counts": counts,
    }, None


def analyze(data, w, h, rois):
    out = []
    for idx, roi in enumerate(rois):
        edge = find_edge(data, w, h, *roi)
        rec = {"roi": list(roi), "index": idx}
        if not edge.get("valid"):
            rec.update(
                valid=False,
                reason=edge["reason"],
                slope=edge.get("slope"),
                points=edge.get("points", []),
                inliers=edge.get("inliers", []),
            )
            out.append(rec)
            continue
        res, err = esf_lsf_mtf(data, w, h, roi, edge)
        if err:
            rec.update(valid=False, reason=err, slope=edge["slope"])
            out.append(rec)
            continue
        rec.update(
            valid=True,
            vertical=edge["vertical"],
            slope=edge["slope"],
            normal=list(edge["normal"]),
            line_point=list(edge["line_point"]),
            a=edge["a"],
            b=edge["b"],
            points=edge["points"],
            inliers=edge["inliers"],
            dark=edge["dark"],
            bright=edge["bright"],
            **res,
        )
        out.append(rec)
    return out


def main():
    data, w, h, rois = load(sys.argv[1], sys.argv[2])
    truth = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None
    export = len(sys.argv) > 4
    if export:
        recs = analyze(data, w, h, rois)
        with open(sys.argv[4], "w") as f:
            json.dump({"w": w, "h": h, "rois": rois, "results": recs}, f)
        print("wrote", sys.argv[4])
        return
    for idx, roi in enumerate(rois):
        edge = find_edge(data, w, h, *roi)
        line = f"ROI{idx}: "
        if not edge.get("valid"):
            line += f"INVALID slope={edge.get('slope')} reason={edge.get('reason')}"
            print(line)
            continue
        res, err = esf_lsf_mtf(data, w, h, roi, edge)
        if err:
            print(line + f"INVALID reason={err} slope={edge['slope']:.4f}")
            continue
        t = truth[idx] if truth else None
        extra = ""
        if t:
            extra = f" | truth slope={t['slope']} mtf50={t['mtf50']:.6f} valid={t['valid']}"
            if res["mtf50"] is not None:
                extra += f" | delta50={res['mtf50'] - t['mtf50']:+.2e}"
        print(
            line
            + f"slope={edge['slope']:+.4f} npts={len(edge['points'])} nin={sum(edge['inliers'])} "
            f"mtf50={res['mtf50']:.6f} mtf10={res['mtf10']}"
            + extra
        )


if __name__ == "__main__":
    main()
