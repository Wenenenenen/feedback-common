// SPEC §3-§5：主视锥、三维凸多边形裁剪、反射视束展开、得分、前缀闭合配额 DP
import {
  add, cross, dot, identity4, invert4, length, multiply4, normalize,
  reflectPoint, reflectionMatrix, scale, sub, transformPoint4, v3,
} from './math.js';
import { mirrorDerived } from './validate.js';

// ---------- 相机与主视锥 ----------
export function createCamera(cam) {
  const eye = cam.eye.slice();
  const f = normalize(sub(cam.target, cam.eye));
  const r = normalize(cross(f, cam.up));
  const u = cross(r, f);
  const t = Math.tan((cam.fovYDeg * Math.PI) / 360);
  const aspect = cam.width / cam.height;
  return {
    eye, f, r, u,
    near: cam.near, far: cam.far,
    t, aspect, width: cam.width, height: cam.height,
  };
}

// 世界点 -> 主相机空间 [x_c, y_c, z_view]
export function toCamera(camera, p) {
  const w = sub(p, camera.eye);
  return [dot(w, camera.r), dot(w, camera.u), dot(w, camera.f)];
}

// 相机空间 -> 画布坐标（SPEC §3），z<=0 返回 null
export function projectCamera(camera, c) {
  const z = c[2];
  if (!(z > 0)) return null;
  const xndc = c[0] / (camera.aspect * camera.t * z);
  const yndc = c[1] / (camera.t * z);
  return [
    ((xndc + 1) / 2) * camera.width,
    ((1 - yndc) / 2) * camera.height,
  ];
}

// 主视锥 6 个半空间（相机空间），每个 {n, p, eps}，保留 (x-p)·n >= eps
export function frustumPlanes(camera) {
  const { near, far, t, aspect } = camera;
  const at = aspect * t;
  return [
    { n: [0, 0, 1], p: [0, 0, near], eps: 0 },           // 近 z>=near
    { n: [0, 0, -1], p: [0, 0, far], eps: 0 },           // 远 z<=far
    { n: normalize([1, 0, at]), p: [0, 0, 0], eps: 0 },  // 左
    { n: normalize([-1, 0, at]), p: [0, 0, 0], eps: 0 }, // 右
    { n: normalize([0, 1, t]), p: [0, 0, 0], eps: 0 },   // 下
    { n: normalize([0, -1, t]), p: [0, 0, 0], eps: 0 },  // 上
  ];
}

// ---------- Sutherland-Hodgman 三维凸多边形裁剪 ----------
function clipPlane(poly, plane) {
  const { n, p, eps = 0 } = plane;
  if (poly.length === 0) return poly;
  const out = [];
  const sdist = (x) => dot(sub(x, p), n);
  let prev = poly[poly.length - 1];
  let prevIn = sdist(prev) >= eps;
  for (const cur of poly) {
    const curIn = sdist(cur) >= eps;
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur, n, p));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur, n, p));
    }
    prev = cur;
    prevIn = curIn;
  }
  return out;
}

function intersect(a, b, n, p) {
  const da = dot(sub(a, p), n);
  const db = dot(sub(b, p), n);
  const denom = da - db;
  const t = Math.abs(denom) < 1e-18 ? 0 : da / denom;
  return add(a, scale(sub(b, a), t));
}

export function clipByPlanes(poly, planes) {
  let cur = poly;
  for (const pl of planes) {
    cur = clipPlane(cur, pl);
    if (cur.length < 3) return cur;
  }
  return cur;
}

// 三维多边形面积（Newell 法向模 / 2）
export function polygonArea3(poly) {
  if (poly.length < 3) return 0;
  const N = v3();
  const v0 = poly[0];
  for (let i = 0; i < poly.length; i++) {
    const a = sub(poly[i], v0);
    const b = poly[(i + 1) % poly.length] === poly[0] ? sub(poly[0], v0) : sub(poly[(i + 1) % poly.length], v0);
    N[0] += a[1] * b[2] - a[2] * b[1];
    N[1] += a[2] * b[0] - a[0] * b[2];
    N[2] += a[0] * b[1] - a[1] * b[0];
  }
  return 0.5 * length(N);
}

// 二维有向面积（鞋带公式）
export function polygonArea2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return 0.5 * s;
}

function centroid(poly) {
  const c = v3();
  for (const p of poly) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return scale(c, 1 / poly.length);
}

// 视束侧平面（世界空间，内法线指向窗口内部）
export function sidePlanes(eye, window) {
  const c = centroid(window);
  const k = window.length;
  const planes = [];
  for (let i = 0; i < k; i++) {
    const qi = window[i];
    const qj = window[(i + 1) % k];
    let s = cross(sub(qi, eye), sub(qj, eye));
    const ls = length(s);
    if (ls <= 1e-15) continue;
    s = scale(s, 1 / ls);
    if (dot(s, sub(c, eye)) < 0) s = scale(s, -1);
    planes.push({ n: s, p: eye.slice(), eps: 0 });
  }
  return planes;
}

// ---------- 场景模型 ----------
export function buildModel(scene) {
  const camera = createCamera(scene.camera);
  const mirrors = scene.mirrors.map((m) => {
    const d = mirrorDerived(m);
    return {
      id: m.id,
      enabled: m.enabled !== false,
      reflectance: m.reflectance.slice(),
      vertices: m.vertices.map((p) => p.slice()),
      normal: d.normal,
      v0: d.v0,
      area: d.area,
    };
  });
  const triangles = scene.triangles.map((t) => {
    const a = scene.vertices[t.indices[0]].slice();
    const b = scene.vertices[t.indices[1]].slice();
    const c = scene.vertices[t.indices[2]].slice();
    return {
      id: t.id,
      a, b, c,
      normal: normalize(cross(sub(b, a), sub(c, a))),
      color: t.color.slice(),
      singleSided: t.singleSided === true,
    };
  });
  return {
    scene, camera, mirrors, triangles,
    width: camera.width, height: camera.height,
    maxBounceDepth: scene.maxBounceDepth,
    K: scene.beamBudgetK,
  };
}

// ---------- 视束展开（SPEC §4） ----------
// beam: { path:[mirrorId...], depth, eye, M, R(累计反射率), window(世界空间凸多边形),
//         mirrorId(当前镜面), score, children:[beam...] }

// 在给定父视束下生成全部子视束（不递归）；返回新建 beam 列表
function expandChildren(model, beam, planesF, mirrorById) {
  const { mirrors, maxBounceDepth, camera } = model;
  if (beam.depth >= maxBounceDepth) return [];
  const created = [];
  for (const m of mirrors) {
    if (!m.enabled) continue;
    if (beam.depth >= 1 && m.id === beam.mirrorId) continue; // 禁紧邻自反射
    // 1) 虚相机正面判定
    const h = dot(sub(beam.eye, m.v0), m.normal);
    if (!(h > 1e-6)) continue;
    // 2) 三维裁剪
    let poly = m.vertices.map((p) => p.slice());
    if (beam.depth === 0) {
      let camPoly = poly.map((p) => toCamera(camera, p));
      camPoly = clipByPlanes(camPoly, planesF);
      if (camPoly.length < 3) continue;
      poly = camPoly.map((c) => camToWorld(camera, c));
    } else {
      const parentMirror = mirrorById.get(beam.mirrorId);
      // (a) 父镜面正面半空间
      poly = clipPlane(poly, { n: parentMirror.normal, p: parentMirror.v0, eps: 1e-6 });
      if (poly.length < 3) continue;
      // (b) 视束侧平面
      poly = clipByPlanes(poly, sidePlanes(beam.eye, beam.window));
      if (poly.length < 3) continue;
      // (c) 经 M_d 展开到主相机空间后裁主视锥，再逆回世界空间
      const Minv = invert4(beam.M);
      let camPoly = poly.map((p) => toCamera(camera, transformPoint4(beam.M, p)));
      camPoly = clipByPlanes(camPoly, planesF);
      if (camPoly.length < 3) continue;
      poly = camPoly.map((c) => transformPoint4(Minv, camToWorld(camera, c)));
    }
    // 3) 面积剪枝
    if (poly.length < 3 || polygonArea3(poly) <= 1e-7) continue;
    // 4) 生成子视束
    const H = reflectionMatrix(m.v0, m.normal);
    const child = {
      path: beam.path.concat(m.id),
      depth: beam.depth + 1,
      eye: reflectPoint(beam.eye, m.v0, m.normal),
      M: multiply4(beam.M, H),
      R: [
        beam.R[0] * m.reflectance[0],
        beam.R[1] * m.reflectance[1],
        beam.R[2] * m.reflectance[2],
      ],
      window: poly,
      mirrorId: m.id,
      children: [],
      parent: beam,
      version: (beam.version || 0) + 1,
    };
    beam.children.push(child);
    created.push(child);
  }
  return created;
}

function camToWorld(camera, c) {
  return [
    camera.eye[0] + c[0] * camera.r[0] + c[1] * camera.u[0] + c[2] * camera.f[0],
    camera.eye[1] + c[0] * camera.r[1] + c[1] * camera.u[1] + c[2] * camera.f[1],
    camera.eye[2] + c[0] * camera.r[2] + c[1] * camera.u[2] + c[2] * camera.f[2],
  ];
}

// 全量展开
export function expandBeams(model) {
  const { camera, mirrors } = model;
  const mirrorById = new Map(mirrors.map((m) => [m.id, m]));
  const root = {
    path: [], depth: 0, eye: camera.eye.slice(), M: identity4(),
    R: [1, 1, 1], window: null, mirrorId: null, children: [], parent: null, version: 0,
  };
  const all = [root];
  const planesF = frustumPlanes(camera);
  const stack = [root];
  while (stack.length) {
    const beam = stack.pop();
    const created = expandChildren(model, beam, planesF, mirrorById);
    all.push(...created);
    stack.push(...created);
  }
  const computeSubtreeVersion = (beam) => {
    let v = beam.version || 0;
    for (const ch of beam.children) v = Math.max(v, computeSubtreeVersion(ch));
    beam.subtreeVersion = v;
    return v;
  };
  computeSubtreeVersion(root);
  return { root, all };
}

// 增量：镜面 mirrorId 被编辑后，仅重建路径包含该镜面的子树。
// 旧树中路径不含该镜面的视束对象（连同 version）整体保留；
// 重建的视束若与同路径旧节点几何等价则继承版本（像素缓冲可复用），否则分配新版本号。
export function expandBeamsIncremental(model, oldTree, changedMirrorId) {
  const { camera, mirrors } = model;
  const mirrorById = new Map(mirrors.map((m) => [m.id, m]));
  const planesF = frustumPlanes(camera);
  const root = oldTree.root;
  const all = [root];
  let nextVersion = 1 + Math.max(0, ...oldTree.all.map((b) => b.version || 0));
  // 根视束每次增量都重新生成子节点，其像素缓冲引用会变化，必须取新版本
  root.version = nextVersion++;
  const rebuild = (beam) => {
    const affected = beam.path.includes(changedMirrorId) || beam.depth === 0;
    if (!affected) {
      // 整条子树原样保留（version 不变 -> 像素缓冲可复用）
      const collect = (b) => { all.push(b); b.children.forEach(collect); };
      beam.children.forEach(collect);
      return;
    }
    if (beam.depth >= model.maxBounceDepth) return;
    const oldByPath = new Map(beam.children.map((c) => [c.path.join('>'), c]));
    beam.children = [];
    const created = expandChildren(model, beam, planesF, mirrorById);
    for (const ch of created) {
      const old = oldByPath.get(ch.path.join('>'));
      ch.version = old && geometryEqual(old, ch) ? old.version : nextVersion++;
      all.push(ch);
      rebuild(ch);
    }
  };
  rebuild(root);
  // 子树版本：beam 自身或任一后代被重建则升高。像素缓冲缓存以此为键——
  // 整棵子树未变才可复用（父缓冲持有子镜面窗口引用，后代变化即失效）
  const computeSubtreeVersion = (beam) => {
    let v = beam.version || 0;
    for (const ch of beam.children) v = Math.max(v, computeSubtreeVersion(ch));
    beam.subtreeVersion = v;
    return v;
  };
  computeSubtreeVersion(root);
  return { root, all };
}

function geometryEqual(a, b) {
  if (a.path.join('>') !== b.path.join('>')) return false;
  if (a.window.length !== b.window.length) return false;
  for (let i = 0; i < a.window.length; i++) {
    for (let k = 0; k < 3; k++) if (Math.abs(a.window[i][k] - b.window[i][k]) > 1e-9) return false;
  }
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a.R[k] - b.R[k]) > 1e-12) return false;
    if (Math.abs(a.eye[k] - b.eye[k]) > 1e-9) return false;
  }
  return true;
}

// ---------- 得分（SPEC §5） ----------
export function scoreBeams(model, tree) {
  const { camera } = model;
  const reflectBeams = tree.all.slice(1);
  for (const b of reflectBeams) {
    const Mp = b.parent.M; // M_{d-1}
    const pts = b.window.map((p) => {
      const c = toCamera(camera, transformPoint4(Mp, p));
      return projectCamera(camera, c);
    });
    let area = 0;
    if (pts.every(Boolean)) area = Math.abs(polygonArea2(pts));
    const L = 0.2126 * b.R[0] + 0.7152 * b.R[1] + 0.0722 * b.R[2];
    b.screenArea = area;
    b.luma = L;
    b.score = Math.round(area * L * 1000);
  }
  return reflectBeams;
}

// 路径字典序比较（逐项字符串比较）
export function comparePath(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// ---------- 树前缀闭合配额 DP（SPEC §5） ----------
// 输入全部反射视束（带 parent/children/score/path），返回 { selected:Set(beam), totalScore }
export function solveBudget(tree, K) {
  const root = tree.root;
  const beams = tree.all.slice(1);
  if (beams.length === 0) return { selected: new Set(), totalScore: 0 };

  // 全局路径字典序 rank（rank 越小路径字典序越小）
  const sorted = beams.slice().sort((x, y) => comparePath(x.path, y.path));
  const rankOf = new Map();
  sorted.forEach((b, i) => rankOf.set(b, i));

  // 后序（按深度降序，保证子先于父）
  const post = beams.slice().sort((a, b) => b.depth - a.depth);
  const NEG = -1;
  // dp[beam] = 数组，下标 k(1..子树可选最大数) -> {score, ranks:number[] 升序, picks:Map(child->k)}
  const dp = new Map();

  const better = (cand, cur) => {
    if (cur === undefined) return true;
    if (cand.score !== cur.score) return cand.score > cur.score;
    if (cand.ranks.length !== cur.ranks.length) return cand.ranks.length > cur.ranks.length;
    for (let i = 0; i < cand.ranks.length; i++) {
      if (cand.ranks[i] !== cur.ranks[i]) return cand.ranks[i] < cur.ranks[i];
    }
    return false;
  };

  for (const beam of post) {
    // 本节点必选（进入此表即选 beam 自身），初始 k=1
    let table = new Map(); // k -> state
    table.set(1, {
      score: beam.score,
      ranks: [rankOf.get(beam)],
      picks: new Map(),
    });
    for (const child of beam.children) {
      const childDp = dp.get(child); // k>=1 的表；undefined 表示子树无可行（不可能，子自身至少 1）
      const merged = new Map();
      const put = (k, st) => {
        const cur = merged.get(k);
        if (better(st, cur)) merged.set(k, st);
      };
      for (const [k0, st0] of table) {
        // 不选该子视束（前缀闭合：父选子可不选）
        put(k0, st0);
        // 选子视束子树 kc 条
        if (childDp) {
          for (const [kc, stc] of childDp) {
            const k = k0 + kc;
            if (k > K) continue;
            const ranks = st0.ranks.concat(stc.ranks).sort((x, y) => x - y);
            put(k, {
              score: st0.score + stc.score,
              ranks,
              picks: new Map(st0.picks).set(child, kc),
            });
          }
        }
      }
      table = merged;
    }
    dp.set(beam, table);
  }

  // 根合并：根不计分不计数，各深度 1 视束可选 0 或 kc 条
  let rootTable = new Map();
  rootTable.set(0, { score: 0, ranks: [], picks: new Map() });
  for (const child of root.children) {
    const childDp = dp.get(child);
    const merged = new Map();
    const put = (k, st) => {
      const cur = merged.get(k);
      if (better(st, cur)) merged.set(k, st);
    };
    for (const [k0, st0] of rootTable) {
      put(k0, st0);
      if (childDp) {
        for (const [kc, stc] of childDp) {
          const k = k0 + kc;
          if (k > K) continue;
          const ranks = st0.ranks.concat(stc.ranks).sort((x, y) => x - y);
          put(k, {
            score: st0.score + stc.score,
            ranks,
            picks: new Map(st0.picks).set(child, kc),
          });
        }
      }
    }
    rootTable = merged;
  }

  // 在所有 <=K 的状态中取最优（better 已含三级并列规则）
  let best;
  for (const st of rootTable.values()) {
    if (better(st, best)) best = st;
  }
  // 重建选中集合
  const selected = new Set();
  const reconstruct = (beam, table, k) => {
    const st = table.get(k);
    selected.add(beam);
    for (const [child, kc] of st.picks) {
      reconstruct(child, dp.get(child), kc);
    }
  };
  for (const [child, kc] of best.picks) reconstruct(child, dp.get(child), kc);
  return { selected, totalScore: best.score };
}
