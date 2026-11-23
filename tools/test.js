// 正确性测试：暴力参考实现 vs 引擎；含样例、手工用例、随机模糊、校验测试
// 用法：node tools/test.js
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('../src/engine.js');

let failures = 0;
let checks = 0;

function assert(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error('  ✗ ' + msg);
  }
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// 暴力参考实现
// ---------------------------------------------------------------------------

function bruteGrid(project, version) {
  const { rows, edits } = project;
  const h = rows.length;
  const w = rows[0].length;
  const g = rows.map((r) => r.split(''));
  const chain = [];
  let v = version;
  while (v > 0) { chain.push(v - 1); v = edits[v - 1].parent; }
  for (let k = chain.length - 1; k >= 0; k--) {
    const e = edits[chain[k]];
    g[e.y][e.x] = e.value;
  }
  return { g, w, h };
}

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const D8 = D4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

function bruteQuery(project, version, x, y) {
  const { g, w, h } = bruteGrid(project, version);
  const target = g[y][x];
  const isEmpty = target === '.';
  const dirs = isEmpty ? D8 : D4;
  const seen = Array.from({ length: h }, () => new Array(w).fill(false));
  const stack = [[x, y]];
  seen[y][x] = true;
  let area = 0;
  let perimeter = 0;
  let touchesBoundary = false;
  const owners = new Set();
  while (stack.length) {
    const [cx, cy] = stack.pop();
    area++;
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesBoundary = true;
    for (const [dx, dy] of D4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
        perimeter++;
      } else if (g[ny][nx] !== target) {
        perimeter++;
        if (isEmpty && g[ny][nx] !== '.') owners.add(g[ny][nx]);
      }
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (seen[ny][nx] || g[ny][nx] !== target) continue;
      seen[ny][nx] = true;
      stack.push([nx, ny]);
    }
  }
  if (isEmpty) {
    return {
      type: 'empty', version, x, y, area,
      enclave: !touchesBoundary,
      owner: owners.size === 1 ? [...owners][0] : null,
    };
  }
  return { type: 'territory', version, x, y, faction: target, area, perimeter };
}

function runBrute(project) {
  return project.queries.map((q) => bruteQuery(project, q.version, q.x, q.y));
}

// ---------------------------------------------------------------------------
// 1. 样例文件
// ---------------------------------------------------------------------------

console.log('== 样例文件 ==');
{
  const raw = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frontier-versions.json'), 'utf8');
  const input = JSON.parse(raw);
  const v = engine.validateProject(input);
  assert(v.ok, '样例应通过校验: ' + (v.ok ? '' : v.errors.join('; ')));
  const got = engine.runBatch(v.project);
  const want = runBrute(v.project);
  assert(deepEq(got, want), `样例结果应与暴力一致\n  got=${JSON.stringify(got)}\n want=${JSON.stringify(want)}`);
  // 手工核对：版本0 空地 (1,1) 八邻整块为中间两个点 (1,1)(2,1)，都不贴外边 → 飞地；
  // 该块四邻同时接触 A（上方/左方）与 B（(1,2)）→ 无主
  const q0 = got[0];
  assert(q0.type === 'empty' && q0.area === 2 && q0.enclave === true && q0.owner === null,
    '样例查询0：面积2、飞地、同时邻接 A/B 故无主，实际 ' + JSON.stringify(q0));
  // 版本1：(1,0) 改空地后，(1,1) 与 (1,0) 八邻相连 → 面积3，且 (1,0) 贴外边 → 非飞地
  const q1 = got[1];
  assert(q1.type === 'empty' && q1.area === 3 && q1.enclave === false && q1.owner === null,
    '样例查询1：面积3、非飞地、无主，实际 ' + JSON.stringify(q1));
}

// ---------------------------------------------------------------------------
// 2. 手工用例
// ---------------------------------------------------------------------------

console.log('== 手工用例 ==');

// 2.1 周长：单格阵营在角落=4，边中=4，内部=4（单格四面都是边界/异色）
{
  const proj = {
    rows: ['...', '.A.', '...'],
    edits: [],
    queries: [{ version: 0, x: 1, y: 1 }],
  };
  const v = engine.validateProject(proj);
  assert(v.ok, '2.1 校验通过');
  const got = engine.runBatch(v.project)[0];
  assert(got.area === 1 && got.perimeter === 4, '2.1 内部孤立格周长4，实际 ' + JSON.stringify(got));
}

// 2.2 两格横条在顶边：面积2，周长 6（上2外+下2异色+左右各1）
{
  const proj = {
    rows: ['AA.', '...'],
    edits: [],
    queries: [{ version: 0, x: 0, y: 0 }, { version: 0, x: 1, y: 0 }],
  };
  const v = engine.validateProject(proj);
  const r = engine.runBatch(v.project);
  assert(r[0].area === 2 && r[0].perimeter === 6, '2.2 顶边横条周长6，实际 ' + JSON.stringify(r[0]));
  assert(r[1].area === 2 && r[1].perimeter === 6, '2.2 同分量一致');
}

// 2.3 飞地判定：3x3 全 A，中心空地 → 飞地；角落空地 → 非飞地
{
  const proj = {
    rows: ['AAA', 'A.A', 'AAA'],
    edits: [
      { parent: 0, x: 0, y: 0, value: '.' }, // v1：角落空地，非飞地
    ],
    queries: [
      { version: 0, x: 1, y: 1 },
      { version: 1, x: 0, y: 0 },
    ],
  };
  const v = engine.validateProject(proj);
  const r = engine.runBatch(v.project);
  assert(r[0].type === 'empty' && r[0].area === 1 && r[0].enclave === true && r[0].owner === 'A',
    '2.3 中心空地是飞地且归 A：' + JSON.stringify(r[0]));
  assert(r[1].enclave === false, '2.3 角落空地非飞地：' + JSON.stringify(r[1]));
}

// 2.4 归属：空地共边两个阵营 → null；只有对角接触不算共边
{
  const proj = {
    rows: ['A.B', '...', 'A.B'],
    edits: [],
    queries: [
      { version: 0, x: 1, y: 1 }, // 四邻都是空地 → 无主
      { version: 0, x: 0, y: 1 }, // 上 A 下 A → A
      { version: 0, x: 2, y: 1 }, // 上 B 下 B → B
      { version: 0, x: 1, y: 0 }, // 左 A 右 B，共边两阵营 → null
    ],
  };
  const v = engine.validateProject(proj);
  const r = engine.runBatch(v.project);
  // 5 个空地八邻相连为同一分量；整块共边同时接触 A、B → 无主；含贴边格 → 非飞地
  for (const q of r) {
    assert(q.type === 'empty' && q.owner === null && q.area === 5 && q.enclave === false,
      '2.4 整块接触 A/B 两阵营 → 无主：' + JSON.stringify(q));
  }
}

// 2.5 对角连接：空地只在对角相接 → 八邻同块；阵营对角不相连
{
  const proj = {
    rows: ['A.', '.A'],
    edits: [],
    queries: [
      { version: 0, x: 0, y: 0 }, // A 单格
      { version: 0, x: 1, y: 1 }, // A 单格（对角不连）
      { version: 0, x: 1, y: 0 }, // 空地
    ],
  };
  const v = engine.validateProject(proj);
  const r = engine.runBatch(v.project);
  assert(r[0].area === 1 && r[1].area === 1, '2.5 阵营对角不相连');
  assert(r[2].type === 'empty' && r[2].area === 2, '2.5 空地对角八邻相连，面积2：' + JSON.stringify(r[2]));
}

// 2.6 分支隔离：同一 parent 两个兄弟改不同格，互不影响
{
  const proj = {
    rows: ['AA', 'AA'],
    edits: [
      { parent: 0, x: 0, y: 0, value: '.' }, // v1
      { parent: 0, x: 1, y: 1, value: '.' }, // v2（兄弟）
      { parent: 1, x: 1, y: 1, value: '.' }, // v3（v1 后继）
    ],
    queries: [
      { version: 1, x: 0, y: 0 },
      { version: 2, x: 0, y: 0 }, // v2 看不到 v1 的改动 → 仍是 A
      { version: 2, x: 1, y: 1 },
      { version: 3, x: 0, y: 0 },
      { version: 3, x: 1, y: 1 },
    ],
  };
  const v = engine.validateProject(proj);
  const got = engine.runBatch(v.project);
  const want = runBrute(v.project);
  assert(deepEq(got, want), '2.6 分支隔离与暴力一致\n got=' + JSON.stringify(got) + '\nwant=' + JSON.stringify(want));
}

// 2.7 改回原值（no-op 编辑）与反复横跳
{
  const proj = {
    rows: ['A.'],
    edits: [
      { parent: 0, x: 1, y: 0, value: 'A' }, // v1 连上
      { parent: 1, x: 1, y: 0, value: '.' }, // v2 又挖开
      { parent: 2, x: 1, y: 0, value: 'A' }, // v3 再连上
    ],
    queries: [0, 1, 2, 3].map((ver) => ({ version: ver, x: 0, y: 0 })),
  };
  const v = engine.validateProject(proj);
  const got = engine.runBatch(v.project);
  const want = runBrute(v.project);
  assert(deepEq(got, want), '2.7 反复横跳与暴力一致\n got=' + JSON.stringify(got) + '\nwant=' + JSON.stringify(want));
  assert(got[1].area === 2 && got[1].perimeter === 6, '2.7 v1 两格横条周长6');
  assert(got[2].area === 1 && got[2].perimeter === 4, '2.7 v2 恢复单格周长4');
}

// 2.8 1x1 地图边界
{
  const proj = {
    rows: ['A'],
    edits: [{ parent: 0, x: 0, y: 0, value: '.' }],
    queries: [
      { version: 0, x: 0, y: 0 },
      { version: 1, x: 0, y: 0 },
    ],
  };
  const v = engine.validateProject(proj);
  const r = engine.runBatch(v.project);
  assert(r[0].area === 1 && r[0].perimeter === 4, '2.8 单格周长4');
  assert(r[1].type === 'empty' && r[1].area === 1 && r[1].enclave === false && r[1].owner === null,
    '2.8 单格空地贴边非飞地无主：' + JSON.stringify(r[1]));
}

// ---------------------------------------------------------------------------
// 3. 随机模糊
// ---------------------------------------------------------------------------

console.log('== 随机模糊 ==');

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProject(rng, w, h, editN, queryN, alphabet) {
  // 底图先保证每个阵营字母至少出现一次，使后续 edit 的 value 都合法
  const rows = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) {
      if (y === 0 && x < alphabet.length) {
        s += alphabet[x];
        continue;
      }
      const r = rng();
      s += r < 0.35 ? '.' : alphabet[Math.floor(rng() * alphabet.length)];
    }
    rows.push(s);
  }
  const edits = [];
  for (let i = 0; i < editN; i++) {
    const parent = Math.floor(rng() * (i + 1));
    const x = Math.floor(rng() * w);
    const y = Math.floor(rng() * h);
    const r = rng();
    const value = r < 0.4 ? '.' : alphabet[Math.floor(rng() * alphabet.length)];
    edits.push({ parent, x, y, value });
  }
  const V = editN + 1;
  const queries = [];
  for (let i = 0; i < queryN; i++) {
    queries.push({
      version: Math.floor(rng() * V),
      x: Math.floor(rng() * w),
      y: Math.floor(rng() * h),
    });
  }
  return { rows, edits, queries };
}

const fuzzConfigs = [
  { w: 4, h: 4, edits: 40, queries: 60, alpha: ['A', 'B'], rounds: 200 },
  { w: 6, h: 5, edits: 80, queries: 100, alpha: ['A', 'B', 'C'], rounds: 100 },
  { w: 3, h: 7, edits: 60, queries: 80, alpha: ['A'], rounds: 100 },
  { w: 8, h: 8, edits: 120, queries: 150, alpha: ['A', 'B', 'C', 'D'], rounds: 60 },
  { w: 2, h: 2, edits: 30, queries: 40, alpha: ['A', 'B'], rounds: 100 },
];

let fuzzRound = 0;
for (const cfg of fuzzConfigs) {
  for (let r = 0; r < cfg.rounds; r++) {
    const rng = mulberry32(1000 + fuzzRound * 7919);
    fuzzRound++;
    const input = randomProject(rng, cfg.w, cfg.h, cfg.edits, cfg.queries, cfg.alpha);
    const v = engine.validateProject(input);
    if (!v.ok) {
      failures++;
      console.error('  ✗ 模糊用例校验失败: ' + v.errors.join('; '));
      continue;
    }
    const got = engine.runBatch(v.project);
    const want = runBrute(v.project);
    if (!deepEq(got, want)) {
      failures++;
      for (let i = 0; i < got.length; i++) {
        if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) {
          console.error(`  ✗ 模糊分歧 (cfg=${cfg.w}x${cfg.h} round=${fuzzRound} query#${i}):`);
          console.error('    got =' + JSON.stringify(got[i]));
          console.error('    want=' + JSON.stringify(want[i]));
          console.error('    input=' + JSON.stringify(input).slice(0, 600));
          break;
        }
      }
      if (failures > 8) break;
    }
  }
}
assert(failures === 0, '模糊测试全部通过');

// ---------------------------------------------------------------------------
// 4. 校验：无效导入指出记录号
// ---------------------------------------------------------------------------

console.log('== 校验 ==');

{
  const bad = {
    rows: ['AB', 'AB'],
    edits: [
      { parent: 0, x: 0, y: 0, value: 'C' },        // 1: value 未在底图出现
      { parent: 5, x: 0, y: 0, value: 'A' },        // 2: parent 越界（引用未来版本）
      { parent: 0, x: 9, y: 0, value: 'A' },        // 3: 坐标越界
    ],
    queries: [
      { version: 9, x: 0, y: 0 },                    // 1: version 越界
      { version: 0, x: -1, y: 0 },                   // 2: 坐标越界
    ],
  };
  const r = engine.validateProject(bad);
  assert(!r.ok, '非法导入应被拒绝');
  const msg = r.errors.join('\n');
  assert(msg.includes('edits 第 1 条'), '指出 edits 第1条: ' + msg);
  assert(msg.includes('edits 第 2 条'), '指出 edits 第2条');
  assert(msg.includes('edits 第 3 条'), '指出 edits 第3条');
  assert(msg.includes('queries 第 1 条'), '指出 queries 第1条');
  assert(msg.includes('queries 第 2 条'), '指出 queries 第2条');
}

{
  const cases = [
    [{ rows: [] }, '空 rows'],
    [{ rows: ['A', 'BB'] }, '行宽不一致'],
    [{ rows: ['A'], edits: 'nope' }, 'edits 非数组'],
    [{ rows: ['A'], queries: null }, 'queries 非数组'],
    [{ rows: ['A'], edits: [{ parent: -1, x: 0, y: 0, value: 'A' }] }, 'parent 负数'],
    [{ rows: ['A'], edits: [{ parent: 0, x: 0, y: 0, value: 'AB' }] }, '多字符 value'],
    ['not-object', '根非对象'],
  ];
  for (const [input, label] of cases) {
    const r = engine.validateProject(input);
    assert(!r.ok, '应拒绝：' + label);
  }
  const ok = engine.validateProject({ rows: ['A'] });
  assert(ok.ok && ok.project.edits.length === 0 && ok.project.queries.length === 0,
    'edits/queries 可缺省');
}

// ---------------------------------------------------------------------------
// 5. floodBlock 与 materializeGrid 一致性
// ---------------------------------------------------------------------------

console.log('== 交互工具 ==');
{
  const proj = engine.validateProject({
    rows: ['AAB', 'A.B', 'BBB'],
    edits: [{ parent: 0, x: 1, y: 1, value: 'A' }],
    queries: [],
  }).project;
  const c2m = new Map([['.', 0], ['A', 1], ['B', 2]]);
  const blk = engine.floodBlock(proj, 1, 0, 0, 4, (ch) => c2m.get(ch));
  assert(blk.area === 4, 'floodBlock A 分量面积4（v1 填上后），实际 ' + blk.area);
  const g0 = engine.materializeGrid(proj, 0, (ch) => c2m.get(ch));
  assert(g0[1 * 3 + 1] === 0, 'v0 中心是空');
  const g1 = engine.materializeGrid(proj, 1, (ch) => c2m.get(ch));
  assert(g1[1 * 3 + 1] === 1, 'v1 中心是 A');
}

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks} 项断言，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
