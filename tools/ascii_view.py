#!/usr/bin/env python3
"""Print ASCII visualization of mask and image value bands."""
import sys
sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/saddle-contour-atlas/tools")
from png_inspect import read_png

path = sys.argv[1]
w, h, bitd, ctype, rows = read_png(path)
mode = sys.argv[2] if len(sys.argv) > 2 else "mask"
if mode == "mask":
    for r in range(h):
        print("".join("#" if rows[r][c] >= 128 else "." for c in range(w)))
else:
    t = float(sys.argv[3])
    for r in range(h):
        print("".join("+" if rows[r][c] > t else "-" for c in range(w)))
