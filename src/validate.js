// Validity checking for measurement regions.
// All coordinates are integers in 1/16-pixel units; geometry is done in BigInt
// so every touch/intersection decision is exact. A valid region is one simple
// outer ring plus zero or more holes that are pairwise disjoint and strictly
// inside the outer ring. Winding order is irrelevant.

export class RegionError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'RegionError';
    this.issues = issues || [];
  }
}

const B = (v) => BigInt(v);

function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }

function segCross(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  return cross(B(r[0]), B(r[1]), B(s[0]), B(s[1]));
}

// Signed orientation of (a,b,c): >0 CCW, <0 CW, 0 collinear (BigInt).
function orient(a, b, c) {
  return cross(B(b[0]) - B(a[0]), B(b[1]) - B(a[1]),
               B(c[0]) - B(a[0]), B(c[1]) - B(a[1]));
}

function onSegment(a, b, p) {
  if (orient(a, b, p) !== 0n) return false;
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
         Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

// How two closed segments relate.
// 'none'      : disjoint
// 'proper'    : interiors cross at a single interior point
// 'touch'     : share exactly an endpoint, otherwise disjoint
// 'overlap'   : collinear with a shared segment (or a vertex lying on the other edge)
function segmentRelation(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d);
  const o3 = orient(c, d, a), o4 = orient(c, d, b);
  if ((o1 > 0n && o2 < 0n) || (o1 < 0n && o2 > 0n)) {
    if ((o3 > 0n && o4 < 0n) || (o3 < 0n && o4 > 0n)) return 'proper';
  }
  if (o1 === 0n && onSegment(a, b, c)) return 'overlap';
  if (o2 === 0n && onSegment(a, b, d)) return 'overlap';
  if (o3 === 0n && onSegment(c, d, a)) return 'overlap';
  if (o4 === 0n && onSegment(c, d, b)) return 'overlap';
  if (o1 === 0n || o2 === 0n || o3 === 0n || o4 === 0n) {
    // Endpoint-on-line but outside the segment: no contact at all.
    return 'none';
  }
  return 'none';
}

function ringSignedArea2(ring) {
  let s = 0n;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += B(a[0]) * B(b[1]) - B(b[0]) * B(a[1]);
  }
  return s;
}

// Strict point-in-simple-polygon (boundary counts as outside).
function pointStrictInside(ring, p) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(a, b, p)) return false;
    const cond1 = a[1] > p[1] !== b[1] > p[1];
    if (cond1) {
      const lhs = (b[0] - a[0]) * (p[1] - a[1]);
      const rhs = (p[0] - a[0]) * (b[1] - a[1]);
      const lhsB = B(lhs), rhsB = B(rhs);
      if (b[1] > a[1] ? lhsB > rhsB : lhsB < rhsB) inside = !inside;
    }
  }
  return inside;
}

function validateRing(ring, label, issues) {
  if (!Array.isArray(ring) || ring.length < 3) {
    issues.push({ ring: label, message: '至少需要 3 个顶点' });
    return false;
  }
  let ok = true;
  for (let i = 0; i < ring.length; i++) {
    const v = ring[i];
    if (!Array.isArray(v) || v.length !== 2 ||
        !Number.isInteger(v[0]) || !Number.isInteger(v[1])) {
      issues.push({ ring: label, vertex: i, message: '顶点必须是 1/16 像素整数坐标' });
      ok = false;
    }
  }
  if (!ok) return false;

  // Duplicate vertices.
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      if (ring[i][0] === ring[j][0] && ring[i][1] === ring[j][1]) {
        issues.push({ ring: label, vertices: [i, j], message: `顶点 ${i} 与顶点 ${j} 重合` });
        ok = false;
      }
    }
  }

  const n = ring.length;
  // Pairwise edge checks. Adjacent edges may only meet at their shared endpoint.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const c = ring[j], d = ring[(j + 1) % n];
      const adjacent = (i + 1) % n === j || (j + 1) % n === i;
      const rel = segmentRelation(a, b, c, d);
      if (rel === 'none') continue;
      if (adjacent) {
        // Adjacent edges share exactly one endpoint. That contact is legal;
        // anything more (the other endpoint lying inside the neighbor, or a
        // collinear run) is still illegal.
        const shared = (i + 1) % n === j ? b : a;
        const otherAB = a === shared ? b : a;
        const otherCD = c === shared ? d : c;
        const legal = rel === 'touch' ||
          (rel === 'overlap' &&
            !onSegment(c, d, otherAB) &&
            !onSegment(a, b, otherCD));
        if (legal) continue;
      }
      const where = `边 ${i}–${(i + 1) % n} 与 边 ${j}–${(j + 1) % n}`;
      if (rel === 'proper') {
        issues.push({ ring: label, edges: [i, j], message: `${where} 在内部交叉` });
      } else {
        issues.push({ ring: label, edges: [i, j], message: `${where} 非端点接触或共线重叠` });
      }
      ok = false;
    }
  }
  // A 180-degree vertex: the two edges meeting at vertex i are collinear.
  // Such a vertex is redundant at best and signals a degenerate/overlapping
  // ring, so reject it with precise localization.
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    if (orient(prev, cur, next) === 0n) {
      issues.push({ ring: label, vertex: i,
        message: `顶点 ${i} 处相邻两边共线（180° 冗余顶点/共线重叠）` });
      ok = false;
    }
  }

  // A vertex lying in the interior of a non-incident edge means collinear
  // overlap / a redundant 180-degree vertex, which segmentRelation only
  // catches through its own edge pair. Check it explicitly for localization.
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    for (let j = 0; j < n; j++) {
      const a = ring[j], b = ring[(j + 1) % n];
      const incident = j === i || (j + 1) % n === i;
      if (incident) continue;
      if (onSegment(a, b, p)) {
        issues.push({ ring: label, vertex: i, edges: [j],
          message: `顶点 ${i} 落在非相邻边 ${j}–${(j + 1) % n} 上（共线重叠/180° 冗余顶点）` });
        ok = false;
      }
    }
  }

  if (ringSignedArea2(ring) === 0n) {
    issues.push({ ring: label, message: '环面积为零，退化多边形' });
    ok = false;
  }
  return ok;
}

// region: { outer: [[x,y]...], holes: [[[x,y]...], ...] }
export function validateRegion(region) {
  const issues = [];
  if (!region || typeof region !== 'object') {
    throw new RegionError('测区必须是包含 outer 的对象', [{ message: '缺少 outer/holes 结构' }]);
  }
  const { outer, holes } = region;
  let totalVerts = 0;
  if (Array.isArray(outer)) totalVerts += outer.length;
  if (holes) {
    if (!Array.isArray(holes)) {
      throw new RegionError('holes 必须是环数组', [{ message: 'holes 类型错误' }]);
    }
    for (const h of holes) totalVerts += Array.isArray(h) ? h.length : 0;
  }
  if (totalVerts > 1024) {
    issues.push({ message: `顶点总数 ${totalVerts} 超过 1024 上限` });
  }

  const outerOk = validateRing(outer, '外环', issues);
  const holesOk = (holes || []).map((h, k) => validateRing(h, `孔 ${k + 1}`, issues));

  if (outerOk) {
    // Every hole strictly inside the outer ring.
    (holes || []).forEach((h, k) => {
      if (!holesOk[k]) return;
      for (let i = 0; i < h.length; i++) {
        if (!pointStrictInside(outer, h[i])) {
          issues.push({
            ring: `孔 ${k + 1}`, vertex: i,
            message: `孔 ${k + 1} 的顶点 ${i} 不在外环内部（孔必须严格位于外环之内）`
          });
        }
      }
    });

    // Holes pairwise disjoint: no vertex inside another and no edge contact.
    for (let k1 = 0; k1 < holes.length; k1++) {
      for (let k2 = k1 + 1; k2 < holes.length; k2++) {
        if (!holesOk[k1] || !holesOk[k2]) continue;
        const h1 = holes[k1], h2 = holes[k2];
        for (let i = 0; i < h1.length; i++) {
          if (pointStrictInside(h2, h1[i])) {
            issues.push({ ring: `孔 ${k1 + 1}`, vertex: i, message: `孔 ${k1 + 1} 与孔 ${k2 + 1} 存在包含关系（孔之间必须互不碰触）` });
          }
        }
        for (let i = 0; i < h2.length; i++) {
          if (pointStrictInside(h1, h2[i])) {
            issues.push({ ring: `孔 ${k2 + 1}`, vertex: i, message: `孔 ${k2 + 1} 与孔 ${k1 + 1} 存在包含关系（孔之间必须互不碰触）` });
          }
        }
        for (let i = 0; i < h1.length; i++) {
          const a = h1[i], b = h1[(i + 1) % h1.length];
          for (let j = 0; j < h2.length; j++) {
            const c = h2[j], d = h2[(j + 1) % h2.length];
            const rel = segmentRelation(a, b, c, d);
            if (rel !== 'none') {
              issues.push({
                ring: `孔 ${k1 + 1}`, edges: [i],
                message: `孔 ${k1 + 1} 边 ${i} 与孔 ${k2 + 1} 边 ${j} ${rel === 'proper' ? '交叉' : '接触/重叠'}（孔之间必须互不碰触）`
              });
            }
          }
        }
      }
    }
  }

  if (issues.length) throw new RegionError('测区校验未通过', issues);
  return true;
}
