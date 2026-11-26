#!/usr/bin/env python3
"""Emit per-pixel reference solution as JSON for cross-checking the JS solver."""
import json, os, sys, math

sys.path.insert(0, os.path.dirname(__file__))
from reference_solve import read_pnm, solve_pixel


def main():
    data_dir, tol = sys.argv[1], int(sys.argv[2])
    spec = json.load(open(os.path.join(data_dir, "groups.json"), encoding="utf-8"))
    groups = []
    w = h = 0
    for g in spec["groups"]:
        w, h, _, bg = read_pnm(os.path.join(data_dir, g["background"]))
        _, _, _, ob = read_pnm(os.path.join(data_dir, g["observed"]))
        if g.get("valid"):
            _, _, _, vd = read_pnm(os.path.join(data_dir, g["valid"]))
        else:
            vd = bytes([255]) * (w * h)
        groups.append((bg, ob, vd))
    out = []
    for p in range(w * h):
        pg = []
        for bg, ob, vd in groups:
            if vd[p] != 0:
                pg.append((
                    tuple(bg[3 * p + c] for c in range(3)),
                    tuple(ob[3 * p + c] for c in range(3)),
                    True,
                ))
            else:
                pg.append(None)
        status, sol, feasible = solve_pixel(pg, tol)
        out.append({
            "s": status,
            "sol": sol,
            "nA": len(feasible),
        })
    print(json.dumps({"w": w, "h": h, "tol": tol, "pixels": out}))


if __name__ == "__main__":
    main()
