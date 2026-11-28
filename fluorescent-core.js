/*
 * fluorescent-core.js
 * 荧光贴片稳态换灯打样：数据校验 + 稳态线性求解 + 观察权重转色。
 * 纯数值核心，无 DOM 依赖，可在浏览器与 Node 中运行。
 *
 * 模型（B 个波段，按波长从短到长排序；N 个贴片）：
 *   稳态入射 E[i][k] = D[i][k]                       （直射）
 *                    + Σ_{链接 p->i} t[p][i] * O[p][k]   （同波段其他贴片出射）
 *   同波段反射      R[i][k] = r[i][k] * E[i][k]
 *   荧光（只向更长波段） F[i][j] = Σ_{k<j} c[i][k][j] * E[i][k]
 *   总出射          O[i][j] = R[i][j] + F[i][j]
 * 每个波段 j 是一个 N×N 线性方程：
 *   (I - T·diag(r[:,j])) E[:,j] = D[:,j] + Σ_{k<j} (T·C[k][j]) E[:,k]
 * 从短波段向长波段依次求解即可（荧光只耦合更短波段）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FluorescentCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { patches: 96, bands: 16, links: 4096 };
  var EPS = 1e-12;

  function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
  function fmt(x, d) {
    if (d === undefined) d = 6;
    if (!Number.isFinite(x)) return String(x);
    if (x !== 0 && Math.abs(x) < 1e-4) return x.toExponential(4);
    return (Math.round(x * 1e10) / 1e10).toFixed(d).replace(/\.?0+$/, '');
  }

  /* ---------------- 校验 ---------------- */

  function validate(data) {
    var errors = [];
    if (!data || typeof data !== 'object') {
      return { ok: false, errors: ['数据不是对象'] };
    }

    // 波段
    var bands = data.bands;
    if (!Array.isArray(bands) || bands.length === 0) {
      errors.push('bands 必须是非空数组');
    } else if (bands.length > LIMITS.bands) {
      errors.push('波段数 ' + bands.length + ' 超过上限 ' + LIMITS.bands);
    } else {
      for (var b = 0; b < bands.length; b++) {
        if (!isFiniteNum(bands[b])) errors.push('波段 ' + b + ' 的波长不是数值');
        if (b > 0 && isFiniteNum(bands[b]) && isFiniteNum(bands[b - 1]) && bands[b] <= bands[b - 1]) {
          errors.push('波段 ' + b + '（' + bands[b] + 'nm）未按波长严格递增，前一波段为 ' + bands[b - 1] + 'nm');
        }
      }
    }
    var B = Array.isArray(bands) ? bands.length : 0;

    // 观察权重
    var rgb = data.observerRGB;
    if (!Array.isArray(rgb) || rgb.length !== B) {
      errors.push('observerRGB 必须是 ' + B + ' 行（每波段一行）的数组');
    } else {
      for (var r2 = 0; r2 < B; r2++) {
        var row = rgb[r2];
        if (!Array.isArray(row) || row.length !== 3 || row.some(function (v) { return !isFiniteNum(v); })) {
          errors.push('observerRGB 第 ' + r2 + ' 行（波段 ' + (B ? bands[r2] : r2) + 'nm）必须是 3 个数值');
        }
      }
    }

    // 贴片
    var patches = data.patches;
    if (!Array.isArray(patches) || patches.length === 0) {
      errors.push('patches 必须是非空数组');
    } else if (patches.length > LIMITS.patches) {
      errors.push('贴片数 ' + patches.length + ' 超过上限 ' + LIMITS.patches);
    }
    var N = Array.isArray(patches) ? patches.length : 0;
    var ids = {};
    var dupIds = {};
    for (var i = 0; i < N; i++) {
      var p = patches[i] || {};
      var name = (p.id !== undefined ? String(p.id) : '#');
      if (p.id === undefined) errors.push('第 ' + i + ' 个贴片缺少 id');
      if (ids[name] !== undefined) dupIds[name] = true;
      ids[name] = i;
      ['direct', 'reflect'].forEach(function (key) {
        var arr = p[key];
        if (!Array.isArray(arr) || arr.length !== B) {
          errors.push('贴片 ' + name + ' 的 ' + key + ' 必须是 ' + B + ' 个数值（逐波段）');
        } else {
          arr.forEach(function (v, k) {
            if (!isFiniteNum(v)) errors.push('贴片 ' + name + ' 的 ' + key + ' 在波段 ' + k + '（' + (B ? bands[k] : '') + 'nm）不是数值');
            else if (v < 0) errors.push('贴片 ' + name + ' 的 ' + key + ' 在波段 ' + k + '（' + bands[k] + 'nm）为负：' + fmt(v));
          });
        }
      });
      if (!Array.isArray(p.convert)) {
        errors.push('贴片 ' + name + ' 的 convert 必须是数组');
      } else {
        // 先收集，按 (src,dst) 合并重复项后再做能量守恒检查
        var cmap = {};
        p.convert.forEach(function (triple, ti) {
          if (!Array.isArray(triple) || triple.length !== 3) {
            errors.push('贴片 ' + name + ' 的 convert[' + ti + '] 必须是 [源波段, 目标波段, 比例]');
            return;
          }
          var s = triple[0], t = triple[1], q = triple[2];
          if (!Number.isInteger(s) || s < 0 || s >= B) errors.push('贴片 ' + name + ' 的 convert[' + ti + '] 源波段 ' + s + ' 越界（合法 0..' + (B - 1) + '）');
          if (!Number.isInteger(t) || t < 0 || t >= B) errors.push('贴片 ' + name + ' 的 convert[' + ti + '] 目标波段 ' + t + ' 越界（合法 0..' + (B - 1) + '）');
          else if (Number.isInteger(s) && s >= 0 && s < B && t <= s) {
            errors.push('贴片 ' + name + ' 的 convert[' + ti + '] 目标波段 ' + t + '（' + bands[t] + 'nm）不长于源波段 ' + s + '（' + bands[s] + 'nm），荧光只能向更长波段转换');
          }
          if (!isFiniteNum(q)) errors.push('贴片 ' + name + ' 的 convert[' + ti + '] 比例不是数值');
          else if (q < 0) errors.push('贴片 ' + name + ' 的 convert[' + ti + '] 比例为负：' + fmt(q));
          if (Number.isInteger(s) && s >= 0 && s < B && Number.isInteger(t) && t >= 0 && t < B && isFiniteNum(q) && q >= 0) {
            cmap[s] = cmap[s] || {};
            cmap[s][t] = (cmap[s][t] || 0) + q;
          }
        });
        // 能量守恒：同波段 反射 + 全部荧光转出 ≤ 1
        if (Array.isArray(p.reflect) && p.reflect.length === B) {
          for (var s2 = 0; s2 < B; s2++) {
            var convSum = 0;
            if (cmap[s2]) for (var t2 in cmap[s2]) convSum += cmap[s2][t2];
            var ref = isFiniteNum(p.reflect[s2]) ? p.reflect[s2] : 0;
            if (ref + convSum > 1 + EPS) {
              errors.push('贴片 ' + name + ' 在波段 ' + s2 + '（' + bands[s2] + 'nm）能量分配越界：反射 ' + fmt(ref) +
                ' + 荧光转出合计 ' + fmt(convSum) + ' = ' + fmt(ref + convSum) + ' > 1');
            }
          }
        }
      }
    }
    Object.keys(dupIds).forEach(function (n) { errors.push('贴片 id 重复：' + n); });

    // 传播链接
    var links = data.links;
    if (!Array.isArray(links)) errors.push('links 必须是数组');
    else if (links.length > LIMITS.links) errors.push('传播记录数 ' + links.length + ' 超过上限 ' + LIMITS.links);
    var linkAgg = {}; // src -> dst -> 累加比例
    if (Array.isArray(links)) {
      links.forEach(function (ln, li) {
        if (!Array.isArray(ln) || ln.length !== 3) {
          errors.push('links[' + li + '] 必须是 [来源, 去向, 比例]');
          return;
        }
        var src = String(ln[0]), dst = String(ln[1]), w = ln[2];
        if (ids[src] === undefined) errors.push('links[' + li + '] 来源贴片 "' + src + '" 不存在');
        if (ids[dst] === undefined) errors.push('links[' + li + '] 去向贴片 "' + dst + '" 不存在');
        if (!isFiniteNum(w)) errors.push('links[' + li + ']（' + src + ' → ' + dst + '）比例不是数值');
        else if (w < 0) errors.push('links[' + li + ']（' + src + ' → ' + dst + '）比例为负：' + fmt(w));
        if (ids[src] !== undefined && ids[dst] !== undefined && isFiniteNum(w) && w >= 0) {
          linkAgg[src] = linkAgg[src] || {};
          linkAgg[src][dst] = (linkAgg[src][dst] || 0) + w;
        }
      });
      // 同一来源传出比例之和 ≤ 0.95
      Object.keys(linkAgg).forEach(function (src) {
        var sum = 0, parts = [];
        Object.keys(linkAgg[src]).forEach(function (dst) { sum += linkAgg[src][dst]; parts.push(dst + '=' + fmt(linkAgg[src][dst])); });
        if (sum > 0.95 + EPS) {
          errors.push('传播来源 "' + src + '" 传出比例合计 ' + fmt(sum) + ' > 0.95（' + parts.join(', ') + '）');
        }
      });
    }

    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------- 线性求解 ---------------- */

  // 部分主元高斯消元，解 A x = b（A 为 n×n 行优先数组，b 长度 n），返回 x。
  // 再做一步迭代精化，把舍入误差压到机器精度量级。
  function solveLinear(A0, b0) {
    var n = b0.length;
    var A = new Float64Array(n * n), b = new Float64Array(n);
    for (var q = 0; q < n * n; q++) A[q] = A0[q];
    for (var q2 = 0; q2 < n; q2++) b[q2] = b0[q2];
    var piv = new Int32Array(n);
    for (var i2 = 0; i2 < n; i2++) piv[i2] = i2;

    for (var col = 0; col < n; col++) {
      // 选主元
      var maxRow = col, maxVal = Math.abs(A[col * n + col]);
      for (var rr = col + 1; rr < n; rr++) {
        var v = Math.abs(A[rr * n + col]);
        if (v > maxVal) { maxVal = v; maxRow = rr; }
      }
      if (maxVal < 1e-300) throw new Error('矩阵奇异，波段 ' + col + ' 无法求解');
      if (maxRow !== col) {
        for (var c2 = 0; c2 < n; c2++) {
          var tmp = A[col * n + c2]; A[col * n + c2] = A[maxRow * n + c2]; A[maxRow * n + c2] = tmp;
        }
        var tmpP = piv[col]; piv[col] = piv[maxRow]; piv[maxRow] = tmpP;
      }
      var pivVal = A[col * n + col];
      for (var r3 = col + 1; r3 < n; r3++) {
        var factor = A[r3 * n + col] / pivVal;
        A[r3 * n + col] = factor;
        for (var c3 = col + 1; c3 < n; c3++) A[r3 * n + c3] -= factor * A[col * n + c3];
      }
    }
    // 回代（LU 已原地存储；先对 b 做行交换与前向消元）
    var y = new Float64Array(n);
    for (var i3 = 0; i3 < n; i3++) y[i3] = b[piv[i3]];
    for (var k2 = 0; k2 < n; k2++) {
      for (var j2 = k2 + 1; j2 < n; j2++) y[j2] -= A[j2 * n + k2] * y[k2];
    }
    var x = new Float64Array(n);
    for (var i4 = n - 1; i4 >= 0; i4--) {
      var s = y[i4];
      for (var j3 = i4 + 1; j3 < n; j3++) s -= A[i4 * n + j3] * x[j3];
      x[i4] = s / A[i4 * n + i4];
    }

    // 迭代精化：r = b0 - A0 x，解 A0 d = r，x += d
    var r = new Float64Array(n);
    for (var i5 = 0; i5 < n; i5++) {
      var s2 = b0[i5];
      for (var j4 = 0; j4 < n; j4++) s2 -= A0[i5 * n + j4] * x[j4];
      r[i5] = s2;
    }
    var d = solveLU(A, piv, r, n);
    for (var i6 = 0; i6 < n; i6++) x[i6] += d[i6];
    return x;
  }

  // 用已分解的 LU（含 piv）解右端项 rhs
  function solveLU(LU, piv, rhs, n) {
    var y = new Float64Array(n);
    for (var i = 0; i < n; i++) y[i] = rhs[piv[i]];
    for (var k = 0; k < n; k++) {
      for (var j = k + 1; j < n; j++) y[j] -= LU[j * n + k] * y[k];
    }
    var x = new Float64Array(n);
    for (var i2 = n - 1; i2 >= 0; i2--) {
      var s = y[i2];
      for (var j2 = i2 + 1; j2 < n; j2++) s -= LU[i2 * n + j2] * x[j2];
      x[i2] = s / LU[i2 * n + i2];
    }
    return x;
  }

  /*
   * 求解稳态。输入已通过 validate 的数据；lamp 为可选的逐波段灯光倍数（长度 B，默认全 1）。
   * 返回：
   * {
   *   N, B, bands, ids,
   *   incident:  N×B 稳态入射 E
   *   direct:    N×B 直射（含灯光倍数）
   *   reflected: N×B 同波段反射 R
   *   fluorescent: N×B 荧光出射 F
   *   outgoing:  N×B 总出射 O
   *   rgb:       N×3 线性 RGB
   *   residual:  最大方程残差 |E - D - T O|
   * }
   */
  function solve(data, lamp) {
    var v = validate(data);
    if (!v.ok) throw new Error('数据未通过校验：' + v.errors[0]);
    var B = data.bands.length, N = data.patches.length;
    lamp = lamp || data.bands.map(function () { return 1; });
    if (lamp.length !== B) throw new Error('灯光倍数数组长度应为 ' + B);

    // 合并后的传播矩阵 T[dst][src]
    var T = new Float64Array(N * N);
    var indexById = {};
    data.patches.forEach(function (p, i) { indexById[String(p.id)] = i; });
    data.links.forEach(function (ln) {
      var si = indexById[String(ln[0])];
      var di = indexById[String(ln[1])];
      T[di * N + si] += ln[2];
    });

    // 转换矩阵集合 conv[srcBand][i][dstBand]（直接按贴片存更省）
    // C[k][i][j]
    var C = [];
    for (var k = 0; k < B; k++) {
      C.push(new Float64Array(N * B));
    }
    data.patches.forEach(function (p, i) {
      p.convert.forEach(function (tri) {
        C[tri[0]][i * B + tri[1]] += tri[2];
      });
    });

    var E = new Float64Array(N * B);   // 入射
    var R = new Float64Array(N * B);   // 反射
    var F = new Float64Array(N * B);   // 荧光
    var O = new Float64Array(N * B);   // 出射
    var D = new Float64Array(N * B);
    data.patches.forEach(function (p, i) {
      for (var b2 = 0; b2 < B; b2++) D[i * B + b2] = p.direct[b2] * lamp[b2];
    });

    var maxResid = 0;
    for (var j = 0; j < B; j++) {
      // A = I - T diag(r_j)，行优先 A[i*N+s]
      var A = new Float64Array(N * N);
      for (var i2 = 0; i2 < N; i2++) {
        for (var s = 0; s < N; s++) {
          A[i2 * N + s] = (i2 === s ? 1 : 0) - T[i2 * N + s] * data.patches[s].reflect[j];
        }
      }
      // rhs = D_j + Σ_{k<j} T C[k][:,j] E_k
      var rhs = new Float64Array(N);
      for (var i3 = 0; i3 < N; i3++) rhs[i3] = D[i3 * B + j];
      for (var k2 = 0; k2 < j; k2++) {
        // f[i] = Σ_s C[k2][s][j] E[s,k2]；再加 T f
        var f = new Float64Array(N);
        for (var s2 = 0; s2 < N; s2++) {
          var ckj = C[k2][s2 * B + j];
          if (ckj !== 0) f[s2] = ckj * E[s2 * B + k2];
        }
        for (var i4 = 0; i4 < N; i4++) {
          var acc = 0;
          for (var s3 = 0; s3 < N; s3++) acc += T[i4 * N + s3] * f[s3];
          rhs[i4] += acc;
        }
      }
      var ej = solveLinear(A, rhs);
      for (var i5 = 0; i5 < N; i5++) E[i5 * B + j] = ej[i5];

      // 反射
      for (var i6 = 0; i6 < N; i6++) R[i6 * B + j] = data.patches[i6].reflect[j] * E[i6 * B + j];
      // 荧光：累加来自更短波段的转换
      for (var i7 = 0; i7 < N; i7++) {
        var fj = 0;
        for (var k3 = 0; k3 < j; k3++) {
          fj += C[k3][i7 * B + j] * E[i7 * B + k3];
        }
        F[i7 * B + j] = fj;
        O[i7 * B + j] = R[i7 * B + j] + fj;
      }

      // 残差校验：E_j 应等于 D_j + T O_j（O 在 j 列此时已完整）
      for (var i8 = 0; i8 < N; i8++) {
        var check = D[i8 * B + j];
        for (var s4 = 0; s4 < N; s4++) check += T[i8 * N + s4] * O[s4 * B + j];
        var resid = Math.abs(E[i8 * B + j] - check);
        if (resid > maxResid) maxResid = resid;
      }
    }

    // 线性 RGB：逐波段出射乘观察权重求和
    var rgbOut = new Float64Array(N * 3);
    for (var i9 = 0; i9 < N; i9++) {
      for (var b3 = 0; b3 < B; b3++) {
        var o = O[i9 * B + b3];
        rgbOut[i9 * 3] += o * data.observerRGB[b3][0];
        rgbOut[i9 * 3 + 1] += o * data.observerRGB[b3][1];
        rgbOut[i9 * 3 + 2] += o * data.observerRGB[b3][2];
      }
    }

    function row2(arr, idx, width) {
      var out = [];
      for (var z = 0; z < width; z++) out.push(arr[idx * width + z]);
      return out;
    }
    return {
      N: N, B: B,
      bands: data.bands.slice(),
      ids: data.patches.map(function (p) { return String(p.id); }),
      direct: data.patches.map(function (p, i) { return row2(D, i, B); }),
      incident: data.patches.map(function (p, i) { return row2(E, i, B); }),
      reflected: data.patches.map(function (p, i) { return row2(R, i, B); }),
      fluorescent: data.patches.map(function (p, i) { return row2(F, i, B); }),
      outgoing: data.patches.map(function (p, i) { return row2(O, i, B); }),
      rgb: data.patches.map(function (p, i) { return row2(rgbOut, i, 3); }),
      residual: maxResid
    };
  }

  // 线性 RGB -> sRGB 显示色（可选增益 gain；负值截断为 0）
  function linearToSrgb(c) {
    c = c <= 0.0031308 ? 12.92 * c : 1.13005 * Math.pow(c, 1 / 2.4) - 0.13005;
    return Math.min(1, Math.max(0, c));
  }
  function swatchCss(rgbLinear, gain) {
    gain = gain || 1;
    var ch = [linearToSrgb(rgbLinear[0] * gain), linearToSrgb(rgbLinear[1] * gain), linearToSrgb(rgbLinear[2] * gain)];
    return 'rgb(' + ch.map(function (v) { return Math.round(v * 255); }).join(',') + ')';
  }

  return {
    LIMITS: LIMITS,
    EPS: EPS,
    validate: validate,
    solve: solve,
    solveLinear: solveLinear,
    linearToSrgb: linearToSrgb,
    swatchCss: swatchCss,
    fmt: fmt
  };
});
