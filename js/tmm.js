/*
 * Coherent multilayer thin-film optics — scattering matrix formulation.
 * Mirrors tools/tmm_ref.py. Stable for total internal reflection, evanescent
 * layers, thick absorbing films and zero-thickness layers.
 *
 * Convention: exp(-i w t), forward wave exp(i kz z); passive n+ik with k>=0.
 */
(function (global) {
  'use strict';

  // ---- minimal complex helpers (plain {re, im} objects) -----------------
  function c(re, im) { return { re: re, im: im || 0 }; }
  function cadd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
  function csub(a, b) { return { re: a.re - b.re, im: a.im - b.im }; }
  function cmul(a, b) {
    return {
      re: a.re * b.re - a.im * b.im,
      im: a.re * b.im + a.im * b.re
    };
  }
  function cdiv(a, b) {
    const d = b.re * b.re + b.im * b.im;
    return {
      re: (a.re * b.re + a.im * b.im) / d,
      im: (a.im * b.re - a.re * b.im) / d
    };
  }
  function cabs2(a) { return a.re * a.re + a.im * a.im; }
  function csqrt(z) {
    // principal square root: Re >= 0, Im has sign of z.im
    const r = Math.hypot(z.re, z.im);
    const re = Math.sqrt(Math.max(0, (r + z.re) / 2));
    let im = Math.sqrt(Math.max(0, (r - z.re) / 2));
    if (z.im < 0) im = -im;
    let q = { re: re, im: im };
    // enforce the passive branch explicitly
    if (q.re < 0 || (q.re === 0 && q.im < 0)) q = { re: -q.re, im: -q.im };
    return q;
  }
  function cexpi(z) {
    // exp(i z), z = a + ib -> exp(-b) * (cos a + i sin a)
    const decay = Math.exp(-z.im);
    return { re: decay * Math.cos(z.re), im: decay * Math.sin(z.re) };
  }
  function cneg(a) { return { re: -a.re, im: -a.im }; }

  // ---- optics -------------------------------------------------------------
  function qOf(nc, n0SinSq) {
    return csqrt(csub(cmul(nc, nc), { re: n0SinSq, im: 0 }));
  }

  function admittance(nc, q, pol) {
    if (pol === 's') return q;
    return cdiv(cmul(nc, nc), q);
  }

  // S-matrix as a 4-tuple [s11, s12, s21, s22] of complex numbers.
  function interfaceMatrix(yL, yR) {
    const sum = cadd(yL, yR);
    const r = cdiv(csub(yL, yR), sum);
    const tLR = cdiv({ re: 2 * yL.re, im: 2 * yL.im }, sum);
    const tRL = cdiv({ re: 2 * yR.re, im: 2 * yR.im }, sum);
    return [r, tRL, tLR, cneg(r)];
  }

  function star(s, t) {
    const [s11, s12, s21, s22] = s;
    const [t11, t12, t21, t22] = t;
    const inv = cdiv({ re: 1, im: 0 }, csub({ re: 1, im: 0 }, cmul(s22, t11)));
    return [
      cadd(s11, cmul(cmul(cmul(s12, t11), inv), s21)),
      cmul(cmul(s12, inv), t12),
      cmul(cmul(t21, inv), s21),
      cadd(t22, cmul(cmul(cmul(t21, s22), inv), t12))
    ];
  }

  function solveStack(n0, ns, layers, wavelength, theta0Deg, pol) {
    const sinT = Math.sin(theta0Deg * Math.PI / 180);
    const n0SinSq = n0 * n0 * sinT * sinT;
    const n0c = c(n0, 0);

    let qPrev = qOf(n0c, n0SinSq);
    let yPrev = admittance(n0c, qPrev, pol);
    let globalS = null;

    for (const layer of layers) {
      const nc = c(layer.n, layer.k);
      const q = qOf(nc, n0SinSq);
      const y = admittance(nc, q, pol);
      const sIf = interfaceMatrix(yPrev, y);
      globalS = globalS === null ? sIf : star(globalS, sIf);
      const delta = cmul(c(2 * Math.PI * layer.d / wavelength, 0), q);
      const prop = cexpi(delta);
      const sProp = [c(0, 0), prop, prop, c(0, 0)];
      globalS = star(globalS, sProp);
      qPrev = q;
      yPrev = y;
    }

    const nsc = c(ns, 0);
    const qs = qOf(nsc, n0SinSq);
    const ys = admittance(nsc, qs, pol);
    const sIf = interfaceMatrix(yPrev, ys);
    globalS = globalS === null ? sIf : star(globalS, sIf);

    return { r: globalS[0], t: globalS[2], ys: ys };
  }

  /**
   * R/T/A for both polarizations at one wavelength and angle.
   * layers: [{d, n, k}] in nanometres. Returns {s:{R,T,A}, p:{R,T,A}}.
   */
  function spectrum(n0, ns, layers, wavelength, theta0Deg) {
    const sinT = Math.sin(theta0Deg * Math.PI / 180);
    const n0SinSq = n0 * n0 * sinT * sinT;
    const q0 = qOf(c(n0, 0), n0SinSq);
    const out = {};
    for (const pol of ['s', 'p']) {
      const res = solveStack(n0, ns, layers, wavelength, theta0Deg, pol);
      const y0 = admittance(c(n0, 0), q0, pol);
      const R = cabs2(res.r);
      let T = (res.ys.re / y0.re) * cabs2(res.t);
      if (!Number.isFinite(T) || T < 0) T = 0;
      let A = 1 - R - T;
      if (A < 0 && A > -1e-9) A = 0;
      out[pol] = { R: R, T: T, A: A };
    }
    return out;
  }

  /**
   * Full angular/spectral grid.
   * wavelengths, angles: arrays of numbers.
   * Returns { s:{R:[[..]],T,A}, p:{...} } with [angleIndex][wavelengthIndex].
   */
  function fullGrid(n0, ns, layers, wavelengths, angles) {
    const res = {
      s: { R: [], T: [], A: [] },
      p: { R: [], T: [], A: [] }
    };
    for (let ai = 0; ai < angles.length; ai++) {
      const ang = angles[ai];
      const rows = {
        s: { R: [], T: [], A: [] },
        p: { R: [], T: [], A: [] }
      };
      for (let wi = 0; wi < wavelengths.length; wi++) {
        const sp = spectrum(n0, ns, layers, wavelengths[wi], ang);
        for (const pol of ['s', 'p']) {
          rows[pol].R.push(sp[pol].R);
          rows[pol].T.push(sp[pol].T);
          rows[pol].A.push(sp[pol].A);
        }
      }
      for (const pol of ['s', 'p']) {
        res[pol].R.push(rows[pol].R);
        res[pol].T.push(rows[pol].T);
        res[pol].A.push(rows[pol].A);
      }
    }
    return res;
  }

  const TMM = {
    spectrum: spectrum,
    fullGrid: fullGrid,
    // exported for tests
    _internals: { qOf: qOf, admittance: admittance, star: star, csqrt: csqrt }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TMM;
  } else {
    global.TMM = TMM;
  }
})(typeof window !== 'undefined' ? window : globalThis);
