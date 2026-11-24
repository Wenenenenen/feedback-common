#!/usr/bin/env python3
"""生成对拍测试包：覆盖导数、舍弃、辅助格、mip 选择、周期边界、深度选择等。"""
import json
import math
import os
import random
import sys


def mip_chain(w, h, rng, const_top=False):
    layers = []
    cw, ch = w, h
    idx = 0
    while True:
        if const_top and (cw == 1 or ch == 1):
            layers.append({"width": cw, "height": ch, "rgb": [rng.uniform(-1, 2), rng.uniform(0, 1), rng.uniform(0, 1)]})
        else:
            pix = []
            for _ in range(cw * ch):
                pix.append([rng.uniform(-2, 2), rng.uniform(-1, 1.5), rng.uniform(0, 3)])
            layers.append({"width": cw, "height": ch, "pixels": pix})
        if cw == 1 and ch == 1:
            break
        cw, ch = max(1, cw // 2), max(1, ch // 2)
        idx += 1
    return layers


def gen_basic(rng):
    """小画面 + 纹理 + 常量 mip，覆盖周期双线性与层间混合。"""
    return {
        "rules": "", "width": 4, "height": 4,
        "quads": [
            {"x": 0, "y": 0, "id": 1, "mask": 15,
             "z": [2, 2, 2, 2],
             "uv": [[0.1, 0.2], [0.35, 0.2], [0.1, 0.6], [0.35, 0.6]]},
            {"x": 2, "y": 2, "id": 2, "mask": 15,
             "z": [1, 1, 1, 1],
             "uv": [[-0.2, 1.1], [0.05, 1.1], [-0.2, 1.35], [0.05, 1.35]]},
        ],
        "program": [["纹理", "r", "u", "v", 0]],
        "out": ["r", "u", "v"],
        "mips": [
            {"width": 4, "height": 4, "pixels": [[float((i * 3 + j) % 7), 0.1 * j, 0.2] for j in range(4) for i in range(4)]},
            {"width": 2, "height": 2, "pixels": [[0.9, 0.8, 0.7], [0.6, 0.5, 0.4], [0.3, 0.2, 0.1], [0.05, 0.15, 0.25]]},
            {"width": 1, "height": 1, "rgb": [0.5, 0.5, 0.5]},
        ],
    }


def gen_derivatives(rng):
    """全部指令类型，含粗/细导数、舍弃、加乘；部分 mask 与 discard。"""
    quads = []
    for q in range(6):
        x, y = 2 * (q % 2), 2 * ((q // 2) % 2)
        mask = rng.choice([15, 7, 10, 5, 1, 0])
        uv = [[rng.uniform(-1, 2), rng.uniform(-1, 2)] for _ in range(4)]
        quads.append({"x": x, "y": y, "id": q + 1, "mask": mask,
                      "z": [rng.randint(0, 5) for _ in range(4)], "uv": uv})
    program = [
        ["常量", "k", 0.5],
        ["加", "u2", "u", "k"],
        ["乘", "v2", "v", "k"],
        ["细横", "dxu", "u2"],
        ["细纵", "dyv", "v2"],
        ["粗横", "cx", "u"],
        ["粗纵", "cy", "v"],
        ["舍弃", "dxu", "dyv"],
        ["加", "uu", "u2", "cx"],
        ["乘", "vv", "v2", "cy"],
        ["纹理", "r", "uu", "vv", 1],
        ["纹理", "g", "u", "v", 2],
        ["加", "b", "dxu", "k"],
    ]
    return {
        "rules": "", "width": 4, "height": 4, "quads": quads,
        "program": program, "out": ["r", "g", "b"],
        "mips": mip_chain(8, 8, rng, const_top=True),
    }


def gen_discards_depth(rng):
    """舍弃车道继续执行并参与导数；深度竞争、同深度小 id 胜。"""
    quads = [
        {"x": 0, "y": 0, "id": 7, "mask": 15, "z": [3, 3, 3, 3],
         "uv": [[0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4]]},
        {"x": 0, "y": 0, "id": 3, "mask": 15, "z": [3, 3, 3, 3],
         "uv": [[0.1, 0.1], [0.5, 0.1], [0.1, 0.5], [0.5, 0.5]]},
        {"x": 0, "y": 0, "id": 1, "mask": 15, "z": [5, 5, 5, 5],
         "uv": [[0.2, 0.2], [0.6, 0.2], [0.2, 0.6], [0.6, 0.6]]},
    ]
    program = [
        ["常量", "t", 0.45],
        ["舍弃", "u", "t"],          # u>=0.45 的车道被舍弃
        ["细横", "dx", "u"],         # 被舍弃车道仍参与
        ["纹理", "r", "u", "v", 0],
        ["加", "g", "dx", "u"],
        ["常量", "b", 0.25],
    ]
    return {
        "rules": "", "width": 2, "height": 2, "quads": quads,
        "program": program, "out": ["r", "g", "b"],
        "mips": mip_chain(4, 4, rng),
    }


def gen_zero_deriv(rng):
    """零导数 -> 第 0 层。"""
    quad = {"x": 0, "y": 0, "id": 1, "mask": 15, "z": [0, 0, 0, 0],
            "uv": [[0.3, 0.7], [0.3, 0.7], [0.3, 0.7], [0.3, 0.7]]}
    return {
        "rules": "", "width": 2, "height": 2, "quads": [quad],
        "program": [["纹理", "r", "u", "v", 0]],
        "out": ["r", "u", "v"],
        "mips": mip_chain(2, 2, rng, const_top=True),
    }


def gen_random(rng, w=16, h=16, nq=40, nins=24):
    quads = []
    for _ in range(nq):
        x = 2 * rng.randrange(w // 2)
        y = 2 * rng.randrange(h // 2)
        mask = rng.randrange(16)
        quads.append({
            "x": x, "y": y, "id": rng.randrange(1, 100000), "mask": mask,
            "z": [rng.randint(-10, 10) for _ in range(4)],
            "uv": [[rng.uniform(-3, 3), rng.uniform(-3, 3)] for _ in range(4)],
        })
    # 允许同一 (x,y) 不同 id 的重叠
    program = [["常量", "k", rng.uniform(-1, 1)]]
    regs = ["u", "v", "k"]
    for i in range(nins - 2):
        kind = rng.randrange(8)
        tgt = f"t{i}"
        if kind == 0:
            program.append(["常量", tgt, rng.uniform(-2, 2)])
        elif kind in (1, 2):
            a, b = rng.choice(regs), rng.choice(regs)
            program.append([["加", "乘"][kind - 1], tgt, a, b])
        elif kind in (3, 4, 5, 6):
            program.append([["细横", "细纵", "粗横", "粗纵"][kind - 3], tgt, rng.choice(regs)])
        else:
            program.append(["舍弃", rng.choice(regs), rng.choice(regs)])
        if kind != 7:
            regs.append(tgt)
    program.append(["纹理", "r", "u", "v", rng.randrange(3)])
    tw = 2 ** rng.randrange(1, 7)
    th = 2 ** rng.randrange(1, 7)
    return {
        "rules": "", "width": w, "height": h, "quads": quads,
        "program": program,
        "out": ["r", rng.choice(regs), rng.choice(regs)],
        "mips": mip_chain(tw, th, rng, const_top=True),
    }


def gen_stress(rng):
    """25 万组、512×512、48 指令（含一条采样）。"""
    W = H = 512
    nq = 250_000
    quads = []
    for i in range(nq):
        x = 2 * rng.randrange(W // 2)
        y = 2 * rng.randrange(H // 2)
        quads.append({
            "x": x, "y": y, "id": rng.randrange(1, 10 ** 9), "mask": 15,
            "z": [rng.randint(0, 1000) for _ in range(4)],
            "uv": [[rng.uniform(0, 1), rng.uniform(0, 1)] for _ in range(4)],
        })
    program = [["常量", "k", 0.5]]
    regs = ["u", "v", "k"]
    for i in range(46):
        tgt = f"t{i}"
        kind = rng.randrange(6)
        if kind == 0:
            program.append(["常量", tgt, rng.uniform(-1, 1)])
        elif kind in (1, 2):
            program.append([["加", "乘"][kind - 1], tgt, rng.choice(regs), rng.choice(regs)])
        else:
            program.append([["细横", "细纵", "粗横", "粗纵"][kind - 3], tgt, rng.choice(regs[:4])])
        regs.append(tgt)
    program.append(["纹理", "r", "u", "v", 0])
    return {
        "rules": "", "width": W, "height": H, "quads": quads,
        "program": program, "out": ["r", "u", "v"],
        "mips": mip_chain(64, 64, rng, const_top=True),
    }


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    rng = random.Random(20261125)
    cases = {
        "basic": gen_basic(rng),
        "derivatives": gen_derivatives(rng),
        "discards_depth": gen_discards_depth(rng),
        "zero_deriv": gen_zero_deriv(rng),
    }
    for i in range(6):
        cases[f"random{i}"] = gen_random(rng)
    for name, pkg in cases.items():
        with open(os.path.join(out_dir, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(pkg, f, separators=(",", ":"))
    print(f"wrote {len(cases)} functional cases to {out_dir}")
    if "--stress" in sys.argv:
        s = gen_stress(random.Random(42))
        path = os.path.join(out_dir, "stress.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(s, f, separators=(",", ":"))
        size = os.path.getsize(path)
        print(f"wrote stress: {len(s['quads'])} quads, {len(s['program'])} insns, {size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
