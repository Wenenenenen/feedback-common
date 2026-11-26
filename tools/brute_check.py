#!/usr/bin/env python3
"""Brute-force cross-check: enumerate every (permutation, shifts) arrangement
and compare against best_plan(). Small n only.

Run: python3 -I brute_check.py
"""
import itertools
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from ref import best_plan, MAX_TOTAL_SHIFT, MAX_STAGE_SHIFT  # noqa: E402


def brute(sections, bands):
    n = len(sections)
    nb = len(bands)
    best_key = None
    best_seq = None
    for perm in itertools.permutations(range(n)):
        for shifts in itertools.product(range(MAX_STAGE_SHIFT + 1),
                                        repeat=n):
            if sum(shifts) > MAX_TOTAL_SHIFT:
                continue
            book = [0] * nb
            total = 0
            psum = 0
            ok = True
            for k, i in enumerate(perm):
                sh = shifts[k]
                total += sh
                psum += total
                for b in range(nb):
                    book[b] += sections[i]["gain"][b] - 256 * sh
                    if book[b] > sections[i]["limit"][b]:
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                continue
            seq = tuple((sections[i]["id"], shifts[k])
                        for k, i in enumerate(perm))
            key = (total, psum, seq)
            if best_key is None or key < best_key:
                best_key = key
                best_seq = seq
    return best_key, best_seq


def check(path):
    import json
    with open(path, "rb") as f:
        plan = json.loads(f.read().decode("utf-8"))
    sections, bands = plan["sections"], plan["bands"]
    bk, bseq = brute(sections, bands)
    got = best_plan(sections, bands)
    if bk is None:
        assert got is None, f"{path}: brute says no solution, DP found one"
        print(f"{os.path.basename(path)}: both NO SOLUTION  OK")
        return
    gkey = (got["total"], got["psum"], tuple(got["seq"]))
    assert gkey == bk, f"{path}:\n brute={bk}\n dp   ={gkey}"
    print(f"{os.path.basename(path)}: {bseq} total={bk[0]} "
          f"psum={bk[1]}  OK")


if __name__ == "__main__":
    base = os.path.join(os.path.dirname(__file__), "cases")
    check(os.path.join(base, "infeasible.json"))
    check(os.path.join(base, "needshift.json"))
    # randomized small cases
    import random
    random.seed(7)
    for t in range(40):
        n = random.randint(1, 5)
        nb = random.randint(1, 4)
        bands = sorted(random.sample(range(1, 24000), nb))
        ids = random.sample(range(65536), n)
        secs = []
        for i in range(n):
            secs.append({
                "id": ids[i],
                "b": [16384, 0, 0], "a": [0, 0],
                "gain": [random.randint(-400, 700) for _ in bands],
                "limit": [random.randint(-600, 900) for _ in bands],
            })
        p = {"bands": bands, "sections": secs}
        tmp = os.path.join(base, "_tmp_small.json")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(p, f)
        check(tmp)
    os.remove(os.path.join(base, "_tmp_small.json"))
    print("all brute-force checks passed")
