// 精确有理数：全部工作量/速度/倍率用 BigInt 分数，杜绝浮点近似。
// 分数以最简形式保存，分母恒为正数；零保存为 0/1。

export class Fraction {
  constructor(n, d = 1n) {
    if (typeof n === 'number') n = BigInt(n);
    if (typeof d === 'number') d = BigInt(d);
    if (d === 0n) throw new Error('fraction denominator is zero');
    if (n === 0n) d = 1n;
    if (d < 0n) { n = -n; d = -d; }
    if (n !== 0n) {
      const g = gcdAbs(n, d);
      n /= g;
      d /= g;
    }
    this.n = n;
    this.d = d;
  }

  static ZERO = new Fraction(0n, 1n);
  static ONE = new Fraction(1n, 1n);

  static from(x) {
    if (x instanceof Fraction) return x;
    if (Array.isArray(x)) return new Fraction(BigInt(x[0]), BigInt(x[1]));
    if (typeof x === 'bigint') return new Fraction(x, 1n);
    if (typeof x === 'number') return new Fraction(BigInt(x), 1n);
    throw new Error(`cannot make Fraction from ${x}`);
  }

  add(o) {
    o = Fraction.from(o);
    return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    o = Fraction.from(o);
    return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o) {
    o = Fraction.from(o);
    return new Fraction(this.n * o.n, this.d * o.d);
  }
  div(o) {
    o = Fraction.from(o);
    return new Fraction(this.n * o.d, this.d * o.n);
  }
  neg() { return new Fraction(-this.n, this.d); }

  cmp(o) {
    o = Fraction.from(o);
    const l = this.n * o.d, r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  lt(o) { return this.cmp(o) < 0; }
  lte(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  gte(o) { return this.cmp(o) >= 0; }
  eq(o) { return this.cmp(o) === 0; }
  isZero() { return this.n === 0n; }
  isPositive() { return this.n > 0n; }

  // 向下取整（用于按工作量比例的资源退款）
  floor() {
    let q = this.n / this.d;
    if (this.n < 0n && this.n % this.d !== 0n) q -= 1n;
    return q;
  }

  // 序列化为 [p, q]，数字字符串保证 BigInt 无损
  toJSON() { return [this.n.toString(), this.d.toString()]; }

  // 展示用：精确分数串，以及最多保留若干位的十进制（仅显示用，不参与计算）
  toString() {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }
  toDecimal(maxDigits = 6) {
    const neg = this.n < 0n;
    const an = neg ? -this.n : this.n;
    const whole = an / this.d;
    let rem = an % this.d;
    if (rem === 0n) return (neg ? '-' : '') + whole.toString();
    let digits = '';
    let i = 0;
    while (rem !== 0n && i < maxDigits) {
      rem *= 10n;
      digits += (rem / this.d).toString();
      rem %= this.d;
      i++;
    }
    let s = whole.toString() + '.' + digits;
    if (rem !== 0n) s += '…';
    return (neg ? '-' : '') + s;
  }

  // 精确浮点（仅用于进度条等展示，不回写状态）
  toNumber() { return Number(this.n) / Number(this.d); }
}

function gcdAbs(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) { [a, b] = [b, a % b]; }
  return a;
}
