"""Reference implementation of coherent multilayer transfer-matrix optics.

Scattering-matrix (Redheffer star product) formulation, stable for:
  - total internal reflection (evanescent layers, q purely imaginary)
  - thick / strongly absorbing films (propagation factor only decays)
  - zero-thickness layers

Convention: time dependence exp(-i w t), forward wave exp(i kz z).
Complex n = n + i k with k >= 0 (passive); sqrt branch chosen with
Re(q) >= 0 (and Im(q) >= 0 when Re(q) == 0).

Run: python3 -I tools/tmm_ref.py
"""

import cmath
import json
import math
import os
import sys

POL_S = "s"
POL_P = "p"


def q_of(n_complex, n0_sin_sq):
    """Normalized z-wavevector q = sqrt(n^2 - n0^2 sin^2(theta0))."""
    q = cmath.sqrt(n_complex * n_complex - n0_sin_sq)
    if q.real < 0.0 or (q.real == 0.0 and q.imag < 0.0):
        q = -q
    return q


def admittance(n_complex, q, pol):
    if pol == POL_S:
        return q
    return n_complex * n_complex / q


def star(s, t):
    """Redheffer star product of two 2x2 scattering matrices (scalar ports)."""
    s11, s12, s21, s22 = s
    t11, t12, t21, t22 = t
    inv = 1.0 / (1.0 - s22 * t11)
    return (
        s11 + s12 * t11 * inv * s21,
        s12 * inv * t12,
        t21 * inv * s21,
        t22 + t21 * s22 * inv * t12,
    )


def interface_matrix(y_left, y_right):
    """S-matrix of a single interface between admittances yL, yR."""
    r = (y_left - y_right) / (y_left + y_right)
    t_lr = 2.0 * y_left / (y_left + y_right)
    t_rl = 2.0 * y_right / (y_left + y_right)
    return (r, t_rl, t_lr, -r)


def solve_stack(n0, ns, layers, wavelength, theta0_deg, pol):
    """Return (r, t) amplitude coefficients for the full stack.

    layers: sequence of (thickness_nm, n, k).
    """
    theta0 = math.radians(theta0_deg)
    n0c = complex(n0, 0.0)
    n0_sin_sq = (n0 * math.sin(theta0)) ** 2

    q0 = q_of(n0c, n0_sin_sq)
    y0 = admittance(n0c, q0, pol)

    q_prev, y_prev = q0, y0
    global_s = None

    for thickness, n_real, k in layers:
        nc = complex(n_real, k)
        q = q_of(nc, n0_sin_sq)
        y = admittance(nc, q, pol)
        s_if = interface_matrix(y_prev, y)
        global_s = s_if if global_s is None else star(global_s, s_if)
        delta = 2.0 * math.pi * q * thickness / wavelength
        prop = cmath.exp(1j * delta)  # |prop| <= 1 for passive branch
        s_prop = (0.0, prop, prop, 0.0)
        global_s = star(global_s, s_prop)
        q_prev, y_prev = q, y

    qs = q_of(complex(ns, 0.0), n0_sin_sq)
    ys = admittance(complex(ns, 0.0), qs, pol)
    s_if = interface_matrix(y_prev, ys)
    global_s = s_if if global_s is None else star(global_s, s_if)

    r = global_s[0]
    t = global_s[2]
    return r, t, y0, ys


def spectrum(n0, ns, layers, wavelength, theta0_deg):
    """R/T/A for s and p at one (wavelength, angle)."""
    out = {}
    for pol in (POL_S, POL_P):
        r, t, y0, ys = solve_stack(n0, ns, layers, wavelength, theta0_deg, pol)
        refl = abs(r) ** 2
        trans = (ys.real / y0.real) * abs(t) ** 2
        trans = max(trans, 0.0)
        absp = 1.0 - refl - trans
        out[pol] = (refl, trans, absp)
    return out


def full_grid(n0, ns, layers, wavelengths, angles):
    """Compute complete R/T/A grids. Result[pol][quantity] indexed [angle][wl]."""
    res = {"s": {"R": [], "T": [], "A": []}, "p": {"R": [], "T": [], "A": []}}
    for ang in angles:
        rows = {"s": [[], [], []], "p": [[], [], []]}
        for wl in wavelengths:
            spec = spectrum(n0, ns, layers, wl, ang)
            for pol in (POL_S, POL_P):
                r, t, a = spec[pol]
                rows[pol][0].append(r)
                rows[pol][1].append(t)
                rows[pol][2].append(a)
        for pol in (POL_S, POL_P):
            for qi, q in enumerate(("R", "T", "A")):
                res[pol][q].append(rows[pol][qi])
    return res


# --------------------------------------------------------------------------
# Analytic validation
# --------------------------------------------------------------------------

def approx(a, b, tol=1e-9):
    return abs(a - b) <= tol


def main():
    failures = []

    def check(name, cond, detail=""):
        status = "ok " if cond else "FAIL"
        print(f"[{status}] {name} {detail}")
        if not cond:
            failures.append(name)

    # 1. bare glass, normal incidence: R = ((ns-n0)/(ns+n0))^2 = 0.04
    spec = spectrum(1.0, 1.5, [], 550.0, 0.0)
    r_expected = ((1.5 - 1.0) / (1.5 + 1.0)) ** 2
    check("glass normal Rs", approx(spec["s"][0], r_expected, 1e-12),
          f"Rs={spec['s'][0]:.12g}")
    check("glass normal Rp=Rs", approx(spec["s"][0], spec["p"][0], 1e-12))
    check("glass normal T=0.96", approx(spec["s"][1], 0.96, 1e-12))
    check("glass normal A=0", approx(spec["s"][2], 0.0, 1e-12))

    # 2. Brewster angle: p reflectance vanishes, s nonzero; energy conserved
    spec = spectrum(1.0, 1.5, [], 550.0, math.degrees(math.atan(1.5)))
    check("brewster Rp ~ 0", spec["p"][0] < 1e-14, f"Rp={spec['p'][0]:.3e}")
    check("brewster Rs > 0", spec["s"][0] > 0.1)
    check("brewster conservation s", approx(spec["s"][0] + spec["s"][1], 1.0, 1e-12))
    check("brewster conservation p", approx(spec["p"][0] + spec["p"][1], 1.0, 1e-12))

    # 3. total internal reflection n0=1.5 -> ns=1 at 60 deg
    spec = spectrum(1.5, 1.0, [], 550.0, 60.0)
    check("tir Rs=1", approx(spec["s"][0], 1.0, 1e-12), f"Rs={spec['s'][0]:.12g}")
    check("tir Rp=1", approx(spec["p"][0], 1.0, 1e-12))
    check("tir T=0", approx(spec["s"][1], 0.0, 1e-12) and approx(spec["p"][1], 0.0, 1e-12))
    check("tir A=0", approx(spec["s"][2], 0.0, 1e-12))

    # 4. quarter-wave AR coating at 550 nm normal incidence
    ar_layer = [(550.0 / (4.0 * math.sqrt(1.5)), math.sqrt(1.5), 0.0)]
    spec = spectrum(1.0, 1.5, ar_layer, 550.0, 0.0)
    check("ar R(550) ~ 0", spec["s"][0] < 1e-12, f"R={spec['s'][0]:.3e}")
    check("ar conservation", approx(spec["s"][0] + spec["s"][1], 1.0, 1e-10))

    # 5. 16 x 5000 nm strongly absorbing layers: finite, physical, no NaN
    thick = [(5000.0, 1.5, 2.0)] * 16
    wavelengths = list(range(400, 701, 10))
    angles = [float(a) for a in range(0, 86)]
    grid = full_grid(1.0, 1.5, thick, wavelengths, angles)
    finite = all(
        math.isfinite(v)
        for pol in ("s", "p")
        for q in ("R", "T", "A")
        for row in grid[pol][q]
        for v in row
    )
    check("absorbing stack all finite", finite)
    physical = all(
        -1e-9 <= v <= 1.0 + 1e-9
        for pol in ("s", "p")
        for q in ("R", "T", "A")
        for row in grid[pol][q]
        for v in row
    )
    check("absorbing stack values in [0,1]", physical)
    # 80 um of k=2 material at 550 nm: intensity transmittance ~ exp(-4 pi k d / lam)
    # -> effectively zero; absorption must carry the missing energy
    r0 = grid["s"]["R"][0][15]
    t0 = grid["s"]["T"][0][15]
    a0 = grid["s"]["A"][0][15]
    check("absorbing stack T ~ 0", t0 < 1e-6, f"T={t0:.3e}")
    check("absorbing stack energy balance", approx(r0 + t0 + a0, 1.0, 1e-9),
          f"sum={r0 + t0 + a0:.12g}")

    # 6. frustrated TIR through an evanescent air gap: lossless, R+T=1
    # n0=1.5 prism, 100 nm air gap (q imaginary at 60 deg), glass exit
    gap = [(100.0, 1.0, 0.0)]
    spec = spectrum(1.5, 1.5, gap, 550.0, 60.0)
    check("ftir conservation s", approx(spec["s"][0] + spec["s"][1], 1.0, 1e-10),
          f"R={spec['s'][0]:.6f} T={spec['s'][1]:.6f}")
    check("ftir conservation p", approx(spec["p"][0] + spec["p"][1], 1.0, 1e-10))
    check("ftir nonzero tunneling", 0.0 < spec["s"][1] < 1.0)

    # 7. zero-thickness layer is identical to no layer
    spec_z = spectrum(1.0, 1.5, [(0.0, 2.0, 0.5)], 550.0, 30.0)
    spec_bare = spectrum(1.0, 1.5, [], 550.0, 30.0)
    same = all(approx(spec_z[p][i], spec_bare[p][i], 1e-12)
               for p in ("s", "p") for i in range(3))
    check("zero thickness == bare interface", same)

    # 8. coherent 3-layer sample: lossless except k=0.05, energy balance holds
    coherent = [(85.0, 2.0, 0.0), (110.0, 1.4, 0.0), (60.0, 1.9, 0.05)]
    spec = spectrum(1.0, 1.5, coherent, 550.0, 40.0)
    for pol in ("s", "p"):
        r, t, a = spec[pol]
        check(f"coherent energy balance {pol}", approx(r + t + a, 1.0, 1e-9),
              f"sum={r + t + a:.12g}")
        check(f"coherent positive absorption {pol}", a >= -1e-12)

    # 9. s/p coincide at normal incidence for an arbitrary stack
    spec = spectrum(1.0, 1.5, coherent, 470.0, 0.0)
    check("normal incidence s==p", approx(spec["s"][0], spec["p"][0], 1e-12))

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        sys.exit(1)
    print("all reference checks passed")


if __name__ == "__main__":
    main()
