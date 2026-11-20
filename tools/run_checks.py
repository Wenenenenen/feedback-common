#!/usr/bin/env python3
# Validate ref_impl.py against reference.json. Run: python3 -I run_checks.py <cases_dir>
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ref_impl as R

cases_dir = sys.argv[1]
ref = json.load(open(os.path.join(cases_dir, "reference.json")))
overall = 0.0
for idx in range(4):
    case = json.load(open(os.path.join(cases_dir, f"case-{idx}.json")))
    tw, th, ch, pixels = R.read_png(os.path.join(cases_dir, case["texture"]))
    img = R.render(case, pixels, tw, th, ch, "elliptic")
    worst = 0.0
    for row in ref:
        if row["case"] != idx:
            continue
        x, y = row["pixel"]
        got = img[y][x]
        for k in range(4):
            worst = max(worst, abs(got[k] - row["linearRGBA"][k]))
    overall = max(overall, worst)
    print(f"case-{idx}: worst abs diff vs reference = {worst:.3e}")
print(f"OVERALL: {overall:.3e}")
