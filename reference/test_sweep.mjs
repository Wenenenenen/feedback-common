// Node 校验：JS 核心与样例 truth.json 及 Python 参考实现对齐。
// 运行：node reference/test_sweep.mjs
import { readFileSync } from 'node:fs';
import { buildSweep, v3 } from '../app/js/sweep.js';

const dir = 'samples-extracted';
const load = (f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const truth = load('truth.json');
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
};

// ---- 计数对照 truth.json ----
const helix = buildSweep(load('helix.json'));
check('helix side verts = 320', helix.sideVerts.length === truth.helix_side_vertices,
  `got ${helix.sideVerts.length}`);
check('helix side tris = 624', helix.sideTris.length === truth.helix_side_triangles,
  `got ${helix.sideTris.length}`);
check('helix cap tris = 16', helix.capTris.length === 16);

const closed = buildSweep(load('closed.json'));
check('closed side verts = 248', closed.sideVerts.length === truth.closed_side_vertices);
check('closed side tris = 496', closed.sideTris.length === truth.closed_side_triangles);
check('closed has no caps', closed.capTris.length === 0);

const zero = buildSweep(load('zero-segment.json'));
check('zero-segment invalid', zero.valid === false);
check('zero-segment reports segment 0',
  zero.diagnostics.zeroSegments.length === 1 && zero.diagnostics.zeroSegments[0] === 0);

const nr = buildSweep(load('near-reverse.json'));
check('near-reverse valid', nr.valid === true);
check('near-reverse 180deg jump at ring 1',
  nr.diagnostics.frameJumps.length === 1 &&
  nr.diagnostics.frameJumps[0].at === 1 &&
  Math.abs(nr.diagnostics.frameJumps[0].angleDeg - 180) < 1e-9);
check('near-reverse detects 4 self-intersecting faces',
  nr.diagnostics.selfIntersectingFaces.length === 4,
  `got ${nr.diagnostics.selfIntersectingFaces.length}`);
check('helix has no self-intersection',
  helix.diagnostics.selfIntersectingFaces.length === 0);
check('closed has no self-intersection',
  closed.diagnostics.selfIntersectingFaces.length === 0);

// ---- 标架正交性 ----
for (const r of [helix, closed, nr]) {
  let ok = true;
  for (let i = 0; i < r.n; i++) {
    const { tangents: t, ringNormals: nn, ringBinormals: bb } = r;
    if (Math.abs(v3.dot(t[i], nn[i])) > 1e-9) ok = false;
    if (Math.abs(v3.dot(nn[i], bb[i])) > 1e-9) ok = false;
    if (Math.abs(v3.norm(v3.cross(nn[i], bb[i])) - 1) > 1e-9) ok = false;
  }
  check(`${r.n}-ring frames orthonormal`, ok);
}

// ---- 闭环接缝：补偿后末环跨过接缝与首环重合 ----
{
  const r = closed;
  const t0 = r.tangents[0];
  // 末环再做一次移动到 t0，并施加末段剩余补偿角
  const phi = -r.seamTwist - r.ringTwistAngles[r.n - 1];
  const nRet = transportPublic(r.ringNormals[r.n - 1], r.tangents[r.n - 1], t0);
  const bRet = v3.cross(t0, nRet);
  const c = Math.cos(phi), s = Math.sin(phi);
  const nx = v3.add(v3.scale(nRet, c), v3.scale(bRet, s));
  const err = Math.max(...nx.map((x, k) => Math.abs(x - r.ringNormals[0][k])));
  check('closed seam closure err < 1e-12', err < 1e-12, `err=${err}`);
}

// ---- 端盖朝向 ----
{
  const r = helix;
  const faceN = (tri) => {
    const [a, b, c] = tri;
    return v3.normalize(v3.cross(
      v3.sub(r.capVerts[b], r.capVerts[a]),
      v3.sub(r.capVerts[c], r.capVerts[a])));
  };
  const fn0 = faceN(r.capTris[0]);
  const fn1 = faceN(r.capTris[r.m]);
  check('start cap faces -t0',
    Math.abs(v3.dot(fn0, v3.normalize(v3.scale(r.tangents[0], -1))) - 1) < 1e-12);
  check('end cap faces +tN',
    Math.abs(v3.dot(fn1, r.tangents[r.n - 1]) - 1) < 1e-12);
  // 端盖法线数组朝向
  check('cap normal arrays oriented',
    v3.dot(r.capNormals[0], r.tangents[0]) < 0 &&
    v3.dot(r.capNormals[r.capNormals.length - 1], r.tangents[r.n - 1]) > 0);
}

// ---- 总扭转：开放路径末环相对零扭转恰为 theta ----
{
  const d = load('helix.json');
  const a = buildSweep({ ...d, twist: Math.PI });
  const b = buildSweep({ ...d, twist: 0 });
  const t = b.tangents[b.n - 1];
  const ang = Math.atan2(
    v3.dot(t, v3.cross(b.ringNormals[b.n - 1], a.ringNormals[a.n - 1])),
    v3.dot(a.ringNormals[a.n - 1], b.ringNormals[b.n - 1]));
  check('open twist pi reaches end ring', Math.abs(ang - Math.PI) < 1e-10, `ang=${ang}`);

  const cd = load('closed.json');
  check('closed non-2pi twist rejected', buildSweep({ ...cd, twist: 1 }).valid === false);
  check('closed 2pi twist accepted', buildSweep({ ...cd, twist: 2 * Math.PI }).valid === true);
}

// ---- 诊断模式：关闭补偿不改变拓扑 ----
{
  const cd = load('closed.json');
  const on = buildSweep({ ...cd, compensate: true });
  const off = buildSweep({ ...cd, compensate: false });
  check('compensation toggle keeps topology',
    on.sideTris.length === off.sideTris.length &&
    on.sideVerts.length === off.sideVerts.length &&
    JSON.stringify(on.sideTris) === JSON.stringify(off.sideTris));
  check('compensation off leaves seam twist visible',
    Math.abs(off.seamTwist - on.seamTwist) < 1e-15);
}

// 内部 transport 与 sweep.js 私有实现相同逻辑的公开副本（仅测试用）
function transportPublic(nPrev, tPrev, tNext) {
  const EPS_DOT = 1e-10;
  const d = v3.dot(tPrev, tNext);
  let x;
  if (d < -1 + EPS_DOT) x = v3.rotateAxis(nPrev, nPrev, Math.PI);
  else if (d > 1 - EPS_DOT) x = v3.sub(nPrev, v3.scale(tNext, v3.dot(nPrev, tNext)));
  else {
    const axis = v3.normalize(v3.cross(tPrev, tNext));
    x = v3.rotateAxis(nPrev, axis, Math.acos(Math.max(-1, Math.min(1, d))));
    x = v3.sub(x, v3.scale(tNext, v3.dot(x, tNext)));
  }
  return v3.normalize(x);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
