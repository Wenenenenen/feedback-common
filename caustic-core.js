/*
 * caustic-core.js — 彩色透射焦散打样核心算法
 *
 * 模型约定(与 samples/caustic-footprints.json 的“说明”一致):
 *   - 接光板在 z=0,宽 width、高 height 个单位像素,像素 (i,j) 覆盖 [i,i+1]×[j,j+1],y 向上。
 *   - 源片为空间三角形,每色射线平行,方向 (dx,dy,-1);
 *     顶点 (x,y,z) 的落点为 (x+z*dx, y+z*dy)。
 *   - 入射能量(每源片每色)= powerPerXY[c] × 源片 XY 投影面积。
 *   - 该能量在落点三角形上摊匀:面密度 = 入射能量 / 落点三角形面积。
 *   - 挡板为高度 z 的水平矩形 [左,下,右,上],沿同一方向投影到板上,
 *     阴影 = rect 平移 (z*dx, z*dy);多挡板阴影按并集扣除(顺序差集等价)。
 *   - 扣挡之后,落在板外的部分计为出界。
 *
 * 所有面积均为精确多边形裁剪(Sutherland–Hodgman 半平面裁剪),
 * 逐像素能量 = 面密度 × (多边形 ∩ 单位像素)的精确面积,不做任何点采样。
 */
(function (global) {
  'use strict';

  var COLORS = ['R', 'G', 'B'];

  /* 凸片顶点数上界:三角形经 16 块挡板 × 4 个半平面裁剪,再加板/像素裁剪余量 */
  var MAXV = 320;
  var bufA = new Float64Array(2 * MAXV);
  var bufB = new Float64Array(2 * MAXV);
  var bufC = new Float64Array(2 * MAXV);
  var bufD = new Float64Array(2 * MAXV);

  function triSignedArea(ax, ay, bx, by, cx, cy) {
    return 0.5 * ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  }

  /* 多边形(交错存储 [x0,y0,x1,y1,...],n 个顶点)的有符号面积 */
  function polyAreaFlat(poly, n) {
    var s = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      s += poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
    }
    return s / 2;
  }

  /*
   * 半平面裁剪(凸多边形,顶点数 n)。
   * coord=0 按 x、coord=1 按 y;keepLess=true 保留坐标 <= bound,否则保留 >= bound。
   * 结果写入 out(交错数组),返回顶点数。out 不得与 poly 重叠。
   */
  function clipHalf(poly, n, coord, bound, keepLess, out) {
    var m = 0;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var ax = poly[2 * i], ay = poly[2 * i + 1];
      var bx = poly[2 * j], by = poly[2 * j + 1];
      var ac = coord === 0 ? ax : ay;
      var bc = coord === 0 ? bx : by;
      var da = keepLess ? bound - ac : ac - bound; /* >=0 表示在保留侧 */
      var db = keepLess ? bound - bc : bc - bound;
      var ain = da >= 0, bin = db >= 0;
      if (ain) { out[2 * m] = ax; out[2 * m + 1] = ay; m++; }
      if (ain !== bin) {
        var t = da / (da - db);
        out[2 * m] = ax + t * (bx - ax);
        out[2 * m + 1] = ay + t * (by - ay);
        m++;
      }
    }
    return m;
  }

  /* 凸多边形 ∩ 矩形 [l,r]×[b,t],结果写入 out,返回顶点数(不足 3 返回 0)。 */
  function clipToRect(poly, n, l, b, r, t, out) {
    var m = clipHalf(poly, n, 0, l, false, bufA);
    if (m < 3) return 0;
    m = clipHalf(bufA, m, 0, r, true, bufB);
    if (m < 3) return 0;
    m = clipHalf(bufB, m, 1, b, false, bufA);
    if (m < 3) return 0;
    m = clipHalf(bufA, m, 1, t, true, out);
    if (m < 3) return 0;
    return m;
  }

  /*
   * 凸多边形减去矩形(阴影),返回至多 4 个互不重叠的凸片(普通数组的数组)。
   * 矩形外部分解为:左条 {x<=l}、右条 {x>=r}、中条 {l<=x<=r} 的
   * 下段 {y<=b} 与上段 {y>=t},四片仅在边界相接(零面积重叠)。
   */
  function pushPiece(pieces, poly, m) {
    if (m >= 3 && polyAreaFlat(poly, m) !== 0) {
      pieces.push(Array.prototype.slice.call(poly, 0, 2 * m));
    }
  }
  function subtractRectPieces(poly, n, l, b, r, t) {
    var pieces = [];
    var m = clipHalf(poly, n, 0, l, true, bufD);          /* 左条 */
    pushPiece(pieces, bufD, m);
    m = clipHalf(poly, n, 0, r, false, bufD);             /* 右条 */
    pushPiece(pieces, bufD, m);
    m = clipHalf(poly, n, 0, l, false, bufD);             /* 中条:x>=l */
    if (m >= 3) {
      m = clipHalf(bufD, m, 0, r, true, bufC);            /* 中条:x<=r */
      if (m >= 3) {
        var m2 = clipHalf(bufC, m, 1, b, true, bufD);     /* 中条下段 */
        pushPiece(pieces, bufD, m2);
        m2 = clipHalf(bufC, m, 1, t, false, bufD);        /* 中条上段 */
        pushPiece(pieces, bufD, m2);
      }
    }
    return pieces;
  }

  /* 把板内凸片精确栅格化:逐像素求交集面积,累加能量与贡献记录。 */
  function rasterize(poly, n, density, colorIdx, srcIdx, W, H, pixels, contrib) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < n; i++) {
      var x = poly[2 * i], y = poly[2 * i + 1];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
    var x0 = Math.max(0, Math.floor(minx)), x1 = Math.min(W - 1, Math.floor(maxx));
    var y0 = Math.max(0, Math.floor(miny)), y1 = Math.min(H - 1, Math.floor(maxy));
    for (var py = y0; py <= y1; py++) {
      for (var px = x0; px <= x1; px++) {
        var m = clipToRect(poly, n, px, py, px + 1, py + 1, bufC);
        if (m < 3) continue;
        var a = Math.abs(polyAreaFlat(bufC, m));
        if (a === 0) continue;
        var e = density * a;
        var idx = py * W + px;
        pixels[3 * idx + colorIdx] += e;
        var lst = contrib[idx];
        if (lst === undefined) lst = contrib[idx] = [];
        lst.push(srcIdx, colorIdx, e);
      }
    }
  }

  /*
   * 主入口。返回:
   *   width, height          板尺寸
   *   pixels                 Float64Array(W*H*3),像素 (i,j) 在 (j*W+i)*3+c,线性 RGB
   *   contrib                每像素贡献清单(扁平三元组 [源片序号, 色序号, 能量, ...])
   *   entries                逐片逐色 {source,color,incident,occluded,outOfBounds,landed,degenerate}
   *   degenerate             落点三角形面积为零的 {source,color} 列表
   *   totals                 四项合计
   */
  function analyze(model) {
    var W = model.width, H = model.height;
    var sources = model.sources || [];
    var blockers = model.blockers || [];
    var pixels = new Float64Array(W * H * 3);
    var contrib = new Array(W * H);
    var entries = [];
    var degenerate = [];
    var totals = { incident: 0, occluded: 0, outOfBounds: 0, landed: 0 };

    for (var si = 0; si < sources.length; si++) {
      var src = sources[si];
      var id = src.id != null ? String(src.id) : String(si);
      var v = src.vertices;
      var srcXY = Math.abs(triSignedArea(
        v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1]));

      for (var c = 0; c < 3; c++) {
        var dx = src.slopes[c][0], dy = src.slopes[c][1];
        var incident = src.powerPerXY[c] * srcXY;
        var lx0 = v[0][0] + v[0][2] * dx, ly0 = v[0][1] + v[0][2] * dy;
        var lx1 = v[1][0] + v[1][2] * dx, ly1 = v[1][1] + v[1][2] * dy;
        var lx2 = v[2][0] + v[2][2] * dx, ly2 = v[2][1] + v[2][2] * dy;
        var la = triSignedArea(lx0, ly0, lx1, ly1, lx2, ly2);

        var entry = {
          source: id, color: COLORS[c], incident: incident,
          occluded: 0, outOfBounds: 0, landed: 0, degenerate: false
        };
        entries.push(entry);
        totals.incident += incident;

        if (la === 0) { /* 落点三角形面积为零:指出源片与颜色 */
          entry.degenerate = true;
          degenerate.push({ source: id, color: COLORS[c] });
          continue;
        }
        if (incident === 0) continue;

        var landingArea = Math.abs(la);
        var density = incident / landingArea;

        /* 扣挡:落点三角形依次减去各挡板阴影(并集 = 顺序差集) */
        var pieces = [[lx0, ly0, lx1, ly1, lx2, ly2]];
        for (var bi = 0; bi < blockers.length && pieces.length > 0; bi++) {
          var bl = blockers[bi];
          var sx = bl.z * dx, sy = bl.z * dy;
          var l = bl.rect[0] + sx, bb = bl.rect[1] + sy;
          var r = bl.rect[2] + sx, t = bl.rect[3] + sy;
          var next = [];
          for (var pi = 0; pi < pieces.length; pi++) {
            var sub = subtractRectPieces(pieces[pi], pieces[pi].length / 2, l, bb, r, t);
            for (var k = 0; k < sub.length; k++) next.push(sub[k]);
          }
          pieces = next;
        }

        var remArea = 0, pi2, n, m, pArea, inArea;
        for (pi2 = 0; pi2 < pieces.length; pi2++) {
          remArea += Math.abs(polyAreaFlat(pieces[pi2], pieces[pi2].length / 2));
        }
        entry.occluded = density * (landingArea - remArea);
        totals.occluded += entry.occluded;

        /* 扣挡后才计出界;板内部分逐像素精确覆盖 */
        for (pi2 = 0; pi2 < pieces.length; pi2++) {
          var poly = pieces[pi2];
          n = poly.length / 2;
          pArea = Math.abs(polyAreaFlat(poly, n));
          m = clipToRect(poly, n, 0, 0, W, H, bufC);
          inArea = m >= 3 ? Math.abs(polyAreaFlat(bufC, m)) : 0;
          entry.outOfBounds += density * (pArea - inArea);
          entry.landed += density * inArea;
          if (inArea > 0) {
            rasterize(Array.prototype.slice.call(bufC, 0, 2 * m), m,
              density, c, si, W, H, pixels, contrib);
          }
        }
        totals.outOfBounds += entry.outOfBounds;
        totals.landed += entry.landed;
      }
    }

    return {
      width: W, height: H, pixels: pixels, contrib: contrib,
      entries: entries, degenerate: degenerate, totals: totals, sources: sources
    };
  }

  /* 输入校验,返回错误信息数组(空数组表示通过)。 */
  function validate(data) {
    var errors = [];
    function num(x) { return typeof x === 'number' && isFinite(x); }
    if (!data || typeof data !== 'object') { errors.push('根节点不是对象'); return errors; }
    if (!Number.isInteger(data.width) || data.width < 1 || data.width > 128)
      errors.push('width 须为 1..128 的整数,当前: ' + data.width);
    if (!Number.isInteger(data.height) || data.height < 1 || data.height > 96)
      errors.push('height 须为 1..96 的整数,当前: ' + data.height);
    var srcs = data.sources;
    if (!Array.isArray(srcs) || srcs.length < 1) {
      errors.push('sources 须为非空数组');
    } else {
      if (srcs.length > 512) errors.push('sources 超过 512 个: ' + srcs.length);
      srcs.forEach(function (s, i) {
        if (!s || typeof s !== 'object') { errors.push('源片 ' + i + ' 不是对象'); return; }
        if (!Array.isArray(s.vertices) || s.vertices.length !== 3 ||
            !s.vertices.every(function (p) { return Array.isArray(p) && p.length === 3 && p.every(num); }))
          errors.push('源片 ' + i + ' 的 vertices 须为 3 个 [x,y,z]');
        if (!Array.isArray(s.slopes) || s.slopes.length !== 3 ||
            !s.slopes.every(function (p) { return Array.isArray(p) && p.length === 2 && p.every(num); }))
          errors.push('源片 ' + i + ' 的 slopes 须为 3 个 [dx,dy](按 RGB)');
        if (!Array.isArray(s.powerPerXY) || s.powerPerXY.length !== 3 || !s.powerPerXY.every(num))
          errors.push('源片 ' + i + ' 的 powerPerXY 须为 3 个数(按 RGB)');
      });
    }
    var bl = data.blockers == null ? [] : data.blockers;
    if (!Array.isArray(bl)) {
      errors.push('blockers 须为数组');
    } else {
      if (bl.length > 16) errors.push('blockers 超过 16 块: ' + bl.length);
      bl.forEach(function (b, i) {
        if (!b || typeof b !== 'object') { errors.push('挡板 ' + i + ' 不是对象'); return; }
        if (!num(b.z)) errors.push('挡板 ' + i + ' 缺合法 z');
        if (!Array.isArray(b.rect) || b.rect.length !== 4 || !b.rect.every(num)) {
          errors.push('挡板 ' + i + ' 的 rect 须为 [左,下,右,上]');
        } else if (!(b.rect[0] < b.rect[2] && b.rect[1] < b.rect[3])) {
          errors.push('挡板 ' + i + ' 的 rect 须满足 左<右、下<上');
        }
      });
    }
    return errors;
  }

  var api = { analyze: analyze, validate: validate, COLORS: COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CausticCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
