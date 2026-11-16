// Node 校验：核心库对照 samples/instance-ray-bvh-cases/expected.json
// 运行：node test/run-tests.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const IRB = require('../js/core.js');

const dir = path.join(__dirname, '..', 'samples', 'instance-ray-bvh-cases');
const sceneData = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8'));
const rays = JSON.parse(fs.readFileSync(path.join(dir, 'rays.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const invalidScene = JSON.parse(fs.readFileSync(path.join(dir, 'invalid-affine.json'), 'utf8'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  PASS ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

// ---------- 主场景 ----------
console.log('[1] 主场景：BVH vs 穷举 vs expected');
const scene = IRB.createScene();
IRB.loadSceneData(scene, sceneData);
const stats = IRB.sceneStats(scene);

check('unique_blas = 2', stats.uniqueBlas === expected.unique_blas, 'got ' + stats.uniqueBlas);
check('singular 被排除', JSON.stringify(stats.invalidInstances.map((x) => x.id)) === JSON.stringify(expected.singular_excluded),
  JSON.stringify(stats.invalidInstances));

let bvhTri = 0, bruteTri = 0, mismatches = 0, expectedFails = 0;
for (const ray of rays) {
  const r1 = IRB.queryBVH(scene, ray.origin, ray.direction);
  const r2 = IRB.queryBruteForce(scene, ray.origin, ray.direction);
  bvhTri += r1.stats.triTests;
  bruteTri += r2.stats.triTests;
  if (!IRB.hitsEqual(r1.hit, r2.hit)) {
    mismatches++;
    console.log('  不一致 @' + ray.id, JSON.stringify(r1.hit), JSON.stringify(r2.hit));
  }
  const exp = expected[ray.id];
  if (exp !== undefined) {
    if (!IRB.hitMatchesExpected(r1.hit, exp)) {
      expectedFails++;
      console.log('  与 expected 不符 @' + ray.id, 'got', JSON.stringify(r1.hit), 'want', JSON.stringify(exp));
    }
  }
}
check('BVH 与穷举全部一致 (' + rays.length + ' 条射线)', mismatches === 0, mismatches + ' 处不一致');
check('与 expected.json 全部相符', expectedFails === 0, expectedFails + ' 处不符');
console.log('  三角测试次数：BVH=' + bvhTri + ' 穷举=' + bruteTri + ' 加速比=' + (bruteTri / Math.max(1, bvhTri)).toFixed(1) + 'x');

// 定点复核 fixed 射线的完整字段
const fixed = IRB.queryBVH(scene, [0, 0, 0], [0, 0, 1]).hit;
check('fixed 命中 a-mirror/face0/t5', fixed && fixed.instance === 'a-mirror' && fixed.face === 0 && fixed.t === 5);
check('fixed 法线 [0,0,-1]（不翻转）', JSON.stringify(fixed.normal) === '[0,0,-1]');
check('fixed 重心 [0.25,0.25,0.5]', JSON.stringify(fixed.barycentric) === '[0.25,0.25,0.5]');

// ---------- 实例矩阵更新：只重建 TLAS ----------
console.log('[2] 实例矩阵更新');
const blasBefore = IRB.sceneStats(scene).blasBuilds;
const tlasBefore = IRB.sceneStats(scene).tlasBuilds;
const err = IRB.updateInstanceMatrix(scene, 'grid-00-00', [1, 0, 0, 31, 0, 1, 0, 0, 0, 0, 1, 20, 0, 0, 0, 1]);
const stats2 = IRB.sceneStats(scene);
check('更新成功', err === null, err);
check('BLAS 未重建', stats2.blasBuilds === blasBefore, blasBefore + ' -> ' + stats2.blasBuilds);
check('TLAS 重建 +1', stats2.tlasBuilds === tlasBefore + 1);
check('revision 递增', stats2.revision === stats.revision + 1);
const moved = IRB.queryBVH(scene, [31, 0, 0], [0, 0, 1]);
check('移动后可命中新位置', moved.hit && moved.hit.instance === 'grid-00-00' && Math.abs(moved.hit.t - 19) < 1e-9);

// 把实例改成奇异矩阵 → 排除且场景不失败
const err2 = IRB.updateInstanceMatrix(scene, 'grid-00-00', [0, 0, 0, 31, 0, 1, 0, 0, 0, 0, 1, 20, 0, 0, 0, 1]);
check('可改为奇异矩阵（无异常）', err2 === null);
const stats3 = IRB.sceneStats(scene);
check('奇异实例被列入排除清单', stats3.invalidInstances.some((x) => x.id === 'grid-00-00'));
const afterSingular = IRB.queryBVH(scene, [31, 0, 0], [0, 0, 1]);
check('奇异实例不再命中', !afterSingular.hit || afterSingular.hit.instance !== 'grid-00-00');

// ---------- 非法仿射场景 ----------
console.log('[3] 非法仿射矩阵样例');
const scene2 = IRB.createScene();
IRB.loadSceneData(scene2, invalidScene);
const s2 = IRB.sceneStats(scene2);
check('a-mirror 因末行非法被排除', s2.invalidInstances.some((x) => x.id === 'a-mirror' && /末行/.test(x.reason)),
  JSON.stringify(s2.invalidInstances.slice(0, 3)));
check('singular 仍被排除', s2.invalidInstances.some((x) => x.id === 'singular'));
check('场景其余部分可正常求交', (() => {
  const h = IRB.queryBVH(scene2, [0, 0, 0], [0, 0, 1]).hit;
  return h && h.instance === 'b-tie' && Math.abs(h.t - 5) < 1e-9;
})());

// ---------- 边界 ----------
console.log('[4] 边界情况');
check('零方向射线报错', IRB.queryBVH(scene, [0, 0, 0], [0, 0, 0]).error !== null);
check('未命中返回 null', IRB.queryBVH(scene, [-20, 0, 0], [0, 0, 1]).hit === null);
check('场景哈希随编辑变化', IRB.sceneHash(scene) !== IRB.sceneHash(scene2));

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
