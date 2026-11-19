// 平面剖分：输入整数轮廓 -> 原子边 -> 半边结构 -> 面 -> 绕数
import { Frac, f0 } from './frac.js';
import {
  pt, ptInt, ptEq, ptCmp, ptKey, orient, vecCross,
  bboxDisjoint, segmentIntersection, ringArea2,
} from './geometry.js';

// ---------- 输入清洗 ----------
const lexMin = (a, b) => (a.cmp(b) <= 0 ? a : b);
const lexMax = (a, b) => (a.cmp(b) >= 0 ? a : b);

export function validateRawContours(contours) {
  if (!Array.isArray(contours)) throw new Error('contours 必须是数组');
  const cleaned = [];
  let edgeCount = 0;
  for (let ci = 0; ci < contours.length; ci++) {
    const raw = contours[ci];
    if (!Array.isArray(raw)) {
      throw new Error(`轮廓 #${ci} 必须是点数组`);
    }
    // 点过少的退化轮廓直接忽略（零长边/退化几何不参与填充）
    if (raw.length < 3) continue;
    const ring = [];
    for (const p of raw) {
      if (!Array.isArray(p) || p.length !== 2) {
        throw new Error(`轮廓 #${ci} 存在非二维点`);
      }
      const [x, y] = p;
      if (typeof x !== 'number' || typeof y !== 'number' ||
          !Number.isInteger(x) || !Number.isInteger(y)) {
        throw new Error(`轮廓 #${ci} 含非整数坐标: ${JSON.stringify(p)}`);
      }
      if (Math.abs(x) > 4096 || Math.abs(y) > 4096) {
        throw new Error(`轮廓 #${ci} 坐标超出 [-4096,4096]`);
      }
      const q = ptInt(x, y);
      // 消除连续重复点（含末点重复首点）
      if (!ring.length || !ptEq(ring[ring.length - 1], q)) ring.push(q);
    }
    // 首尾再消一次（末点 == 首点的情况）
    while (ring.length > 1 && ptEq(ring[0], ring[ring.length - 1])) ring.pop();
    if (ring.length < 3) {
      // 退化轮廓（零面积/零长边）忽略
      continue;
    }
    cleaned.push(ring);
    edgeCount += ring.length;
  }
  if (edgeCount > 512) throw new Error(`闭合线段总数 ${edgeCount} 超过 512`);
  return cleaned;
}

// 边上参数 t（沿 p->q），调用方保证 r 与 p,q 共线
function paramT(p, q, r) {
  const dx = q.x.sub(p.x), dy = q.y.sub(p.y);
  const num = r.x.sub(p.x).mul(dx).add(r.y.sub(p.y).mul(dy));
  const den = dx.mul(dx).add(dy.mul(dy));
  return num.div(den);
}

// ---------- 构造平面剖分 ----------
export function buildArrangement(cleanedContours) {
  const nE0 = []; // 原始有向边 {a,b,contour}
  cleanedContours.forEach((ring, ci) => {
    for (let i = 0; i < ring.length; i++) {
      nE0.push({ a: ring[i], b: ring[(i + 1) % ring.length], contour: ci });
    }
  });

  // 每条原始边收集分割点
  const splits = nE0.map((e) => [e.a, e.b]);
  for (let i = 0; i < nE0.length; i++) {
    for (let j = i + 1; j < nE0.length; j++) {
      const s1 = nE0[i], s2 = nE0[j];
      if (bboxDisjoint(s1, s2)) continue;
      const hit = segmentIntersection(s1, s2);
      if (hit.type === 'none') continue;
      for (const p of hit.points) {
        splits[i].push(p);
        splits[j].push(p);
      }
    }
  }

  // 原子几何边（去重），并累计每条有向原边的贡献
  const atomicMap = new Map(); // key -> atomic id
  const atomic = []; // {lo,hi, covers:[{contour,dir}], delta, parity}
  const getAtomic = (u, v) => {
    const lo = ptCmp(u, v) <= 0 ? u : v;
    const hi = lo === u ? v : u;
    const key = `${ptKey(lo)}#${ptKey(hi)}`;
    let id = atomicMap.get(key);
    if (id === undefined) {
      id = atomic.length;
      atomicMap.set(key, id);
      atomic.push({ lo, hi, covers: [] });
    }
    return id;
  };
  nE0.forEach((e, idx) => {
    const pts = splits[idx];
    pts.sort((r1, r2) => paramT(e.a, e.b, r1).cmp(paramT(e.a, e.b, r2)));
    const uniq = [];
    for (const p of pts) {
      if (!uniq.length || !ptEq(uniq[uniq.length - 1], p)) uniq.push(p);
    }
    for (let k = 0; k + 1 < uniq.length; k++) {
      const u = uniq[k], v = uniq[k + 1];
      if (ptEq(u, v)) continue;
      const id = getAtomic(u, v);
      const forward = ptEq(atomic[id].lo, u); // 原边方向是否与 lo->hi 同向
      atomic[id].covers.push({ contour: e.contour, dir: forward ? 1 : -1 });
    }
  });
  for (const g of atomic) {
    g.delta = g.covers.reduce((s, c) => s + c.dir, 0);
    g.parity = g.covers.length % 2;
  }

  // ---------- 顶点 ----------
  const verts = [];
  const vMap = new Map();
  const vid = (p) => {
    const k = ptKey(p);
    let id = vMap.get(k);
    if (id === undefined) {
      id = verts.length;
      vMap.set(k, id);
      verts.push({ id, x: p.x, y: p.y });
    }
    return id;
  };

  // ---------- 半边 ----------
  // 每条原子边生成 h(lo->hi, 偶数 id) 与 twin(hi->lo, 奇数 id)
  const half = []; // {origin, twin, geom, next, face}
  const out = new Map(); // vid -> [halfedge ids]
  const addHalf = (originId, twinId, geomId) => {
    const id = half.length;
    half.push({ origin: originId, twin: twinId, geom: geomId, next: -1, face: -1 });
    if (!out.has(originId)) out.set(originId, []);
    out.get(originId).push(id);
    return id;
  };
  for (let gId = 0; gId < atomic.length; gId++) {
    const g = atomic[gId];
    const u = vid(g.lo), v = vid(g.hi);
    const h1 = half.length;
    const h2 = half.length + 1;
    addHalf(u, h2, gId);
    addHalf(v, h1, gId);
  }

  // 每个顶点的出边按极角 CCW 排序（无同射线并列：重叠边已合并）
  const angleLess = (hA, hB) => {
    const o = verts[half[hA].origin];
    const va = verts[half[half[hA].twin].origin];
    const vb = verts[half[half[hB].twin].origin];
    const ax = va.x.sub(o.x), ay = va.y.sub(o.y);
    const bx = vb.x.sub(o.x), by = vb.y.sub(o.y);
    const ha = ay.sign() > 0 || (ay.sign() === 0 && ax.sign() >= 0) ? 0 : 1;
    const hb = by.sign() > 0 || (by.sign() === 0 && bx.sign() >= 0) ? 0 : 1;
    if (ha !== hb) return ha < hb;
    const cr = ax.mul(by).sub(ay.mul(bx)).sign();
    return cr > 0;
  };
  for (const list of out.values()) {
    list.sort((a, b) => (angleLess(a, b) ? -1 : 1));
  }

  // next(h) = 目标顶点出边中 twin(h) 的顺时针前一条
  for (let h = 0; h < half.length; h++) {
    const v = half[half[h].twin].origin;
    const list = out.get(v);
    const pos = list.indexOf(half[h].twin);
    half[h].next = list[(pos - 1 + list.length) % list.length];
  }

  // ---------- 阶段 1：next 连通分量（拓扑面），仅用于绕数传播 ----------
  const topoFace = new Array(half.length).fill(-1); // 半边 -> 拓扑面 id
  const topoFaces = [];
  for (let h = 0; h < half.length; h++) {
    if (topoFace[h] !== -1) continue;
    const fid = topoFaces.length;
    topoFaces.push(fid);
    let cur = h;
    do {
      topoFace[cur] = fid;
      cur = half[cur].next;
    } while (cur !== h);
  }

  // 定位外拓扑面：全局最左下顶点出边的孪生半边所在面
  let minV = 0;
  for (let i = 1; i < verts.length; i++) {
    if (ptCmp(verts[i], verts[minV]) < 0) minV = i;
  }
  const firstOut = out.get(minV)[0];
  const outerTopo = topoFace[half[firstOut].twin];

  // 拓扑面邻接（跨孪生边）
  const adj = topoFaces.map(() => []);
  for (let h = 0; h < half.length; h++) {
    adj[topoFace[h]].push({ to: topoFace[half[h].twin], via: h });
  }

  // 任一点对全部原始轮廓的全局绕数（精确），用于给不连通分量定基数
  const globalWinding = (p) => {
    let wn = 0, cross = 0;
    for (const ring of cleanedContours) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const s = orient(a, b, p);
        if (a.y.cmp(p.y) <= 0) {
          if (b.y.cmp(p.y) > 0 && s > 0) { wn++; cross++; }
        } else if (b.y.cmp(p.y) <= 0 && s < 0) { wn--; cross++; }
      }
    }
    return { wn, odd: cross % 2 === 1 };
  };
  // 拓扑面内点：取该面一条半边，向面内微偏。简单做法用该面某环顶点平均后，
  // 若落在边上则改用三角形重心；这里用"第一条边中点 + 法向微偏"并选落在面内者。
  const faceInteriorSample = (tf) => {
    for (let h = 0; h < half.length; h++) {
      if (topoFace[h] !== tf) continue;
      const o = verts[half[h].origin];
      const d = verts[half[half[h].twin].origin];
      const mid = { x: o.x.add(d.x).div(new Frac(2n)), y: o.y.add(d.y).div(new Frac(2n)) };
      // 沿该半边左侧法向移动一个极小有理数
      const dx = d.x.sub(o.x), dy = d.y.sub(o.y);
      const shifted = {
        x: mid.x.sub(dy.div(new Frac(BigInt(10 ** 6)))),
        y: mid.y.add(dx.div(new Frac(BigInt(10 ** 6)))),
      };
      return { mid, shifted };
    }
    return null;
  };

  // 绕数多源 BFS：每个不连通分量用全局绕数定基数，再沿孪生边按有向贡献传播
  const wNZ = new Array(topoFaces.length).fill(null);
  const wEO = new Array(topoFaces.length).fill(null);
  for (let seed = 0; seed < topoFaces.length; seed++) {
    if (wNZ[seed] !== null) continue;
    const comp = [];
    const stk = [seed];
    const seen = new Set([seed]);
    while (stk.length) {
      const x = stk.pop();
      comp.push(x);
      for (const e of adj[x]) {
        if (!seen.has(e.to)) { seen.add(e.to); stk.push(e.to); }
      }
    }
    // 分量最外面：含该分量最左下顶点的拓扑面
    let compMinV = -1;
    for (const f of comp) {
      for (let h = 0; h < half.length; h++) {
        if (topoFace[h] !== f) continue;
        const v = half[h].origin;
        if (compMinV === -1 || ptCmp(verts[v], verts[compMinV]) < 0) compMinV = v;
      }
    }
    const compOuter = topoFace[half[out.get(compMinV)[0]].twin];
    // 用全局轮廓给分量外面定绝对绕数（采样点取内偏点，避免落边）
    const samp = faceInteriorSample(compOuter);
    const gw = samp ? globalWinding(samp.shifted) : { wn: 0, odd: false };
    wNZ[compOuter] = gw.wn;
    wEO[compOuter] = gw.odd ? 1 : 0;
    const queue = [compOuter];
    while (queue.length) {
      const f = queue.shift();
      for (const { to, via } of adj[f]) {
        if (wNZ[to] !== null) continue;
        const g = atomic[half[via].geom];
        const dLeft = half[via].origin === vMap.get(ptKey(g.lo)) ? g.delta : -g.delta;
        wNZ[to] = wNZ[f] - dLeft;
        wEO[to] = wEO[f] ^ g.parity;
        queue.push(to);
      }
    }
  }

  // ---------- 阶段 2：枚举简单环，拆自接触，并绑定拓扑面绕数 ----------
  const rawCycles = [];
  const halfRawCycle = new Array(half.length).fill(-1);
  const visitedH = new Set();
  for (let h = 0; h < half.length; h++) {
    if (visitedH.has(h)) continue;
    const ci = rawCycles.length;
    const halves = [];
    const ring = [];
    let cur = h;
    do {
      visitedH.add(cur);
      halfRawCycle[cur] = ci;
      halves.push(cur);
      ring.push(half[cur].origin);
      cur = half[cur].next;
    } while (cur !== h);
    rawCycles.push({ halves, ring });
  }

  // 拆自接触环为简单子环；记录每半边所属简单环、每简单环的拓扑面
  const cycles = [];
  const halfCycle = new Array(half.length).fill(-1);
  const emit = (halfList) => {
    const ring = halfList.map((hh) => half[hh].origin);
    if (ring.length < 3) return -1;
    const id = cycles.length;
    cycles.push({
      ring,
      area2: ringArea2(ring.map((i) => verts[i])),
      topo: topoFace[halfList[0]],
    });
    for (const hh of halfList) halfCycle[hh] = id;
    return id;
  };
  for (const rc of rawCycles) {
    const where = new Map();
    let curH = [];
    for (const hh of rc.halves) {
      const o = half[hh].origin;
      if (where.has(o)) {
        const j = where.get(o);
        emit(curH.slice(j));
        curH = curH.slice(0, j + 1);
        where.clear();
        curH.forEach((q, i) => where.set(half[q].origin, i));
      } else {
        where.set(o, curH.length);
        curH.push(hh);
      }
    }
    emit(curH);
  }

  // 每个拓扑面对应一个区域面。真正的外面 = 全局绕数为 0 的拓扑面
  // （相切/多分量情形下"最左下点"启发式不可靠，BFS 已给出精确全局绕数）。
  const topoToRegion = new Map();
  const faces = [];
  const makeFace = () => {
    const id = faces.length;
    faces.push({ id, loops: [], area2: f0, topoIds: [] });
    return id;
  };
  const outerFace = makeFace();
  // 找含全局最左下顶点且绕数为 0 的拓扑面作为外面；兜底用 outerTopo
  let gMinV = 0;
  for (let i = 1; i < verts.length; i++) {
    if (ptCmp(verts[i], verts[gMinV]) < 0) gMinV = i;
  }
  let realOuterTopo = -1;
  // 该顶点各出边的孪生面中，绕数为 0 的即外面
  for (const hh of out.get(gMinV)) {
    const tf = topoFace[half[hh].twin];
    if (wNZ[tf] === 0 && wEO[tf] === 0) { realOuterTopo = tf; break; }
  }
  if (realOuterTopo === -1) realOuterTopo = outerTopo;
  for (let tf = 0; tf < topoFaces.length; tf++) {
    if (tf === realOuterTopo) topoToRegion.set(tf, outerFace);
    else topoToRegion.set(tf, makeFace());
  }
  // 环先按拓扑面归入区域面
  const cycleRegion = new Array(cycles.length).fill(outerFace);
  cycles.forEach((cyc, ci) => {
    if (cyc.area2.sign() === 0) { cycleRegion[ci] = outerFace; return; }
    cycleRegion[ci] = topoToRegion.get(cyc.topo);
  });

  // 几何包含（简单环）
  const onSeg = (a, b, p) => {
    if (orient(a, b, p) !== 0) return false;
    return p.x.cmp(lexMin(a.x, b.x)) >= 0 && p.x.cmp(lexMax(a.x, b.x)) <= 0 &&
           p.y.cmp(lexMin(a.y, b.y)) >= 0 && p.y.cmp(lexMax(a.y, b.y)) <= 0;
  };
  const ringTest = (p, ring) => {
    // 先严格判边界（点必须真的落在某条边上）
    for (let i = 0; i < ring.length; i++) {
      if (onSeg(verts[ring[i]], verts[ring[(i + 1) % ring.length]], p)) return 0;
    }
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = verts[ring[j]], b = verts[ring[i]];
      if (b.y.cmp(p.y) > 0 !== a.y.cmp(p.y) > 0) {
        const xc = a.x.sub(b.x).mul(p.y.sub(b.y)).div(a.y.sub(b.y)).add(b.x);
        if (xc.cmp(p.x) > 0) inside = !inside;
      }
    }
    return inside ? 1 : -1;
  };
  const contains = (a, b) => {
    let strict = false;
    for (const id of b.ring) {
      const t = ringTest(verts[id], a.ring);
      if (t === -1) return false;
      if (t === 1) strict = true;
    }
    return strict;
  };

  // 区域面嵌套：用每面的主环（面积绝对值最大者）做包含判定
  const regionMainRing = (fid) => {
    let best = -1, bestAbs = null;
    cycles.forEach((cyc, ci) => {
      if (cycleRegion[ci] !== fid || cyc.area2.sign() === 0) return;
      const abs = cyc.area2.abs();
      if (bestAbs === null || abs.cmp(bestAbs) > 0) { bestAbs = abs; best = ci; }
    });
    return best;
  };
  const regionIds = faces.map((_, i) => i).filter((fid) => fid !== outerFace);
  const regionParent = new Map();
  for (const fid of regionIds) {
    const myRing = cycles[regionMainRing(fid)];
    let best = -1;
    for (const other of regionIds) {
      if (other === fid) continue;
      const otherRing = cycles[regionMainRing(other)];
      if (!contains(otherRing, myRing)) continue;
      if (best === -1) best = other;
      else {
        const bestRing = cycles[regionMainRing(best)];
        if (contains(bestRing, otherRing)) best = other;
      }
    }
    regionParent.set(fid, best === -1 ? outerFace : best);
  }

  // 把嵌套子面（孔/岛）的环并入父面，形成"外环+孔环"的完整区域面；
  // 但绕数不同的子面必须保留为独立区域，只合并绕数相同且为"洞"（父填充、子不填）的情形。
  // 为保证三角化输入正确：区域面保留自己全部环；嵌套关系仅用于导出 regions 层级，
  // 三角化按每个有界拓扑面独立处理（其环即该面边界，孔在另一拓扑面，不会被错误填充）。
  // 区域面嵌套（几何包含），供 pipeline 组装外环/孔环
  const regionParentFinal = new Map();
  for (const fid of regionIds) {
    regionParentFinal.set(fid, regionParent.get(fid));
  }

  cycles.forEach((cyc, ci) => {
    if (cyc.area2.sign() !== 0) faces[cycleRegion[ci]].loops.push(cyc.ring);
  });
  for (let h = 0; h < half.length; h++) {
    const ci = halfCycle[h];
    half[h].face = ci === -1 ? outerFace : cycleRegion[ci];
  }
  for (const f of faces) {
    let s = f0;
    for (const ring of f.loops) s = s.add(ringArea2(ring.map((i) => verts[i])));
    f.area2 = s;
  }

  // 区域面绕数 = 其拓扑面绕数
  const faceWNZ = new Array(faces.length).fill(0);
  const faceWEO = new Array(faces.length).fill(0);
  for (const [tf, fid] of topoToRegion) {
    faceWNZ[fid] = wNZ[tf];
    faceWEO[fid] = wEO[tf];
  }

  return {
    contours: cleanedContours,
    verts, half, atomic, faces, outerFace,
    windNZ: faceWNZ, windEO: faceWEO,
    regionParent: regionParentFinal,
    topoWindNZ: wNZ, topoWindEO: wEO,
  };
}
