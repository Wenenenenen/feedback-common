"""Reference masked Richardson-Lucy per 约定.txt, stdlib only. Validated against reference.json."""
import json
import sys

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/tools")
from png_io import read_png

EPS = 1e-8


def reflect(k, n):
    if n == 1:
        return 0
    p = k % (2 * n - 2)
    return p if p < n else 2 * n - 2 - p


def forward(x, h, anchor, H, W):
    """(Ax)[y,x] = sum_ab h[a,b] x[R(y+a-ay,H), R(x+b-ax,W)]"""
    kh = len(h)
    kw = len(h[0])
    ax, ay = anchor
    out = [[0.0] * W for _ in range(H)]
    for y in range(H):
        for xx in range(W):
            s = 0.0
            for a in range(kh):
                ry = reflect(y + a - ay, H)
                for b in range(kw):
                    rx = reflect(xx + b - ax, W)
                    s += h[a][b] * x[ry][rx]
            out[y][xx] = s
    return out


def adjoint(z, h, anchor, H, W):
    """True adjoint: scatter each output position's contributions with same R indexing."""
    kh = len(h)
    kw = len(h[0])
    ax, ay = anchor
    out = [[0.0] * W for _ in range(H)]
    for y in range(H):
        for xx in range(W):
            val = z[y][xx]
            for a in range(kh):
                ry = reflect(y + a - ay, H)
                for b in range(kw):
                    rx = reflect(xx + b - ax, W)
                    out[ry][rx] += h[a][b] * val
    return out


def load_kernel(path):
    kj = json.load(open(path))
    h = [[float(v) for v in row] for row in kj["weights"]]
    anchor = kj["anchor"]
    assert all(v >= 0 for row in h for v in row)
    total = sum(sum(row) for row in h)
    h = [[v / total for v in row] for row in h]
    return h, anchor


def run_rl(y_img, mask, h, anchor, n_iter):
    H = len(y_img)
    W = len(y_img[0])
    chans = len(y_img[0][0]) if isinstance(y_img[0][0], (list, tuple)) else 1
    if chans == 1:
        y_list = [[[y_img[y][x]] for x in range(W)] for y in range(H)]
    else:
        y_list = [[[y_img[y][x][c] for c in range(chans)] for x in range(W)] for y in range(H)]

    denom_const = adjoint(mask, h, anchor, H, W)  # A^T M
    valid_count = sum(sum(row) for row in mask)
    history = []
    mses = []
    x = []
    for c in range(chans):
        vals = [y_list[y][x][c] for y in range(H) for x in range(W) if mask[y][x] > 0.5]
        mean = sum(vals) / len(vals) if vals else 0.0
        init = max(mean, EPS)
        x.append([[init] * W for _ in range(H)])

    def mse_of(ax):
        s = 0.0
        for y in range(H):
            for xx in range(W):
                if mask[y][xx] > 0.5:
                    for c in range(chans):
                        d = ax[c][y][xx] - y_list[y][xx][c]
                        s += d * d
        return s / (valid_count * chans)

    for it in range(n_iter + 1):
        ax = [forward(x[c], h, anchor, H, W) for c in range(chans)]
        mses.append(mse_of(ax))
        history.append([[ [x[c][y][xx] for c in range(chans)] for xx in range(W)] for y in range(H)])
        if it == n_iter:
            break
        for c in range(chans):
            ratio = [[0.0] * W for _ in range(H)]
            for y in range(H):
                for xx in range(W):
                    if mask[y][xx] > 0.5:
                        ratio[y][xx] = y_list[y][xx][c] / max(ax[c][y][xx], EPS)
            at_ratio = adjoint(ratio, h, anchor, H, W)
            for y in range(H):
                for xx in range(W):
                    if denom_const[y][xx] > 0:
                        x[c][y][xx] = x[c][y][xx] * at_ratio[y][xx] / denom_const[y][xx]
                    else:
                        x[c][y][xx] = 0.0
    return history, mses, ax


def main():
    case_dir = "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/_untrusted/cases"
    ref = json.load(open(case_dir + "/reference.json"))
    h, anchor = load_kernel(case_dir + "/tiny.json")
    H, W = 3, 4
    probe = [[ref["probe"][y * W + x] for x in range(W)] for y in range(H)]
    dual = [[ref["dual"][y * W + x] for x in range(W)] for y in range(H)]

    ap = forward(probe, h, anchor, H, W)
    atd = adjoint(dual, h, anchor, H, W)
    ap_flat = [ap[y][x] for y in range(H) for x in range(W)]
    atd_flat = [atd[y][x] for y in range(H) for x in range(W)]

    err1 = max(abs(a - b) for a, b in zip(ap_flat, ref["A_probe"]))
    err2 = max(abs(a - b) for a, b in zip(atd_flat, ref["AT_dual"]))
    dot1 = sum(ap[y][x] * dual[y][x] for y in range(H) for x in range(W))
    dot2 = sum(probe[y][x] * atd[y][x] for y in range(H) for x in range(W))
    print("A_probe max err:", err1)
    print("AT_dual max err:", err2)
    print("dots:", dot1, dot2, "ref:", ref["dot_Ax_y"], "diff:", abs(dot1 - dot2))

    # RL iterations on tiny.png with mask
    w, hh, ch, raw = read_png(case_dir + "/tiny.png")
    assert (w, hh, ch) == (4, 3, 1)
    y_img = [[raw[y * w + x] / 255.0 for x in range(w)] for y in range(hh)]
    w2, h2, ch2, mraw = read_png(case_dir + "/tiny-mask.png")
    mask = [[1.0 if mraw[y * w2 + x] > 127 else 0.0 for x in range(w2)] for y in range(h2)]
    print("mask valid:", sum(sum(r) for r in mask))

    history, mses, ax = run_rl(y_img, mask, h, anchor, 3)
    for it in range(4):
        flat = [history[it][y][x][0] for y in range(hh) for x in range(w)]
        err = max(abs(a - b) for a, b in zip(flat, ref["iterations"][it]))
        print("iter", it, "x max err:", err, "mse:", mses[it], "ref mse:", ref["mse"][it],
              "mse err:", abs(mses[it] - ref["mse"][it]))


if __name__ == "__main__":
    main()
