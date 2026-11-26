// Exact rational arithmetic on BigInt. Every fraction is kept reduced with d > 0.
function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Fraction {
  constructor(n, d = 1n, reduce = true) {
    if (typeof n === 'number') n = BigInt(n);
    if (typeof d === 'number') d = BigInt(d);
    if (d === 0n) throw new Error('Fraction: zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    if (reduce) {
      if (n !== 0n) {
        const g = gcd(n, d);
        n /= g;
        d /= g;
      } else {
        d = 1n;
      }
    }
    this.n = n;
    this.d = d;
  }
  // Raw constructor: skips gcd. Used inside hot clipping loops where the
  // operands are known positive and a final reduction happens once per cell.
  static raw(n, d) {
    if (d < 0n) { n = -n; d = -d; }
    const f = Object.create(Fraction.prototype);
    f.n = n; f.d = d;
    return f;
  }
  reduce() {
    if (this.n === 0n) { this.d = 1n; return this; }
    const g = gcd(this.n, this.d);
    this.n /= g; this.d /= g;
    return this;
  }
  static from(n, d) { return new Fraction(n, d); }
  static int(k) { return new Fraction(BigInt(k), 1n); }
  static ZERO = new Fraction(0n, 1n);
  static ONE = new Fraction(1n, 1n);

  isZero() { return this.n === 0n; }
  neg() { return Fraction.raw(-this.n, this.d); }
  abs() { return this.n < 0n ? this.neg() : this; }
  add(o) { return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Fraction(this.n * o.n, this.d * o.d); }
  div(o) {
    if (o.n === 0n) throw new Error('Fraction: division by zero');
    return new Fraction(this.n * o.d, this.d * o.n);
  }
  // Unreduced variants for hot clipping/integration loops. The caller must
  // reduce() any value that escapes the loop or feeds a comparison decision
  // that needs canonical form; cmp/eq work fine on unreduced fractions.
  addR(o) { return Fraction.raw(this.n * o.d + o.n * this.d, this.d * o.d); }
  subR(o) { return Fraction.raw(this.n * o.d - o.n * this.d, this.d * o.d); }
  mulR(o) { return Fraction.raw(this.n * o.n, this.d * o.d); }
  divR(o) {
    if (o.n === 0n) throw new Error('Fraction: division by zero');
    return Fraction.raw(this.n * o.d, this.d * o.n);
  }
  cmp(o) {
    const l = this.n * o.d, r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) { return this.n === o.n && this.d === o.d; }
  floor() {
    const q = this.n / this.d; // truncates toward zero
    return this.n < 0n && this.n % this.d !== 0n ? q - 1n : q;
  }
  ceil() {
    const q = this.n / this.d;
    return this.n > 0n && this.n % this.d !== 0n ? q + 1n : q;
  }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return `${this.n}/${this.d}`; }
  // Fixed-precision decimal for display only; exact values stay fractions.
  toDecimal(digits = 12) {
    const neg = this.n < 0n;
    let n = neg ? -this.n : this.n;
    const whole = n / this.d;
    let rem = n % this.d;
    let out = whole.toString();
    if (digits > 0 && rem !== 0n) {
      let frac = '';
      for (let i = 0; i < digits && rem !== 0n; i++) {
        rem *= 10n;
        frac += (rem / this.d).toString();
        rem %= this.d;
      }
      // round half-up at the cutoff
      if (rem !== 0n) {
        rem *= 10n;
        if (rem / this.d >= 5n) {
          let f = BigInt(frac) + 1n;
          frac = f.toString().padStart(frac.length, '0');
        }
      }
      out += '.' + frac;
    }
    return (neg && this.n !== 0n ? '-' : '') + out;
  }
}

export const frac = (n, d) => new Fraction(n, d);
