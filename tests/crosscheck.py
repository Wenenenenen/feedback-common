#!/usr/bin/env python3
"""独立的标准库交叉核对：不 import 任何产品代码，按包内文字定义重算一遍。

对 samples/sweep-harmonic-cases.zip：
  * 解析 WAV（RIFF 块、16 位 PCM）
  * 逆扫频 g、定标 D、线性卷积 c（numpy 不可用，用 FFT 的纯 Python 实现）
  * 定位零点与四窗，输出 JSON；与页面导出的 results.json 逐项对比

用法：
  python3 -I tests/crosscheck.py [--package samples/sweep-harmonic-cases.zip]
                                 [--results /path/to/sweep-harmonic-results.json]
"""
import argparse
import cmath
import json
import math
import struct
import sys
import wave


# ---------------------------- WAV ----------------------------

def read_wav(path):
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"{path}: 仅支持 16 位 PCM（实际 {sw * 8} 位）")
    frames = len(raw) // (2 * ch)
    chans = [[0.0] * frames for _ in range(ch)]
    vals = struct.unpack("<" + "h" * (frames * ch), raw[: frames * ch * 2])
    for i in range(frames):
        for c in range(ch):
            chans[c][i] = vals[i * ch + c] / 32768.0
    return {"channels": ch, "rate": sr, "frames": frames, "data": chans}


# ---------------------------- FFT ----------------------------

def fft(a):
    n = len(a)
    if n == 1:
        return a
    ev = fft(a[0::2])
    od = fft(a[1::2])
    out = [0j] * n
    for k in range(n // 2):
        t = cmath.exp(-2j * math.pi * k / n) * od[k]
        out[k] = ev[k] + t
        out[k + n // 2] = ev[k] - t
    return out


def ifft(a):
    n = len(a)
    conj = [x.conjugate() for x in a]
    return [x.conjugate() / n for x in fft(conj)]


def next_pow2(n):
    p = 1
    while p < n:
        p <<= 1
    return p


def linear_conv(a, b):
    n = next_pow2(len(a) + len(b) - 1)
    fa = fft([complex(x) for x in a] + [0j] * (n - len(a)))
    fb = fft([complex(x) for x in b] + [0j] * (n - len(b)))
    return [z.real for z in ifft([fa[i] * fb[i] for i in range(n)])]


# ---------------------------- 定义 ----------------------------

def analyze(sweep, capture, p):
    x = sweep["data"][0]
    N = len(x)
    f0, f1 = p["f0"], p["f1"]
    L = math.log(f1 / f0)
    g = [x[N - 1 - j] * math.exp(-j * L / N) for j in range(N)]
    D = sum(x[k] * g[N - 1 - k] for k in range(N))
    if D == 0:
        raise SystemExit("D = 0")

    results = []
    for y in capture["data"]:
        conv = linear_conv(y, g)
        data_len = len(conv)
        c = [v / D for v in conv]
        s = N - 1 + p["lo"]
        e = N - 1 + p["hi"]
        zero = s
        best = abs(c[s])
        for n in range(s + 1, e + 1):
            a = abs(c[n])
            if a > best:            # 严格大于 → 同高取较早帧
                best, zero = a, n
        wins = []
        for q in (1, 2, 3, 4):
            shift = math.floor(N * math.log(q) / L + 0.5)
            center = zero - shift
            start = center - p["pre"]
            end = center + p["post"]
            energy = 0.0
            peak = 0.0
            peak_index = -1
            zero_filled = 0
            for i in range(start, end):
                if 0 <= i < data_len:
                    v = c[i]
                else:
                    v = 0.0
                    zero_filled += 1
                energy += v * v
                if abs(v) > abs(peak):
                    peak, peak_index = v, i
            wins.append({
                "q": q, "shift": shift, "center": center,
                "start": start, "end": end, "energy": energy,
                "peak": peak, "peakIndex": peak_index,
                "zeroFilled": zero_filled,
            })
        conflicts = []
        for a in range(4):
            for b in range(a + 1, 4):
                A, B = wins[a], wins[b]
                if A["start"] < B["end"] and B["start"] < A["end"]:
                    conflicts.append([A["q"], B["q"]])
        results.append({
            "calibrator": D, "dataLen": data_len, "zero": zero,
            "zeroRel": zero - (N - 1), "zeroValue": c[zero],
            "windows": wins, "conflicts": conflicts,
        })
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", default="samples/sweep-harmonic-cases.zip")
    ap.add_argument("--results", default=None, help="页面导出的 results.json，用于对比")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    import zipfile
    with zipfile.ZipFile(args.package) as z:
        names = z.namelist()
        sweep_name = next(n for n in names if n.endswith("sweep.wav"))
        cap_name = next(n for n in names if n.endswith("capture.wav"))
        setup_name = next(n for n in names if n.endswith("setup.json"))
        import io
        sweep = read_wav(io.BytesIO(z.read(sweep_name)))
        capture = read_wav(io.BytesIO(z.read(cap_name)))
        params = json.loads(z.read(setup_name))

    out = analyze(sweep, capture, params)
    doc = {"params": params, "channels": out}

    if args.results:
        with open(args.results, "r", encoding="utf-8") as f:
            theirs = json.load(f)
        ok = True
        for mine, them in zip(doc["channels"], theirs["channels"]):
            if mine["zero"] != them["zero"]:
                print(f"零点不一致：{mine['zero']} vs {them['zero']}", file=sys.stderr)
                ok = False
            if abs(mine["calibrator"] - them["calibrator"]) > abs(mine["calibrator"]) * 1e-9:
                print("定标值不一致", file=sys.stderr)
                ok = False
            for a, b in zip(mine["windows"], them["windows"]):
                if (a["start"], a["end"]) != (b["start"], b["end"]):
                    print(f"q{a['q']} 窗不一致", file=sys.stderr)
                    ok = False
                if abs(a["energy"] - b["energy"]) > max(1e-10, abs(b["energy"]) * 1e-8):
                    print(f"q{a['q']} 能量不一致 {a['energy']} vs {b['energy']}", file=sys.stderr)
                    ok = False
            if mine["conflicts"] != them["conflicts"]:
                print("冲突列表不一致", file=sys.stderr)
                ok = False
        print("核对通过" if ok else "核对失败", file=sys.stderr)
        if not ok:
            sys.exit(1)

    if args.json:
        print(json.dumps(doc, ensure_ascii=False, indent=1))
    else:
        for i, r in enumerate(out):
            print(f"通道 {i + 1}：零点 {r['zero']}（rel {r['zeroRel']}）值 {r['zeroValue']:.9f} 定标 {r['calibrator']:.9f}")
            for w in r["windows"]:
                print(f"  q{w['q']} 中心 {w['center']} 窗 [{w['start']}, {w['end']}) "
                      f"能量 {w['energy']:.9e} 峰值 {w['peak']:+.6f} 补零 {w['zeroFilled']}")
            print(f"  冲突 {r['conflicts']}")


if __name__ == "__main__":
    main()
