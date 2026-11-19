#!/usr/bin/env node
/* 校验核心引擎：参考数据、增量一致性、模拟不变量。用法：node test/verify.js */
'use strict';

const fs = require('fs');
const path = require('path');
const FlowField = require('../src/flow.js');

const ROOT = path.join(__dirname, '..');
const casesDir = path.join(ROOT, 'cases');

let failures = 0;
let checks = 0;
function ok(cond, label, extra) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  ✗ ${label}${extra ? '\n    ' + extra : ''}`);
  }
}
function section(name) {
  console.log(`\n== ${name}`);
}

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(casesDir, name + '.json'), 'utf8'));
}

function compareField(actual, expected, label) {
  const w = expected.width, h = expected.height;
  ok(actual.size === expected.size, `${label}: size`);
  ok(actual.width === w && actual.height === h, `${label}: 尺寸 ${actual.width}x${actual.height} vs ${w}x${h}`);
  let valDiffs = 0, dirDiffs = 0;
  const samples = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const av = actual.integration[i];
      const ev = expected.integration[i];
      if (av !== ev) {
        valDiffs++;
        if (samples.length < 8) samples.push(`(${x},${y}) 期望 ${ev} 实得 ${av}`);
      }
      const ad = actual.direction[i];
      const ed = expected.direction[i];
      if (ad !== ed) {
        dirDiffs++;
        if (samples.length < 8) samples.push(`(${x},${y}) 方向 期望 ${ed} 实得 ${ad}`);
      }
    }
  }
  ok(valDiffs === 0, `${label}: 积分值有 ${valDiffs} 处不一致`, samples.join('; '));
  ok(dirDiffs === 0, `${label}: 方向有 ${dirDiffs} 处不一致`, samples.join('; '));
}

/* ---------------- 1. 参考数据 ---------------- */
function testReference() {
  section('参考数据对照');
  const ref = load('reference');
  for (const caseName of ['corridor-mud', 'slit', 'multi-goal']) {
    const input = load(caseName);
    const engine = FlowField.createEngine(input);
    for (const k of [1, 2, 3]) {
      const got = FlowField.integrationExport(engine, k);
      compareField(got, ref[caseName][String(k)], `${caseName} size=${k}`);
    }
  }
}

/* ---------------- 2. 无效地图 ---------------- */
function testInvalid() {
  section('非法输入');
  const invalid = load('invalid');
  let threw = null;
  try { FlowField.createEngine(invalid); } catch (e) { threw = e; }
  ok(!!threw, 'invalid.json 应被拒绝');
  if (threw) console.log(`  拒绝原因：${threw.message}`);

  const bad = [
    { label: '行不等长', input: { rows: ['...', '..'], units: [] } },
    { label: '非法字符', input: { rows: ['..X', '...'], units: [] } },
    { label: '空 rows', input: { rows: [], units: [] } },
    { label: '尺寸 4', input: { rows: ['....', '....', '....', '....'], units: [{ id: 0, size: 4, x: 0, y: 0 }] } },
    { label: '单位在墙里', input: { rows: ['.#', '..'], units: [{ id: 0, size: 2, x: 0, y: 0 }] } },
    { label: '单位越界', input: { rows: ['...', '...'], units: [{ id: 0, size: 2, x: 2, y: 2 }] } },
    { label: 'id 重复', input: { rows: ['....'], units: [{ id: 1, size: 1, x: 0, y: 0 }, { id: 1, size: 1, x: 1, y: 0 }] } },
  ];
  for (const b of bad) {
    let caught = null;
    try { FlowField.createEngine(b.input); } catch (e) { caught = e; }
    ok(!!caught, `${b.label} 应被拒绝`, caught ? '' : '未抛出');
  }

  // 初始重合不是致命错误（slit.json 即如此），但必须有警告
  {
    const eng = FlowField.createEngine({
      rows: ['....', '....'],
      units: [{ id: 0, size: 2, x: 0, y: 0 }, { id: 1, size: 2, x: 1, y: 0 }],
    });
    ok(eng.warnings.length > 0, '初始占块重叠应给出警告');
    console.log(`  初始重叠警告：${eng.warnings.join('；')}`);
  }
}

/* ---------------- 3. 增量一致性 ---------------- */
function randomEdits(rng, map, count) {
  const chars = ['#', '.', ',', 'G'];
  const edits = [];
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * map.width);
    const y = Math.floor(rng() * map.height);
    edits.push({ x, y, ch: chars[Math.floor(rng() * chars.length)] });
  }
  return edits;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function testIncremental() {
  section('增量重算 == 全量重算');
  const caseNames = ['doorway', 'slit', 'multi-goal', 'corridor-mud', 'big-256'];
  for (const caseName of caseNames) {
    const input = load(caseName);
    const rng = mulberry32(12345);
    const engine = FlowField.createEngine(input);
    let rounds = 0;
    let identicalAll = true;
    for (let round = 0; round < 12; round++) {
      const edits = randomEdits(rng, engine.map, caseName === 'big-256' ? 6 : 3);
      FlowField.applyTerrainEdits(engine, edits);
      rounds++;
      const res = FlowField.verifyIncremental(engine);
      for (const k of [1, 2, 3]) {
        if (!res[k].identical) {
          identicalAll = false;
          ok(false, `${caseName} 第 ${round + 1} 轮 size=${k} 增量与全量不一致`,
            `值差异 ${res[k].valueDiffs}，方向差异 ${res[k].directionDiffs}；` +
            res[k].sample.map(s => `(${s.x},${s.y}) full=${s.full} inc=${s.inc}`).join('; '));
        }
      }
    }
    ok(identicalAll, `${caseName}: ${rounds} 轮随机地形改动增量均与全量一致`);
    if (identicalAll) console.log(`  ✓ ${caseName}: ${rounds} 轮随机改动一致`);
  }

  // 大范围改动：整条走廊开/关，验证影响区域较大时依然一致
  {
    const input = load('doorway');
    const engine = FlowField.createEngine(input);
    const edits = [];
    for (let y = 0; y < engine.map.height; y++) {
      edits.push({ x: 20, y, ch: '#' });
    }
    const stat = FlowField.applyTerrainEdits(engine, edits);
    const res = FlowField.verifyIncremental(engine);
    const allSame = [1, 2, 3].every(k => res[k].identical);
    ok(allSame, 'doorway 封死整列后增量与全量一致');
    if (allSame) {
      console.log(`  ✓ doorway 封死整列 (${stat.changed} 格)：size1 重算 ${stat.perSize[1].invalidated}/${stat.perSize[1].nodes || ''} 锚点，一致`);
    }
    // 再打开
    const reopen = [];
    for (let y = 0; y < engine.map.height; y++) reopen.push({ x: 20, y, ch: '.' });
    FlowField.applyTerrainEdits(engine, reopen);
    const res2 = FlowField.verifyIncremental(engine);
    ok([1, 2, 3].every(k => res2[k].identical), 'doorway 重新打开整列后增量与全量一致');
  }
}

/* ---------------- 4. 模拟不变量 ---------------- */
function testSimulation() {
  section('模拟不变量');
  const cases = ['slit', 'doorway', 'multi-goal', 'corridor-mud'];
  for (const caseName of cases) {
    const input = load(caseName);
    const engine = FlowField.createEngine(input);
    const sim = engine.sim;
    const start = sim.units.map(u => ({ ...u }));
    let frames = 0;
    let overlapError = null, wallError = null, stepError = null;
    // 记录“初始就重叠”的单位对；只禁止产生新的重叠
    const initialOverlap = new Set();
    for (let i = 0; i < start.length; i++) {
      for (let j = i + 1; j < start.length; j++) {
        const a = start[i], b = start[j];
        if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size) {
          initialOverlap.add([Math.min(a.id, b.id), Math.max(a.id, b.id)].join('-'));
        }
      }
    }
    const beforeMap = new Map(start.map(u => [u.id, u]));
    while (!sim.finished && frames < 3000) {
      const before = sim.units.map(u => ({ id: u.id, x: u.x, y: u.y, size: u.size }));
      for (const u of before) beforeMap.set(u.id, u);
      FlowField.stepSim(engine);
      frames++;
      for (let i = 0; i < sim.units.length; i++) {
        for (let j = i + 1; j < sim.units.length; j++) {
          const a = sim.units[i], b = sim.units[j];
          if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size) {
            const key = [Math.min(a.id, b.id), Math.max(a.id, b.id)].join('-');
            if (!initialOverlap.has(key)) overlapError = `第 ${frames} 帧 id=${a.id} 与 id=${b.id} 新产生重叠`;
          }
        }
      }
      for (const u of sim.units) {
        // 不穿墙
        if (FlowField.blockBlocked(engine.map.grid, u.x, u.y, u.size)) {
          wallError = `第 ${frames} 帧 id=${u.id} 占块进入墙`;
        }
        const b = beforeMap.get(u.id);
        if (b) {
          const dx = u.x - b.x, dy = u.y - b.y;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            stepError = `id=${u.id} 第 ${frames} 帧移动 (${dx},${dy}) 超过一格`;
          }
          if (dx !== 0 && dy !== 0) {
            const W = engine.fields[u.size].W;
            const pass = engine.fields[u.size].pass;
            if (!pass[b.y * W + b.x + dx] || !pass[(b.y + dy) * W + b.x]) {
              stepError = `id=${u.id} 第 ${frames} 帧斜穿墙角`;
            }
          }
        }
      }
    }
    ok(!overlapError, `${caseName}: 不产生新的占块重叠`, overlapError || '');
    // 模拟结束后不应残留任何重叠
    let residual = null;
    for (let i = 0; i < sim.units.length; i++) {
      for (let j = i + 1; j < sim.units.length; j++) {
        const a = sim.units[i], b = sim.units[j];
        if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size) {
          residual = `id=${a.id} 与 id=${b.id}`;
        }
      }
    }
    ok(!residual, `${caseName}: 结束时无残留重叠`, residual || '');
    if (initialOverlap.size) console.log(`  ${caseName}: 初始重叠 ${Array.from(initialOverlap).join(', ')}（样例数据本身如此）`);
    ok(!wallError, `${caseName}: 无穿墙`, wallError || '');
    ok(!stepError, `${caseName}: 每帧至多一格且不斜穿墙角`, stepError || '');
    const traj = FlowField.trajectoryExport(engine);
    const accounted = sim.arrivals.length + sim.unreachableIds.length + sim.blockedIds.length;
    ok(accounted === engine.initialUnits.length, `${caseName}: 每个单位都有明确归宿（到达/不可达/被堵死）`,
      `到达 ${sim.arrivals.length}，不可达 ${sim.unreachableIds.length}，被堵死 ${sim.blockedIds.length}，` +
      `总数 ${engine.initialUnits.length}，finished=${sim.finished} deadlock=${sim.deadlock}`);
    const arrivalFrames = traj.arrivals.map(a => `${a.id}@${a.frame}`).join(' ');
    console.log(`  ${caseName}: ${frames} 帧，finished=${sim.finished} deadlock=${sim.deadlock}，到达 ${arrivalFrames || '无'}` +
      (sim.unreachableIds.length ? `，不可达 ${sim.unreachableIds.join(',')}` : '') +
      (sim.blockedIds.length ? `，被堵死 ${sim.blockedIds.join(',')}` : ''));
  }
}

/* ---------------- 5. 抖动检测 ---------------- */
function testOscillation() {
  section('门口拥堵抖动检测');
  // 用 doorway：大门口两侧大量单位涌入
  const input = load('doorway');
  const engine = FlowField.createEngine(input);
  const sim = engine.sim;
  const posHistory = new Map(); // id -> [x,y][] 最近
  const flips = new Map();
  let frames = 0;
  while (!sim.finished && frames < 4000) {
    FlowField.stepSim(engine);
    frames++;
    for (const u of sim.units) {
      if (!posHistory.has(u.id)) posHistory.set(u.id, []);
      const h = posHistory.get(u.id);
      h.push(u.x + ',' + u.y);
      if (h.length > 8) h.shift();
    }
  }
  // A-B-A-B 反复视为抖动
  for (const [id, h] of posHistory) {
    let count = 0;
    for (let i = 3; i < h.length; i++) {
      if (h[i] === h[i - 2] && h[i] !== h[i - 1]) count++;
    }
    if (count > 1) flips.set(id, count);
  }
  ok(flips.size === 0, '没有单位出现 A-B-A 来回抖动',
    Array.from(flips).map(([id, c]) => `id=${id} 折返 ${c} 次`).join('; '));
  console.log(`  doorway 运行 ${frames} 帧，抖动单位 ${flips.size} 个，finished=${sim.finished} deadlock=${sim.deadlock}`);
}

/* ---------------- 6. 到达帧统计 ---------------- */
function testArrivalStats() {
  section('到达帧统计');
  const input = load('slit');
  const engine = FlowField.createEngine(input);
  FlowField.runSim(engine, 500);
  const traj = FlowField.trajectoryExport(engine);
  for (const a of traj.arrivals) {
    ok(typeof a.frame === 'number' && a.frame >= 0, `slit id=${a.id} 有到达帧 ${a.frame}`);
  }
  console.log(`  slit 到达：${traj.arrivals.map(a => `id=${a.id} 第${a.frame}帧`).join('，')}` +
    (traj.unreachable.length ? `；不可达：${traj.unreachable.join(',')}` : ''));
}

/* ---------------- main ---------------- */
testReference();
testInvalid();
testIncremental();
testSimulation();
testOscillation();
testArrivalStats();

console.log(`\n共 ${checks} 项检查，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
