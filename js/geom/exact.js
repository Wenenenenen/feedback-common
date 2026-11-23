/*
 * 精确整数/有理数几何谓词（BigInt）。
 * 输入坐标为整数（齐次 w=1）；裁分产生的点用齐次 BigInt 坐标 (x,y,z,w) 表示，
 * orient3d 全程无浮点，符号判定严格精确。
 */
(function (global) {
  'use strict';

  const BI = Object.freeze({
    zero: 0n,
    one: 1n,
    negOne: -1n,
  });

  function bi(v) { return BigInt(v); }
  function isBi(v) { return typeof v === 'bigint'; }

  function gcd(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) { [a, b] = [b, a % b]; }
    return a;
  }

  function i3(x, y, z) { return { x, y, z, w: BI.one }; }

  function h3(x, y, z, w) {
    if (w < 0n) { x = -x; y = -y; z = -z; w = -w; }
    const g = gcd(gcd(gcd(x, y), z), w);
    if (g > 1n) return { x: x / g, y: y / g, z: z / g, w: w / g };
    return { x, y, z, w };
  }

  function hsub(a, b) {
    return h3(a.x * b.w - b.x * a.w, a.y * b.w - b.y * a.w, a.z * b.w - b.z * a.w, a.w * b.w);
  }
  function hcross(a, b) {
    return h3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, a.w * b.w);
  }

  /**
   * 精确 orient3d：返回 det([b-a,c-a,d-a]) 的带符号分子（BigInt）。
   * 齐次坐标的公共分母恒正，因此返回值符号即行列式符号，数值无需归一化。
   */
  function orient3dExact(a, b, c, d) {
    const u = hsub(b, a), v = hsub(c, a), w = hsub(d, a);
    const cx = hcross(v, w);
    // dot(u, cx)：值 = (u.x*cx.x*u.w*cx.w + ...) / (u.w^2 * cx.w^2)，分母为正
    const uw2 = u.w * u.w, cw2 = cx.w * cx.w;
    return u.x * cx.x * cw2 + u.y * cx.y * cw2 + u.z * cx.z * cw2;
  }

  function signBi(v) { return v < 0n ? -1 : (v > 0n ? 1 : 0); }

  // ---------- 有理数（BigInt 分子/分母，分母恒正，自动约分） ----------
  function rat(n, d) {
    if (d === undefined || d === null) d = BI.one;
    if (!isBi(n)) n = bi(n);
    if (!isBi(d)) d = bi(d);
    if (d === 0n) throw new Error('rat: 分母为零');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    if (g > 1n) { n /= g; d /= g; }
    return { n, d };
  }
  const ratZero = () => rat(0n, 1n);
  const ratOne = () => rat(1n, 1n);
  function rneg(a) { return { n: -a.n, d: a.d }; }
  function radd(a, b) { return rat(a.n * b.d + b.n * a.d, a.d * b.d); }
  function rsub(a, b) { return rat(a.n * b.d - b.n * a.d, a.d * b.d); }
  function rmul(a, b) { return rat(a.n * b.n, a.d * b.d); }
  function rdiv(a, b) {
    if (b.n === 0n) throw new Error('rdiv: 除以零');
    return rat(a.n * b.d, a.d * b.n);
  }
  function rsign(a) { return a.n < 0n ? -1 : (a.n > 0n ? 1 : 0); }
  function rcmp(a, b) { return rsign(rsub(a, b)); }
  function rnum(a) {
    // 安全转 Number（坐标量级 1e6，裁分深度有限）
    return Number(a.n) / Number(a.d);
  }
  function rkey(a) { return `${a.n}/${a.d}`; }
  function req(a, b) { return a.n === b.n && a.d === b.d; }

  const api = {
    BI, bi, isBi, gcd, i3, h3, hsub, hcross,
    orient3d: orient3dExact, signBi,
    rat, ratZero, ratOne, rneg, radd, rsub, rmul, rdiv, rsign, rcmp, rnum, rkey, req,
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; global.TCExact = api; }
  else global.TCExact = api;
})(typeof window !== 'undefined' ? window : globalThis);
