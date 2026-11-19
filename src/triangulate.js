// 面三角化：环拆分、孔洞架桥、精确耳切（全部 BigInt 精确运算，无第三方库）
import { f0, Frac } from './frac.js';
import {
  pt, ptEq, ptKey, ptCmp, orient, pointInTriangleClosed,
  segmentIntersection, ringArea2,
} from './geometry.js';

// 连续去重
function dedupeRing(ids, P) {
  const out = [];
  for (const id of ids) {
    if (!out.length || !ptEq(P(out[out.length - 1]), P(id))) out.push(id);
  }
  if (out.length > 1 && ptEq(P(out[0]), P(out[out.length - 1]))) out.pop();
  return out;
}

// 在重复顶点处拆成若干简单环
function splitAtRepeats(ids, P) {
  const result = [];
  let cur = [];
  let where = new Map();
  for (const id of ids) {
    const k = ptKey(P(id));
    if (where.has(k)) {
      const j = where.get(k);
      const sub = cur.slice(j, cur.length);
      const clean = dedupeRing(sub, P);
      if (clean.length >= 3) result.push(clean);
      cur = cur.slice(0, j + 1);
      where = new Map();
      cur.forEach((q, i) => where.set(ptKey(P(q)), i));
    } else {
      where.set(k, cur.length);
      cur.push(id);
    }
  }
  const tail = dedupeRing(cur, P);
  if (tail.length >= 3) result.push(tail);
  return result;
}

// 精确射线法点在环内：1 内 / 0 边界 / -1 外（环顶点为简单环）
function pointInRing(p, ring, P) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = P(ring[j]), b = P(ring[i]);
    if (orient(a, b, p) === 0 &&
        p.x.cmp(a.x.cmp(b.x) <= 0 ? a.x : b.x) >= 0 &&
        p.x.cmp(a.x.cmp(b.x) >= 0 ? a.x : b.x) <= 0 &&
        p.y.cmp(a.y.cmp(b.y) <= 0 ? a.y : b.y) >= 0 &&
        p.y.cmp(a.y.cmp(b.y) >= 0 ? a.y : b.y) <= 0) {
      return 0;
    }
    const yi = b.y, yj = a.y, xi = b.x, xj = a.x;
    if (yi.cmp(p.y) > 0 !== yj.cmp(p.y) > 0) {
      const xCross = xj.sub(xi).mul(p.y.sub(yi)).div(yj.sub(yi)).add(xi);
      if (xCross.cmp(p.x) > 0) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

// 开线段 (u,v) 与边集合是否在内部相交（端点 u/v 处接触允许；共线重叠算阻挡）
function segmentBlocked(u, v, edges, P) {
  const su = { a: u, b: v };
  for (const [ea, eb] of edges) {
    // 与桥共享端点的边不阻挡
    if ((ptEq(ea, u) && ptEq(eb, v)) || (ptEq(ea, v) && ptEq(eb, u))) continue;
    const hit = segmentIntersection(su, { a: ea, b: eb });
    if (hit.type === 'none') continue;
    if (hit.type === 'segment') {
      // 共线但仅在端点接触则放行
      if (ptEq(hit.points[0], hit.points[1])) continue;
      return true;
    }
    const h = hit.points[0];
    if (!ptEq(h, u) && !ptEq(h, v)) return true;
  }
  return false;
}

function dist2(a, b) {
  const dx = a.x.sub(b.x), dy = a.y.sub(b.y);
  return dx.mul(dx).add(dy.mul(dy));
}

// 水平射线架桥：把 CW 孔 hole 接到"原始父环" parentRing（未被桥接污染的简单环）。
// 从孔最左顶点向右水平投射，在父环上取最近交点 M（辅助顶点），返回拼接环。
// 关键：射线只与干净的父环求交，避免命中已拼接环的桥接尖刺。
function bridgeToParent(parentRing, hole, verts, P) {
  let hIdx = 0;
  for (let i = 1; i < hole.length; i++) {
    const c = ptCmp(P(hole[i]), P(hole[hIdx]));
    if (c < 0) hIdx = i;
  }
  const Hvid = hole[hIdx];
  const H = P(Hvid);
  let best = null;
  for (let i = 0; i < parentRing.length; i++) {
    const a = P(parentRing[i]), b = P(parentRing[(i + 1) % parentRing.length]);
    if (a.y.eq(b.y)) continue;
    const yLo = a.y.cmp(b.y) < 0 ? a.y : b.y;
    const yHi = a.y.cmp(b.y) > 0 ? a.y : b.y;
    if (H.y.cmp(yLo) <= 0 || H.y.cmp(yHi) >= 0) continue;
    const t = H.y.sub(a.y).div(b.y.sub(a.y));
    const ix = a.x.add(b.x.sub(a.x).mul(t));
    if (ix.cmp(H.x) <= 0) continue;
    if (best === null || ix.cmp(best.ix) < 0) best = { edgeIdx: i, ix, t };
  }
  if (best === null) throw new Error('水平射线架桥失败：未找到父边');
  const ea = P(parentRing[best.edgeIdx]);
  const eb = P(parentRing[(best.edgeIdx + 1) % parentRing.length]);
  verts.push(pt(ea.x.add(eb.x.sub(ea.x).mul(best.t)), H.y));
  const Mid = verts.length - 1;
  // 在父环副本中插入 M
  const newParent = parentRing.slice(0, best.edgeIdx + 1)
    .concat([Mid])
    .concat(parentRing.slice(best.edgeIdx + 1));
  const mPos = best.edgeIdx + 1;
  const holeRe = hole.slice(hIdx).concat(hole.slice(0, hIdx));
  return newParent.slice(0, mPos + 1)
    .concat(holeRe)
    .concat([Hvid, Mid])
    .concat(newParent.slice(mPos + 1));
}

// 耳切：环为 CCW 弱简单多边形（允许架桥产生的重复位置点，不能整体去重——删了桥会断）
function earClip(ringIds, P) {
  let ids = ringIds.slice();
  const tris = [];
  let guard = 0;
  while (ids.length >= 3) {
    if (++guard > 100000) throw new Error('耳切保护上限');
    const n = ids.length;
    let ear = -1;
    for (let i = 0; i < n; i++) {
      const a = ids[(i - 1 + n) % n];
      const b = ids[i];
      const c = ids[(i + 1) % n];
      if (orient(P(a), P(b), P(c)) <= 0) continue; // 非凸或零面积步
      let blocked = false;
      for (let k = 0; k < n; k++) {
        const v = ids[k];
        if (v === a || v === b || v === c) continue;
        if (ptEq(P(v), P(a)) || ptEq(P(v), P(b)) || ptEq(P(v), P(c))) continue;
        if (pointInTriangleClosed([P(a), P(b), P(c)], P(v))) { blocked = true; break; }
      }
      if (!blocked) { ear = i; break; }
    }
    if (ear === -1) {
      // 回退 1：删除尖刺/共线点（位置重合或与前后共线），这类点不贡献面积
      const spike = ids.findIndex((b, i) => {
        const a = ids[(i - 1 + ids.length) % ids.length];
        const c = ids[(i + 1) % ids.length];
        return ptEq(P(a), P(b)) || ptEq(P(b), P(c)) || orient(P(a), P(b), P(c)) === 0;
      });
      if (spike !== -1) { ids.splice(spike, 1); continue; }
      // 回退 2：对角线分裂
      const pieces = diagonalSplit(ids, P);
      for (const piece of pieces) {
        for (const t of earClip(piece, P)) tris.push(t);
      }
      return tris;
    }
    const n2 = ids.length;
    const a = ids[(ear - 1 + n2) % n2];
    const b = ids[ear];
    const c = ids[(ear + 1) % n2];
    if (orient(P(a), P(b), P(c)) > 0) tris.push([a, b, c]); // 跳过零面积
    ids.splice(ear, 1);
  }
  return tris;
}

// 回退分裂：找一条不与任何边内部相交的对角线，把环切成两段。
// 不依赖 pointInRing（对自接触/尖刺环不可靠），仅用精确边相交 + 中点朝向判定。
function diagonalSplit(ids, P) {
  const n = ids.length;
  const edges = [];
  for (let i = 0; i < n; i++) edges.push([P(ids[i]), P(ids[(i + 1) % n])]);
  // 按对角线长度优先尝试较短者（更可能是局部内对角线）
  const cand = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const u = ids[i], v = ids[j];
      if (ptEq(P(u), P(v))) continue;
      cand.push([i, j]);
    }
  }
  cand.sort(([ia, ib], [ja, jb]) =>
    dist2(P(ids[ia]), P(ids[ib])).cmp(dist2(P(ids[ja]), P(ids[jb]))));
  for (const [i, j] of cand) {
    const u = ids[i], v = ids[j];
    if (segmentBlocked(P(u), P(v), edges, P)) continue;
    // 中点处该对角线两侧朝向：要求至少一个子环面积为正（有效分裂）
    const r1 = ids.slice(i, j + 1);
    const r2 = ids.slice(j).concat(ids.slice(0, i + 1));
    const c1 = dedupeRing(r1, P), c2 = dedupeRing(r2, P);
    if (c1.length < 3 || c2.length < 3) continue;
    if (ringArea2(c1.map(P)).sign() <= 0 || ringArea2(c2.map(P)).sign() <= 0) continue;
    return [c1, c2];
  }
  throw new Error('对角线分裂失败');
}

// 三角化一个面：faceLoops 为 vid 环数组（CCW 外环 + CW 孔环，支持嵌套、多外环）
export function triangulateFace(faceLoops, verts) {
  const P = (id) => verts[id];
  // 1. 拆重复顶点环 + 分类
  const outers = [], holes = [];
  for (const loop of faceLoops) {
    for (const simple of splitAtRepeats(dedupeRing(loop, P), P)) {
      const area = ringArea2(simple.map(P));
      if (area.sign() === 0) continue;
      if (area.sign() > 0) outers.push(simple);
      else holes.push(simple);
    }
  }
  const triangles = [];

  // 环包含（严格），用于建孔嵌套树
  const loopContains = (outer, inner) => {
    let strict = false;
    for (const id of inner) {
      const t = pointInRing(P(id), outer, P);
      if (t === -1) return false;
      if (t === 1) strict = true;
    }
    return strict;
  };

  // 2. 每个外环独立处理；先把孔按直接包含关系组织成嵌套树
  const usedHole = new Set();
  for (const outer of outers) {
    const myHoles = [];
    for (let hi = 0; hi < holes.length; hi++) {
      if (usedHole.has(hi)) continue;
      if (pointInRing(P(holes[hi][0]), outer, P) === 1) {
        myHoles.push(holes[hi]);
        usedHole.add(hi);
      }
    }
    if (!myHoles.length) {
      for (const t of earClip(outer, P)) triangles.push(t);
      continue;
    }

    // 孔的直接父：另一孔（最近包含者）或 -1（外环）
    const holeParent = myHoles.map((h) => {
      let best = -1;
      myHoles.forEach((other, oj) => {
        if (other === h) return;
        if (!loopContains(other, h)) return;
        if (best === -1 || loopContains(myHoles[best], other)) best = oj;
      });
      return best;
    });

    // 环带三角化：把"父 CCW 边界 + 其直接 CW 孩子孔"作为单层带，
    // 用水平射线架桥（仅单层，射线必命中干净父环）后耳切。
    // 从最内层向外逐层处理，每层独立，避免深嵌套尖刺环。
    // 深度
    const depthOf = (idx) => {
      let d = 0, p = holeParent[idx];
      const seen = new Set();
      while (p !== -1 && !seen.has(p)) { seen.add(p); d++; p = holeParent[p]; }
      return d;
    };
    const maxDepth = myHoles.reduce((m, _, i) => Math.max(m, depthOf(i)), 0);

    // 每个"带"的父边界：外环或某个孔。孩子 = 直接挂在它下面的孔。
    // 从最深层开始，每带独立架桥三角化。
    // bandParent 标识：-1=外环，否则=孔索引
    for (let depth = maxDepth; depth >= 0; depth--) {
      // 该深度的孔作为"父边界"，其孩子在 depth+1；外环（-1）的根孔在 depth 0
      if (depth === 0) {
        // 外环带：outer + 根孔
        const rootHoles = myHoles.filter((_, i) => holeParent[i] === -1);
        let ring = outer;
        for (const h of rootHoles) ring = bridgeToParent(ring, h, verts, P);
        for (const t of earClip(ring, P)) triangles.push(t);
      } else {
        // 该深度的每个孔，与它的直接孩子形成一个内部填充带（孔内、孩子外之间）
        const parents = myHoles.map((_, i) => i).filter((i) => depthOf(i) === depth);
        for (const pi of parents) {
          const kids = myHoles.map((_, i) => i).filter((i) => holeParent[i] === pi);
          if (!kids.length) continue;
          // 父孔是 CW，取反成 CCW 作为该带外环
          let bandOuter = myHoles[pi].slice().reverse();
          for (const ki of kids) bandOuter = bridgeToParent(bandOuter, myHoles[ki], verts, P);
          for (const t of earClip(bandOuter, P)) triangles.push(t);
        }
      }
    }
  }
  return triangles;
}
