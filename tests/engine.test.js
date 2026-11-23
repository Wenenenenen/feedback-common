// tests/engine.test.js — 核心几何/混合规则正确性（node tests/engine.test.js）
const assert = require('assert');
const E = require('../src/engine.js');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// ---------- 1. 样例八面体 ----------
const sample = require('./fixtures/sample-layout.json');

ok('样例：构建场景，8 个三角面（共面合并后）', () => {
  const s = E.buildScene(sample);
  assert.strictEqual(s.n, 6);
  assert.strictEqual(s.faces.length, 8);
  // 每个面顶点互异且全部 20 条棱被覆盖两次
  const edges = new Map();
  for (const f of s.faces) {
    const v = f.vSorted;
    assert.strictEqual(new Set(v).size, 3);
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? a + '_' + b : b + '_' + a;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  assert.strictEqual(edges.size, 12);
  assert.ok([...edges.values()].every((c) => c === 2));
});

ok('样例：frame=0 方向 (2,0,1) 落在 id {1,3,5} 正锥，单位能量', () => {
  const s = E.buildScene(sample);
  const g = new Float64Array(6);
  const r = E.frameGains(s, 0, g, -1);
  assert.deepStrictEqual(r.face.key, [1, 3, 5]);
  const expect = [2, 0, 1].map((x) => x / Math.hypot(2, 0, 1));
  assert.ok(Math.abs(g[0] - expect[0]) < 1e-12);
  assert.ok(Math.abs(g[2] - expect[1]) < 1e-12);
  assert.ok(Math.abs(g[4] - expect[2]) < 1e-12);
  assert.ok(Math.abs(g[1]) < 1e-12 && Math.abs(g[3]) < 1e-12);
  const e2 = g.reduce((a, b) => a + b * b, 0);
  assert.ok(Math.abs(e2 - 1) < 1e-15);
});

ok('样例：插值不预归一，系数与 |d| 无关（frame 12000 中点）', () => {
  const s = E.buildScene(sample);
  const g1 = new Float64Array(6);
  E.frameGains(s, 12000, g1, -1);
  // 方向 = (2,0,1)+0.5*((1,2,1)-(2,0,1)) = (1.5, 1, 1)
  const r = E.frameDirection(s, 12000);
  assert.deepStrictEqual(r.d, [1.5, 1, 1]);
  const e2 = g1.reduce((a, b) => a + b * b, 0);
  assert.ok(Math.abs(e2 - 1) < 1e-15);
  // 方向 (3,2,2) 与 (1.5,1,1) 同向 → 归一化增益相同
  const g2 = new Float64Array(6);
  const { frameGains } = E;
  // 直接构造同方向放大两倍的帧不可得（轨迹固定），改用面片求解验证
  const f = s.faces.find((fc) => fc.key.join() === [1, 3, 5].join());
  const c1 = E.solveFace(f, [1.5, 1, 1]);
  const c2 = E.solveFace(f, [3, 2, 2]);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(c1[i] * 2 - c2[i]) < 1e-10);
});

ok('样例：computeAll 无零帧、无 fallback，末帧 frame=47999', () => {
  const s = E.buildScene(sample);
  const res = E.computeAll(s, 48000);
  assert.strictEqual(res.zeroFrames.length, 0);
  assert.strictEqual(res.fallbackFrames.length, 0);
  assert.strictEqual(res.nFrames, 48000);
});

// ---------- 2. 立方体（共面四边形 -> 扇形，锚点为面内最小 id）----------
function cubeLayout() {
  const sp = [];
  let id = 1;
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    sp.push({ id: id++, xyz: [x, y, z] });
  }
  return {
    speakers: sp,
    path: [
      { frame: 0, xyz: [1, 1, 1] },
      { frame: 100, xyz: [-1, -1, -1] },
    ],
  };
}

ok('立方体：凸包 6 面 × 2 三角 = 12 片，扇形锚点均为面内最小 id', () => {
  const s = E.buildScene(cubeLayout());
  assert.strictEqual(s.faces.length, 12);
  for (const f of s.faces) {
    const minId = Math.min(...f.v.map((vi) => s.ids[vi]));
    assert.strictEqual(s.ids[f.v[0]], minId, '扇形首顶点应为最小 id');
  }
});

ok('立方体：所有面片朝外且严格包含原点', () => {
  const s = E.buildScene(cubeLayout());
  for (const f of s.faces) {
    const n = f.planeN;
    const d = f.planeD;
    assert.ok(d > 0, '原点应在所有面内侧');
    // 面外一点应在正面侧
    const outer = [n[0] * 2, n[1] * 2, n[2] * 2];
    assert.ok(E.dot(n, outer) - d > 0);
  }
});

// ---------- 3. tie-break：射线沿棱，多个正锥候选取字典序最小三元组 ----------
ok('tie-break：方向沿 +x 轴（棱方向），取 id 三元组字典序最小候选', () => {
  const s = E.buildScene(sample);
  const g = new Float64Array(6);
  const r = solveAt(s, [1, 0, 0], g);
  // 八面体 +x 方向相邻 4 个面：{1,3,5},{1,3,6},{1,4,5},{1,4,6} → 最小 {1,3,5}
  assert.deepStrictEqual(r.face.key, [1, 3, 5]);
  assert.ok(Math.abs(g[0] - 1) < 1e-12);
  const rest = [...g].slice(1).reduce((a, b) => a + b * b, 0);
  assert.ok(rest < 1e-24);
});

function solveAt(scene, d, g) {
  // 借用 frameGains：构造单帧轨迹
  const saved = scene.path;
  scene.path = [{ frame: 0, xyz: d }, { frame: 1, xyz: d }];
  const r = E.frameGains(scene, 0, g, -1);
  scene.path = saved;
  return r;
}

ok('tie-break：重排扬声器输入顺序不改变字典序结果', () => {
  const reordered = JSON.parse(JSON.stringify(sample));
  reordered.speakers = reordered.speakers.slice().reverse(); // id 6..1
  const s1 = E.buildScene(sample);
  const s2 = E.buildScene(reordered);
  const g1 = new Float64Array(6), g2 = new Float64Array(6);
  solveAt(s1, [1, 0, 0], g1);
  solveAt(s2, [1, 0, 0], g2);
  // 按 id 对齐比较
  const map2 = new Map(s2.ids.map((id, i) => [id, g2[i]]));
  s1.ids.forEach((id, i) => assert.ok(Math.abs(g1[i] - map2.get(id)) < 1e-12));
});

// ---------- 4. 零向量：指出位置并保留上次结果 ----------
ok('零方向：关键点为零时标记 zero 且保留上帧增益', () => {
  const layout = {
    speakers: sample.speakers,
    path: [
      { frame: 0, xyz: [2, 0, 1] },
      { frame: 10, xyz: [0, 0, 0] },
      { frame: 20, xyz: [1, 2, 1] },
    ],
  };
  const s = E.buildScene(layout);
  const g = new Float64Array(6);
  const r0 = E.frameGains(s, 0, g, -1);
  assert.ok(!r0.zero);
  const snapshot = Float64Array.from(g);
  const r1 = E.frameGains(s, 10, g, r0.faceIndex);
  assert.ok(r1.zero);
  assert.deepStrictEqual(Array.from(g), Array.from(snapshot));
  // 插值经过零：段 (2,0,1)->(-2,0,-1) 在 frame 5 处为零（整数精确）
  const layout2 = {
    speakers: sample.speakers,
    path: [
      { frame: 0, xyz: [2, 0, 1] },
      { frame: 10, xyz: [-2, 0, -1] },
      { frame: 20, xyz: [1, 2, 1] },
    ],
  };
  const s2 = E.buildScene(layout2);
  const rMid = E.frameDirection(s2, 5);
  assert.ok(rMid.isZero);
  const rNon = E.frameDirection(s2, 4);
  assert.ok(!rNon.isZero);
});

// ---------- 5. 凸包不包含原点 ----------
ok('原点在凸包外：共球但全部偏在一侧 → ORIGIN_NOT_INSIDE', () => {
  // 半径 √6 的四个非共面点，全部 x>0，原点在凸包外
  const layout = {
    speakers: [
      { id: 1, xyz: [2, 1, 1] }, { id: 2, xyz: [2, 1, -1] },
      { id: 3, xyz: [2, -1, 1] }, { id: 4, xyz: [1, 2, 1] },
    ],
    path: [{ frame: 0, xyz: [1, 1, 1] }, { frame: 9, xyz: [2, 0, 0] }],
  };
  assert.throws(() => E.buildScene(layout), (e) => e.code === 'ORIGIN_NOT_INSIDE');
});

ok('共面扬声器：同一平面 z=2、半径 3 的圆上四点 → NOT_ENCLOSING', () => {
  const layout = {
    speakers: [
      { id: 1, xyz: [2, 1, 2] }, { id: 2, xyz: [1, 2, 2] },
      { id: 3, xyz: [-2, 1, 2] }, { id: 4, xyz: [-1, -2, 2] },
    ],
    path: [{ frame: 0, xyz: [1, 1, 1] }, { frame: 9, xyz: [-1, 1, 1] }],
  };
  // 四点均满足 x²+y²=5、z=2 → 半径 3，且全部位于 z=2 平面 → 凸包维度 2
  assert.throws(() => E.buildScene(layout), (e) => e.code === 'NOT_ENCLOSING');
});

ok('非共球 / id 重复 / frame 非递增：抛出对应错误', () => {
  assert.throws(() => E.buildScene({
    speakers: [
      { id: 1, xyz: [2, 0, 0] }, { id: 2, xyz: [-1, 0, 0] },
      { id: 3, xyz: [0, 1, 0] }, { id: 4, xyz: [0, -1, 0] },
      { id: 5, xyz: [0, 0, 1] }, { id: 6, xyz: [0, 0, -1] }],
    path: sample.path,
  }), (e) => e.code === 'NOT_SPHERICAL');
  assert.throws(() => E.buildScene({
    speakers: sample.speakers.map((s) => ({ ...s })).concat([{ id: 1, xyz: [0, 0, 2] }]),
    path: sample.path,
  }), /重复/);
  assert.throws(() => E.buildScene({
    speakers: sample.speakers,
    path: [{ frame: 1, xyz: [1, 0, 0] }, { frame: 2, xyz: [0, 1, 0] }],
  }), /首点/);
});

// ---------- 6. 棱上方向能量守恒与连续性（跨组不跳变）----------
ok('沿轨迹逐帧增益连续：相邻帧增益差有界且每帧单位能量', () => {
  const s = E.buildScene(sample);
  const g = new Float64Array(6);
  let last = -1, prev = null;
  let maxJump = 0;
  for (let f = 0; f < 48000; f += 137) {
    const r = E.frameGains(s, f, g, last);
    if (!r.zero && !r.fallback) last = r.faceIndex;
    const e2 = g.reduce((a, b) => a + b * b, 0);
    assert.ok(Math.abs(e2 - 1) < 1e-12);
    if (prev) {
      let j = 0;
      for (let i = 0; i < 6; i++) j = Math.max(j, Math.abs(g[i] - prev[i]));
      maxJump = Math.max(maxJump, j);
    }
    prev = Float64Array.from(g);
  }
  assert.ok(maxJump < 0.05, '跨面跳变应被共享棱吸收，实际最大 ' + maxJump);
});

console.log('\n' + passed + ' 项通过');
