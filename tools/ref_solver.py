#!/usr/bin/env python3
"""Python 参考实现：与 assets/solver.js 语义一致，用于交叉验证。

用法：
  python3 -I tools/ref_solver.py --check <model.json>        # 打印求解结论
  python3 -I tools/ref_solver.py --selftest                  # 随机模型自测
"""
import argparse
import json
import random
import sys
from functools import lru_cache


class Model:
    def __init__(self, raw):
        self.horizon = int(raw["horizon"])
        self.states = list(raw["states"])
        actions = list(raw["actions"])
        actions.sort(key=lambda a: a["id"])
        self.actions = actions
        self.sid = {s["id"]: i for i, s in enumerate(self.states)}
        self.aid = {a["id"]: i for i, a in enumerate(actions)}
        self.initial = frozenset(self.sid[x] for x in raw["initial"])
        self.goals = frozenset(self.sid[s["id"]] for s in self.states if s.get("goal"))
        n, m = len(self.states), len(actions)
        self.succ = [[frozenset() for _ in range(n)] for _ in range(m)]
        for sid, aid, nxt in raw.get("transitions", []):
            s, a = self.sid[sid], self.aid[aid]
            self.succ[a][s] = self.succ[a][s] | frozenset(self.sid[x] for x in nxt)

    def legal(self, belief):
        out = []
        for ai in range(len(self.actions)):
            if all(self.succ[ai][s] for s in belief):
                out.append(ai)
        return out

    def apply(self, belief, ai):
        union = frozenset().union(*(self.succ[ai][s] for s in belief))
        groups = {}
        for s in union:
            groups.setdefault(self.states[s].get("hint", ""), set()).add(s)
        return sorted((h, frozenset(ss)) for h, ss in groups.items())


def evaluate(m: Model, belief, t):
    @lru_cache(maxsize=None)
    def go(b, tt):
        if b and b <= m.goals:
            return True, 0, -1, ()
        if tt <= 0:
            return False, None, -1, ()
        best = None
        for ai in m.legal(b):
            branches = m.apply(b, ai)
            evals = [go(bb, tt - 1) for _, bb in branches]
            if all(e[0] for e in evals):
                cost = 1 + max(e[1] for e in evals)
                if best is None or cost < best[1] or (
                    cost == best[1] and m.actions[ai]["id"] < m.actions[best[2]]["id"]
                ):
                    best = (True, cost, ai, tuple((h, e) for (h, _), e in zip(branches, evals)))
        if best is None:
            return False, None, -1, ()
        return best

    return go(belief, t)


def analyze(m: Model, belief, t):
    root = evaluate(m, belief, t)
    rows = []
    for ai, a in enumerate(m.actions):
        missing = [m.states[s]["id"] for s in belief if not m.succ[ai][s]]
        if missing:
            rows.append({"id": a["id"], "legal": False, "guaranteed": False, "cost": None,
                         "chosen": False, "reason": "illegal"})
            continue
        branches = m.apply(belief, ai)
        evals = [evaluate(m, bb, t - 1) for _, bb in branches]
        if not all(e[0] for e in evals):
            rows.append({"id": a["id"], "legal": True, "guaranteed": False, "cost": None,
                         "chosen": False, "reason": "failing-branch",
                         "branches": [{"hint": h, "belief": sorted(m.states[s]["id"] for s in bb),
                                       "win": e[0], **({"cost": e[1]} if e[0] else {})}
                                      for (h, bb), e in zip(branches, evals)]})
            continue
        cost = 1 + max(e[1] for e in evals)
        chosen = root[0] and root[2] == ai
        rows.append({"id": a["id"], "legal": True, "guaranteed": True, "cost": cost,
                     "chosen": chosen,
                     "reason": ("chosen" if chosen else
                                ("tie-lost" if root[0] and root[1] == cost else "ok")),
                     "branches": [{"hint": h, "belief": sorted(m.states[s]["id"] for s in bb),
                                   "win": True, "cost": e[1]}
                                  for (h, bb), e in zip(branches, evals)]})
    return root, rows


def random_model(rng):
    n = rng.randint(2, 10)
    m = rng.randint(1, 5)
    horizon = rng.randint(1, 8)
    hints = rng.choice([["A", "B"], ["未亮", "左灯", "右灯", "完成"], ["x", "y", "z"]])
    states = [{"id": i + 1, "hint": rng.choice(hints),
               "goal": (i == n - 1 and rng.random() < 0.7)} for i in range(n)]
    # 保证至少一个终点
    if not any(s["goal"] for s in states):
        states[rng.randrange(n)]["goal"] = True
    actions = [{"id": j + 1, name: f"a{j+1}"} for j in range(m)]
    transitions = []
    for s in states:
        for a in actions:
            if rng.random() < 0.75:
                k = rng.randint(1, 2)
                nxt = rng.sample([x["id"] for x in states], k=min(k, n))
                transitions.append([s["id"], a["id"], nxt])
    init_size = rng.randint(1, min(3, n))
    initial = rng.sample([s["id"] for s in states], init_size)
    return {"horizon": horizon, "states": states, "actions": actions,
            "initial": initial, "transitions": transitions, "rules": "random"}


def selftest(count):
    rng = random.Random(20261124)
    for i in range(count):
        yield random_model(rng)


def counter_trace(m: Model, belief, t, first_ai):
    steps = []
    cur, tt, ai = belief, t, first_ai
    while True:
        legal = m.legal(cur)
        if ai not in legal:
            return {"ok": False, "reason": "illegal", "steps": steps}
        branches = m.apply(cur, ai)
        candidates = [(h, bb, evaluate(m, bb, tt - 1)) for h, bb in branches]
        failing = [(h, bb, e) for h, bb, e in candidates if not e[0]]
        if not failing:
            return {"ok": False, "reason": "no-failing-branch", "steps": steps}
        h, bb, _ = failing[0]
        steps.append({"actionId": m.actions[ai]["id"], "hint": h,
                      "belief": sorted(m.states[s]["id"] for s in bb),
                      "remaining": tt - 1})
        cur, tt = bb, tt - 1
        if cur and cur <= m.goals:
            return {"ok": True, "steps": steps, "endReason": "all-goal"}
        if tt <= 0:
            return {"ok": True, "steps": steps, "endReason": "timeout"}
        nxt = None
        for cand in m.legal(cur):
            if any(not evaluate(m, b2, tt - 1)[0] for _, b2 in m.apply(cur, cand)):
                nxt = cand
                break
        if nxt is None:
            return {"ok": True, "steps": steps, "endReason": "stuck"}
        ai = nxt


def full(raw):
    m = Model(raw)
    root, rows = analyze(m, m.initial, m.horizon)
    traces = {}
    for ai in m.legal(m.initial):
        traces[str(m.actions[ai]["id"])] = counter_trace(m, m.initial, m.horizon, ai)
    return {
        "root": {"win": root[0], "cost": root[1],
                 "action": m.actions[root[2]]["id"] if root[0] and root[2] >= 0 else None},
        "rows": rows,
        "traces": traces,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check")
    ap.add_argument("--full")
    ap.add_argument("--selftest", type=int, default=0)
    args = ap.parse_args()
    if args.full:
        with open(args.full, encoding="utf-8") as f:
            raw = json.load(f)
        print(json.dumps(full(raw), ensure_ascii=False))
    elif args.check:
        with open(args.check, encoding="utf-8") as f:
            raw = json.load(f)
        m = Model(raw)
        win, cost, ai, _ = evaluate(m, m.initial, m.horizon)
        print(json.dumps({"win": win, "cost": cost,
                          "action": m.actions[ai]["id"] if win else None}, ensure_ascii=False))
    elif args.selftest:
        for raw in selftest(args.selftest):
            m = Model(raw)
            win, cost, ai, _ = evaluate(m, m.initial, m.horizon)
            print(json.dumps({"solvable": win, "cost": cost,
                              "action": m.actions[ai]["id"] if win else None}, ensure_ascii=False))


if __name__ == "__main__":
    main()
