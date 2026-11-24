#!/usr/bin/env python3
"""暴力参照实现：独立于网页 JS 实现，用于交叉验证。

用法：python3 -I reference/ref_bruteforce.py <case_dir>
case_dir 内含 table.json 与 target.ppm。输出 proof_ref.ppm 与逐像素结果。
所有运算同样使用精确整数（分数用交叉乘法比较），逐通道半值向上取整。
"""

import json
import os
import sys


def locate_interval(axis, code):
    # axis 严格递增、首 0 尾 63
    if code >= axis[-1]:
        return len(axis) - 2
    lo, hi = 0, len(axis) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if axis[mid] <= code:
            lo = mid
        else:
            hi = mid
    return lo


def round_half_up(num, den):
    q, r = divmod(num, den)
    return q + 1 if 2 * r >= den else q


def forward(table, r, g, b):
    axes = table["axes"]
    nodes = table["nodes"]
    counts = [len(a) for a in axes]
    codes = (r, g, b)

    seg, num, den = [], [], []
    for a in range(3):
        i = locate_interval(axes[a], codes[a])
        x0, x1 = axes[a][i], axes[a][i + 1]
        seg.append(i)
        num.append(codes[a] - x0)
        den.append(x1 - x0)

    # 分数降序，平分按 RGB 轴序
    order = sorted(range(3), key=lambda a: (-num[a] / den[a], a))
    s0, s1, s2 = order

    n_r, n_g = counts[1] * counts[2], counts[2]

    def nidx(ir, ig, ib):
        return ir * n_r + ig * n_g + ib

    i000 = nidx(seg[0], seg[1], seg[2])
    i111 = nidx(seg[0] + 1, seg[1] + 1, seg[2] + 1)
    mask1 = 1 << s0
    mask2 = mask1 | (1 << s1)

    def corner(mask):
        return nidx(
            seg[0] + ((mask >> 0) & 1),
            seg[1] + ((mask >> 1) & 1),
            seg[2] + ((mask >> 2) & 1),
        )

    c = [i000, corner(mask1), corner(mask2), i111]
    d = den[0] * den[1] * den[2]
    t0 = num[s0] * d // den[s0]
    t1 = num[s1] * d // den[s1]
    t2 = num[s2] * d // den[s2]
    w = (d - t0, t0 - t1, t1 - t2, t2)

    out = []
    for ch in range(3):
        numerator = sum(nodes[c[k]][ch] * w[k] for k in range(4))
        out.append(round_half_up(numerator, d))
    return tuple(out)


def parse_p6(path):
    with open(path, "rb") as f:
        data = f.read()

    tokens = []
    pos = 0

    def skip_ws():
        nonlocal pos
        while pos < len(data):
            ch = data[pos]
            if ch == 35:
                while pos < len(data) and data[pos] != 10:
                    pos += 1
            elif ch in b" \t\n\r":
                pos += 1
            else:
                break

    for _ in range(4):
        skip_ws()
        start = pos
        while pos < len(data) and data[pos] not in b" \t\n\r#":
            pos += 1
        tokens.append(data[start:pos].decode("ascii"))

    magic, w_s, h_s, max_s = tokens
    assert magic == "P6"
    width, height, maxval = int(w_s), int(h_s), int(max_s)
    assert maxval == 255
    skip_ws()
    rgb = data[pos:pos + width * height * 3]
    assert len(rgb) == width * height * 3
    return width, height, rgb


def main():
    case_dir = sys.argv[1]
    with open(os.path.join(case_dir, "table.json"), "rb") as f:
        table = json.loads(f.read().decode("utf-8"))
    width, height, rgb = parse_p6(os.path.join(case_dir, "target.ppm"))

    bounds = table.get("bounds", [[0, 63]] * 3)
    anchor = tuple(table.get("anchor", [32, 32, 32]))
    weights = tuple(table.get("weights", [1, 1, 1]))

    # 预算全部允许码的正向输出
    forward_map = {}
    for r in range(bounds[0][0], bounds[0][1] + 1):
        for g in range(bounds[1][0], bounds[1][1] + 1):
            for b in range(bounds[2][0], bounds[2][1] + 1):
                forward_map[(r, g, b)] = forward(table, r, g, b)

    def best_code(target):
        best = None
        best_key = None
        for code, out in forward_map.items():
            err = sum(weights[c] * (out[c] - target[c]) ** 2 for c in range(3))
            man = sum(abs(code[c] - anchor[c]) for c in range(3))
            key = (err, man, code)  # code 元组即 RGB 字典序
            if best_key is None or key < best_key:
                best_key = key
                best = code
        return best, best_key

    out_codes = bytearray()
    out_rgb = bytearray()
    mismatches_log = []
    npix = width * height
    for p in range(npix):
        target = tuple(rgb[p * 3:p * 3 + 3])
        code, key = best_code(target)
        out_codes.extend(code)
        proof = forward_map[code]
        out_rgb.extend(proof)
        mismatches_log.append((p, target, code, proof, key[0]))

    header = f"P6\n{width} {height}\n255\n".encode("ascii")
    with open(os.path.join(case_dir, "proof_ref.ppm"), "wb") as f:
        f.write(header + bytes(out_rgb))
    with open(os.path.join(case_dir, "codes_ref.ppm"), "wb") as f:
        f.write(header + bytes(out_codes))

    # 同时导出前若干条供核对
    with open(os.path.join(case_dir, "reference_log.txt"), "w", encoding="utf-8") as f:
        for p, target, code, proof, err in mismatches_log[:200]:
            x, y = p % width, p // width
            f.write(
                f"({x},{y}) target={target} code={code} proof={proof} werr={err}\n"
            )
    print(f"OK {npix} pixels, distinct outputs={len(set(forward_map.values()))}")


if __name__ == "__main__":
    main()
