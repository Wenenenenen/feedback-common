#!/usr/bin/env python3
"""对拍 Python 参考与 Node 核心的烘焙输出，并检查硬性不变量。"""
import json
import math
import sys

FACE_ORDER = ("px", "nx", "py", "ny", "pz", "nz")
ROUGH = ("0", "0.25", "0.5", "1")


def load(p):
    with open(p, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    # 归一化档位键为浮点字符串。
    return {str(float(k)): v for k, v in raw.items()}


ROUGH = ("0.0", "0.25", "0.5", "1.0")


def compare(py_path, js_path, label, tol=2e-6):
    py = load(py_path)
    js = load(js_path)
    worst = 0.0
    n = 0
    for r in ROUGH:
        for f in FACE_ORDER:
            a, b = py[r][f], js[r][f]
            assert len(a) == len(b), (r, f, len(a), len(b))
            for x, y in zip(a, b):
                worst = max(worst, abs(x - y))
                n += 1
    status = "OK" if worst <= tol else "FAIL"
    print(f"[{label}] 对拍 {n} 个分量, 最大差={worst:.3e} -> {status} (tol={tol:g})")
    return worst <= tol


def check_constant(js_path):
    js = load(js_path)
    ok = True
    for r in ROUGH:
        for f in FACE_ORDER:
            for i in range(0, len(js[r][f]), 3):
                got = js[r][f][i:i + 3]
                if any(abs(g - c) > 1e-7 for g, c in zip(got, (0.25, 1, 4))):
                    ok = False
                    print("  常量破坏", r, f, got)
    print(f"[constant] 所有档位/面/纹素 == [0.25,1,4]: {'OK' if ok else 'FAIL'}")
    return ok


def check_direction_r0(js_dir_path, n):
    # r=0 重采样 direction.json：当输出纹素中心与输入对齐（同尺寸）时，
    # 双线性权重退化为单点，输出应精确等于编码值 0.5*(d+1)。
    js = load(js_dir_path)

    def face_uv_to_dir(face, u, v):
        table = {"px": (1, -v, -u), "nx": (-1, -v, u), "py": (u, 1, v),
                 "ny": (u, -1, -v), "pz": (u, -v, 1), "nz": (-u, -v, -1)}
        x, y, z = table[face]
        l = math.hypot(x, y, z)
        return (x / l, y / l, z / l)

    worst = 0.0
    for f in FACE_ORDER:
        for p in range(n * n):
            row, col = divmod(p, n)
            u = -1 + 2 * (col + 0.5) / n
            v = -1 + 2 * (row + 0.5) / n
            d = face_uv_to_dir(f, u, v)
            expect = [0.5 * (x + 1) for x in d]
            got = js["0.0"][f][p * 3:p * 3 + 3]
            worst = max(worst, max(abs(a - b) for a, b in zip(got, expect)))
    print(f"[direction] r=0 同尺寸({n})中心对齐输出==0.5(d+1), 最大差={worst:.3e} "
          f"-> {'OK' if worst < 1e-5 else 'FAIL'}")
    return worst < 1e-5


def check_highlight_seam(js_hi_path):
    # 高光跨 px/pz 缝：粗糙档下，px 最右列与 pz 最左列相邻纹素不应出现
    # 单张面独立过滤会造成的塌陷（这里只报告比值，人工核对连续性）。
    js = load(js_hi_path)
    n = 32
    for r in ("0.25", "0.5", "1.0"):
        px_bright = [js[r]["px"][(row * n + (n - 1)) * 3] for row in range(n)]
        pz_bright = [js[r]["pz"][(row * n + 0) * 3] for row in range(n)]
        diffs = [abs(a - b) for a, b in zip(px_bright, pz_bright)]
        print(f"[highlight] r={r}: px 右列 vs pz 左列 R 通道最大相邻差={max(diffs):.4f} "
              f"(均值={sum(diffs)/len(diffs):.4f})")


if __name__ == "__main__":
    base = sys.argv[1]
    checks = [
        compare(f"{base}/py-constant.json", f"{base}/js-constant.json", "constant"),
        compare(f"{base}/py-highlight.json", f"{base}/js-highlight.json", "highlight"),
        compare(f"{base}/py-direction.json", f"{base}/js-direction.json", "direction"),
        check_constant(f"{base}/js-constant.json"),
    ]
    if len(sys.argv) > 2:
        checks.append(check_direction_r0(sys.argv[2], 16))
    check_highlight_seam(f"{base}/js-highlight.json")
    sys.exit(0 if all(checks) else 1)
