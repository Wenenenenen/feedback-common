/**
 * 快门曝光连续时间积分核心。
 *
 * 语义（与任务说明一致）：
 *  - 场景时间 t ∈ [0,1]；顶点屏幕坐标与深度随 t 线性变化：v(t)=(1-t)v0+t·v1。
 *  - 覆盖判定只看像素中心 (px+0.5, py+0.5)，三角形内部为“覆盖”。
 *  - 同一色片（card）的所有三角形共用恒定线性 RGB 与单一深度 d(t)。
 *  - 某时刻该像素的可见颜色 = 覆盖该像素的三角形中深度最小者（深度小=更靠前）的色片颜色；
 *    无覆盖则为背景色。深度相等时取色片 ID 较小者。
 *  - 曝光窗口可按行扫描延迟平移；积分在连续时间上做，瞬间贴边（切触/相切）是零测集，不增加曝光。
 *  - 权重：均匀，或以窗口中心为峰、两端为零的对称三角形。
 *
 * 做法：对每个像素，先求所有“边穿过像素中心”的二次方程根，把时间轴切成若干开区间；
 * 这些开区间上覆盖集合恒定。再在每个开区间内按色片深度线性函数的交点细分，得到
 * 可见色片恒定的子区间，逐段做权重函数的精确积分（权重为常值或分段线性，可解析求积）。
 * 因此结果不是采样逼近，而是解析积分。
 */

export class ValidationError extends Error {
  constructor(messages) {
    super(`场景校验失败：\n${messages.join('\n')}`);
    this.name = 'ValidationError';
    this.messages = messages;
  }
}

const MAX_W = 160;
const MAX_H = 96;
const MAX_TRIANGLES = 64;

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/** 色片 ID 比较：两者都是数字时按数值，否则按字符串码元比较。 */
export function compareCardIds(a, b) {
  const na = typeof a === 'number' ? a : (a !== '' && Number.isFinite(Number(a)) ? Number(a) : null);
  const nb = typeof b === 'number' ? b : (b !== '' && Number.isFinite(Number(b)) ? Number(b) : null);
  if (na !== null && nb !== null) {
    if (na !== nb) return na < nb ? -1 : 1;
    return 0;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

function checkVec2(arr, where, errs) {
  if (!Array.isArray(arr) || arr.length !== 2 || !isFiniteNum(arr[0]) || !isFiniteNum(arr[1])) {
    errs.push(`${where} 必须是两个有限数 [x, y]`);
    return null;
  }
  return [arr[0], arr[1]];
}

function checkRgb(arr, where, errs) {
  if (!Array.isArray(arr) || arr.length !== 3 || !arr.every(isFiniteNum)) {
    errs.push(`${where} 必须是三个有限数 [r, g, b]`);
    return null;
  }
  return [arr[0], arr[1], arr[2]];
}

/**
 * 校验并规范化样例 JSON。返回 { background, cases:[...] }。
 * 严格模式：任何非法输入整份拒绝，并给出全部问题列表。
 */
export function parseCaseSet(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new ValidationError([`不是合法 JSON：${e.message}`]);
    }
  }
  const errs = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ValidationError(['顶层必须是对象 { background?, cases: [...] }']);
  }
  const background = obj.background === undefined
    ? [0, 0, 0]
    : checkRgb(obj.background, 'background', errs) || [0, 0, 0];

  if (!Array.isArray(obj.cases) || obj.cases.length === 0) {
    errs.push('cases 必须是非空数组');
  }

  const cases = [];
  const seenCaseIds = new Set();
  const casesRaw = Array.isArray(obj.cases) ? obj.cases : [];

  casesRaw.forEach((c, ci) => {
    const cwhere = `cases[${ci}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errs.push(`${cwhere} 必须是对象`);
      return;
    }
    const id = c.id === undefined ? `case-${ci}` : String(c.id);
    if (seenCaseIds.has(id)) errs.push(`${cwhere}.id 重复：${JSON.stringify(id)}`);
    seenCaseIds.add(id);

    if (!Array.isArray(c.size) || c.size.length !== 2 || !isInt(c.size[0]) || !isInt(c.size[1])) {
      errs.push(`${cwhere}.size 必须是两个整数 [W, H]`);
      return;
    }
    const [W, H] = c.size;
    if (W < 1 || H < 1 || W > MAX_W || H > MAX_H) {
      errs.push(`${cwhere}.size = [${W}, ${H}] 超出范围（宽 1..${MAX_W}，高 1..${MAX_H}）`);
    }

    if (!Array.isArray(c.cards) || c.cards.length === 0) {
      errs.push(`${cwhere}.cards 必须是非空数组`);
      return;
    }

    let triangleTotal = 0;
    const seenCardIds = new Set();
    const cards = [];

    c.cards.forEach((card, k) => {
      const where = `${cwhere}.cards[${k}]`;
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        errs.push(`${where} 必须是对象`);
        return;
      }
      if (card.id === undefined) errs.push(`${where}.id 缺失`);
      const cid = card.id === undefined ? `card-${k}` : card.id;
      const idKey = String(cid);
      if (seenCardIds.has(idKey)) errs.push(`${where}.id 在同一 case 内重复：${JSON.stringify(cid)}`);
      seenCardIds.add(idKey);

      const rgb = checkRgb(card.rgb, `${where}.rgb`, errs) || [0, 0, 0];
      if (rgb.some((v) => v < 0 || v > 1)) {
        errs.push(`${where}.rgb 的分量应在 0..1（线性值）`);
      }
      if (!Array.isArray(card.depth) || card.depth.length !== 2 || !card.depth.every(isFiniteNum)) {
        errs.push(`${where}.depth 必须是两个有限数 [d0, d1]`);
      }
      if (!Array.isArray(card.xy0) || card.xy0.length < 3) {
        errs.push(`${where}.xy0 至少要有 3 个顶点`);
      }
      if (!Array.isArray(card.xy1) || card.xy1.length < 3) {
        errs.push(`${where}.xy1 至少要有 3 个顶点`);
      }
      if (Array.isArray(card.xy0) && Array.isArray(card.xy1) && card.xy0.length !== card.xy1.length) {
        errs.push(`${where}.xy0 与 .xy1 顶点数必须一致`);
      }
      const nv = Array.isArray(card.xy0) ? card.xy0.length : 0;
      const xy0 = [];
      const xy1 = [];
      for (let i = 0; i < nv; i++) {
        const a = checkVec2(card.xy0[i], `${where}.xy0[${i}]`, errs);
        const b = checkVec2(card.xy1[i], `${where}.xy1[${i}]`, errs);
        if (a) xy0.push(a);
        if (b) xy1.push(b);
      }
      if (!Array.isArray(card.f) || card.f.length === 0) {
        errs.push(`${where}.f 必须是非空三角形索引数组`);
      }
      const f = [];
      if (Array.isArray(card.f)) {
        card.f.forEach((tri, ti) => {
          if (!Array.isArray(tri) || tri.length !== 3 || !tri.every((x) => isInt(x) && x >= 0 && x < nv)) {
            errs.push(`${where}.f[${ti}] 必须是 3 个有效顶点索引`);
            return;
          }
          f.push([tri[0], tri[1], tri[2]]);
          triangleTotal++;
        });
      }
      cards.push({
        id: cid,
        rgb,
        d0: Array.isArray(card.depth) ? card.depth[0] : 0,
        d1: Array.isArray(card.depth) ? card.depth[1] : 0,
        xy0,
        xy1,
        f,
      });
    });

    if (triangleTotal > MAX_TRIANGLES) {
      errs.push(`${cwhere} 共有 ${triangleTotal} 个三角形，超过上限 ${MAX_TRIANGLES}`);
    }
    const caseBackground = c.background === undefined
      ? background
      : (checkRgb(c.background, `${cwhere}.background`, errs) || background);

    cases.push({ id, W, H, background: caseBackground, cards });
  });

  if (errs.length) throw new ValidationError(errs);
  return { background, cases };
}

/**
 * 由 case 构建渲染场景。既接受 parseCaseSet 的规范化结果（d0/d1），
 * 也接受原始样例形态（depth: [d0,d1]），便于直接传入单个场景对象。
 * 三角形记录：p0/p1 三个顶点，card 索引；深度与颜色由色片给出。
 */
export function buildScene(caseObj) {
  const { W, H } = caseObj;
  const background = caseObj.background || [0, 0, 0];
  const cards = [];
  const triangles = [];
  caseObj.cards.forEach((card, ci) => {
    const d0 = card.d0 !== undefined ? card.d0 : (Array.isArray(card.depth) ? card.depth[0] : 0);
    const d1 = card.d1 !== undefined ? card.d1 : (Array.isArray(card.depth) ? card.depth[1] : d0);
    cards.push({ id: card.id, rgb: card.rgb.slice(), d0, d1 });
    const nv = card.xy0.length;
    for (const tri of card.f) {
      if (!tri || tri.length !== 3 || tri.some((x) => !(x >= 0 && x < nv))) continue;
      triangles.push({
        card: ci,
        p0x: [card.xy0[tri[0]][0], card.xy0[tri[1]][0], card.xy0[tri[2]][0]],
        p0y: [card.xy0[tri[0]][1], card.xy0[tri[1]][1], card.xy0[tri[2]][1]],
        p1x: [card.xy1[tri[0]][0], card.xy1[tri[1]][0], card.xy1[tri[2]][0]],
        p1y: [card.xy1[tri[0]][1], card.xy1[tri[1]][1], card.xy1[tri[2]][1]],
      });
    }
  });
  return { W, H, background: background.slice(), cards, triangles };
}

// ---------------------------------------------------------------------------
// 几何：线性运动三角形与像素中心
// ---------------------------------------------------------------------------

const EVENT_EPS = 1e-12;
const AABB_EPS = 1e-9;
const DEPTH_EPS = 1e-12;

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** 边 A(t)->B(t) 相对点 P 的有向叉积 E(t)=q2 t²+q1 t+q0 的系数。 */
function edgeQuadratic(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y, px, py) {
  const ax = b0x - a0x;
  const ay = b0y - a0y;
  const bx = (b1x - b0x) - (a1x - a0x);
  const by = (b1y - b0y) - (a1y - a0y);
  const cx = px - a0x;
  const cy = py - a0y;
  const dx = -a1x + a0x;
  const dy = -a1y + a0y;
  const q0 = cross(ax, ay, cx, cy);
  const q1 = cross(ax, ay, dx, dy) + cross(bx, by, cx, cy);
  const q2 = cross(bx, by, dx, dy);
  return [q2, q1, q0];
}

/** 把二次方程在开区间 (lo,hi) 内的实根追加到 out。 */
function quadraticRootsIn(q2, q1, q0, lo, hi, out) {
  const scale = Math.max(Math.abs(q2), Math.abs(q1), Math.abs(q0));
  if (scale === 0) return;
  const eps = 1e-14 * scale;
  if (Math.abs(q2) <= eps) {
    if (Math.abs(q1) <= eps) return;
    const t = -q0 / q1;
    if (t > lo + EVENT_EPS && t < hi - EVENT_EPS) out.push(t);
    return;
  }
  const disc = q1 * q1 - 4 * q2 * q0;
  if (disc < 0) {
    // 允许极小负判别式（数值噪声）
    if (disc > -1e-12 * scale * scale) {
      const t = -q1 / (2 * q2);
      if (t > lo + EVENT_EPS && t < hi - EVENT_EPS) out.push(t);
    }
    return;
  }
  const sq = Math.sqrt(Math.max(0, disc));
  // 数值稳定：避免 -q1 ± sq 的相消
  const qq = -0.5 * (q1 + (q1 >= 0 ? sq : -sq));
  const r1 = qq / q2;
  const r2 = qq === 0 ? 0 : q0 / qq;
  if (r1 > lo + EVENT_EPS && r1 < hi - EVENT_EPS) out.push(r1);
  if (r2 !== r1 && r2 > lo + EVENT_EPS && r2 < hi - EVENT_EPS) out.push(r2);
}

/** 三角形在 t 时刻是否覆盖 (px,py)。边界按“覆盖”处理；零面积三角形不覆盖任何面积。 */
function coversAt(tri, px, py, t) {
  const x0 = tri.p0x[0] + (tri.p1x[0] - tri.p0x[0]) * t;
  const y0 = tri.p0y[0] + (tri.p1y[0] - tri.p0y[0]) * t;
  const x1 = tri.p0x[1] + (tri.p1x[1] - tri.p0x[1]) * t;
  const y1 = tri.p0y[1] + (tri.p1y[1] - tri.p0y[1]) * t;
  const x2 = tri.p0x[2] + (tri.p1x[2] - tri.p0x[2]) * t;
  const y2 = tri.p0y[2] + (tri.p1y[2] - tri.p0y[2]) * t;
  return coversVerts(x0, y0, x1, y1, x2, y2, px, py);
}

function coversVerts(x0, y0, x1, y1, x2, y2, px, py) {
  const e0x = x1 - x0, e0y = y1 - y0;
  const e1x = x2 - x1, e1y = y2 - y1;
  const area = cross(e0x, e0y, x2 - x0, y2 - y0);
  const scale2 = Math.max(
    e0x * e0x + e0y * e0y,
    e1x * e1x + e1y * e1y,
    (x2 - x0) * (x2 - x0) + (y2 - y0) * (y2 - y0),
    1e-300,
  );
  if (Math.abs(area) <= 1e-12 * scale2) return false; // 零面积：不遮挡任何面积
  const c1 = cross(e1x, e1y, px - x1, py - y1);
  const c2 = cross(x0 - x2, y0 - y2, px - x2, py - y2);
  const c0 = cross(e0x, e0y, px - x0, py - y0);
  if (area > 0) return c0 >= 0 && c1 >= 0 && c2 >= 0;
  return c0 <= 0 && c1 <= 0 && c2 <= 0;
}

/** 三角形在 [lo,hi] 时间段的轴对齐包围盒（线性运动，端点即极值）。 */
function triAabb(tri, lo, hi) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 3; i++) {
    const xa = tri.p0x[i] + (tri.p1x[i] - tri.p0x[i]) * lo;
    const xb = tri.p0x[i] + (tri.p1x[i] - tri.p0x[i]) * hi;
    const ya = tri.p0y[i] + (tri.p1y[i] - tri.p0y[i]) * lo;
    const yb = tri.p0y[i] + (tri.p1y[i] - tri.p0y[i]) * hi;
    if (xa < minX) minX = xa;
    if (xb < minX) minX = xb;
    if (xa > maxX) maxX = xa;
    if (xb > maxX) maxX = xb;
    if (ya < minY) minY = ya;
    if (yb < minY) minY = yb;
    if (ya > maxY) maxY = ya;
    if (yb > maxY) maxY = yb;
  }
  return [minX, maxX, minY, maxY];
}

// ---------------------------------------------------------------------------
// 曝光窗口与权重函数
// ---------------------------------------------------------------------------

/**
 * 像素 (py) 所在行的名义曝光窗口 [开始, 结束]（未裁剪到 [0,1]）。
 * scanDir='down' 时从顶部先扫；'up' 时从底部先扫。
 */
export function exposureWindow(py, H, params) {
  const frac = (py + 0.5) / H;
  const offset = (params.scanDir === 'up' ? 1 - frac : frac) * params.scanDelay;
  const start = params.start + offset;
  return [start, start + params.duration];
}

/** 分段线性/常值的权重函数在 [ws,we] 上的原函数。 */
function makeWeightIntegral(kind, ws, we) {
  if (kind === 'uniform') {
    return (u, v) => Math.max(0, v - u);
  }
  const half = (we - ws) / 2;
  if (!(half > 0)) return () => 0;
  const mid = ws + half;
  const F = (t) => {
    if (t <= ws) return 0;
    if (t <= mid) {
      const d = t - ws;
      return (d * d) / (2 * half);
    }
    const u = Math.min(t, we);
    const areaMid = half / 2;
    const seg = (we * u - (u * u) / 2) - (we * mid - (mid * mid) / 2);
    return areaMid + seg / half;
  };
  return (u, v) => {
    const a = Math.max(u, ws);
    const b = Math.min(v, we);
    if (b <= a) return 0;
    return F(b) - F(a);
  };
}

// ---------------------------------------------------------------------------
// 单像素积分
// ---------------------------------------------------------------------------

const NO_COLOR = [0, 0, 0];

function depthAt(card, t) {
  return card.d0 + (card.d1 - card.d0) * t;
}

/** 判断色片 a 是否比色片 b 更靠前（深度更小；相等取 ID 更小）。 */
function isFront(cards, aIdx, bIdx, t) {
  const da = depthAt(cards[aIdx], t);
  const db = depthAt(cards[bIdx], t);
  if (Math.abs(da - db) > DEPTH_EPS) return da < db;
  return compareCardIds(cards[aIdx].id, cards[bIdx].id) < 0;
}

/**
 * 计算单个像素的连续时间曝光积分。
 * @returns {{
 *   rgb:[number,number,number],      归一化的线性颜色（无曝光时为 0）
 *   sum:[number,number,number],      加权线性颜色积分
 *   totalWeight:number,              有效权重积分
 *   segments:Array,                  时间分段（可见色片或背景）
 *   window:[number,number],          名义窗口
 *   clipped:[number,number],         裁剪到 [0,1] 后的积分区间
 * }}
 */
export function integratePixel(scene, px, py, params, wantSegments = false) {
  const { H, cards, triangles, background } = scene;
  const P = px + 0.5;
  const Q = py + 0.5;
  const nominal = exposureWindow(py, H, params);
  const a = Math.max(0, nominal[0]);
  const b = Math.min(1, nominal[1]);
  const empty = {
    rgb: [0, 0, 0],
    sum: [0, 0, 0],
    totalWeight: 0,
    segments: [],
    window: nominal,
    clipped: [a, b],
  };
  if (!(b > a)) return empty;

  const weight = makeWeightIntegral(params.weight, nominal[0], nominal[1]);
  const totalWeight = weight(a, b);
  if (!(totalWeight > 0)) return empty;

  // 候选三角形：在 [a,b] 的包围盒覆盖该点
  const cand = [];
  for (let i = 0; i < triangles.length; i++) {
    const tri = triangles[i];
    const [minX, maxX, minY, maxY] = triAabb(tri, a, b);
    if (P >= minX - AABB_EPS && P <= maxX + AABB_EPS && Q >= minY - AABB_EPS && Q <= maxY + AABB_EPS) {
      cand.push(tri);
    }
  }

  if (cand.length === 0) {
    // 整段都是背景
    const w = weight(a, b);
    const sub = corners3(background);
    const seg = wantSegments
      ? [{ card: -1, id: null, rgb: background.slice(), t0: a, t1: b, weight: w, sum: mul3(background, w) }]
      : null;
    return {
      rgb: sub,
      sum: mul3(background, totalWeight),
      totalWeight,
      segments: seg || [],
      window: nominal,
      clipped: [a, b],
    };
  }

  // 事件：各候选三角形三条边与像素中心相交的时刻
  const events = [a, b];
  for (const tri of cand) {
    pushEdgeRoots(tri, P, Q, a, b, events);
  }
  events.sort((x, y) => x - y);
  const uniq = dedupeTimes(events);

  const sum = [0, 0, 0];
  const segments = wantSegments ? [] : null;

  const addSpan = (u, v, color, cardIdx) => {
    if (!(v > u)) return;
    const w = weight(u, v);
    if (!(w > 0)) return;
    for (let c = 0; c < 3; c++) sum[c] += color[c] * w;
    if (segments) {
      const last = segments[segments.length - 1];
      if (last && last.card === cardIdx && Math.abs(last.t1 - u) < 1e-12) {
        last.t1 = v;
        last.weight += w;
        for (let c = 0; c < 3; c++) last.sum[c] += color[c] * w;
      } else {
        segments.push({
          card: cardIdx,
          id: cardIdx >= 0 ? cards[cardIdx].id : null,
          rgb: color.slice(),
          t0: u,
          t1: v,
          weight: w,
          sum: mul3(color, w),
        });
      }
    }
  };

  for (let k = 0; k + 1 < uniq.length; k++) {
    const l = uniq[k];
    const r = uniq[k + 1];
    if (!(r > l)) continue;
    const mid = (l + r) / 2;

    // 该开区间上覆盖集合恒定
    let coverCards = null;
    for (const tri of cand) {
      if (coversAt(tri, P, Q, mid)) {
        if (!coverCards) coverCards = [];
        if (!coverCards.includes(tri.card)) coverCards.push(tri.card);
      }
    }
    if (!coverCards) {
      addSpan(l, r, background, -1);
      continue;
    }

    // 覆盖集合恒定的基础区间内，按深度交点细分
    const subEvents = [l, r];
    for (let i = 0; i < coverCards.length; i++) {
      for (let j = i + 1; j < coverCards.length; j++) {
        const di = cards[coverCards[i]];
        const dj = cards[coverCards[j]];
        const slope = (di.d1 - di.d0) - (dj.d1 - dj.d0);
        if (Math.abs(slope) <= 1e-15) continue;
        const t = -(di.d0 - dj.d0) / slope;
        if (t > l + EVENT_EPS && t < r - EVENT_EPS) subEvents.push(t);
      }
    }
    subEvents.sort((x, y) => x - y);
    const subs = dedupeTimes(subEvents);
    for (let s = 0; s + 1 < subs.length; s++) {
      const u = subs[s];
      const v = subs[s + 1];
      if (!(v > u)) continue;
      const m2 = (u + v) / 2;
      let front = coverCards[0];
      for (let c = 1; c < coverCards.length; c++) {
        if (isFront(cards, coverCards[c], front, m2)) front = coverCards[c];
      }
      addSpan(u, v, cards[front].rgb, front);
    }
  }

  const rgb = [sum[0] / totalWeight, sum[1] / totalWeight, sum[2] / totalWeight];
  if (segments) {
    for (const s of segments) {
      s.share = s.weight / totalWeight;
      s.contribution = [s.sum[0] / totalWeight, s.sum[1] / totalWeight, s.sum[2] / totalWeight];
    }
  }
  return { rgb, sum, totalWeight, segments: segments || [], window: nominal, clipped: [a, b] };
}

function pushEdgeRoots(tri, px, py, lo, hi, out) {
  const { p0x, p0y, p1x, p1y } = tri;
  for (let e = 0; e < 3; e++) {
    const i = e;
    const j = (e + 1) % 3;
    const [q2, q1, q0] = edgeQuadratic(
      p0x[i], p0y[i], p1x[i], p1y[i],
      p0x[j], p0y[j], p1x[j], p1y[j],
      px, py,
    );
    quadraticRootsIn(q2, q1, q0, lo, hi, out);
  }
}

function dedupeTimes(arr) {
  if (arr.length <= 1) return arr;
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] - out[out.length - 1] > EVENT_EPS) out.push(arr[i]);
  }
  return out;
}

function mul3(c, s) {
  return [c[0] * s, c[1] * s, c[2] * s];
}

function corners3(c) {
  return [c[0], c[1], c[2]];
}

// ---------------------------------------------------------------------------
// 整帧渲染
// ---------------------------------------------------------------------------

/**
 * 瞬时画面：t 时刻每个像素中心的最前色片颜色（或背景）。
 * @param {Float64Array} [out] 可复用的 W*H*3 缓冲
 * @param {Uint8Array} [maskOut] 可复用的 W*H 覆盖掩码（1=有三角形覆盖）
 */
export function renderInstant(scene, t, out, maskOut) {
  const { W, H, background, cards, triangles } = scene;
  const data = out && out.length === W * H * 3 ? out : new Float64Array(W * H * 3);
  const mask = maskOut && maskOut.length === W * H ? maskOut : new Uint8Array(W * H);
  data.fill(0);
  mask.fill(0);
  // 提前计算每个三角形在 t 的顶点与深度
  const active = [];
  for (const tri of triangles) {
    const x0 = tri.p0x[0] + (tri.p1x[0] - tri.p0x[0]) * t;
    const y0 = tri.p0y[0] + (tri.p1y[0] - tri.p0y[0]) * t;
    const x1 = tri.p0x[1] + (tri.p1x[1] - tri.p0x[1]) * t;
    const y1 = tri.p0y[1] + (tri.p1y[1] - tri.p0y[1]) * t;
    const x2 = tri.p0x[2] + (tri.p1x[2] - tri.p0x[2]) * t;
    const y2 = tri.p0y[2] + (tri.p1y[2] - tri.p0y[2]) * t;
    const minX = Math.min(x0, x1, x2);
    const maxX = Math.max(x0, x1, x2);
    const minY = Math.min(y0, y1, y2);
    const maxY = Math.max(y0, y1, y2);
    active.push({ tri, x0, y0, x1, y1, x2, y2, minX, maxX, minY, maxY });
  }
  for (let py = 0; py < H; py++) {
    const Q = py + 0.5;
    for (let px = 0; px < W; px++) {
      const P = px + 0.5;
      let bestCard = -1;
      let bestDepth = Infinity;
      for (const a of active) {
        if (P < a.minX || P > a.maxX || Q < a.minY || Q > a.maxY) continue;
        if (!coversVerts(a.x0, a.y0, a.x1, a.y1, a.x2, a.y2, P, Q)) continue;
        const card = a.tri.card;
        const d = depthAt(cards[card], t);
        if (bestCard < 0) {
          bestCard = card;
          bestDepth = d;
        } else if (Math.abs(d - bestDepth) > DEPTH_EPS ? d < bestDepth : compareCardIds(cards[card].id, cards[bestCard].id) < 0) {
          bestCard = card;
          bestDepth = d;
        }
      }
      const o = (py * W + px) * 3;
      if (bestCard < 0) {
        data[o] = background[0];
        data[o + 1] = background[1];
        data[o + 2] = background[2];
      } else {
        const color = cards[bestCard].rgb;
        data[o] = color[0];
        data[o + 1] = color[1];
        data[o + 2] = color[2];
        mask[py * W + px] = 1;
      }
    }
  }
  renderInstant.mask = mask;
  return data;
}

/**
 * 整帧曝光积分。返回 { data: Float64Array(W*H*3), weights: Float64Array(W*H) }。
 * 可传入 progress 回调（每行一次）。
 */
export function renderIntegrated(scene, params, progress) {
  const { W, H } = scene;
  const data = new Float64Array(W * H * 3);
  const weights = new Float64Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const r = integratePixel(scene, px, py, params, false);
      const o = (py * W + px) * 3;
      data[o] = r.rgb[0];
      data[o + 1] = r.rgb[1];
      data[o + 2] = r.rgb[2];
      weights[py * W + px] = r.totalWeight;
    }
    if (progress) progress(py + 1, H);
  }
  return { data, weights };
}

/** 线性 RGB -> sRGB 传输编码（显示用）。 */
export function linearToSrgb(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
