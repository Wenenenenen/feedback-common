// 校验拒绝（编号+原因）与原场景保留；编辑后增量结果与全量一致
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';
import { validateScene } from '../src/validate.js';

const base = JSON.parse(readFileSync('cases-unpacked/case1_single_mirror.json', 'utf8'));
let fails = 0;
const expectReject = (name, mutate, expectId) => {
  const scene = JSON.parse(JSON.stringify(base));
  mutate(scene);
  const v = validateScene(scene);
  if (v.valid) { console.log(`✗ ${name}: 应拒绝却通过`); fails++; return; }
  const ids = v.errors.map((e) => e.id);
  console.log(`✓ ${name}:`, v.errors.map((e) => `[${e.kind}:${e.id}] ${e.reason}`).join('; '));
  if (expectId !== undefined && !ids.includes(expectId)) {
    console.log(`  ✗ 期望指出 id=${expectId}，实际 ${ids}`); fails++;
  }
};

expectReject('越界三角形索引', (s) => { s.triangles[0].indices[0] = 999; }, 1);
expectReject('零面积三角形', (s) => { s.vertices[1] = s.vertices[0].slice(); }, 1);
expectReject('非共面镜面', (s) => { s.mirrors[0].vertices[2][2] = 0.5; }, 'M_front');
expectReject('非凸镜面(凹点)', (s) => {
  s.mirrors[0].vertices = [[-1, 0, 0], [1, 0, 0], [0, 1, 0], [1, 2, 0], [-1, 2, 0]];
}, 'M_front');
expectReject('零面积镜面', (s) => { s.mirrors[0].vertices = [[0, 0, 0], [1, 0, 0], [1, 0, 0], [0, 0, 0]]; }, 'M_front');
expectReject('反射率越界', (s) => { s.mirrors[0].reflectance[1] = 1.5; }, 'M_front');
expectReject('画布越界', (s) => { s.camera.width = 400; });
expectReject('K 越界', (s) => { s.beamBudgetK = 0; });
expectReject('bounce 越界', (s) => { s.maxBounceDepth = 5; });
expectReject('near>=far', (s) => { s.camera.near = 100; });
expectReject('fov 越界', (s) => { s.camera.fovYDeg = 180; });
expectReject('镜面顶点数不足', (s) => { s.mirrors[0].vertices = [[0, 0, 0], [1, 0, 0]]; }, 'M_front');
expectReject('颜色越界', (s) => { s.triangles[0].color[0] = -0.1; }, 1);
expectReject('非有限坐标', (s) => { s.vertices[0][1] = NaN; });
expectReject('镜面数量超限', (s) => {
  for (let i = 0; i < 17; i++) s.mirrors.push(JSON.parse(JSON.stringify(s.mirrors[0]))), s.mirrors[s.mirrors.length - 1].id = 'X' + i;
});

// 自交四边形（蝴蝶结）
const bow = JSON.parse(JSON.stringify(base));
bow.mirrors[0].vertices = [[-1, 0, 0], [1, 2, 0], [1, 0, 0], [-1, 2, 0]];
const vb = validateScene(bow);
if (vb.valid) { console.log('✗ 自交镜面应拒绝'); fails++; }
else console.log('✓ 自交镜面:', vb.errors[0].reason);

// 保留原场景：加载合法场景后，拒绝非法编辑，引擎状态不变
const engine = new Engine();
const loadOk = engine.load(base);
if (!loadOk.ok) { console.log('✗ 基础场景无法载入', loadOk.errors); fails++; }
const before = JSON.stringify(engine.exportJSON());
const bad = JSON.parse(JSON.stringify(base));
bad.mirrors[0].vertices[2][2] = 0.9; // 非共面
const edit = engine.applyEdit(bad);
if (edit.ok) { console.log('✗ 非法编辑应被拒绝'); fails++; }
else console.log('✓ 非法编辑被拒绝，原场景保留:', edit.errors[0].reason);
const after = JSON.stringify(engine.exportJSON());
if (before !== after) { console.log('✗ 拒绝编辑后场景发生变化'); fails++; }
else console.log('✓ 拒绝编辑后导出结果与之前完全一致');

// 合法编辑后全量重算与全新引擎结果一致
const good = JSON.parse(JSON.stringify(base));
good.mirrors[0].reflectance = [0.5, 0.6, 0.7];
const e2 = engine.applyEdit(good);
const fresh = new Engine(); fresh.load(good);
if (JSON.stringify(engine.exportJSON()) !== JSON.stringify(fresh.exportJSON())) {
  console.log('✗ 增量重算与全量结果不一致'); fails++;
} else console.log('✓ 合法编辑重算结果与全量载入一致');

console.log(fails === 0 ? '\n校验/保留/重算测试全部通过' : `\n${fails} 项失败`);
process.exit(fails ? 1 : 0);
