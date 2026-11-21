/*
 * 冲印标记定位器 — 核心算法
 * ------------------------------------------------------------
 * 纯 JavaScript，无第三方依赖。浏览器挂到 window.MarkLocator，
 * Node 通过 module.exports 暴露，便于自动化测试。
 *
 * 约定（与样例数据一致）：
 *   - 8 位灰度 PGM（P5/P2），整数像素中心。
 *   - 姿态以锚点为原点：先水平镜像（可选），再缩放，最后在
 *     x 向右、y 向下的坐标系中顺时针旋转并平移。
 *   - 边缘 = Sobel 梯度强响应像素；单位法向指向亮侧。
 *   - 模板边点与场景边点配对：距离 ≤ 2.5 px 且法向夹角 ≤ 45°。
 *   - 覆盖率 = 配对成功边点数 / 全部模板边点数（含投出图像外的点）。
 *   - 结果按覆盖率降序、配对距离均值升序排列。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MarkLocator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAIR_DIST = 2.5;
  var PAIR_DIST2 = PAIR_DIST * PAIR_DIST;
  var PAIR_COS = Math.cos(45 * Math.PI / 180);
  var EPS = 1e-9;
  var NORMAL_BINS = 24; // 每 15° 一个法向区间

  /* ================================================================== *
   * PGM
   * ================================================================== */
  function parsePGM(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 3) throw new Error('文件为空或不是 PGM');
    var pos = 0;
    function skipSpace() {
      while (pos < bytes.length) {
        var c = bytes[pos];
        if (c === 35) {
          while (pos < bytes.length && bytes[pos] !== 10 && bytes[pos] !== 13) pos++;
        } else if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) {
          pos++;
        } else break;
      }
    }
    function token() {
      skipSpace();
      var start = pos;
      while (pos < bytes.length) {
        var c = bytes[pos];
        if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 35) break;
        pos++;
      }
      if (pos === start) throw new Error('PGM 头部不完整');
      var s = '';
      for (var i = start; i < pos; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    var magic = token();
    if (magic !== 'P5' && magic !== 'P2') {
      throw new Error('仅支持 8 位灰度 PGM（P5/P2），检测到 ' + magic);
    }
    var w = parseInt(token(), 10);
    var h = parseInt(token(), 10);
    var maxv = parseInt(token(), 10);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) throw new Error('PGM 尺寸无效');
    if (maxv !== 255) throw new Error('仅支持 8 位灰度（maxval=255），当前为 ' + maxv);
    if (w * h > 32 * 1024 * 1024) throw new Error('图像过大');
    var data = new Uint8Array(w * h);
    if (magic === 'P5') {
      if (pos < bytes.length && (bytes[pos] === 32 || bytes[pos] === 9 || bytes[pos] === 10 || bytes[pos] === 13)) pos++;
      if (bytes.length - pos < w * h) throw new Error('P5 像素数据不足：期望 ' + (w * h) + ' 字节');
      data.set(bytes.subarray(pos, pos + w * h));
    } else {
      for (var k = 0; k < w * h; k++) {
        var v = parseInt(token(), 10);
        if (!(v >= 0 && v <= 255)) throw new Error('P2 像素值超出 0..255');
        data[k] = v;
      }
    }
    return { width: w, height: h, data: data };
  }

  /* ================================================================== *
   * Sobel 方向边缘
   * ================================================================== */
  function sobelEdges(img, threshold) {
    var w = img.width, h = img.height, d = img.data;
    var thr = Number(threshold);
    if (!isFinite(thr)) thr = 0;
    if (w < 3 || h < 3) return makeEdgeSet(w, h, [], [], [], [], []);
    var ex = [], ey = [], enx = [], eny = [], emag = [];
    var W1 = w - 1, H1 = h - 1;
    for (var y = 0; y < h; y++) {
      var ym = y > 0 ? y - 1 : 0;
      var yp = y < H1 ? y + 1 : H1;
      var rowM = ym * w, row0 = y * w, rowP = yp * w;
      for (var x = 0; x < w; x++) {
        var xm = x > 0 ? x - 1 : 0;
        var xp = x < W1 ? x + 1 : W1;
        var tl = d[rowM + xm], tc = d[rowM + x], tr = d[rowM + xp];
        var ml = d[row0 + xm], mr = d[row0 + xp];
        var bl = d[rowP + xm], bc = d[rowP + x], br = d[rowP + xp];
        var gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        var gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        var mag = Math.sqrt(gx * gx + gy * gy);
        if (mag >= thr && mag > EPS) {
          ex.push(x); ey.push(y);
          enx.push(gx / mag); eny.push(gy / mag);
          emag.push(mag);
        }
      }
    }
    return makeEdgeSet(w, h, ex, ey, enx, eny, emag);
  }

  function makeEdgeSet(w, h, ex, ey, enx, eny, emag) {
    var n = ex.length;
    var E = {
      width: w, height: h, count: n,
      x: Float64Array.from(ex), y: Float64Array.from(ey),
      nx: Float64Array.from(enx), ny: Float64Array.from(eny),
      mag: Float64Array.from(emag)
    };
    // 空间网格：单元 2.5 px，查 3×3 单元即可覆盖整个配对半径
    var cell = PAIR_DIST;
    var cols = Math.max(1, Math.ceil(w / cell));
    var rows = Math.max(1, Math.ceil(h / cell));
    var buckets = new Array(cols * rows);
    for (var i = 0; i < n; i++) {
      var cx = Math.min(cols - 1, Math.max(0, Math.floor(ex[i] / cell)));
      var cy = Math.min(rows - 1, Math.max(0, Math.floor(ey[i] / cell)));
      var key = cy * cols + cx;
      (buckets[key] || (buckets[key] = [])).push(i);
    }
    E.grid = { cell: cell, cols: cols, rows: rows, buckets: buckets };
    return E;
  }

  // 模板轮廓包围盒对角线（用于按尺度设定去重半径）
  function templateExtent(tpl) {
    if (tpl.count === 0) return 1;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < tpl.count; i++) {
      if (tpl.x[i] < minX) minX = tpl.x[i];
      if (tpl.x[i] > maxX) maxX = tpl.x[i];
      if (tpl.y[i] < minY) minY = tpl.y[i];
      if (tpl.y[i] > maxY) maxY = tpl.y[i];
    }
    return Math.max(1, Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY)));
  }

  /*
   * 自动边缘强度：取模板边点梯度幅值的中位数乘以系数。
   * 现场的弱化边缘（低对比度夹具/杂块轮廓）会被挡在门外，
   * 而标记本身亮度与模板相近，强边得以保留。
   * 用中位数而非最大值，避免模板中个别超强边把阈值抬得过高。
   */
  function autoEdgeThreshold(templateImg) {
    var e = sobelEdges(templateImg, 0);
    if (e.count === 0) return 0;
    var mags = Array.from(e.mag).sort(function (a, b) { return a - b; });
    var median = mags[Math.floor(mags.length / 2)];
    return median * 0.72;
  }

  /* ================================================================== *
   * 几何与评分
   * ================================================================== */
  function mirroredOffset(tpl, anchorX, anchorY, mirror) {
    var n = tpl.count;
    var ux = new Float64Array(n), uy = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var dx = tpl.x[i] - anchorX;
      ux[i] = mirror ? -dx : dx;
      uy[i] = tpl.y[i] - anchorY;
    }
    return { ux: ux, uy: uy };
  }

  function transformNormals(tpl, mirror, cosT, sinT) {
    var n = tpl.count;
    var tx = new Float64Array(n), ty = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var nx = tpl.nx[i], ny = tpl.ny[i];
      if (mirror) nx = -nx;
      tx[i] = cosT * nx - sinT * ny;
      ty[i] = sinT * nx + cosT * ny;
    }
    return { tx: tx, ty: ty };
  }

  function projectOffsets(offsets, pose, out) {
    var n = offsets.ux.length;
    var c = Math.cos(pose.angle * Math.PI / 180);
    var s = Math.sin(pose.angle * Math.PI / 180);
    var sc = pose.scale;
    var qx = (out && out.qx) || new Float64Array(n);
    var qy = (out && out.qy) || new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var ux = offsets.ux[i], uy = offsets.uy[i];
      qx[i] = pose.x + sc * (c * ux - s * uy);
      qy[i] = pose.y + sc * (s * ux + c * uy);
    }
    return { qx: qx, qy: qy, cos: c, sin: s };
  }

  /*
   * 评估一个姿态：把模板边点投影到场景，逐点找满足
   * 「距离 ≤ 2.5 px 且法向夹角 ≤ 45°」的最近场景边点。
   * 投出图像外的模板点计入覆盖率分母但不计入配对。
   */
  function evaluatePose(pose, tpl, scene, opts) {
    opts = opts || {};
    var anchorX = opts.anchor ? opts.anchor[0] : 0;
    var anchorY = opts.anchor ? opts.anchor[1] : 0;
    var offs = opts._offsets || mirroredOffset(tpl, anchorX, anchorY, !!pose.mirror);
    var pr = projectOffsets(offs, pose);
    var normals = transformNormals(tpl, !!pose.mirror, pr.cos, pr.sin);
    var g = scene.grid, cell = g.cell, cols = g.cols, rows = g.rows;
    var sx = scene.x, sy = scene.y, snx = scene.nx, sny = scene.ny;
    var w = scene.width, h = scene.height;
    var n = tpl.count;
    var matched = 0, sumDist = 0;
    var keep = !!opts.keepPoints;
    var flags = keep ? new Uint8Array(n) : null;
    var pairIdx = keep ? new Int32Array(n).fill(-1) : null;
    var pairDist = keep ? new Float64Array(n) : null;
    var tx = normals.tx, ty = normals.ty;
    var qx = pr.qx, qy = pr.qy;
    for (var i = 0; i < n; i++) {
      var px = qx[i], py = qy[i];
      if (!(px >= 0 && px < w && py >= 0 && py < h)) continue;
      var ccx = Math.floor(px / cell), ccy = Math.floor(py / cell);
      var x0 = ccx > 0 ? ccx - 1 : 0, x1 = ccx + 1 < cols ? ccx + 1 : cols - 1;
      var y0 = ccy > 0 ? ccy - 1 : 0, y1 = ccy + 1 < rows ? ccy + 1 : rows - 1;
      var best = -1, bestD2 = PAIR_DIST2 + EPS;
      for (var cy = y0; cy <= y1; cy++) {
        var rowBase = cy * cols;
        for (var cx = x0; cx <= x1; cx++) {
          var bucket = g.buckets[rowBase + cx];
          if (bucket === undefined) continue;
          for (var k = 0; k < bucket.length; k++) {
            var j = bucket[k];
            var dx = sx[j] - px, dy = sy[j] - py;
            var d2 = dx * dx + dy * dy;
            if (d2 > bestD2) continue;
            if (tx[i] * snx[j] + ty[i] * sny[j] < PAIR_COS) continue;
            bestD2 = d2; best = j;
          }
        }
      }
      if (best >= 0) {
        matched++;
        sumDist += Math.sqrt(bestD2);
        if (flags) { flags[i] = 1; pairIdx[i] = best; pairDist[i] = Math.sqrt(bestD2); }
      }
    }
    return {
      coverage: n ? matched / n : 0,
      matched: matched,
      total: n,
      meanDist: matched ? sumDist / matched : Infinity,
      qx: qx, qy: qy,
      normals: normals,
      flags: flags, pairIdx: pairIdx, pairDist: pairDist
    };
  }

  /* ================================================================== *
   * 方向霍夫：候选姿态
   * ================================================================== */
  function normalBin(nx, ny) {
    var a = Math.atan2(ny, nx);
    if (a < 0) a += 2 * Math.PI;
    var b = Math.floor(a / (2 * Math.PI) * NORMAL_BINS);
    return b >= NORMAL_BINS ? NORMAL_BINS - 1 : b;
  }

  function buildAngleList(step) {
    var s = Math.max(0.5, Number(step) || 12);
    var list = [];
    for (var a = -180; a < 180 - 1e-9; a += s) list.push(Math.round(a * 1e6) / 1e6);
    return list;
  }

  function buildScaleList(minS, maxS, step) {
    var lo = Math.max(0.05, Number(minS) || 0.75);
    var hi = Math.max(lo, Number(maxS) || 1.4);
    var st = Math.max(0.01, Number(step) || 0.1);
    var list = [];
    var count = Math.floor((hi - lo) / st + 1e-7);
    for (var k = 0; k <= count; k++) list.push(Math.min(hi, lo + k * st));
    var last = list[list.length - 1];
    if (hi - last > Math.max(1e-6, st * 0.34)) list.push(hi);
    return list;
  }

  function sampleIndices(n, maxCount) {
    if (n <= maxCount) {
      var all = new Array(n);
      for (var i = 0; i < n; i++) all[i] = i;
      return all;
    }
    var out = new Array(maxCount);
    for (var k = 0; k < maxCount; k++) out[k] = Math.floor(k * (n - 1) / (maxCount - 1));
    return out;
  }

  function buildVotePlan(tpl, scene, opts) {
    var mirrorList = opts.mirror ? [false, true] : [false];
    var scales = buildScaleList(opts.minScale, opts.maxScale, opts.scaleStep);
    var angles = buildAngleList(opts.angleStep);
    var totalCombos = mirrorList.length * scales.length * angles.length;
    // 组合很多时降低投票点数，保持交互流畅
    var tplBudget = totalCombos > 1200 ? 300 : 420;
    var sceneBudget = totalCombos > 2400 ? 1200 : (totalCombos > 1200 ? 1700 : 2600);
    var tplVote = sampleIndices(tpl.count, Math.min(420, Math.max(80, tplBudget)));
    var sceneVote = sampleIndices(scene.count, Math.min(4000, Math.max(200, sceneBudget)));
    var sceneBins = new Array(NORMAL_BINS);
    for (var b = 0; b < NORMAL_BINS; b++) sceneBins[b] = [];
    for (var vi = 0; vi < sceneVote.length; vi++) {
      var j = sceneVote[vi];
      sceneBins[normalBin(scene.nx[j], scene.ny[j])].push(j);
    }
    var combos = [];
    for (var mi = 0; mi < mirrorList.length; mi++) {
      var mirror = mirrorList[mi];
      var tplOff = mirroredOffset(tpl, opts.anchor[0], opts.anchor[1], mirror);
      for (var si = 0; si < scales.length; si++) {
        for (var ai = 0; ai < angles.length; ai++) {
          combos.push({
            mirror: mirror, scale: scales[si], angle: angles[ai],
            ux: tplOff.ux, uy: tplOff.uy
          });
        }
      }
    }
    return {
      combos: combos, tplVote: tplVote, sceneBins: sceneBins,
      W: scene.width, H: scene.height, scene: scene
    };
  }

  // 对一个 (镜像, 尺度, 角度) 做平移投票，返回若干峰值
  function voteCombo(combo, plan, tpl, acc, touched, voteTol) {
    var tplVote = plan.tplVote, sceneBins = plan.sceneBins;
    var W = plan.W, H = plan.H, scene = plan.scene;
    var c = Math.cos(combo.angle * Math.PI / 180);
    var s = Math.sin(combo.angle * Math.PI / 180);
    var sc = combo.scale;
    var n = tpl.count;
    var offX = new Float64Array(n), offY = new Float64Array(n);
    var groups = new Array(NORMAL_BINS);
    for (var vi = 0; vi < tplVote.length; vi++) {
      var i = tplVote[vi];
      var ux = combo.ux[i], uy = combo.uy[i];
      offX[i] = sc * (c * ux - s * uy);
      offY[i] = sc * (s * ux + c * uy);
      var nx = tpl.nx[i], ny = tpl.ny[i];
      if (combo.mirror) nx = -nx;
      var b = normalBin(c * nx - s * ny, s * nx + c * ny);
      (groups[b] || (groups[b] = [])).push(i);
    }
    var touchedCount = 0, maxVotes = 0;
    for (var bi = 0; bi < NORMAL_BINS; bi++) {
      var bucket = sceneBins[bi];
      if (bucket.length === 0) continue;
      for (var db = -voteTol; db <= voteTol; db++) {
        var grp = groups[(bi + db + NORMAL_BINS) % NORMAL_BINS];
        if (grp === undefined) continue;
        for (var k = 0; k < bucket.length; k++) {
          var j = bucket[k];
          var qx = scene.x[j], qy = scene.y[j];
          for (var t = 0; t < grp.length; t++) {
            var ii = grp[t];
            var tx = Math.round(qx - offX[ii]);
            var ty = Math.round(qy - offY[ii]);
            if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
            var key = ty * W + tx;
            if (acc[key] === 0) touched[touchedCount++] = key;
            acc[key]++;
            if (acc[key] > maxVotes) maxVotes = acc[key];
          }
        }
      }
    }
    if (maxVotes === 0) return [];
    // 3×3 邻域求和，抑制单个格子的偶然堆积
    var cutoff = Math.max(2, Math.floor(maxVotes * 0.16));
    var scored = [];
    for (var q = 0; q < touchedCount; q++) {
      var kk = touched[q];
      var v = acc[kk];
      if (v < cutoff) continue;
      var x = kk % W, y = (kk - x) / W;
      var sum = v;
      var xa = x > 0 ? x - 1 : x, xb = x + 1 < W ? x + 1 : x;
      var ya = y > 0 ? y - 1 : y, yb = y + 1 < H ? y + 1 : y;
      for (var yy = ya; yy <= yb; yy++) {
        for (var xx = xa; xx <= xb; xx++) {
          if (xx === x && yy === y) continue;
          sum += acc[yy * W + xx];
        }
      }
      scored.push([sum, x, y]);
    }
    for (var q2 = 0; q2 < touchedCount; q2++) acc[touched[q2]] = 0;
    if (scored.length === 0) return [];
    scored.sort(function (a, b) { return b[0] - a[0]; });
    var peaks = [];
    for (var p = 0; p < scored.length && peaks.length < 3; p++) {
      var cand = scored[p];
      var ok = true;
      for (var pp = 0; pp < peaks.length; pp++) {
        var dx = peaks[pp][1] - cand[1], dy = peaks[pp][2] - cand[2];
        if (dx * dx + dy * dy <= 25) { ok = false; break; }
      }
      if (!ok) continue;
      if (peaks.length > 0 && cand[0] < peaks[0][0] * 0.3) break;
      peaks.push(cand);
    }
    return peaks;
  }

  /* ================================================================== *
   * 姿态细化：仅用已配对点做阻尼 Gauss-Newton
   * ================================================================== */
  function solve4(A, b) {
    var M = [A[0].slice(), A[1].slice(), A[2].slice(), A[3].slice()];
    var v = b.slice();
    for (var col = 0; col < 4; col++) {
      var piv = col;
      for (var r = col + 1; r < 4; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      if (piv !== col) {
        var tmp = M[piv]; M[piv] = M[col]; M[col] = tmp;
        var tv = v[piv]; v[piv] = v[col]; v[col] = tv;
      }
      var d = M[col][col];
      for (var r2 = col + 1; r2 < 4; r2++) {
        var f = M[r2][col] / d;
        if (f === 0) continue;
        for (var k = col; k < 4; k++) M[r2][k] -= f * M[col][k];
        v[r2] -= f * v[col];
      }
    }
    var x = new Array(4);
    for (var r3 = 3; r3 >= 0; r3--) {
      var sum = v[r3];
      for (var k2 = r3 + 1; k2 < 4; k2++) sum -= M[r3][k2] * x[k2];
      x[r3] = sum / M[r3][r3];
    }
    return x;
  }

  /*
   * 覆盖率是整数计数比，遮挡时会在一个连通平台上来回跳，
   * 单点差异 (<1%) 不足以说明谁更好；平台内改看连续的均距。
   * tol 之外的覆盖率差仍然优先。
   */
  function isBetterResult(a, b, tol) {
    if (!b) return true;
    var t = tol == null ? 0.008 : tol;
    if (a.coverage > b.coverage + t) return true;
    if (a.coverage < b.coverage - t) return false;
    return a.meanDist < b.meanDist - 1e-9;
  }

  function refinePose(startPose, tpl, scene, opts) {
    var anchor = opts.anchor;
    var loS = opts.scaleBounds ? opts.scaleBounds[0] : 0.05;
    var hiS = opts.scaleBounds ? opts.scaleBounds[1] : 8;
    var p = {
      x: startPose.x, y: startPose.y, angle: startPose.angle,
      scale: startPose.scale, mirror: !!startPose.mirror
    };
    var offs = mirroredOffset(tpl, anchor[0], anchor[1], p.mirror);
    function evalAt(pp) {
      return evaluatePose(pp, tpl, scene, { anchor: anchor, _offsets: offs });
    }
    var bestEval = evalAt(p);
    var bestPose = { x: p.x, y: p.y, angle: p.angle, scale: p.scale, mirror: p.mirror };
    for (var iter = 0; iter < 24; iter++) {
      var ev = evaluatePose(p, tpl, scene, { anchor: anchor, _offsets: offs, keepPoints: true });
      if (ev.matched < 8) break;
      var c = Math.cos(p.angle * Math.PI / 180);
      var s = Math.sin(p.angle * Math.PI / 180);
      var A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      var rhs = [0, 0, 0, 0];
      var used = 0;
      for (var i = 0; i < tpl.count; i++) {
        if (!ev.flags[i]) continue;
        var ux = offs.ux[i], uy = offs.uy[i];
        var rx = scene.x[ev.pairIdx[i]] - ev.qx[i];
        var ry = scene.y[ev.pairIdx[i]] - ev.qy[i];
        var wgt = 1 / (0.6 + ev.pairDist[i]); // 远配对更可能是遮挡/误配，降权
        var Jx = [1, 0, p.scale * (-s * ux - c * uy), c * ux - s * uy];
        var Jy = [0, 1, p.scale * (c * ux - s * uy), s * ux + c * uy];
        for (var a = 0; a < 4; a++) {
          rhs[a] += wgt * (Jx[a] * rx + Jy[a] * ry);
          for (var bb = 0; bb < 4; bb++) A[a][bb] += wgt * (Jx[a] * Jx[bb] + Jy[a] * Jy[bb]);
        }
        used++;
      }
      if (used < 8) break;
      for (var dgl = 0; dgl < 4; dgl++) A[dgl][dgl] += 1e-6 * used;
      var delta = solve4(A, rhs);
      if (!delta || !isFinite(delta[0]) || !isFinite(delta[1]) || !isFinite(delta[2]) || !isFinite(delta[3])) break;
      var dX = clamp(delta[0], -1.5, 1.5);
      var dY = clamp(delta[1], -1.5, 1.5);
      var dA = clamp(delta[2] * 180 / Math.PI, -6, 6);
      var dS = clamp(delta[3], -0.04, 0.04);
      p.x += dX; p.y += dY; p.angle = normalizeAngle(p.angle + dA); p.scale += dS;
      if (p.scale < loS) p.scale = loS;
      if (p.scale > hiS) p.scale = hiS;
      var ev2 = evalAt(p);
      if (isBetterResult(ev2, bestEval)) {
        bestEval = ev2;
        bestPose = { x: p.x, y: p.y, angle: p.angle, scale: p.scale, mirror: p.mirror };
      }
      if (Math.abs(dX) < 2e-3 && Math.abs(dY) < 2e-3 && Math.abs(dA) < 2e-2 && Math.abs(dS) < 2e-4) break;
    }
    return { pose: bestPose, eval: bestEval };
  }

  /* ================================================================== *
   * 排序与去重
   * ================================================================== */
  function angularDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // 同一姿态的近邻候选
  function samePose(a, b, opts, extent) {
    var sRef = Math.max(a.scale, b.scale);
    var distT = Math.max(2.5, 0.12 * extent * sRef);
    var dx = a.x - b.x, dy = a.y - b.y;
    if (dx * dx + dy * dy > distT * distT) return false;
    if (!!a.mirror !== !!b.mirror) return false;
    if (angularDiff(a.angle, b.angle) > Math.max(6, (opts.angleStep || 12) * 0.6)) return false;
    return Math.abs(a.scale - b.scale) <= Math.max(0.05, (opts.scaleStep || 0.1) * 0.6);
  }

  // 同一物理位置的不同解释（包括镜像孪生）：只保留排序靠前的一个
  function sameLocation(a, b, extent) {
    var sRef = Math.max(a.scale, b.scale);
    var r = Math.max(3, 0.16 * extent * sRef);
    var dx = a.x - b.x, dy = a.y - b.y;
    if (dx * dx + dy * dy > r * r) return false;
    return Math.abs(a.scale - b.scale) <= Math.max(0.08, 0.18 * sRef);
  }

  function sortResults(list) {
    list.sort(function (a, b) {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (a.meanDist !== b.meanDist) return a.meanDist - b.meanDist;
      return a.x - b.x;
    });
    return list;
  }

  // 输入须已排序。近邻同姿态只报一次；同位置的镜像/角度孪生只留最优。
  // 条目可以是扁平姿态，也可以是 {pose, coverage, meanDist}。
  function poseOf(item) {
    return item && item.pose ? item.pose : item;
  }

  /*
   * 两个姿态若映射到同一批场景边点，就是同一个标记的不同解释。
   * 用「配对的场景边点索引集合」的交并比来度量：强者先入，
   * 后来者与已保留项的集合重合超过阈值就丢弃。
   * 这比单纯的距离去重更能处理镜像孪生与角度歧义，
   * 又不会把两个真实相邻标记合并（它们配对的是不同边点）。
   */
  function evidenceOverlap(setA, setB) {
    if (!setA || !setB) return 0;
    var small = setA.size <= setB.size ? setA : setB;
    var large = small === setA ? setB : setA;
    if (small.size === 0) return 0;
    var inter = 0;
    small.forEach(function (v) { if (large.has(v)) inter++; });
    return inter / small.size;
  }

  function dedupe(list, opts, extent, pairSets) {
    var kept = [];
    var keptSets = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var p = poseOf(item);
      var dup = false;
      for (var k = 0; k < kept.length; k++) {
        var q = poseOf(kept[k]);
        if (samePose(p, q, opts, extent) || sameLocation(p, q, extent)) { dup = true; break; }
        if (pairSets && evidenceOverlap(pairSets[i], keptSets[k]) >= 0.5) { dup = true; break; }
      }
      if (!dup) { kept.push(item); keptSets.push(pairSets ? pairSets[i] : null); }
    }
    return kept;
  }

  /* ================================================================== *
   * 主流程
   * ================================================================== */
  async function locate(templateImg, sceneImg, params, hooks) {
    hooks = hooks || {};
    var onProgress = hooks.onProgress || function () {};
    var shouldCancel = hooks.shouldCancel || function () { return false; };
    var yieldFn = hooks.yieldFn || function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    var t0 = now();

    var anchor = [Number(params.anchor[0]), Number(params.anchor[1])];
    if (!isFinite(anchor[0]) || !isFinite(anchor[1])) throw new Error('锚点坐标无效');
    var minScale = Number(params.minScale);
    var maxScale = Number(params.maxScale);
    if (!(minScale > 0) || !(maxScale >= minScale)) throw new Error('尺度范围无效');
    var angleStep = Number(params.angleStep);
    if (!(angleStep > 0)) throw new Error('角度步长无效');
    var scaleStep = Number(params.scaleStep);
    if (!(scaleStep > 0)) throw new Error('尺度步长无效');
    var minCoverage = Number(params.minCoverage);
    if (!(minCoverage >= 0 && minCoverage <= 1)) throw new Error('最低覆盖率需在 0..1 之间');
    var edgeThreshold;
    if (params.edgeThreshold === 'auto' || params.edgeThreshold == null) {
      edgeThreshold = autoEdgeThreshold(templateImg);
    } else {
      edgeThreshold = Number(params.edgeThreshold);
    }
    if (!isFinite(edgeThreshold) || edgeThreshold < 0) throw new Error('边缘强度无效');

    onProgress({ phase: 'edges', pct: 0.02, text: '提取方向边缘' });
    var tpl = sobelEdges(templateImg, edgeThreshold);
    if (tpl.count < 6) {
      throw new Error('模板在该边缘强度下可用边点太少（' + tpl.count + '），请降低边缘强度');
    }
    var scene = sobelEdges(sceneImg, edgeThreshold);
    var extent = templateExtent(tpl);
    if (scene.count < 6) {
      onProgress({ phase: 'done', pct: 1, text: '场景中没有可用边缘' });
      return {
        poses: [],
        stats: { templateEdges: tpl.count, sceneEdges: scene.count, candidates: 0, refined: 0, elapsedMs: 0, edgeThreshold: edgeThreshold },
        tpl: tpl, scene: scene
      };
    }
    if (shouldCancel()) throw cancelError();
    await yieldFn();
    onProgress({ phase: 'edges', pct: 0.05, text: '边缘：模板 ' + tpl.count + ' 点 / 场景 ' + scene.count + ' 点' });

    var opts = {
      anchor: anchor, minScale: minScale, maxScale: maxScale, scaleStep: scaleStep,
      angleStep: angleStep, mirror: !!params.mirrorSearch, minCoverage: minCoverage
    };
    var plan = buildVotePlan(tpl, scene, opts);
    var W = plan.W, H = plan.H;
    var acc = new Int32Array(W * H);
    var touched = new Int32Array(Math.max(1024, W * H)); // 不同格数不会超过像素数
    var combos = plan.combos;
    var candidates = [];
    var lastYield = now();
    // 组合数量很大时，只对靠前的峰值做评分，控制总耗时
    var candBudget = 16000;
    onProgress({ phase: 'vote', pct: 0.08, text: '方向霍夫投票', done: 0, total: combos.length });

    for (var ci = 0; ci < combos.length; ci++) {
      var combo = combos[ci];
      var peaks = voteCombo(combo, plan, tpl, acc, touched, 1);
      for (var pi = 0; pi < peaks.length && candidates.length < candBudget; pi++) {
        var pk = peaks[pi];
        candidates.push({ x: pk[1], y: pk[2], angle: combo.angle, scale: combo.scale, mirror: combo.mirror });
      }
      if (shouldCancel()) throw cancelError();
      if ((ci & 3) === 3) {
        onProgress({ phase: 'vote', pct: 0.08 + 0.42 * (ci + 1) / combos.length, text: '方向霍夫投票', done: ci + 1, total: combos.length });
        if (now() - lastYield > 26) { await yieldFn(); lastYield = now(); }
      }
    }
    onProgress({ phase: 'vote', pct: 0.5, text: '候选投票完成', done: combos.length, total: combos.length, candidates: candidates.length });

    // ---- 精确评分 ----
    var scored = [];
    var batch = Math.max(16, Math.ceil(candidates.length / 24));
    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      var ev = evaluatePose(cand, tpl, scene, { anchor: anchor });
      scored.push({
        pose: { x: cand.x, y: cand.y, angle: cand.angle, scale: cand.scale, mirror: cand.mirror },
        coverage: ev.coverage, meanDist: ev.meanDist, matched: ev.matched, total: ev.total
      });
      if (i % batch === batch - 1) {
        onProgress({ phase: 'score', pct: 0.5 + 0.2 * (i + 1) / candidates.length, text: '模板边点精配', done: i + 1, total: candidates.length });
        if (shouldCancel()) throw cancelError();
        if (now() - lastYield > 26) { await yieldFn(); lastYield = now(); }
      }
    }
    sortResults(scored);

    // ---- 每个位置最多保留 3 个不同解释，交给细化甄别 ----
    var refineThreshold = Math.max(0.15, Math.min(minCoverage * 0.7, minCoverage - 0.08));
    var groups = [];
    for (var si = 0; si < scored.length && groups.length < 60; si++) {
      var sp = scored[si];
      if (sp.coverage < refineThreshold) break;
      var placed = false;
      for (var gi = 0; gi < groups.length; gi++) {
        var g0 = groups[gi];
        var gdx = g0.x - sp.pose.x, gdy = g0.y - sp.pose.y;
        var rr = Math.max(3.5, 0.14 * extent * Math.max(g0.scale, sp.pose.scale));
        if (gdx * gdx + gdy * gdy <= rr * rr) {
          if (g0.items.length < 3) g0.items.push(sp);
          g0.x = (g0.x * g0.n + sp.pose.x) / (g0.n + 1);
          g0.y = (g0.y * g0.n + sp.pose.y) / (g0.n + 1);
          g0.n++;
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push({ x: sp.pose.x, y: sp.pose.y, n: 1, scale: sp.pose.scale, items: [sp] });
      }
    }
    var refineList = [];
    for (var gi2 = 0; gi2 < groups.length; gi2++) {
      for (var ii = 0; ii < groups[gi2].items.length; ii++) refineList.push(groups[gi2].items[ii]);
    }
    sortResults(refineList);
    if (refineList.length > 84) refineList = refineList.slice(0, 84);

    // ---- 姿态细化 ----
    var refined = [];
    var scaleLo = Math.max(0.05, minScale * 0.9);
    var scaleHi = maxScale * 1.1;
    for (var ri = 0; ri < refineList.length; ri++) {
      if (shouldCancel()) throw cancelError();
      var r = refinePose(refineList[ri].pose, tpl, scene, { anchor: anchor, scaleBounds: [scaleLo, scaleHi] });
      refined.push({
        pose: r.pose, coverage: r.eval.coverage, meanDist: r.eval.meanDist,
        matched: r.eval.matched, total: r.eval.total
      });
      if (ri % 4 === 3) {
        onProgress({ phase: 'refine', pct: 0.7 + 0.25 * (ri + 1) / refineList.length, text: '姿态细化', done: ri + 1, total: refineList.length });
        if (now() - lastYield > 26) { await yieldFn(); lastYield = now(); }
      }
    }

    // ---- 过滤、排序、去重 ----
    onProgress({ phase: 'dedupe', pct: 0.97, text: '近邻去重' });
    sortResults(refined);
    var passed = [];
    for (var pj = 0; pj < refined.length; pj++) {
      if (refined[pj].coverage >= minCoverage - 1e-9) passed.push(refined[pj]);
    }
    // 为通过者收集配对到的场景边点集合，供证据重叠去重
    var pairSets = passed.map(function (item) {
      var ev = evaluatePose(item.pose, tpl, scene, { anchor: anchor, keepPoints: true });
      var set = new Set();
      for (var i = 0; i < tpl.count; i++) if (ev.flags[i]) set.add(ev.pairIdx[i]);
      item.eval = ev;
      return set;
    });
    var deduped = dedupe(passed, opts, extent, pairSets);

    var poses = deduped.map(function (p, idx) {
      return {
        rank: idx + 1,
        x: round(p.pose.x, 4),
        y: round(p.pose.y, 4),
        angle: round(normalizeAngle(p.pose.angle), 3),
        scale: round(p.pose.scale, 4),
        mirror: !!p.pose.mirror,
        coverage: round(p.coverage, 6),
        meanDistance: round(p.meanDist, 6),
        matched: p.matched,
        total: p.total
      };
    });
    onProgress({ phase: 'done', pct: 1, text: '完成' });
    return {
      poses: poses,
      stats: {
        templateEdges: tpl.count,
        sceneEdges: scene.count,
        candidates: candidates.length,
        refined: refineList.length,
        elapsedMs: Math.round(now() - t0),
        edgeThreshold: round(edgeThreshold, 2)
      },
      tpl: tpl, scene: scene
    };
  }

  /* ================================================================== *
   * 工具
   * ================================================================== */
  function normalizeAngle(a) {
    a = a % 360;
    if (a >= 180) a -= 360;
    if (a < -180) a += 360;
    return a;
  }
  function round(v, nd) {
    var f = Math.pow(10, nd);
    return Math.round(v * f) / f;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function cancelError() {
    var e = new Error('已取消');
    e.cancelled = true;
    return e;
  }

  return {
    parsePGM: parsePGM,
    sobelEdges: sobelEdges,
    evaluatePose: evaluatePose,
    locate: locate,
    refinePose: refinePose,
    dedupe: dedupe,
    sortResults: sortResults,
    templateExtent: templateExtent,
    autoEdgeThreshold: autoEdgeThreshold,
    buildAngleList: buildAngleList,
    buildScaleList: buildScaleList,
    normalizeAngle: normalizeAngle,
    PAIR_DIST: PAIR_DIST,
    PAIR_ANGLE: 45,
    _internal: {
      mirroredOffset: mirroredOffset,
      projectOffsets: projectOffsets,
      samePose: samePose,
      sameLocation: sameLocation,
      buildVotePlan: buildVotePlan,
      voteCombo: voteCombo,
      normalBin: normalBin
    }
  };
});
