"""Dump reference full-grid results for every sample case for cross-checking.

Run: python3 -I tools/dump_ref.py samples/film-stack-cases.json tools/ref_outputs.json
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmm_ref import full_grid


def main():
    in_path, out_path = sys.argv[1], sys.argv[2]
    with open(in_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    wavelengths = [float(w) for w in data["wavelengths"]]
    angles = [float(a) for a in range(0, 86)]  # 0..85 inclusive, step 1

    output = {"wavelengths": wavelengths, "angles": angles, "cases": {}}
    for case in data["cases"]:
        layers = [
            {"d": float(l[0]), "n": float(l[1]), "k": float(l[2])}
            for l in case["layers"]
        ]
        grid = full_grid(float(case["n0"]), float(case["ns"]),
                         [(l["d"], l["n"], l["k"]) for l in layers],
                         wavelengths, angles)
        output["cases"][case["id"]] = grid

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f)
    print(f"wrote {out_path}: {len(output['cases'])} cases, "
          f"{len(angles)} angles x {len(wavelengths)} wavelengths")


if __name__ == "__main__":
    main()
