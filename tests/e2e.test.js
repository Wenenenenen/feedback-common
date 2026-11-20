// 端到端：配置导出/导入复现、轨迹导出格式、地图导出合法性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Solver, STATUS, validateConfig } from '../js/solver.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'sample-data');
const loadCase = (n) => JSON.parse(readFileSync(join(dataDir, `${n}.json`), 'utf8'));

test('导出配置再导入：相同种子得到完全相同轨迹与网格', () => {
  const first = new Solver(loadCase('backtrack'));
  first.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  const exported = first.exportConfig();

  // 模拟“关闭页面后重新导入配置”
  const roundTrip = JSON.parse(JSON.stringify(exported));
  validateConfig(roundTrip);
  const second = new Solver(roundTrip);
  second.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);

  assert.equal(second.status, first.status);
  assert.deepEqual(second.trace, first.trace);
  assert.deepEqual(second.getGrid(), first.getGrid());
  assert.equal(second.rng.snapshot(), first.rng.snapshot());
});

test('轨迹导出包含全部删除/试选/回溯事件且字段满足说明要求', () => {
  const s = new Solver(loadCase('backtrack'));
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  const out = s.exportTrace();
  assert.equal(out.format, 'wfc-tile-foundry-trace');
  assert.equal(out.status, STATUS.SOLVED);
  assert.ok(Array.isArray(out.trace) && out.trace.length > 0);
  for (const e of out.trace) {
    if (e.type === 'removal') {
      assert.equal(typeof e.tile, 'string');
      assert.ok(['N', 'E', 'S', 'W'].includes(e.dir));
      assert.ok(Array.isArray(e.neighborCandidates));
      assert.ok(Number.isInteger(e.neighbor));
    }
  }
  assert.ok(out.trace.some((e) => e.type === 'trial'));
  assert.ok(out.trace.some((e) => e.type === 'backtrack'));
  // 用导出轨迹中的 config 重跑，事件序列逐字一致
  const replay = new Solver(out.config);
  replay.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(replay.trace, out.trace);
});

test('无解样例导出轨迹状态为 unsolvable，且与预算耗尽可区分', () => {
  const s = new Solver(loadCase('checker-odd'));
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  assert.equal(s.status, STATUS.UNSOLVABLE);
  const out = s.exportTrace();
  assert.equal(out.status, 'unsolvable');
  assert.equal(out.grid, null);
  assert.equal(out.trace.at(-1).type, 'unsolvable');

  const exhausted = new Solver({ ...loadCase('backtrack'), budget: 1 });
  exhausted.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  assert.equal(exhausted.status, STATUS.BUDGET_EXHAUSTED);
  assert.notEqual(exhausted.exportTrace().status, 'unsolvable');
});

test('已求解地图网格所有邻边（含周期边）合法', () => {
  const s = new Solver(loadCase('checker-even'));
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  const grid = s.getGrid();
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const here2 = s.idToIndex.get(grid[y][x]);
      for (const d of [{ dx: 1, dy: 0, e: 1 }, { dx: 0, dy: 1, e: 2 }]) {
        const nx = (x + d.dx) % s.width;
        const ny = (y + d.dy) % s.height;
        const there = s.idToIndex.get(grid[ny][nx]);
        assert.equal(s.tiles[here2].edges[d.e], s.tiles[there].edges[(d.e + 2) % 4]);
      }
    }
  }
});

test('32×32、24 拼块上限规模可求解且每格单值', { timeout: 30000 }, () => {
  const tiles = [];
  const labels = ['l0', 'l1', 'l2'];
  for (let i = 0; i < 24; i++) {
    tiles.push({
      id: `tile${i}`,
      weight: (i % 5) + 1,
      edges: [labels[i % 3], labels[(i + 1) % 3], labels[i % 3], labels[(i + 1) % 3]],
      color: '#888',
    });
  }
  const cfg = { width: 32, height: 32, wrap_x: true, wrap_y: false, seed: 42, budget: 100000, pins: [], tiles };
  const s = new Solver(cfg);
  s.run({ cancelled: false }, Number.MAX_SAFE_INTEGER);
  assert.equal(s.status, STATUS.SOLVED);
  const grid = s.getGrid();
  assert.equal(grid.length, 32);
  assert.ok(grid.every((row) => row.length === 32 && row.every((id) => typeof id === 'string')));
});

test('取消语义：cancel 后状态为 cancelled 且轨迹记录取消事件', () => {
  const s = new Solver({ ...loadCase('backtrack'), budget: 1_000_000 });
  s.step();
  s.cancel();
  assert.equal(s.status, STATUS.CANCELLED);
  assert.equal(s.trace.at(-1).type, 'cancelled');
  // 取消后不能再推进
  assert.equal(s.step(), null);
});
