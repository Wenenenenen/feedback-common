#!/usr/bin/env python3
"""独立 Python 参考实现 / 随机用例生成器（不依赖本项目 JS）。

用法：
  python3 reference_oracle.py gen <seed> <fixture.json> <expected.json>
  python3 reference_oracle.py ref <fixture.json> <expected.json>

参考实现严格按题面文字：
  像素 (p-dark)/(bright-dark) 夹 [0,1] -> 均值 -> *65536-32768
  -> Python round（半档取偶）-> 夹 int16；
  逐 tick 按 id 最小的有效条带选源；帧值 Σ(样本*刻数)/960 半档取偶。
"""
import json
import math
import random
import sys

TPF = 960
MAXF = 2_880_000
MISSING = None


def round_even_float(x):
    # Python 3 round(float) 即半档取偶（作用在 double 实际值上）
    return int(round(x))


def channel_sample(ch):
    if ch is None:
        return None
    if not isinstance(ch, list) or len(ch) < 3:
        return None
    dark, bright, values = ch[0], ch[1], ch[2]
    if not isinstance(dark, (int, float)) or not isinstance(bright, (int, float)):
        return None
    if isinstance(dark, bool) or isinstance(bright, bool):
        return None
    if not (bright > dark):
        return None
    if not isinstance(values, list) or len(values) == 0:
        return None
    norm = []
    den = bright - dark
    for p in values:
        if p is None or not isinstance(p, (int, float)):
            return None
        x = (p - dark) / den
        if x < 0:
            x = 0.0
        elif x > 1:
            x = 1.0
        norm.append(x)
    mean = sum(norm) / len(norm)
    v = mean * 65536 - 32768
    s = round_even_float(v)
    return max(-32768, min(32767, s))


def floor_div(a, b):
    return a // b


def div_round_even(num, den=960):
    q = num // den
    r = num - q * den
    two = 2 * r
    if two < den:
        return q
    if two > den:
        return q + 1
    return q if q % 2 == 0 else q + 1


def render(data):
    raw_strips = data["strips"]
    strips = []
    for idx, rs in enumerate(raw_strips):
        sid = rs.get("id", idx + 1)
        start = int(rs["start"])
        step = int(rs.get("step", rs.get("width")))
        assert step > 0
        rows = rs["rows"]
        sl, sr = [], []
        for row in rows:
            lch = row[0] if isinstance(row, list) else row.get("left")
            rch = row[1] if isinstance(row, list) else row.get("right")
            sl.append(channel_sample(lch))
            sr.append(channel_sample(rch))
        strips.append(dict(id=sid, start=start, step=step, n=len(rows),
                           end=start + len(rows) * step, l=sl, r=sr))
    strips.sort(key=lambda s: s["id"])

    F = int(data.get("frames") or 0)
    if not F:
        F = max(1, math.ceil(max(s["end"] for s in strips) / TPF))
    F = min(F, MAXF)
    T = F * TPF

    pcm = [0] * (2 * F)
    cov_l = [0] * F
    cov_r = [0] * F
    num_l = [0] * F
    num_r = [0] * F
    gap_l, gap_r = [], []
    run_l = run_r = None

    for t in range(T):
        vl = vr = None
        for s in strips:
            if t < s["start"] or t >= s["end"]:
                continue
            i = (t - s["start"]) // s["step"]
            if i < 0 or i >= s["n"]:
                continue
            if vl is None and s["l"][i] is not None:
                vl = s["l"][i]
            if vr is None and s["r"][i] is not None:
                vr = s["r"][i]
            if vl is not None and vr is not None:
                break
        f = t // TPF
        if vl is not None:
            num_l[f] += vl
            cov_l[f] += 1
        if vr is not None:
            num_r[f] += vr
            cov_r[f] += 1
        if vl is None:
            if run_l is None:
                run_l = t
        elif run_l is not None:
            gap_l.append([run_l, t]); run_l = None
        if vr is None:
            if run_r is None:
                run_r = t
        elif run_r is not None:
            gap_r.append([run_r, t]); run_r = None

    if run_l is not None:
        gap_l.append([run_l, T])
    if run_r is not None:
        gap_r.append([run_r, T])

    for f in range(F):
        l = max(-32768, min(32767, div_round_even(num_l[f], TPF)))
        r = max(-32768, min(32767, div_round_even(num_r[f], TPF)))
        pcm[2 * f] = l
        pcm[2 * f + 1] = r

    # 帧来源（按条带合计刻数）
    sources = []
    for f in range(F):
        A, B = f * TPF, (f + 1) * TPF
        acc = {0: {}, 1: {}}
        for t in range(A, B):
            for ci, arr_key in ((0, "l"), (1, "r")):
                pass
        # 简化：再扫一遍该 960 窗
        for t in range(A, B):
            vl_id = vr_id = None
            for s in strips:
                if t < s["start"] or t >= s["end"]:
                    continue
                i = (t - s["start"]) // s["step"]
                if i < 0 or i >= s["n"]:
                    continue
                if vl_id is None and s["l"][i] is not None:
                    vl_id = s["id"]
                if vr_id is None and s["r"][i] is not None:
                    vr_id = s["id"]
                if vl_id is not None and vr_id is not None:
                    break
            if vl_id is not None:
                acc[0][vl_id] = acc[0].get(vl_id, 0) + 1
            if vr_id is not None:
                acc[1][vr_id] = acc[1].get(vr_id, 0) + 1
        sources.append({
            "left": sorted([{"stripId": k, "ticks": v} for k, v in acc[0].items()],
                           key=lambda x: x["stripId"]),
            "right": sorted([{"stripId": k, "ticks": v} for k, v in acc[1].items()],
                            key=lambda x: x["stripId"]),
        })

    return {
        "frameCount": F,
        "pcm": pcm,
        "coverageLeft": cov_l,
        "coverageRight": cov_r,
        "gapsLeft": gap_l,
        "gapsRight": gap_r,
        "sources": sources,
    }


def rand_channel(rng):
    k = rng.random()
    if k < 0.2:
        return None
    dark = rng.randrange(0, 40)
    bright = dark + rng.randrange(0, 8)
    if k < 0.32:
        bright = dark
    n = rng.randrange(1, 7)
    vals = []
    for _ in range(n):
        if rng.random() < 0.1:
            vals.append(None)
        else:
            vals.append(rng.randrange(0, bright + 10) - 2)
    return [dark, bright, vals]


def gen(seed):
    rng = random.Random(seed)
    F = rng.randrange(1, 7)
    T = F * TPF
    strips = []
    for k in range(rng.randrange(1, 5)):
        step = rng.choice([1, 3, 7, 16, 300, 479, 720, 960, 1441])
        start = rng.randrange(0, T) - rng.randrange(0, 400)
        rows = [[rand_channel(rng), rand_channel(rng)]
                for _ in range(rng.randrange(1, 9))]
        strips.append({"id": k + 1, "start": start, "step": step, "rows": rows})
    return {"frames": F, "strips": strips}


def main():
    mode = sys.argv[1]
    if mode == "gen":
        seed = int(sys.argv[2])
        fx_path, ex_path = sys.argv[3], sys.argv[4]
        data = gen(seed)
        with open(fx_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        exp = render(data)
        with open(ex_path, "w", encoding="utf-8") as f:
            json.dump(exp, f)
        print(f"seed {seed}: frames={exp['frameCount']} -> {fx_path}")
    elif mode == "ref":
        with open(sys.argv[2], encoding="utf-8") as f:
            data = json.load(f)
        exp = render(data)
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            json.dump(exp, f)
        print("wrote", sys.argv[3])


if __name__ == "__main__":
    main()
