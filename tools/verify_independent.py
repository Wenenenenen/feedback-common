#!/usr/bin/env python3
"""独立解析真值验证：不 import 任何被测实现。
锚点：direction.json 颜色严格等于 0.5*(纹素中心方向 d + 1)。
r=0 且输入输出同尺寸时，中心对齐的双线性必须逐纹素精确还原该编码。
"""
import json
import math
import sys

FACE_ORDER = ("px", "nx", "py", "ny", "pz", "nz")


def face_dir(face, u, v):
    t = {
        "px": (1, -v, -u), "nx": (-1, -v, u), "py": (u, 1, v),
        "ny": (u, -1, -v), "pz": (u, -v, 1), "nz": (-u, -v, -1),
    }
    x, y, z = t[face]
    l = math.hypot(x, y, z)
    return (x / l, y / l, z / l)


def main(baked_path, env_path, n_out):
    env = json.load(open(env_path, "r", encoding="utf-8"))
    baked = json.load(open(baked_path, "r", encoding="utf-8"))
    baked = {str(float(k)): v for k, v in baked.items()}
    worst = 0.0
    n_bad = 0
    for f in FACE_ORDER:
        for p in range(n_out * n_out):
            row, col = divmod(p, n_out)
            u = -1 + 2 * (col + 0.5) / n_out
            v = -1 + 2 * (row + 0.5) / n_out
            d = face_dir(f, u, v)
            expect = [0.5 * (x + 1) for x in d]
            got = baked["0.0"][f][p * 3:p * 3 + 3]
            e = max(abs(a - b) for a, b in zip(got, expect))
            worst = max(worst, e)
            if e > 1e-5:
                n_bad += 1
    print(f"[独立锚点] r=0 同尺寸还原 0.5(d+1): 最大差={worst:.3e}, 超差纹素={n_bad}")
    # 浮点存储允许 ~1e-6 误差。
    ok = worst < 1e-5 and n_bad == 0
    print("结果:", "OK" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    baked, envp, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    sys.exit(0 if main(baked, envp, n) else 1)
