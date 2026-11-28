// model.js —— 输入校验、几何求交、沿弧长排序
// 纯逻辑模块，不依赖 DOM，可在 Node 中直接测试。

/** 数据不合规时抛出，issues 为可逐条核对的中文说明。 */
export class ModelError extends Error {
  /** @param {string[]} issues */
  constructor(issues) {
    super(`输入数据存在 ${issues.length} 处问题`);
    this.name = 'ModelError';
    this.issues = issues;
  }
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/** 坐标键：x,y 均为整数，用定长拼接避免歧义。 */
const keyOf = (x, y) => `${x},${y}`;

/**
 * 解析并校验输入，构建几何模型。
 * @param {{strands: any[], pins?: any[]}} data
 */
export function buildModel(data) {
  const issues = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ModelError(['顶层必须是对象，含 strands 数组（可选 pins 数组）']);
  }
  const rawStrands = data.strands;
  if (!Array.isArray(rawStrands) || rawStrands.length === 0) {
    throw new ModelError(['strands 必须是非空数组']);
  }
  if (rawStrands.length > 10000) {
    issues.push(`线条数量 ${rawStrands.length} 超过上限 10000`);
  }

  /** 规范化后的线条，按输入顺序保存。 */
  const strands = [];
  /** 所有横竖线段（展开折线后）。 */
  const segments = [];
  /** 坐标键 -> 落在该点的线段端点 [{sid, ptIndex, at(x,y)}]。 */
  const endpointAt = new Map();

  const seenIds = new Set();
  let vxMin = Infinity, vxMax = -Infinity, vyMin = Infinity, vyMax = -Infinity;

  const addEndpoint = (x, y, sid, ptIndex) => {
    const k = keyOf(x, y);
    let arr = endpointAt.get(k);
    if (!arr) endpointAt.set(k, (arr = []));
    arr.push({ sid, ptIndex, x, y });
    if (x < vxMin) vxMin = x;
    if (x > vxMax) vxMax = x;
    if (y < vyMin) vyMin = y;
    if (y > vyMax) vyMax = y;
  };

  for (let s = 0; s < rawStrands.length; s++) {
    const raw = rawStrands[s];
    const label = `第 ${s + 1} 条线条`;
    if (!raw || typeof raw !== 'object') {
      issues.push(`${label}不是对象`);
      continue;
    }
    const id = raw.id;
    if (!isInt(id) || id <= 0) {
      issues.push(`${label}的 id 必须是正整数`);
      continue;
    }
    if (seenIds.has(id)) {
      issues.push(`线条 id=${id} 重复`);
      continue;
    }
    seenIds.add(id);
    const closed = raw.closed === true;
    const gap = raw.gap;
    if (!isInt(gap) || gap < 0) {
      issues.push(`线条 ${id} 的 gap 必须是非负整数`);
      continue;
    }
    const pts = raw.points;
    if (!Array.isArray(pts) || pts.length < 2) {
      issues.push(`线条 ${id} 的 points 至少需要 2 个点`);
      continue;
    }
    /** @type {number[][]} */
    const points = [];
    let badPoint = false;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Array.isArray(p) || p.length !== 2 || !isInt(p[0]) || !isInt(p[1])) {
        issues.push(`线条 ${id} 的 points[${i}] 必须是 [整数x, 整数y]`);
        badPoint = true;
      } else {
        points.push([p[0], p[1]]);
      }
    }
    if (badPoint) continue;
    if (closed && points.length < 3) {
      issues.push(`闭线 ${id} 至少需要 3 个顶点`);
      continue;
    }

    const sid = id;
    const nSeg = closed ? points.length : points.length - 1;
    const strandSegs = [];
    let totalLen = 0;
    for (let i = 0; i < nSeg; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if (x1 === x2 && y1 === y2) {
        issues.push(`线条 ${id} 的第 ${i} 段是零长度段（两点重合）`);
        continue;
      }
      const horizontal = y1 === y2;
      if (!horizontal && x1 !== x2) {
        issues.push(`线条 ${id} 的第 ${i} 段既非水平也非竖直（只允许横竖线段）`);
        continue;
      }
      const len = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
      const seg = {
        sid, i,
        x1, y1, x2, y2,
        horizontal,
        len,
        lo: horizontal ? Math.min(x1, x2) : Math.min(y1, y2),
        hi: horizontal ? Math.max(x1, x2) : Math.max(y1, y2),
      };
      segments.push(seg);
      strandSegs.push(seg);
      totalLen += len;
    }
    if (strandSegs.length === 0) continue;

    // 同线条共线重叠检测：相邻段只允许在共用端点接合，非相邻段不许重叠。
    for (let a = 0; a < strandSegs.length; a++) {
      for (let b = a + 1; b < strandSegs.length; b++) {
        const A = strandSegs[a], B = strandSegs[b];
        if (A.horizontal !== B.horizontal) continue;
        const sameLine = A.horizontal ? A.y1 === B.y1 : A.x1 === B.x1;
        if (!sameLine) continue;
        const overlap = Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo);
        const adjacent =
          b === a + 1 ||
          (closed && a === 0 && b === strandSegs.length - 1);
        if (overlap > 0 || (overlap === 0 && !adjacent)) {
          issues.push(
            `线条 ${id} 自身的共线线段发生重叠/非端点接触（第 ${a}、${b} 段）`,
          );
        }
      }
    }

    const strand = {
      id: sid,
      points,
      closed,
      gap,
      segments: strandSegs,
      totalLen,
      /** @type {{cid:number, arc:number}[]} 沿行进顺序填充 */
      order: [],
    };
    strands.push(strand);
    for (let i = 0; i < points.length; i++) {
      addEndpoint(points[i][0], points[i][1], sid, i);
    }
  }

  if (issues.length) throw new ModelError(issues);

  // ---- 端点接触校验：不同线条不许在端点接触；同线条只允许相邻段共用端点 ----
  for (const arr of endpointAt.values()) {
    if (arr.length < 2) continue;
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const A = arr[a], B = arr[b];
        if (A.sid !== B.sid) {
          issues.push(
            `坐标 (${A.x},${A.y}) 是线条 ${A.sid} 与线条 ${B.sid} 的端点接触；交点只允许出现在两条线段内部`,
          );
        } else {
          const st = strands.find((t) => t.id === A.sid);
          const n = st.points.length;
          const adjacent =
            Math.abs(A.ptIndex - B.ptIndex) === 1 ||
            (st.closed &&
              ((A.ptIndex === 0 && B.ptIndex === n - 1) ||
                (B.ptIndex === 0 && A.ptIndex === n - 1)));
          if (!adjacent) {
            issues.push(
              `线条 ${A.sid} 在 (${A.x},${A.y}) 出现非相邻顶点重合（自交）`,
            );
          }
        }
      }
    }
  }
  if (issues.length) throw new ModelError(issues);

  // ---- T 接校验：任一线条的端点落在另一线段内部即非法 ----
  for (const seg of segments) {
    for (const arr of endpointAt.values()) {
      for (const ep of arr) {
        if (ep.sid === seg.sid) continue;
        const inside = seg.horizontal
          ? ep.y === seg.y1 && ep.x > seg.lo && ep.x < seg.hi
          : ep.x === seg.x1 && ep.y > seg.lo && ep.y < seg.hi;
        if (inside) {
          issues.push(
            `坐标 (${ep.x},${ep.y}) 是线条 ${ep.sid} 的端点，却落在线条 ${seg.sid} 线段内部；交点只允许出现在两条线段内部`,
          );
        }
      }
    }
  }
  if (issues.length) throw new ModelError(issues);

  // ---- 扫掠线求全部横平竖直交点 ----
  // 竖线在其 x 处：先加入起于该 x 的横线，再范围查询活动横线，最后移出止于该 x 的横线。
  // y 压缩必须覆盖横线所在高度（查询命中的就是横线 y）。
  const ys = [];
  for (const seg of segments) ys.push(seg.y1, seg.y2);
  ys.sort((a, b) => a - b);
  const yDedup = [];
  for (const y of ys) {
    if (yDedup.length === 0 || yDedup[yDedup.length - 1] !== y) yDedup.push(y);
  }
  /** Fenwick 树：下标为去重 y 的 1-based 位次。 */
  class Fenwick {
    constructor(n) {
      this.n = n;
      this.w = new Int32Array(n + 1);
    }
    add(i, d) {
      for (; i <= this.n; i += i & -i) this.w[i] += d;
    }
    /** 1..i 的前缀和。 */
    sum(i) {
      let s = 0;
      for (; i > 0; i -= i & -i) s += this.w[i];
      return s;
    }
    /** 最小的 i（1-based）使前缀和 >= k，k 为 1-based。 */
    kth(k) {
      let i = 0;
      let step = 1;
      while (step << 1 <= this.n) step <<= 1;
      for (; step; step >>= 1) {
        const j = i + step;
        if (j <= this.n && this.w[j] < k) {
          i = j;
          k -= this.w[j];
        }
      }
      return i + 1;
    }
  }
  const yIndex = new Map();
  yDedup.forEach((y, i) => yIndex.set(y, i + 1));
  const bit = new Fenwick(yDedup.length);
  /**
   * 活动横线按 y 分桶，桶内按 lo 升序。
   * 关键事实：交点的 x 等于竖线的 x，故竖线事件触发时，与之相交的横线
   * 必然已经加入（lo < x）且尚未移出（hi > x），一次范围查询即可覆盖全部交点。
   */
  const activeH = new Map();
  const findHorizontalAt = (x, y) => {
    const bucket = activeH.get(y);
    if (!bucket) return null;
    // 桶按 lo 升序：lower_bound 找第一个 lo >= x，其前一个就是 lo < x 的候选。
    // 同 y 共线重叠已在校验阶段排除，故至多一条覆盖 x。
    let lo = 0, hi = bucket.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bucket[mid].lo < x) lo = mid + 1;
      else hi = mid;
    }
    const j = lo - 1;
    if (j < 0) return null;
    const seg = bucket[j];
    return x < seg.hi ? seg : null;
  };
  const insertHorizontal = (seg) => {
    let bucket = activeH.get(seg.y1);
    if (!bucket) activeH.set(seg.y1, (bucket = []));
    let lo = 0, hi = bucket.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bucket[mid].lo < seg.lo) lo = mid + 1;
      else hi = mid;
    }
    bucket.splice(lo, 0, seg);
  };
  const removeHorizontal = (seg) => {
    const bucket = activeH.get(seg.y1);
    if (!bucket) return;
    let lo = 0, hi = bucket.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bucket[mid].lo < seg.lo) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j < bucket.length && bucket[j].lo === seg.lo; j++) {
      if (bucket[j] === seg) {
        bucket.splice(j, 1);
        return;
      }
    }
  };

  const events = [];
  for (const seg of segments) {
    if (seg.horizontal) {
      events.push({ x: seg.lo, type: 0, seg }); // 加入
      events.push({ x: seg.hi, type: 2, seg }); // 移出
    } else {
      // 竖线是一条固定 x 的线段，查询事件挂在它的 x 上
      events.push({ x: seg.x1, type: 1, seg });
    }
  }
  events.sort((a, b) => (a.x - b.x) || (a.type - b.type));

  /** 坐标键 -> crossing（暂存，稍后编号）。 */
  const crossingMap = new Map();
  const addCrossing = (x, y, hSeg, vSeg) => {
    // 严格内部：横线开区间 (lo,hi)，竖线开区间 (lo,hi)
    if (!(x > hSeg.lo && x < hSeg.hi && y > vSeg.lo && y < vSeg.hi)) return;
    const k = keyOf(x, y);
    const pair = { h: hSeg.sid, v: vSeg.sid };
    const prev = crossingMap.get(k);
    if (prev) {
      const extra = pair.h === prev.h || pair.h === prev.v ? pair.v : pair.h;
      issues.push(
        `坐标 (${x},${y}) 有超过两条线交汇（涉及线条 ${prev.h},${prev.v},${extra}）；每个交点只允许两条线`,
      );
      return;
    }
    crossingMap.set(k, { x, y, h: hSeg.sid, v: vSeg.sid });
  };

  let ei = 0;
  while (ei < events.length) {
    const x = events[ei].x;
    // type 0：加入起于 x 的横线
    while (ei < events.length && events[ei].x === x && events[ei].type === 0) {
      const seg = events[ei].seg;
      insertHorizontal(seg);
      bit.add(yIndex.get(seg.y1), 1);
      ei++;
    }
    // type 1：x 处的竖线查询（同 x 多条竖线共线，各自独立查询）
    const verticals = [];
    while (ei < events.length && events[ei].x === x && events[ei].type === 1) {
      verticals.push(events[ei].seg);
      ei++;
    }
    for (const vSeg of verticals) {
      const iLo = yIndex.get(vSeg.lo);
      const iHi = yIndex.get(vSeg.hi);
      const cnt = bit.sum(iHi - 1) - bit.sum(iLo); // 严格内部 y
      if (cnt === 0) continue;
      const base = bit.sum(iLo);
      for (let k = 1; k <= cnt; k++) {
        const idx = bit.kth(base + k);
        const y = yDedup[idx - 1];
        const hSeg = findHorizontalAt(x, y);
        if (hSeg) addCrossing(x, y, hSeg, vSeg);
      }
    }
    // type 2：移出止于 x 的横线（交点严格在内部，移出不影响同 x 查询）
    while (ei < events.length && events[ei].x === x && events[ei].type === 2) {
      const seg = events[ei].seg;
      bit.add(yIndex.get(seg.y1), -1);
      removeHorizontal(seg);
      ei++;
    }
  }

  if (issues.length) throw new ModelError(issues);

  // ---- 交点编号：按 y 再 x 排序，分配 cid ----
  const crossings = [...crossingMap.values()].sort(
    (a, b) => (a.y - b.y) || (a.x - b.x),
  );
  if (crossings.length > 50000) {
    issues.push(`交点数量 ${crossings.length} 超过上限 50000`);
    throw new ModelError(issues);
  }
  const strandById = new Map();
  for (const st of strands) strandById.set(st.id, st);

  crossings.forEach((c, cid) => {
    c.cid = cid;
    c.a = Math.min(c.h, c.v); // 小编号线
    c.b = Math.max(c.h, c.v);
  });

  // ---- 计算每个交点沿两条线的弧长，并挂到线条的行进顺序中 ----
  for (const c of crossings) {
    for (const sid of [c.h, c.v]) {
      const st = strandById.get(sid);
      let arc = 0;
      let found = false;
      for (const seg of st.segments) {
        const on =
          seg.horizontal
            ? seg.y1 === c.y && c.x > seg.lo && c.x < seg.hi
            : seg.x1 === c.x && c.y > seg.lo && c.y < seg.hi;
        if (on) {
          arc += seg.horizontal
            ? Math.abs(c.x - seg.x1)
            : Math.abs(c.y - seg.y1);
          found = true;
          break;
        }
        arc += seg.len;
      }
      if (!found) {
        issues.push(`内部错误：交点 (${c.x},${c.y}) 无法在线条 ${sid} 上定位`);
        continue;
      }
      st.order.push({ cid: c.cid, arc });
    }
  }
  if (issues.length) throw new ModelError(issues);

  for (const st of strands) {
    st.order.sort((p, q) => p.arc - q.arc);
    // 闭线弧长在 [0, totalLen)；同弧长重复意味着同一位置两个交点，几何上已被前面校验排除
  }

  // ---- 校验 pins ----
  const pins = [];
  if (data.pins !== undefined) {
    if (!Array.isArray(data.pins)) {
      throw new ModelError(['pins 必须是数组']);
    }
    for (let i = 0; i < data.pins.length; i++) {
      const p = data.pins[i];
      const label = `pins[${i}]`;
      if (!p || !Array.isArray(p.at) || p.at.length !== 2 ||
          !isInt(p.at[0]) || !isInt(p.at[1]) || !isInt(p.above) || p.above <= 0) {
        issues.push(`${label} 必须形如 {"at":[x,y],"above":正整数}`);
        continue;
      }
      const c = crossingMap.get(keyOf(p.at[0], p.at[1]));
      if (!c) {
        issues.push(`${label} 的坐标 (${p.at[0]},${p.at[1]}) 不是交点`);
        continue;
      }
      if (p.above !== c.h && p.above !== c.v) {
        issues.push(
          `${label} 指定的线条 ${p.above} 不经过交点 (${p.at[0]},${p.at[1]})`,
        );
        continue;
      }
      pins.push({ cid: c.cid, above: p.above });
    }
  }
  if (issues.length) throw new ModelError(issues);

  return {
    strands,
    strandById,
    crossings,
    crossingMap,
    pins,
    bounds: { minX: vxMin, maxX: vxMax, minY: vyMin, maxY: vyMax },
  };
}
