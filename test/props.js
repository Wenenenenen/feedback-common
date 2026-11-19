#!/usr/bin/env node
/* 性质的随机化测试：不变量、抖动、增量一致性。
 * 用法：node test/props.js [迭代数] */
'use strict';

const path = require('path');
const FlowField = require('../src/flow.js');

const ITER = parseInt(process.argv[2] || '300', 10);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0, checks = 0;
function ok(cond, label, extra) {
  checks++;
  if (!cond) { failures++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

function makeCase(r) {
  const W = 8 + Math.floor(r() * 12);
  const H = 7 + Math.floor(r() * 10);
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) row += '#';
      else {
        const p = r();
        row += p < 0.16 ? '#' : p < 0.28 ? ',' : '.';
      }
    }
    rows.push(row);
  }
  // 目标区域：1~2 块
  const gCount = 1 + Math.floor(r() * 2);
  for (let g = 0; g < gCount; g++) {
    const gw = 1 + Math.floor(r() * 3), gh = 1 + Math.floor(r() * 3);
    const gx = 1 + Math.floor(r() * (W - gw - 1));
    const gy = 1 + Math.floor(r() * (H - gh - 1));
    for (let y = gy; y < gy + gh; y++) {
      const arr = rows[y].split('');
      for (let x = gx; x < gx + gw; x++) if (arr[x] === '#') arr[x] = 'G'; else arr[x] = 'G';
      rows[y] = arr.join('');
    }
  }
  const unitCount = 2 + Math.floor(r() * 9);
  const units = [];
  const occupied = [];
  for (let id = 0; id < unitCount; id++) {
    const size = 1 + Math.floor(r() * 3);
    for (let attempt = 0; attempt < 50; attempt++) {
      const x = 1 + Math.floor(r() * Math.max(1, W - size - 1));
      const y = 1 + Math.floor(r() * Math.max(1, H - size - 1));
      let wall = false, onGoal = false;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const c = rows[y + dy][x + dx];
          if (c === '#') wall = true;
          if (c === 'G') onGoal = true;
        }
      }
      if (wall || onGoal) continue;
      let clash = false;
      for (const o of occupied) {
        if (x < o.x + o.size && o.x < x + size && y < o.y + o.size && o.y < y + size) { clash = true; break; }
      }
      if (clash) continue;
      units.push({ id, size, x, y });
      occupied.push({ x, y, size });
      break;
    }
  }
  return { rows, units };
}

function rectOverlap(a, b) {
  return a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size;
}

const MAX_FRAMES = 2500;

for (let it = 0; it < ITER; it++) {
  const r = rng(1000 + it);
  const input = makeCase(r);
  if (input.units.length < 2) continue;
  const label = `#${it}(${input.rows.length}x${input.rows[0].length},${input.units.length}u)`;

  let engine;
  try {
    engine = FlowField.createEngine(input);
  } catch (e) {
    ok(false, `${label} 合法地图不应抛错`, e.message);
    continue;
  }

  // 初始重叠：本生成器不产生初始重叠
  ok(engine.warnings.length === 0, `${label} 生成器不应产生初始重叠`, engine.warnings.join(';'));

  const sim = engine.sim;
  const positions = new Map(); // id -> [{x,y,frame}]
  const valueAt = new Map();   // id -> 上一帧积分值
  const retreatFrames = new Map(); // id -> Set(frame)
  for (const u of sim.units) {
    positions.set(u.id, [{ x: u.x, y: u.y, frame: 0 }]);
    const f = engine.fields[u.size];
    valueAt.set(u.id, f.integration[u.y * f.W + u.x]);
  }
  const startIds = new Set(sim.units.map(u => u.id));

  let frames = 0;
  let newOverlap = null, wallViolation = null, jumpViolation = null, uphillViolation = null;
  while (!sim.finished && frames < MAX_FRAMES) {
    const beforeMap = new Map(sim.units.map(u => [u.id, { x: u.x, y: u.y, size: u.size }]));
    const beforeVal = new Map();
    for (const u of sim.units) {
      const f = engine.fields[u.size];
      beforeVal.set(u.id, f.integration[u.y * f.W + u.x]);
    }
    const res = FlowField.stepSim(engine);
    frames++;
    if (res.retreat) retreatFrames.set(res.retreat.id, (retreatFrames.get(res.retreat.id) || 0) + 1);

    // 占块不重叠
    for (let i = 0; i < sim.units.length; i++) {
      for (let j = i + 1; j < sim.units.length; j++) {
        if (rectOverlap(sim.units[i], sim.units[j])) {
          newOverlap = `第 ${frames} 帧 id=${sim.units[i].id}/${sim.units[j].id}`;
        }
      }
    }
    for (const u of sim.units) {
      if (FlowField.blockBlocked(engine.map.grid, u.x, u.y, u.size)) {
        wallViolation = `第 ${frames} 帧 id=${u.id}`;
      }
      const b = beforeMap.get(u.id);
      if (b) {
        const dx = u.x - b.x, dy = u.y - b.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) jumpViolation = `第 ${frames} 帧 id=${u.id} 位移 ${dx},${dy}`;
        if (dx !== 0 && dy !== 0) {
          const fld = engine.fields[u.size];
          if (!fld.pass[b.y * fld.W + b.x + dx] || !fld.pass[(b.y + dy) * fld.W + b.x]) {
            jumpViolation = `第 ${frames} 帧 id=${u.id} 斜穿墙角`;
          }
        }
        const prevV = beforeVal.get(u.id);
        const f2 = engine.fields[u.size];
        const nowV = f2.integration[u.y * f2.W + u.x];
        if ((dx || dy) && nowV >= prevV) {
          // 只有显式的退让/分离允许非下坡移动
          if (!res.retreat || res.retreat.id !== u.id) {
            uphillViolation = `第 ${frames} 帧 id=${u.id} 从 ${prevV} 移到 ${nowV}`;
          }
        }
      }
      const arr = positions.get(u.id) || [];
      arr.push({ x: u.x, y: u.y, frame: frames });
      positions.set(u.id, arr);
    }
  }

  ok(!newOverlap, `${label} 模拟中不得出现占块重叠`, newOverlap || '');
  ok(!wallViolation, `${label} 不得进入墙`, wallViolation || '');
  ok(!jumpViolation, `${label} 每帧至多一格且不斜穿墙角`, jumpViolation || '');
  ok(!uphillViolation, `${label} 非退让移动必须严格下坡`, uphillViolation || '');

  // 全部单位应有归宿
  const acc = sim.arrivals.length + sim.unreachableIds.length + sim.blockedIds.length;
  ok(acc === startIds.size, `${label} 单位归宿完整`, `到达 ${sim.arrivals.length} 不可达 ${sim.unreachableIds.length} 堵死 ${sim.blockedIds.length} / ${startIds.size}`);
  ok(sim.finished, `${label} 模拟应结束（${MAX_FRAMES} 帧内）`, `跑到 ${frames} 帧仍未结束`);

  // 抖动：A-B-A-B 反复（退让造成的位移不计）
  for (const [id, path] of positions) {
    let flips = 0;
    for (let i = 3; i < path.length; i++) {
      const a = path[i - 3], b = path[i - 2], c = path[i - 1], d = path[i];
      if (a.x === c.x && a.y === c.y && b.x === d.x && b.y === d.y && (a.x !== b.x || a.y !== b.y)) {
        // 若区间内该单位没有退让，则视为抖动
        flips++;
      }
    }
    if (flips > 1) {
      ok(false, `${label} id=${id} 出现 ${flips} 次来回抖动`, path.map(p => `${p.x},${p.y}`).join(' '));
    }
  }

  // 退让次数应有上限（不能无休止让位）
  for (const [id, n] of retreatFrames) {
    ok(n <= 6, `${label} id=${id} 退让次数 ${n} 应在合理范围`);
  }

  // 增量重算一致性（同一地图，随机改 4 格）
  const edits = [];
  for (let k = 0; k < 4; k++) {
    edits.push({
      x: Math.floor(r() * engine.map.width),
      y: Math.floor(r() * engine.map.height),
      ch: ['#', '.', ',', 'G'][Math.floor(r() * 4)],
    });
  }
  FlowField.applyTerrainEdits(engine, edits);
  const ver = FlowField.verifyIncremental(engine);
  for (const k of [1, 2, 3]) {
    ok(ver[k].identical, `${label} 改地形后 size=${k} 增量与全量一致`,
      `值差 ${ver[k].valueDiffs}，方向差 ${ver[k].directionDiffs}`);
  }
}

console.log(`\n性质测试：${checks} 项检查，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
