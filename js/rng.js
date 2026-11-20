// 线性同余随机数：state = (1664525*state + 1013904223) mod 2^32，取 state / 2^32
// 全部运算用 uint32 数学（Math.imul + >>>0），保证与语言无关的确定性轨迹。
export class LCG {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  // 先推进状态，再返回 [0,1) 浮点
  next() {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  snapshot() {
    return this.state >>> 0;
  }
}
