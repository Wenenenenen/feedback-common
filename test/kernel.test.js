/* 几何内核测试（Node 运行：node test/kernel.test.js） */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'js', 'geom', 'exact.js'));
const X = require(path.join(__dirname, '..', 'js', 'geom', 'intersect.js'));
const C = require(path.join(__dirname, '..', 'js', 'geom', 'cage.js'));
const F = require(path.join(__dirname, '..', 'js', 'geom', 'fragmenter.js'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function vapprox(a, b, eps = 1e-9) {
  return a.length === b.length && a.every((x, i) => approx(x, b[i], eps));
}

/* ---------- 1. 精确 orient3d 与浮点参考一致 ---------- */
function orientFloat(a, b, c, d) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  // 标准 orient3d = det[b-a, c-a, d-a] = u · (v × w)
  const cx = [v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0]];
  return u[0] * cx[0] + u[1] * cx[1] + u[2] * cx[2];
}
{
  const cases = [
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[12, -3, 7], [4, 9, 1], [-8, 2, 11], [5, 5, 5]],
    [[1000000, -1000000, 0], [0, 1000000, -999999], [-1000000, 1, 1000000], [1, 2, 3]],
  ];
  for (const t of cases) {
    const hp = t.map(q => E.i3(E.bi(q[0]), E.bi(q[1]), E.bi(q[2])));
    const exact = E.signBi(E.orient3d(...hp));
    const ref = Math.sign(orientFloat(...t));
    ok(exact === ref, `orient3d 符号一致: ${JSON.stringify(t)} got ${exact} ref ${ref}`);
  }
  // 共面
  const cop = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 3, 0]].map(q => E.i3(E.bi(q[0]), E.bi(q[1]), E.bi(q[2])));
  ok(E.orient3d(...cop) === 0n, '共面四点 orient3d 严格为 0');
}

/* ---------- 2. 单元相交裁决 ---------- */
function hp(t) { return t.map(q => E.i3(E.bi(q[0]), E.bi(q[1]), E.bi(q[2]))); }
{
  // 共面相邻（共享面，合法）
  const t1 = hp([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]]);
  const t2 = hp([[2, 0, 0], [0, 2, 0], [2, 2, 0], [0, 0, 2]]);
  ok(X.tetPairLegal(t1, t2).ok, '共享面的两个单元合法');

  // 共边相邻（合法）
  const t3 = hp([[0, 0, 0], [2, 0, 0], [0, 0, 2], [0, -2, 0]]);
  ok(X.tetPairLegal(t1, t3).ok, '共享边的两个单元合法');

  // 共点相邻（合法）
  const t4 = hp([[0, 0, 0], [-2, 0, 0], [0, -2, 0], [0, 0, -2]]);
  ok(X.tetPairLegal(t1, t4).ok, '仅共享顶点的两个单元合法');

  // 一个顶点刺入另一个单元内部（非法），整数坐标
  const t5 = hp([[0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4]]);
  const t6 = hp([[1, 1, 1], [8, 0, 0], [0, 8, 0], [0, 0, 8]]);
  ok(!X.tetPairLegal(t5, t6).ok, '顶点刺入对方内部必须判非法');

  // 重叠（共 4 顶点）
  const t7 = hp([[0, 0, 0], [4, 0, 0], [0, 0, 4], [0, 4, 0]]);
  ok(!X.tetPairLegal(t5, t7).ok, '同四点不同绕向视为重复单元非法');

  // 无共享顶点但相离（合法）
  const t8 = hp([[10, 10, 10], [12, 10, 10], [10, 12, 10], [10, 10, 12]]);
  ok(X.tetPairLegal(t1, t8).ok, '相离单元合法');

  // 无共享顶点但穿插（非法）：t1 内部点附近放一个跨过去的小 tet
  const t9 = hp([[-1, -1, 1], [3, 3, -1], [3, -1, 1], [-1, 3, 1]]);
  ok(!X.tetPairLegal(t1, t9).ok, '无共享顶点的体积穿插必须判非法');
}

/* ---------- 3. 体积符号 ---------- */
{
  const pts = [[0, 0, 0], [12, 0, 0], [0, 12, 0], [0, 0, 12]];
  const cell = [0, 1, 2, 3];
  ok(E.signBi(C.signedVolume6(pts, cell)) > 0, '正绕向单元体积为正');
  ok(E.signBi(C.signedVolume6(pts, [0, 2, 1, 3])) < 0, '翻转绕向体积为负');
}

/* ---------- 4. 样本：单 tet 裁分 ---------- */
function loadSample() {
  return JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'samples', 'tetra-cage.json'), 'utf8'));
}
{
  const data = loadSample();
  const vRest = C.validateCage(data.rest, data.cells);
  const vPose = C.validateCage(data.pose, data.cells);
  ok(vRest.badCells.length === 0 && vPose.badCells.length === 0, '样本 rest/pose 笼均合法');
  ok(C.volumeSignMismatch(vRest.volSign, vPose.volSign).length === 0, '样本体积符号一致');

  const tr = C.cellTransforms(data.rest, data.pose, data.cells);
  const r = F.fragmentModel(data, tr);
  ok(r.badFaces.length === 0, '样本原面不应越界');
  ok(r.fragments.length === 1, `样本应只产生 1 块碎片，实际 ${r.fragments.length}`);
  const fr = r.fragments[0];
  ok(fr.cellId === 0 && fr.faceId === 0, '碎片归属单元 0、原面 0');
  ok(fr.vertIds.length === 3, '未跨单元时碎片保持三角形');
  // 变形位置：顶点 3 从 (0,0,12) 移到 (2,0,16)，检查仿射
  // 取原三角形顶点 (1,1,1)
  const gv = r.globalVerts.find(g => vapprox(g.rest, [1, 1, 1]));
  ok(!!gv, '能找到原顶点 (1,1,1) 的全局顶点');
  // 手工仿射：F 满足 F*[12,0,0]=[12,0,0], F*[0,12,0]=[0,12,0], F*[0,0,12]=[2,0,16]
  // F = [[1,0,1/6],[0,1,0],[0,0,4/3]]
  const expect = [1 + 1 / 6, 1, 4 / 3];
  ok(vapprox(r.deformed[gv.id], expect, 1e-10), `变形位置正确，got ${r.deformed[gv.id]}`);

  // 法线逆转置：原法线 (0,0,1)。F^-1=[[1,0,-1/8],[0,1,0],[0,0,3/4]]，
  // n' = F^-T·(0,0,1) = F^-1 的第 3 列 = (0,0,3/4)，归一化后仍为 (0,0,1)
  const nnRaw = C.applyNormal(tr[0], [0, 0, 1]);
  ok(vapprox(nnRaw, [0, 0, 0.75], 1e-12), `逆转置原始结果 (0,0,0.75)，got ${nnRaw}`);
  const nn = C.normalize3(nnRaw);
  ok(vapprox(nn, [0, 0, 1], 1e-12), '法线归一化正确');
  // 非平凡方向：F^-T·(1,0,2) = (1, 0, -0.125+1.5) = (1,0,1.375)
  const tilted = C.normalize3(C.applyNormal(tr[0], [1, 0, 2]));
  const expTilt = (() => { const v = [1, 0, 1.375]; const l = Math.hypot(...v); return v.map(x => x / l); })();
  ok(vapprox(tilted, expTilt, 1e-12), '倾斜法线逆转置变换正确');
}

/* ---------- 5. 跨公共面裁分与最小单元归属 ---------- */
{
  // 两个单元共享三角面 (1,2,3)：cell0 含顶点 0，cell1 含顶点 4
  const rest = [
    [0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4],
    [4, 4, 4],
  ];
  const cells = [[0, 1, 2, 3], [1, 4, 2, 3]];
  const vc = C.validateCage(rest, cells);
  ok(vc.badCells.length === 0, `两单元笼合法（${[...vc.reasons.values()].join(';')}）`);

  // 一个横跨共享面的三角形：顶点 (1,1,1) 在 cell0 内，另两点在 cell1 内
  const data = {
    rest, cells,
    faces: [{
      p: [[1, 1, 1], [2, 2, 1], [2, 2, 2]],
      n: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
    }],
  };
  const tr = C.cellTransforms(rest, rest, cells);
  const r = F.fragmentModel(data, tr);
  ok(r.badFaces.length === 0, '跨面三角形不越界: ' + r.faceErrors.map(e => e.error).join(';'));
  ok(r.fragments.length === 2, `应切成 2 块，实际 ${r.fragments.length}`);
  const owners = r.fragments.map(f => f.cellId).sort((a, b) => a - b);
  ok(owners[0] === 0 && owners[1] === 1, `两块分别归 cell0/cell1，got ${owners}`);
  // 面积守恒：e1=(1,1,0), e2=(1,1,1) → |e1×e2|=|(1,-1,0)|=√2，参数三角形面积 1/2 → 真实 √2/2
  const expectArea = Math.SQRT2 / 2;
  const sum = r.fragments.reduce((s, f) => s + f.polyArea, 0);
  ok(approx(sum, expectArea, 1e-9), `碎片面积之和等于原面积 ${expectArea}，got ${sum}`);
  // 落在公共面上的三角形：取公共面 (1,2,3) 内的小三角形，应只归最小编号单元 0
  const data2 = {
    rest, cells,
    faces: [{
      p: [[2, 1, 0], [1, 2, 0], [1, 1, 1]],
      n: [[1, 0, 0], [1, 0, 0], [1, 0, 0]],
    }],
  };
  const r2 = F.fragmentModel(data2, tr);
  ok(r2.badFaces.length === 0 && r2.fragments.length === 1, '贴公共面三角形产生一块碎片');
  ok(r2.fragments[0].cellId === 0, '公共面上的碎片归编号最小单元 0');
}

/* ---------- 6. 越界原面被拒绝并标记 ---------- */
{
  const data = loadSample();
  const bad = JSON.parse(JSON.stringify(data));
  bad.faces = [{ p: [[9, 9, 9], [10, 9, 9], [9, 10, 9]], n: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] }];
  const tr = C.cellTransforms(data.rest, data.pose, data.cells);
  const r = F.fragmentModel(bad, tr);
  ok(r.badFaces.length === 1 && r.badFaces[0] === 0, '越界面被标记');
  ok(r.fragments.length === 0, '越界面不产出碎片');
}

/* ---------- 7. 退化输入拒绝 ---------- */
{
  const data = loadSample();
  const tr = C.cellTransforms(data.rest, data.pose, data.cells);
  const collinear = JSON.parse(JSON.stringify(data));
  collinear.faces = [{ p: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], n: [[0, 1, 0], [0, 1, 0], [0, 1, 0]] }];
  const r1 = F.fragmentModel(collinear, tr);
  ok(r1.badFaces.length === 1, '共线原面被拒绝');
  const zeroN = JSON.parse(JSON.stringify(data));
  zeroN.faces = [{ p: [[1, 1, 1], [6, 1, 1], [1, 6, 1]], n: [[0, 0, 0], [0, 0, 1], [0, 0, 1]] }];
  const r2 = F.fragmentModel(zeroN, tr);
  ok(r2.badFaces.length === 1, '零法线角被拒绝');
}

/* ---------- 8. 非法姿态：体积翻号 ---------- */
{
  const data = loadSample();
  const flipped = JSON.parse(JSON.stringify(data));
  flipped.pose = [[0, 0, 0], [0, 12, 0], [12, 0, 0], [0, 0, 12]]; // 交换 1、2 → 体积翻号
  const vr = C.validateCage(data.rest, data.cells);
  const vp = C.validateCage(flipped.pose, data.cells);
  ok(C.volumeSignMismatch(vr.volSign, vp.volSign).length === 1, '体积翻号被识别');
}

/* ---------- 9. 覆盖完整性：多单元网格中的大三角形 ---------- */
{
  // 2x1x1 长方体切成 2 个 tet（共享对角线面），三角形横跨两格
  const rest = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [0, 0, 4], [4, 0, 4], [4, 4, 4], [0, 4, 4]];
  const cells = [[0, 1, 2, 5], [0, 2, 3, 5]]; // 共享面 (0,2,5)
  // 第二个 tet 顶点 3 需要在合法侧 —— 先直接看校验结果
  const vc = C.validateCage(rest, cells);
  if (vc.badCells.length !== 0) {
    fail++;
    console.error('  ✗ 测试网格本身非法: ' + [...vc.reasons.values()].join(';'));
  } else {
    const data = {
      rest, cells,
      faces: [{
        p: [[0, 0, 1], [4, 0, 1], [0, 4, 1]],
        n: [[0, -1, 0], [0, -1, 0], [0, -1, 0]],
      }],
    };
    const tr = C.cellTransforms(rest, rest, cells);
    const r = F.fragmentModel(data, tr);
    ok(r.badFaces.length === 0, '网格内大三角形不越界');
    const sum = r.fragments.reduce((s, f) => s + f.polyArea, 0);
    ok(approx(sum, 8, 1e-9), `面积守恒（原面积 8）got ${sum}`);
  }
}

/* ---------- 10. 非平凡变形下共享边无缝 + 面积守恒 ---------- */
{
  const rest = [[0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4], [4, 4, 4]];
  const cells = [[0, 1, 2, 3], [1, 4, 2, 3]];
  const pose = [[0, 0, 0], [5, 0, 0], [0, 5, 0], [0, 0, 5], [6, 6, 6]]; // 两单元不同仿射
  const data = {
    rest, pose, cells,
    faces: [{ p: [[1, 1, 1], [2, 2, 1], [2, 2, 2]], n: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] }],
  };
  const tr = C.cellTransforms(rest, pose, cells);
  const r = F.fragmentModel(data, tr);
  // 同一 rest 点的所有变形位置必须逐分量一致（共享边无裂缝）
  const byRest = new Map();
  r.globalVerts.forEach((gv, id) => {
    const k = gv.rest.map(x => x.toFixed(9)).join(',');
    const dep = r.deformed[id].map(x => x.toFixed(9)).join(',');
    if (!byRest.has(k)) byRest.set(k, new Set());
    byRest.get(k).add(dep);
  });
  let seams = 0;
  for (const v of byRest.values()) if (v.size > 1) seams++;
  ok(seams === 0, '非平凡变形下共享顶点位置一致（无缝）');
  // rest 面积守恒
  const sum = r.fragments.reduce((s, f) => s + f.polyArea, 0);
  const e1 = [1, 1, 0], e2 = [1, 1, 1];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  ok(approx(sum, 0.5 * Math.hypot(...cr), 1e-9), '碎片 rest 面积之和等于原三角形面积');
  // 变形法线有限非零
  const allNormalOK = r.fragments.every(f => f.cornerNormals.every(n => n.every(Number.isFinite) && Math.hypot(...n) > 0));
  ok(allNormalOK, '所有插值法线有限非零');
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
