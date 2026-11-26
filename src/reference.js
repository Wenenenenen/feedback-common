// Independent cell-by-cell clipping verifier (debug/validation aid, not used
// by the app's hot path). Mirrors tools/reference.py's strategy in JS so the
// scanline engine can be cross-checked within one runtime.
import { Fraction, frac } from './bigfraction.js';

const Z = Fraction.ZERO;

function clipBox(poly, x0, x1, y0, y1) {
  let cur = poly;
  const planes = [
    (p) => p[0].cmp(x0) >= 0, (s, e) => {
      const t = x0.sub(s[0]).div(e[0].sub(s[0]));
      return [x0, s[1].add(t.mul(e[1].sub(s[1])))];
    },
    (p) => p[0].cmp(x1) <= 0, (s, e) => {
      const t = x1.sub(s[0]).div(e[0].sub(s[0]));
      return [x1, s[1].add(t.mul(e[1].sub(s[1])))];
    },
    (p) => p[1].cmp(y0) >= 0, (s, e) => {
      const t = y0.sub(s[1]).div(e[1].sub(s[1]));
      return [s[0].add(t.mul(e[0].sub(s[0]))), y0];
    },
    (p) => p[1].cmp(y1) <= 0, (s, e) => {
      const t = y1.sub(s[1]).div(e[1].sub(s[1]));
      return [s[0].add(t.mul(e[0].sub(s[0]))), y1];
    },
  ];
  for (let q = 0; q < planes.length; q += 2) {
    const inside = planes[q], inter = planes[q + 1];
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
    if (!cur.length) break;
  }
  return cur;
}

function moments(poly) {
  const m = { M00: Z, M10: Z, M01: Z, M20: Z, M02: Z, M11: Z };
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[(i + 1) % n];
    const cr = xi.mul(yj).sub(xj.mul(yi));
    if (cr.isZero()) continue;
    m.M00 = m.M00.add(cr.div(frac(2)));
    m.M10 = m.M10.add(cr.mul(xi.add(xj)).div(frac(6)));
    m.M01 = m.M01.add(cr.mul(yi.add(yj)).div(frac(6)));
    m.M20 = m.M20.add(cr.mul(xi.mul(xi).add(xi.mul(xj)).add(xj.mul(xj))).div(frac(12)));
    m.M02 = m.M02.add(cr.mul(yi.mul(yi).add(yi.mul(yj)).add(yj.mul(yj))).div(frac(12)));
    m.M11 = m.M11.add(cr.mul(
      xi.mul(yj)
        .add(xi.mul(yi).mul(frac(2)))
        .add(xj.mul(yj).mul(frac(2)))
        .add(xj.mul(yi))
    ).div(frac(24)));
  }
  return m;
}

export function referenceMoments(region, image) {
  const outerRing = region.outer.map(([x, y]) => [frac(BigInt(x), 16n), frac(BigInt(y), 16n)]);
  const holeRings = (region.holes || []).map(
    (ring) => ring.map(([x, y]) => [frac(BigInt(x), 16n), frac(BigInt(y), 16n)]));
  const totals = { M00: Z, M10: Z, M01: Z, M20: Z, M02: Z, M11: Z };
  const cells = new Map();
  const norm = (m) => {
    const sgn = m.M00.n < 0n ? -1 : 1;
    const out = {};
    for (const k of Object.keys(m)) out[k] = sgn < 0 ? m[k].neg() : m[k];
    return out;
  };
  for (let r = 0; r < image.height; r++) {
    for (let c = 0; c < image.width; c++) {
      const outerPiece = clipBox(outerRing, frac(c), frac(c + 1), frac(r), frac(r + 1));
      if (outerPiece.length < 3) continue;
      const acc = norm(moments(outerPiece));
      for (const ring of holeRings) {
        const piece = clipBox(ring, frac(c), frac(c + 1), frac(r), frac(r + 1));
        if (piece.length < 3) continue;
        const hm = norm(moments(piece));
        for (const k of Object.keys(acc)) acc[k] = acc[k].sub(hm[k]);
      }
      if (acc.M00.isZero() || acc.M00.n < 0n) continue;
      cells.set(r * image.width + c, acc);
      const g = BigInt(image.gray[r * image.width + c]);
      for (const k of Object.keys(totals)) totals[k] = totals[k].add(acc[k].mul(frac(g)));
    }
  }
  return { totals, cells };
}
