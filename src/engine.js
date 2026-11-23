// engine.js — 扬声器单纯形声像混合核心（浏览器 / Node 通用，无依赖）
// 规范见 samples 说明.txt：
//  - 听者在原点；扬声器共球、坐标互异
//  - 自求包围原点的凸包；共面面片按边界环排序，由最小 id 顶点扇形三角化
//  - 每帧线性插值源方向（不预归一），在正锥内求非负系数
//  - 理论零值允许绝对误差 1e-10；多候选取升序 id 三元组字典序首个
//  - 近零系数归零，三系数除以二范数，其余声道为 0
//  - 零方向帧指出位置并保留上次结果

const ZERO_EPS = 1e-10;          // 系数理论零值的绝对误差
const CONTAIN_EPS = 1e-9;        // 凸包严格包含原点的判定容差
const SPHERE_EPS = 1e-7;         // 共球半径相对容差
const NORMAL_EPS = 1e-12;        // 单位法向量平行判定

// ---------- 基础向量运算 ----------
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];; }
function norm3(a) { return Math.hypot(a[0], a[1], a[2]); }

// ---------- 校验 + 构建场景 ----------
// 输出：{ speakers, ids, faces, ... }，失败抛出带 code 的 Error
function buildScene(layout) {
  const errors = [];
  if (!layout || !Array.isArray(layout.speakers) || !Array.isArray(layout.path)) {
    throw makeError('BAD_LAYOUT', 'layout.json 需包含 speakers 与 path 数组');
  }
  const spIn = layout.speakers;
  if (spIn.length < 4) throw makeError('BAD_LAYOUT', '扬声器至少需要 4 只（当前 ' + spIn.length + ' 只），无法构成三维凸包');
  if (spIn.length > 24) throw makeError('BAD_LAYOUT', '扬声器数量上限 24（当前 ' + spIn.length + ' 只）');

  const ids = [];
  const idSet = new Set();
  const coords = [];
  for (const s of spIn) {
    if (!s || !Number.isInteger(s.id) || s.id <= 0) {
      throw makeError('BAD_LAYOUT', '存在非法扬声器 id（须为唯一正整数）');
    }
    if (idSet.has(s.id)) throw makeError('BAD_LAYOUT', '扬声器 id 重复：' + s.id);
    const xyz = s.xyz;
    if (!Array.isArray(xyz) || xyz.length !== 3 || !xyz.every(Number.isInteger) ||
        xyz.some((v) => Math.abs(v) > 1000)) {
      throw makeError('BAD_LAYOUT', '扬声器 ' + s.id + ' 的 xyz 须为绝对值 ≤1000 的整数三元组');
    }
    if (xyz[0] === 0 && xyz[1] === 0 && xyz[2] === 0) {
      throw makeError('BAD_LAYOUT', '扬声器 ' + s.id + ' 位于原点，半径为 0');
    }
    ids.push(s.id); idSet.add(s.id);
    coords.push([xyz[0], xyz[1], xyz[2]]);
  }
  // 坐标互异
  const keySet = new Set(coords.map((c) => c.join(',')));
  if (keySet.size !== coords.length) throw makeError('BAD_LAYOUT', '扬声器坐标必须互异');

  // 同一以原点为中心的非零半径球面
  const radii = coords.map((c) => norm3(c));
  const r0 = radii[0];
  for (let i = 1; i < radii.length; i++) {
    if (Math.abs(radii[i] - r0) > SPHERE_EPS * r0) {
      throw makeError('NOT_SPHERICAL',
        '扬声器不在同一以原点为中心的球面上：id=' + ids[i] + ' 半径 ' + radii[i].toFixed(6) +
        '，参考半径 ' + r0.toFixed(6));
    }
  }

  // 凸包（gift wrapping，共面合并后扇形三角化）
  const hull = convexHull(coords, ids);
  if (hull.dim < 3) {
    throw makeError('NOT_ENCLOSING',
      '所有扬声器共面/共线，凸包退化（维度=' + hull.dim + '），无法包围听者原点');
  }

  // 严格包含原点：每个外表面 n·x = d（n 朝外单位向量），原点在内侧要求 d > 0
  for (const f of hull.faces) {
    const n = faceUnitNormal(f, coords);
    const d = dot(n, coords[f.v[0]]);
    if (!(d > CONTAIN_EPS)) {
      throw makeError('ORIGIN_NOT_INSIDE',
        '凸包未严格包含原点：面片（扬声器 id ' +
        f.v.map((vi) => ids[vi]).sort((a, b) => a - b).join(', ') +
        '）的有符号距离 ' + d.toExponential(3) + ' ≤ 容差，听者位于凸包表面或外部');
    }
    f.planeN = n;
    f.planeD = d;
  }

  // 按升序 id 三元组字典序排列面片，保证并列时取编号最小三元组
  const faces = hull.faces.map((f) => {
    const vSorted = f.v.slice().sort((a, b) => ids[a] - ids[b]);
    return {
      v: f.v,                       // 朝外绕序（用于三维显示）
      vSorted,                      // 按 id 升序的顶点（用于求系数与字典序比较）
      key: vSorted.map((vi) => ids[vi]),
      planeN: f.planeN,             // 朝外单位法向与平面常数（三维显示/包含性）
      planeD: f.planeD,
    };
  });
  faces.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return 0;
  });

  // 预计算每个面片 3x3 坐标矩阵的余因子/行列式，逐帧只需 9 次乘加
  for (const f of faces) precomputeFace(f, coords);

  // 轨迹校验
  const path = validatePath(layout.path);

  return {
    ids,                          // 数值 id 升序输出顺序
    coords,                       // 与输入同序的坐标
    radius: r0,
    faces,                        // 字典序面片
    path,
    n: coords.length,
  };
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function validatePath(pathIn) {
  if (pathIn.length < 2) throw makeError('BAD_PATH', '轨迹至少需要 2 个关键点');
  const path = [];
  let prev = -1;
  for (const p of pathIn) {
    if (!p || !Number.isInteger(p.frame) || !Array.isArray(p.xyz) || p.xyz.length !== 3 ||
        !p.xyz.every(Number.isInteger) || p.xyz.some((v) => Math.abs(v) > 1000)) {
      throw makeError('BAD_PATH', '存在非法轨迹点（frame 为整数、xyz 为绝对值 ≤1000 的整数三元组）');
    }
    if (p.frame <= prev) throw makeError('BAD_PATH', '轨迹 frame 必须严格递增，违规 frame=' + p.frame);
    prev = p.frame;
    path.push({ frame: p.frame, xyz: p.xyz.slice() });
  }
  if (path[0].frame !== 0) throw makeError('BAD_PATH', '轨迹首点 frame 必须为 0（当前 ' + path[0].frame + '）');
  return path;
}

// ---------- 三维凸包：gift wrapping + 共面多边形扇形三角化 ----------
// points 坐标，ids 用于扇形锚点（取 id 最小顶点）。顶点数组下标即输入顺序。
function convexHull(points, ids) {
  const n = points.length;

  // 0) 仿射维度检查：最远点对 p0-p1、距直线最远 p2、距平面最远 p3，体积趋零即退化
  let p0 = 0, p1 = 1;
  let farPair = -1;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = norm3(sub(points[j], points[i]));
    if (d > farPair) { farPair = d; p0 = i; p1 = j; }
  }
  const e01 = sub(points[p1], points[p0]);
  let p2 = -1, dLine = -1;
  for (let i = 0; i < n; i++) {
    if (i === p0 || i === p1) continue;
    const d = norm3(cross(e01, sub(points[i], points[p0])));
    if (d > dLine) { dLine = d; p2 = i; }
  }
  if (p2 === -1) return { dim: 1, faces: [] };       // 全部共线
  const nPlane = cross(e01, sub(points[p2], points[p0]));
  const nLen = norm3(nPlane);
  let dMax = -1;
  for (let i = 0; i < n; i++) {
    if (i === p0 || i === p1 || i === p2) continue;
    dMax = Math.max(dMax, Math.abs(dot(nPlane, sub(points[i], points[p0]))));
  }
  // 真实点面距离 = dMax/nLen；与最远点对长度比较判定是否退化
  if (dMax / nLen <= 1e-10 * farPair) return { dim: 2, faces: [] };

  // 1) 全枚举凸包面：三元组 (a,b,c) 若所有点都在其平面的同一闭半空间，即为凸包面。
  //    n ≤ 24，C(24,3)=2024、每片至多 24 点，约 5 万次点积，无遍历绕序歧义。
  //    共面的顶点会让同平面产生多个三角片，稍后按平面聚类合并并重新扇形化。
  const tris = [];
  const triSeen = new Set();
  const addTri = (a, b, c) => {
    const tk = [a, b, c].sort((x, y) => x - y).join('_');
    if (triSeen.has(tk)) return;
    triSeen.add(tk);
    tris.push({ v: [a, b, c], key: tk });
  };
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const eab = sub(points[b], points[a]);
      for (let c = b + 1; c < n; c++) {
        const nrm = cross(eab, sub(points[c], points[a]));
        const ln = norm3(nrm);
        if (ln < 1e-15) continue;                   // 共线三元组
        const nU = [nrm[0] / ln, nrm[1] / ln, nrm[2] / ln];
        let sign = 0;
        let ok = true;
        for (let i = 0; i < n; i++) {
          const s = dot(nU, sub(points[i], points[a]));
          if (Math.abs(s) <= NORMAL_EPS) continue; // 面上/共面点
          if (sign === 0) sign = s > 0 ? 1 : -1;
          else if ((s > 0 ? 1 : -1) !== sign) { ok = false; break; }
        }
        if (!ok) continue;
        // 朝外绕序：令所有点满足 n·(x-a) ≤ 0。sign>0 表示当前 n 朝内，翻转 b,c
        if (sign > 0) addTri(a, c, b);
        else addTri(a, b, c);
      }
    }
  }
  if (tris.length === 0) return { dim: 2, faces: [] };

  // 2) 共面三角片聚类：无向平面匹配 —— 法向平行（|n·n0|≈1）且面上点到候选平面
  //    的有向距离 ≈0。所有点为整数、坐标 ≤1000，叉积量级有限，1e-9 绝对容差足够。
  const PLANE_EPS = 1e-9;
  const groups = [];
  for (const t of tris) {
    const n = rawNormal(t.v, points);
    const ln = norm3(n);
    const nU = [n[0] / ln, n[1] / ln, n[2] / ln];
    const ref = points[t.v[0]];
    let g = null;
    for (const cand of groups) {
      if (Math.abs(Math.abs(dot(nU, cand.n)) - 1) > PLANE_EPS) continue; // 法向不平行
      const dist = Math.abs(dot(cand.n, sub(ref, cand.ref)));
      if (dist <= PLANE_EPS) { g = cand; break; }
    }
    if (!g) { g = { n: nU, ref: ref.slice(), tris: [] }; groups.push(g); }
    g.tris.push(t);
  }

  // 3) 每组：枚举会把共面 k 边形的全部 C(k,3) 个三元组都标记为面，无法靠边计数
  //    还原边界。改为收集该平面上的全部顶点，在平面内投影成二维凸多边形、按极角
  //    排序成边界环，再以 id 最小顶点作扇形三角化（环正反方向产生同一三角形集合）。
  const faces = [];
  for (const g of groups) {
    const verts = [...new Set(g.tris.flatMap((t) => t.v))];
    if (verts.length < 3) {
      for (const t of g.tris) faces.push({ v: t.v.slice() }); // 兜底
      continue;
    }
    // 在平面内构造正交基 (b1,b2)：取与法向最不平行的坐标轴做叉积
    const n = g.n;
    const axis = Math.abs(n[0]) < Math.abs(n[1])
      ? (Math.abs(n[0]) < Math.abs(n[2]) ? [1, 0, 0] : [0, 0, 1])
      : (Math.abs(n[1]) < Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1]);
    let b1 = cross(n, axis);
    b1 = b1.map((x) => x / norm3(b1));
    const b2 = cross(n, b1);                    // 已正交单位化（n、b1 单位且垂直）
    const c = verts.reduce((acc, vi) => {
      acc[0] += points[vi][0]; acc[1] += points[vi][1]; acc[2] += points[vi][2];
      return acc;
    }, [0, 0, 0]).map((x) => x / verts.length); // 平面内重心作为极角原点
    // 二维投影 + 极角排序
    const proj = verts.map((vi) => {
      const r = sub(points[vi], c);
      return { vi, x: dot(r, b1), y: dot(r, b2) };
    });
    proj.sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
    let loop = proj.map((p) => p.vi);

    // 绕序与组外法向一致
    const loopN = cross(
      sub(points[loop[1]], points[loop[0]]),
      sub(points[loop[2]], points[loop[0]]));
    if (dot(loopN, n) < 0) loop = loop.slice().reverse();

    // 以 id 最小的顶点作扇形锚点，锚点之后保持环序
    let anchor = loop[0];
    for (const vi of loop) if (ids[vi] < ids[anchor]) anchor = vi;
    const ai = loop.indexOf(anchor);
    const ring = loop.slice(ai + 1).concat(loop.slice(0, ai));
    for (let k = 0; k < ring.length - 1; k++) {
      faces.push({ v: [anchor, ring[k], ring[k + 1]] });
    }
  }

  return { dim: 3, faces };
}

function rawNormal(v, points) {
  return cross(sub(points[v[1]], points[v[0]]), sub(points[v[2]], points[v[0]]));
}
function faceUnitNormal(f, points) {
  const n = rawNormal(f.v, points);
  const ln = norm3(n);
  return [n[0] / ln, n[1] / ln, n[2] / ln];
}

// ---------- 面片求逆预处理 ----------
// 方向 d = c1*S1 + c2*S2 + c3*S3，矩阵 M 列为三扬声器坐标
function precomputeFace(f, points) {
  const [i0, i1, i2] = f.vSorted;
  const a = points[i0], b = points[i1], c = points[i2];
  f.cols = [a, b, c];
  f.det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0]);
  // 余因子矩阵（转置伴随），solve 时 cof·d / det
  f.cof = [
    b[1] * c[2] - b[2] * c[1],
    a[2] * c[1] - a[1] * c[2],
    a[1] * b[2] - a[2] * b[1],
    b[2] * c[0] - b[0] * c[2],
    a[0] * c[2] - a[2] * c[0],
    a[2] * b[0] - a[0] * b[2],
    b[0] * c[1] - b[1] * c[0],
    a[1] * c[0] - a[0] * c[1],
    a[0] * b[1] - a[1] * b[0],
  ];
  f.invDet = 1 / f.det;
}

// 在面片中解 d 的系数；返回 null 表示非正锥
function solveFace(f, d) {
  const c = f.cof, s = f.invDet;
  const x = (c[0] * d[0] + c[1] * d[1] + c[2] * d[2]) * s;
  const y = (c[3] * d[0] + c[4] * d[1] + c[5] * d[2]) * s;
  const z = (c[6] * d[0] + c[7] * d[1] + c[8] * d[2]) * s;
  if (x < -ZERO_EPS || y < -ZERO_EPS || z < -ZERO_EPS) return null;
  return [x, y, z];
}

// ---------- 逐帧方向插值（整数精确零向量检查）----------
function frameDirection(scene, frame) {
  const path = scene.path;
  let seg = 0;
  while (seg < path.length - 2 && frame > path[seg + 1].frame) seg++;
  const p0 = path[seg], p1 = path[seg + 1];
  const span = p1.frame - p0.frame;
  const t = span === 0 ? 0 : (frame - p0.frame) / span;
  const d = [
    p0.xyz[0] + (p1.xyz[0] - p0.xyz[0]) * t,
    p0.xyz[1] + (p1.xyz[1] - p0.xyz[1]) * t,
    p0.xyz[2] + (p1.xyz[2] - p0.xyz[2]) * t,
  ];
  // 精确零向量检查：插值结果为零 ⇔ (f1-f)*p0 + (f-f0)*p1 = 0（整数运算）
  const num = [
    (p1.frame - frame) * p0.xyz[0] + (frame - p0.frame) * p1.xyz[0],
    (p1.frame - frame) * p0.xyz[1] + (frame - p0.frame) * p1.xyz[1],
    (p1.frame - frame) * p0.xyz[2] + (frame - p0.frame) * p1.xyz[2],
  ];
  const isZero = num[0] === 0 && num[1] === 0 && num[2] === 0;
  return { d, isZero, seg, t };
}

// 单帧增益：gains 为长度 n 的 Float64Array（复用）；零方向/失败时保留上次结果
// 返回 { faceIndex, coeffs, zero, fallback }
// 面片已按 id 三元组字典序排列。射线严格在正锥内部时仅一个面片非负；
// 落在边界（系数≈0）时可能多候选，必须全量扫描取字典序最小者。
function frameGains(scene, frame, gains, lastFaceIndex) {
  const { d, isZero } = frameDirection(scene, frame);
  if (isZero) {
    return { zero: true, faceIndex: lastFaceIndex ?? -1, d };
  }
  const faces = scene.faces;
  // 快速路径：先测上帧面片。严格内部命中（三个系数均显著为正）即唯一解
  let chosen = -1;
  let chosenCoeffs = null;
  if (lastFaceIndex >= 0) {
    const coef = solveFace(faces[lastFaceIndex], d);
    if (coef && coef[0] > ZERO_EPS && coef[1] > ZERO_EPS && coef[2] > ZERO_EPS) {
      chosen = lastFaceIndex;
      chosenCoeffs = coef;
    }
  }
  // 慢速路径：字典序全量扫描，命中首个全部非负的面片（边界并列时即最小三元组）
  if (chosen < 0) {
    for (let fi = 0; fi < faces.length; fi++) {
      const coef = solveFace(faces[fi], d);
      if (coef) { chosen = fi; chosenCoeffs = coef; break; }
    }
  }
  if (chosen < 0) {
    // 数值原因未命中：保留上次结果
    return { fallback: true, faceIndex: lastFaceIndex ?? -1, d };
  }
  const c = chosenCoeffs.map((v) => (Math.abs(v) <= ZERO_EPS ? 0 : v));
  const l2 = Math.hypot(c[0], c[1], c[2]);
  const f = faces[chosen];
  gains.fill(0);
  if (l2 > 0) {
    const iv = f.vSorted;
    gains[iv[0]] = c[0] / l2;
    gains[iv[1]] = c[1] / l2;
    gains[iv[2]] = c[2] / l2;
  }
  return { zero: false, faceIndex: chosen, coeffs: c, face: f, d };
}

// 全帧计算（导出/分析用）。audioFrames 为音频帧数；返回诊断信息
function computeAll(scene, audioFrames) {
  const n = scene.n;
  const nFrames = audioFrames;
  const gains = new Float64Array(n);
  const activeFaces = new Int32Array(nFrames);
  const zeroFrames = [];
  const fallbackFrames = [];
  let lastFace = -1;
  // 轨迹末帧校验（音频最后一帧 = nFrames-1）
  const lastPathFrame = scene.path[scene.path.length - 1].frame;
  if (lastPathFrame !== nFrames - 1) {
    throw makeError('BAD_PATH',
      '轨迹末点 frame=' + lastPathFrame + ' 与音频最后一帧 ' + (nFrames - 1) + ' 不一致');
  }
  const t0 = now();
  for (let f = 0; f < nFrames; f++) {
    const r = frameGains(scene, f, gains, lastFace);
    if (r.zero) zeroFrames.push(f);
    else if (r.fallback) fallbackFrames.push(f);
    else lastFace = r.faceIndex;
    activeFaces[f] = lastFace;
  }
  return { activeFaces, zeroFrames, fallbackFrames, elapsedMs: now() - t0, nFrames };
}

function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

const api = {
  ZERO_EPS, CONTAIN_EPS,
  buildScene, convexHull, frameDirection, frameGains, computeAll,
  solveFace, precomputeFace, makeError,
  dot, cross, sub, norm3,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.SimplexEngine = api;
