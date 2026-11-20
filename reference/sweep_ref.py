#!/usr/bin/env python3
"""Reference implementation of the parallel-transport sweep, per 说明.md.

Run with -I and pass the sample directory as an argument:
  python3 -I reference/sweep_ref.py samples-extracted/helix.json
"""
import json
import math
import sys

EPS_LEN = 1e-10      # zero-length segment
EPS_SUM = 1e-8       # degenerate tangent sum
EPS_DOT = 1e-10      # near +/-1 tangent dot
EPS_AREA = 1e-12     # degenerate face

# ---------- small vec3 helpers (right-handed) ----------

def vadd(a, b): return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
def vsub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def vscale(a, s): return [a[0] * s, a[1] * s, a[2] * s]
def vdot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def vcross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]
def vnorm(a): return math.sqrt(vdot(a, a))
def vnormalize(a):
    n = vnorm(a)
    return [a[0] / n, a[1] / n, a[2] / n] if n > 0 else [0.0, 0.0, 0.0]
def vrot_axis(v, axis, ang):
    # Rodrigues
    c, s = math.cos(ang), math.sin(ang)
    return vadd(vadd(vscale(v, c), vscale(vcross(axis, v), s)),
                vscale(axis, vdot(axis, v) * (1 - c)))


def build_sweep(data):
    points = [list(p) for p in data["points"]]
    radii = list(data["radii"])
    profile = [list(q) for q in data["profile"]]
    closed = bool(data["closed"])
    twist = float(data["twist"])
    caps = bool(data["caps"])
    diag = {"errors": [], "warnings": [], "frameJumps": [],
            "zeroSegments": [], "degenerateFaces": []}

    n = len(points)
    m = len(profile)

    # ---------- input validation ----------
    if n < 2:
        diag["errors"].append("路径至少需要 2 个点")
    if not (3 <= m <= 32):
        diag["errors"].append("截面顶点数必须在 3 到 32 之间")
    if len(radii) != n:
        diag["errors"].append("半径数量必须与路径点数量相同")
    if any(r <= 0 for r in radii):
        diag["errors"].append("所有半径必须 > 0")
    if closed and abs((twist / (2 * math.pi)) - round(twist / (2 * math.pi))) > 1e-9:
        diag["errors"].append("闭合路径的总扭转必须是 2π 的整数倍")

    # segments: closed adds the wrap segment
    seg_count = n if closed else n - 1
    seg_dirs = []
    seg_lens = []
    for k in range(seg_count):
        a = points[k]
        b = points[(k + 1) % n]
        d = vsub(b, a)
        L = vnorm(d)
        if L < EPS_LEN:
            diag["zeroSegments"].append(k)
            diag["errors"].append(f"第 {k} 段长度为 {L:.3e}，小于 {EPS_LEN:g}")
            seg_dirs.append(None)
            seg_lens.append(L)
        else:
            seg_dirs.append(vscale(d, 1.0 / L))
            seg_lens.append(L)

    if diag["errors"]:
        return {"valid": False, "diagnostics": diag}

    # ---------- tangents ----------
    tangents = []
    for i in range(n):
        if not closed:
            if i == 0:
                t = seg_dirs[0]
            elif i == n - 1:
                t = seg_dirs[n - 2]
            else:
                s = vadd(seg_dirs[i - 1], seg_dirs[i])  # 前段 + 后段
                if vnorm(s) < EPS_SUM:
                    t = seg_dirs[i]                     # 改取后段方向
                else:
                    t = vnormalize(s)
        else:
            prev_d = seg_dirs[(i - 1) % n]
            next_d = seg_dirs[i]
            s = vadd(prev_d, next_d)
            if vnorm(s) < EPS_SUM:
                t = next_d
            else:
                t = vnormalize(s)
        tangents.append(t)

    # ---------- initial frame ----------
    t0 = tangents[0]
    axes = [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]
    best = sorted(range(3), key=lambda k: abs(vdot(t0, axes[k])))
    # min |dot|; ties resolve in X, Y, Z order (sorted is stable on equal keys)
    n0 = vsub(axes[best[0]], vscale(t0, vdot(axes[best[0]], t0)))
    n0 = vnormalize(n0)
    b0 = vcross(t0, n0)
    normals = [n0]
    binormals = [b0]

    # ---------- parallel transport ----------
    def transport(n_prev, t_prev, t_next):
        d = vdot(t_prev, t_next)
        if d < -1.0 + EPS_DOT:          # near reversal: rotate pi about old n
            n_new = vrot_axis(n_prev, n_prev, math.pi)
        elif d > 1.0 - EPS_DOT:        # near parallel: direct projection
            n_new = vsub(n_prev, vscale(t_next, vdot(n_prev, t_next)))
        else:                          # minimal rotation about t_prev x t_next
            axis = vcross(t_prev, t_next)
            ang = math.acos(max(-1.0, min(1.0, d)))
            n_new = vrot_axis(n_prev, vnormalize(axis), ang)
            n_new = vsub(n_new, vscale(t_next, vdot(n_new, t_next)))
        return vnormalize(n_new)

    seam_twist = 0.0
    for i in range(1, n):
        n_new = transport(normals[i - 1], tangents[i - 1], tangents[i])
        ang = math.acos(max(-1.0, min(1.0, vdot(tangents[i - 1], tangents[i]))))
        if ang >= math.pi / 2:
            diag["frameJumps"].append(
                {"at": i, "angleDeg": math.degrees(ang)})
        normals.append(n_new)
        binormals.append(vcross(tangents[i], n_new))

    # closed: transport the last frame back to t0 and measure the seam
    if closed:
        n_return = transport(normals[n - 1], tangents[n - 1], tangents[0])
        seam_twist = math.atan2(vdot(t0, vcross(n0, n_return)),
                                vdot(n0, n_return))
        diag["seamTwistDeg"] = math.degrees(seam_twist)

    # ---------- arc length ----------
    s = [0.0]
    for i in range(1, n):
        s.append(s[-1] + seg_lens[i - 1])
    L = sum(seg_lens)

    # ---------- twist + closure compensation, then final ring frames ----------
    ring_n = []
    ring_b = []
    for i in range(n):
        phi = twist * s[i] / L
        if closed:
            phi += -seam_twist * s[i] / L
        c, sn = math.cos(phi), math.sin(phi)
        ni = vadd(vscale(normals[i], c), vscale(binormals[i], sn))
        bi = vadd(vscale(normals[i], -sn), vscale(binormals[i], c))
        ring_n.append(ni)
        ring_b.append(bi)

    # ---------- ring vertices P + r*(u*n + v*b) ----------
    rings = []
    for i in range(n):
        ring = []
        for (u, v) in profile:
            off = vadd(vscale(ring_n[i], u * radii[i]),
                       vscale(ring_b[i], v * radii[i]))
            ring.append(vadd(points[i], off))
        rings.append(ring)

    # ---------- side triangles ----------
    # quad (a_i,j, b_i,j+1, c_i+1,j, d_i+1,j+1) -> (a,b,d),(a,d,c)
    verts = []
    for ring in rings:
        verts.extend(ring)
    def idx(i, j):
        ii = i % n if closed else i
        return ii * m + (j % m)

    side_tris = []
    band_count = n if closed else n - 1
    for i in range(band_count):
        i2 = (i + 1) % n
        for j in range(m):
            j2 = (j + 1) % m
            a = idx(i, j)
            b = idx(i, j2)
            c = idx(i2, j)
            d = idx(i2, j2)
            side_tris.append((a, b, d))
            side_tris.append((a, d, c))

    # ---------- degenerate faces ----------
    def tri_cross(tri):
        p0, p1, p2 = verts[tri[0]], verts[tri[1]], verts[tri[2]]
        return vcross(vsub(p1, p0), vsub(p2, p0))

    for k, tri in enumerate(side_tris):
        if vnorm(tri_cross(tri)) < EPS_AREA:
            diag["degenerateFaces"].append({"triangle": k, "where": "side"})

    # ---------- side normals: sum of adjacent non-degenerate face crosses ----------
    side_normals = [[0.0, 0.0, 0.0] for _ in range(n * m)]
    for tri in side_tris:
        cr = tri_cross(tri)
        if vnorm(cr) >= EPS_AREA:
            for vi in tri:
                side_normals[vi] = vadd(side_normals[vi], cr)
    for i in range(n * m):
        if vnorm(side_normals[i]) > 0:
            side_normals[i] = vnormalize(side_normals[i])
        else:
            # radial fallback so the exported normal still points outward
            ring_i, j = divmod(i, m)
            rad = vsub(verts[i], points[ring_i])
            side_normals[i] = (vnormalize(rad) if vnorm(rad) > 0
                               else vnormalize(ring_n[ring_i]))

    # ---------- caps (open paths only) ----------
    cap_tris = []
    cap_normals = []
    cap_verts = []
    if (not closed) and caps:
        # start cap: copy first ring + center, faces toward -t0
        base = len(verts)
        cap_verts.extend(rings[0])
        center0 = list(points[0])
        cap_verts.append(center0)
        c0idx = base + m
        for j in range(m):
            tri = (c0idx, base + ((j + 1) % m), base + j)
            cap_tris.append(tri)
        # end cap: copy last ring + center, faces toward +t_end
        base2 = len(verts)
        cap_verts.extend(rings[n - 1])
        center1 = list(points[n - 1])
        cap_verts.append(center1)
        c1idx = base2 + m
        for j in range(m):
            tri = (c1idx, base2 + j, base2 + ((j + 1) % m))
            cap_tris.append(tri)
        cap_normals = [vscale(t0, -1.0)] * (m + 1) + \
                      [list(tangents[n - 1])] * (m + 1)

    for k, tri in enumerate(cap_tris):
        p0, p1, p2 = cap_verts[tri[0] - n * m], cap_verts[tri[1] - n * m], \
                     cap_verts[tri[2] - n * m]
        if vnorm(vcross(vsub(p1, p0), vsub(p2, p0))) < EPS_AREA:
            diag["degenerateFaces"].append(
                {"triangle": len(side_tris) + k, "where": "cap"})

    if not diag["frameJumps"]:
        diag["warnings"].append("无框架跳变（相邻切线夹角均 < 90°）")

    return {
        "valid": True,
        "n": n, "m": m, "closed": closed,
        "sideVertexCount": n * m,
        "sideTriangleCount": len(side_tris),
        "capTriangleCount": len(cap_tris),
        "diagnostics": diag,
        "tangents": tangents,
        "normals": ring_n,
        "binormals": ring_b,
        "baseNormals": normals,
        "baseBinormals": binormals,
        "seamTwist": seam_twist,
        "rings": rings,
        "sideVerts": verts,
        "sideTris": side_tris,
        "sideNormals": side_normals,
        "capVerts": cap_verts,
        "capTris": cap_tris,
        "capNormals": cap_normals,
        "arcLength": L,
        "s": s,
    }


def main():
    for path in sys.argv[1:]:
        with open(path) as f:
            data = json.load(f)
        r = build_sweep(data)
        print("===", path)
        if not r["valid"]:
            print("INVALID:", r["diagnostics"]["errors"])
            print("zero segments:", r["diagnostics"]["zeroSegments"])
            continue
        d = r["diagnostics"]
        print("side verts:", r["sideVertexCount"],
              "side tris:", r["sideTriangleCount"],
              "cap tris:", r["capTriangleCount"])
        print("frame jumps:", d["frameJumps"])
        print("degenerate:", len(d["degenerateFaces"]))
        if r["closed"]:
            print("seam twist deg:", round(d.get("seamTwistDeg", 0.0), 6))
            # after compensation ring 0 and ring n seam should match
        # orthonormality check
        for i in range(r["n"]):
            t, nn, bb = r["tangents"][i], r["normals"][i], r["binormals"][i]
            assert abs(vdot(nn, bb)) < 1e-9
            assert abs(vdot(t, nn)) < 1e-9
            assert vnorm(vcross(nn, bb)[0:1] and vcross(nn, bb)) > 0.99
        print("frames orthonormal: OK")


if __name__ == "__main__":
    main()
