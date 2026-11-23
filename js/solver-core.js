/*
 * solver-core.js — 法线贴图高度恢复的纯求解核心（无 DOM / 无 Worker 依赖）。
 *
 * 模型：每条有效边 (a -> b, 方向恒为 +x / +y，含周期边) 给出约束
 *     h_b - h_a = g,   权重 w
 * 其中
 *     水平边  g = -mean(nx/nz)_两端 * dx,  垂直边  g = -mean(ny/nz)_两端 * dy
 *     w = min(confidence_a, confidence_b)
 * 只保留 w > 0 的边；孔（null）与零置信度端不产生约束。
 *
 * 目标函数  sum_edges w * (h_b - h_a - g)^2  的带锁点最小二乘解，
 * 用带锁点的法方程 + Jacobi 预处理共轭梯度（PCG）求解。
 *
 * UMD：浏览器 <script> 挂到 window.NormalRelief；Node 走 module.exports；
 * Worker 内 importScripts 后同样可用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    module.exports.__factory__ = factory; // 供 Blob Worker 序列化
  } else {
    root.NormalRelief = factory();
    root.NormalRelief.__factory__ = factory;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ABS_PIN_MAX = 10000;
  var RESIDUAL_TOL = 1e-7; // 未锁格 |有向加权残差和 / 权重和| 的验收上限

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function isFiniteNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* ------------------------------------------------------------------ *
   * 1. 输入校验。返回 { ok:true, data } 或 { ok:false, errors:[...] }
   * ------------------------------------------------------------------ */
  function validateInput(input) {
    var errors = [];
    if (!input || typeof input !== 'object') {
      return { ok: false, errors: ['输入必须是 JSON 对象'] };
    }

    var width = input.width;
    var height = input.height;
    if (!Number.isInteger(width) || width < 1) errors.push('width 必须是正整数');
    if (!Number.isInteger(height) || height < 1) errors.push('height 必须是正整数');
    var dimsOk = errors.length === 0;
    var n = dimsOk ? width * height : 0;

    var spacing = input.spacing;
    var dx = null, dy = null;
    if (!Array.isArray(spacing) || spacing.length !== 2 ||
        !isFiniteNum(spacing[0]) || !isFiniteNum(spacing[1])) {
      errors.push('spacing 必须是两个数 [dx, dy]');
    } else {
      dx = spacing[0];
      dy = spacing[1];
      if (!(dx >= 0.25 && dx <= 4)) errors.push('dx 必须在 0.25 到 4 之间');
      if (!(dy >= 0.25 && dy <= 4)) errors.push('dy 必须在 0.25 到 4 之间');
    }

    var wrap = input.wrap;
    var wrapX = false, wrapY = false;
    if (!Array.isArray(wrap) || wrap.length !== 2 ||
        typeof wrap[0] !== 'boolean' || typeof wrap[1] !== 'boolean') {
      errors.push('wrap 必须是两个布尔值 [wrapX, wrapY]');
    } else {
      wrapX = wrap[0];
      wrapY = wrap[1];
      if (dimsOk && wrapX && width < 3) errors.push('横向周期轴至少需要 3 格');
      if (dimsOk && wrapY && height < 3) errors.push('纵向周期轴至少需要 3 格');
    }

    var samples = input.samples;
    if (!Array.isArray(samples)) {
      errors.push('samples 必须是数组');
    } else if (dimsOk && samples.length !== n) {
      errors.push('samples 长度应为 width*height = ' + n + '，实际 ' + samples.length);
    }

    var validCell = new Uint8Array(dimsOk ? n : 0);
    var conf = new Uint8Array(dimsOk ? n : 0);
    var nx = new Float64Array(dimsOk ? n : 0);
    var ny = new Float64Array(dimsOk ? n : 0);
    var nz = new Float64Array(dimsOk ? n : 0);

    if (Array.isArray(samples) && dimsOk) {
      for (var i = 0; i < n; i++) {
        var s = samples[i];
        if (s === null || s === undefined) continue; // 孔
        if (!Array.isArray(s) || s.length !== 4) {
          errors.push('格 ' + i + '：样本必须是 [nx, ny, nz, 置信度] 或 null');
          continue;
        }
        var vx = s[0], vy = s[1], vz = s[2], c = s[3];
        if (!isFiniteNum(vx) || !isFiniteNum(vy) || !isFiniteNum(vz)) {
          errors.push('格 ' + i + '：法线分量必须是有限数');
          continue;
        }
        if (Math.abs(vx) > 1) errors.push('格 ' + i + '：nx 绝对值至多 1');
        if (Math.abs(vy) > 1) errors.push('格 ' + i + '：ny 绝对值至多 1');
        if (!(vz >= 0.25 && vz <= 1)) errors.push('格 ' + i + '：nz 必须在 0.25 到 1 之间');
        if (!Number.isInteger(c) || c < 0 || c > 16) {
          errors.push('格 ' + i + '：置信度必须是 0 到 16 的整数');
          continue;
        }
        validCell[i] = 1;
        nx[i] = vx; ny[i] = vy; nz[i] = vz; conf[i] = c;
      }
    }

    var pins = input.pins;
    var pinOut = [];
    if (pins === undefined || pins === null) {
      pins = [];
    } else if (!Array.isArray(pins)) {
      errors.push('pins 必须是数组');
    } else {
      var seenPin = new Set();
      for (var p = 0; p < pins.length; p++) {
        var pin = pins[p];
        if (!Array.isArray(pin) || pin.length !== 2 ||
            !Number.isInteger(pin[0]) || !isFiniteNum(pin[1])) {
          errors.push('锁点 #' + p + '：必须是 [格号, 高度]');
          continue;
        }
        var id = pin[0], h = pin[1];
        if (!dimsOk || id < 0 || id >= n) {
          errors.push('锁点格号 ' + id + ' 越界（有效范围 0..' + (n - 1) + '）');
          continue;
        }
        if (!validCell[id]) {
          errors.push('非法锁点：格号 ' + id + ' 是孔，不能锁定');
          continue;
        }
        if (seenPin.has(id)) {
          errors.push('非法锁点：格号 ' + id + ' 重复锁定');
          continue;
        }
        if (Math.abs(h) > ABS_PIN_MAX) {
          errors.push('非法锁点：格号 ' + id + ' 的高度 ' + h + ' 绝对值超过 ' + ABS_PIN_MAX);
          continue;
        }
        seenPin.add(id);
        pinOut.push([id, h]);
      }
    }

    if (!errors.length) {
      return {
        ok: true,
        data: {
          width: width, height: height, n: n,
          dx: dx, dy: dy, wrapX: wrapX, wrapY: wrapY,
          validCell: validCell, conf: conf, nx: nx, ny: ny, nz: nz,
          pins: pinOut
        }
      };
    }
    return { ok: false, errors: errors };
  }

  /* ------------------------------------------------------------------ *
   * 2. 并查集（只对非孔格）
   * ------------------------------------------------------------------ */
  function UnionFind(n) {
    this.parent = new Int32Array(n);
    for (var i = 0; i < n; i++) this.parent[i] = i;
  }
  UnionFind.prototype.find = function (x) {
    var p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  };
  UnionFind.prototype.union = function (a, b) {
    var ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  };

  /* ------------------------------------------------------------------ *
   * 3. 建边 + 连通块 + 锁点方案。
   *    边方向恒为起点 -> 终点（右/下，周期边同样沿正方向）。
   * ------------------------------------------------------------------ */
  function buildModel(data) {
    var t0 = nowMs();
    var W = data.width, H = data.height, n = data.n;
    var valid = data.validCell, conf = data.conf;
    var nx = data.nx, ny = data.ny, nz = data.nz;
    var dx = data.dx, dy = data.dy;

    // 边数组（先全部水平边再全部垂直边，每段按格号升序）
    var ea = [], eb = [], ew = [], eg = [], eAxis = [], eWrap = [];

    function addEdge(a, b, axis, isWrap) {
      var w = conf[a] < conf[b] ? conf[a] : conf[b];
      if (w <= 0) return;
      var g;
      if (axis === 0) { // 水平
        g = -0.5 * (nx[a] / nz[a] + nx[b] / nz[b]) * dx;
      } else { // 垂直
        g = -0.5 * (ny[a] / nz[a] + ny[b] / nz[b]) * dy;
      }
      ea.push(a); eb.push(b); ew.push(w); eg.push(g);
      eAxis.push(axis); eWrap.push(isWrap ? 1 : 0);
    }

    var x, y, a, b, i, r;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        a = y * W + x;
        if (!valid[a]) continue;
        if (x + 1 < W) {
          b = y * W + (x + 1);
          if (valid[b]) addEdge(a, b, 0, false);
        } else if (data.wrapX && W >= 3) {
          b = y * W + 0;
          if (valid[b]) addEdge(a, b, 0, true);
        }
      }
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        a = y * W + x;
        if (!valid[a]) continue;
        if (y + 1 < H) {
          b = (y + 1) * W + x;
          if (valid[b]) addEdge(a, b, 1, false);
        } else if (data.wrapY && H >= 3) {
          b = 0 * W + x;
          if (valid[b]) addEdge(a, b, 1, true);
        }
      }
    }

    var m = ea.length;
    var edgeA = new Int32Array(ea);
    var edgeB = new Int32Array(eb);
    var edgeW = new Float64Array(ew);
    var edgeG = new Float64Array(eg);
    var edgeAxis = new Uint8Array(eAxis);
    var edgeWrap = new Uint8Array(eWrap);

    // 连通块
    var uf = new UnionFind(n);
    for (var e = 0; e < m; e++) uf.union(edgeA[e], edgeB[e]);

    var compRoot = new Int32Array(n);
    for (i = 0; i < n; i++) {
      if (!valid[i]) { compRoot[i] = -1; continue; }
      compRoot[i] = uf.find(i);
    }

    // 每个连通块的最小编号格
    var compMin = new Int32Array(n);
    var compHasPin = new Uint8Array(n);
    var seen = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (!valid[i]) continue;
      r = compRoot[i];
      if (!seen[r]) { seen[r] = 1; compMin[r] = i; }
      else if (i < compMin[r]) compMin[r] = i;
    }

    // 用户锁点
    var pinHeight = new Float64Array(n);
    var pinKind = new Uint8Array(n); // 0 无, 1 用户, 2 自动
    var userPins = [];
    for (var k = 0; k < data.pins.length; k++) {
      var id2 = data.pins[k][0];
      pinHeight[id2] = data.pins[k][1];
      pinKind[id2] = 1;
      compHasPin[compRoot[id2]] = 1;
      userPins.push(id2);
    }

    // 没有用户锁点的连通块：最小编号格锁到 0
    var autoPins = [];
    for (i = 0; i < n; i++) {
      if (!valid[i]) continue;
      r = compRoot[i];
      if (!compHasPin[r] && compMin[r] === i) {
        pinKind[i] = 2;
        pinHeight[i] = 0;
        autoPins.push(i);
      }
    }

    // 全局 -> 自由序号
    var freeIndex = new Int32Array(n);
    freeIndex.fill(-1);
    var nFree = 0, nPinned = 0;
    for (i = 0; i < n; i++) {
      if (!valid[i]) continue;
      if (pinKind[i]) { nPinned++; continue; }
      freeIndex[i] = nFree++;
    }

    // 自由-自由边的紧凑索引（matvec 只用这部分）
    var ffA = [], ffB = [], ffW = [];
    for (e = 0; e < m; e++) {
      var la = freeIndex[edgeA[e]];
      var lb = freeIndex[edgeB[e]];
      if (la >= 0 && lb >= 0) {
        ffA.push(la); ffB.push(lb); ffW.push(edgeW[e]);
      }
    }

    return {
      width: W, height: H, n: n,
      validCell: valid, conf: conf, nx: nx, ny: ny, nz: nz,
      dx: dx, dy: dy, wrapX: data.wrapX, wrapY: data.wrapY,
      // 边
      edgeA: edgeA, edgeB: edgeB, edgeW: edgeW, edgeG: edgeG,
      edgeAxis: edgeAxis, edgeWrap: edgeWrap, edgeCount: m,
      // 连通性 / 锁点
      compRoot: compRoot, pinKind: pinKind, pinHeight: pinHeight,
      userPins: userPins, autoPins: autoPins,
      freeIndex: freeIndex, nFree: nFree, nPinned: nPinned,
      ffA: new Int32Array(ffA), ffB: new Int32Array(ffB), ffW: new Float64Array(ffW),
      buildMs: nowMs() - t0
    };
  }

  /* ------------------------------------------------------------------ *
   * 4. PCG 求解 + 残差复核
   *    opts.warm   : 与模型同尺寸的 Float64Array，自由格的初值
   *    opts.shouldCancel : 回调，返回 true 则中止
   * ------------------------------------------------------------------ */
  function solveModel(model, opts) {
    opts = opts || {};
    var t0 = nowMs();
    var n = model.n, m = model.edgeCount;
    var edgeA = model.edgeA, edgeB = model.edgeB, edgeW = model.edgeW, edgeG = model.edgeG;
    var pinKind = model.pinKind, pinHeight = model.pinHeight;
    var freeIndex = model.freeIndex, nFree = model.nFree;
    var ffA = model.ffA, ffB = model.ffB, ffW = model.ffW;
    var valid = model.validCell;

    // 全局对角与右端。min Φ = Σw(h_b - h_a - g)² 的法方程 A h = b：
    //   出边(a)方程 h_a - h_b = -g -> b_a 贡献 -w g
    //   入边(b)方程 h_b - h_a = +g -> b_b 贡献 +w g
    //   锁点端的 -w·h_lock 移到右端，符号取反
    var diag = new Float64Array(n);
    var bAll = new Float64Array(n);
    for (var e = 0; e < m; e++) {
      var a = edgeA[e], b = edgeB[e], w = edgeW[e], g = edgeG[e];
      diag[a] += w;
      diag[b] += w;
      if (!pinKind[a]) bAll[a] -= w * g;
      if (!pinKind[b]) bAll[b] += w * g;
      if (pinKind[a] && !pinKind[b]) bAll[b] += w * pinHeight[a];
      if (pinKind[b] && !pinKind[a]) bAll[a] += w * pinHeight[b];
    }

    var b = new Float64Array(nFree);
    var diagL = new Float64Array(nFree);
    for (var i = 0; i < n; i++) {
      var li = freeIndex[i];
      if (li >= 0) {
        b[li] = bAll[i];
        diagL[li] = diag[i];
      }
    }

    var iter = 0;
    var maxCheck = 0;
    var cancelled = false;
    var warm = opts.warm;

    if (nFree === 0) {
      // 全部锁定：直接组装结果
    } else {
      var x = new Float64Array(nFree);
      if (warm && warm.length === n) {
        for (i = 0; i < n; i++) if (freeIndex[i] >= 0) x[freeIndex[i]] = warm[i];
      }

      // r = b - A x；先对角部分
      var r = new Float64Array(nFree);
      var Ax = new Float64Array(nFree);
      for (i = 0; i < nFree; i++) Ax[i] = diagL[i] * x[i];
      for (var k = 0; k < ffA.length; k++) {
        var u = ffA[k], v = ffB[k], ww = ffW[k];
        Ax[u] -= ww * x[v];
        Ax[v] -= ww * x[u];
      }
      for (i = 0; i < nFree; i++) r[i] = b[i] - Ax[i];

      var Minv = new Float64Array(nFree);
      for (i = 0; i < nFree; i++) Minv[i] = 1 / diagL[i]; // 自由格必有正对角

      var z = new Float64Array(nFree);
      var p = new Float64Array(nFree);
      for (i = 0; i < nFree; i++) {
        z[i] = r[i] * Minv[i];
        p[i] = z[i];
      }
      var rz = 0;
      for (i = 0; i < nFree; i++) rz += r[i] * z[i];
      var rz0 = rz;

      var Ap = new Float64Array(nFree);
      var maxIter = 20000;

      function currentMaxCheck() {
        // 有向加权残差和 / 权重和（由当前 r 直接给出）
        var mx = 0;
        for (var j = 0; j < nFree; j++) {
          var q = Math.abs(r[j]) / diagL[j];
          if (q > mx) mx = q;
        }
        return mx;
      }

      maxCheck = currentMaxCheck();
      for (iter = 0; iter < maxIter && maxCheck > RESIDUAL_TOL; iter++) {
        if ((iter & 63) === 0 && opts.shouldCancel && opts.shouldCancel()) {
          cancelled = true;
          break;
        }
        // Ap = A p
        for (i = 0; i < nFree; i++) Ap[i] = diagL[i] * p[i];
        for (k = 0; k < ffA.length; k++) {
          u = ffA[k]; v = ffB[k]; ww = ffW[k];
          Ap[u] -= ww * p[v];
          Ap[v] -= ww * p[u];
        }
        var pAp = 0;
        for (i = 0; i < nFree; i++) pAp += p[i] * Ap[i];
        if (!(pAp > 0) || !isFinite(pAp)) break;
        var alpha = rz / pAp;
        for (i = 0; i < nFree; i++) {
          x[i] += alpha * p[i];
          r[i] -= alpha * Ap[i];
        }
        for (i = 0; i < nFree; i++) z[i] = r[i] * Minv[i];
        var rzNew = 0;
        for (i = 0; i < nFree; i++) rzNew += r[i] * z[i];
        if (!isFinite(rzNew)) break;
        var beta = rzNew / rz;
        for (i = 0; i < nFree; i++) p[i] = z[i] + beta * p[i];
        rz = rzNew;
        // 每 16 步或下一步将退出时刷新收敛指标，避免读到陈旧值
        if ((iter & 15) === 15) maxCheck = currentMaxCheck();
      }
      if (!cancelled) maxCheck = currentMaxCheck();

      // 回填全局高度
      var heights = new Float64Array(n);
      for (i = 0; i < n; i++) {
        if (!valid[i]) { heights[i] = NaN; continue; }
        if (pinKind[i]) heights[i] = pinHeight[i];
        else heights[i] = x[freeIndex[i]];
      }

      if (cancelled) {
        return { cancelled: true, iterations: iter, solveMs: nowMs() - t0 };
      }

      return finalize(model, heights, iter, maxCheck, rz0, t0);
    }

    // nFree === 0
    var heightsAll = new Float64Array(n);
    for (i = 0; i < n; i++) {
      heightsAll[i] = valid[i] ? pinHeight[i] : NaN;
    }
    return finalize(model, heightsAll, 0, 0, 0, t0);
  }

  /* 独立按边重算残差与验收指标，不依赖 PCG 内部向量 */
  function finalize(model, heights, iterations, pcgMaxCheck, rz0, t0) {
    var m = model.edgeCount;
    var edgeRes = new Float64Array(m);
    var absSum = new Float64Array(model.n);
    var wSum = new Float64Array(model.n);
    var rmsNum = 0, wTot = 0;
    var maxAbs = 0, maxAbsEdge = -1;
    var worstCell = -1, worstRatio = 0;

    for (var e = 0; e < m; e++) {
      var a = model.edgeA[e], b = model.edgeB[e];
      var r = heights[b] - heights[a] - model.edgeG[e];
      edgeRes[e] = r;
      var w = model.edgeW[e];
      // 有向：a 端为 -r，b 端为 +r
      absSum[a] -= w * r; wSum[a] += w;
      absSum[b] += w * r; wSum[b] += w;
      rmsNum += w * r * r; wTot += w;
      var ar = Math.abs(r);
      if (ar > maxAbs) { maxAbs = ar; maxAbsEdge = e; }
    }

    var cellRatio = new Float64Array(model.n);
    for (var i = 0; i < model.n; i++) {
      if (!model.validCell[i] || model.pinKind[i]) continue;
      var ratio = wSum[i] > 0 ? Math.abs(absSum[i]) / wSum[i] : 0;
      cellRatio[i] = ratio;
      if (ratio > worstRatio) { worstRatio = ratio; worstCell = i; }
    }

    var wrms = Math.sqrt(rmsNum / wTot);
    var passed = worstRatio <= RESIDUAL_TOL;

    return {
      cancelled: false,
      heights: heights,
      edgeResidual: edgeRes,
      cellRatio: cellRatio,
      cellAbsSum: absSum,
      cellWSum: wSum,
      wrms: wrms,
      maxAbsResidual: maxAbs,
      maxAbsResidualEdge: maxAbsEdge,
      worstCell: worstCell,
      worstCellRatio: worstRatio,
      verifyPassed: passed,
      tolerance: RESIDUAL_TOL,
      iterations: iterations,
      pcgMaxCheck: pcgMaxCheck,
      rz0: rz0,
      nFree: model.nFree,
      edgeCount: m,
      solveMs: nowMs() - t0,
      buildMs: model.buildMs
    };
  }

  /* 便捷入口：校验 + 建模 + 求解 */
  function solve(input, opts) {
    var v = validateInput(input);
    if (!v.ok) return { ok: false, errors: v.errors };
    var model = buildModel(v.data);
    var result = solveModel(model, opts);
    result.ok = true;
    result.model = model;
    result.data = v.data;
    return result;
  }

  return {
    ABS_PIN_MAX: ABS_PIN_MAX,
    RESIDUAL_TOL: RESIDUAL_TOL,
    validateInput: validateInput,
    buildModel: buildModel,
    solveModel: solveModel,
    solve: solve
  };
});
