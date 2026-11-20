#!/usr/bin/env python3
"""把样例用例导出为 JSON 基准夹具，供 Node 端与 app/core.js 输出逐项比对。

输出到 tools/fixtures/<case>.json，包含：
  尺寸、节点标量、掩膜、有效单元、每个阈值的
  折线（边 id 序列、开闭、节点坐标、物理坐标、长度、面积、父环序号）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from png_inspect import read_png  # noqa: E402
from reference import extract  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_DIR = os.path.join(HERE, "..", "samples", "extracted")
OUT_DIR = os.path.join(HERE, "fixtures")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cases = [f[:-5] for f in os.listdir(SAMPLE_DIR) if f.endswith(".json")]
    for name in sorted(cases):
        with open(os.path.join(SAMPLE_DIR, name + ".json"), encoding="utf-8") as f:
            case = json.load(f)
        w, h, _, _, rows = read_png(os.path.join(SAMPLE_DIR, case["image"]))
        values = [v for row in rows for v in row[:w]]
        if "mask" in case:
            _, _, _, _, mrows = read_png(os.path.join(SAMPLE_DIR, case["mask"]))
            mask = [1 if x > 127 else 0 for row in mrows for x in row[:w]]
        else:
            mask = [1] * (w * h)
        cols, rows_n = w - 1, h - 1
        valid_cell = [0] * (cols * rows_n)
        for r in range(rows_n):
            for c in range(cols):
                valid_cell[r * cols + c] = (
                    mask[r * w + c] and mask[r * w + c + 1] and
                    mask[(r + 1) * w + c] and mask[(r + 1) * w + c + 1])
        ox, oy = case.get("origin", [0.0, 0.0])
        sx, sy = case.get("spacing", [1.0, 1.0])
        fixture = {
            "case": name,
            "width": w,
            "height": h,
            "values": values,
            "mask": mask,
            "validCell": valid_cell,
            "origin": [ox, oy],
            "spacing": [sx, sy],
            "levels": [],
        }
        for level in case["levels"]:
            lines, frac = extract(w, h, values, valid_cell, level)
            for ln in lines:
                phys = [(ox + sx * x, oy + sy * y) for x, y in ln["node_points"]]
                length = 0.0
                n = len(phys)
                for i in range(1, n):
                    length += ((phys[i][0] - phys[i - 1][0]) ** 2 +
                               (phys[i][1] - phys[i - 1][1]) ** 2) ** 0.5
                area = None
                if not ln["open"]:
                    s = 0.0
                    for i in range(n):
                        x1, y1 = phys[i]
                        x2, y2 = phys[(i + 1) % n]
                        s += x1 * y2 - x2 * y1
                    area = abs(s) / 2.0
                    length += ((phys[0][0] - phys[-1][0]) ** 2 +
                               (phys[0][1] - phys[-1][1]) ** 2) ** 0.5
                ln["physical_points"] = phys
                ln["length"] = length
                ln["area"] = area
            fixture["levels"].append({
                "level": level,
                "lines": lines,
                "fractions": [x for x in frac],
            })
        with open(os.path.join(OUT_DIR, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(fixture, f)
        print("wrote", name)


if __name__ == "__main__":
    main()
