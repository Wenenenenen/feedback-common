#!/usr/bin/env python3 -I
"""暴力参考实现：枚举每拍 (p,s) 序列，用于与 solver.js 对拍。仅小规模使用。"""
import json
import random
import subprocess
import sys
import os

PMIN, PMAX, STEP = 8, 39, 2


def build_match(onsets, frame_count):
    on_sc = [0] * frame_count
    off_sc = [0] * frame_count
    on_src = [-1] * frame_count
    off_src = [-1] * frame_count
    for (o, won, woff) in sorted(onsets):
        for d in range(-3, 4):
            f = o + d
            if not (0 <= f < frame_count):
                continue
            dist = abs(d)
            if won > 0:
                v = won - 2 * dist
                if v > on_sc[f]:
                    on_sc[f] = v
                    on_src[f] = o
            if woff > 0:
                v = woff - 2 * dist
                if v > off_sc[f]:
                    off_sc[f] = v
                    off_src[f] = o
    return on_sc, off_sc, on_src, off_src


def brute(beats, anchors, onsets, frame_count):
    """anchors: dict beat->frame。返回 (G, 序列[(p,s)...]) 或 None。"""
    on_sc, off_sc, on_src, off_src = build_match(onsets, frame_count)
    end_u = anchors[beats] // 6

    def match(b, u, p, s):
        onf = u * 6
        offf = onf + (3 * p if s == 0 else 4 * p)
        a = on_sc[onf] if onf < frame_count else 0
        c = off_sc[offf] if offf < frame_count else 0
        return a + c

    best = [None, None]  # score, seq

    def rec(b, u, prev_p, prev_s, score, seq):
        if b == beats:
            if u != end_u:
                return
            if best[0] is None or score > best[0] or (
                score == best[0] and seq < best[1]
            ):
                best[0] = score
                best[1] = list(seq)
            return
        if b in anchors and u != anchors[b] // 6:
            return
        for p in range(PMIN, PMAX + 1):
            if u + p > end_u:
                break
            for s in (0, 1):
                if prev_p is not None and abs(p - prev_p) > STEP:
                    continue
                cost = 0 if prev_p is None else 3 * abs(p - prev_p) + (7 if s != prev_s else 0)
                m = match(b, u, p, s)
                seq.append((p, s))
                rec(b + 1, u + p, p, s, score + m - cost, seq)
                seq.pop()

    rec(0, anchors[0] // 6, None, None, 0, [])
    if best[0] is None:
        return None
    return best[0], best[1]


def make_case(rng, beats, frame_count, n_anchors_extra=1, n_onsets=40):
    # 先随机生成一条可行路径，再围绕它造锚点和候选
    ps = [rng.randint(PMIN, PMAX)]
    for _ in range(beats - 1):
        lo = max(PMIN, ps[-1] - STEP)
        hi = min(PMAX, ps[-1] + STEP)
        ps.append(rng.randint(lo, hi))
    us = [rng.randint(0, 20)]
    for p in ps:
        us.append(us[-1] + p)
    total = us[-1] * 6 + 300
    if total > frame_count:
        return None
    anchors = [[0, us[0] * 6], [beats, us[-1] * 6]]
    if n_anchors_extra:
        picks = sorted(rng.sample(range(1, beats), min(n_anchors_extra, beats - 1)))
        for b in picks:
            anchors.append([b, us[b] * 6])
        anchors.sort()
    onsets = []
    used = set()
    for b in range(beats):
        onf = us[b] * 6
        s = rng.choice([0, 1])
        offf = onf + (3 * ps[b] if s == 0 else 4 * ps[b])
        for f, kind in ((onf, "on"), (offf, "off")):
            if f in used:
                continue
            used.add(f)
            won = rng.randint(50, 900) if kind == "on" else rng.randint(0, 200)
            woff = rng.randint(50, 900) if kind == "off" else rng.randint(0, 200)
            onsets.append([f, won, woff])
    # 加一些噪声候选
    while len(onsets) < n_onsets:
        f = rng.randint(0, frame_count - 1)
        if f in used:
            continue
        used.add(f)
        onsets.append([f, rng.randint(0, 300), rng.randint(0, 300)])
    return {"beats": beats, "anchors": anchors, "onsets": onsets,
            "frame_count": frame_count}


def make_infeasible(rng):
    """锚点间距对给定拍数不可达：每步 p∈[8,39]。"""
    beats = rng.randint(2, 6)
    frame_count = 3000
    # gap 单位 u，要么过短要么过长
    if rng.random() < 0.5:
        gap_u = beats * PMIN - rng.randint(1, 5)  # 总步数不够
    else:
        gap_u = beats * PMAX + rng.randint(1, 5)  # 总步数超了
    anchors = [[0, 0], [beats, gap_u * 6]]
    raw = [[rng.randint(0, frame_count - 1), rng.randint(0, 500), rng.randint(0, 500)]
           for _ in range(10)]
    uniq, used2 = [], set()
    for o in raw:
        if o[0] not in used2:
            uniq.append(o)
            used2.add(o[0])
    return {"beats": beats, "anchors": anchors, "onsets": uniq,
            "frame_count": frame_count}


def main():
    rng = random.Random(20261123)
    node = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run-case.js")
    n_cases = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    fails = 0
    for t in range(n_cases):
        if t % 5 == 4:
            case = make_infeasible(rng)
            expect_feasible = False
        else:
            beats = rng.randint(2, 8)
            fc = rng.randint(400, 1500)
            case = make_case(rng, beats, fc, rng.randint(0, 2), rng.randint(10, 60))
            if case is None:
                continue
            expect_feasible = True
        ref = brute(case["beats"], dict((a, b) for a, b in case["anchors"]),
                    case["onsets"], case["frame_count"]) if expect_feasible else None
        inp = json.dumps(case)
        out = subprocess.run(["node", node], input=inp, capture_output=True, text=True)
        if out.returncode != 0:
            print("NODE ERROR", out.stderr[:500])
            fails += 1
            continue
        got = json.loads(out.stdout)
        if ref is None:
            if got.get("feasible"):
                print("CASE", t, "REF infeasible but NODE feasible")
                fails += 1
            continue
        ref_score, ref_seq = ref
        if not got.get("feasible"):
            print("CASE", t, "NODE infeasible but REF score", ref_score)
            fails += 1
            continue
        if got["score"] != ref_score:
            print("CASE", t, "SCORE mismatch ref", ref_score, "got", got["score"])
            fails += 1
            continue
        got_seq = [(b_["period"] // 6, b_["swing"]) for b_ in got["beats"]]
        if got_seq != ref_seq:
            print("CASE", t, "LEX mismatch ref", ref_seq, "got", got_seq)
            fails += 1
            continue
        # 校验导出字段恒等式
        s = sum(b_["onScore"] + b_["offScore"] - b_["penalty"] for b_ in got["beats"])
        if s != got["score"]:
            print("CASE", t, "penalty accounting mismatch", s, got["score"])
            fails += 1
    print("ran", n_cases, "cases, fails =", fails)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
