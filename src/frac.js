// 精确有理数：BigInt 分子/分母，分母恒正、约分
export class Frac {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error('zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    if (n !== 0n) {
      const g = gcd(n < 0n ? -n : n, d);
      n /= g; d /= g;
    } else {
      d = 1n;
    }
    this.n = n; this.d = d;
  }
  static ZERO = new Frac(0n);
  static ONE = new Frac(1n);
  static fromInt(i) { return new Frac(BigInt(i)); }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(o) { return new Frac(this.n * o.d, this.d * o.n); }
  neg() { return new Frac(-this.n, this.d); }
  abs() { return this.n < 0n ? this.neg() : this; }
  inv() { return new Frac(this.d, this.n); }
  cmp(o) {
    const l = this.n * o.d, r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  sign() { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0; }
  eq(o) { return this.cmp(o) === 0; }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}

export function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

export const f0 = Frac.ZERO;
export const f1 = Frac.ONE;
