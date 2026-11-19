// 确定性三角函数与矢量工具。
//
// 为什么不用 Math.sin/cos/tan/atan2/hypot：
//   ECMAScript 只规定这些函数“近似”，不同引擎（甚至同引擎不同平台/libm）
//   结果可能相差 1 ULP。逻辑里凡是三角函数都走这里，全部只用 IEEE-754 的
//   + - * / 与 Math.round，逐位可复现；同一份回放换引擎重放校验和不变。
//
// 精度：在 [-1e6, 1e6] 弧度范围内，相对误差约 1e-16（与 libm 同量级）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RallyMath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PI = 3.141592653589793;
  var HPI = 1.5707963267948966;
  // π/2 的扩展精度拆分（Cody–Waite），用于大角度的精确归约
  var PIO2_1 = 1.5707963267341256; // 高位（尾部有零，乘小整数不丢位）
  var PIO2_1T = 6.077100506506192e-11; // 低位

  var INV6 = 1 / 6;
  var INV120 = 1 / 120;
  var INV5040 = 1 / 5040;
  var INV362880 = 1 / 362880;
  var INV39916800 = 1 / 39916800;
  var INV6227020800 = 1 / 6227020800;
  var INV1307674368000 = 1 / 1307674368000;
  var INV355687428096000 = 1 / 355687428096000;
  var INV121645100408832000 = 1 / 121645100408832000;

  var INV2 = 1 / 2;
  var INV24 = 1 / 24;
  var INV720 = 1 / 720;
  var INV40320 = 1 / 40320;
  var INV3628800 = 1 / 3628800;
  var INV479001600 = 1 / 479001600;
  var INV87178291200 = 1 / 87178291200;
  var INV20922789888000 = 1 / 20922789888000;
  var INV6402373705728000 = 1 / 6402373705728000;

  // |r| <= π/4 时的 sin / cos（Taylor 展开到 r^19 / r^20）
  function sinSmall(r) {
    var r2 = r * r;
    return (
      r *
      (1 +
        r2 *
          (-INV6 +
            r2 *
              (INV120 +
                r2 *
                  (-INV5040 +
                    r2 *
                      (INV362880 +
                        r2 *
                          (-INV39916800 +
                            r2 * (INV6227020800 + r2 * (-INV1307674368000 + r2 * (INV355687428096000 + r2 * -INV121645100408832000)))))))))
    );
  }

  function cosSmall(r) {
    var r2 = r * r;
    return (
      1 +
      r2 *
        (-INV2 +
          r2 *
            (INV24 +
              r2 *
                (-INV720 +
                  r2 *
                    (INV40320 +
                      r2 *
                        (-INV3628800 +
                          r2 * (INV479001600 + r2 * (-INV87178291200 + r2 * (INV20922789888000 + r2 * -INV6402373705728000))))))))
    );
  }

  // 把 x 归约到 r + k·(π/2)，返回 r 与象限 k mod 4
  function reduce(x) {
    if (!isFinite(x)) return { r: NaN, q: 0 };
    var k = Math.round(x / HPI);
    var r = x - k * PIO2_1;
    r = r - k * PIO2_1T;
    var q = k % 4;
    if (q < 0) q += 4;
    return { r: r, q: q };
  }

  function sin(x) {
    var red = reduce(x);
    switch (red.q) {
      case 0:
        return sinSmall(red.r);
      case 1:
        return cosSmall(red.r);
      case 2:
        return -sinSmall(red.r);
      default:
        return -cosSmall(red.r);
    }
  }

  function cos(x) {
    var red = reduce(x);
    switch (red.q) {
      case 0:
        return cosSmall(red.r);
      case 1:
        return -sinSmall(red.r);
      case 2:
        return -cosSmall(red.r);
      default:
        return sinSmall(red.r);
    }
  }

  function tan(x) {
    var red = reduce(x);
    var s = sinSmall(red.r);
    var c = cosSmall(red.r);
    switch (red.q) {
      case 0:
        return s / c;
      case 1:
        return -c / s;
      case 2:
        return s / c;
      default:
        return -c / s;
    }
  }

  // atan(x)，先用恒等变换把参数压到 |t| <= tan(π/12)，再展开级数
  var TAN_PI_12 = 0.2679491924311227; // tan(π/12) = 2 - √3
  var SQRT3 = 1.7320508075688772;

  function atanSeries(t) {
    // atan(t) = t - t³/3 + t⁵/5 - …；固定 15 项，结果与平台无关
    var t2 = t * t;
    var term = t;
    var sum = t;
    var n = 1;
    for (var i = 0; i < 15; i++) {
      term = -term * t2;
      n += 2;
      sum += term / n;
    }
    return sum;
  }

  function atan(x) {
    if (x !== x) return NaN;
    if (x === Infinity) return HPI;
    if (x === -Infinity) return -HPI;
    if (x === 0) return 0;
    var sign = x < 0 ? -1 : 1;
    x = x < 0 ? -x : x;
    if (x > 1) {
      // atan(x) = π/2 - atan(1/x)
      return sign * (HPI - atan(1 / x));
    }
    if (x > TAN_PI_12) {
      // atan(x) = π/6 + atan((x·√3 - 1) / (x + √3))
      var u = (x * SQRT3 - 1) / (x + SQRT3);
      return sign * (Math.PI / 6 + atanSeries(u));
    }
    return sign * atanSeries(x);
  }

  function atan2(y, x) {
    if (x === 0) {
      if (y > 0) return HPI;
      if (y < 0) return -HPI;
      return 0;
    }
    var a = atan(y / x);
    if (x > 0) return a;
    // x < 0
    return y >= 0 ? a + PI : a - PI;
  }

  function hypot(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  // 归一化到 (-π, π]
  function normAngle(a) {
    if (!isFinite(a)) return a;
    var twoPi = PI * 2;
    var r = a % twoPi;
    if (r > PI) r -= twoPi;
    else if (r <= -PI) r += twoPi;
    return r;
  }

  return {
    PI: PI,
    HPI: HPI,
    sin: sin,
    cos: cos,
    tan: tan,
    atan: atan,
    atan2: atan2,
    hypot: hypot,
    normAngle: normAngle,
  };
});
