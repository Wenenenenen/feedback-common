/*
 * 跨 UV 接缝投影涂色 —— 纯逻辑核心
 * 不依赖 DOM，浏览器与 Node 均可加载（经典脚本，挂到 globalThis.SeamBrushCore）。
 *
 * 定点约定：屏幕坐标与 UV 坐标均为整数“256 分之一”单位；
 * 纹素 (x,y) 的 UV 取样点 = (256x+128, 256y+128)；
 * 屏幕像素 (x,y) 的取样中心 = (256x+128, 256y+128)。
 */
(function (root) {
  'use strict';

  var MAX_VIEW_W = 512, MAX_VIEW_H = 384;
  var MAX_TEX = 1024;
  var MAX_VERTS = 72000, MAX_FACES = 24000;
  var MAX_COORD = 524288, MAX_Z = 1048576;
  var BG = [32, 36, 40];
  var TILE = 16; // 屏幕分块边长（像素）

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

  /* ---------------- 校验 ---------------- */

  function validateScene(s) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      return '根节点：必须是 JSON 对象';
    }
    var i, j, e;

    if (!Array.isArray(s.view) || s.view.length !== 2) return 'view：必须是含两个整数的数组 [宽,高]';
    if (!isInt(s.view[0]) || s.view[0] < 1 || s.view[0] > MAX_VIEW_W) return 'view[0]：必须是 1..' + MAX_VIEW_W + ' 的整数';
    if (!isInt(s.view[1]) || s.view[1] < 1 || s.view[1] > MAX_VIEW_H) return 'view[1]：必须是 1..' + MAX_VIEW_H + ' 的整数';

    if (!Array.isArray(s.texture) || s.texture.length !== 2) return 'texture：必须是含两个整数的数组 [宽,高]';
    if (!isInt(s.texture[0]) || s.texture[0] < 1 || s.texture[0] > MAX_TEX) return 'texture[0]：必须是 1..' + MAX_TEX + ' 的整数';
    if (!isInt(s.texture[1]) || s.texture[1] < 1 || s.texture[1] > MAX_TEX) return 'texture[1]：必须是 1..' + MAX_TEX + ' 的整数';

    if (!Array.isArray(s.base) || s.base.length !== 3) return 'base：必须是含三个整数的数组 [r,g,b]';
    for (i = 0; i < 3; i++) {
      if (!isInt(s.base[i]) || s.base[i] < 0 || s.base[i] > 255) return 'base[' + i + ']：必须是 0..255 的整数';
    }

    if (!Array.isArray(s.vertices)) return 'vertices：必须是数组';
    if (s.vertices.length > MAX_VERTS) return 'vertices：数量超过上限 ' + MAX_VERTS;
    for (i = 0; i < s.vertices.length; i++) {
      var vv = s.vertices[i];
      if (!Array.isArray(vv) || vv.length !== 3) return 'vertices[' + i + ']：必须是含三个整数的数组 [x,y,z]';
      for (j = 0; j < 3; j++) {
        if (!isInt(vv[j])) return 'vertices[' + i + '][' + j + ']：必须是整数';
      }
      if (vv[0] < -MAX_COORD || vv[0] > MAX_COORD) return 'vertices[' + i + '][0]：x 绝对值超过 ' + MAX_COORD;
      if (vv[1] < -MAX_COORD || vv[1] > MAX_COORD) return 'vertices[' + i + '][1]：y 绝对值超过 ' + MAX_COORD;
      if (vv[2] < 0 || vv[2] > MAX_Z) return 'vertices[' + i + '][2]：z 必须在 0..' + MAX_Z;
    }

    if (!Array.isArray(s.faces)) return 'faces：必须是数组';
    if (s.faces.length > MAX_FACES) return 'faces：数量超过上限 ' + MAX_FACES;
    var tw = s.texture[0] * 256, th = s.texture[1] * 256;
    for (i = 0; i < s.faces.length; i++) {
      var f = s.faces[i];
      if (typeof f !== 'object' || f === null || Array.isArray(f)) return 'faces[' + i + ']：必须是对象';
      if (!Array.isArray(f.v) || f.v.length !== 3) return 'faces[' + i + '].v：必须是含三个顶点下标的数组';
      for (j = 0; j < 3; j++) {
        if (!isInt(f.v[j]) || f.v[j] < 0 || f.v[j] >= s.vertices.length) {
          return 'faces[' + i + '].v[' + j + ']：顶点下标越界';
        }
      }
      if (!Array.isArray(f.uv) || f.uv.length !== 3) return 'faces[' + i + '].uv：必须是含三个 [u,v] 的数组';
      for (j = 0; j < 3; j++) {
        var uv = f.uv[j];
        if (!Array.isArray(uv) || uv.length !== 2) return 'faces[' + i + '].uv[' + j + ']：必须是 [u,v]';
        if (!isInt(uv[0]) || uv[0] < 0 || uv[0] > tw) return 'faces[' + i + '].uv[' + j + '][0]：u 超出 0..纹理宽*256';
        if (!isInt(uv[1]) || uv[1] < 0 || uv[1] > th) return 'faces[' + i + '].uv[' + j + '][1]：v 超出 0..纹理高*256';
      }
    }
    return null;
  }

  function validateStroke(st, maxPoints) {
    if (typeof st !== 'object' || st === null) return '笔画：必须是对象';
    if (!Array.isArray(st.points) || st.points.length < 1 || st.points.length > (maxPoints || 256)) {
      return '笔画 points：必须含 1..' + (maxPoints || 256) + ' 个点';
    }
    var i, p;
    for (i = 0; i < st.points.length; i++) {
      p = st.points[i];
      if (!Array.isArray(p) || p.length !== 2 || !isInt(p[0]) || !isInt(p[1])) {
        return 'points[' + i + ']：必须是两个整数 [x定点,y定点]';
      }
      if (Math.abs(p[0]) > MAX_COORD || Math.abs(p[1]) > MAX_COORD) return 'points[' + i + ']：坐标绝对值超过 ' + MAX_COORD;
    }
    if (!isInt(st.diameter) || st.diameter < 1 || st.diameter > 64) return 'diameter：必须是 1..64 的整数像素';
    if (!isInt(st.a) || st.a < 0 || st.a > 255) return 'a：必须是 0..255 的整数透明度';
    if (!Array.isArray(st.rgb) || st.rgb.length !== 3) return 'rgb：必须是含三个整数的数组';
    for (i = 0; i < 3; i++) {
      if (!isInt(st.rgb[i]) || st.rgb[i] < 0 || st.rgb[i] > 255) return 'rgb[' + i + ']：必须是 0..255 的整数';
    }
    return null;
  }

  /* ---------------- 定点工具 ---------------- */

  // 交互浮点（定点单位）换算为最近整数，半格取“较大值”（绝对值方向进位）
  function halfUp(r) {
    return r >= 0 ? Math.floor(r + 0.5) : -Math.floor(-r + 0.5);
  }

  // 叉积：边 (a->b) 与 (a->p)，坐标为整数；|值| <= 约 2e12，float64 可精确表示
  function cross(ax, ay, bx, by, px, py) {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  }

  // 三个边叉积同号（含 0）即点在三角形内（含边），任意绕序
  function insideFromSigns(c0, c1, c2) {
    return (c0 >= 0 && c1 >= 0 && c2 >= 0) || (c0 <= 0 && c1 <= 0 && c2 <= 0);
  }

  // 有理数比较 n1/d1 vs n2/d2（d 均为非零整数，以 float 精确整数传入），返回 -1/0/1
  function cmpRational(n1, d1, n2, d2) {
    var f1 = n1 / d1, f2 = n2 / d2;
    var tol = 1e-9 * Math.max(1, Math.abs(f1), Math.abs(f2));
    if (Math.abs(f1 - f2) > tol) return f1 < f2 ? -1 : 1;
    var L = BigInt(Math.trunc(n1)) * BigInt(Math.trunc(d2));
    var R = BigInt(Math.trunc(n2)) * BigInt(Math.trunc(d1));
    if (L < R) return -1;
    if (L > R) return 1;
    return 0;
  }

  /* ---------------- 模型构建 ---------------- */

  function createModel(scene) {
    var vw = scene.view[0], vh = scene.view[1];
    var tw = scene.texture[0], th = scene.texture[1];
    var nTex = tw * th, nf = scene.faces.length;

    // 每面拆成扁平表
    var sx0 = new Int32Array(nf), sy0 = new Int32Array(nf),
        sx1 = new Int32Array(nf), sy1 = new Int32Array(nf),
        sx2 = new Int32Array(nf), sy2 = new Int32Array(nf);
    var z0 = new Int32Array(nf), z1 = new Int32Array(nf), z2 = new Int32Array(nf);
    var u0 = new Int32Array(nf), v0 = new Int32Array(nf),
        u1 = new Int32Array(nf), v1 = new Int32Array(nf),
        u2 = new Int32Array(nf), v2 = new Int32Array(nf);
    var uvArea = new Float64Array(nf);   // UV 双倍面积（精确整数），0 = UV 退化
    var scrArea = new Float64Array(nf);  // 屏幕双倍面积（精确整数），0 = 投影退化

    var f, verts = scene.vertices;
    for (f = 0; f < nf; f++) {
      var face = scene.faces[f];
      var ia = face.v[0], ib = face.v[1], ic = face.v[2];
      sx0[f] = verts[ia][0]; sy0[f] = verts[ia][1]; z0[f] = verts[ia][2];
      sx1[f] = verts[ib][0]; sy1[f] = verts[ib][1]; z1[f] = verts[ib][2];
      sx2[f] = verts[ic][0]; sy2[f] = verts[ic][1]; z2[f] = verts[ic][2];
      u0[f] = face.uv[0][0]; v0[f] = face.uv[0][1];
      u1[f] = face.uv[1][0]; v1[f] = face.uv[1][1];
      u2[f] = face.uv[2][0]; v2[f] = face.uv[2][1];
      uvArea[f] = (u1[f] - u0[f]) * (v2[f] - v0[f]) - (u2[f] - u0[f]) * (v1[f] - v0[f]);
      scrArea[f] = (sx1[f] - sx0[f]) * (sy2[f] - sy0[f]) - (sx2[f] - sx0[f]) * (sy1[f] - sy0[f]);
    }

    // 纹素归属：按面号递增光栅化，已归属纹素直接跳过（小面号优先，含共边/重叠）
    var owner = new Int32Array(nTex).fill(-1);
    var ownN0 = new Float64Array(nTex); // 归属面 UV 重心分子（精确整数）
    var ownN1 = new Float64Array(nTex); // n2 = area - n0 - n1
    var projX = new Float64Array(nTex); // 投影回屏幕的定点坐标（浮点）
    var projY = new Float64Array(nTex);
    var inView = new Uint8Array(nTex);  // 投影点落在预览半开范围内

    var tx, ty;
    for (f = 0; f < nf; f++) {
      var area = uvArea[f];
      if (area === 0) continue; // UV 退化面不参与归属
      var minTx = Math.max(0, Math.floor(Math.min(u0[f], u1[f], u2[f]) / 256));
      var maxTx = Math.min(tw - 1, Math.floor(Math.max(u0[f], u1[f], u2[f]) / 256));
      var minTy = Math.max(0, Math.floor(Math.min(v0[f], v1[f], v2[f]) / 256));
      var maxTy = Math.min(th - 1, Math.floor(Math.max(v0[f], v1[f], v2[f]) / 256));
      var au0 = u0[f], av0 = v0[f], au1 = u1[f], av1 = v1[f], au2 = u2[f], av2 = v2[f];
      for (ty = minTy; ty <= maxTy; ty++) {
        var py = 256 * ty + 128;
        for (tx = minTx; tx <= maxTx; tx++) {
          var ti = ty * tw + tx;
          if (owner[ti] !== -1) continue; // 已被更小面号覆盖
          var pxU = 256 * tx + 128;
          var c0 = cross(au0, av0, au1, av1, pxU, py); // 边(0->1)叉积，对应顶点2权重
          var c1 = cross(au1, av1, au2, av2, pxU, py); // 边(1->2)叉积，对应顶点0权重
          var c2 = area - c0 - c1;                      // 边(2->0)叉积，对应顶点1权重
          if (!insideFromSigns(c0, c1, c2)) continue;
          owner[ti] = f;
          ownN0[ti] = c1; // 顶点0权重分子 = 边(1->2)叉积
          ownN1[ti] = c2; // 顶点1权重分子 = 边(2->0)叉积
          var n2v = c0;   // 顶点2权重分子 = 边(0->1)叉积
          var inv = 1 / area;
          projX[ti] = (c1 * sx0[f] + c2 * sx1[f] + c0 * sx2[f]) * inv;
          projY[ti] = (c1 * sy0[f] + c2 * sy1[f] + c0 * sy2[f]) * inv;
          var pxi = projX[ti], pyi = projY[ti];
          if (pxi >= 0 && pxi < 256 * vw && pyi >= 0 && pyi < 256 * vh) inView[ti] = 1;
        }
      }
    }

    // 屏幕分块：只收录非零投影面积的三角形
    var tilesX = Math.max(1, Math.ceil(vw / TILE)), tilesY = Math.max(1, Math.ceil(vh / TILE));
    var tileLists = new Array(tilesX * tilesY);
    for (f = 0; f < nf; f++) {
      if (scrArea[f] === 0) continue;
      var xMin = Math.max(0, Math.floor(Math.min(sx0[f], sx1[f], sx2[f]) / 256));
      var xMax = Math.min(vw - 1, Math.floor(Math.max(sx0[f], sx1[f], sx2[f]) / 256));
      var yMin = Math.max(0, Math.floor(Math.min(sy0[f], sy1[f], sy2[f]) / 256));
      var yMax = Math.min(vh - 1, Math.floor(Math.max(sy0[f], sy1[f], sy2[f]) / 256));
      if (xMin > xMax || yMin > yMax) continue;
      var cx0 = Math.floor(xMin / TILE), cx1 = Math.floor(xMax / TILE);
      var cy0 = Math.floor(yMin / TILE), cy1 = Math.floor(yMax / TILE);
      var cx, cy;
      for (cy = cy0; cy <= cy1; cy++) {
        for (cx = cx0; cx <= cx1; cx++) {
          var idx = cy * tilesX + cx;
          if (!tileLists[idx]) tileLists[idx] = [];
          tileLists[idx].push(f);
        }
      }
    }
    var tileData = new Array(tileLists.length);
    for (var t = 0; t < tileLists.length; t++) {
      tileData[t] = tileLists[t] ? Int32Array.from(tileLists[t]) : new Int32Array(0);
    }

    var model = {
      viewW: vw, viewH: vh, texW: tw, texH: th, nTex: nTex, nFaces: nf,
      sx0: sx0, sy0: sy0, sx1: sx1, sy1: sy1, sx2: sx2, sy2: sy2,
      z0: z0, z1: z1, z2: z2,
      u0: u0, v0: v0, u1: u1, v1: v1, u2: u2, v2: v2,
      uvArea: uvArea, scrArea: scrArea,
      owner: owner, ownN0: ownN0, ownN1: ownN1,
      projX: projX, projY: projY, inView: inView,
      tilesX: tilesX, tilesY: tilesY, tiles: tileData,
      _gen: new Int32Array(nTex), _strokeSeq: 0
    };
    return model;
  }

  /* ---------------- 可见性 ---------------- */

  // 取屏幕定点 (px,py) 处的最前深度。点须在预览半开范围内。
  // 返回 {face, n0, n1, area, depth} 或 null（无覆盖/出界）。
  function frontDepthAt(model, px, py) {
    if (px < 0 || px >= 256 * model.viewW || py < 0 || py >= 256 * model.viewH) return null;
    var pixX = Math.floor(px / 256), pixY = Math.floor(py / 256);
    var cx = Math.floor(pixX / TILE), cy = Math.floor(pixY / TILE);
    var list = model.tiles[cy * model.tilesX + cx];
    var best = null;
    for (var k = 0; k < list.length; k++) {
      var f = list[k];
      var a = model.scrArea[f];
      var c0 = cross(model.sx0[f], model.sy0[f], model.sx1[f], model.sy1[f], px, py); // 边(0->1) → 顶点2
      var c1 = cross(model.sx1[f], model.sy1[f], model.sx2[f], model.sy2[f], px, py); // 边(1->2) → 顶点0
      var c2 = a - c0 - c1;                                                           // 边(2->0) → 顶点1
      if (!insideFromSigns(c0, c1, c2)) continue;
      var n0v = c1, n1v = c2, n2v = c0;
      var num = n0v * model.z0[f] + n1v * model.z1[f] + n2v * model.z2[f];
      if (best === null || cmpRational(num, a, best.num, best.area) < 0) {
        best = { face: f, n0: n0v, n1: n1v, area: a, num: num, depth: num / a };
      }
      // 等深保留小面号：面号随数组递增，严格小于才替换
    }
    return best;
  }

  // 纹素归属面在其投影点处的深度有理数（屏幕重心；投影退化面返回 null）
  function ownerDepth(model, ti) {
    var f = model.owner[ti];
    if (f < 0 || model.scrArea[f] === 0) return null;
    var px = model.projX[ti], py = model.projY[ti];
    var a = model.scrArea[f];
    var c0 = cross(model.sx0[f], model.sy0[f], model.sx1[f], model.sy1[f], px, py);
    var c1 = cross(model.sx1[f], model.sy1[f], model.sx2[f], model.sy2[f], px, py);
    var c2 = a - c0 - c1;
    var n0v = c1, n1v = c2, n2v = c0;
    var num = n0v * model.z0[f] + n1v * model.z1[f] + n2v * model.z2[f];
    return { n0: n0v, n1: n1v, area: a, num: num, depth: num / a, face: f };
  }

  /* ---------------- 笔刷 ---------------- */

  function distToPolylineSq(px, py, points) {
    var best = Infinity;
    var i, dx, dy, d2;
    if (points.length === 1) {
      dx = px - points[0][0]; dy = py - points[0][1];
      return dx * dx + dy * dy;
    }
    for (i = 0; i < points.length - 1; i++) {
      var ax = points[i][0], ay = points[i][1];
      var bx = points[i + 1][0], by = points[i + 1][1];
      dx = bx - ax; dy = by - ay;
      var len2 = dx * dx + dy * dy;
      if (len2 === 0) {
        var ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        var t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        var qx = ax + t * dx, qy = ay + t * dy;
        var qdx = px - qx, qdy = py - qy;
        d2 = qdx * qdx + qdy * qdy;
      }
      if (d2 < best) best = d2;
    }
    return best;
  }

  // 在纹理上应用一笔，返回补丁（同时已写入 texture）。同一纹素一笔只混一次。
  function paintStroke(model, texture, stroke) {
    var err = validateStroke(stroke);
    if (err) throw new Error(err);
    model._strokeSeq++;
    var seq = model._strokeSeq;
    var radiusFixed = stroke.diameter * 128; // 半径 = 直径/2 像素 = 直径*128 定点
    var r2 = radiusFixed * radiusFixed;
    var a = stroke.a, br = stroke.rgb[0], bg = stroke.rgb[1], bb = stroke.rgb[2];
    var blendA = 255 - a;

    // 笔画屏幕包围盒（定点）
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var k;
    for (k = 0; k < stroke.points.length; k++) {
      var ppx = stroke.points[k][0], ppy = stroke.points[k][1];
      if (ppx < minX) minX = ppx; if (ppx > maxX) maxX = ppx;
      if (ppy < minY) minY = ppy; if (ppy > maxY) maxY = ppy;
    }
    minX -= radiusFixed; maxX += radiusFixed; minY -= radiusFixed; maxY += radiusFixed;

    var idx = [], old = [], neu = [];
    var nTex = model.nTex, tw = model.texW;
    for (var ti = 0; ti < nTex; ti++) {
      if (model.owner[ti] < 0 || !model.inView[ti]) continue;
      var x = model.projX[ti], y = model.projY[ti];
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (distToPolylineSq(x, y, stroke.points) > r2) continue;
      // 可见性：深度必须等于该投影点的最前深度（等深面均可）
      var front = frontDepthAt(model, x, y);
      if (!front) continue;
      var od = ownerDepth(model, ti);
      if (!od) continue;
      if (cmpRational(od.num, od.area, front.num, front.area) !== 0) continue;
      if (a === 0) continue; // 全透明笔不改变任何纹素，也不产生历史补丁
      if (model._gen[ti] === seq) continue; // 一笔经过同一纹素多次只混一次
      model._gen[ti] = seq;

      var off = ti * 3;
      idx.push(ti);
      old.push(texture[off], texture[off + 1], texture[off + 2]);
      if (a === 255) {
        texture[off] = br; texture[off + 1] = bg; texture[off + 2] = bb;
      } else {
        // 规格：floor(((255-a)*原值 + a*笔刷值 + 127)/255)
        texture[off] = Math.floor((blendA * texture[off] + a * br + 127) / 255);
        texture[off + 1] = Math.floor((blendA * texture[off + 1] + a * bg + 127) / 255);
        texture[off + 2] = Math.floor((blendA * texture[off + 2] + a * bb + 127) / 255);
      }
      neu.push(texture[off], texture[off + 1], texture[off + 2]);
    }
    return {
      indices: Uint32Array.from(idx),
      old: Uint8Array.from(old),
      neu: Uint8Array.from(neu),
      rgb: stroke.rgb.slice(),
      a: a,
      count: idx.length
    };
  }

  /* ---------------- 预览光栅化 ---------------- */

  function floorDivBig(a, b) { // BigInt 向下取整除法，b > 0
    var q = a / b;
    var r = a % b;
    if (r !== 0n && ((r < 0n) !== (b < 0n))) q -= 1n;
    return q;
  }

  function rationalFloor256(num, den) {
    // floor(num / (256*den))，num/den 为某轴的定点值；先浮点再对近整数做 BigInt 校正
    var val = num / den / 256;
    var fl = Math.floor(val);
    var diff = Math.abs(val - fl);
    if (diff < 1e-6) {
      var exact = Number(floorDivBig(BigInt(Math.trunc(num)), BigInt(256 * Math.trunc(den))));
      if (exact !== fl) return exact;
    }
    return fl;
  }

  // 按屏幕像素中心取样渲染预览，返回 RGBA ImageData 用 Uint8ClampedArray
  function renderPreview(model, texture) {
    var vw = model.viewW, vh = model.viewH, npix = vw * vh;
    var faceId = new Int32Array(npix).fill(-1);
    var pN0 = new Float64Array(npix), pN1 = new Float64Array(npix), pArea = new Float64Array(npix);
    var pNum = new Float64Array(npix); // 当前最前面的深度分子（与 pArea 配对做有理数比较）

    var f;
    for (f = 0; f < model.nFaces; f++) {
      var area = model.scrArea[f];
      if (area === 0) continue;
      var x0 = model.sx0[f], y0 = model.sy0[f], x1 = model.sx1[f], y1 = model.sy1[f],
          x2 = model.sx2[f], y2 = model.sy2[f];
      var pxMin = Math.max(0, Math.floor(Math.min(x0, x1, x2) / 256));
      var pxMax = Math.min(vw - 1, Math.floor(Math.max(x0, x1, x2) / 256));
      var pyMin = Math.max(0, Math.floor(Math.min(y0, y1, y2) / 256));
      var pyMax = Math.min(vh - 1, Math.floor(Math.max(y0, y1, y2) / 256));
      if (pxMin > pxMax || pyMin > pyMax) continue;
      var px, py;
      for (py = pyMin; py <= pyMax; py++) {
        var cy = 256 * py + 128;
        var rowBase = py * vw;
        for (px = pxMin; px <= pxMax; px++) {
          var cxp = 256 * px + 128;
          var c0 = cross(x0, y0, x1, y1, cxp, cy); // 边(0->1) → 顶点2
          var c1 = cross(x1, y1, x2, y2, cxp, cy); // 边(1->2) → 顶点0
          var c2 = area - c0 - c1;                  // 边(2->0) → 顶点1
          if (!insideFromSigns(c0, c1, c2)) continue;
          var n0v = c1, n1v = c2, n2v = c0;
          var num = n0v * model.z0[f] + n1v * model.z1[f] + n2v * model.z2[f];
          var pi = rowBase + px;
          if (faceId[pi] === -1 || cmpRational(num, area, pNum[pi], pArea[pi]) < 0) {
            faceId[pi] = f; pN0[pi] = n0v; pN1[pi] = n1v; pArea[pi] = area; pNum[pi] = num;
          }
          // 等深保留先写入的小面号
        }
      }
    }

    var out = new Uint8ClampedArray(npix * 4);
    var tw = model.texW, th = model.texH;
    for (var pi2 = 0; pi2 < npix; pi2++) {
      var ff2 = faceId[pi2];
      var o4 = pi2 * 4;
      if (ff2 === -1) {
        out[o4] = BG[0]; out[o4 + 1] = BG[1]; out[o4 + 2] = BG[2]; out[o4 + 3] = 255;
        continue;
      }
      var nn0 = pN0[pi2], nn1 = pN1[pi2], nn2 = pArea[pi2] - nn0 - nn1, aa2 = pArea[pi2];
      var uVal = nn0 * model.u0[ff2] + nn1 * model.u1[ff2] + nn2 * model.u2[ff2];
      var vVal = nn0 * model.v0[ff2] + nn1 * model.v1[ff2] + nn2 * model.v2[ff2];
      var texX = rationalFloor256(uVal, aa2);
      var texY = rationalFloor256(vVal, aa2);
      if (texX < 0) texX = 0; else if (texX > tw - 1) texX = tw - 1; // 恰在外边界取最后一个纹素
      if (texY < 0) texY = 0; else if (texY > th - 1) texY = th - 1;
      var tOff = (texY * tw + texX) * 3;
      out[o4] = texture[tOff]; out[o4 + 1] = texture[tOff + 1]; out[o4 + 2] = texture[tOff + 2];
      out[o4 + 3] = 255;
    }
    return { rgba: out, faceId: faceId };
  }

  /* ---------------- 纹素拾取 ---------------- */

  function pickTexel(model, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= model.texW || ty >= model.texH) return null;
    var ti = ty * model.texW + tx;
    var f = model.owner[ti];
    var res = { texelX: tx, texelY: ty, owner: f, inView: !!model.inView[ti] };
    if (f >= 0) {
      res.projX = model.projX[ti];
      res.projY = model.projY[ti];
      var area = model.uvArea[f];
      res.uvWeight = [model.ownN0[ti] / area, model.ownN1[ti] / area,
        (area - model.ownN0[ti] - model.ownN1[ti]) / area];
      if (model.inView[ti]) {
        res.front = frontDepthAt(model, model.projX[ti], model.projY[ti]);
      } else {
        res.front = null; // 投影点出界
      }
      if (model.scrArea[f] === 0) res.ownerDegenerate = true;
    }
    return res;
  }

  /* ---------------- PNG 编码（真彩 8 位 RGB，zlib stored block） ---------------- */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(buf) {
    var a = 1, b = 0;
    for (var i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }

  function chunk(type, data) {
    var len = u32be(data.length);
    var typeBytes = [];
    for (var i = 0; i < 4; i++) typeBytes.push(type.charCodeAt(i));
    var body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0);
    body.set(data, typeBytes.length);
    var crc = u32be(crc32(body));
    var out = new Uint8Array(len.length + body.length + 4);
    out.set(len, 0); out.set(body, 4); out.set(crc, 4 + body.length);
    return out;
  }

  // zlib 流：CMF/FLG + stored blocks + adler32
  function zlibStored(data) {
    var blocks = [];
    var totalLen = data.length;
    var off = 0;
    do {
      var n = Math.min(65535, totalLen - off);
      var last = (off + n === totalLen) ? 1 : 0;
      var head = new Uint8Array(5);
      head[0] = last;
      head[1] = n & 255; head[2] = (n >> 8) & 255;
      head[3] = (~n) & 255; head[4] = ((~n) >> 8) & 255;
      blocks.push(head);
      if (n > 0) blocks.push(data.subarray(off, off + n));
      off += n;
    } while (off < totalLen);
    var adler = u32be(adler32(data));
    var outLen = 2 + blocks.reduce(function (s, b) { return s + b.length; }, 0) + 4;
    var out = new Uint8Array(outLen);
    out[0] = 0x78; out[1] = 0x01;
    var pos = 2;
    blocks.forEach(function (b) { out.set(b, pos); pos += b.length; });
    out.set(adler, pos);
    return out;
  }

  function encodePng(rgb, w, h) {
    var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    var ihdr = new Uint8Array(13);
    var dims = u32be(w).concat(u32be(h));
    ihdr.set(dims, 0);
    ihdr[8] = 8;   // 位深
    ihdr[9] = 2;   // 真彩色 RGB
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    // 每行前置 filter 字节 0
    var raw = new Uint8Array((w * 3 + 1) * h);
    for (var y = 0; y < h; y++) {
      var rowStart = y * (w * 3 + 1);
      raw[rowStart] = 0;
      raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), rowStart + 1);
    }
    var idatData = zlibStored(raw);
    var parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', new Uint8Array(0))];
    var total = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var png = new Uint8Array(total);
    var pos = 0;
    parts.forEach(function (p) { png.set(p, pos); pos += p.length; });
    return png;
  }

  /* ---------------- 纹理 ImageData 适配 ---------------- */

  function textureToImageData(model, texture) {
    var n = model.nTex;
    var out = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      out[i * 4] = texture[i * 3];
      out[i * 4 + 1] = texture[i * 3 + 1];
      out[i * 4 + 2] = texture[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  function makeBaseTexture(scene) {
    var n = scene.texture[0] * scene.texture[1];
    var t = new Uint8ClampedArray(n * 3);
    for (var i = 0; i < n; i++) {
      t[i * 3] = scene.base[0]; t[i * 3 + 1] = scene.base[1]; t[i * 3 + 2] = scene.base[2];
    }
    return t;
  }

  var api = {
    BG: BG,
    validateScene: validateScene,
    validateStroke: validateStroke,
    halfUp: halfUp,
    cross: cross,
    insideFromSigns: insideFromSigns,
    cmpRational: cmpRational,
    createModel: createModel,
    frontDepthAt: frontDepthAt,
    ownerDepth: ownerDepth,
    distToPolylineSq: distToPolylineSq,
    paintStroke: paintStroke,
    renderPreview: renderPreview,
    pickTexel: pickTexel,
    encodePng: encodePng,
    crc32: crc32,
    adler32: adler32,
    textureToImageData: textureToImageData,
    makeBaseTexture: makeBaseTexture
  };
  root.SeamBrushCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
