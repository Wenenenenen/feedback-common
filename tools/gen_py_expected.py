"""Generate independent python reference results for Node cross-check."""
import json
import sys

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/tools")
from png_io import read_png
from ref_rl import load_kernel, run_rl

CASE = "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/_untrusted/cases"
OUT = "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/tools"


def gray(path):
    w, h, ch, raw = read_png(path)
    return [[raw[y * w + x] / 255.0 for x in range(w)] for y in range(h)], w, h


# medium grayscale, 7 updates (iterations 0..7), no mask
h, anchor = load_kernel(CASE + "/medium.json")
y_img, w, ht = gray(CASE + "/medium.png")
mask = [[1.0] * w for _ in range(ht)]
history, mses, _ = run_rl(y_img, mask, h, anchor, 7)
flat = [[[history[it][y][x][0] for x in range(w)] for y in range(ht)] for it in range(8)]
json.dump({"mse": mses, "x": flat}, open(OUT + "/py_medium.json", "w"))

# medium rgb, 5 updates
w, ht, ch, raw = read_png(CASE + "/medium-rgb.png")
assert ch == 3
y_rgb = [[[raw[(y * w + x) * 3 + c] / 255.0 for c in range(3)] for x in range(w)] for y in range(ht)]
mask = [[1.0] * w for _ in range(ht)]
history, mses, _ = run_rl(y_rgb, mask, h, anchor, 5)
flat = [[[[history[it][y][x][c] for x in range(w)] for y in range(ht)] for c in range(3)] for it in range(6)]
json.dump({"mse": mses, "x": flat}, open(OUT + "/py_rgb.json", "w"))
print("python references written")
