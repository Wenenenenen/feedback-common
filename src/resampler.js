// 多相重采样引擎：零群延迟有理比 L/M 转换，流式分块、可取消。
// 分块只决定调度，不影响数值：任何分块大小的结果与整段一次处理完全一致。
//
// 约定（样例包 格式说明.md）：
//   输出第 m 个样本对应时刻 m/fo，取输入在位置 m·fi/fo 处的带限重建值。
//   约分 L/M = fo/fi，故输入域分数位置 x_m = m·M/L = i + k/L，
//   i = floor(x_m)，分支索引 k = m·M - i·L ∈ [0, L)。

/**
 * 每声道样本缓冲。有效样本始终从物理槽 0 连续存放，逻辑索引区间 [base, total)。
 * compact(keepFrom) 丢弃 keepFrom 之前的样本；容量为 2 的幂，自动扩缩。
 */
class Ring {
  constructor() {
    this.cap = 1024;
    this.buf = new Float64Array(this.cap);
    this.base = 0;
    this.total = 0;
  }

  get count() {
    return this.total - this.base;
  }

  ensure(extra) {
    let cap = this.cap;
    while (cap < this.count + extra) cap <<= 1;
    if (cap === this.cap) return;
    const next = new Float64Array(cap);
    next.set(this.buf.subarray(0, this.count));
    this.buf = next;
    this.cap = cap;
  }

  push(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.count);
    this.total += arr.length;
  }

  /** 丢弃绝对索引 keepFrom 之前的样本。 */
  compact(keepFrom) {
    if (keepFrom <= this.base) return;
    const drop = Math.min(keepFrom - this.base, this.count);
    if (drop <= 0) return;
    this.buf.copyWithin(0, drop, this.count);
    this.base += drop;

    let cap = 1024;
    while (cap < this.count * 2) cap <<= 1;
    if (cap < this.cap) {
      const next = new Float64Array(cap);
      next.set(this.buf.subarray(0, this.count));
      this.buf = next;
      this.cap = cap;
    }
  }

  /** 读取绝对索引 idx 的样本；越界（输入两端之外）按 0 处理。 */
  get(idx) {
    if (idx < 0 || idx >= this.total) return 0;
    const slot = idx - this.base;
    if (slot < 0) throw new Error('环形缓冲已压缩，请求的样本已不存在');
    return this.buf[slot];
  }
}

export class PolyphaseResampler {
  /**
   * @param design designResampler() 的返回值
   * @param channels 声道数
   */
  constructor(design, channels) {
    this.d = design;
    this.channels = channels;
    this.rings = [];
    for (let c = 0; c < channels; c++) this.rings.push(new Ring());
    this.mOut = 0; // 已产出的输出样本数
    this.Nin = 0; // 已 push 的输入帧数
    this.P = design.P;
    this.L = design.L;
    this.M = design.M;
    this.half = design.P / 2;
  }

  /** 追加一整块输入帧（每声道一个 TypedArray）。 */
  pushInput(channelChunks) {
    for (let c = 0; c < this.channels; c++) this.rings[c].push(channelChunks[c]);
    this.Nin += channelChunks[0].length;
  }

  /**
   * 生成当前输入足以完整计算的输出帧（所有抽头都落在已到达的输入范围内）。
   * 越界输入在 Ring.get 中按 0 处理，但本方法只产出完整窗口可用的部分；
   * 末端不足的部分由 flush() 补零产出。
   */
  pullAvailable() {
    // 最大抽头输入索引 i + (P/2-1) <= Nin-1  =>  i <= Nin - P/2
    const maxI = this.Nin - this.half;
    if (maxI < 0) return this._emptyOut();
    // floor(m·M/L) <= maxI  <=>  m·M < (maxI+1)·L
    // 最大整数 m = ceil((maxI+1)·L/M) - 1
    const mMax = Math.ceil(((maxI + 1) * this.L) / this.M) - 1;
    if (mMax < this.mOut) return this._emptyOut();
    return this._produce(mMax);
  }

  /** 结束：按输入末端之外为 0，产出全部剩余输出，共 ceil(Nin·L/M) 帧。 */
  flush() {
    const totalOut = Math.ceil((this.Nin * this.L) / this.M);
    if (this.mOut >= totalOut) return this._emptyOut();
    return this._produce(totalOut - 1);
  }

  _emptyOut() {
    const out = [];
    for (let c = 0; c < this.channels; c++) out.push(new Float64Array(0));
    return out;
  }

  _produce(mMax) {
    const { L, M, P, coefs } = this.d;
    const half = P / 2;
    const count = mMax - this.mOut + 1;
    const outs = [];
    for (let c = 0; c < this.channels; c++) outs.push(new Float64Array(count));

    let keepFrom = Infinity;

    for (let n = 0; n < count; n++) {
      const m = this.mOut + n;
      // 输入域分数位置 x_m = m·M/L = i + k/L
      const mM = m * M;
      const i = Math.floor(mM / L);
      const k = mM - i * L; // 0..L-1，分支索引
      const h = coefs[k];
      for (let c = 0; c < this.channels; c++) {
        const ring = this.rings[c];
        let acc = 0;
        // h[qi] 对应输入偏移 (qi-half)
        for (let qi = 0; qi < P; qi++) {
          const hq = h[qi];
          if (hq !== 0) acc += hq * ring.get(i + qi - half);
        }
        outs[c][n] = acc;
      }
      if (i - half < keepFrom) keepFrom = i - half;
    }

    // 本次最早用到的输入索引之前的数据可以压缩
    if (Number.isFinite(keepFrom) && keepFrom > 0) {
      for (let c = 0; c < this.channels; c++) this.rings[c].compact(keepFrom);
    }
    this.mOut = mMax + 1;
    return outs;
  }
}

/** 整段一次处理的便捷接口。 */
export function resampleAll(design, channelData, { onProgress, shouldCancel } = {}) {
  const channels = channelData.length;
  const rs = new PolyphaseResampler(design, channels);
  rs.pushInput(channelData);
  const totalOut = Math.ceil((channelData[0].length * design.L) / design.M);
  const result = [];
  for (let c = 0; c < channels; c++) result.push(new Float64Array(totalOut));
  const part = rs.flush();
  for (let c = 0; c < channels; c++) result[c].set(part[c]);
  if (onProgress) onProgress(1);
  if (shouldCancel && shouldCancel()) throw new Error('CANCELLED');
  return result;
}
