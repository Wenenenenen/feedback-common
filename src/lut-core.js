// 反查调色表校样 —— 纯算法核心（无 DOM 依赖，可在 Node / 浏览器中运行）
// 所有插值使用精确整数有理数运算，逐通道半值向上取整，杜绝浮点边界歧义。

'use strict';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function fail(field, message) {
  const err = new Error(`${field}：${message}`);
  err.field = field;
  return err;
}

// 非负数精确四舍五入（半值向上取整）：round_half_up(num / den)
function roundHalfUp(num, den) {
  const q = Math.floor(num / den);
  const r = num - q * den;
  return r * 2 >= den ? q + 1 : q;
}

// ---------------------------------------------------------------------------
// 表解析与校验
// ---------------------------------------------------------------------------

function validateTable(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw fail('表', '必须是 JSON 对象');
  }

  // axes
  const { axes } = obj;
  if (!Array.isArray(axes) || axes.length !== 3) {
    throw fail('axes', '必须是按 RGB 排列的 3 个数组');
  }
  const axisCounts = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const ax = axes[a];
    const name = `axes[${'RGB'[a]}]`;
    if (!Array.isArray(ax)) throw fail(name, '必须是数组');
    if (ax.length < 2 || ax.length > 64) {
      throw fail(name, '节点数必须在 2 到 64 之间');
    }
    for (const v of ax) {
      if (!isInt(v)) throw fail(name, '节点必须是整数');
    }
    if (ax[0] !== 0 || ax[ax.length - 1] !== 63) {
      throw fail(name, '首尾节点必须为 0 和 63');
    }
    for (let i = 1; i < ax.length; i++) {
      if (!(ax[i] > ax[i - 1])) {
        throw fail(name, '节点必须严格递增');
      }
    }
    axisCounts[a] = ax.length;
  }

  // nodes
  const totalNodes = axisCounts[0] * axisCounts[1] * axisCounts[2];
  const { nodes } = obj;
  if (!Array.isArray(nodes)) {
    throw fail('nodes', '必须是 RGB 字节三元组列表');
  }
  if (nodes.length !== totalNodes) {
    throw fail('nodes', `节点数应为 ${totalNodes}（各轴节点数之积），实际为 ${nodes.length}`);
  }
  const flat = new Uint8Array(totalNodes * 3);
  for (let i = 0; i < totalNodes; i++) {
    const t = nodes[i];
    if (!Array.isArray(t) || t.length !== 3) {
      throw fail(`nodes[${i}]`, '必须是 RGB 三元组');
    }
    for (let c = 0; c < 3; c++) {
      const v = t[c];
      if (!isInt(v) || v < 0 || v > 255) {
        throw fail(`nodes[${i}][${'RGB'[c]}]`, '必须是 0 到 255 的整数字节');
      }
      flat[i * 3 + c] = v;
    }
  }

  const table = {
    axes: axes.map((ax) => Object.freeze(ax.slice())),
    axisCounts,
    nodes: flat,
  };

  // 可选参数：缺失时给默认值，存在但非法时报错并指出字段
  table.bounds = parseBounds(obj.bounds);
  table.anchor = parseAnchor(obj.anchor);
  table.weights = parseWeights(obj.weights);
  return table;
}

function parseBounds(raw) {
  if (raw === undefined) return [[0, 63], [0, 63], [0, 63]];
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw fail('bounds', '必须是 3 个含端点的区间');
  }
  const out = [];
  for (let a = 0; a < 3; a++) {
    const b = raw[a];
    const name = `bounds[${'RGB'[a]}]`;
    if (!Array.isArray(b) || b.length !== 2 || !isInt(b[0]) || !isInt(b[1])) {
      throw fail(name, '必须是 [下界, 上界] 两个整数');
    }
    if (b[0] < 0 || b[0] > 63 || b[1] < 0 || b[1] > 63) {
      throw fail(name, '区间端点必须在 0 到 63 之间');
    }
    if (b[0] > b[1]) {
      throw fail(name, '下界不能大于上界');
    }
    out.push([b[0], b[1]]);
  }
  return out;
}

function parseAnchor(raw) {
  if (raw === undefined) return [32, 32, 32];
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw fail('anchor', '必须是参考 RGB 码三元组');
  }
  for (let a = 0; a < 3; a++) {
    if (!isInt(raw[a]) || raw[a] < 0 || raw[a] > 63) {
      throw fail(`anchor[${'RGB'[a]}]`, '必须是 0 到 63 的整数');
    }
  }
  return [raw[0], raw[1], raw[2]];
}

function parseWeights(raw) {
  if (raw === undefined) return [1, 1, 1];
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw fail('weights', '必须是 3 个通道权重');
  }
  for (let a = 0; a < 3; a++) {
    if (!isInt(raw[a]) || raw[a] < 1 || raw[a] > 8) {
      throw fail(`weights[${'RGB'[a]}]`, '必须是 1 到 8 的整数');
    }
  }
  return [raw[0], raw[1], raw[2]];
}

// ---------------------------------------------------------------------------
// 正向四面体插值（精确整数）
// ---------------------------------------------------------------------------

// 找到 code 在轴上的区间索引 i，使 axes[i] <= code <= axes[i+1]；code==63 取末段
function locateInterval(ax, code) {
  let lo = 0;
  const hi = ax.length - 1;
  if (code >= ax[hi]) return hi - 1;
  let high = hi;
  while (high - lo > 1) {
    const mid = (lo + high) >> 1;
    if (ax[mid] <= code) lo = mid;
    else high = mid;
  }
  return lo;
}

// 单次正向插值，返回 [R,G,B]（0..255，已逐通道半值向上取整）
function forward(table, r, g, b) {
  const { axes, axisCounts, nodes } = table;
  const codes = [r, g, b];

  const seg = [0, 0, 0];
  const num = [0, 0, 0];
  const den = [0, 0, 0];

  for (let a = 0; a < 3; a++) {
    const i = locateInterval(axes[a], codes[a]);
    const x0 = axes[a][i];
    const x1 = axes[a][i + 1];
    seg[a] = i;
    num[a] = codes[a] - x0;
    den[a] = x1 - x0;
  }

  // 按分数降序排轴，平分按 RGB 轴序（0 < 1 < 2）
  const order = [0, 1, 2];
  order.sort((a, c) => {
    const lhs = num[a] * den[c];
    const rhs = num[c] * den[a];
    if (lhs !== rhs) return lhs > rhs ? -1 : 1;
    return a - c;
  });
  const [s0, s1, s2] = order;

  const nR = axisCounts[1] * axisCounts[2];
  const nG = axisCounts[2];
  const nodeIndex = (ir, ig, ib) => ir * nR + ig * nG + ib;
  const i000 = nodeIndex(seg[0], seg[1], seg[2]);
  const i111 = nodeIndex(seg[0] + 1, seg[1] + 1, seg[2] + 1);

  // 四面体四个角：V000、沿 s0、沿 s0+s1、V111
  const mask1 = 1 << s0;
  const mask2 = mask1 | (1 << s1);
  const cornerIndex = (mask) =>
    nodeIndex(
      seg[0] + ((mask >> 0) & 1),
      seg[1] + ((mask >> 1) & 1),
      seg[2] + ((mask >> 2) & 1)
    );
  const c0 = i000;
  const c1 = cornerIndex(mask1);
  const c2 = cornerIndex(mask2);
  const c3 = i111;

  // 公共分母 D = denR*denG*denB；权重 1, q0, q1, q2（q 为排序后的分数）
  const D = den[0] * den[1] * den[2];
  const t0 = (num[s0] * D) / den[s0];
  const t1 = (num[s1] * D) / den[s1];
  const t2 = (num[s2] * D) / den[s2];
  const w0 = D - t0;
  const w1 = t0 - t1;
  const w2 = t1 - t2;
  const w3 = t2;

  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const numerator =
      nodes[c0 * 3 + ch] * w0 +
      nodes[c1 * 3 + ch] * w1 +
      nodes[c2 * 3 + ch] * w2 +
      nodes[c3 * 3 + ch] * w3;
    out[ch] = roundHalfUp(numerator, D);
  }
  return out;
}

// ---------------------------------------------------------------------------
// P6 读写
// ---------------------------------------------------------------------------

function parseP6(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pos = 0;

  function skipWs() {
    while (pos < u8.length) {
      const c = u8[pos];
      if (c === 35) {
        while (pos < u8.length && u8[pos] !== 10) pos++;
      } else if (c === 32 || c === 9 || c === 10 || c === 13) {
        pos++;
      } else {
        break;
      }
    }
  }

  function readToken() {
    skipWs();
    const start = pos;
    while (pos < u8.length) {
      const c = u8[pos];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 35) break;
      pos++;
    }
    if (pos === start) throw fail('P6', '头部格式不完整');
    return new TextDecoder('ascii').decode(u8.subarray(start, pos));
  }

  const magic = readToken();
  if (magic !== 'P6') throw fail('P6', '魔数必须为 P6');
  const width = Number(readToken());
  const height = Number(readToken());
  const maxval = Number(readToken());
  if (!Number.isInteger(width) || width <= 0) throw fail('P6', '宽度非法');
  if (!Number.isInteger(height) || height <= 0) throw fail('P6', '高度非法');
  if (width > 512 || height > 512) throw fail('P6', '图像尺寸不能超过 512×512');
  if (maxval !== 255) throw fail('P6', '仅支持最大值 255 的 8 位 P6');

  skipWs();
  const dataLen = width * height * 3;
  if (u8.length - pos < dataLen) {
    throw fail('P6', `像素数据不完整：需要 ${dataLen} 字节，剩余 ${u8.length - pos} 字节`);
  }
  const data = u8.slice(pos, pos + dataLen);
  return { width, height, rgb: data };
}

// rgb: Uint8Array，长度 width*height*3；码值原样写入（0..63 也是合法字节，不拉伸）
function encodeP6(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw fail('P6', '像素数据长度与尺寸不符');
  }
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + rgb.length);
  out.set(header, 0);
  out.set(rgb, header.length);
  return out;
}

// ---------------------------------------------------------------------------
// KD-Tree（输出 RGB 空间，精确最近邻 + 确定性平局规则）
// ---------------------------------------------------------------------------

function packKey(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

// 就地 nth_element：重排 idx，使 idx[k] 为按 axis 排序后第 k 小，左右分区
function nthElement(idx, pts, axis, k, lo, hi) {
  while (lo < hi) {
    // 三点取中作为 pivot
    const mid = (lo + hi) >> 1;
    const a = pts[idx[lo]][axis];
    const b = pts[idx[mid]][axis];
    const c = pts[idx[hi - 1]][axis];
    let pivot = b;
    if (a < b) {
      if (c < a) pivot = a;
      else if (c < b) pivot = c;
    } else if (c > a) {
      pivot = a;
    } else if (c > b) {
      pivot = c;
    }

    // 三路分区：[lo, lt) < pv；[lt, gt) == pv；[gt, hi) > pv
    let lt = lo;
    let gt = hi;
    let i = lo;
    while (i < gt) {
      const v = pts[idx[i]][axis];
      if (v < pivot) {
        const t = idx[lt];
        idx[lt] = idx[i];
        idx[i] = t;
        lt++;
        i++;
      } else if (v > pivot) {
        gt--;
        const t = idx[gt];
        idx[gt] = idx[i];
        idx[i] = t;
      } else {
        i++;
      }
    }

    if (k < lt) {
      hi = lt;
    } else if (k >= gt) {
      lo = gt;
    } else {
      return;
    }
  }
}

function buildTree(idx, pts, lo, hi, depth, store) {
  if (lo >= hi) return -1;
  const axis = depth % 3;
  const mid = (lo + hi) >> 1;
  nthElement(idx, pts, axis, mid, lo, hi);
  const point = idx[mid];

  const left = buildTree(idx, pts, lo, mid, depth + 1, store);
  const right = buildTree(idx, pts, mid + 1, hi, depth + 1, store);

  const node = { point, axis, left, right, min: [0, 0, 0], max: [0, 0, 0] };
  for (let ch = 0; ch < 3; ch++) {
    let mn = pts[point][ch];
    let mx = mn;
    if (left >= 0) {
      mn = Math.min(mn, store[left].min[ch]);
      mx = Math.max(mx, store[left].max[ch]);
    }
    if (right >= 0) {
      mn = Math.min(mn, store[right].min[ch]);
      mx = Math.max(mx, store[right].max[ch]);
    }
    node.min[ch] = mn;
    node.max[ch] = mx;
  }
  store.push(node);
  return store.length - 1;
}

// ---------------------------------------------------------------------------
// 反查求解器
// ---------------------------------------------------------------------------

class InverseSolver {
  // table: validateTable 的结果；bounds/anchor/weights 为当前表单值
  constructor(table, bounds, anchor, weights) {
    this.table = table;
    this.bounds = bounds.map((b) => b.slice());
    this.anchor = anchor.slice();
    this.weights = weights.slice();
    this._build();
  }

  _build() {
    const [bR, bG, bB] = this.bounds;
    const total =
      (bR[1] - bR[0] + 1) * (bG[1] - bG[0] + 1) * (bB[1] - bB[0] + 1);

    // 输出色 -> 全部输入码编号；三重循环 B 最快，码按 RGB 字典序自然递增
    this.buckets = new Map();
    const codeList = new Uint8Array(total * 3);
    let n = 0;
    for (let r = bR[0]; r <= bR[1]; r++) {
      for (let g = bG[0]; g <= bG[1]; g++) {
        for (let b = bB[0]; b <= bB[1]; b++) {
          const out = forward(this.table, r, g, b);
          const key = packKey(out[0], out[1], out[2]);
          let bucket = this.buckets.get(key);
          if (!bucket) {
            bucket = [];
            this.buckets.set(key, bucket);
          }
          bucket.push(n);
          codeList[n * 3] = r;
          codeList[n * 3 + 1] = g;
          codeList[n * 3 + 2] = b;
          n++;
        }
      }
    }
    this.codeList = codeList;
    this.candidateCount = n;

    this._recomputeBucketBest();

    // 每个不同输出色一个 KD 点，代表该桶当前最优码
    const pts = [];
    this.repCodes = [];
    for (const [key, bucket] of this.buckets) {
      pts.push([(key >> 16) & 255, (key >> 8) & 255, key & 255]);
      this.repCodes.push(bucket[0]);
    }
    this.pts = pts;

    const idx = pts.map((_, i) => i);
    const store = [];
    this.treeRoot = buildTree(idx, pts, 0, pts.length, 0, store);
    this.treeNodes = store;

    this.queryCache = new Map();
  }

  // anchor 改变：只需重选每桶最优码（权重不影响码选择，只影响误差度量）
  _recomputeBucketBest() {
    for (const bucket of this.buckets.values()) {
      // 桶内码按字典序；找曼哈顿最小者，平分保留字典序最前者
      let bestIdx = 0;
      let bestD = this._manhattan(bucket[0]);
      for (let i = 1; i < bucket.length; i++) {
        const d = this._manhattan(bucket[i]);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const saved = bucket[bestIdx];
      if (bestIdx !== 0) {
        bucket.splice(bestIdx, 1);
        bucket.unshift(saved);
      }
    }
  }

  _manhattan(codeIdx) {
    const c = this.codeList;
    const o = codeIdx * 3;
    return (
      Math.abs(c[o] - this.anchor[0]) +
      Math.abs(c[o + 1] - this.anchor[1]) +
      Math.abs(c[o + 2] - this.anchor[2])
    );
  }

  setAnchor(anchor) {
    this.anchor = anchor.slice();
    this._recomputeBucketBest();
    let i = 0;
    for (const bucket of this.buckets.values()) {
      this.repCodes[i++] = bucket[0];
    }
    this.queryCache.clear();
  }

  setWeights(weights) {
    this.weights = weights.slice();
    this.queryCache.clear();
  }

  // 目标 RGB -> 最优输入码 [r,g,b]；全局最优，平局按 曼哈顿 -> 字典序
  query(tR, tG, tB) {
    const key = packKey(tR, tG, tB);
    const cached = this.queryCache.get(key);
    if (cached !== undefined) return cached;

    let bestCode;
    const exact = this.buckets.get(key);
    if (exact) {
      // 输出精确命中：桶首已是该桶按平局规则选出的全局最优码
      bestCode = exact[0];
    } else {
      bestCode = this._treeSearch(tR, tG, tB);
    }
    const c = this.codeList;
    const result = [c[bestCode * 3], c[bestCode * 3 + 1], c[bestCode * 3 + 2]];
    this.queryCache.set(key, result);
    return result;
  }

  _treeSearch(tR, tG, tB) {
    const w = this.weights;
    const nodes = this.treeNodes;
    const pts = this.pts;
    const target = [tR, tG, tB];
    let bestPoint = -1;
    let bestDist = Infinity;

    const boxLowerBound = (node) => {
      let d = 0;
      for (let c = 0; c < 3; c++) {
        let delta = 0;
        if (target[c] < node.min[c]) delta = node.min[c] - target[c];
        else if (target[c] > node.max[c]) delta = target[c] - node.max[c];
        if (delta) d += w[c] * delta * delta;
      }
      return d;
    };

    const visit = (ni) => {
      if (ni < 0) return;
      const node = nodes[ni];
      if (bestPoint >= 0 && boxLowerBound(node) > bestDist) return;

      const p = pts[node.point];
      const d =
        w[0] * (p[0] - tR) * (p[0] - tR) +
        w[1] * (p[1] - tG) * (p[1] - tG) +
        w[2] * (p[2] - tB) * (p[2] - tB);

      if (bestPoint < 0 || d < bestDist) {
        bestDist = d;
        bestPoint = node.point;
      } else if (d === bestDist) {
        const candCode = this.repCodes[node.point];
        const bestCode = this.repCodes[bestPoint];
        const mCand = this._manhattan(candCode);
        const mBest = this._manhattan(bestCode);
        let take = false;
        if (mCand < mBest) {
          take = true;
        } else if (mCand === mBest) {
          const cc = this.codeList;
          const o1 = candCode * 3;
          const o2 = bestCode * 3;
          for (let a = 0; a < 3; a++) {
            if (cc[o1 + a] !== cc[o2 + a]) {
              take = cc[o1 + a] < cc[o2 + a];
              break;
            }
          }
        }
        if (take) bestPoint = node.point;
      }

      const delta = target[node.axis] - p[node.axis];
      if (delta <= 0) {
        visit(node.left);
        visit(node.right);
      } else {
        visit(node.right);
        visit(node.left);
      }
    };

    visit(this.treeRoot);
    return this.repCodes[bestPoint];
  }

  // 批量反查（异步分块），onProgress(done, total)；signal.cancelled 可中止
  async solveImage(rgb, onProgress, signal) {
    const n = rgb.length / 3;
    const codes = new Uint8Array(n * 3);
    const chunk = 4096;
    for (let i = 0; i < n; i += chunk) {
      if (signal && signal.cancelled) throw new Error('CANCELLED');
      const end = Math.min(i + chunk, n);
      for (let p = i; p < end; p++) {
        const o = p * 3;
        const code = this.query(rgb[o], rgb[o + 1], rgb[o + 2]);
        codes[o] = code[0];
        codes[o + 1] = code[1];
        codes[o + 2] = code[2];
      }
      if (onProgress) onProgress(end, n);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return codes;
  }
}

export {
  validateTable,
  parseBounds,
  parseAnchor,
  parseWeights,
  forward,
  locateInterval,
  roundHalfUp,
  parseP6,
  encodeP6,
  InverseSolver,
  packKey,
};
