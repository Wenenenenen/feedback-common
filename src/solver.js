/*
 * 逐像素 Stokes 求解器（手写，禁用现成优化/偏振重建库）。
 *
 * 模型：p_i = offset_i + g_i * (s0 + (u_i*s1 + v_i*s2)/5),  g_i = gain_i/4
 *   普通帧      r = p - m
 *   下饱和 m=0  r = max(0, p)
 *   上饱和 m=MAX r = min(0, p - MAX)
 * 最小化 Σ w_i r_i²，约束 s0 ≥ sqrt(s1²+s2²)。
 *
 * 方法：饱和帧用主动集（active set）处理，固定主动集下是凸二次规划：
 *   - 内部解：3x3 正规方程
 *   - 锥边界解：x=s0(1,cosθ,sinθ)，θ 粗扫 + 局部细扫 + 黄金分割
 * 循环时用锥投影梯度（Moreau 投影 + Armijo 回溯）兜底并做最终抛光。
 */
(function (global) {
  'use strict';

  var SAT_MAX = 65535;
  var KIND_NORMAL = 0;
  var KIND_LOWER = 1;
  var KIND_UPPER = 2;
  var MAX_ACTIVE_ITERS = 24;

  /**
   * 预处理帧常量。
   * project.frames: [{u,v,gain,offset,weight,image:Uint16Array,maskData:Uint8Array|null}]
   * enabled: 布尔数组（长度=帧数）
   */
  function prepare(project, enabled) {
    var n = project.frames.length;
    var g = new Float64Array(n);
    var a1 = new Float64Array(n);
    var a2 = new Float64Array(n);
    var off = new Float64Array(n);
    var w = new Float64Array(n);
    var kind = new Uint8Array(n);
    var hasMask = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var f = project.frames[i];
      g[i] = f.gain / 4;
      a1[i] = g[i] * f.u / 5;
      a2[i] = g[i] * f.v / 5;
      off[i] = f.offset;
      w[i] = f.weight;
      hasMask[i] = f.maskData ? 1 : 0;
    }
    return {
      width: project.width,
      height: project.height,
      n: n,
      g: g, a1: a1, a2: a2, off: off, w: w,
      frames: project.frames,
      enabled: enabled,
      hasMask: hasMask
    };
  }

  /* 3x3 线性方程（高斯消元+部分选主元），成功返回 [x0,x1,x2]，奇异返回 null */
  function solve3(H, rhs) {
    var a = [H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]];
    var b = [rhs[0], rhs[1], rhs[2]];
    var i, j, k;
    for (i = 0; i < 3; i++) {
      var piv = i;
      for (j = i + 1; j < 3; j++) if (Math.abs(a[j * 3 + i]) > Math.abs(a[piv * 3 + i])) piv = j;
      if (Math.abs(a[piv * 3 + i]) < 1e-12) return null;
      if (piv !== i) {
        for (j = 0; j < 3; j++) {
          var t = a[i * 3 + j]; a[i * 3 + j] = a[piv * 3 + j]; a[piv * 3 + j] = t;
        }
        var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      }
      for (j = i + 1; j < 3; j++) {
        var factor = a[j * 3 + i] / a[i * 3 + i];
        for (k = i; k < 3; k++) a[j * 3 + k] -= factor * a[i * 3 + k];
        b[j] -= factor * b[i];
      }
    }
    var x = [0, 0, 0];
    for (i = 2; i >= 0; i--) {
      var s = b[i];
      for (j = i + 1; j < 3; j++) s -= a[i * 3 + j] * x[j];
      x[i] = s / a[i * 3 + i];
    }
    return x;
  }

  function coneProject(x) {
    var r = Math.hypot(x[1], x[2]);
    if (x[0] >= r) return;
    if (x[0] <= -r) { x[0] = 0; x[1] = 0; x[2] = 0; return; }
    var s0n = (x[0] + r) / 2;
    var scale = r > 0 ? s0n / r : 0;
    x[0] = s0n;
    x[1] *= scale;
    x[2] *= scale;
  }

  /**
   * 单像素求解。
   * ctx: prepare() 的结果；px: 像素下标
   * 返回 {s:[s0,s1,s2]} 或 null（无解）
   */
  function solvePixel(ctx, px) {
    var n = ctx.n;
    var idx = [];
    var kinds = [];
    var dirsSeen = Object.create(null);
    var distinctDirs = 0;

    for (var i = 0; i < n; i++) {
      if (!ctx.enabled[i]) continue;
      var fr = ctx.frames[i];
      if (fr.maskData && fr.maskData[px] !== 255) continue;
      var m = fr.image[px];
      var kd;
      if (m === 0) kd = KIND_LOWER;
      else if (m === SAT_MAX) kd = KIND_UPPER;
      else {
        kd = KIND_NORMAL;
        var key = fr.u + ',' + fr.v;
        if (!dirsSeen[key]) { dirsSeen[key] = 1; distinctDirs++; }
      }
      idx.push(i);
      kinds.push(kd);
    }
    if (distinctDirs < 3) return null;
    var K = idx.length;

    // 每帧的 a 向量与 b 常量（按类型）
    var A0 = ctx.g, A1 = ctx.a1, A2 = ctx.a2, OFF = ctx.off, W = ctx.w;
    var bArr = new Float64Array(K);
    for (var t = 0; t < K; t++) {
      var fi = idx[t];
      if (kinds[t] === KIND_NORMAL) bArr[t] = ctx.frames[fi].image[px] - OFF[fi];
      else if (kinds[t] === KIND_LOWER) bArr[t] = -OFF[fi];              // 主动时 r = a·x - b
      else bArr[t] = SAT_MAX - OFF[fi];
    }

    function fullObjective(x) {
      var sum = 0;
      for (var j = 0; j < K; j++) {
        var fi2 = idx[j];
        var ax = A0[fi2] * x[0] + A1[fi2] * x[1] + A2[fi2] * x[2];
        var r;
        if (kinds[j] === KIND_NORMAL) r = ax - bArr[j];
        else if (kinds[j] === KIND_LOWER) r = Math.max(0, ax + OFF[fi2]);
        else r = Math.min(0, ax + OFF[fi2] - SAT_MAX);
        sum += W[fi2] * r * r;
      }
      return sum;
    }

    function fullGradient(x, grad) {
      grad[0] = 0; grad[1] = 0; grad[2] = 0;
      for (var j = 0; j < K; j++) {
        var fi2 = idx[j];
        var ax = A0[fi2] * x[0] + A1[fi2] * x[1] + A2[fi2] * x[2];
        var r = 0;
        if (kinds[j] === KIND_NORMAL) r = ax - bArr[j];
        else if (kinds[j] === KIND_LOWER) { if (ax + OFF[fi2] > 0) r = ax + OFF[fi2]; }
        else { if (ax + OFF[fi2] - SAT_MAX < 0) r = ax + OFF[fi2] - SAT_MAX; }
        if (r !== 0) {
          var c = 2 * W[fi2] * r;
          grad[0] += c * A0[fi2];
          grad[1] += c * A1[fi2];
          grad[2] += c * A2[fi2];
        }
      }
    }

    /* 固定主动集（mask 位=1 的帧参与等式残差），求锥约束最小 */
    function solveActive(activeMask) {
      var H = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      var rhs = [0, 0, 0];
      for (var j = 0; j < K; j++) {
        if (!(activeMask & (1 << j))) continue;
        var fi2 = idx[j];
        var wi = W[fi2], c0 = A0[fi2], c1 = A1[fi2], c2 = A2[fi2], bi = bArr[j];
        H[0] += wi * c0 * c0; H[1] += wi * c0 * c1; H[2] += wi * c0 * c2;
        H[4] += wi * c1 * c1; H[5] += wi * c1 * c2; H[8] += wi * c2 * c2;
        rhs[0] += wi * c0 * bi; rhs[1] += wi * c1 * bi; rhs[2] += wi * c2 * bi;
      }
      H[3] = H[1]; H[6] = H[2]; H[7] = H[5];
      var interior = solve3(H, rhs);
      if (interior && interior[0] > Math.hypot(interior[1], interior[2]) + 1e-10) {
        return interior;
      }
      // WLS 越界（或奇异）：锥投影是边界问题的邻近热启动
      var warm = null;
      if (interior) {
        warm = [interior[0], interior[1], interior[2]];
        coneProject(warm);
      }
      return boundaryMin(activeMask, warm);
    }

    /* 边界上给定 θ 的最优 s0 与对应目标，返回 {s0,obj} */
    function evalTheta(activeMask, theta) {
      var ct = Math.cos(theta), st = Math.sin(theta);
      var num = 0, den = 0;
      for (var j = 0; j < K; j++) {
        if (!(activeMask & (1 << j))) continue;
        var fi2 = idx[j];
        var alpha = A0[fi2] + A1[fi2] * ct + A2[fi2] * st; // g(1+(u cos+v sin)/5) ≥ 0
        num += W[fi2] * alpha * bArr[j];
        den += W[fi2] * alpha * alpha;
      }
      var s0 = den > 0 ? Math.max(0, num / den) : 0;
      var obj = 0;
      for (var j2 = 0; j2 < K; j2++) {
        if (!(activeMask & (1 << j2))) continue;
        var fi3 = idx[j2];
        var alpha2 = A0[fi3] + A1[fi3] * ct + A2[fi3] * st;
        var rr = s0 * alpha2 - bArr[j2];
        obj += W[fi3] * rr * rr;
      }
      return { s0: s0, obj: obj };
    }

    /* 在 [lo,hi] 内黄金分割求 θ（周期性已由调用方处理） */
    function golden(activeMask, lo, hi, iters) {
      var gr = (Math.sqrt(5) - 1) / 2;
      var a = lo, b = hi;
      var c = b - gr * (b - a), d = a + gr * (b - a);
      var fc = evalTheta(activeMask, c).obj, fd = evalTheta(activeMask, d).obj;
      for (var it = 0; it < iters; it++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = evalTheta(activeMask, c).obj; }
        else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = evalTheta(activeMask, d).obj; }
      }
      var mid = (a + b) / 2;
      return { theta: mid, obj: evalTheta(activeMask, mid).obj };
    }

    /* 锥边界：x = s0(1,cosθ,sinθ)，θ∈[0,π)。多级网格 + WLS 投影热启动 */
    function boundaryMin(activeMask, warm) {
      var best = { theta: 0, obj: Infinity };
      function consider(theta) {
        if (theta < 0) theta += Math.PI;
        else if (theta >= Math.PI) theta -= Math.PI;
        var r = evalTheta(activeMask, theta);
        if (r.obj < best.obj) best = { theta: theta, obj: r.obj };
      }
      // 1) WLS 投影热启动（最常见的边界最优位置）
      if (warm && warm[0] > 0) consider(Math.atan2(warm[2], warm[1]));
      // 2) 64 点粗扫
      var C = 64, cell = Math.PI / C;
      var vals = [];
      for (var q = 0; q < C; q++) {
        var th = cell * (q + 0.5);
        var o = evalTheta(activeMask, th).obj;
        vals.push(o);
        if (o < best.obj) best = { theta: th, obj: o };
      }
      // 3) 最优 2 个粗格做 16 点细分，再取细分最优格黄金分割
      var order = vals.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return a[0] - b[0]; });
      for (var rank = 0; rank < 2; rank++) {
        var q0 = order[rank][1];
        var lo = q0 * cell, hi = (q0 + 1) * cell;
        var subBest = Infinity, subTh = lo;
        for (var q2 = 0; q2 < 16; q2++) {
          var t2 = lo + (hi - lo) * (q2 + 0.5) / 16;
          var o2 = evalTheta(activeMask, t2).obj;
          if (o2 < subBest) { subBest = o2; subTh = t2; }
        }
        var g = golden(activeMask, subTh - cell / 16, subTh + cell / 16, 24);
        consider(g.theta);
      }
      // 4) 热启动 θ 局部黄金分割（覆盖粗网格漏掉的窄谷）
      if (warm && warm[0] > 0) {
        var wth = Math.atan2(warm[2], warm[1]);
        if (wth < 0) wth += Math.PI;
        var g2 = golden(activeMask, wth - cell, wth + cell, 24);
        consider(g2.theta);
      }
      var ct2 = Math.cos(best.theta), st2 = Math.sin(best.theta);
      var r2 = evalTheta(activeMask, best.theta);
      return [r2.s0, r2.s0 * ct2, r2.s0 * st2];
    }

    /* 锥投影梯度：BB 步长 + 非单调线搜索，从 x0 出发最小化 fullObjective */
    function projectedGradient(x0, maxIter) {
      var x = [x0[0], x0[1], x0[2]];
      coneProject(x);
      var grad = [0, 0, 0], prevGrad = [0, 0, 0], prevX = [0, 0, 0];
      var L = 0;
      for (var j = 0; j < K; j++) {
        var fi2 = idx[j];
        L += 2 * W[fi2] * (A0[fi2] * A0[fi2] + A1[fi2] * A1[fi2] + A2[fi2] * A2[fi2]);
      }
      var tMax = L > 0 ? 1 / L : 1;
      var tMin = tMax * 1e-8;
      var t = tMax;
      var f = fullObjective(x);
      var fRef = f;       // 非单调参考值
      var refAge = 0;
      fullGradient(x, grad);
      for (var it = 0; it < maxIter; it++) {
        var gnorm = Math.hypot(grad[0], grad[1], grad[2]);
        if (gnorm <= 1e-12 * Math.max(1, Math.abs(f))) break;
        // 非单调线搜索（Zhang-Hager 风格的参考值接受准则）
        var tt = Math.min(tMax, Math.max(tMin, t));
        var accepted = false, xn = [0, 0, 0], fn = 0;
        for (var ls = 0; ls < 30; ls++) {
          xn[0] = x[0] - tt * grad[0];
          xn[1] = x[1] - tt * grad[1];
          xn[2] = x[2] - tt * grad[2];
          coneProject(xn);
          fn = fullObjective(xn);
          var dx0 = xn[0] - x[0], dx1 = xn[1] - x[1], dx2 = xn[2] - x[2];
          var quad = grad[0] * dx0 + grad[1] * dx1 + grad[2] * dx2 +
            (dx0 * dx0 + dx1 * dx1 + dx2 * dx2) / (2 * tt);
          if (fn <= fRef + 1e-12 * (1 + Math.abs(fRef)) + quad) { accepted = true; break; }
          tt *= 0.5;
        }
        if (!accepted) { tt = tMin; continue; }
        // BB 步长（由相邻迭代点与梯度差计算）
        if (it > 0) {
          var sx = xn[0] - prevX[0], sy = xn[1] - prevX[1], sz = xn[2] - prevX[2];
          var gx = grad[0] - prevGrad[0], gy = grad[1] - prevGrad[1], gz = grad[2] - prevGrad[2];
          var ss = sx * sx + sy * sy + sz * sz;
          var syy = gx * gx + gy * gy + gz * gz;
          var syg = sx * gx + sy * gy + sz * gz;
          if (ss > 0 && syg > 0) t = Math.min(tMax, Math.max(tMin, ss / syg));
          else if (ss > 0 && syy > 0) t = Math.min(tMax, Math.max(tMin, Math.sqrt(ss / syy)));
          else t = tt;
        } else {
          t = tt;
        }
        var moved = Math.hypot(xn[0] - x[0], xn[1] - x[1], xn[2] - x[2]);
        prevX[0] = x[0]; prevX[1] = x[1]; prevX[2] = x[2];
        prevGrad[0] = grad[0]; prevGrad[1] = grad[1]; prevGrad[2] = grad[2];
        x = xn;
        f = fn;
        fullGradient(x, grad);
        // 更新非单调参考
        var eta = 0.85;
        fRef = eta * fRef + (1 - eta) * f;
        refAge++;
        if (refAge >= 6 || f < fRef) { fRef = f; refAge = 0; }
        if (moved < 1e-12 * (1 + Math.abs(x[0]))) break;
      }
      return x;
    }

    /* ---------- 主动集主循环（标准工作集：只添加，不删除；循环即跳出） ---------- */
    var active = 0;
    for (var t2 = 0; t2 < K; t2++) if (kinds[t2] === KIND_NORMAL) active |= (1 << t2);

    var seenMasks = Object.create(null);
    seenMasks[active] = 1;
    var bestX = null, bestObj = Infinity;
    var x = null;
    var converged = false;

    for (var iter = 0; iter < MAX_ACTIVE_ITERS; iter++) {
      x = solveActive(active);
      var obj = fullObjective(x);
      if (obj < bestObj) { bestObj = obj; bestX = [x[0], x[1], x[2]]; }

      var added = -1;
      var TOL = 1e-7;
      for (var j2 = 0; j2 < K; j2++) {
        if (active & (1 << j2)) continue;
        var fi5 = idx[j2];
        var axv = A0[fi5] * x[0] + A1[fi5] * x[1] + A2[fi5] * x[2];
        if (kinds[j2] === KIND_LOWER) {
          if (axv + OFF[fi5] > TOL) { added = j2; break; }   // p>0，下饱和约束生效
        } else {
          if (axv + OFF[fi5] - SAT_MAX < -TOL) { added = j2; break; } // p<MAX，上饱和约束生效
        }
      }
      if (added < 0) { converged = true; break; }
      active |= (1 << added);
      if (seenMasks[active]) break; // 工作集重复：跳出，交给投影梯度抛光
      seenMasks[active] = 1;
    }

    // 二阶热启动：按 bestX 处每帧的真实截断状态构造加权最小二乘（含起作用的饱和帧），
    // 锥投影后作为抛光起点，克服投影梯度在病态 Hessian 下的线性慢收敛。
    function wlsWarmFrom(xcur) {
      var Hw = [0, 0, 0, 0, 0, 0, 0, 0, 0], rhsw = [0, 0, 0];
      for (var j = 0; j < K; j++) {
        var fi = idx[j];
        var c0 = A0[fi], c1 = A1[fi], c2 = A2[fi];
        var pcur = OFF[fi] + c0 * xcur[0] + c1 * xcur[1] + c2 * xcur[2];
        var use = false, bv = 0;
        if (kinds[j] === KIND_NORMAL) { use = true; bv = ctx.frames[fi].image[px] - OFF[fi]; }
        else if (kinds[j] === KIND_LOWER) { if (pcur > 0) { use = true; bv = -OFF[fi]; } }
        else { if (pcur < SAT_MAX) { use = true; bv = SAT_MAX - OFF[fi]; } }
        if (!use) continue;
        var wi = W[fi];
        Hw[0] += wi * c0 * c0; Hw[1] += wi * c0 * c1; Hw[2] += wi * c0 * c2;
        Hw[4] += wi * c1 * c1; Hw[5] += wi * c1 * c2; Hw[8] += wi * c2 * c2;
        rhsw[0] += wi * c0 * bv; rhsw[1] += wi * c1 * bv; rhsw[2] += wi * c2 * bv;
      }
      Hw[3] = Hw[1]; Hw[6] = Hw[2]; Hw[7] = Hw[5];
      var wls = solve3(Hw, rhsw);
      if (!wls) return null;
      coneProject(wls);
      return wls;
    }
    var warm2 = wlsWarmFrom(bestX);
    if (warm2 && fullObjective(warm2) < bestObj) { bestX = warm2; bestObj = fullObjective(warm2); }

    // 最终抛光：BB 投影梯度，只接受目标值不上升的结果
    var polished = projectedGradient(bestX, 300);
    var pObj = fullObjective(polished);
    if (pObj <= bestObj + 1e-9 * (1 + Math.abs(bestObj))) { bestX = polished; bestObj = pObj; }

    // 再做一次二阶 WLS 热启动 + 短抛光，清理投影梯度的线性收敛残尾
    var warm3 = wlsWarmFrom(bestX);
    if (warm3) {
      var o3 = fullObjective(warm3);
      if (o3 < bestObj) {
        var pol3 = projectedGradient(warm3, 80);
        var o4 = fullObjective(pol3);
        if (o4 <= o3 + 1e-12 * (1 + Math.abs(o3))) { bestX = pol3; bestObj = o4; }
        else { bestX = warm3; bestObj = o3; }
      }
    }

    // 边界终抛光：在锥边界上按真实（含截断的）目标对 θ 做黄金分割，
    // 每个 θ 的 s0 用一维闭式最优（沿射线 s0≥0 求分段凸目标）。
    function rayOptimalS0(theta) {
      var ct = Math.cos(theta), st = Math.sin(theta);
      // 收集饱和帧截断拐点 s0*：下饱和 p=0、上饱和 p=MAX
      var breaks = [0];
      for (var j = 0; j < K; j++) {
        if (kinds[j] === KIND_NORMAL) continue;
        var fi = idx[j];
        var alpha = A0[fi] + A1[fi] * ct + A2[fi] * st;
        if (alpha > 1e-15) {
          var sCrit = kinds[j] === KIND_LOWER ? -OFF[fi] / alpha : (SAT_MAX - OFF[fi]) / alpha;
          if (sCrit > 0) breaks.push(sCrit);
        }
      }
      breaks.sort(function (a, b) { return a - b; });
      var bestS0 = 0, bestO = fullObjective([0, 0, 0]);
      for (var ci = 0; ci < breaks.length; ci++) {
        var loS = breaks[ci];
        var hiS = ci + 1 < breaks.length ? breaks[ci + 1] : Infinity;
        // 段中点确定每帧在该段的有效残差 r=α·s0-bEff
        var mid = isFinite(hiS) ? (loS + hiS) / 2 : loS + 1;
        var num = 0, den = 0;
        for (var j2 = 0; j2 < K; j2++) {
          var fi2 = idx[j2];
          var al2 = A0[fi2] + A1[fi2] * ct + A2[fi2] * st;
          var pmid = OFF[fi2] + al2 * mid;
          var active;
          if (kinds[j2] === KIND_NORMAL) active = true;
          else if (kinds[j2] === KIND_LOWER) active = pmid > 0;
          else active = pmid < SAT_MAX;
          if (active) {
            var bEff = kinds[j2] === KIND_NORMAL ? ctx.frames[fi2].image[px] - OFF[fi2]
              : kinds[j2] === KIND_LOWER ? -OFF[fi2] : SAT_MAX - OFF[fi2];
            num += W[fi2] * al2 * bEff;
            den += W[fi2] * al2 * al2;
          }
        }
        var sStar = den > 0 ? num / den : 0;
        var cand = (sStar > loS && (!isFinite(hiS) || sStar < hiS)) ? sStar : loS;
        var xx = [cand, cand * ct, cand * st];
        var o = fullObjective(xx);
        if (o < bestO) { bestO = o; bestS0 = cand; }
      }
      return { s0: bestS0, obj: bestO };
    }

    function boundaryFullGolden(theta0) {
      var gr = (Math.sqrt(5) - 1) / 2;
      var a = theta0 - Math.PI / 64, b = theta0 + Math.PI / 64;
      var c = b - gr * (b - a), d = a + gr * (b - a);
      var fc = rayOptimalS0(c).obj, fd = rayOptimalS0(d).obj;
      for (var it = 0; it < 30; it++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = rayOptimalS0(c).obj; }
        else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = rayOptimalS0(d).obj; }
      }
      var th = (a + b) / 2;
      var r = rayOptimalS0(th);
      return { s: [r.s0, r.s0 * Math.cos(th), r.s0 * Math.sin(th)], obj: r.obj };
    }

    var r0 = Math.hypot(bestX[1], bestX[2]);
    if (r0 > 1e-8) {
      var th0 = Math.atan2(bestX[2], bestX[1]);
      if (th0 < 0) th0 += Math.PI;
      var bp = boundaryFullGolden(th0);
      if (bp.obj <= bestObj + 1e-10 * (1 + Math.abs(bestObj))) { bestX = bp.s; bestObj = bp.obj; }
    }

    // 数值安全：确保落在锥内
    coneProject(bestX);
    return { s: bestX, converged: converged };
  }

  /**
   * 整图求解。
   * onProgress(frac) 可选；shouldCancel() 返回 true 时中止并返回 null。
   * chunkSize 控制每批像素数（让出事件循环由调度器负责，这里只做回调）。
   */
  function solveProject(project, enabled, onProgress, shouldCancel, chunkSize) {
    var ctx = prepare(project, enabled);
    var N = ctx.width * ctx.height;
    var s0 = new Float64Array(N);
    var s1 = new Float64Array(N);
    var s2 = new Float64Array(N);
    var solved = new Uint8Array(N);
    var chunk = chunkSize || 2048;
    var px = 0;
    while (px < N) {
      if (shouldCancel && shouldCancel()) return null;
      var end = Math.min(N, px + chunk);
      for (; px < end; px++) {
        var res = solvePixel(ctx, px);
        if (res) {
          s0[px] = res.s[0];
          s1[px] = res.s[1];
          s2[px] = res.s[2];
          solved[px] = 1;
        }
      }
      if (onProgress) onProgress(px / N);
    }
    var enabledList = [];
    for (var i = 0; i < enabled.length; i++) if (enabled[i]) enabledList.push(i);
    return {
      width: ctx.width,
      height: ctx.height,
      enabled: enabledList,
      s0: s0, s1: s1, s2: s2,
      solved: solved
    };
  }

  var api = {
    prepare: prepare,
    solvePixel: solvePixel,
    solveProject: solveProject,
    coneProject: coneProject,
    predict: function (frame, s) {
      return frame.offset + (frame.gain / 4) * (s[0] + (frame.u * s[1] + frame.v * s[2]) / 5);
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.StokesSolver = api;
})(typeof window !== 'undefined' ? window : globalThis);
