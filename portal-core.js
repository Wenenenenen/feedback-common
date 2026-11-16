// portal-core.js — 门洞可见性核心逻辑（纯函数，无渲染依赖，可在 node 中测试）
// 约定：右手系 y 向上；房间为轴对齐凸盒；门洞为凸多边形（矩形），双向通行。

export const ROOM_EPS = 1e-8;   // 相机归属房间容差
const GEO_TOL = 1e-6;           // 门洞几何校验容差
const MAX_EXPANSIONS = 100000;  // 遍历展开上限（防御性，正常不会触及）

// ---------- 向量工具 ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0]; };

// ---------- 相机归属 ----------
// 点在容差内可同时属于多个相邻房间，取 id 字典序最小者。
export function findRoom(rooms, p) {
  let best = null;
  for (const r of rooms) {
    let inside = true;
    for (let k = 0; k < 3; k++) {
      if (p[k] < r.min[k] - ROOM_EPS || p[k] > r.max[k] + ROOM_EPS) { inside = false; break; }
    }
    if (inside && (best === null || r.id < best.id)) best = r;
  }
  return best;
}

// ---------- 场景校验 ----------
function planeNormalOf(pts) {
  for (let i = 1; i < pts.length - 1; i++) {
    const n = cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]));
    if (len(n) > 1e-12) return norm(n);
  }
  return null;
}

function isConvexPlanar(pts, n) {
  const m = pts.length;
  let sign = 0;
  for (let i = 0; i < m; i++) {
    const e1 = sub(pts[(i + 1) % m], pts[i]);
    const e2 = sub(pts[(i + 2) % m], pts[(i + 1) % m]);
    const c = dot(cross(e1, e2), n);
    if (Math.abs(c) <= 1e-12) continue;
    const s = Math.sign(c);
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return sign !== 0;
}

export function validateScene(scene) {
  const errors = [];
  if (!scene || typeof scene !== 'object') return ['场景文件不是合法的 JSON 对象'];
  const rooms = scene.rooms;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    errors.push('场景缺少 rooms 数组');
    return errors;
  }
  if (rooms.length > 16) errors.push(`房间数量 ${rooms.length} 超过上限 16`);
  const roomById = new Map();
  for (const r of rooms) {
    if (!r || typeof r.id !== 'string') { errors.push('存在缺少 id 的房间'); continue; }
    if (roomById.has(r.id)) errors.push(`房间 id 重复: "${r.id}"`);
    roomById.set(r.id, r);
    if (!Array.isArray(r.min) || !Array.isArray(r.max) || r.min.length !== 3 || r.max.length !== 3) {
      errors.push(`房间 "${r.id}" 的 min/max 非法`); continue;
    }
    for (let k = 0; k < 3; k++) {
      if (!(r.min[k] < r.max[k])) errors.push(`房间 "${r.id}" 在轴 ${k} 上 min>=max`);
    }
  }

  const portals = Array.isArray(scene.portals) ? scene.portals : [];
  if (portals.length > 64) errors.push(`门洞数量 ${portals.length} 超过上限 64`);
  const portalIds = new Set();
  for (const p of portals) {
    const tag = `门洞 "${p && p.id}"`;
    if (!p || typeof p.id !== 'string') { errors.push('存在缺少 id 的门洞'); continue; }
    if (portalIds.has(p.id)) errors.push(`${tag}: id 重复`);
    portalIds.add(p.id);
    const rs = p.rooms;
    if (!Array.isArray(rs) || rs.length !== 2 || rs[0] === rs[1]) {
      errors.push(`${tag}: rooms 必须是两个不同房间`); continue;
    }
    const ra = roomById.get(rs[0]), rb = roomById.get(rs[1]);
    if (!ra || !rb) { errors.push(`${tag}: 引用了不存在的房间 ${JSON.stringify(rs)}`); continue; }
    const pts = p.points;
    if (!Array.isArray(pts) || pts.length < 3) { errors.push(`${tag}: points 至少需要 3 个点`); continue; }
    if (pts.some(q => !Array.isArray(q) || q.length !== 3 || q.some(v => typeof v !== 'number' || !Number.isFinite(v)))) {
      errors.push(`${tag}: points 含非法坐标`); continue;
    }
    // 共面
    const n = planeNormalOf(pts);
    if (!n) { errors.push(`${tag}: points 共线或退化，无法确定平面`); continue; }
    for (const q of pts) {
      if (Math.abs(dot(sub(q, pts[0]), n)) > GEO_TOL) {
        errors.push(`${tag}: 点不共面（如 [${q.join(', ')}] 偏离门洞平面）`); break;
      }
    }
    // 凸性
    if (!isConvexPlanar(pts, n)) errors.push(`${tag}: 多边形非凸或自交`);
    // 两房间公共边界：重叠盒应恰好在一个轴上退化为平面
    const lo = [0, 1, 2].map(k => Math.max(ra.min[k], rb.min[k]));
    const hi = [0, 1, 2].map(k => Math.min(ra.max[k], rb.max[k]));
    const planeAxes = [];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(hi[k] - lo[k]) <= GEO_TOL) planeAxes.push(k);
      else if (hi[k] <= lo[k]) { errors.push(`${tag}: 房间 "${ra.id}" 与 "${rb.id}" 在轴 ${k} 上无公共边界`); }
    }
    if (planeAxes.length !== 1) {
      errors.push(`${tag}: 房间 "${ra.id}" 与 "${rb.id}" 没有唯一的公共边界平面`);
      continue;
    }
    const k = planeAxes[0];
    for (const q of pts) {
      if (Math.abs(q[k] - lo[k]) > GEO_TOL) {
        errors.push(`${tag}: 点 [${q.join(', ')}] 不在两房间公共边界平面上`); break;
      }
      const ok = [0, 1, 2].every(j => j === k || (q[j] >= lo[j] - GEO_TOL && q[j] <= hi[j] + GEO_TOL));
      if (!ok) { errors.push(`${tag}: 点 [${q.join(', ')}] 超出两房间公共边界范围`); break; }
    }
  }

  const objects = Array.isArray(scene.objects) ? scene.objects : [];
  for (const o of objects) {
    if (!o || typeof o.id !== 'string') { errors.push('存在缺少 id 的展品'); continue; }
    if (!roomById.has(o.room)) errors.push(`展品 "${o.id}" 所属房间 "${o.room}" 不存在`);
  }
  return errors;
}

// ---------- 多边形裁剪 ----------
// 视空间近平面裁剪：保留 z <= -near 的部分（相机朝 -z 看）
function clipNearPlane(poly, near) {
  const g = p => -near - p[2]; // >=0 表示保留
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ga = g(a), gb = g(b);
    if (ga >= 0) out.push(a);
    if ((ga > 0 && gb < 0) || (ga < 0 && gb > 0)) {
      const t = ga / (ga - gb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

// 用凸窗口（逆时针）裁剪任意凸多边形（Sutherland–Hodgman，2D）
function clipConvex2D(subject, window) {
  let poly = subject;
  for (let i = 0; i < window.length && poly.length > 0; i++) {
    const a = window[i], b = window[(i + 1) % window.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const inside = p => ex * (p[1] - a[1]) - ey * (p[0] - a[0]) >= -1e-12;
    const out = [];
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j], q = poly[(j + 1) % poly.length];
      const ip = inside(p), iq = inside(q);
      if (ip) out.push(p);
      if (ip !== iq) {
        const d = [q[0] - p[0], q[1] - p[1]];
        const denom = ex * d[1] - ey * d[0];
        if (Math.abs(denom) > 1e-300) {
          // cross(e, p + t·d − a) = 0 → t = −cross(e, p−a) / cross(e, d)
          const t = -(ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / denom;
          out.push([p[0] + d[0] * t, p[1] + d[1] * t]);
        }
      }
    }
    poly = out;
  }
  return poly;
}

function signedArea2D(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function polyArea2D(poly) {
  return Math.abs(signedArea2D(poly));
}

// 窗口必须保持逆时针（inside 测试依赖绕序）；裁剪会继承被裁多边形的绕序，需归一
function ensureCCW(poly) {
  return signedArea2D(poly) < 0 ? [...poly].reverse() : poly;
}

// 点是否落在空间凸多边形内（投影到法线主导轴平面，允许任一绕序）
function pointInPolygon3D(p, pts, n) {
  const an = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  const drop = an[0] >= an[1] && an[0] >= an[2] ? 0 : (an[1] >= an[2] ? 1 : 2);
  const axes = [0, 1, 2].filter(k => k !== drop);
  const [u, v] = axes;
  let pos = 0, neg = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const c = (b[u] - a[u]) * (p[v] - a[v]) - (b[v] - a[v]) * (p[u] - a[u]);
    if (c > 1e-9) pos++; else if (c < -1e-9) neg++;
  }
  return pos === 0 || neg === 0;
}

// ---------- 门洞遍历 ----------
// cam: {position, target, up, fov(度), aspect, near, far}
// isOpen: (portalId) => bool
// 返回 {room, error, candidates, paths, truncated}
// paths 元素: {rooms, portals, window, steps:[{portal, from, to, window}]}
export function computeTraversal(scene, isOpen, cam) {
  const room = findRoom(scene.rooms, cam.position);
  if (!room) {
    return {
      room: null,
      error: `相机 [${cam.position.map(v => +v.toFixed(4)).join(', ')}] 不在任何房间内，无法进行门洞裁剪`,
      candidates: [], paths: [], truncated: false,
    };
  }

  const fwd = norm(sub(cam.target, cam.position));
  let right = cross(fwd, cam.up);
  if (len(right) < 1e-12) right = [1, 0, 0];
  right = norm(right);
  const up2 = cross(right, fwd);
  const tanH = Math.tan((cam.fov * Math.PI) / 360);
  const tanW = tanH * cam.aspect;
  const toView = p => {
    const d = sub(p, cam.position);
    return [dot(d, right), dot(d, up2), -dot(d, fwd)];
  };

  // 邻接表
  const adj = new Map();
  for (const r of scene.rooms) adj.set(r.id, []);
  for (const p of scene.portals || []) {
    adj.get(p.rooms[0]).push({ portal: p, neighbor: p.rooms[1] });
    adj.get(p.rooms[1]).push({ portal: p, neighbor: p.rooms[0] });
  }

  const START = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // 全屏窗口（逆时针）

  // 计算穿过门洞后的观察窗口；不可见返回 null
  function clipPortalWindow(portal, window) {
    const pts = portal.points;
    const n = planeNormalOf(pts);
    // 近平面穿门：相机贴在门洞平面附近且位于门洞范围内 → 窗口直通
    if (n) {
      const dist = dot(sub(cam.position, pts[0]), n);
      if (Math.abs(dist) <= cam.near + 1e-9) {
        const proj = sub(cam.position, scale(n, dist));
        if (pointInPolygon3D(proj, pts, n)) return window;
      }
    }
    let poly = pts.map(toView);
    poly = clipNearPlane(poly, cam.near);
    if (poly.length < 3) return null;
    const ndc = poly.map(([x, y, z]) => [x / (-z) / tanW, y / (-z) / tanH]);
    const clipped = ensureCCW(clipConvex2D(ndc, window));
    if (clipped.length < 3 || polyArea2D(clipped) <= 1e-9) return null;
    return clipped;
  }

  const candidates = new Set([room.id]);
  const paths = [];
  let truncated = false;
  let expansions = 0;

  // 逐路径传播：visited 是“当前路径”上的房间集合，不用全局 visited，
  // 因此同一房间经不同门洞窗口到达时仍会展开；路径内成环即终止。
  const stack = [{ roomId: room.id, window: START, rooms: [room.id], portals: [], steps: [] }];
  while (stack.length > 0) {
    if (++expansions > MAX_EXPANSIONS) { truncated = true; break; }
    const st = stack.pop();
    for (const { portal, neighbor } of adj.get(st.roomId)) {
      if (!isOpen(portal.id)) continue;
      if (st.rooms.includes(neighbor)) continue; // 环终止（仅针对本路径）
      const w = clipPortalWindow(portal, st.window);
      if (!w) continue;
      candidates.add(neighbor);
      const step = { portal: portal.id, from: st.roomId, to: neighbor, window: w };
      const rec = {
        rooms: [...st.rooms, neighbor],
        portals: [...st.portals, portal.id],
        window: w,
        steps: [...st.steps, step],
      };
      paths.push(rec);
      stack.push({ roomId: neighbor, window: w, rooms: rec.rooms, portals: rec.portals, steps: rec.steps });
    }
  }

  if (truncated) {
    // 防御：路径爆炸时退化为门洞图连通性（保守多报，绝不漏报）
    const seen = new Set([room.id]);
    const q = [room.id];
    while (q.length) {
      const cur = q.shift();
      for (const { portal, neighbor } of adj.get(cur)) {
        if (!isOpen(portal.id) || seen.has(neighbor)) continue;
        seen.add(neighbor); candidates.add(neighbor); q.push(neighbor);
      }
    }
  }

  return { room: room.id, error: null, candidates: [...candidates].sort(), paths, truncated };
}
