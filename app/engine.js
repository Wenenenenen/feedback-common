/* UV Overlap Auditor — geometry + analysis engine (framework-free)
   Constants and conventions follow 说明.txt:
   - UV origin bottom-left; absolute 3D and UV areas
   - degenerate: 3D or UV area <= 1e-12 (excluded from overlap & stretch stats)
   - overlap reported only when area > 1e-8; shared edge / point contact excluded
   - mask 256x256, pixel (r,c) center ((c+.5)/256, 1-(r+.5)/256);
     count = strict-interior hits + at most one lowest-id boundary hit; tol 1e-10
*/
(function (global) {
  'use strict';

  var EPS_DEG = 1e-12;
  var EPS_OVL = 1e-8;
  var EPS_BOUND = 1e-10;
  var MASK_SIZE = 256;

  function sub2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
  function triSignedArea2(p, q, r) { return cross2(sub2(q, p), sub2(r, p)) * 0.5; }

  function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len3(a) { return Math.sqrt(dot3(a, a)); }

  // Singular values of the 3D-plane -> UV linear map.
  // Built from 2D in-plane edge coordinates (x1,x2) and UV edge vectors (d1,d2):
  // J = [d1 d2] [x1 x2]^-1 ; singular values = sqrt(eigenvalues of J^T J).
  function singularValues(x1, x2, d1, d2) {
    var det = x1[0] * x2[1] - x1[1] * x2[0];
    var j00 = (d1[0] * x2[1] - d2[0] * x1[1]) / det;
    var j01 = (d2[0] * x1[0] - d1[0] * x2[0]) / det;
    var j10 = (d1[1] * x2[1] - d2[1] * x1[1]) / det;
    var j11 = (d2[1] * x1[0] - d1[1] * x2[0]) / det;
    var g00 = j00 * j00 + j10 * j10;
    var g01 = j00 * j01 + j10 * j11;
    var g11 = j01 * j01 + j11 * j11;
    var tr = g00 + g11;
    var disc = Math.max(0, 0.25 * tr * tr - (g00 * g11 - g01 * g01));
    var root = Math.sqrt(disc);
    var hi = Math.sqrt(Math.max(0, 0.5 * tr + root));
    var lo = Math.sqrt(Math.max(0, 0.5 * tr - root));
    return [hi, lo];
  }

  function computeFaceMetrics(vertices, face, uvTri) {
    var a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]];
    var e1 = sub3(b, a), e2 = sub3(c, a);
    var cr = cross3(e1, e2);
    var area3 = 0.5 * len3(cr);

    var p0 = uvTri[0], p1 = uvTri[1], p2 = uvTri[2];
    var signedUv = triSignedArea2(p0, p1, p2);
    var areaUv = Math.abs(signedUv);
    var degenerate = area3 <= EPS_DEG || areaUv <= EPS_DEG;
    var mirrored = signedUv < 0;
    var outside = false;
    for (var k = 0; k < 3; k++) {
      var u = uvTri[k][0], v = uvTri[k][1];
      if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) { outside = true; break; }
    }

    var m = {
      area3: area3,
      areaUv: areaUv,
      signedUv: signedUv,
      degenerate: degenerate,
      mirrored: mirrored,
      outside: outside,
      areaRatio: null,
      svHi: null,
      svLo: null,
      stretch: null
    };
    if (degenerate) return m;

    m.areaRatio = areaUv / area3;

    // In-plane orthonormal basis: e1 direction + face normal cross it.
    var l1 = len3(e1);
    var ux = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
    var n = [cr[0] / (2 * area3), cr[1] / (2 * area3), cr[2] / (2 * area3)];
    var uy = cross3(n, ux);
    var x1 = [dot3(e1, ux), dot3(e1, uy)];
    var x2 = [dot3(e2, ux), dot3(e2, uy)];
    var d1 = sub2(p1, p0), d2 = sub2(p2, p0);
    var sv = singularValues(x1, x2, d1, d2);
    m.svHi = sv[0];
    m.svLo = sv[1];
    m.stretch = m.svLo > EPS_DEG ? m.svHi / m.svLo : Infinity;
    return m;
  }

  // CCW-oriented copy of a UV triangle (degenerate triangles returned as-is).
  function orientCcw(tri, signed) {
    if (signed < 0) return [tri[0], tri[2], tri[1]];
    return [tri[0], tri[1], tri[2]];
  }

  // Sutherland-Hodgman clip of subject polygon by a CCW triangle.
  function clipPolygon(subject, clip) {
    var out = subject;
    for (var e = 0; e < 3; e++) {
      var a = clip[e], b = clip[(e + 1) % 3];
      var edge = sub2(b, a);
      if (out.length === 0) return [];
      var inp = out;
      out = [];
      var prev = inp[inp.length - 1];
      var prevIn = cross2(edge, sub2(prev, a)) >= -EPS_BOUND;
      for (var i = 0; i < inp.length; i++) {
        var cur = inp[i];
        var curIn = cross2(edge, sub2(cur, a)) >= -EPS_BOUND;
        if (curIn !== prevIn) {
          var pe = sub2(cur, prev);
          var den = cross2(pe, edge);
          if (Math.abs(den) > EPS_DEG) {
            var t = cross2(sub2(a, prev), edge) / den;
            out.push([prev[0] + t * pe[0], prev[1] + t * pe[1]]);
          }
        }
        if (curIn) out.push(cur);
        prev = cur;
        prevIn = curIn;
      }
    }
    return out;
  }

  function polygonArea(poly) {
    if (poly.length < 3) return 0;
    var s = 0;
    for (var i = 0; i < poly.length; i++) {
      s += cross2(poly[i], poly[(i + 1) % poly.length]);
    }
    return Math.abs(s) * 0.5;
  }

  function triBounds(t) {
    return {
      minU: Math.min(t[0][0], t[1][0], t[2][0]),
      maxU: Math.max(t[0][0], t[1][0], t[2][0]),
      minV: Math.min(t[0][1], t[1][1], t[2][1]),
      maxV: Math.max(t[0][1], t[1][1], t[2][1])
    };
  }

  // Point-in-triangle for an oriented triangle. Returns:
  // 2 = strict interior, 1 = boundary (within EPS_BOUND), 0 = outside.
  function pointTriKind(pt, t) {
    var d0 = cross2(sub2(t[1], t[0]), sub2(pt, t[0]));
    var d1 = cross2(sub2(t[2], t[1]), sub2(pt, t[1]));
    var d2 = cross2(sub2(t[0], t[2]), sub2(pt, t[2]));
    if (d0 > EPS_BOUND && d1 > EPS_BOUND && d2 > EPS_BOUND) return 2;
    if (d0 >= -EPS_BOUND && d1 >= -EPS_BOUND && d2 >= -EPS_BOUND) return 1;
    return 0;
  }

  function validate(data) {
    if (data === null || typeof data !== 'object') {
      throw new Error('JSON 根节点必须是对象，包含 vertices / faces / uv 三个数组。');
    }
    var vertices = data.vertices, faces = data.faces, uv = data.uv;
    if (!Array.isArray(vertices) || !Array.isArray(faces) || !Array.isArray(uv)) {
      throw new Error('缺少 vertices、faces 或 uv 数组。');
    }
    if (faces.length > 5000) {
      throw new Error('三角形数量为 ' + faces.length + '，超出上限 5000。');
    }
    if (uv.length !== faces.length) {
      throw new Error('uv 数组长度(' + uv.length + ')与 faces(' + faces.length + ')不一致，要求逐面逐角对应。');
    }
    var i, j, p;
    for (i = 0; i < vertices.length; i++) {
      p = vertices[i];
      if (!Array.isArray(p) || p.length !== 3 ||
          typeof p[0] !== 'number' || typeof p[1] !== 'number' || typeof p[2] !== 'number' ||
          !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) {
        throw new Error('vertices[' + i + '] 必须是 3 个有限数字。');
      }
    }
    for (i = 0; i < faces.length; i++) {
      var f = faces[i];
      if (!Array.isArray(f) || f.length !== 3) {
        throw new Error('faces[' + i + '] 必须是长度为 3 的索引数组。');
      }
      for (j = 0; j < 3; j++) {
        if (!Number.isInteger(f[j]) || f[j] < 0 || f[j] >= vertices.length) {
          throw new Error('faces[' + i + '][' + j + '] = ' + String(f[j]) +
            ' 越界，有效索引范围为 0..' + (vertices.length - 1) + '。');
        }
      }
    }
    for (i = 0; i < uv.length; i++) {
      var t = uv[i];
      if (!Array.isArray(t) || t.length !== 3) {
        throw new Error('uv[' + i + '] 必须包含 3 个角点。');
      }
      for (j = 0; j < 3; j++) {
        p = t[j];
        if (!Array.isArray(p) || p.length !== 2 ||
            typeof p[0] !== 'number' || typeof p[1] !== 'number' ||
            !isFinite(p[0]) || !isFinite(p[1])) {
          throw new Error('uv[' + i + '][' + j + '] 必须是 2 个有限数字（NaN/Infinity 不合法）。');
        }
      }
    }
    return { vertices: vertices, faces: faces, uv: uv };
  }

  // Full analysis. token: {cancelled:boolean}; yieldTo: async chunk boundary.
  // onProgress(phase, done, total). Never resolves with partial data after cancel —
  // the caller checks token.cancelled and discards the result.
  async function analyze(data, token, onProgress, yieldTo) {
    var v = data.vertices, faces = data.faces, uvs = data.uv;
    var n = faces.length;
    var metrics = new Array(n);
    var valid = new Array(n);
    var oriented = new Array(n);
    var bounds = new Array(n);

    var CHUNK = 250;
    var i, j, q, r, c, kk;
    for (i = 0; i < n; i++) {
      metrics[i] = computeFaceMetrics(v, faces[i], uvs[i]);
      valid[i] = !metrics[i].degenerate;
      oriented[i] = valid[i] ? orientCcw(uvs[i], metrics[i].signedUv) : null;
      bounds[i] = valid[i] ? triBounds(oriented[i]) : null;
      if (i % CHUNK === CHUNK - 1) {
        if (onProgress) onProgress('metrics', Math.min(i + 1, n), n);
        await yieldTo();
        if (token.cancelled) return null;
      }
    }

    // Overlap pairs: bbox reject, then exact polygon clip.
    var overlaps = [];
    var facePairs = Array.from({ length: n }, function () { return []; });
    for (i = 0; i < n; i++) {
      if (!valid[i]) continue;
      var bi = bounds[i];
      for (j = i + 1; j < n; j++) {
        if (!valid[j]) continue;
        var bj = bounds[j];
        if (bi.maxU <= bj.minU || bj.maxU <= bi.minU ||
            bi.maxV <= bj.minV || bj.maxV <= bi.minV) continue;
        var poly = clipPolygon(oriented[i].slice(), oriented[j]);
        var area = polygonArea(poly);
        if (area > EPS_OVL) {
          var cu = 0, cv = 0;
          for (var q = 0; q < poly.length; q++) { cu += poly[q][0]; cv += poly[q][1]; }
          var rec = {
            a: i, b: j, area: area,
            centroid: [cu / poly.length, cv / poly.length],
            poly: poly
          };
          overlaps.push(rec);
          facePairs[i].push(rec);
          facePairs[j].push(rec);
        }
      }
      if (i % 50 === 49) {
        if (onProgress) onProgress('overlap', i + 1, n);
        await yieldTo();
        if (token.cancelled) return null;
      }
    }

    // 256x256 mask. Per row, candidate faces are those whose bbox spans the row.
    var mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
    for (var r = 0; r < MASK_SIZE; r++) {
      var py = 1 - (r + 0.5) / MASK_SIZE;
      var cands = [];
      for (i = 0; i < n; i++) {
        if (!valid[i]) continue;
        var bd = bounds[i];
        if (py >= bd.minV - EPS_BOUND && py <= bd.maxV + EPS_BOUND) cands.push(i);
      }
      var rowBase = r * MASK_SIZE;
      for (var c = 0; c < MASK_SIZE; c++) {
        var px = (c + 0.5) / MASK_SIZE;
        var interior = 0, boundaryMin = -1;
        for (var kk = 0; kk < cands.length; kk++) {
          var fi = cands[kk];
          if (px < bounds[fi].minU - EPS_BOUND || px > bounds[fi].maxU + EPS_BOUND) continue;
          var kind = pointTriKind([px, py], oriented[fi]);
          if (kind === 2) interior++;
          else if (kind === 1 && (boundaryMin === -1 || fi < boundaryMin)) boundaryMin = fi;
        }
        var count = interior + (boundaryMin === -1 ? 0 : 1);
        if (count >= 2) mask[rowBase + c] = 1;
      }
      if (r % 16 === 15) {
        if (onProgress) onProgress('mask', r + 1, MASK_SIZE);
        await yieldTo();
        if (token.cancelled) return null;
      }
    }

    return {
      metrics: metrics,
      valid: valid,
      oriented: oriented,
      bounds: bounds,
      overlaps: overlaps,
      facePairs: facePairs,
      mask: mask,
      maskSize: MASK_SIZE
    };
  }

  // Faces whose UV triangle contains a UV point; boundary counts as containing.
  function facesAtPoint(result, pt) {
    var hits = [];
    for (var i = 0; i < result.valid.length; i++) {
      if (!result.valid[i]) continue;
      if (pointTriKind(pt, result.oriented[i]) > 0) hits.push(i);
    }
    return hits;
  }

  global.UVAudit = {
    EPS_DEG: EPS_DEG,
    EPS_OVL: EPS_OVL,
    EPS_BOUND: EPS_BOUND,
    MASK_SIZE: MASK_SIZE,
    validate: validate,
    analyze: analyze,
    computeFaceMetrics: computeFaceMetrics,
    clipPolygon: clipPolygon,
    polygonArea: polygonArea,
    pointTriKind: pointTriKind,
    facesAtPoint: facesAtPoint,
    triSignedArea2: triSignedArea2
  };
})(typeof window !== 'undefined' ? window : globalThis);
