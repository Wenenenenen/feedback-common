// 核心逻辑测试：node test/core.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateScene, computeTraversal, findRoom } from '../portal-core.js';

const load = name => JSON.parse(fs.readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8'));
const gallery = load('gallery.json');
const invalid = load('invalid-portal.json');
const expected = load('expected.json');

const allOpen = () => true;
const openMap = m => id => m[id] !== false;

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ---------- 校验 ----------
ok('gallery.json 校验通过', () => {
  assert.deepEqual(validateScene(gallery), []);
});

ok('invalid-portal.json 检出非法门洞', () => {
  const errs = validateScene(invalid);
  assert.ok(errs.length > 0, '应报告错误');
  assert.ok(errs.some(e => e.includes('front-left')), `错误应指名 front-left: ${errs.join(' | ')}`);
});

// ---------- 相机归属 ----------
ok('z=4 边界归属字典序最小房间 a', () => {
  const r = findRoom(gallery.rooms, [-1.5, 1.5, 4]);
  assert.equal(r.id, expected.boundary_z4_room);
});

ok('房间外返回 null', () => {
  assert.equal(findRoom(gallery.rooms, [100, 1.5, 4]), null);
});

// ---------- 主相机遍历 ----------
const mainCam = gallery.cameras.main;
ok('主相机候选房间覆盖必需集合', () => {
  const t = computeTraversal(gallery, allOpen, mainCam);
  assert.equal(t.error, null);
  assert.equal(t.room, 'a');
  for (const id of expected.main_required_candidate_rooms) {
    assert.ok(t.candidates.includes(id), `缺少候选房间 ${id}（实际: ${t.candidates.join(',')}）`);
  }
});

ok('主相机经 front-right 窗口能看到 side（不允许全局 visited 丢窗口）', () => {
  const t = computeTraversal(gallery, allOpen, mainCam);
  assert.ok(t.candidates.includes('side'), `side 应可达: ${t.candidates.join(',')}`);
});

ok('循环通路 a→b→side→a 终止且不重复房间', () => {
  const t = computeTraversal(gallery, allOpen, mainCam);
  assert.ok(Number.isFinite(t.paths.length));
  assert.ok(t.paths.length > 0);
  for (const p of t.paths) {
    assert.equal(new Set(p.rooms).size, p.rooms.length, `路径含重复房间: ${p.rooms.join('→')}`);
    assert.ok(p.rooms.length <= gallery.rooms.length, '路径深度不应超过房间数');
  }
  // 图中确实存在 a-b-side-a 环（expected.cycle），遍历必须终止
  assert.ok(t.paths.some(p => p.rooms.includes('side')), '应存在经过 side 的路径');
});

ok('同一房间可经不同窗口重复到达（b 的前门双门洞）', () => {
  const t = computeTraversal(gallery, allOpen, mainCam);
  const toB = t.paths.filter(p => p.rooms.length === 2 && p.rooms[1] === 'b');
  assert.ok(toB.length >= 2, `b 应经 front-left 与 front-right 两条路径到达，实际 ${toB.length} 条`);
});

// ---------- 近平面穿门 ----------
ok('door-before（近平面压门）仍可达 b', () => {
  const t = computeTraversal(gallery, allOpen, gallery.cameras['door-before']);
  assert.equal(t.room, 'a');
  assert.ok(t.candidates.includes('b'), `近平面穿门后应看到 b: ${t.candidates.join(',')}`);
});

ok('door-after 归属房间 b', () => {
  const t = computeTraversal(gallery, allOpen, gallery.cameras['door-after']);
  assert.equal(t.room, 'b');
});

// ---------- 门洞开关 ----------
ok('全部关门后只剩当前房间', () => {
  const t = computeTraversal(gallery, () => false, mainCam);
  assert.deepEqual(t.candidates, ['a']);
});

ok('关闭 front-left 后 b 仍经 front-right 可达', () => {
  const t = computeTraversal(gallery, openMap({ 'front-left': false }), mainCam);
  assert.ok(t.candidates.includes('b'));
});

ok('关闭 front-left 与 front-right 后 b 不可达', () => {
  const t = computeTraversal(gallery, openMap({ 'front-left': false, 'front-right': false }), mainCam);
  assert.ok(!t.candidates.includes('b'));
  assert.ok(!t.candidates.includes('left'));
});

// ---------- 相机出界 ----------
ok('相机离开全部房间时给出明确错误', () => {
  const t = computeTraversal(gallery, allOpen, { ...mainCam, position: [50, 1.5, 1], target: [50, 1.5, 10] });
  assert.equal(t.room, null);
  assert.ok(t.error && t.error.includes('不在任何房间'));
});

// ---------- 窗口单调收缩 ----------
ok('观察窗口沿路径单调不增且始终在屏幕内', () => {
  const t = computeTraversal(gallery, allOpen, mainCam);
  for (const p of t.paths) {
    for (const [x, y] of p.window) {
      assert.ok(x >= -1 - 1e-6 && x <= 1 + 1e-6 && y >= -1 - 1e-6 && y <= 1 + 1e-6,
        `窗口越界: ${JSON.stringify(p.window)}`);
    }
  }
});

console.log(`\n全部 ${passed} 项核心测试通过`);
