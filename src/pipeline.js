// 总管线：清洗 -> 剖分 -> 绕数分区 -> 三角化 -> 精确面积（仅统计实际输出三角形）
import { Frac, f0 } from './frac.js';
import { ptEq, ptCmp, ptKey, orient, ringArea2 } from './geometry.js';
import { validateRawContours, buildArrangement } from './arrangement.js';
import { triangulateFace } from './triangulate.js';

// 单条轮廓对 p 的精确绕数（带符号）与奇偶
function contourWinding(ring, p) {
  let wn = 0;
  let crossings = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const left = orient(a, b, p); // (b-a)×(p-a)
    const ayCmp = a.y.cmp(p.y), byCmp = b.y.cmp(p.y);
    if (ayCmp <= 0) {
      if (byCmp > 0 && left > 0) { wn++; crossings++; }
    } else if (byCmp <= 0 && left < 0) { wn--; crossings++; }
  }
  return { wn, odd: crossings % 2 === 1 };
}

// 在面内取一个严格内点（用于点选信息）；候选：外环重心 -> 网格细分候选 -> 三角形重心
function findInteriorPoint(region, triangles, verts) {
  const P = (id) => verts[id];
  const outer = region.outerRings[0];
  const inners = region.innerRings;
  const insideFace = (p) => {
    let inOuter = false;
    for (const ring of [outer]) {
      if (ringPointTest(p, ring, P) === 1) inOuter = true;
    }
    if (!inOuter) return false;
    for (const ring of inners) if (ringPointTest(p, ring, P) !== -1) return false;
    return true;
  };
  const bbox = ringBBox(outer, P);
  const cands = candidatePoints(bbox);
  for (const c of cands) if (insideFace(c)) return c;
  // 回退：输出三角形重心
  for (const t of triangles) {
    const c = {
      x: P(t[0]).x.add(P(t[1]).x).add(P(t[2]).x).div(new Frac(3n)),
      y: P(t[0]).y.add(P(t[1]).y).add(P(t[2]).y).div(new Frac(3n)),
    };
    if (insideFace(c)) return c;
  }
  return cands[0];
}

function ringPointTest(p, ring, P) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = P(ring[j]), b = P(ring[i]);
    if (orient(a, b, p) === 0 &&
        p.x.cmp(minF(a.x, b.x)) >= 0 && p.x.cmp(maxF(a.x, b.x)) <= 0 &&
        p.y.cmp(minF(a.y, b.y)) >= 0 && p.y.cmp(maxF(a.y, b.y)) <= 0) return 0;
    if (b.y.cmp(p.y) > 0 !== a.y.cmp(p.y) > 0) {
      const xc = a.x.sub(b.x).mul(p.y.sub(b.y)).div(a.y.sub(b.y)).add(b.x);
      if (xc.cmp(p.x) > 0) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}
const minF = (a, b) => (a.cmp(b) <= 0 ? a : b);
const maxF = (a, b) => (a.cmp(b) >= 0 ? a : b);

function ringBBox(ring, P) {
  let x0 = P(ring[0]).x, x1 = x0, y0 = P(ring[0]).y, y1 = y0;
  for (const id of ring) {
    const p = P(id);
    if (p.x.cmp(x0) < 0) x0 = p.x; if (p.x.cmp(x1) > 0) x1 = p.x;
    if (p.y.cmp(y0) < 0) y0 = p.y; if (p.y.cmp(y1) > 0) y1 = p.y;
  }
  return { x0, x1, y0, y1 };
}
function candidatePoints(bb) {
  const { x0, x1, y0, y1 } = bb;
  const fx = (k) => x0.add(x1.sub(x0).mul(new Frac(BigInt(k))).div(new Frac(8n)));
  const fy = (k) => y0.add(y1.sub(y0).mul(new Frac(BigInt(k))).div(new Frac(8n)));
  const out = [];
  for (const i of [4, 2, 6, 1, 3, 5, 7]) {
    for (const j of [4, 2, 6, 1, 3, 5, 7]) out.push({ x: fx(i), y: fy(j) });
  }
  return out;
}

export function tessellate(rawContours, rule) {
  if (rule !== 'evenodd' && rule !== 'nonzero') {
    throw new Error(`未知填充规则: ${rule}`);
  }
  const cleaned = validateRawContours(rawContours);
  // 全部轮廓退化（无有效边）时返回空网格
  if (!cleaned.length) {
    return {
      rule, arrangement: null, cleaned,
      compactVerts: [], triangles: [], regions: [], area: f0,
    };
  }
  const arr = buildArrangement(cleaned);
  const { verts, faces, windEO, windNZ, regionParent, half, atomic } = arr;
  const wind = rule === 'evenodd' ? windEO : windNZ;
  const filled = (w) => (rule === 'evenodd' ? w === 1 : w !== 0);
  const isFilledFace = (fid) => fid !== arr.outerFace && filled(wind[fid]);

  // 拓扑面孪生邻接表（共享原子边）
  const topoAdj = faces.map(() => new Set());
  for (let h = 0; h < half.length; h++) {
    const f1 = half[h].face, f2 = half[half[h].twin].face;
    if (f1 !== f2) { topoAdj[f1].add(f2); topoAdj[f2].add(f1); }
  }

  // 填充面聚合为几何连通区域（并查集）。区域是一片连通的填充面积，
  // 内部允许存在不同绕数的子分区（如重叠区 w=2），它们只影响标注不产生几何缝隙。
  // 合并条件（两者都填充）：
  //  (a) 孪生相邻（共享原子边）；或
  //  (b) 几何嵌套树上的直接父子（严格包含，已排除相切误判）。
  const dsu = faces.map((_, i) => i);
  const find = (x) => { while (dsu[x] !== x) { dsu[x] = dsu[dsu[x]]; x = dsu[x]; } return x; };
  const union = (a, b) => { dsu[find(a)] = find(b); };
  for (const f of faces) {
    if (!isFilledFace(f.id)) continue;
    for (const nb of topoAdj[f.id]) {
      if (isFilledFace(nb)) union(f.id, nb);
    }
    const p = regionParent.get(f.id);
    if (p !== undefined && p !== arr.outerFace && isFilledFace(p)) {
      union(f.id, p);
    }
  }
  const regionByRoot = new Map();
  const faceRegion = new Array(faces.length).fill(-1);
  for (const f of faces) {
    if (!isFilledFace(f.id)) continue;
    const root = find(f.id);
    if (!regionByRoot.has(root)) {
      regionByRoot.set(root, {
        faceId: root, winding: wind[f.id],
        outerRings: [], innerRings: [], memberFaces: [], triangles: [],
        candidateOuter: [], candidateHole: [],
      });
    }
    faceRegion[f.id] = root;
  }
  const findFilledRegion = (fid) => {
    let p = fid;
    const seen = new Set();
    while (p !== arr.outerFace && p !== undefined && !seen.has(p)) {
      seen.add(p);
      if (isFilledFace(p)) return find(p);
      p = regionParent.get(p);
    }
    return -1;
  };
  for (const f of faces) {
    if (f.id === arr.outerFace || isFilledFace(f.id)) continue;
    const root = findFilledRegion(f.id);
    if (root !== -1) faceRegion[f.id] = root;
  }

  // 组装每个区域的边界环
  for (const f of faces) {
    const root = faceRegion[f.id];
    if (root === -1 || !regionByRoot.has(root)) continue;
    const region = regionByRoot.get(root);
    region.memberFaces.push(f.id);
    const selfFilled = isFilledFace(f.id);
    for (const loop of f.loops) {
      const a2 = ringArea2(loop.map((id) => verts[id]));
      if (a2.sign() === 0) continue;
      if (selfFilled) {
        if (a2.sign() > 0) region.candidateOuter.push(loop);
      } else if (a2.sign() > 0) {
        region.candidateHole.push(loop.slice().reverse());
      } else {
        region.candidateHole.push(loop);
      }
    }
  }

  const loopContains = (outer, inner) => {
    const P = (id) => verts[id];
    let strict = false;
    for (const id of inner) {
      const t = ringPointTest(verts[id], outer, P);
      if (t === -1) return false;
      if (t === 1) strict = true;
    }
    return strict;
  };
  const ringKey = (loop) => loop.map((id) => ptKey(verts[id])).sort().join('|');

  for (const region of regionByRoot.values()) {
    const outers = [];
    for (const a of region.candidateOuter) {
      let contained = false;
      for (const b of region.candidateOuter) {
        if (a === b) continue;
        if (loopContains(b, a)) { contained = true; break; }
      }
      if (!contained) outers.push(a);
    }
    const holeSeen = new Set();
    const holes = [];
    for (const h of region.candidateHole) {
      const key = ringKey(h);
      if (holeSeen.has(key)) continue;
      holeSeen.add(key);
      holes.push(h);
    }
    const outerSeen = new Set();
    region.outerRings = outers.filter((l) => {
      const k = ringKey(l);
      if (outerSeen.has(k)) return false;
      outerSeen.add(k);
      return true;
    });
    region.innerRings = holes;
  }

  const regions = [...regionByRoot.values()];
  let allTriangles = [];
  for (const region of regions) {
    if (!region.outerRings.length) continue;
    const faceLoops = region.outerRings.concat(region.innerRings);
    const tris = triangulateFace(faceLoops, verts);
    region.triangles = tris;
    allTriangles = allTriangles.concat(tris);
  }

  // 紧凑索引网格（仅输出被三角形引用的顶点）
  const used = new Map();
  const compactVerts = [];
  const cid = (vid) => {
    let k = used.get(vid);
    if (k === undefined) {
      k = compactVerts.length;
      used.set(vid, k);
      compactVerts.push(verts[vid]);
    }
    return k;
  };
  const triangles = allTriangles.map((t) => {
    const out = t.map(cid);
    // 保证统一 CCW
    const a = compactVerts[out[0]], b = compactVerts[out[1]], c = compactVerts[out[2]];
    if (orient(a, b, c) < 0) return [out[2], out[1], out[0]];
    return out;
  });

  // 面积：只累加实际输出三角形（精确分数）
  let area2 = f0;
  for (const t of triangles) {
    const a = compactVerts[t[0]], b = compactVerts[t[1]], c = compactVerts[t[2]];
    area2 = area2.add(ringArea2([a, b, c]));
  }
  const area = area2.div(new Frac(2n));

  // 区域内点与贡献轮廓
  for (const r of regions) {
    if (!r.outerRings.length || !r.triangles.length) {
      r.sample = null;
      r.contributors = [];
      continue;
    }
    r.sample = findInteriorPoint(r, r.triangles, verts);
    r.contributors = cleaned.map((ring, ci) => {
      const cw = contourWinding(ring, r.sample);
      return { contour: ci, winding: cw.wn, odd: cw.odd };
    }).filter((c) => (rule === 'evenodd' ? c.odd : c.winding !== 0));
  }

  return {
    rule,
    arrangement: arr,
    cleaned,
    compactVerts,
    triangles,
    regions,
    area, // Frac
  };
}

// ---------- 可导出的纯 JSON ----------
const num = (p) => [p.x.toNumber(), p.y.toNumber()];
const ringJSON = (ring, verts) => ring.map((id) => num(verts[id]));

export function meshToJSON(result) {
  const { compactVerts: V, triangles, regions, arrangement, rule, area } = result;
  // 绕数分区：每个有界拓扑面都是一个同绕数分区（含未填充的孔洞区），完整保留边界环与绕数
  const zones = !arrangement ? [] : arrangement.faces
    .filter((f) => f.id !== arrangement.outerFace && f.area2.sign() !== 0)
    .map((f) => ({
      winding: rule === 'evenodd' ? arrangement.windEO[f.id] : arrangement.windNZ[f.id],
      windingNonzero: arrangement.windNZ[f.id],
      windingEvenodd: arrangement.windEO[f.id],
      filled: rule === 'evenodd'
        ? arrangement.windEO[f.id] === 1
        : arrangement.windNZ[f.id] !== 0,
      rings: f.loops.map((ring) => ({
        orientation: ringArea2(ring.map((id) => arrangement.verts[id])).sign() > 0 ? 'CCW' : 'CW',
        points: ringJSON(ring, arrangement.verts),
      })),
      signedArea: f.area2.toNumber() / 2,
    }));
  return {
    rule,
    vertices: V.map(num),
    triangles: triangles.map((t) => t.slice()),
    area: area.toNumber(),
    areaExact: area.toString(),
    regions: regions.map((r) => ({
      winding: r.winding,
      outer: r.outerRings.map((ring) => ringJSON(ring, arrangement.verts)),
      inner: r.innerRings.map((ring) => ringJSON(ring, arrangement.verts)),
      area: r.triangles.reduce((s, t) =>
        s + ringArea2(t.map((id) => arrangement.verts[id])).toNumber(), 0) / 2,
      sample: r.sample ? num(r.sample) : null,
      contributors: r.contributors.map((c) => ({ contour: c.contour, winding: c.winding })),
    })),
    zones,
  };
}
