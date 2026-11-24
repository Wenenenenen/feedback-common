/*
 * frac.js — 任意精度精确有理数（bigint）。
 * 浏览器经典脚本与 Node CommonJS 双用；ESM 用法见根目录 rks.mjs。
 * 所有构造都会约分并保证分母为正。
 */
(function () {
  'use strict';

  function bigGcd(a, b) {
    if (a < 0n) a = -a;
    if (b < 0n) b = -b;
    while (b !== 0n) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  class Frac {
    constructor(n, d) {
      if (d === undefined || d === null) d = 1n;
      n = typeof n === 'bigint' ? n : BigInt(n);
      d = typeof d === 'bigint' ? d : BigInt(d);
      if (d === 0n) throw new Error('Frac: 分母不能为 0');
      if (d < 0n) {
        n = -n;
        d = -d;
      }
      if (n === 0n) {
        this.n = 0n;
        this.d = 1n;
        return;
      }
      const g = bigGcd(n, d);
      this.n = n / g;
      this.d = d / g;
    }

    static zero() { return new Frac(0n, 1n); }
    static one() { return new Frac(1n, 1n); }

    static parse(v) {
      if (v instanceof Frac) return v;
      if (typeof v === 'bigint') return new Frac(v, 1n);
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new Error('Frac: 非有限数字');
        if (Number.isInteger(v)) return new Frac(BigInt(v), 1n);
        return Frac.parse(String(v));
      }
      if (typeof v !== 'string') throw new Error('Frac: 无法解析 ' + String(v));
      let s = v.trim();
      if (s === '') throw new Error('Frac: 空字符串');
      if (/^[+-]?\d+$/.test(s)) return new Frac(BigInt(s), 1n);
      // 分数  a/b  （a、b 均为整数，允许各自带符号/空白）
      if (s.includes('/')) {
        const parts = s.split('/');
        if (parts.length !== 2) throw new Error('Frac: 非法分数 ' + v);
        const a = parts[0].trim();
        const b = parts[1].trim();
        if (!/^[+-]?\d+$/.test(a) || !/^[+-]?\d+$/.test(b)) {
          throw new Error('Frac: 非法分数 ' + v);
        }
        return new Frac(BigInt(a), BigInt(b));
      }
      // 精确十进制（含可选小数点），例如 0.25 / -3.14
      const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
      if (m) {
        const sign = m[1] === '-' ? -1n : 1n;
        const intPart = m[2] === '' ? '0' : m[2];
        const fracPart = m[3] || '';
        if (intPart === '0' && fracPart === '') { /* zero */ }
        const digits = intPart + fracPart;
        let num = BigInt(digits) * sign;
        let den = 10n ** BigInt(fracPart.length);
        return new Frac(num, den);
      }
      throw new Error('Frac: 无法解析 “' + v + '”（需整数、a/b 或十进制字符串）');
    }

    add(o) {
      o = Frac.parse(o);
      return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
    }
    sub(o) {
      o = Frac.parse(o);
      return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
    }
    mul(o) {
      o = Frac.parse(o);
      return new Frac(this.n * o.n, this.d * o.d);
    }
    div(o) {
      o = Frac.parse(o);
      if (o.n === 0n) throw new Error('Frac: 除以零');
      return new Frac(this.n * o.d, this.d * o.n);
    }
    neg() { return new Frac(-this.n, this.d); }

    cmp(o) {
      o = Frac.parse(o);
      const lhs = this.n * o.d;
      const rhs = o.n * this.d;
      return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
    }
    eq(o) {
      if (!(o instanceof Frac)) {
        try { o = Frac.parse(o); } catch { return false; }
      }
      return this.n === o.n && this.d === o.d;
    }
    lt(o) { return this.cmp(o) < 0; }
    lte(o) { return this.cmp(o) <= 0; }
    gt(o) { return this.cmp(o) > 0; }
    gte(o) { return this.cmp(o) >= 0; }
    isZero() { return this.n === 0n; }
    sign() { return this.n === 0n ? 0 : this.n < 0n ? -1 : 1; }

    /** 转为 JS number（仅用于绘制/自适应采样，不用于相等判定与导出 JSON）。 */
    toNumber() {
      // 先做量级控制，避免 Number(bigint) 对超大整数失真为 Infinity 后无法相除。
      const absN = this.n < 0n ? -this.n : this.n;
      const nb = absN.toString().length;
      const db = this.d.toString().length;
      const shift = db - nb; // 需要补/去的十进制位数差
      if (shift > 300) {
        // 分母远大于分子：结果接近 0
        return this.n < 0n ? -0 : 0;
      }
      if (shift < -300) {
        return this.n < 0n ? -Infinity : Infinity;
      }
      return Number(this.n) / Number(this.d);
    }

    /** 精确四舍五入到 maxDigits 位小数，返回普通十进制字符串（去掉末尾 0）。 */
    toDecimal(maxDigits) {
      if (maxDigits === undefined) maxDigits = 12;
      maxDigits = Math.max(0, Math.floor(maxDigits));
      const neg = this.n < 0n;
      const an = neg ? -this.n : this.n;
      const scale = 10n ** BigInt(maxDigits);
      // 对 |n|/d * scale 做四舍五入（半数向上，按绝对值）
      let v = an * scale;
      let q = v / this.d;
      const r = v % this.d;
      if (r * 2n >= this.d) q += 1n;
      let out;
      if (maxDigits === 0) {
        out = q.toString();
      } else {
        let s = q.toString().padStart(maxDigits + 1, '0');
        const intPart = s.slice(0, s.length - maxDigits);
        const fracPart = s.slice(s.length - maxDigits).replace(/0+$/, '');
        out = fracPart ? intPart + '.' + fracPart : intPart;
      }
      if (neg && q !== 0n) out = '-' + out;
      return out;
    }

    toString() {
      return this.d === 1n ? this.n.toString() : this.n.toString() + '/' + this.d.toString();
    }

    toJSON() { return this.toString(); }
  }

  const api = { Frac, gcd: bigGcd };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') {
    globalThis.RKS = globalThis.RKS || {};
    Object.assign(globalThis.RKS, api);
  }
})();
