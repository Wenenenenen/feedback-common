// 自研几何测试台：参考面积对拍 + 输出网格强校验
// 运行: node --experimental-vm-modules 不需要；直接 node tests/run-tests.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tessellate, meshToJSON } from '../src/pipeline.js';
import { orient, ringArea2, pointInTriangleStrict, pointInTriangleClosed } from '../src/geometry.js';
import { Frac } from '../src/frac.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = join(root, 'samples', 'extracted');
const reference = JSON.parse(readFileSync(join(sampleDir, 'reference.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
};

function load(name) {
  return JSON.parse(readFileSync(join(sampleDir, name + '.json'), 'utf8'));
}

// 精确 SAT：两三角形内部是否相交（共享边/点不算）
function trianglesInteriorOverlap(t1, t2, V) {
  const A = t1.map((i) => V[i]), B = t2.map((i) => V[i]);
  const axes = [];
  for (const tri of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      axes.push({ nx: b.y.sub(a.y), ny: a.x.sub(b.x) }); // 边法向
    }
  }
  for (const ax of axes) {
    const proj = (p) => ax.nx.mul(p.x).add(ax.ny.mul(p.y));
    const pa = A.map(proj), pb = B.map(proj);
    const minA = pa.reduce((m, v) => (v.cmp(m) < 0 ? v : m));
    const maxA = pa.reduce((m, v) => (v.cmp(m) > 0 ? v : m));
    const minB = pb.reduce((m, v) => (v.cmp(m) < 0 ? v : m));
    const maxB = pb.reduce((m, v) => (v.cmp(m) > 0 ? v : m));
    // 内部相交要求每个轴上投影区间严格相交
    if (maxA.cmp(minB) <= 0 || maxB.cmp(minA) <= 0) return false;
  }
  return true;
}

function validateMesh(result, label) {
  const { compactVerts: V, triangles, arrangement } = result;
  // 1. 全部 CCW 且非退化
  for (const [k, t] of triangles.entries()) {
    const o = orient(V[t[0]], V[t[1]], V[t[2]]);
    ok(o > 0, `${label}: 三角形 ${k} 非严格 CCW（orient=${o}）`);
  }
  // 2. 两两内部不重叠（SAT，精确）
  for (let i = 0; i < triangles.length; i++) {
    for (let j = i + 1; j < triangles.length; j++) {
      ok(!trianglesInteriorOverlap(triangles[i], triangles[j], V),
        `${label}: 三角形 ${i} 与 ${j} 内部重叠`);
    }
  }
  // 3. 区域边界环面积（外环 − 孔环）== 输出三角形面积，二者都精确求和
  const AV = arrangement.verts; // 环 id 是 arrangement 顶点索引
  let ringArea2Sum = new Frac(0n);
  for (const r of result.regions) {
    for (const outer of r.outerRings) {
      ringArea2Sum = ringArea2Sum.add(ringArea2(outer.map((i) => AV[i])));
    }
    for (const inner of r.innerRings) {
      // 孔环为 CW（负面积），直接累加即扣除
      ringArea2Sum = ringArea2Sum.add(ringArea2(inner.map((i) => AV[i])));
    }
  }
  let triArea2 = new Frac(0n);
  for (const t of triangles) {
    triArea2 = triArea2.add(ringArea2([V[t[0]], V[t[1]], V[t[2]]]));
  }
  ok(ringArea2Sum.eq(triArea2),
    `${label}: 边界环面积 ${ringArea2Sum.toString()} 与三角形面积 ${triArea2.toString()} 不一致`);

  // 4. 孔洞不被盖住：每个填充区域 innerRings（CW 孔环）的重心必须落在所有三角形之外
  for (const r of result.regions) {
    for (const hole of r.innerRings) {
      // 反向回 CCW 以便重心在孔内
      const ccw = ringArea2(hole.map((i) => arrangement.verts[i])).sign() < 0
        ? hole.slice().reverse() : hole;
      const p = polygonCentroid(ccw, arrangement.verts);
      for (const t of triangles) {
        ok(!pointInTriangleStrict(t.map((i) => V[i]), p),
          `${label}: 区域 ${r.faceId} 的孔洞内点被三角形覆盖`);
      }
    }
  }
  // 5. 每个填充区域采样点必须被某个三角形覆盖
  for (const r of result.regions) {
    if (!r.sample || !r.triangles.length) continue;
    const hit = triangles.some((t) => pointInTriangleClosed(t.map((i) => V[i]), r.sample));
    ok(hit, `${label}: 面 ${r.faceId} 采样点未被任何三角形覆盖`);
  }
  // 6. 数值导出无 NaN/Infinity
  const js = meshToJSON(result);
  ok(Number.isFinite(js.area) && js.vertices.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1])),
    `${label}: 导出含非有限数值`);
  return js;
}

function polygonCentroid(ring, verts) {
  let sx = new Frac(0n), sy = new Frac(0n);
  for (const id of ring) { sx = sx.add(verts[id].x); sy = sy.add(verts[id].y); }
  const n = new Frac(BigInt(ring.length));
  return { x: sx.div(n), y: sy.div(n) };
}

function runCase(name, rule) {
  const data = load(name);
  const result = tessellate(data.contours, rule);
  const js = validateMesh(result, `${name}/${rule}`);
  const ref = reference[name]?.[rule];
  if (ref !== undefined) {
    ok(Math.abs(js.area - ref) < 1e-6,
      `${name}/${rule}: 面积 ${js.area} 与参考 ${ref} 不符`);
  }
  return { result, js };
}

// ---------- 全部样例 × 两种规则 ----------
const cases = readdirSync(sampleDir).filter((f) => f.endsWith('.json') && f !== 'reference.json');
for (const file of cases) {
  const name = file.replace('.json', '');
  if (name === 'invalid-coordinate') continue;
  for (const rule of ['evenodd', 'nonzero']) runCase(name, rule);
}

// ---------- 非法坐标必须报错 ----------
try {
  tessellate(load('invalid-coordinate').contours, 'nonzero');
  ok(false, 'invalid-coordinate: 应当拒绝非整数坐标');
} catch (e) {
  ok(/非整数/.test(e.message), 'invalid-coordinate: 报错信息应指明非整数: ' + e.message);
}

// ---------- 顺序/方向无关性 ----------
function mutate(contours, mode) {
  const cs = contours.map((r) => r.map((p) => p.slice()));
  if (mode === 'shuffle') {
    for (let i = cs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cs[i], cs[j]] = [cs[j], cs[i]];
    }
  } else if (mode === 'reverse') {
    for (const r of cs) r.reverse();
  } else if (mode === 'dupPoints') {
    for (const r of cs) {
      r.push(r[0].slice());            // 末点重复首点
      r.splice(1, 0, r[0].slice());    // 连续重复点
    }
  }
  return cs;
}
for (const name of ['same-hole', 'overlap', 'bowtie', 'duplicate', 'collinear-touch']) {
  const data = load(name);
  for (const rule of ['evenodd', 'nonzero']) {
    const base = tessellate(data.contours, rule);
    for (const mode of ['shuffle', 'reverse', 'dupPoints']) {
      const mut = tessellate(mutate(data.contours, mode), rule);
      ok(Math.abs(mut.area.toNumber() - base.area.toNumber()) < 1e-9,
        `${name}/${rule}/${mode}: 面积随输入变化`);
      ok(mut.triangles.length === base.triangles.length || mut.area.eq(base.area),
        `${name}/${rule}/${mode}: 网格不稳定`);
      validateMesh(mut, `${name}/${rule}/${mode}`);
    }
  }
}

// ---------- 相切/共线专项：绕数与贡献 ----------
{
  const ct = load('collinear-touch');
  const r = tessellate(ct.contours, 'evenodd');
  ok(Math.abs(meshToJSON(r).area - 84) < 1e-6, 'collinear-touch 面积应为 84');
  const dup = tessellate(load('duplicate').contours, 'evenodd');
  ok(meshToJSON(dup).triangles.length === 0, 'duplicate/evenodd 必须为空网格');
  const dupNZ = tessellate(load('duplicate').contours, 'nonzero');
  ok(Math.abs(meshToJSON(dupNZ).area - 64) < 1e-6, 'duplicate/nonzero 面积应为 64');
}

// ---------- 相反方向重复边：贡献抵消但不去重 ----------
{
  const c = [
    [[0, 0], [8, 0], [8, 8], [0, 8]],
    [[0, 0], [0, 8], [8, 8], [8, 0]], // 同环反向
  ];
  const eo = tessellate(c, 'evenodd');
  ok(meshToJSON(eo).triangles.length === 0, '反向重复边 evenodd 应无填充');
  const nz = tessellate(c, 'nonzero');
  ok(meshToJSON(nz).triangles.length === 0, '反向重复边 nonzero 应抵消为 0');
}

// ---------- 区域绕数与参考手工值（绕数分区在 arrangement 拓扑面层面）----------
{
  const ov = tessellate(load('overlap').contours, 'nonzero');
  const windings = [...new Set(ov.arrangement.topoWindNZ)].filter((w) => w !== 0).sort((a, b) => a - b);
  ok(JSON.stringify(windings) === JSON.stringify([1, 2]),
    'overlap/nonzero 拓扑面应出现绕数 1 与 2，实际: ' + JSON.stringify(windings));
  const sh = tessellate(load('same-hole').contours, 'nonzero');
  ok(sh.regions.every((r) => r.winding === 1), 'same-hole/nonzero 填充区绕数应全为 1');
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败'}：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
