#!/usr/bin/env python3
"""Inspect the sample environment cases (untrusted data, read-only)."""
import json
import math
import sys


def main(path: str) -> None:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    size = data["size"]
    faces = data["faces"]
    print(f"file={path} size={size} faces={sorted(faces)}")
    for name in ("px", "nx", "py", "ny", "pz", "nz"):
        arr = faces[name]
        assert len(arr) == size * size, (name, len(arr))
        mins = [min(c[k] for c in arr) for k in range(3)]
        maxs = [max(c[k] for c in arr) for k in range(3)]
        print(f"  {name}: n={len(arr)} min={mins} max={maxs}")

    # direction table per spec
    def dir_of(face, u, v):
        if face == "px":
            d = (1, -v, -u)
        elif face == "nx":
            d = (-1, -v, u)
        elif face == "py":
            d = (u, 1, v)
        elif face == "ny":
            d = (u, -1, -v)
        elif face == "pz":
            d = (u, -v, 1)
        else:
            d = (-u, -v, -1)
        l = math.sqrt(sum(x * x for x in d))
        return tuple(x / l for x in d)

    base = path.rsplit("/", 1)[-1]
    if base == "direction.json":
        # hypothesis: color encodes the normalized direction (abs? or raw with offset)
        worst = 0.0
        worst_abs = 0.0
        for face in faces:
            for row in range(size):
                for col in range(size):
                    u = -1 + 2 * (col + 0.5) / size
                    v = -1 + 2 * (row + 0.5) / size
                    d = dir_of(face, u, v)
                    c = faces[face][row * size + col]
                    worst = max(worst, max(abs(c[k] - d[k]) for k in range(3)))
                    worst_abs = max(worst_abs, max(abs(c[k] - abs(d[k])) for k in range(3)))
        print(f"  color == dir? maxerr={worst:.6g}  color==abs(dir)? maxerr={worst_abs:.6g}")
    if base == "highlight.json":
        # locate bright texels (>0.1 on red channel) per face
        for face in faces:
            bright = [
                (i // size, i % size, faces[face][i])
                for i in range(size * size)
                if faces[face][i][0] > 0.1
            ]
            print(f"  {face}: bright count={len(bright)}")
            for row, col, c in bright[:6]:
                u = -1 + 2 * (col + 0.5) / size
                v = -1 + 2 * (row + 0.5) / size
                print(f"    ({row},{col}) uv=({u:.3f},{v:.3f}) rgb={c} dir={dir_of(face,u,v)}")
    if base == "capacity.json":
        # all identical?
        c0 = faces["px"][0]
        same = all(faces[f][i] == c0 for f in faces for i in range(size * size))
        print(f"  all texels identical to {c0}: {same}")
    if base == "constant.json":
        c0 = faces["px"][0]
        same = all(faces[f][i] == c0 for f in faces for i in range(size * size))
        print(f"  all texels identical to {c0}: {same}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        main(p)
