/*
 * QG01 四叉树限码归档核心。
 * 浏览器中挂到 window.QG01；Node/CommonJS 中可 require。
 * 不调用任何现成图像编码器。
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QG01 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  const MAGIC = 'QG01';
  const HEADER_BYTES = 10;
  const MIN_SIDE = 16;
  const MAX_SIDE = 512;
  const MIN_BUDGET = 10;
  const MAX_BUDGET = 4096;
  const INF = 1e100;

  class QG01Error extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = 'QG01Error';
      this.code = details.code || 'invalid-qg01';
      this.bitPosition = details.bitPosition ?? null;
      this.byteOffset = details.byteOffset ?? null;
      this.bitStart = details.bitStart ?? null;
      this.bitEnd = details.bitEnd ?? null;
      this.wantedBits = details.wantedBits ?? null;
      this.availableBits = details.availableBits ?? null;
      this.position = details.position ?? this.bitStart ?? this.bitPosition ?? this.byteOffset ?? null;
      this.offset = this.byteOffset;
    }

    positionText() {
      const parts = [];
      if (this.byteOffset !== null && this.byteOffset !== undefined) {
        parts.push(`字节偏移 ${this.byteOffset} (0x${this.byteOffset.toString(16).padStart(2, '0')})`);
      }
      if (this.bitStart !== null && this.bitStart !== undefined) {
        if (this.bitEnd !== null && this.bitEnd !== undefined) {
          parts.push(`载荷位区间 [${this.bitStart}, ${this.bitEnd})`);
        } else {
          parts.push(`载荷位 ${this.bitStart}`);
        }
      } else if (this.bitPosition !== null && this.bitPosition !== undefined) {
        parts.push(`载荷位 ${this.bitPosition}`);
      }
      return parts.join('，');
    }

    toReport() {
      const pos = this.positionText();
      return pos ? `${this.message}（位置：${pos}）` : this.message;
    }
  }

  function isPowerOfTwoSide(n) {
    return Number.isInteger(n) && n >= MIN_SIDE && n <= MAX_SIDE && (n & (n - 1)) === 0;
  }

  // 格式解码器允许更小的二次幂样例，便于直接验证 1×1 非法分支等位流边界；
  // 页面正式导入仍用 isPowerOfTwoSide 执行 16–512 的产品范围。
  function isDecodableSide(n) {
    return Number.isInteger(n) && n >= 1 && n <= MAX_SIDE && (n & (n - 1)) === 0;
  }

  function isAllowedBudget(n) {
    return Number.isInteger(n) && n >= MIN_BUDGET && n <= MAX_BUDGET;
  }

  function asUint8Array(data, name = 'data') {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return Uint8Array.from(data);
    throw new TypeError(`${name} 必须是字节数组`);
  }

  // ---------- P5 PGM ----------

  function isWhitespaceByte(c) {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  }

  function parsePGM(input) {
    const bytes = asUint8Array(input, 'PGM');
    let pos = 0;

    function readToken() {
      while (pos < bytes.length) {
        const c = bytes[pos];
        if (isWhitespaceByte(c)) { pos++; continue; }
        if (c === 0x23 /* # */) {
          while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
          continue;
        }
        break;
      }
      const start = pos;
      while (pos < bytes.length && !isWhitespaceByte(bytes[pos])) pos++;
      if (start === pos) throw new QG01Error('PGM 头部意外结束', { code: 'bad-pgm-header', byteOffset: pos });
      let s = '';
      for (let i = start; i < pos; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }

    const magic = readToken();
    if (magic !== 'P5') {
      throw new QG01Error(`仅支持二进制 P5 PGM，收到 ${magic || '空魔数'}`, { code: 'bad-pgm-magic', byteOffset: 0 });
    }
    const width = Number(readToken());
    const height = Number(readToken());
    const maxval = Number(readToken());

    // P5 规范：maxval 后恰好一个空白分隔符，随后立即是二进制像素。
    if (pos >= bytes.length || !isWhitespaceByte(bytes[pos])) {
      throw new QG01Error('PGM maxval 后缺少单个空白分隔符', { code: 'bad-pgm-header', byteOffset: pos });
    }
    pos += 1;

    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new QG01Error(`PGM 宽高非法：${width}×${height}`, { code: 'bad-pgm-dimensions' });
    }
    if (maxval !== 255) {
      throw new QG01Error(`仅支持 8 位 PGM（maxval=255），收到 maxval=${maxval}`, { code: 'bad-pgm-depth' });
    }
    const needed = width * height;
    if (bytes.length - pos < needed) {
      throw new QG01Error(`PGM 像素数据截断：需要 ${needed} 字节，实际剩余 ${bytes.length - pos}`, {
        code: 'truncated-pgm',
        byteOffset: bytes.length,
      });
    }
    const data = bytes.slice(pos, pos + needed);
    return { format: 'P5', width, height, maxval, data };
  }

  function validateGrayImage(image) {
    if (!image || !(image.data)) throw new TypeError('缺少灰度图像数据');
    const width = image.width;
    const height = image.height ?? width;
    const validSide = image.allowNonstandard
      ? Number.isInteger(width) && width >= 1 && width <= MAX_SIDE && (width & (width - 1)) === 0 && height === width
      : isPowerOfTwoSide(width) && height === width;
    if (!validSide) {
      throw new QG01Error(`边长必须是 ${MIN_SIDE} 到 ${MAX_SIDE} 的二次幂方形，收到 ${width}×${height}`, {
        code: 'bad-dimensions',
      });
    }
    const data = asUint8Array(image.data, 'pixels');
    if (data.length !== width * height) {
      throw new QG01Error(`灰度像素数应为 ${width * height}，实际为 ${data.length}`, { code: 'bad-pixel-count' });
    }
    return { width, height, data };
  }

  function normalizeMask(maskInput, width, height) {
    if (!maskInput) return null;
    let parsedData;
    if (maskInput instanceof Uint8Array && maskInput.length === width * height) {
      parsedData = maskInput;
    } else {
      const parsed = parsePGM(maskInput);
      if (parsed.width !== width || parsed.height !== height) {
        throw new QG01Error(`掩膜尺寸 ${parsed.width}×${parsed.height} 与灰度图 ${width}×${height} 不一致`, {
          code: 'mask-size-mismatch',
        });
      }
      parsedData = parsed.data;
    }
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = parsedData[i] ? 1 : 0;
    return mask;
  }

  // ---------- 块误差统计 ----------

  function buildStats(pixels, mask, n) {
    const stride = n + 1;
    const count = new Float64Array(stride * stride);
    const sum = new Float64Array(stride * stride);
    const square = new Float64Array(stride * stride);

    for (let y = 0; y < n; y++) {
      let rowCount = 0, rowSum = 0, rowSquare = 0;
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const valid = !mask || mask[i] !== 0;
        const p = pixels[i] & 255;
        if (valid) {
          rowCount++;
          rowSum += p;
          rowSquare += p * p;
        }
        const cur = (y + 1) * stride + (x + 1);
        const up = y * stride + (x + 1);
        count[cur] = count[up] + rowCount;
        sum[cur] = sum[up] + rowSum;
        square[cur] = square[up] + rowSquare;
      }
    }

    function block(x, y, size) {
      const x1 = x + size, y1 = y + size;
      const a = y * stride + x;
      const b = y * stride + x1;
      const c = y1 * stride + x;
      const d = y1 * stride + x1;
      const cnt = count[d] - count[b] - count[c] + count[a];
      const sv = sum[d] - sum[b] - sum[c] + sum[a];
      const sq = square[d] - square[b] - square[c] + square[a];
      let value = 0;
      let distortion = 0;
      if (cnt > 0) {
        const floorMean = Math.max(0, Math.min(255, Math.floor(sv / cnt)));
        let bestV = floorMean;
        let bestD = sq - 2 * bestV * sv + cnt * bestV * bestV;
        // 均值相邻的另一个整数；相等时不替换，保留较小值，也即字典序更小的字节。
        const v2 = floorMean + 1;
        if (v2 <= 255) {
          const d2 = sq - 2 * v2 * sv + cnt * v2 * v2;
          if (d2 < bestD) { bestV = v2; bestD = d2; }
        }
        value = bestV;
        distortion = bestD;
      }
      return { count: cnt, sum: sv, square: sq, value, distortion };
    }

    return { block };
  }

  // ---------- 最优四叉树 DP ----------
  /*
   * 每个 DPNode 保留一条 Pareto 前沿：位数递增、最小误差严格递减。
   * 被更短且误差不更高的状态支配的方案，不可能成为整图预算最优解。
   * 每个前沿 entry 的 arg 保存该精确位数/误差下字典序最小的载荷构造。
   */

  function fullTreeBits(size) {
    const area = size * size;
    return 10 * area + (area - 1) / 3;
  }

  function rawBitsFor(size) {
    return 2 + 8 * size * size;
  }

  function rawCodeFor(pixels, x, y, size, stride) {
    let body = 0n;
    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        body = (body << 8n) | BigInt(pixels[(y + yy) * stride + (x + xx)] & 255);
      }
    }
    return (1n << BigInt(8 * size * size)) | body; // 前缀 01
  }

  function entryCode(entry, pixels, stride) {
    if (entry._code !== undefined) return entry._code;
    const arg = entry.arg;
    let code;
    if (!arg) {
      code = 0n;
    } else if (arg.t === 'constant') {
      code = BigInt(arg.value); // 00 + value
    } else if (arg.t === 'raw') {
      code = arg.code;
    } else if (arg.t === 'cat') {
      const left = entryCode(arg.left, pixels, stride);
      const right = entryCode(arg.right, pixels, stride);
      code = (left << BigInt(arg.right.bits)) | right;
    } else if (arg.t === 'split') {
      const inner = entryCode(arg.concat, pixels, stride);
      code = (1n << BigInt(arg.concat.bits)) | inner;
    } else {
      throw new Error('未知 DP 参数类型');
    }
    entry._code = code;
    return code;
  }

  function extractPareto(bestDist, bestArg, bestCode, maxBits) {
    const entries = [];
    let globallyBest = INF;
    for (let bits = 0; bits <= maxBits; bits++) {
      const d = bestDist[bits];
      if (d < globallyBest) {
        entries.push({ bits, dist: d, arg: bestArg[bits], _code: bestCode ? bestCode[bits] : undefined });
        globallyBest = d;
      }
    }
    return entries;
  }

  function concatCandidateCode(left, right, pixels, stride) {
    return (entryCode(left, pixels, stride) << BigInt(right.bits)) | entryCode(right, pixels, stride);
  }

  function mergeFrontiers(leftEntries, rightEntries, capBits, pixels, stride) {
    let maxBits = 0;
    if (leftEntries.length && rightEntries.length) {
      maxBits = Math.min(capBits, leftEntries[leftEntries.length - 1].bits + rightEntries[rightEntries.length - 1].bits);
    }
    const bestDist = new Float64Array(maxBits + 1).fill(INF);
    const bestArg = new Array(maxBits + 1);
    const bestCode = new Array(maxBits + 1);

    for (const left of leftEntries) {
      for (const right of rightEntries) {
        const bits = left.bits + right.bits;
        if (bits > maxBits) break;
        const dist = left.dist + right.dist;
        if (dist > bestDist[bits]) continue;
        if (dist < bestDist[bits]) {
          bestDist[bits] = dist;
          bestArg[bits] = { t: 'cat', left, right };
          bestCode[bits] = undefined;
        } else if (dist === bestDist[bits]) {
          const candidateCode = concatCandidateCode(left, right, pixels, stride);
          if (bestCode[bits] === undefined) {
            bestCode[bits] = entryCode({ bits, arg: bestArg[bits] }, pixels, stride);
          }
          if (candidateCode < bestCode[bits]) {
            bestArg[bits] = { t: 'cat', left, right };
            bestCode[bits] = candidateCode;
          }
        }
      }
    }
    return extractPareto(bestDist, bestArg, bestCode, maxBits);
  }

  function analyzeQuadtree(input) {
    const { width: n, data: pixels } = validateGrayImage(input);
    const mask = input.mask ? normalizeMask(input.mask, n, n) : null;
    const capBits = input.maxBudget ?? MAX_BUDGET;
    if (!Number.isInteger(capBits) || capBits < MIN_BUDGET || capBits > MAX_BUDGET) {
      throw new QG01Error(`DP 上限必须在 ${MIN_BUDGET}–${MAX_BUDGET} 位之间`, { code: 'bad-budget' });
    }
    const stats = buildStats(pixels, mask, n);
    const dummyEntry = { bits: 0, dist: 0, arg: null, _code: 0n };

    function buildNode(x, y, size) {
      const stat = stats.block(x, y, size);
      const limit = Math.min(capBits, fullTreeBits(size));
      const bestDist = new Float64Array(limit + 1).fill(INF);
      const bestArg = new Array(limit + 1);
      const bestCode = new Array(limit + 1);

      function offer(bits, dist, arg) {
        if (bits > limit) return;
        if (dist < bestDist[bits]) {
          bestDist[bits] = dist;
          bestArg[bits] = arg;
          bestCode[bits] = undefined;
        } else if (dist === bestDist[bits]) {
          const candidate = entryCode({ bits, arg }, pixels, n);
          if (bestCode[bits] === undefined) {
            bestCode[bits] = entryCode({ bits, arg: bestArg[bits] }, pixels, n);
          }
          if (candidate < bestCode[bits]) {
            bestArg[bits] = arg;
            bestCode[bits] = candidate;
          }
        }
      }

      offer(10, stat.distortion, { t: 'constant', value: stat.value });

      const rb = rawBitsFor(size);
      if (rb <= limit) {
        offer(rb, 0, { t: 'raw', code: rawCodeFor(pixels, x, y, size, n) });
      }

      let children = null;
      if (size > 1) {
        const h = size >> 1;
        children = [
          buildNode(x, y, h),
          buildNode(x + h, y, h),
          buildNode(x, y + h, h),
          buildNode(x + h, y + h, h),
        ];

        let merged = [dummyEntry];
        const splitCap = Math.min(limit - 1, capBits - 1);
        for (const child of children) {
          merged = mergeFrontiers(merged, child.entries, splitCap, pixels, n);
        }
        for (const concatEntry of merged) {
          if (concatEntry.bits >= 40) {
            offer(concatEntry.bits + 1, concatEntry.dist, { t: 'split', concat: concatEntry });
          }
        }
      }

      const entries = extractPareto(bestDist, bestArg, bestCode, limit);
      // 不保留 children 节点树：entry.arg 已能沿实际候选构造回溯，
      // 这样未被任何前沿状态引用的子 DP 节点可以尽早回收。
      const node = { x, y, size, stat, entries, limit };
      if (typeof input.onNode === 'function') input.onNode(node);
      return node;
    }

    const rootNode = buildNode(0, 0, n);
    return { width: n, height: n, pixels, mask, rootNode, capBits };
  }

  function chooseEntry(analysis, budget) {
    if (!isAllowedBudget(budget)) {
      throw new QG01Error(`载荷预算必须是 ${MIN_BUDGET}–${MAX_BUDGET} 的整数位`, { code: 'bad-budget' });
    }
    const entries = analysis.rootNode.entries;
    let chosen = null;
    for (const entry of entries) {
      if (entry.bits <= budget) chosen = entry;
      else break;
    }
    if (!chosen) throw new QG01Error(`${budget} 位预算内不存在合法 QG01 树`, { code: 'budget-infeasible' });
    return chosen;
  }

  function concatKids(concatEntry) {
    const kids = [];
    function walk(entry) {
      if (!entry || !entry.arg) return;
      if (entry.arg.t === 'cat') {
        walk(entry.arg.left);
        kids.push(entry.arg.right);
      }
    }
    walk(concatEntry);
    return kids;
  }

  function materializePlan(analysis, budget) {
    const n = analysis.width;
    const chosen = chooseEntry(analysis, budget);
    const code = entryCode(chosen, analysis.pixels, n);
    const reconstructed = new Uint8Array(n * n);
    const nodes = [];
    const leaves = [];

    function materialize(entry, x, y, size, bitStart, depth, parentId, childIndex) {
      const id = nodes.length;
      const bits = entry.bits;
      const bitEnd = bitStart + bits;
      const arg = entry.arg;
      const mode = arg.t === 'constant' ? 'constant' : arg.t === 'raw' ? 'raw' : 'split';
      const node = {
        id, parentId, childIndex, x, y, size, depth,
        mode,
        bitStart, bitEnd, bits,
        distortion: entry.dist,
        value: mode === 'constant' ? arg.value : null,
        childIds: [],
        fieldIntervals: {},
      };
      nodes.push(node);
      if (parentId !== null) nodes[parentId].childIds.push(id);

      if (mode === 'constant') {
        node.fieldIntervals.prefix = [bitStart, bitStart + 2];
        node.fieldIntervals.value = [bitStart + 2, bitEnd];
        for (let yy = 0; yy < size; yy++) {
          reconstructed.fill(arg.value, (y + yy) * n + x, (y + yy) * n + x + size);
        }
        leaves.push(node);
        return;
      }

      if (mode === 'raw') {
        node.fieldIntervals.prefix = [bitStart, bitStart + 2];
        node.fieldIntervals.pixels = [bitStart + 2, bitEnd];
        for (let yy = 0; yy < size; yy++) {
          for (let xx = 0; xx < size; xx++) {
            const v = analysis.pixels[(y + yy) * n + (x + xx)];
            reconstructed[(y + yy) * n + (x + xx)] = v;
          }
        }
        leaves.push(node);
        return;
      }

      node.fieldIntervals.branch = [bitStart, bitStart + 1];
      const kids = concatKids(arg.concat);
      if (kids.length !== 4) throw new Error(`四分节点缺少子状态：${kids.length}`);
      const h = size >> 1;
      const positions = [
        [x, y], [x + h, y], [x, y + h], [x + h, y + h],
      ];
      let p = bitStart + 1;
      for (let i = 0; i < 4; i++) {
        materialize(kids[i], positions[i][0], positions[i][1], h, p, depth + 1, id, i);
        p += kids[i].bits;
      }
    }

    materialize(chosen, 0, 0, n, 0, 0, null, null);

    return {
      format: 'QG01',
      width: n,
      height: n,
      budget,
      usedBits: chosen.bits,
      distortion: chosen.dist,
      rootEntry: chosen,
      code,
      rootNodeId: 0,
      nodes,
      leaves,
      reconstructed,
      pixels: analysis.pixels,
      mask: analysis.mask,
      payload: packCode(code, chosen.bits, n),
    };
  }

  function encodeOptimal(input) {
    const budget = input.budget ?? 1024;
    const analysis = input.rootNode ? input : analyzeQuadtree(input);
    return materializePlan(analysis, budget);
  }

  // ---------- QG01 字节打包 ----------

  function packCode(code, bitLength, side = 0) {
    const bytes = new Uint8Array(HEADER_BYTES + Math.ceil(bitLength / 8));
    bytes[0] = 0x51; // Q
    bytes[1] = 0x47; // G
    bytes[2] = 0x30; // 0
    bytes[3] = 0x31; // 1
    const view = new DataView(bytes.buffer);
    view.setUint16(4, side, true);
    view.setUint32(6, bitLength >>> 0, true);
    const bin = code.toString(2).padStart(bitLength, '0');
    for (let i = 0; i < bitLength; i++) {
      if (bin.charCodeAt(i) === 49) bytes[HEADER_BYTES + (i >> 3)] |= 0x80 >> (i & 7);
    }
    return bytes;
  }

  function encodeQG01(plan) {
    const n = plan.width;
    const bitLength = plan.usedBits ?? plan.bitLength;
    const code = plan.code ?? plan.rootEntry?._code ?? entryCode(plan.rootEntry, plan.pixels, n);
    if (typeof code !== 'bigint') throw new TypeError('encodeQG01 需要 plan.code');
    return packCode(code, bitLength, n);
  }

  // ---------- QG01 解码 ----------

  class BitReader {
    constructor(payload, declaredBits) {
      this.payload = payload;
      this.declaredBits = declaredBits;
      this.pos = 0;
    }

    readBit() {
      if (this.pos + 1 > this.declaredBits) {
        throw new QG01Error('QG01 载荷截断：缺少至少 1 位', {
          code: 'truncated',
          bitStart: this.pos,
          bitPosition: this.pos,
          wantedBits: 1,
          availableBits: Math.max(0, this.declaredBits - this.pos),
          byteOffset: HEADER_BYTES + (this.pos >> 3),
        });
      }
      const bit = (this.payload[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return bit;
    }

    readBits(count) {
      if (this.pos + count > this.declaredBits) {
        const start = this.pos;
        throw new QG01Error(`QG01 载荷截断：需要 ${count} 位，仅剩 ${Math.max(0, this.declaredBits - start)} 位`, {
          code: 'truncated',
          bitStart: start,
          bitEnd: Math.min(this.declaredBits, start + count),
          bitPosition: start,
          wantedBits: count,
          availableBits: Math.max(0, this.declaredBits - start),
          byteOffset: HEADER_BYTES + (start >> 3),
        });
      }
      let value = 0;
      for (let i = 0; i < count; i++) value = (value << 1) | this.readBit();
      return value;
    }
  }

  function decodeQG01(input) {
    const bytes = asUint8Array(input, 'QG01');
    if (bytes.length < HEADER_BYTES) {
      throw new QG01Error(`QG01 文件头截断：至少需要 ${HEADER_BYTES} 字节，实际 ${bytes.length}`, {
        code: 'truncated-header',
        byteOffset: bytes.length,
      });
    }
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC.charCodeAt(i)) {
        throw new QG01Error('QG01 魔数错误，应为 ASCII "QG01"', { code: 'bad-magic', byteOffset: 0 });
      }
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const side = view.getUint16(4, true);
    const declaredBits = view.getUint32(6, true);

    if (!isDecodableSide(side)) {
      throw new QG01Error(`QG01 边长 ${side} 非法：必须是 1–${MAX_SIDE} 的二次幂`, {
        code: 'bad-dimensions',
        byteOffset: 4,
      });
    }

    const payloadByteCount = Math.ceil(declaredBits / 8);
    const expectedBytes = HEADER_BYTES + payloadByteCount;
    if (bytes.length < expectedBytes) {
      throw new QG01Error(
        `QG01 文件截断：声明 ${declaredBits} 位，需要 ${expectedBytes} 字节，实际 ${bytes.length} 字节，缺少 ${expectedBytes - bytes.length} 字节`,
        { code: 'truncated-file', byteOffset: bytes.length },
      );
    }
    if (bytes.length > expectedBytes) {
      throw new QG01Error(`QG01 存在额外字节：应结束于 ${expectedBytes}，实际 ${bytes.length}，多出 ${bytes.length - expectedBytes} 字节`, {
        code: 'extra-bytes',
        byteOffset: expectedBytes,
      });
    }

    const payload = bytes.subarray(HEADER_BYTES, expectedBytes);

    const rem = declaredBits & 7;
    if (rem !== 0 && payloadByteCount > 0) {
      const padBits = 8 - rem;
      const padMask = (1 << padBits) - 1;
      const lastByte = payload[payloadByteCount - 1];
      if ((lastByte & padMask) !== 0) {
        throw new QG01Error(
          `QG01 末字节填充位非零：最后 ${padBits} 个低位必须为 0，实际为 0b${(lastByte & padMask).toString(2).padStart(padBits, '0')}`,
          {
            code: 'nonzero-padding',
            byteOffset: HEADER_BYTES + payloadByteCount - 1,
            bitStart: declaredBits,
            bitEnd: payloadByteCount * 8,
          },
        );
      }
    }

    const reader = new BitReader(payload, declaredBits);
    const pixels = new Uint8Array(side * side);
    const nodes = [];

    function decodeNode(x, y, size, depth, parentId, childIndex) {
      const id = nodes.length;
      const bitStart = reader.pos;
      const first = reader.readBit();

      if (first === 1) {
        if (size === 1) {
          throw new QG01Error('非法分块：1×1 块不得四分（分支位 1）', {
            code: 'illegal-split',
            bitStart,
            bitEnd: bitStart + 1,
            bitPosition: bitStart,
            byteOffset: HEADER_BYTES + (bitStart >> 3),
          });
        }
        const node = {
          id, parentId, childIndex, x, y, size, depth,
          mode: 'split', bitStart, bitEnd: null, bits: null,
          distortion: null, value: null, childIds: [],
          fieldIntervals: { branch: [bitStart, bitStart + 1] },
        };
        nodes.push(node);
        if (parentId !== null) nodes[parentId].childIds.push(id);
        const h = size >> 1;
        const positions = [
          [x, y], [x + h, y], [x, y + h], [x + h, y + h],
        ];
        for (let i = 0; i < 4; i++) {
          decodeNode(positions[i][0], positions[i][1], h, depth + 1, id, i);
        }
        node.bitEnd = reader.pos;
        node.bits = node.bitEnd - bitStart;
        return id;
      }

      const second = reader.readBit();
      if (second === 0) {
        const valueStart = reader.pos;
        const value = reader.readBits(8);
        const bitEnd = reader.pos;
        for (let yy = 0; yy < size; yy++) {
          pixels.fill(value, (y + yy) * side + x, (y + yy) * side + x + size);
        }
        const node = {
          id, parentId, childIndex, x, y, size, depth,
          mode: 'constant', bitStart, bitEnd, bits: bitEnd - bitStart,
          distortion: null, value, childIds: [],
          fieldIntervals: { prefix: [bitStart, bitStart + 2], value: [valueStart, bitEnd] },
        };
        nodes.push(node);
        if (parentId !== null) nodes[parentId].childIds.push(id);
        return id;
      }

      const dataStart = reader.pos;
      for (let yy = 0; yy < size; yy++) {
        for (let xx = 0; xx < size; xx++) {
          pixels[(y + yy) * side + (x + xx)] = reader.readBits(8);
        }
      }
      const bitEnd = reader.pos;
      const node = {
        id, parentId, childIndex, x, y, size, depth,
        mode: 'raw', bitStart, bitEnd, bits: bitEnd - bitStart,
        distortion: null, value: null, childIds: [],
        fieldIntervals: { prefix: [bitStart, bitStart + 2], pixels: [dataStart, bitEnd] },
      };
      nodes.push(node);
      if (parentId !== null) nodes[parentId].childIds.push(id);
      return id;
    }

    decodeNode(0, 0, side, 0, null, null);

    if (reader.pos < declaredBits) {
      const start = reader.pos;
      let firstOne = null;
      for (let p = start; p < declaredBits; p++) {
        const bit = (payload[p >> 3] >> (7 - (p & 7))) & 1;
        if (bit) { firstOne = p; break; }
      }
      if (firstOne !== null) {
        throw new QG01Error(
          `QG01 树之后存在非零填充/未消费数据：树结束于 ${start}，声明 ${declaredBits} 位；首个 1 在载荷位 ${firstOne}`,
          {
            code: 'nonzero-padding',
            bitStart: firstOne,
            bitEnd: firstOne + 1,
            bitPosition: firstOne,
            byteOffset: HEADER_BYTES + (firstOne >> 3),
          },
        );
      }
      throw new QG01Error(
        `QG01 树未正好用尽声明位数：树结束于 ${start}，声明 ${declaredBits} 位，剩余 ${declaredBits - start} 个零位`,
        {
          code: 'trailing-bits',
          bitStart: start,
          bitEnd: declaredBits,
          bitPosition: start,
          byteOffset: HEADER_BYTES + (start >> 3),
        },
      );
    }

    const leaves = nodes.filter((n) => n.mode !== 'split');
    return {
      format: 'QG01',
      width: side,
      height: side,
      bitLength: declaredBits,
      usedBits: declaredBits,
      code: null,
      pixels,
      reconstructed: pixels,
      rootNodeId: 0,
      nodes,
      leaves,
      payloadBytes: payload,
    };
  }

  // ---------- 误差评估 / 工具 ----------

  function distortionBetween(reconstructed, original, mask) {
    let total = 0;
    for (let i = 0; i < original.length; i++) {
      if (!mask || mask[i]) {
        const d = reconstructed[i] - original[i];
        total += d * d;
      }
    }
    return total;
  }

  function evaluateNodes(nodes, reconstructed, original, mask, width) {
    for (const node of nodes) {
      if (node.mode !== 'split') {
        let d = 0;
        for (let y = node.y; y < node.y + node.size; y++) {
          for (let x = node.x; x < node.x + node.size; x++) {
            const i = y * width + x;
            if (!mask || mask[i]) {
              const e = reconstructed[i] - original[i];
              d += e * e;
            }
          }
        }
        node.distortion = d;
      }
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.mode === 'split') {
        node.distortion = node.childIds.reduce((s, id) => s + nodes[id].distortion, 0);
      }
    }
  }

  function bitsToString(plan) {
    const code = typeof plan === 'bigint' ? plan : plan.code;
    const len = typeof plan === 'bigint' ? arguments[1] : (plan.usedBits ?? plan.bitLength);
    return code.toString(2).padStart(len, '0');
  }

  function formatBitInterval(node) {
    return `[${node.bitStart}, ${node.bitEnd})`;
  }

  return {
    MAGIC,
    HEADER_BYTES,
    MIN_SIDE,
    MAX_SIDE,
    MIN_BUDGET,
    MAX_BUDGET,
    QG01Error,
    isPowerOfTwoSide,
    isDecodableSide,
    isAllowedBudget,
    parsePGM,
    validateGrayImage,
    normalizeMask,
    buildStats,
    fullTreeBits,
    analyzeQuadtree,
    encodeOptimal,
    chooseEntry,
    entryCode,
    concatKids,
    encodeQG01,
    decodeQG01,
    packCode,
    distortionBetween,
    evaluateNodes,
    bitsToString,
    formatBitInterval,
  };
});
