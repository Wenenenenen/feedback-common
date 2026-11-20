#!/usr/bin/env python3
"""独立参考实现：按 README 约定做 marching squares（与 app/core.js 独立编写）。

用法:
  python3 -I reference.py case.json
读取 case.json 中的 image/mask/levels/origin/spacing，
向 stdout 输出完整几何 JSON，供与 JS 结果逐字段比对。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from png_inspect import read_png  # noqa: E402


def h_id(r, c, w):
    return r * (w - 1) + c


def v_id(r, c, w, h, horiz):
    return horiz + r * w + c


def cell_edges(r, c, w, h, horiz):
    return (
        h_id(r, c, w),
        v_id(r, c + 1, w, h, horiz),
        h_id(r + 1, c, w),
        v_id(r, c, w, h, horiz),
    )


EDGE_NAMES = ("top", "right", "bottom", "left")


def extract(width, height, values, valid_cell, level):
    horiz = height * (width - 1)
    total = horiz + (height - 1) * width
    above = [v > level for v in values]
    frac = [None] * total

    def edge_coord(e, f):
        if e < horiz:
            r = e // (width - 1)
            c = e - r * (width - 1)
            return (c + f, r)
        local = e - horiz
        r = local // width
        c = local - r * width
        return (c, r + f)

    def ensure(e):
        if frac[e] is not None:
            return
        if e < horiz:
            r = e // (width - 1)
            c = e - r * (width - 1)
            v1 = values[r * width + c]
            v2 = values[r * width + c + 1]
        else:
            local = e - horiz
            r = local // width
            c = local - r * width
            v1 = values[r * width + c]
            v2 = values[(r + 1) * width + c]
        frac[e] = (level - v1) / (v2 - v1)

    # 边 -> 相邻段 id 列表
    adj = [[] for _ in range(total)]
    segments = []  # (e1, e2, r, c)
    cell_segs = {}
    cols = width - 1
    rows = height - 1
    for r in range(rows):
        for c in range(cols):
            if not valid_cell[r * cols + c]:
                continue
            i0 = r * width + c
            sa, sb = above[i0], above[i0 + 1]
            sc = above[i0 + width + 1]
            sd = above[i0 + width]
            if (sa and sb and sc and sd) or not (sa or sb or sc or sd):
                continue
            a, b = values[i0], values[i0 + 1]
            cv = values[i0 + width + 1]
            d = values[i0 + width]
            edges = cell_edges(r, c, width, height, horiz)
            crosses = (sa != sb, sb != sc, sc != sd, sd != sa)
            cross_idx = tuple(k for k, x in enumerate(crosses) if x)
            pairs = []
            if len(cross_idx) == 4:
                q = (a - level) * (cv - level) - (b - level) * (d - level)
                if q > 0:
                    pairs = ((0, 1), (2, 3))
                else:
                    pairs = ((0, 3), (1, 2))
            else:
                pairs = (cross_idx,)
            for i, j in pairs:
                e1, e2 = edges[i], edges[j]
                ensure(e1)
                ensure(e2)
                sid = len(segments)
                segments.append((e1, e2, r, c))
                adj[e1].append(sid)
                adj[e2].append(sid)
                cell_segs.setdefault((r, c), []).append(sid)

    used = [False] * len(segments)
    lines = []

    def walk(start_seg, start_edge):
        seq = [start_edge]
        seg = start_seg
        cur_edge = start_edge
        while True:
            used[seg] = True
            e1, e2 = segments[seg][0], segments[seg][1]
            nxt_edge = e2 if e1 == cur_edge else e1
            seq.append(nxt_edge)
            if len(adj[nxt_edge]) == 1:
                return seq, True
            cand = [s for s in adj[nxt_edge] if s != seg]
            if not cand:
                return seq, False
            seg = cand[0]
            cur_edge = nxt_edge
            if cur_edge == start_edge:
                return seq, False

    for e in range(total):
        if len(adj[e]) == 1:
            seg0 = adj[e][0]
            if used[seg0]:
                continue
            seq, _ = walk(seg0, e)
            lines.append({"open": True, "edge_ids": seq})

    for sid in range(len(segments)):
        if used[sid]:
            continue
        e0 = segments[sid][0]
        seq, _ = walk(sid, e0)
        if len(seq) > 1 and seq[0] == seq[-1]:
            seq.pop()
        lines.append({"open": False, "edge_ids": seq})

    # 父环
    closed = [ln for ln in lines if not ln["open"]]

    def node_area(ln):
        pts = [edge_coord(e, frac[e]) for e in ln["edge_ids"]]
        s = 0.0
        n = len(pts)
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            s += x1 * y2 - x2 * y1
        return abs(s) / 2.0

    def contains(ln, px, py):
        pts = [edge_coord(e, frac[e]) for e in ln["edge_ids"]]
        inside = False
        j = len(pts) - 1
        for i in range(len(pts)):
            xi, yi = pts[i]
            xj, yj = pts[j]
            if ((yi > py) != (yj > py)) and \
                    (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    areas = [node_area(ln) for ln in closed]
    for idx, ln in enumerate(lines):
        if ln["open"]:
            ln["id"] = None
            ln["parent_id"] = None
            ln["node_area"] = None
        else:
            k = closed.index(ln)
            ln["id"] = k
            ln["node_area"] = areas[k]
    for k, inner in enumerate(closed):
        px, py = edge_coord(inner["edge_ids"][0], frac[inner["edge_ids"][0]])
        best = None
        for m, outer in enumerate(closed):
            if m == k or areas[m] <= areas[k]:
                continue
            if contains(outer, px, py):
                if best is None or areas[m] < areas[best]:
                    best = m
        inner["parent_id"] = best

    out_lines = []
    open_counter = 0
    closed_counter = 0
    for ln in lines:
        pts = [edge_coord(e, frac[e]) for e in ln["edge_ids"]]
        if ln["open"]:
            lid = f"O{open_counter}"
            open_counter += 1
        else:
            lid = f"R{closed_counter}"
            closed_counter += 1
        out_lines.append({
            "id": lid,
            "open": ln["open"],
            "parent_index": ln["parent_id"],
            "node_points": pts,
            "edge_ids": ln["edge_ids"],
            "node_area": ln["node_area"],
        })
    return out_lines, frac


def main():
    case_path = sys.argv[1]
    with open(case_path, encoding="utf-8") as f:
        case = json.load(f)
    base = os.path.dirname(case_path)
    w, h, bitd, ctype, rows = read_png(os.path.join(base, case["image"]))
    values = [v for row in rows for v in row[:w]]
    if "mask" in case:
        mw, mh, _, _, mrows = read_png(os.path.join(base, case["mask"]))
        assert (mw, mh) == (w, h)
        mask = [1 if x > 127 else 0 for row in mrows for x in row[:w]]
    else:
        mask = [1] * (w * h)
    cols, rows_n = w - 1, h - 1
    valid_cell = [0] * (cols * rows_n)
    for r in range(rows_n):
        for c in range(cols):
            valid_cell[r * cols + c] = (
                mask[r * w + c] and mask[r * w + c + 1] and
                mask[(r + 1) * w + c] and mask[(r + 1) * w + c + 1])
    ox, oy = case.get("origin", [0.0, 0.0])
    sx, sy = case.get("spacing", [1.0, 1.0])
    result = {"width": w, "height": h, "levels": []}
    for level in case["levels"]:
        lines, frac = extract(w, h, values, valid_cell, level)
        for ln in lines:
            phys = [(ox + sx * x, oy + sy * y) for x, y in ln["node_points"]]
            length = 0.0
            n = len(phys)
            for i in range(1, n):
                length += ((phys[i][0] - phys[i - 1][0]) ** 2 +
                           (phys[i][1] - phys[i - 1][1]) ** 2) ** 0.5
            area = None
            if not ln["open"]:
                s = 0.0
                for i in range(n):
                    x1, y1 = phys[i]
                    x2, y2 = phys[(i + 1) % n]
                    s += x1 * y2 - x2 * y1
                area = abs(s) / 2.0
                length += ((phys[0][0] - phys[-1][0]) ** 2 +
                           (phys[0][1] - phys[-1][1]) ** 2) ** 0.5
            ln["physical_points"] = phys
            ln["length"] = length
            ln["area"] = area
        result["levels"].append({"level": level, "lines": lines})
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
