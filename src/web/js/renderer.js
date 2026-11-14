// CPU 软件光栅化参考台 —— JavaScript 实现（无任何外部依赖）。
// 与 src/py/alpha_render.py 遵循同一规范：
//   相机空间六平面 Sutherland-Hodgman 裁剪 → 屏幕投影 →
//   有向边函数 + 左上规则 → 透视正确 RGBA 插值 →
//   每像素全片元 (深度,id) 排序 → 前→后预乘线性合成 → sRGB 编码。
// 本模块不接触 DOM，可在 Worker 与 Node 中直接 import。

export const DEPTH_EPS = 1e-9;
const EDGE_EPS = 1e-12;

export class ValidationError extends Error {}

// ---------------------------------------------------------------------------
// 向量工具
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(a) {
  const n = Math.hypot(a[0], a[1], a[2]);
  if (n === 0) throw new ValidationError('零长度向量无法构成相机基向量');
  return [a[0] / n, a[1] / n, a[2] / n];
}
const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}
function asVec3(obj, name) {
  if (!Array.isArray(obj) || obj.length !== 3 || !obj.every(isNum))
    throw new ValidationError(`${name} 必须是 3 个有限数字`);
  return [Number(obj[0]), Number(obj[1]), Number(obj[2])];
}
function asRgba(obj, name) {
  if (!Array.isArray(obj) || obj.length !== 4 || !obj.every(isNum))
    throw new ValidationError(`${name} 必须是 4 个有限数字`);
  const v = obj.map(Number);
  for (const c of v) if (c < 0 || c > 1) throw new ValidationError(`${name} 分量超出 [0,1]`);
  return v;
}
function asRgb01(obj, name) {
  if (!Array.isArray(obj) || obj.length !== 3 || !obj.every(isNum))
    throw new ValidationError(`${name} 必须是 3 个有限数字`);
  const v = obj.map(Number);
  for (const c of v) if (c < 0 || c > 1) throw new ValidationError(`${name} 分量超出 [0,1]`);
  return v;
}
function checkCamera(cam) {
  const position = asVec3(cam.position, 'camera.position');
  const target = asVec3(cam.target, 'camera.target');
  const up = asVec3(cam.up, 'camera.up');
  if (!isNum(cam.fov_y_degrees) || !(cam.fov_y_degrees > 0 && cam.fov_y_degrees < 180))
    throw new ValidationError('fov_y_degrees 必须在 (0,180) 内');
  if (!isNum(cam.near) || !isNum(cam.far))
    throw new ValidationError('near/far 必须为数字');
  if (!(cam.near > 0 && cam.near < cam.far))
    throw new ValidationError('必须满足 0 < near < far');
  if (dot(sub(target, position), sub(target, position)) === 0)
    throw new ValidationError('position 与 target 重合');
  return {
    position, target, up,
    fov_y_degrees: Number(cam.fov_y_degrees),
    near: Number(cam.near), far: Number(cam.far),
  };
}

export function validateScene(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
    throw new ValidationError('场景根必须是对象');
  if (obj.version !== 1) throw new ValidationError('version 必须为 1');
  const { width, height } = obj;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new ValidationError('width/height 必须为正整数');
  if (obj.camera === null || typeof obj.camera !== 'object')
    throw new ValidationError('缺少 camera');
  const camera = checkCamera(obj.camera);
  const background = asRgb01(obj.background_linear_rgb, 'background_linear_rgb');
  if (!Array.isArray(obj.triangles) || obj.triangles.length === 0)
    throw new ValidationError('triangles 必须是非空数组');

  const seen = new Set();
  const triangles = obj.triangles.map((t, ti) => {
    if (t === null || typeof t !== 'object')
      throw new ValidationError(`triangles[${ti}] 必须是对象`);
    if (!Number.isInteger(t.id) || t.id < 0)
      throw new ValidationError(`triangles[${ti}].id 必须是非负整数`);
    if (seen.has(t.id))
      throw new ValidationError(`三角形 id ${t.id} 重复，拒绝整个场景`);
    seen.add(t.id);
    if (!Array.isArray(t.vertices) || t.vertices.length !== 3)
      throw new ValidationError(`三角形 ${t.id} 必须恰有 3 个顶点`);
    const vertices = t.vertices.map((v, vi) => {
      if (v === null || typeof v !== 'object')
        throw new ValidationError(`三角形 ${t.id} 顶点 ${vi} 必须是对象`);
      return {
        position: asVec3(v.position, `三角形 ${t.id} 顶点 ${vi}.position`),
        rgba: asRgba(v.rgba, `三角形 ${t.id} 顶点 ${vi}.rgba`),
      };
    });
    return { id: t.id, vertices };
  });
  return { version: 1, width, height, camera, background_linear_rgb: background, triangles };
}

// ---------------------------------------------------------------------------
// 相机
// ---------------------------------------------------------------------------

function buildCamera(cam) {
  const forward = norm(sub(cam.target, cam.position));
  const right = norm(cross(forward, norm(cam.up)));
  const up = cross(right, forward);
  return {
    position: cam.position, right, up, forward,
    tanHalf: Math.tan((cam.fov_y_degrees * Math.PI / 180) * 0.5),
    near: cam.near, far: cam.far,
  };
}
function toCamera(camera, p) {
  const d = sub(p, camera.position);
  return [dot(d, camera.right), dot(d, camera.up), dot(d, camera.forward)];
}

// ---------------------------------------------------------------------------
// 视锥裁剪（六平面 Sutherland-Hodgman）
// ---------------------------------------------------------------------------

function frustumPlanes(cam) {
  const t = cam.tanHalf;
  return [
    (v) => v[2] - cam.near,
    (v) => cam.far - v[2],
    (v) => v[0] + v[2] * t,
    (v) => v[2] * t - v[0],
    (v) => v[1] + v[2] * t,
    (v) => v[2] * t - v[1],
  ];
}
function clipPolygon(poly, plane) {
  if (poly.length === 0) return poly;
  const out = [];
  let s = poly[poly.length - 1];
  let ds = plane(s.cam);
  for (const e of poly) {
    const de = plane(e.cam);
    const sIn = ds >= 0, eIn = de >= 0;
    if (eIn) {
      if (!sIn) {
        const t = ds / (ds - de);
        out.push({ cam: lerp(s.cam, e.cam, t), rgba: s.rgba.map((c, i) => c + (e.rgba[i] - c) * t) });
      }
      out.push(e);
    } else if (sIn) {
      const t = ds / (ds - de);
      out.push({ cam: lerp(s.cam, e.cam, t), rgba: s.rgba.map((c, i) => c + (e.rgba[i] - c) * t) });
    }
    s = e; ds = de;
  }
  return out;
}

// ---------------------------------------------------------------------------
// sRGB
// ---------------------------------------------------------------------------

export function srgbEncode(c) {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function srgbByte(c) {
  return Math.min(255, Math.max(0, Math.trunc(srgbEncode(c) * 255 + 0.5)));
}

// ---------------------------------------------------------------------------
// 单分带光栅化
// 返回紧凑 SoA：rgb8 / linear / 片元数组（像素索引为分带内局部索引）
// ---------------------------------------------------------------------------

export function renderBand(scene, size, cameraOverride, y0, y1) {
  const sc = validateScene(scene);
  const cam = buildCamera(checkCamera(cameraOverride || sc.camera));
  const w = size;
  const bandH = y1 - y0;
  const n = w * bandH;
  const bg = sc.background_linear_rgb;

  const linear = new Float64Array(n * 3);
  const rgb8 = new Uint8ClampedArray(n * 3);

  // 裁剪 + 投影 + 扇形三角化
  const planes = frustumPlanes(cam);
  const screenTris = [];
  for (const tri of sc.triangles) {
    let poly = tri.vertices.map((v) => ({ cam: toCamera(cam, v.position), rgba: v.rgba.slice() }));
    for (const plane of planes) {
      poly = clipPolygon(poly, plane);
      if (poly.length === 0) break;
    }
    if (poly.length < 3) continue;
    const proj = poly.map((v) => {
      const [cx, cy, cz] = v.cam;
      const invZ = 1 / cz;
      return {
        sx: ((cx * invZ) / cam.tanHalf + 1) * 0.5 * w,
        sy: (1 - (cy * invZ) / cam.tanHalf) * 0.5 * w,
        invZ, z: cz, rgba: v.rgba,
      };
    });
    for (let k = 1; k < proj.length - 1; k++)
      screenTris.push([tri.id, proj[0], proj[k], proj[k + 1]]);
  }

  // 每像素覆盖片元（延迟分配）
  const cover = new Array(n).fill(null);
  const counts = new Int32Array(n);

  for (let [tid, a0, b0, c0] of screenTris) {
    let a = a0, b = b0, c = c0;
    let area2 = (b.sx - a.sx) * (c.sy - a.sy) - (b.sy - a.sy) * (c.sx - a.sx);
    if (area2 === 0) continue;
    if (area2 < 0) { [b, c] = [c, b]; area2 = -area2; }

    const xMin = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx)));
    const xMax = Math.min(w - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)) - 1);
    const yMin = Math.max(y0, Math.floor(Math.min(a.sy, b.sy, c.sy)));
    const yMax = Math.min(y1 - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)) - 1);
    if (xMin > xMax || yMin > yMax) continue;

    // 边 (p,q): (q-p) × (s-p)，步进增量
    const edges = [edgeStep(a, b), edgeStep(b, c), edgeStep(c, a)];

    for (let y = yMin; y <= yMax; y++) {
      const py = y + 0.5;
      // 行首三条边的值
      const eRow = edges.map((ed) => ed.dx * (py - ed.y) - ed.dy * ((xMin + 0.5) - ed.x));
      for (let x = xMin; x <= xMax; x++) {
        let inside = true;
        const ws = [0, 0, 0];
        for (let ei = 0; ei < 3; ei++) {
          let e = eRow[ei];
          // 增量步进的浮点残差对称 snap 到 0，保证共享边严格命中左上规则
          if (Math.abs(e) <= EDGE_EPS * area2) e = 0;
          if (e < 0) { inside = false; break; }
          if (e === 0) {
            const { dx, dy } = edges[ei];
            if (!(dy < 0 || (dy === 0 && dx > 0))) { inside = false; break; }
          }
          ws[ei] = e;
        }
        if (inside) {
          // w_a=E_bc, w_b=E_ca, w_c=E_ab
          const wa = ws[1] / area2;
          const wb = ws[2] / area2;
          const wc = ws[0] / area2;
          const denom = wa * a.invZ + wb * b.invZ + wc * c.invZ;
          const depth = 1 / denom;
          if (depth >= cam.near && depth <= cam.far) {
            const la = (wa * a.invZ) / denom;
            const lb = (wb * b.invZ) / denom;
            const lc = (wc * c.invZ) / denom;
            const rgba = [0, 0, 0, 0];
            for (let i = 0; i < 4; i++)
              rgba[i] = la * a.rgba[i] + lb * b.rgba[i] + lc * c.rgba[i];
            if (rgba[3] > 0) {
              const li = (y - y0) * w + x;
              counts[li]++;
              if (cover[li] === null) cover[li] = [];
              cover[li].push(tid, depth, rgba[0], rgba[1], rgba[2], rgba[3]);
            }
          }
        }
        // x 步进：e(x+1) - e(x) = -dy
        for (let ei = 0; ei < 3; ei++) eRow[ei] -= edges[ei].dy;
      }
    }
  }

  // 紧凑片元存储
  const total = counts.reduce((s, c) => s + c, 0);
  const fragStart = new Int32Array(n + 1);
  let off = 0;
  for (let i = 0; i < n; i++) { fragStart[i] = off; off += counts[i]; }
  fragStart[n] = off;
  const fragId = new Int32Array(total);
  const fragDepth = new Float64Array(total);
  const fragRgba = new Float64Array(total * 4);
  const fragComp = new Float64Array(total * 3);

  const depthCmp = (da, ida, db, idb) => {
    const scale = Math.max(1, Math.abs(da), Math.abs(db));
    if (Math.abs(da - db) <= DEPTH_EPS * scale) return ida < idb ? -1 : ida > idb ? 1 : 0;
    return da < db ? -1 : 1;
  };

  for (let i = 0; i < n; i++) {
    const raw = cover[i];
    if (raw === null) {
      const r = srgbByte(bg[0]), g = srgbByte(bg[1]), b = srgbByte(bg[2]);
      linear[i * 3] = bg[0]; linear[i * 3 + 1] = bg[1]; linear[i * 3 + 2] = bg[2];
      rgb8[i * 3] = r; rgb8[i * 3 + 1] = g; rgb8[i * 3 + 2] = b;
      continue;
    }
    // 解包为对象数组排序
    const list = [];
    for (let k = 0; k < raw.length; k += 6)
      list.push({ id: raw[k], depth: raw[k + 1], rgba: raw.slice(k + 2, k + 6) });
    list.sort((p, q) => depthCmp(p.depth, p.id, q.depth, q.id));

    let accR = 0, accG = 0, accB = 0, accA = 0;
    const base = fragStart[i];
    list.forEach((fr, k) => {
      const [r, g, b, alpha] = fr.rgba;
      const keep = 1 - accA;
      accR += keep * r * alpha;
      accG += keep * g * alpha;
      accB += keep * b * alpha;
      accA += keep * alpha;
      const slot = base + k;
      fragId[slot] = fr.id;
      fragDepth[slot] = fr.depth;
      fragRgba.set(fr.rgba, slot * 4);
      const remain = 1 - accA;
      fragComp[slot * 3] = accR + remain * bg[0];
      fragComp[slot * 3 + 1] = accG + remain * bg[1];
      fragComp[slot * 3 + 2] = accB + remain * bg[2];
    });
    const remain = 1 - accA;
    const fr = accR + remain * bg[0];
    const fg = accG + remain * bg[1];
    const fb = accB + remain * bg[2];
    linear[i * 3] = fr; linear[i * 3 + 1] = fg; linear[i * 3 + 2] = fb;
    rgb8[i * 3] = srgbByte(fr);
    rgb8[i * 3 + 1] = srgbByte(fg);
    rgb8[i * 3 + 2] = srgbByte(fb);
  }

  return { y0, y1, width: w, linear, rgb8, fragStart, fragId, fragDepth, fragRgba, fragComp };
}

function edgeStep(p, q) {
  return { x: p.sx, y: p.sy, dx: q.sx - p.sx, dy: q.sy - p.sy };
}

// ---------------------------------------------------------------------------
// 整帧（合并分带）。bands 为 renderBand 结果数组，按 y0 排序覆盖整帧。
// ---------------------------------------------------------------------------

export function mergeBands(bands, size, background) {
  const n = size * size;
  const linear = new Float64Array(n * 3);
  const rgb8 = new Uint8ClampedArray(n * 3);
  const fragStart = new Int32Array(n + 1);
  // 先统计总量
  let total = 0;
  for (const bd of bands) {
    const bn = bd.width * (bd.y1 - bd.y0);
    for (let i = 0; i < bn; i++) total += bd.fragStart[i + 1] - bd.fragStart[i];
  }
  const fragId = new Int32Array(total);
  const fragDepth = new Float64Array(total);
  const fragRgba = new Float64Array(total * 4);
  const fragComp = new Float64Array(total * 3);

  let outOff = 0;
  for (const bd of bands) {
    const bn = bd.width * (bd.y1 - bd.y0);
    for (let i = 0; i < bn; i++) {
      const globalP = bd.y0 * bd.width + i;
      linear.set(bd.linear.subarray(i * 3, i * 3 + 3), globalP * 3);
      rgb8.set(bd.rgb8.subarray(i * 3, i * 3 + 3), globalP * 3);
      const s0 = bd.fragStart[i], s1 = bd.fragStart[i + 1];
      fragStart[globalP] = outOff;
      const cnt = s1 - s0;
      fragId.set(bd.fragId.subarray(s0, s1), outOff);
      fragDepth.set(bd.fragDepth.subarray(s0, s1), outOff);
      fragRgba.set(bd.fragRgba.subarray(s0 * 4, s1 * 4), outOff * 4);
      fragComp.set(bd.fragComp.subarray(s0 * 3, s1 * 3), outOff * 3);
      outOff += cnt;
    }
  }
  fragStart[n] = outOff;
  return { size, background, linear, rgb8, fragStart, fragId, fragDepth, fragRgba, fragComp };
}

export function inspectPixel(frame, x, y) {
  const { size } = frame;
  if (!(x >= 0 && x < size && y >= 0 && y < size))
    throw new ValidationError('像素坐标越界');
  const p = y * size + x;
  const s0 = frame.fragStart[p], s1 = frame.fragStart[p + 1];
  const hits = [];
  for (let k = s0; k < s1; k++) {
    hits.push({
      id: frame.fragId[k],
      depth: frame.fragDepth[k],
      rgba: Array.from(frame.fragRgba.subarray(k * 4, k * 4 + 4)),
      composite_linear_rgb: Array.from(frame.fragComp.subarray(k * 3, k * 3 + 3)),
    });
  }
  return {
    x, y,
    linear_rgb: Array.from(frame.linear.subarray(p * 3, p * 3 + 3)),
    png_rgb8: Array.from(frame.rgb8.subarray(p * 3, p * 3 + 3)),
    hits,
  };
}
