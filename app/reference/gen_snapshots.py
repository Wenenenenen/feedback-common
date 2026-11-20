#!/usr/bin/env python3
"""生成 Python 参考实现快照，供 Node 端 core.mjs 交叉校验。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from reference_reproject import reproject  # noqa: E402

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "sample-data")
OUT = os.path.join(HERE, "snapshots")

CASES = ["three-pixels.json", "moving.json", "capacity.json"]
PARAM_SETS = [
    {"tau": 0.05, "history_weight": 0.9, "cap": 8},       # 默认
    {"tau": 0.0, "history_weight": 0.0, "cap": 1},        # 边界：无历史权重、计数上限 1
    {"tau": 0.5, "history_weight": 0.99, "cap": 64},      # 边界：最大值
    {"tau": 0.2, "history_weight": 0.5, "cap": 3},        # 中间值
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for case in CASES:
        with open(os.path.join(DATA, case), "r", encoding="utf-8") as f:
            seq = json.load(f)
        for pi, prm in enumerate(PARAM_SETS):
            res = reproject(seq, prm["tau"], prm["history_weight"], prm["cap"])
            # 快照只保留数值，不带 debug
            snap = {
                "case": case,
                "params": prm,
                "width": res["width"],
                "height": res["height"],
                "frames": [
                    {
                        "frame": fr["frame"],
                        "color": fr["color"],
                        "count": fr["count"],
                        "reason": fr["reason"],
                    }
                    for fr in res["frames"]
                ],
            }
            name = "%s.param%d.json" % (case.replace(".json", ""), pi)
            with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
                json.dump(snap, f)
            print("snapshot", name)


if __name__ == "__main__":
    main()
