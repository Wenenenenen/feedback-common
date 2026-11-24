// pyramid.js — 源轨统计金字塔
//
// 每个源轨、每个声道存一棵分层汇总树：
//   L1 叶子每块 LEAF=256 帧；其上每层块大小翻倍。
// 每节点记录 min / max / count / sumSq：
//   - L1 平方和 ≤ 256 × 32767² ≈ 2.73e11 < 2^53，用 Float64 即可逐样本精确累加；
//   - L2 及以上用 BigInt64，任意总长（≤ 2^31-1 帧）平方和都精确，最终十进制字符串导出。
// 区间查询按“对齐最大整块”贪心下降，单次查询 O(块数 + log 层数 + 2×LEAF 尾巴)。

export const LEAF_SHIFT = 8;
export const LEAF = 1 << LEAF_SHIFT; // 256
export const LEAF_MASK = LEAF - 1;
const INT_MIN = -32768;
const INT_MAX = 32767;

export function emptyStat() {
  return null;
}

export function mergeStat(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return {
    min: a.min < b.min ? a.min : b.min,
    max: a.max > b.max ? a.max : b.max,
    count: a.count + b.count,
    sumSq: a.sumSq + b.sumSq,
  };
}

// 静音帧：计入零样本（min=max=0），count 照常增加
export function zeroStat(count) {
  return { min: 0, max: 0, count, sumSq: 0n };
}

function buildLevel1(pcm) {
  const n = pcm.length;
  const nodes = Math.ceil(n / LEAF);
  const min = new Int32Array(nodes).fill(INT_MAX);
  const max = new Int32Array(nodes).fill(INT_MIN);
  const count = new Int32Array(nodes);
  const sumSq = new Float64Array(nodes);
  for (let i = 0; i < n; i++) {
    const k = i >> LEAF_SHIFT;
    const v = pcm[i];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
    count[k]++;
    sumSq[k] += v * v; // 每个 v*v ≤ 2^30，块内总和 < 2^53，浮点精确
  }
  return { size: LEAF, nodes, min, max, count, sumSq, big: false };
}

function buildUpper(lower, n) {
  const size = lower.size * 2;
  const nodes = Math.ceil(n / size);
  const min = new Int32Array(nodes).fill(INT_MAX);
  const max = new Int32Array(nodes).fill(INT_MIN);
  const count = new Int32Array(nodes);
  const sumSq = new BigInt64Array(nodes);
  for (let k = 0; k < nodes; k++) {
    const l = k * 2;
    const r = l + 1;
    let lo = lower.min[l];
    let hi = lower.max[l];
    let cn = lower.count[l];
    let ss = lower.big ? lower.sumSq[l] : BigInt(lower.sumSq[l]);
    if (r < lower.nodes) {
      if (lower.min[r] < lo) lo = lower.min[r];
      if (lower.max[r] > hi) hi = lower.max[r];
      cn += lower.count[r];
      ss += lower.big ? lower.sumSq[r] : BigInt(lower.sumSq[r]);
    }
    min[k] = lo;
    max[k] = hi;
    count[k] = cn;
    sumSq[k] = ss;
  }
  return { size, nodes, min, max, count, sumSq, big: true };
}

export class SourcePyramid {
  /**
   * @param {Int16Array[]} channels frames[ch]，双声道
   * @param {number} frameCount
   * @param {string} name
   */
  constructor(channels, frameCount, name) {
    this.name = name;
    this.frameCount = frameCount;
    this.levelsPerChannel = channels.map((pcm) => {
      const levels = [buildLevel1(pcm)];
      while (levels[levels.length - 1].nodes > 1) {
        levels.push(buildUpper(levels[levels.length - 1], pcm.length));
      }
      return levels;
    });
    this.pcm = channels;
  }

  // 取单帧原始值（逐帧定位用）
  sample(channel, frame) {
    return this.pcm[channel][frame];
  }

  /**
   * 前向半开区间 [start, end) 的精确统计；空区间返回 null。
   * 倒序由调用方把拼接位置映射成源区间后再查询，金字塔不感知顺序。
   */
  query(channel, start, end) {
    if (end <= start) return null;
    const n = this.frameCount;
    if (start < 0 || end > n) throw new RangeError(`金字塔查询越界: [${start}, ${end}) / ${n}`);
    const levels = this.levelsPerChannel[channel];
    const pcm = this.pcm[channel];

    let min = INT_MAX;
    let max = INT_MIN;
    let count = 0;
    let sumSq = 0n;
    let rawSq = 0; // 尾巴原始样本先用 Number 累加（量 < 2^53），最后转 BigInt
    const addRaw = (v) => {
      if (v < min) min = v;
      if (v > max) max = v;
      count++;
      rawSq += v * v;
    };
    const addNode = (levelIdx, node) => {
      const lvl = levels[levelIdx];
      if (lvl.min[node] < min) min = lvl.min[node];
      if (lvl.max[node] > max) max = lvl.max[node];
      count += lvl.count[node];
      sumSq += lvl.big ? lvl.sumSq[node] : BigInt(lvl.sumSq[node]);
    };

    let pos = start;
    // 头部：对齐到叶子边界之前的散样本
    while (pos < end && (pos & LEAF_MASK) !== 0) addRaw(pcm[pos++]);

    while (pos < end) {
      let levelIdx = 0;
      let size = LEAF;
      let node = pos >> LEAF_SHIFT;
      // 连一个完整叶子都取不了（末尾碎块/查询尾巴）→ 逐样本
      if (node * LEAF + LEAF > n || pos + LEAF > end) {
        addRaw(pcm[pos++]);
        continue;
      }
      // 贪心爬升到起点对齐、且完整落在数据与查询区间内的最大节点
      while (true) {
        const parentNode = node >> 1;
        const parentSize = size * 2;
        const parentStart = parentNode * parentSize;
        if (parentStart !== pos) break;
        if (parentStart + parentSize > n || pos + parentSize > end) break;
        levelIdx++;
        size = parentSize;
        node = parentNode;
      }
      addNode(levelIdx, node);
      pos += size;
    }

    if (count === 0) return null;
    sumSq += BigInt(rawSq);
    return { min, max, count, sumSq };
  }
}
