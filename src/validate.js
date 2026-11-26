// SPEC §2 合法性校验 —— 失败时返回结构化错误，由调用方保留原场景
import {
  add, cross, dot, isFiniteV, length, normalize, sub, triAreaNorm, v3,
} from './math.js';

// Newell 式法向量（SPEC §2.2）：N = Σ (v_i - v0) × (v_(i+1) - v0)
export function mirrorNormal(vertices) {
  const v0 = vertices[0];
  const N = v3();
  const m = vertices.length;
  for (let i = 0; i < m; i++) {
    const a = sub(vertices[i], v0);
    const b = sub(vertices[(i + 1) % m], v0);
    N[0] += a[1] * b[2] - a[2] * b[1];
    N[1] += a[2] * b[0] - a[0] * b[2];
    N[2] += a[0] * b[1] - a[1] * b[0];
  }
  return N;
}

// 镜面派生几何：法向、平面基点、面积；校验通过后缓存到模型上
export function mirrorDerived(mirror) {
  const N = mirrorNormal(mirror.vertices);
  const n = normalize(N);
  return {
    normal: n,
    v0: mirror.vertices[0].slice(),
    area: 0.5 * length(N),
  };
}

function segOrient2(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSeg2(px, py, ax, ay, bx, by) {
  return Math.min(ax, bx) - 1e-12 <= px && px <= Math.max(ax, bx) + 1e-12
    && Math.min(ay, by) - 1e-12 <= py && py <= Math.max(ay, by) + 1e-12;
}

function segIntersect2(a, b, c, d) {
  const o1 = segOrient2(...a, ...b, ...c);
  const o2 = segOrient2(...a, ...b, ...d);
  const o3 = segOrient2(...c, ...d, ...a);
  const o4 = segOrient2(...c, ...d, ...b);
  if (((o1 > 1e-12 && o2 < -1e-12) || (o1 < -1e-12 && o2 > 1e-12))
    && ((o3 > 1e-12 && o4 < -1e-12) || (o3 < -1e-12 && o4 > 1e-12))) {
    return true; // 严格相交
  }
  // 端点落在另一线段上（共线接触也算自交）
  if (Math.abs(o1) <= 1e-12 && onSeg2(...c, ...a, ...b)) return true;
  if (Math.abs(o2) <= 1e-12 && onSeg2(...d, ...a, ...b)) return true;
  if (Math.abs(o3) <= 1e-12 && onSeg2(...a, ...c, ...d)) return true;
  if (Math.abs(o4) <= 1e-12 && onSeg2(...b, ...c, ...d)) return true;
  return false;
}

function validateMirror(mirror, errors) {
  const id = mirror.id;
  const verts = mirror.vertices;
  if (!Array.isArray(verts) || verts.length < 3 || verts.length > 8) {
    errors.push({ kind: 'mirror', id, reason: `顶点数 ${verts ? verts.length : 0} 不在 [3,8] 范围内` });
    return;
  }
  if (!verts.every(isFiniteV)) {
    errors.push({ kind: 'mirror', id, reason: '存在非有限浮点坐标' });
    return;
  }
  const refl = mirror.reflectance;
  if (!Array.isArray(refl) || refl.length !== 3 || !refl.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)) {
    errors.push({ kind: 'mirror', id, reason: 'reflectance 必须是三个 [0,1] 内的分量' });
  }
  const N = mirrorNormal(verts);
  const nLen = length(N);
  if (0.5 * nLen <= 1e-7) {
    errors.push({ kind: 'mirror', id, reason: '零面积退化镜面（Newell 法向量模接近 0）' });
    return;
  }
  const n = scaleV(N, 1 / nLen);
  const v0 = verts[0];
  // 共面性
  for (let i = 1; i < verts.length; i++) {
    const d = Math.abs(dot(sub(verts[i], v0), n));
    if (d > 1e-5) {
      errors.push({ kind: 'mirror', id, reason: `非共面镜面：顶点 ${i} 到平面距离 ${d.toExponential(3)} > 1e-5` });
      return;
    }
  }
  // 严格凸性：连续三边叉积
  const m = verts.length;
  for (let i = 0; i < m; i++) {
    const prev = verts[(i - 1 + m) % m];
    const cur = verts[i];
    const next = verts[(i + 1) % m];
    const turn = dot(cross(sub(cur, prev), sub(next, cur)), n);
    if (turn <= 1e-8) {
      errors.push({ kind: 'mirror', id, reason: `非凸镜面：顶点 ${i} 处转向叉积 ${turn.toExponential(3)} <= 1e-8（存在凹点或共线边）` });
      return;
    }
  }
  // 边不自交：投影到法线主轴平面做 2D 判定
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const proj = (p) => (ax >= ay && ax >= az) ? [p[1], p[2]] : (ay >= az ? [p[0], p[2]] : [p[0], p[1]]);
  const ps = verts.map(proj);
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const adjacent = (i === 0 && j === m - 1) || j === i + 1;
      if (adjacent) continue;
      if (segIntersect2(ps[i], ps[(i + 1) % m], ps[j], ps[(j + 1) % m])) {
        errors.push({ kind: 'mirror', id, reason: `非凸镜面：边 ${i} 与边 ${j} 自交` });
        return;
      }
    }
  }
}

function scaleV(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

export function validateScene(scene) {
  const errors = [];
  if (!scene || typeof scene !== 'object') {
    return { valid: false, errors: [{ kind: 'scene', id: null, reason: '场景 JSON 顶层不是对象' }] };
  }
  const cam = scene.camera;
  if (!cam || !isFiniteV(cam.eye) || !isFiniteV(cam.target) || !isFiniteV(cam.up)) {
    errors.push({ kind: 'camera', id: null, reason: 'camera 的 eye/target/up 必须是有限三维向量' });
  } else {
    const f = sub(cam.target, cam.eye);
    if (length(f) <= 1e-12) errors.push({ kind: 'camera', id: null, reason: 'eye 与 target 重合' });
    const fxup = cross(f, cam.up);
    if (length(fxup) <= 1e-12) errors.push({ kind: 'camera', id: null, reason: 'up 与视线方向平行' });
  }
  const widthOk = Number.isInteger(cam?.width) && cam.width >= 16 && cam.width <= 320;
  if (!widthOk) errors.push({ kind: 'camera', id: null, reason: `width=${cam?.width} 不在 [16,320]` });
  const heightOk = Number.isInteger(cam?.height) && cam.height >= 16 && cam.height <= 240;
  if (!heightOk) errors.push({ kind: 'camera', id: null, reason: `height=${cam?.height} 不在 [16,240]` });
  if (!(Number.isFinite(cam?.near) && Number.isFinite(cam?.far) && cam.near > 0 && cam.near < cam.far)) {
    errors.push({ kind: 'camera', id: null, reason: '需满足 0 < near < far' });
  }
  if (!(Number.isFinite(cam?.fovYDeg) && cam.fovYDeg > 5 && cam.fovYDeg < 170)) {
    errors.push({ kind: 'camera', id: null, reason: `fovYDeg=${cam?.fovYDeg} 不在 (5,170)` });
  }
  if (!(Number.isInteger(scene.maxBounceDepth) && scene.maxBounceDepth >= 0 && scene.maxBounceDepth <= 4)) {
    errors.push({ kind: 'scene', id: null, reason: `maxBounceDepth=${scene.maxBounceDepth} 不在 [0,4]` });
  }
  if (!(Number.isInteger(scene.beamBudgetK) && scene.beamBudgetK >= 1 && scene.beamBudgetK <= 32)) {
    errors.push({ kind: 'scene', id: null, reason: `beamBudgetK=${scene.beamBudgetK} 不在 [1,32]` });
  }
  const mirrors = Array.isArray(scene.mirrors) ? scene.mirrors : [];
  const tris = Array.isArray(scene.triangles) ? scene.triangles : [];
  if (mirrors.length > 16) errors.push({ kind: 'scene', id: null, reason: `mirrors.length=${mirrors.length} 超过 16` });
  if (tris.length > 4000) errors.push({ kind: 'scene', id: null, reason: `triangles.length=${tris.length} 超过 4000` });
  const ids = new Set();
  for (const m of mirrors) {
    if (typeof m.id !== 'string' || !m.id) errors.push({ kind: 'mirror', id: String(m.id), reason: '镜面缺少有效 id' });
    else if (ids.has(m.id)) errors.push({ kind: 'mirror', id: m.id, reason: '镜面 id 重复' });
    ids.add(m.id);
    validateMirror(m, errors);
  }
  const verts = Array.isArray(scene.vertices) ? scene.vertices : [];
  if (!verts.every(isFiniteV)) {
    errors.push({ kind: 'scene', id: null, reason: 'vertices 中存在非有限三维点' });
  }
  const triIds = new Set();
  for (const t of tris) {
    const tid = t.id;
    if (triIds.has(tid)) errors.push({ kind: 'triangle', id: tid, reason: '三角形 id 重复' });
    triIds.add(tid);
    const idx = t.indices;
    if (!Array.isArray(idx) || idx.length !== 3 || !idx.every((i) => Number.isInteger(i) && i >= 0 && i < verts.length)) {
      errors.push({ kind: 'triangle', id: tid, reason: `indices=${JSON.stringify(idx)} 存在越界索引（顶点数 ${verts.length}）` });
      continue;
    }
    const a = verts[idx[0]], b = verts[idx[1]], c = verts[idx[2]];
    if (triAreaNorm(a, b, c) <= 1e-9) {
      errors.push({ kind: 'triangle', id: tid, reason: '零面积退化三角形' });
    }
    const col = t.color;
    if (!Array.isArray(col) || col.length !== 3 || !col.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) {
      errors.push({ kind: 'triangle', id: tid, reason: 'color 必须是三个 [0,1] 内的分量' });
    }
  }
  return { valid: errors.length === 0, errors };
}
