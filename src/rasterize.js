// SPEC §6：斜近裁面+视束棱锥裁剪、奇数次单面翻转、层次像素遮挡与前向线性深度
import {
  add, cross, dot, mul, scale, sub, toByte, transformPoint4,
} from './math.js';
import { clipByPlanes, frustumPlanes, projectCamera, sidePlanes, toCamera } from './beam.js';

const Z_EPS = 1e-6;

// 世界空间几何（三角形/多边形）裁剪，保留世界坐标
function clipWorld(poly, planes) {
  return clipByPlanes(poly, planes);
}

// 相机空间裁剪：顶点带 {w(世界), c(相机)}
function clipVerts(verts, planes) {
  let cur = verts;
  for (const pl of planes) {
    const { n, p } = pl;
    const sdist = (v) => (v.c[0] - p[0]) * n[0] + (v.c[1] - p[1]) * n[1] + (v.c[2] - p[2]) * n[2];
    if (cur.length === 0) break;
    const out = [];
    let prev = cur[cur.length - 1];
    let prevIn = sdist(prev) >= 0;
    for (const c of cur) {
      const curIn = sdist(c) >= 0;
      if (curIn) {
        if (!prevIn) out.push(interpV(prev, c, pl));
        out.push(c);
      } else if (prevIn) {
        out.push(interpV(prev, c, pl));
      }
      prev = c; prevIn = curIn;
    }
    cur = out;
  }
  return cur;
}

function interpV(a, b, pl) {
  const { n, p } = pl;
  const da = dot(sub(a.c, p), n);
  const db = dot(sub(b.c, p), n);
  const t = Math.abs(da - db) < 1e-18 ? 0 : da / (da - db);
  return {
    w: add(a.w, scale(sub(b.w, a.w), t)),
    c: add(a.c, scale(sub(b.c, a.c), t)),
  };
}

// 三角形/多边形顶点 -> {w,c}
function toVerts(model, M, worldPts) {
  const { camera } = model;
  return worldPts.map((w) => {
    const unfolded = transformPoint4(M, w);
    return { w, c: toCamera(camera, unfolded) };
  });
}

// 光栅化一个三角形（顶点已投影），逐像素写 winner
// verts: [{c, screen:[u,v], w}]
function rasterTriangle(verts, width, height, writePixel) {
  const [A, B, C] = verts;
  const minU = Math.max(0, Math.floor(Math.min(A.screen[0], B.screen[0], C.screen[0])));
  const maxU = Math.min(width - 1, Math.ceil(Math.max(A.screen[0], B.screen[0], C.screen[0])));
  const minV = Math.max(0, Math.floor(Math.min(A.screen[1], B.screen[1], C.screen[1])));
  const maxV = Math.min(height - 1, Math.ceil(Math.max(A.screen[1], B.screen[1], C.screen[1])));
  const area = edge(A.screen, B.screen, C.screen);
  if (Math.abs(area) < 1e-12) return;
  const invArea = 1 / area;
  for (let j = minV; j <= maxV; j++) {
    for (let i = minU; i <= maxU; i++) {
      const sx = i + 0.5, sy = j + 0.5;
      const w0 = edge(B.screen, C.screen, [sx, sy]);
      const w1 = edge(C.screen, A.screen, [sx, sy]);
      const w2 = edge(A.screen, B.screen, [sx, sy]);
      // 与 area 同号即在内（含边界，中心采样）
      if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
      const b0 = w0 * invArea, b1 = w1 * invArea, b2 = w2 * invArea;
      // 透视正确的线性 z（z_view 本身为相机空间深度，1/z 线性插值）
      const z = 1 / (b0 / A.c[2] + b1 / B.c[2] + b2 / C.c[2]);
      writePixel(i, j, z);
    }
  }
}

function edge(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

// 凸多边形（镜面窗口）光栅化：扇面三角化
function rasterConvexPoly(verts, width, height, writePixel) {
  for (let k = 1; k + 1 < verts.length; k++) {
    rasterTriangle([verts[0], verts[k], verts[k + 1]], width, height, writePixel);
  }
}

function projectVerts(model, verts) {
  const { camera } = model;
  const out = [];
  for (const v of verts) {
    const screen = projectCamera(camera, v.c);
    if (!screen) return null;
    out.push({ ...v, screen });
  }
  return out;
}

// 构建一条激活视束的逐像素候选缓冲
// 元素: null | { kind:'tri', z, tri } | { kind:'mirror', z, mirrorId, childBeam }
function buildBeamBuffer(model, beam, activeSet) {
  const { camera, triangles, width, height } = model;
  const buf = new Array(width * height).fill(null);
  const d = beam.depth;

  // 视束世界空间裁剪平面
  const worldPlanes = [];
  if (d >= 1) {
    const mirror = model.mirrors.find((mm) => mm.id === beam.mirrorId);
    worldPlanes.push({ n: mirror.normal, p: mirror.v0, eps: 1e-6 });
    worldPlanes.push(...sidePlanes(beam.eye, beam.window));
  }

  const writeTri = (tri) => (i, j, z) => {
    const idx = j * width + i;
    const cur = buf[idx];
    const cand = { kind: 'tri', z, tri };
    if (!cur || closer(cand, cur, d)) buf[idx] = cand;
  };

  for (const tri of triangles) {
    // 单面朝向：在真实世界空间对当前虚相机判定（奇数次翻转由 det(M_d) 自动体现）
    if (tri.singleSided) {
      if (!(dot(sub(beam.eye, tri.a), tri.normal) > 0)) continue;
    }
    let worldPts = [tri.a, tri.b, tri.c];
    if (d >= 1) {
      worldPts = clipWorld(worldPts, worldPlanes);
      if (worldPts.length < 3) continue;
    }
    // 展开到主相机空间并裁主视锥
    let verts = toVerts(model, beam.M, worldPts);
    verts = clipVerts(verts, model.frustum);
    if (verts.length < 3) continue;
    const proj = projectVerts(model, verts);
    if (!proj) continue;
    // 世界空间裁剪可能产生 >3 顶点多边形，扇面三角化
    for (let k = 1; k + 1 < proj.length; k++) {
      rasterTriangle([proj[0], proj[k], proj[k + 1]], width, height, writeTri(tri));
    }
  }

  // 激活子镜面窗口
  for (const child of beam.children) {
    if (!activeSet.has(child)) continue;
    let worldPts = child.window;
    if (d >= 1) {
      worldPts = clipWorld(worldPts.map((p) => p.slice()), worldPlanes);
      if (worldPts.length < 3) continue;
    }
    let verts = toVerts(model, beam.M, worldPts);
    verts = clipVerts(verts, model.frustum);
    if (verts.length < 3) continue;
    const proj = projectVerts(model, verts);
    if (!proj) continue;
    const writeMirror = (i, j, z) => {
      const idx = j * width + i;
      const cur = buf[idx];
      const cand = { kind: 'mirror', z, mirrorId: child.mirrorId, childBeam: child };
      if (!cur || closer(cand, cur, d)) buf[idx] = cand;
    };
    rasterConvexPoly(proj, width, height, writeMirror);
  }
  return buf;
}

// 同视束内深度竞争：近者胜；并列时层数小（外层调用已固定 d）→ 图元 id 小
// 同层内：三角形优先于镜面（z_tri <= z_mirror 即挡住），同类按 id
function closer(cand, cur, d) {
  if (cur.z - cand.z > Z_EPS) return true;          // cand 明显更近
  if (Math.abs(cur.z - cand.z) <= Z_EPS) {
    if (cand.kind === 'tri' && cur.kind === 'mirror') return true;
    if (cand.kind === 'mirror' && cur.kind === 'tri') return false;
    const idC = cand.kind === 'tri' ? cand.tri.id : cand.mirrorId;
    const idU = cur.kind === 'tri' ? cur.tri.id : cur.mirrorId;
    if (typeof idC === 'number' && typeof idU === 'number') return idC < idU;
    return String(idC) < String(idU);
  }
  return false;
}

// 递归解析像素：返回 { color:[r,g,b] 0..255, trace:[...] }
function resolvePixel(beam, buf, x, y, width, model, activeSet, buffers) {
  const idx = y * width + x;
  const hit = buf[idx];
  if (!hit) return null;
  if (hit.kind === 'tri') {
    const rgb = mul(hit.tri.color, beam.R).map(toByte);
    return {
      color: rgb,
      trace: [{
        depth: beam.depth, path: beam.path.slice(), kind: 'triangle',
        triangleId: hit.tri.id, z: hit.z, reflectance: beam.R.slice(),
      }],
    };
  }
  // 镜面：递归进入子视束
  const child = hit.childBeam;
  const sub = resolvePixel(child, buffers.get(child), x, y, width, model, activeSet, buffers);
  const baseColor = mul([0.12, 0.12, 0.12], child.R).map(toByte);
  const mirrorStep = {
    depth: child.depth, path: child.path.slice(), kind: 'mirror',
    mirrorId: child.mirrorId, z: hit.z, reflectance: child.R.slice(),
  };
  if (!sub) {
    return { color: baseColor, trace: [mirrorStep] };
  }
  return { color: sub.color, trace: [mirrorStep, ...sub.trace] };
}

export function render(model, tree, activeSet, bufferCache = null, keyOf = null) {
  const { camera, width, height } = model;
  model.frustum = frustumPlanes(camera);

  const activeBeams = tree.all.filter((b) => b.depth === 0 || activeSet.has(b));
  const buffers = new Map();
  let reused = 0;
  for (const b of activeBeams) {
    const key = keyOf ? keyOf(b) : b;
    if (bufferCache && bufferCache.has(key)) {
      buffers.set(b, bufferCache.get(key));
      reused++;
      continue;
    }
    const buf = buildBeamBuffer(model, b, activeSet);
    buffers.set(b, buf);
    if (bufferCache) bufferCache.set(key, buf);
  }
  const rootBuf = buffers.get(tree.root);
  const image = new Uint8ClampedArray(width * height * 4);
  const pixelInfo = new Array(width * height).fill(null);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const res = resolvePixel(tree.root, rootBuf, i, j, width, model, activeSet, buffers);
      const o = (j * width + i) * 4;
      if (res) {
        image[o] = res.color[0]; image[o + 1] = res.color[1]; image[o + 2] = res.color[2];
        pixelInfo[j * width + i] = res.trace;
      } else {
        image[o] = 0; image[o + 1] = 0; image[o + 2] = 0;
        pixelInfo[j * width + i] = [];
      }
      image[o + 3] = 255;
    }
  }
  return { image, pixelInfo, buffers, bufferReuse: reused };
}
