/*
 * BC1 / BC3 block codec — decode strictly per 格式说明.md, encode with
 * PCA-line endpoint optimization + local 565 refinement (not bbox corners).
 * Exposed as globalThis.BCC (browser classic script / importScripts worker)
 * and via module.exports (Node test harness).
 */
(function (root) {
  'use strict';

  // ---------- small helpers ----------
  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  function expand565(v) {
    const r5 = (v >>> 11) & 31, g6 = (v >>> 5) & 63, b5 = v & 31;
    return [
      (r5 << 3) | (r5 >> 2),
      (g6 << 2) | (g6 >> 4),
      (b5 << 3) | (b5 >> 2),
    ];
  }

  function to565(r, g, b) {
    const q5 = (c) => clamp8(Math.round(c / 255 * 31));
    const q6 = (c) => clamp8(Math.round(c / 255 * 63));
    return (q5(r) << 11) | (q6(g) << 5) | q5(b);
  }

  function dist3(ar, ag, ab, br, bg, bb) {
    const dr = ar - br, dg = ag - bg, db = ab - bb;
    return dr * dr + dg * dg + db * db;
  }

  // ---------- decode ----------

  // Returns { palette: [[r,g,b,a] x4], indices: [16], mode }
  function decodeColorBlock(bytes, off, forceFourColor) {
    const c0 = (bytes[off] | (bytes[off + 1] << 8)) & 0xFFFF;
    const c1 = (bytes[off + 2] | (bytes[off + 3] << 8)) & 0xFFFF;
    let bits = 0;
    for (let k = 0; k < 4; k++) bits |= bytes[off + 4 + k] << (8 * k);
    bits = bits >>> 0;

    const p0 = expand565(c0), p1 = expand565(c1);
    const palette = new Array(4);
    let mode;
    if (c0 > c1 || forceFourColor) {
      mode = forceFourColor ? 'bc3-4color' : '4-color';
      palette[0] = [p0[0], p0[1], p0[2], 255];
      palette[1] = [p1[0], p1[1], p1[2], 255];
      palette[2] = [((2 * p0[0] + p1[0]) / 3) | 0, ((2 * p0[1] + p1[1]) / 3) | 0, ((2 * p0[2] + p1[2]) / 3) | 0, 255];
      palette[3] = [((p0[0] + 2 * p1[0]) / 3) | 0, ((p0[1] + 2 * p1[1]) / 3) | 0, ((p0[2] + 2 * p1[2]) / 3) | 0, 255];
    } else {
      mode = '3-color+alpha';
      palette[0] = [p0[0], p0[1], p0[2], 255];
      palette[1] = [p1[0], p1[1], p1[2], 255];
      palette[2] = [((p0[0] + p1[0]) / 2) | 0, ((p0[1] + p1[1]) / 2) | 0, ((p0[2] + p1[2]) / 2) | 0, 255];
      palette[3] = [0, 0, 0, 0];
    }
    const indices = new Array(16);
    for (let i = 0; i < 16; i++) indices[i] = (bits >>> (2 * i)) & 3;
    return { c0, c1, palette, indices, mode };
  }

  function decodeAlphaBlock(bytes, off) {
    const a0 = bytes[off], a1 = bytes[off + 1];
    // 48-bit index field; assemble without 32-bit signed-shift overflow.
    let bits = 0;
    for (let k = 0; k < 6; k++) bits += bytes[off + 2 + k] * Math.pow(2, 8 * k);
    const table = new Array(8);
    table[0] = a0; table[1] = a1;
    let mode;
    if (a0 > a1) {
      mode = '8-interp';
      for (let i = 2; i < 8; i++) {
        table[i] = (((8 - i) * a0 + (i - 1) * a1) / 7) | 0;
      }
    } else {
      mode = '6-interp+0/255';
      for (let i = 2; i < 6; i++) {
        table[i] = (((6 - i) * a0 + (i - 1) * a1) / 5) | 0;
      }
      table[6] = 0; table[7] = 255;
    }
    const indices = new Array(16);
    for (let i = 0; i < 16; i++) indices[i] = Math.floor(bits / Math.pow(2, 3 * i)) & 7;
    return { a0, a1, table, indices, mode };
  }

  // Decode full DDS payload. format: 'BC1' | 'BC3'. Returns RGBA Uint8ClampedArray
  // of the PADDED size (pw x ph); caller crops to original dimensions.
  function decodePayload(payload, pw, ph, format) {
    const bw = pw >> 2, bh = ph >> 2, bs = format === 'BC3' ? 16 : 8;
    const out = new Uint8ClampedArray(pw * ph * 4);
    const blockInfos = new Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const bi = by * bw + bx, off = bi * bs;
        let color, alpha = null;
        if (format === 'BC3') {
          alpha = decodeAlphaBlock(payload, off);
          color = decodeColorBlock(payload, off + 8, true);
          blockInfos[bi] = { alpha, color };
        } else {
          color = decodeColorBlock(payload, off, false);
          blockInfos[bi] = { color };
        }
        for (let i = 0; i < 16; i++) {
          const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
          const o = (py * pw + px) * 4;
          const p = color.palette[color.indices[i]];
          out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2];
          out[o + 3] = format === 'BC3' ? alpha.table[alpha.indices[i]] : p[3];
        }
      }
    }
    return { rgba: out, blockInfos };
  }

  // ---------- encode: color (BC1 / BC3 color sub-block) ----------

  // Build the exact spec palette for an endpoint pair.
  function paletteFor(c0, c1, transparentMode) {
    const p0 = expand565(c0), p1 = expand565(c1);
    const pal = new Array(4);
    if (!transparentMode) {
      pal[0] = [p0[0], p0[1], p0[2], 255];
      pal[1] = [p1[0], p1[1], p1[2], 255];
      pal[2] = [((2 * p0[0] + p1[0]) / 3) | 0, ((2 * p0[1] + p1[1]) / 3) | 0, ((2 * p0[2] + p1[2]) / 3) | 0, 255];
      pal[3] = [((p0[0] + 2 * p1[0]) / 3) | 0, ((p0[1] + 2 * p1[1]) / 3) | 0, ((p0[2] + 2 * p1[2]) / 3) | 0, 255];
    } else {
      pal[0] = [p0[0], p0[1], p0[2], 255];
      pal[1] = [p1[0], p1[1], p1[2], 255];
      pal[2] = [((p0[0] + p1[0]) / 2) | 0, ((p0[1] + p1[1]) / 2) | 0, ((p0[2] + p1[2]) / 2) | 0, 255];
      pal[3] = [0, 0, 0, 0];
    }
    return pal;
  }

  // Build the exact spec palette as a flat [r,g,b, ... x4] array.
  function paletteFlat(c0, c1, transparentMode) {
    const p0 = expand565(c0), p1 = expand565(c1);
    const pal = new Int16Array(12);
    if (!transparentMode) {
      pal[0] = p0[0]; pal[1] = p0[1]; pal[2] = p0[2];
      pal[3] = p1[0]; pal[4] = p1[1]; pal[5] = p1[2];
      pal[6] = ((2 * p0[0] + p1[0]) / 3) | 0; pal[7] = ((2 * p0[1] + p1[1]) / 3) | 0; pal[8] = ((2 * p0[2] + p1[2]) / 3) | 0;
      pal[9] = ((p0[0] + 2 * p1[0]) / 3) | 0; pal[10] = ((p0[1] + 2 * p1[1]) / 3) | 0; pal[11] = ((p0[2] + 2 * p1[2]) / 3) | 0;
    } else {
      pal[0] = p0[0]; pal[1] = p0[1]; pal[2] = p0[2];
      pal[3] = p1[0]; pal[4] = p1[1]; pal[5] = p1[2];
      pal[6] = ((p0[0] + p1[0]) / 2) | 0; pal[7] = ((p0[1] + p1[1]) / 2) | 0; pal[8] = ((p0[2] + p1[2]) / 2) | 0;
      pal[9] = 0; pal[10] = 0; pal[11] = 0;
    }
    return pal;
  }

  // Evaluate one endpoint pair.
  // transparentMode (BC1): c0<=c1 3-color+alpha palette, alpha<128 texels
  // forced to index 3 and excluded from RGB error.
  // maskOpaque (BC3): ignore alpha<128 texels for both fitting and error
  // (the alpha sub-block represents transparency independently).
  function evalColorPair(c0, c1, px, transparentMode, maskOpaque) {
    const pal = paletteFlat(c0, c1, transparentMode);
    const maxIdx = transparentMode ? 2 : 3;
    let sse = 0;
    const indices = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      const p = px[i];
      const pr = p[0], pg = p[1], pb = p[2];
      if (maskOpaque && p[3] < 128) { indices[i] = 0; continue; }
      if (transparentMode && p[3] < 128) { indices[i] = 3; continue; }
      let best = 0;
      let dr = pr - pal[0], dg = pg - pal[1], db = pb - pal[2];
      let bestD = dr * dr + dg * dg + db * db;
      for (let k = 1; k <= maxIdx; k++) {
        dr = pr - pal[3 * k]; dg = pg - pal[3 * k + 1]; db = pb - pal[3 * k + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = k; }
      }
      indices[i] = best;
      sse += bestD;
    }
    return { sse, indices };
  }

  // Principal-axis direction of opaque pixels (fallback: luminance axis).
  function principalAxis(px, opaqueMask) {
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (let i = 0; i < 16; i++) if (opaqueMask[i]) {
      mr += px[i][0]; mg += px[i][1]; mb += px[i][2]; n++;
    }
    mr /= n; mg /= n; mb /= n;
    let sxx = 0, syy = 0, szz = 0, sxy = 0, sxz = 0, syz = 0;
    for (let i = 0; i < 16; i++) if (opaqueMask[i]) {
      const dr = px[i][0] - mr, dg = px[i][1] - mg, db = px[i][2] - mb;
      sxx += dr * dr; syy += dg * dg; szz += db * db;
      sxy += dr * dg; sxz += dr * db; syz += dg * db;
    }
    // Power iteration on the 3x3 covariance matrix.
    let vx = 1, vy = 1, vz = 0;
    for (let it = 0; it < 24; it++) {
      const nx = sxx * vx + sxy * vy + sxz * vz;
      const ny = sxy * vx + syy * vy + syz * vz;
      const nz = sxz * vx + syz * vy + szz * vz;
      const norm = Math.hypot(nx, ny, nz) || 1;
      vx = nx / norm; vy = ny / norm; vz = nz / norm;
    }
    if (!Number.isFinite(vx + vy + vz)) return [0.577, 0.577, 0.577];
    return [vx, vy, vz];
  }

  function uniquePush(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  // Candidate 565 endpoints: bbox corners + PCA projection extremes + quantiles.
  function colorCandidates(px, opaqueMask) {
    let rMin = 255, gMin = 255, bMin = 255, rMax = 0, gMax = 0, bMax = 0;
    for (let i = 0; i < 16; i++) if (opaqueMask[i]) {
      rMin = Math.min(rMin, px[i][0]); gMin = Math.min(gMin, px[i][1]); bMin = Math.min(bMin, px[i][2]);
      rMax = Math.max(rMax, px[i][0]); gMax = Math.max(gMax, px[i][1]); bMax = Math.max(bMax, px[i][2]);
    }
    const cands = [];
    if (!opaqueMask.some(Boolean)) { cands.push(0); return cands; }
    uniquePush(cands, to565(rMin, gMin, bMin));
    uniquePush(cands, to565(rMax, gMax, bMax));
    // Bounding-box other corners (cheap, helps axis-aligned blocks).
    uniquePush(cands, to565(rMin, gMax, bMin));
    uniquePush(cands, to565(rMax, gMin, bMax));
    uniquePush(cands, to565(rMin, gMin, bMax));
    uniquePush(cands, to565(rMax, gMax, bMin));

    const [ax, ay, az] = principalAxis(px, opaqueMask);
    const proj = [];
    for (let i = 0; i < 16; i++) if (opaqueMask[i]) {
      proj.push([px[i][0] * ax + px[i][1] * ay + px[i][2] * az, i]);
    }
    proj.sort((a, b) => a[0] - b[0]);
    const denom = Math.max(1, proj.length - 1);
    const pick = (t) => proj[Math.min(proj.length - 1, Math.max(0, Math.round(t * denom)))][1];
    const picks = [0, 1 / denom, 0.5, (proj.length - 1) / denom, 1].map(pick);
    // Project extreme points back onto the axis line for endpoints beyond the data cloud.
    const t0 = proj[0][0], t1 = proj[proj.length - 1][0];
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (let i = 0; i < 16; i++) if (opaqueMask[i]) { mr += px[i][0]; mg += px[i][1]; mb += px[i][2]; n++; }
    mr /= n; mg /= n; mb /= n;
    const linePoint = (t) => [
      clamp8(mr + ax * (t - (mr * ax + mg * ay + mb * az))),
      clamp8(mg + ay * (t - (mr * ax + mg * ay + mb * az))),
      clamp8(mb + az * (t - (mr * ax + mg * ay + mb * az))),
    ];
    for (const t of [t0, t1, t0 - (t1 - t0) * 0.15, t1 + (t1 - t0) * 0.15]) {
      const p = linePoint(t);
      uniquePush(cands, to565(p[0], p[1], p[2]));
    }
    for (const i of picks) uniquePush(cands, to565(px[i][0], px[i][1], px[i][2]));
    return cands;
  }

  // Coordinate-descent refinement on the 565 bit fields.
  // transparentMode: keep c0<=c1. forceFourColor (BC3): palette always 4-color,
  // any ordering is legal at decode, so no ordering constraint is applied.
  // penalty: added for 4-color blocks covering transparent texels (BC1 only).
  function refineColor(c0, c1, px, transparentMode, forceFourColor, maskOpaque, penalty, bestTotal, bestIndices) {
    let improved = true, guard = 0;
    while (improved && guard++ < 6) {
      improved = false;
      for (const which of [0, 1]) {
        const cur = which === 0 ? c0 : c1;
        for (let bit = 0; bit < 16; bit++) {
          const trial = cur ^ (1 << bit);
          const tc0 = which === 0 ? trial : c0, tc1 = which === 1 ? trial : c1;
          if (!forceFourColor) {
            if (transparentMode && tc0 > tc1) continue;
            if (!transparentMode && tc0 <= tc1) continue; // would silently switch mode
          }
          const r = evalColorPair(tc0, tc1, px, transparentMode, maskOpaque);
          const total = r.sse + (transparentMode ? 0 : penalty);
          if (total < bestTotal) {
            bestTotal = total; bestIndices = r.indices;
            if (which === 0) c0 = trial; else c1 = trial;
            improved = true;
          }
        }
      }
    }
    // Report the pure RGB SSE (no penalty); the record's sse is used for stats.
    const finalEval = evalColorPair(c0, c1, px, transparentMode, maskOpaque);
    return { c0, c1, sse: finalEval.sse, indices: finalEval.indices };
  }

  // Encode one 4x4 color block.
  // forceFourColor: BC3 color sub-block (always 4-color palette semantics).
  function encodeColorBlock(px, forceFourColor) {
    const opaqueMask = px.map((p) => p[3] >= 128);
    const hasTransparent = opaqueMask.indexOf(false) >= 0;
    const opaqueCount = opaqueMask.reduce((n, v) => n + (v ? 1 : 0), 0);

    // Fully transparent block.
    if (opaqueCount === 0) {
      let c0, c1, indices;
      if (forceFourColor) {
        // BC3: alpha comes from the alpha sub-block; colors are irrelevant.
        c0 = 1; c1 = 0; indices = new Array(16).fill(0);
      } else {
        // BC1: every texel must decode as transparent => 3-color+alpha mode,
        // index 3 everywhere (c0<=c1; equal endpoints are legal).
        c0 = 0; c1 = 0; indices = new Array(16).fill(3);
      }
      const bytes = new Uint8Array(8);
      bytes[0] = c0 & 255; bytes[1] = (c0 >> 8) & 255;
      bytes[2] = c1 & 255; bytes[3] = (c1 >> 8) & 255;
      let bits = 0;
      for (let i = 0; i < 16; i++) bits |= indices[i] << (2 * i);
      bytes[4] = bits & 255; bytes[5] = (bits >>> 8) & 255;
      bytes[6] = (bits >>> 16) & 255; bytes[7] = (bits >>> 24) & 255;
      const decoded = decodeColorBlock(bytes, 0, forceFourColor);
      return { bytes, c0, c1, indices, mode: decoded.mode, palette: decoded.palette, sse: 0 };
    }

    const cands = colorCandidates(px, opaqueMask);
    // BC3: the alpha sub-block handles transparency, so color fitting only
    // sees opaque texels. BC1: all texels participate (transparent ones via
    // the special index-3 rule).
    const maskOpaque = !!forceFourColor;

    let best = { sse: Infinity, c0: 0, c1: 0, indices: null, transparentMode: false };
    // A 4-color block cannot represent transparency: every alpha<128 texel it
    // covers becomes a visible, fully-opaque pixel. Charge each such texel a
    // fixed large penalty so mixed blocks choose transparent mode whenever it
    // is legal, while still comparing RGB fit fairly between the two modes.
    let transparentPenalty = 0;
    for (let i = 0; i < 16; i++) if (px[i][3] < 128) transparentPenalty += 3 * 255 * 255;
    const consider = (c0, c1, transparentMode) => {
      // Spec: transparent mode is legal only when the block actually contains
      // an alpha<128 texel. This also makes ties resolve to 4-color mode.
      if (transparentMode && !hasTransparent) return;
      if (transparentMode && c0 > c1) return;
      const r = evalColorPair(c0, c1, px, transparentMode, maskOpaque);
      const sse = r.sse + (transparentMode ? 0 : transparentPenalty);
      // Strict < keeps an earlier 4-color candidate on equal SSE.
      if (sse < best.sse) best = { sse, c0, c1, indices: r.indices, transparentMode };
    };

    for (let a = 0; a < cands.length; a++) {
      for (let b = 0; b < cands.length; b++) {
        if (a === b) continue;
        // Spec: a block without transparent texels must not decode transparent ones,
        // so 4-color mode requires c0>c1, and transparent mode is only legal when
        // the block actually contains alpha < 128 texels.
        if (!forceFourColor && cands[a] > cands[b]) consider(cands[a], cands[b], false);
        if (forceFourColor) consider(cands[a], cands[b], false);
        if (hasTransparent && !forceFourColor) consider(cands[a], cands[b], true);
      }
    }
    // Equal endpoints: legal in transparent mode (c0==c1 keeps the alpha
    // palette). For a fully opaque BC1 block a c0==c1 pair would decode as
    // transparent mode, so instead emit a legal c0>c1 pair whose low bit
    // differs; the palette stays effectively a single color.
    if (cands.length) {
      if (!hasTransparent && !forceFourColor) {
        const v = cands[0];
        const hi = v < 0xFFFF ? v + 1 : v;
        const lo = v < 0xFFFF ? v : v - 1;
        consider(Math.max(hi, lo), Math.min(hi, lo), false);
      } else {
        consider(cands[0], cands[0], false);
      }
      if (hasTransparent && !forceFourColor) consider(cands[0], cands[0], true);
    }
    if (best.indices === null) throw new Error('internal: no endpoint pair was legal');

    const refined = refineColor(best.c0, best.c1, px, best.transparentMode, forceFourColor,
      maskOpaque, transparentPenalty, best.sse, best.indices);
    best.c0 = refined.c0; best.c1 = refined.c1; best.sse = refined.sse; best.indices = refined.indices;

    // Safety: no transparent pixels => never emit a transparent-mode block.
    if (!hasTransparent && best.transparentMode) throw new Error('internal: transparent mode without transparent texels');

    const bytes = new Uint8Array(8);
    bytes[0] = best.c0 & 255; bytes[1] = (best.c0 >> 8) & 255;
    bytes[2] = best.c1 & 255; bytes[3] = (best.c1 >> 8) & 255;
    let bits = 0;
    for (let i = 0; i < 16; i++) bits |= (best.indices[i] & 3) << (2 * i);
    bytes[4] = bits & 255; bytes[5] = (bits >>> 8) & 255;
    bytes[6] = (bits >>> 16) & 255; bytes[7] = (bits >>> 24) & 255;

    const decoded = decodeColorBlock(bytes, 0, forceFourColor);
    return {
      bytes,
      c0: best.c0, c1: best.c1,
      indices: best.indices,
      mode: decoded.mode,
      palette: decoded.palette,
      sse: best.sse,
    };
  }

  // ---------- encode: BC3 alpha ----------

  function alphaTable(a0, a1) {
    const t = new Array(8);
    t[0] = a0; t[1] = a1;
    if (a0 > a1) {
      for (let i = 2; i < 8; i++) t[i] = (((8 - i) * a0 + (i - 1) * a1) / 7) | 0;
      return { table: t, mode: '8-interp' };
    }
    for (let i = 2; i < 6; i++) t[i] = (((6 - i) * a0 + (i - 1) * a1) / 5) | 0;
    t[6] = 0; t[7] = 255;
    return { table: t, mode: '6-interp+0/255' };
  }

  function evalAlpha(a0, a1, px) {
    const table = alphaTable(a0, a1).table;
    let sse = 0;
    const indices = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      const target = px[i][3];
      let best = 0;
      let d = target - table[0], bestD = d * d;
      for (let k = 1; k < 8; k++) {
        d = target - table[k];
        const dd = d * d;
        if (dd < bestD) { bestD = dd; best = k; }
      }
      indices[i] = best; sse += bestD;
    }
    return { sse, indices };
  }

  // Fast alpha block encoder: the BC3 table is a monotonic ramp between a0/a1,
  // so good endpoints sit at (or just outside) the data range. Enumerate a
  // narrow window around the min/max for both table modes, then refine with
  // short +/-1 coordinate moves.
  function encodeAlphaBlock(px) {
    const vals = px.map((p) => p[3]);
    const sorted = vals.slice().sort((a, b) => a - b);
    const minV = sorted[0], maxV = sorted[15];

    let best = { sse: Infinity, a0: 0, a1: 0, indices: null, mode: null };
    const tryPair = (a0, a1) => {
      if (a0 < 0 || a0 > 255 || a1 < 0 || a1 > 255) return;
      const r = evalAlpha(a0, a1, px);
      if (r.sse < best.sse) {
        best = { sse: r.sse, a0, a1, indices: r.indices, mode: alphaTable(a0, a1).mode };
      }
    };

    // Endpoint window: a few values around the extremes (ramp overshoot helps
    // with quantized tables), plus explicit 0/255 anchors for the 6-entry mode.
    const near = (v) => {
      const out = [];
      for (const d of [0, 1, 2, 4, 8]) {
        uniquePush(out, clamp8(v - d)); uniquePush(out, clamp8(v + d));
      }
      return out;
    };
    const low = near(minV), high = near(maxV);
    uniquePush(low, 0); uniquePush(high, 255);
    for (const a0 of low) for (const a1 of high) tryPair(a0, a1);
    // Also try swapped-extreme windows for blocks whose values sit oddly.
    for (const a0 of high) for (const a1 of low) tryPair(a0, a1);

    // Local +/-1 refinement.
    let improved = true, guard = 0;
    while (improved && guard++ < 8) {
      improved = false;
      for (const which of [0, 1]) {
        const cur = which === 0 ? best.a0 : best.a1;
        for (const delta of [-1, 1]) {
          const trial = clamp8(cur + delta);
          const ta0 = which === 0 ? trial : best.a0, ta1 = which === 1 ? trial : best.a1;
          const r = evalAlpha(ta0, ta1, px);
          if (r.sse < best.sse) {
            best = { sse: r.sse, a0: ta0, a1: ta1, indices: r.indices, mode: alphaTable(ta0, ta1).mode };
            improved = true;
          }
        }
      }
    }

    const bytes = new Uint8Array(8);
    bytes[0] = best.a0; bytes[1] = best.a1;
    let bits = 0;
    for (let i = 0; i < 16; i++) bits += (best.indices[i] & 7) * Math.pow(2, 3 * i);
    for (let k = 0; k < 6; k++) bytes[2 + k] = Math.floor(bits / Math.pow(2, 8 * k)) & 255;
    const decoded = decodeAlphaBlock(bytes, 0);
    return {
      bytes, a0: best.a0, a1: best.a1, indices: best.indices,
      table: decoded.table, mode: decoded.mode, sse: best.sse,
    };
  }

  // ---------- full-image encode ----------

  // src: { width, height, rgba(Uint8ClampedArray of padded pw x ph) }, pw/ph multiples of 4.
  function encodeImage(src, pw, ph, format, onProgress) {
    const bw = pw >> 2, bh = ph >> 2, bs = format === 'BC3' ? 16 : 8;
    const total = bw * bh;
    const payload = new Uint8Array(total * bs);
    const records = new Array(total);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const bi = by * bw + bx;
        const px = new Array(16);
        for (let i = 0; i < 16; i++) {
          const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
          const o = (y * pw + x) * 4;
          px[i] = [src.rgba[o], src.rgba[o + 1], src.rgba[o + 2], src.rgba[o + 3]];
        }
        let rec;
        if (format === 'BC3') {
          const alpha = encodeAlphaBlock(px);
          const color = encodeColorBlock(px, true);
          alpha.bytes.forEach((v, k) => payload[bi * 16 + k] = v);
          color.bytes.forEach((v, k) => payload[bi * 16 + 8 + k] = v);
          rec = { bx, by, alpha, color };
        } else {
          const color = encodeColorBlock(px, false);
          color.bytes.forEach((v, k) => payload[bi * 8 + k] = v);
          rec = { bx, by, color };
        }
        records[bi] = rec;
        if (onProgress && (bi & 31) === 0) onProgress(bi / total);
      }
    }
    if (onProgress) onProgress(1);
    return { payload, records, bw, bh };
  }

  const BCC = {
    expand565, to565,
    decodeColorBlock, decodeAlphaBlock, decodePayload,
    paletteFor, evalColorPair, encodeColorBlock,
    alphaTable, evalAlpha, encodeAlphaBlock,
    encodeImage,
  };
  root.BCC = BCC;
  if (typeof module !== 'undefined' && module.exports) module.exports = BCC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
