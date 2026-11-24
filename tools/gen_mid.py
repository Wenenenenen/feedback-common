#!/usr/bin/env python3
"""生成与 stress 同分布的中等规模包，供 Python 参考与 JS 对拍大场景语义。"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
from gen_cases import gen_stress  # noqa: E402


def shrink(pkg, nq, w=64, h=64):
    rng = random.Random(7)
    quads = []
    for i in range(nq):
        x = 2 * rng.randrange(w // 2)
        y = 2 * rng.randrange(h // 2)
        quads.append({
            "x": x, "y": y, "id": rng.randrange(1, 10 ** 9), "mask": 15,
            "z": [rng.randint(0, 1000) for _ in range(4)],
            "uv": [[rng.uniform(0, 1), rng.uniform(0, 1)] for _ in range(4)],
        })
    pkg = dict(pkg)
    pkg["width"], pkg["height"], pkg["quads"] = w, h, quads
    return pkg


def main():
    out = sys.argv[1]
    rng = random.Random(42)
    big = gen_stress(rng)  # 仅借用其 48 指令程序与 mip 结构
    mid = shrink(big, 10_000)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(mid, f, separators=(",", ":"))
    print(f"wrote {out}: {len(mid['quads'])} quads, {len(mid['program'])} insns")


if __name__ == "__main__":
    main()
