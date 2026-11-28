// gaps.js —— 下穿缺口与保留线段
// 每个下穿点沿弧长两侧各挖 strand.gap；缺口重叠取并集；
// 闭线在 [0,L) 圆周上处理，跨接缝的缺口要连通；整圈被挖空时整条线不绘制。

/**
 * 计算每条线挖洞后的保留折线。
 * @param model buildModel 的结果
 * @param above Int32Array，cid -> 在上的 strand id
 * @returns {Map<number, number[][][]>} strandId -> 多段折线（每段为点数组）
 */
export function computeRetained(model, above) {
  const result = new Map();
  for (const st of model.strands) {
    const L = st.totalLen;
    /** @type {Array<[number,number]>} 原始缺口区间（弧长坐标，允许越界） */
    const raw = [];
    for (const { cid, arc } of st.order) {
      if (above[cid] === st.id) continue; // 上穿，不挖
      const g = st.gap;
      if (g === 0) continue;
      raw.push([arc - g, arc + g]);
    }

    /** @type {Array<[number,number]>} 规范到 [0,L) 内的缺口碎片 */
    let pieces = [];
    if (st.closed) {
      for (const [a, b] of raw) {
        // 按长度 L 折叠进 [-L, 2L) 范围，再切成 [0,L) 内的碎片
        let a2 = a % L;
        if (a2 < 0) a2 += L;
        let len = b - a;
        if (len >= L) {
          pieces = [[0, L]];
          break;
        }
        let end = a2 + len;
        if (end <= L) {
          pieces.push([a2, end]);
        } else {
          pieces.push([a2, L]);
          pieces.push([0, end - L]);
        }
      }
    } else {
      for (const [a, b] of raw) {
        const a2 = Math.max(0, a);
        const b2 = Math.min(L, b);
        if (a2 < b2) pieces.push([a2, b2]);
      }
    }

    if (pieces.length === 0) {
      const full = st.points.map((p) => [p[0], p[1]]);
      if (st.closed) full.push([st.points[0][0], st.points[0][1]]); // 补闭合边
      result.set(st.id, [full]);
      continue;
    }
    pieces.sort((p, q) => p[0] - q[0]);
    /** 并集后的缺口（线性区间，端点均在 [0,L]）。 */
    const merged = [];
    for (const [a, b] of pieces) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) {
        if (b > last[1]) last[1] = b;
      } else {
        merged.push([a, b]);
      }
    }

    /** 缺口取补，得到保留弧长区间。 */
    let kept = [];
    if (st.closed && merged.length > 1 &&
        merged[0][0] === 0 && merged[merged.length - 1][1] === L) {
      // 跨接缝缺口：首碎片占 [0,b0]、末碎片占 [aN,L]，在圆周上连通。
      // 保留区间是各内部缺口之间的部分，外加 [b0, aN] 这一段。
      let cursor = merged[0][1];
      for (let i = 1; i < merged.length - 1; i++) {
        const [a, b] = merged[i];
        if (a > cursor) kept.push([cursor, a]);
        cursor = b;
      }
      const tailStart = merged[merged.length - 1][0];
      if (tailStart > cursor) kept.push([cursor, tailStart]);
    } else {
      if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] >= L) {
        result.set(st.id, []); // 整圈挖空
        continue;
      }
      let cursor = 0;
      for (const [a, b] of merged) {
        if (a > cursor) kept.push([cursor, a]);
        cursor = b;
      }
      if (cursor < L) kept.push([cursor, L]);
    }

    const paths = [];
    for (const [a, b] of kept) {
      if (b - a <= 0) continue;
      paths.push(arcRangeToPath(st, a, b));
    }
    result.set(st.id, paths);
  }
  return result;
}

/**
 * 把一条线 [a,b] 的保留弧长区间转成折线点（含途经顶点），闭线允许 0<=a<b<=L。
 */
function arcRangeToPath(st, a, b) {
  const pts = st.points;
  const nSeg = st.segments.length;
  // 定位 a 所在段及其段内偏移（a 恰为顶点时归属前一段，偏移取段长）
  let segIdx = 0, acc = 0;
  while (segIdx < nSeg - 1 && acc + st.segments[segIdx].len <= a) {
    acc += st.segments[segIdx].len;
    segIdx++;
  }
  const path = [pointAt(st, segIdx, a - acc)];
  let pos = a;
  let idx = segIdx;
  // 逐段推进：每段贡献 [当前位置, min(b, 段终点)]，段终点即下一顶点
  while (pos < b - 1e-9) {
    const seg = st.segments[idx];
    const segEnd = acc + seg.len;
    const stop = Math.min(b, segEnd);
    if (stop >= segEnd - 1e-9) {
      const endPt = pts[(idx + 1) % pts.length];
      path.push([endPt[0], endPt[1]]);
      pos = segEnd;
      acc = segEnd;
      idx = (idx + 1) % nSeg;
    } else {
      path.push(pointAt(st, idx, stop - acc));
      pos = b;
    }
  }
  return path;
}

/** 第 segIdx 段上，距该段起点 d 的点。 */
function pointAt(st, segIdx, d) {
  const seg = st.segments[segIdx];
  if (seg.horizontal) {
    const dir = Math.sign(seg.x2 - seg.x1);
    return [seg.x1 + dir * d, seg.y1];
  }
  const dir = Math.sign(seg.y2 - seg.y1);
  return [seg.x1, seg.y1 + dir * d];
}
