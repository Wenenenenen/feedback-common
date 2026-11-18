#!/usr/bin/env python3
# 独立参照实现（numpy 手工组装，与 JS 产品代码完全独立），用于交叉验证。
# 运行：python3 -I test/numpy_reference.py <样例目录>
import json
import math
import sys
from pathlib import Path

import numpy as np


def analyze(positions, triangles):
    nV = len(positions)
    P = np.asarray(positions, dtype=float)
    areas = []
    valid = []
    excluded = []
    for fi, t in enumerate(triangles):
        e1 = P[t[1]] - P[t[0]]
        e2 = P[t[2]] - P[t[0]]
        ar = 0.5 * np.linalg.norm(np.cross(e1, e2))
        if len(set(t)) < 3 or ar <= 1e-12:
            excluded.append((fi, ar))
        else:
            valid.append(fi)
        areas.append(ar)
    edge_faces = {}
    for fi in valid:
        t = triangles[fi]
        for k in range(3):
            key = tuple(sorted((t[k], t[(k + 1) % 3])))
            edge_faces.setdefault(key, []).append(fi)
    # components
    v2f = {}
    for fi in valid:
        for v in triangles[fi]:
            v2f.setdefault(v, []).append(fi)
    seen = set()
    comps = []
    for fi in valid:
        if fi in seen:
            continue
        stack = [fi]
        seen.add(fi)
        fs = []
        vs = set()
        while stack:
            f = stack.pop()
            fs.append(f)
            for v in triangles[f]:
                vs.add(v)
                for g in v2f.get(v, []):
                    if g not in seen:
                        seen.add(g)
                        stack.append(g)
        comps.append((sorted(vs), sorted(fs)))
    return P, valid, excluded, edge_faces, comps, areas


def solve(positions, triangles, sources, tau):
    P, valid, excluded, edge_faces, comps, areas = analyze(positions, triangles)
    nV = len(P)
    dist = [None] * nV
    for verts, faces in comps:
        local = {g: k for k, g in enumerate(verts)}
        n = len(verts)
        csrc = [local[s] for s in sources if s in local]
        if not csrc:
            continue
        edges = set()
        elen = 0.0
        for fi in faces:
            t = triangles[fi]
            for k in range(3):
                edges.add(tuple(sorted((t[k], t[(k + 1) % 3]))))
        for u, v in edges:
            elen += np.linalg.norm(P[u] - P[v])
        mean_edge = elen / len(edges)
        t = tau * mean_edge**2

        M = np.zeros(n)
        L = np.zeros((n, n))
        finfo = []
        for fi in faces:
            a, b, c = triangles[fi]
            ga, gb, gc = local[a], local[b], local[c]
            ar = areas[fi]
            nrm = np.cross(P[b] - P[a], P[c] - P[a])
            nrm = nrm / np.linalg.norm(nrm)
            dA = 2 * ar
            gb0 = np.cross(nrm, P[c] - P[b]) / dA
            gb1 = np.cross(nrm, P[a] - P[c]) / dA
            gb2 = np.cross(nrm, P[b] - P[a]) / dA
            finfo.append(((ga, gb, gc), ar, (gb0, gb1, gb2)))
            M[[ga, gb, gc]] += ar / 3

        def cot(fi, opp):
            tt = triangles[fi]
            o = [v for v in tt if v != opp]
            e1 = P[o[0]] - P[opp]
            e2 = P[o[1]] - P[opp]
            return float(np.dot(e1, e2) / np.linalg.norm(np.cross(e1, e2)))

        for u, v in edges:
            w = 0.0
            for fi in edge_faces[(u, v)]:
                opp = next(q for q in triangles[fi] if q != u and q != v)
                w += 0.5 * cot(fi, opp)
            lu, lv = local[u], local[v]
            L[lu, lu] += w
            L[lv, lv] += w
            L[lu, lv] -= w
            L[lv, lu] -= w

        b = np.zeros(n)
        b[csrc] = 1.0
        A = np.diag(M) + t * L
        u = np.linalg.solve(A, b)
        heat_res = np.linalg.norm(A @ u - b) / max(np.linalg.norm(b), 1e-12)

        g = np.zeros(n)
        for (li, ar, grads) in finfo:
            gu = sum(grads[k] * u[li[k]] for k in range(3))
            ln = np.linalg.norm(gu)
            X = -gu / ln if ln > 1e-12 else np.zeros(3)
            for k in range(3):
                g[li[k]] += ar * float(np.dot(grads[k], X))

        src_set = set(csrc)
        free = [i for i in range(n) if i not in src_set]
        phi = np.zeros(n)
        poi_res = 0.0
        if free:
            Lff = L[np.ix_(free, free)]
            gf = g[free]
            phif = np.linalg.solve(Lff, gf)
            poi_res = np.linalg.norm(Lff @ phif - gf) / max(np.linalg.norm(gf), 1e-12)
            for k, i in enumerate(free):
                phi[i] = phif[k]
        for li in range(n):
            dist[verts[li]] = max(phi[li], 0.0)
        for s in csrc:
            dist[verts[s]] = 0.0
        yield_info = (heat_res, poi_res, mean_edge, t)
    return dist


def main():
    d = Path(sys.argv[1])
    if len(sys.argv) > 2 and sys.argv[2] == '--dump':
        # 导出全部样例的参照距离场，供 JS 交叉校验
        out = {}
        for name in ['flat', 'folded', 'obtuse', 'stress', 'disconnected', 'isolated', 'degenerate']:
            case = json.loads((d / f'{name}.json').read_text())
            res = solve(case['positions'], case['triangles'], case['sources'], case['tau'])
            out[name] = [None if x is None else float(x) for x in res]
        out_path = Path(sys.argv[3])
        out_path.write_text(json.dumps(out))
        print(f'dumped reference distances to {out_path}')
        return
    flat = json.loads((d / 'flat.json').read_text())
    dist = solve(flat['positions'], flat['triangles'], flat['sources'], flat['tau'])
    P = np.asarray(flat['positions'])
    src = 40
    print('vertex  heat_dist   euclidean   rel.err   edge_graph')
    # edge graph
    import heapq

    adj = {}
    for t in flat['triangles']:
        for k in range(3):
            u, v = t[k], t[(k + 1) % 3]
            w = float(np.linalg.norm(P[u] - P[v]))
            adj.setdefault(u, []).append((v, w))
            adj.setdefault(v, []).append((u, w))
    ed = {src: 0.0}
    pq = [(0.0, src)]
    while pq:
        du, u = heapq.heappop(pq)
        if du > ed[u]:
            continue
        for v, w in adj[u]:
            if v not in ed or du + w < ed[v]:
                ed[v] = du + w
                heapq.heappush(pq, (du + w, v))
    worst = 0.0
    for v in [1, 9, 41, 49, 58, 80, 0]:
        eu = float(np.linalg.norm(P[v] - P[src]))
        rel = abs(dist[v] - eu) / eu if eu else 0
        worst = max(worst, rel)
        print(f'{v:6d}  {dist[v]:9.4f}  {eu:9.4f}  {rel*100:7.2f}%  {ed[v]:9.4f}')
    allworst = max(
        abs(dist[v] - float(np.linalg.norm(P[v] - P[src]))) / float(np.linalg.norm(P[v] - P[src]))
        for v in range(len(P))
        if v != src
    )
    print(f'worst relative error over all verts: {allworst*100:.2f}%')

    # folded vs flat
    fold = json.loads((d / 'folded.json').read_text())
    d2 = solve(fold['positions'], fold['triangles'], fold['sources'], fold['tau'])
    md = max(abs(a - b) for a, b in zip(dist, d2) if a is not None and b is not None)
    print(f'flat vs folded max diff: {md:.2e}')


if __name__ == '__main__':
    main()
