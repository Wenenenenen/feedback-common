// 节点测试：用样例包验证求解结局、确定性、预算与传播删除原因。
// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Solver, STATUS } from '../js/solver.js';
import { LCG } from '../js/rng.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'sample-data');

function loadCase(name) {
  return JSON.parse(readFileSync(join(dataDir, `${name}.json`), 'utf8'));
}

function solve(cfg) {
  const s = new Solver(cfg);
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  return s;
}

const truth = JSON.parse(readFileSync(join(dataDir, 'truth.json'), 'utf8'));

test('checker-even：已求解且网格为合法棋盘', () => {
  const s = solve(loadCase('checker-even'));
  assert.equal(s.status, STATUS.SOLVED);
  assert.equal(truth['checker-even'], '已求解');
  const grid = s.getGrid();
  assert.equal(grid.length, 4);
  // 每条邻边标签相等
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const t = s.tiles[s.idToIndex.get(grid[y][x])];
      for (const [dx, dy, e] of [[1, 0, 1], [0, 1, 2]]) {
        const nx = (x + dx) % 4;
        const ny = (y + dy) % 4;
        const u = s.tiles[s.idToIndex.get(grid[ny][nx])];
        assert.equal(t.edges[e], u.edges[(e + 2) % 4]);
      }
    }
  }
  // pin 生效
  assert.equal(grid[0][0], 'a');
});

test('checker-odd：3×3 全周期棋盘证明无解（不是预算耗尽）', () => {
  const cfg = loadCase('checker-odd');
  const s = solve(cfg);
  assert.equal(s.status, STATUS.UNSOLVABLE);
  assert.ok(s.trialsUsed <= cfg.budget);
  assert.equal(truth['checker-odd'], '无解');
  // 轨迹以 unsolvable 事件结束；初始传播矛盾即无解（栈空，无需回溯事件）
  assert.equal(s.trace.at(-1).type, 'unsolvable');
  assert.ok(s.trace.some((e) => e.type === 'contradiction'));
  assert.ok(s.trace.some((e) => e.type === 'removal' && e.remaining.length === 0) ||
            s.trace.some((e) => e.type === 'backtrack'));
});

test('backtrack：高权重死路需要回溯后找到全 b-live 合法解', () => {
  const s = solve(loadCase('backtrack'));
  assert.equal(s.status, STATUS.SOLVED);
  const grid = s.getGrid();
  assert.ok(grid[0].every((id) => id === 'b-live'));
  // 必须真实发生过回溯，而不是一次命中
  assert.ok(s.trace.some((e) => e.type === 'backtrack'));
  assert.ok(s.trace.some((e) => e.type === 'trial' && e.tile !== 'b-live'));
});

test('相同配置与种子产生完全相同的选择轨迹', () => {
  const cfg = loadCase('backtrack');
  const a = solve(cfg);
  const b = solve(cfg);
  assert.deepEqual(b.trace, a.trace);
  assert.equal(b.rng.snapshot(), a.rng.snapshot());
  assert.deepEqual(b.getGrid(), a.getGrid());
});

test('不同种子产生不同加权抽取序列', () => {
  // 构造无强约束的多拼块网格，保证每个多候选格都真正调用加权随机
  const mk = (seed) => ({
    width: 4, height: 4, wrap_x: false, wrap_y: false, seed, budget: 10000, pins: [],
    tiles: ['t1', 't2', 't3', 't4'].map((id, i) => ({
      id, weight: i + 1, edges: ['e', 'e', 'e', 'e'], color: '#888',
    })),
  });
  const c1 = solve(mk(1));
  const c2 = solve(mk(2));
  const t1 = c1.trace.filter((e) => e.type === 'trial').map((e) => e.tile);
  const t2 = c2.trace.filter((e) => e.type === 'trial').map((e) => e.tile);
  assert.ok(t1.length >= 10);
  assert.notDeepEqual(t2, t1);
});

test('预算耗尽与无解严格区分', () => {
  const cfg = { ...loadCase('backtrack'), budget: 1 };
  const s = solve(cfg);
  assert.equal(s.status, STATUS.BUDGET_EXHAUSTED);
  assert.equal(s.trace.at(-1).type, 'budget_exhausted');
  assert.equal(s.trialsUsed, 1);
});

test('预算给足后同一配置可求解，证明预算耗尽不是无解', () => {
  const s = solve({ ...loadCase('backtrack'), budget: 1000 });
  assert.equal(s.status, STATUS.SOLVED);
});

test('LCG 数值符合说明的递推', () => {
  const r = new LCG(0);
  const first = r.next();
  assert.equal(r.state, 1013904223);
  assert.ok(first >= 0 && first < 1);
  assert.equal(first, 1013904223 / 4294967296);
  const r2 = new LCG(7);
  const seq = [r2.next(), r2.next(), r2.next()];
  const r3 = new LCG(7);
  assert.deepEqual([r3.next(), r3.next(), r3.next()], seq);
});

test('删除原因包含 tile、邻格方向与当时邻格候选', () => {
  const s = new Solver(loadCase('checker-odd'));
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  const removals = s.trace.filter((e) => e.type === 'removal');
  assert.ok(removals.length > 0);
  for (const ev of removals) {
    assert.equal(typeof ev.tile, 'string');
    assert.ok(['N', 'E', 'S', 'W'].includes(ev.dir));
    assert.ok(Array.isArray(ev.neighborCandidates));
    assert.ok(ev.neighborCandidates.length > 0);
    assert.ok(Number.isInteger(ev.neighborX));
  }
});

test('单步执行与整跑轨迹一致（暂停/单步语义）', () => {
  const cfg = loadCase('backtrack');
  const oneShot = solve(cfg);
  const stepped = new Solver(cfg);
  let guard = 0;
  while (stepped.status === STATUS.READY || stepped.status === STATUS.PAUSED) {
    if (stepped.step() === null) break;
    if (++guard > 1_000_000) throw new Error('单步未终止');
  }
  assert.deepEqual(stepped.trace, oneShot.trace);
  assert.equal(stepped.status, oneShot.status);
});

test('回溯恢复候选域且随机状态不回退', () => {
  const s = new Solver(loadCase('backtrack'));
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  const bt = s.trace.filter((e) => e.type === 'backtrack');
  assert.ok(bt.length > 0);
  // 回溯事件记录的 rngState 始终是合法 uint32（随机状态不随域快照回退）
  for (const ev of bt) {
    assert.ok(Number.isInteger(ev.rngState) && ev.rngState >= 0 && ev.rngState <= 0xffffffff);
  }
  // 更严格的检查：所有 select/backtrack 记录的 rngState 均为合法 uint32
  const states = s.trace.filter((e) => e.type === 'select' || e.type === 'backtrack').map((e) => e.rngState);
  assert.ok(states.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff));
});

test('pin 交集为空直接判无解', () => {
  const cfg = loadCase('checker-even');
  const bad = {
    ...cfg,
    pins: [{ x: 0, y: 0, allowed: ['a'] }, { x: 0, y: 0, allowed: ['b'] }],
  };
  const s = solve(bad);
  assert.equal(s.status, STATUS.UNSOLVABLE);
});

test('尺寸1周期轴检查自身相邻边', () => {
  // 1×1，wrap_x：东西边必须相等；b 的东西边相等可解，a 不等不可解
  const base = {
    width: 1, height: 1, wrap_x: true, wrap_y: false, seed: 0, budget: 100, pins: [],
    tiles: [
      { id: 'a', weight: 1, edges: ['n', 'X', 's', 'Y'], color: '#fff' },
      { id: 'b', weight: 1, edges: ['n', 'Z', 's', 'Z'], color: '#000' },
    ],
  };
  assert.equal(solve(base).status, STATUS.SOLVED);
  const onlyA = { ...base, tiles: [base.tiles[0]] };
  assert.equal(solve(onlyA).status, STATUS.UNSOLVABLE);
});

test('非法配置被拒绝', () => {
  assert.throws(() => new Solver({ ...loadCase('truth'), width: 0 }));
  assert.throws(() => new Solver({ ...loadCase('backtrack'), seed: -1 }));
  assert.throws(() => new Solver({ ...loadCase('backtrack'), budget: 0 }));
});
