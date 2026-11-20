#!/usr/bin/env python3
"""参考实现：时域抗锯齿历史重投影（按 samples 包内说明.txt 的约定）。

用法:
  python3 -I reference_reproject.py <sequence.json> [--tau 0.05]
      [--history-weight 0.9] [--cap 8] [--out result.json]

输出每帧每像素的累积线性 RGB、计数与拒绝原因，用于与网页端实现交叉校验。
"""
import argparse
import json
import math


def validate(seq):
    if not isinstance(seq, dict):
        raise ValueError("序列必须是 JSON 对象")
    w = seq.get("width")
    h = seq.get("height")
    frames = seq.get("frames")
    if not isinstance(w, int) or not isinstance(h, int) or w <= 0 or h <= 0:
        raise ValueError("width/height 必须为正整数")
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames 必须为非空数组")
    n = w * h
    for i, f in enumerate(frames):
        for key in ("color", "depth", "motion"):
            if not isinstance(f.get(key), list) or len(f[key]) != n:
                raise ValueError("第%d帧 %s 长度应为 %d" % (i, key, n))
        if len(f["color"][0]) != 3:
            raise ValueError("第%d帧 color 必须为 RGB 三元组" % i)
        if len(f["motion"][0]) != 2:
            raise ValueError("第%d帧 motion 必须为二元组" % i)
        if not isinstance(f.get("jitter"), list) or len(f["jitter"]) != 2:
            raise ValueError("第%d帧 jitter 必须为 [x,y]" % i)
    return w, h, frames


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def reproject(seq, tau=0.05, history_weight=0.9, cap=8):
    w, h, frames = validate(seq)
    n = w * h

    # 上一帧累积结果
    prev_color = [[0.0, 0.0, 0.0] for _ in range(n)]
    prev_count = [0] * n

    all_frames = []
    for fi, frame in enumerate(frames):
        color = frame["color"]
        depth = frame["depth"]
        motion = frame["motion"]
        jx, jy = frame["jitter"]
        if fi > 0:
            pjx, pjy = frames[fi - 1]["jitter"]
        out_color = [[0.0, 0.0, 0.0] for _ in range(n)]
        out_count = [0] * n
        reasons = [""] * n
        debug = [None] * n

        for p in range(n):
            x = p % w
            y = p // w
            cur = color[p]

            # 当前深度为空：直接输出当前色、计数 1
            if depth[p] is None:
                out_color[p] = list(cur)
                out_count[p] = 1
                reasons[p] = "current-depth-null"
                debug[p] = {"samples": []}
                continue

            if fi == 0:
                out_color[p] = list(cur)
                out_count[p] = 1
                reasons[p] = "first-frame"
                debug[p] = {"samples": []}
                continue

            # 历史位置：像素中心 + motion + 前帧 jitter - 当前 jitter
            hx = (x + 0.5) + motion[p][0] + pjx - jx
            hy = (y + 0.5) + motion[p][1] + pjy - jy

            # 双线性四个邻居（像素中心采样）；负数也必须用 floor 语义
            x0 = math.floor(hx - 0.5)
            y0 = math.floor(hy - 0.5)
            fx = (hx - 0.5) - x0
            fy = (hy - 0.5) - y0
            x1 = x0 + 1
            y1 = y0 + 1
            cand = [
                (x0, y0, (1 - fx) * (1 - fy)),
                (x1, y0, fx * (1 - fy)),
                (x0, y1, (1 - fx) * fy),
                (x1, y1, fx * fy),
            ]

            samples = []
            wsum = 0.0
            H = [0.0, 0.0, 0.0]
            nn = 0.0
            reject_bits = {"out-of-bounds": 0, "depth-null": 0, "depth-threshold": 0}
            for sx, sy, sw in cand:
                inside = 0 <= sx < w and 0 <= sy < h
                rec = {
                    "x": sx, "y": sy, "weight": sw, "valid": False,
                    "inside": inside, "reason": None,
                    "prevColor": None, "prevCount": None, "depth": None,
                }
                if not inside:
                    rec["reason"] = "out-of-bounds"
                    reject_bits["out-of-bounds"] += 1
                    samples.append(rec)
                    continue
                q = sy * w + sx
                rec["depth"] = depth[p]
                pd = frames[fi - 1]["depth"][q]
                if pd is None:
                    rec["reason"] = "depth-null"
                    reject_bits["depth-null"] += 1
                    samples.append(rec)
                    continue
                if abs(depth[p] - pd) > tau * max(1.0, depth[p]):
                    rec["reason"] = "depth-threshold"
                    reject_bits["depth-threshold"] += 1
                    samples.append(rec)
                    continue
                rec["valid"] = True
                rec["prevColor"] = list(prev_color[q])
                rec["prevCount"] = prev_count[q]
                samples.append(rec)
                wsum += sw
                for c in range(3):
                    H[c] += sw * prev_color[q][c]
                nn += sw * prev_count[q]

            if wsum <= 0.0:
                out_color[p] = list(cur)
                out_count[p] = 1
                if reject_bits["depth-threshold"]:
                    reasons[p] = "no-valid-depth-threshold"
                elif reject_bits["depth-null"]:
                    reasons[p] = "no-valid-depth-null"
                else:
                    reasons[p] = "no-valid-out-of-bounds"
                debug[p] = {"historyX": hx, "historyY": hy, "samples": samples}
                continue

            # 有效权重重新归一化
            inv = 1.0 / wsum
            for c in range(3):
                H[c] *= inv
            nn *= inv
            for s in samples:
                if s["valid"]:
                    s["normalizedWeight"] = s["weight"] * inv

            # 当前帧 3x3 邻域逐通道最小最大值限幅
            lo = [float("inf")] * 3
            hi = [float("-inf")] * 3
            for ny in range(max(0, y - 1), min(h, y + 2)):
                for nx in range(max(0, x - 1), min(w, x + 2)):
                    nc = color[ny * w + nx]
                    for c in range(3):
                        lo[c] = min(lo[c], nc[c])
                        hi[c] = max(hi[c], nc[c])
            Hclamped = [clamp(H[c], lo[c], hi[c]) for c in range(3)]

            a = min(history_weight, nn / (nn + 1.0))
            out = [(1.0 - a) * cur[c] + a * Hclamped[c] for c in range(3)]
            out_color[p] = out
            # 约定：新计数 = min(cap, n + 1)，n 为有效点历史计数的加权值
            out_count[p] = min(cap, int(nn + 1.0 + 1e-9))
            reasons[p] = "accepted"
            debug[p] = {
                "historyX": hx, "historyY": hy, "samples": samples,
                "H": H, "Hclamped": Hclamped, "n": nn, "alpha": a,
                "neighborhoodMin": lo, "neighborhoodMax": hi,
            }

        all_frames.append({
            "frame": fi,
            "color": out_color,
            "count": out_count,
            "reason": reasons,
            "debug": debug,
        })
        prev_color = out_color
        prev_count = out_count

    return {"width": w, "height": h, "frames": all_frames}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sequence")
    ap.add_argument("--tau", type=float, default=0.05)
    ap.add_argument("--history-weight", type=float, default=0.9)
    ap.add_argument("--cap", type=int, default=8)
    ap.add_argument("--out")
    args = ap.parse_args()
    with open(args.sequence, "r", encoding="utf-8") as f:
        seq = json.load(f)
    res = reproject(seq, args.tau, args.history_weight, args.cap)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(res, f)
        print("written", args.out)
    else:
        for fr in res["frames"]:
            print("frame", fr["frame"], fr["color"], "count", fr["count"], fr["reason"])


if __name__ == "__main__":
    main()
