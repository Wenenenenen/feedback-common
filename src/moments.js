// Exact raster moments of a (possibly out-of-image, holed) polygon clipped
// against the pixel grid.
//
// Correctness strategy
// --------------------
// Each ring is clipped independently against every pixel cell it can touch
// (cells in its bounding box) with exact Sutherland-Hodgman clipping in BigInt
// Fractions. The outer ring contributes positively; every hole ring is
// subtracted. Because holes are simple, pairwise disjoint and strictly inside
// the outer ring, outer-minus-holes is exactly the even-odd region, with no
// dependence on winding order. Every touched cell therefore keeps its exact
// geometric moments, and weighted moments multiply by the constant cell gray.
//
// There is no center sampling and no supersampling anywhere: the integrand is
// the constant cell gray and the integration domain is the exact clipped
// polygon area, integrated by Green's theorem.
//
// Region vertices are integers in 1/16-pixel units.

import { Fraction, frac } from './bigfraction.js';

const HALF = frac(1n, 2n);
const THIRD = frac(1n, 3n);
const SIXTH = frac(1n, 6n);
const TWELFTH = frac(1n, 12n);
const T24 = frac(1n, 24n);
const SCALE = 16n;

const f16 = (i) => frac(BigInt(i), SCALE);
const zeroMRaw = () => ({ M00: Fraction.raw(0n, 1n), M10: Fraction.raw(0n, 1n), M01: Fraction.raw(0n, 1n), M20: Fraction.raw(0n, 1n), M02: Fraction.raw(0n, 1n), M11: Fraction.raw(0n, 1n) });

// Green's-theorem moments of a simple polygon (any winding order; results are
// signed by orientation). Runs on unreduced (raw) fractions for speed and
// reduces each accumulator once at the end.
function polygonMoments(points) {
  const m = zeroMRaw();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[(i + 1) % n];
    const cr = xi.mulR(yj).subR(xj.mulR(yi));
    if (cr.isZero()) continue;
    m.M00 = m.M00.addR(cr.mulR(HALF));
    m.M10 = m.M10.addR(cr.mulR(xi.addR(xj)).mulR(SIXTH));
    m.M01 = m.M01.addR(cr.mulR(yi.addR(yj)).mulR(SIXTH));
    m.M20 = m.M20.addR(cr.mulR(
      xi.mulR(xi).addR(xi.mulR(xj)).addR(xj.mulR(xj))).mulR(TWELFTH));
    m.M02 = m.M02.addR(cr.mulR(
      yi.mulR(yi).addR(yi.mulR(yj)).addR(yj.mulR(yj))).mulR(TWELFTH));
    m.M11 = m.M11.addR(cr.mulR(
      xi.mulR(yj)
        .addR(xi.mulR(yi).mulR(frac(2n)))
        .addR(xj.mulR(yj).mulR(frac(2n)))
        .addR(xj.mulR(yi))
    ).mulR(T24));
  }
  for (const k of Object.keys(m)) m[k].reduce();
  return m;
}

// Sutherland-Hodgman against the axis-aligned cell [x0,x1] × [y0,y1].
// All arithmetic stays in raw fractions; intersection denominators stay
// bounded (one division per crossing plane), and reduction is deferred to the
// moment step.
function clipToCell(poly, x0, x1, y0, y1) {
  const planes = [
    (p) => p[0].cmp(x0) >= 0,
    (s, e) => { const t = x0.subR(s[0]).divR(e[0].subR(s[0])); return [x0, s[1].addR(t.mulR(e[1].subR(s[1])))]; },
    (p) => p[0].cmp(x1) <= 0,
    (s, e) => { const t = x1.subR(s[0]).divR(e[0].subR(s[0])); return [x1, s[1].addR(t.mulR(e[1].subR(s[1])))]; },
    (p) => p[1].cmp(y0) >= 0,
    (s, e) => { const t = y0.subR(s[1]).divR(e[1].subR(s[1])); return [s[0].addR(t.mulR(e[0].subR(s[0]))), y0]; },
    (p) => p[1].cmp(y1) <= 0,
    (s, e) => { const t = y1.subR(s[1]).divR(e[1].subR(s[1])); return [s[0].addR(t.mulR(e[0].subR(s[0]))), y1]; },
  ];
  let cur = poly;
  for (let q = 0; q < planes.length; q += 2) {
    const inside = planes[q], inter = planes[q + 1];
    if (cur.length < 3) break;
    const out = [];
    for (let i = 0; i < cur.length; i++) {
      const s = cur[i - 1 < 0 ? cur.length - 1 : i - 1];
      const e = cur[i];
      const sin = inside(s), ein = inside(e);
      if (ein && !sin) { out.push(inter(s, e)); out.push(e); }
      else if (ein) out.push(e);
      else if (sin) out.push(inter(s, e));
    }
    cur = out;
  }
  return cur;
}

function ringBoundsF(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

// region: { outer: [[x,y]...], holes: [[...], ...] } coordinates in 1/16 units
// image:  { width, height, gray: Uint16Array }
export function computeRasterMoments(region, image) {
  const W = image.width, H = image.height;
  const rings = [
    { ring: region.outer, isHole: false },
    ...(region.holes || []).map((ring) => ({ ring, isHole: true })),
  ].map(({ ring, isHole }) => ({
    isHole,
    ring,
    pts: ring.map(([x, y]) => [f16(x), f16(y)]),
    bbox: ringBoundsF(ring),
  }));

  const T = zeroMRaw();                    // weighted totals (raw; reduced at end)
  const cellMoments = new Map();           // key -> exact geometric moments
  const coverage = new Float64Array(W * H);

  for (const { pts, isHole, bbox } of rings) {
    // Conservative cell range from the ring's integer bounding box. The exact
    // clipper discards every non-intersecting cell, so this only bounds work,
    // never correctness.
    const c0 = Math.max(0, Math.floor(bbox.minX / 16));
    const c1 = Math.min(W - 1, Math.floor(bbox.maxX / 16));
    const r0 = Math.max(0, Math.floor(bbox.minY / 16));
    const r1 = Math.min(H - 1, Math.floor(bbox.maxY / 16));
    for (let r = r0; r <= r1; r++) {
      const y0 = Fraction.raw(BigInt(r), 1n), y1 = Fraction.raw(BigInt(r + 1), 1n);
      for (let c = c0; c <= c1; c++) {
        const key = r * W + c;
        const x0 = Fraction.raw(BigInt(c), 1n), x1 = Fraction.raw(BigInt(c + 1), 1n);
        const piece = clipToCell(pts, x0, x1, y0, y1);
        if (piece.length < 3) continue;
        const pm = polygonMoments(piece);
        if (pm.M00.isZero()) continue;
        // Normalize to positive orientation, then outer adds / hole subtracts.
        const neg = pm.M00.n < 0n;
        let cm = cellMoments.get(key);
        if (!cm) { cm = zeroMRaw(); cellMoments.set(key, cm); }
        for (const k of Object.keys(cm)) {
          const v = neg ? pm[k].neg() : pm[k];
          cm[k] = isHole ? cm[k].subR(v) : cm[k].addR(v);
        }
      }
    }
  }

  // Reduce each cell once, drop cells cancelled to zero, and fold totals.
  for (const [key, cm] of [...cellMoments.entries()]) {
    for (const k of Object.keys(cm)) cm[k].reduce();
    if (cm.M00.isZero() || cm.M00.n < 0n) { cellMoments.delete(key); continue; }
    coverage[key] = cm.M00.toNumber();
    const g = BigInt(image.gray[key]);
    for (const k of Object.keys(T)) T[k] = T[k].addR(cm[k].mulR(Fraction.raw(g, 1n)));
  }
  for (const k of Object.keys(T)) T[k].reduce();

  let coveredArea = Fraction.raw(0n, 1n);
  let fullCount = 0;
  const ONE = frac(1n);
  for (const cm of cellMoments.values()) {
    coveredArea = coveredArea.addR(cm.M00);
    if (cm.M00.eq(ONE)) fullCount++; // exact full-cell test, no float tolerance
  }
  coveredArea.reduce();

  return {
    width: W, height: H, coverage, partial: cellMoments,
    totals: T, coveredArea,
    cellCount: cellMoments.size, fullCount,
    partialCount: cellMoments.size,
  };
}

// Exact six weighted contributions of one pixel cell (inspector).
export function cellContributions(result, image, r, c) {
  const key = r * result.width + c;
  const pm = result.partial.get(key);
  if (!pm || pm.M00.isZero()) return null;
  const g = BigInt(image.gray[key]);
  const weighted = {};
  for (const k of Object.keys(pm)) weighted[k] = pm[k].mul(frac(g));
  return { gray: image.gray[key], geometric: pm, weighted, area: pm.M00 };
}

// Centroid and 2x2 covariance from the weighted totals.
// Nulls when the total mass M00 is zero.
export function derivedStats(totals) {
  if (totals.M00.isZero()) {
    return { centroid: null, covariance: null };
  }
  const xbar = totals.M10.div(totals.M00);
  const ybar = totals.M01.div(totals.M00);
  return {
    centroid: { x: xbar, y: ybar },
    covariance: {
      xx: totals.M20.div(totals.M00).sub(xbar.mul(xbar)),
      yy: totals.M02.div(totals.M00).sub(ybar.mul(ybar)),
      xy: totals.M11.div(totals.M00).sub(xbar.mul(ybar)),
    },
  };
}
