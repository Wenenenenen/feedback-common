/*
 * 核心数学：双线性曲面系数、二次求根（稳定公式）、梯度法线。
 * UMD 写法：浏览器挂到 window.ReliefMath，Node 下可 require。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.ReliefMath = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 欧几里得取模（负数也回绕到 [0, m)）
  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  // 双线性曲面 h(u,v) = a + b*u + c*v + d*u*v
  // 节点约定：h00 左下(i0,j0)，h10 右下(i1,j0)，h01 左上(i0,j1)，h11 右上(i1,j1)
  function bilinearCoeffs(h00, h10, h01, h11) {
    return {
      a: h00,
      b: h10 - h00,
      c: h01 - h00,
      d: h00 - h10 - h01 + h11,
    };
  }

  function evalBilinear(cf, u, v) {
    return cf.a + cf.b * u + cf.c * v + cf.d * u * v;
  }

  /*
   * 稳定求解 A t^2 + B t + C = 0。
   * 返回 { roots: 升序去重, tangent: 是否切触（判别式≈0）, degenerate }
   * 判别式略小于 0 视为数值误差夹到 0 —— 切触照样计为命中。
   */
  function solveQuadratic(A, B, C) {
    const scale = Math.max(1, Math.abs(A), Math.abs(B), Math.abs(C));

    // A、B 都小到机器误差量级才算退化；容差不能含 C 的尺度，
    // 否则垂直射线（A=B=0, C≠0）会被误判成 0=常数 的无解方程
    if (Math.abs(A) <= 1e-14 && Math.abs(B) <= 1e-12) {
      return { roots: [], tangent: false, degenerate: true };
    }
    if (Math.abs(A) <= 1e-14) {
      // 退化一次方程 B t + C = 0
      return { roots: [-C / B], tangent: false, degenerate: false };
    }

    const discRaw = B * B - 4 * A * C;
    const discScale = Math.max(1, B * B, Math.abs(4 * A * C));
    // 明显为负 => 无实根；轻微为负 => 切触的舍入误差，夹到 0
    if (discRaw < -1e-12 * discScale) {
      return { roots: [], tangent: false, degenerate: false };
    }
    const disc = Math.max(0, discRaw);
    const sd = Math.sqrt(disc);
    const q = -0.5 * (B + (B >= 0 ? sd : -sd));

    let roots;
    if (Math.abs(q) > 1e-12 * scale) {
      roots = [q / A, C / q];
    } else {
      roots = [(-B + sd) / (2 * A), (-B - sd) / (2 * A)];
    }

    roots.sort((x, y) => x - y);
    const out = [];
    for (const r of roots) {
      // 二重根在浮点下间距 ~1e-16 量级；1e-12 足以合并，又不会吞掉正常双根
      if (!out.length || Math.abs(r - out[out.length - 1]) > 1e-12 * Math.max(1, Math.abs(r))) {
        out.push(r);
      }
    }
    // 判别式在机器误差量级内为 0 => 二重根切触（阈值不能更松，否则误吞双穿）
    const tangent = Math.abs(discRaw) <= 1e-12 * discScale;
    return { roots: out, tangent, degenerate: false };
  }

  function normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  /*
   * 梯度法线：曲面 z = h(x,y)，法线 (-dh/dx, -dh/dy, 1)。
   * dh/dx = (1/sx) dh/du，dh/dy = (1/sy) dh/dv，物理间距参与计算。
   * z 分量恒为正，天然朝上方。
   */
  function gradientNormal(h00, h10, h01, h11, u, v, sx, sy) {
    const dhu = (1 - v) * (h10 - h00) + v * (h11 - h01);
    const dhv = (1 - u) * (h01 - h00) + u * (h11 - h10);
    return normalize([-dhu / sx, -dhv / sy, 1]);
  }

  // 有限差分数值法线，供测试对照（e 为 u/v 参数空间步长，物理距离分别乘 sx、sy）
  function numericalNormal(field, cx, cy, u, v) {
    const e = 1e-6;
    const sx = field.sx, sy = field.sy;
    const cf = field.cellCoeffs(cx, cy);
    const hAt = (uu, vv) => evalBilinear(
      cf,
      Math.min(1, Math.max(0, uu)),
      Math.min(1, Math.max(0, vv))
    );
    const dhdx = (hAt(u + e, v) - hAt(u - e, v)) / (2 * e * sx);
    const dhdy = (hAt(u, v + e) - hAt(u, v - e)) / (2 * e * sy);
    return normalize([-dhdx, -dhdy, 1]);
  }

  return { mod, bilinearCoeffs, evalBilinear, solveQuadratic, normalize, gradientNormal, numericalNormal };
});
