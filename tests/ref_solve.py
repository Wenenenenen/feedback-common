#!/usr/bin/env python3
"""精确有理数参考解（Fraction 高斯消元），生成测试用例与期望值到 JSON。
运行: python3 -I tests/ref_solve.py
"""
import json
import os
import random
from fractions import Fraction

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def frac(x):
    if isinstance(x, Fraction):
        return x
    return Fraction(x).limit_denominator(10 ** 6)


def solve_exact(data):
    bands = data["bands"]
    B = len(bands)
    N = len(data["patches"])
    # T[dst][src]
    T = [[Fraction(0) for _ in range(N)] for _ in range(N)]
    idx = {str(p["id"]): i for i, p in enumerate(data["patches"])}
    for src, dst, w in data["links"]:
        T[idx[str(dst)]][idx[str(src)]] += frac(w)
    # C[k][i][j]
    C = [[[Fraction(0) for _ in range(B)] for _ in range(N)] for _ in range(B)]
    for i, p in enumerate(data["patches"]):
        for s, t, q in p["convert"]:
            C[s][i][t] += frac(q)
    refl = [[frac(v) for v in p["reflect"]] for p in data["patches"]]
    D = [[frac(v) for v in p["direct"]] for p in data["patches"]]

    E = [[Fraction(0)] * B for _ in range(N)]
    R = [[Fraction(0)] * B for _ in range(N)]
    F = [[Fraction(0)] * B for _ in range(N)]
    O = [[Fraction(0)] * B for _ in range(N)]

    def gauss(A, b):
        n = len(b)
        M = [row[:] + [b[i]] for i, row in enumerate(A)]
        for col in range(n):
            piv = max(range(col, n), key=lambda r: abs(M[r][col]))
            M[col], M[piv] = M[piv], M[col]
            pv = M[col][col]
            for r in range(col + 1, n):
                f = M[r][col] / pv
                for c in range(col, n + 1):
                    M[r][c] -= f * M[col][c]
        x = [Fraction(0)] * n
        for i in range(n - 1, -1, -1):
            s = M[i][n]
            for j in range(i + 1, n):
                s -= M[i][j] * x[j]
            x[i] = s / M[i][i]
        return x

    for j in range(B):
        A = [[Fraction(1 if i == s else 0) - T[i][s] * refl[s][j]
              for s in range(N)] for i in range(N)]
        rhs = [D[i][j] for i in range(N)]
        for k in range(j):
            fv = [C[k][s][j] * E[s][k] for s in range(N)]
            for i in range(N):
                rhs[i] += sum(T[i][s] * fv[s] for s in range(N))
        ej = gauss(A, rhs)
        for i in range(N):
            E[i][j] = ej[i]
            R[i][j] = refl[i][j] * E[i][j]
            F[i][j] = sum(C[k][i][j] * E[i][k] for k in range(j))
            O[i][j] = R[i][j] + F[i][j]

    rgb = [[Fraction(0) for _ in range(3)] for _ in range(N)]
    for i in range(N):
        for b in range(B):
            for ch in range(3):
                rgb[i][ch] += O[i][b] * frac(data["observerRGB"][b][ch])

    def f2x(m):
        return [[float(v) for v in row] for row in m]
    return {
        "incident": f2x(E), "reflected": f2x(R),
        "fluorescent": f2x(F), "outgoing": f2x(O),
        "direct": f2x(D), "rgb": f2x(rgb),
    }


def random_case(rng, N, B, link_count):
    wl = sorted(rng.sample(range(380, 720), B))
    obs = [[round(rng.random(), 3) for _ in range(3)] for _ in range(B)]
    patches = []
    for i in range(N):
        refl = [round(rng.uniform(0.05, 0.5), 4) for _ in range(B)]
        conv = []
        for s in range(B - 1):
            budget = 1 - refl[s]
            used = 0
            for t in range(s + 1, B):
                if rng.random() < 0.3 and budget - used > 0.01:
                    q = round(rng.uniform(0.01, min(0.3, budget - used)), 4)
                    conv.append([s, t, q])
                    used += q
        patches.append({
            "id": "p%02d" % i,
            "direct": [round(rng.uniform(0, 2), 4) for _ in range(B)],
            "reflect": refl,
            "convert": conv,
        })
    # 保证每个来源的链接比例之和 <= 0.95
    per_source = {}
    links = []
    for _ in range(link_count):
        s = rng.randrange(N)
        d = rng.randrange(N)
        cur = per_source.setdefault(s, 0)
        if cur >= 0.9:
            continue
        w = round(rng.uniform(0.01, min(0.2, 0.95 - cur)), 4)
        per_source[s] = cur + w
        links.append([patches[s]["id"], patches[d]["id"], w])
    return {"bands": wl, "observerRGB": obs, "patches": patches, "links": links}


def main():
    with open(os.path.join(ROOT, "samples", "fluorescent-patches.json"), encoding="utf-8") as f:
        sample = json.load(f)
    sample.pop("说明", None)
    cases = [sample]
    rng = random.Random(20261129)
    cases.append(random_case(rng, 5, 4, 18))
    cases.append(random_case(rng, 12, 7, 120))
    cases.append(random_case(rng, 33, 10, 900))
    expected = [solve_exact(c) for c in cases]
    out = {"cases": cases, "expected": expected}
    with open(os.path.join(ROOT, "tests", "ref-cases.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("wrote tests/ref-cases.json with", len(cases), "cases; sizes:",
          [(len(c["patches"]), len(c["bands"]), len(c["links"])) for c in cases])


if __name__ == "__main__":
    main()
