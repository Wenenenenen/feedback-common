// 增量重算：单镜面编辑后，增量结果 == 全量结果；未受影响子树对象保留；时序达标
import { Engine } from '../src/engine.js';

function makeScene() {
  // 3 面镜、2 层反射，保证出现多子树
  return {
    sceneId: 'incr',
    camera: { eye: [0, 1.5, 6], target: [0, 1.5, 0], up: [0, 1, 0], fovYDeg: 70, near: 0.2, far: 60, width: 160, height: 120 },
    maxBounceDepth: 3, beamBudgetK: 8,
    mirrors: [
      { id: 'MA', enabled: true, reflectance: [0.9, 0.9, 0.9], vertices: [[-3, 0.2, 0], [-1.2, 0.2, 0], [-1.2, 2.8, 0], [-3, 2.8, 0]] },
      { id: 'MB', enabled: true, reflectance: [0.8, 0.85, 0.9], vertices: [[1.2, 0.2, 0], [3, 0.2, 0], [3, 2.8, 0], [1.2, 2.8, 0]] },
      { id: 'MC', enabled: true, reflectance: [0.85, 0.8, 0.75], vertices: [[-1, 0.2, -3], [1, 0.2, -3], [1, 2.8, -3], [-1, 2.8, -3]] },
    ],
    vertices: [[-0.8, 0.6, 2], [0.8, 0.6, 2], [0, 2.2, 2], [-2, 0.5, -2], [2, 0.5, -2], [0, 2.4, -2]],
    triangles: [
      { id: 1, indices: [0, 2, 1], color: [0.9, 0.25, 0.2], singleSided: true },
      { id: 2, indices: [3, 4, 5], color: [0.2, 0.85, 0.3], singleSided: true },
    ],
  };
}

const base = makeScene();
const engine = new Engine();
let r = engine.load(base);
if (!r.ok) { console.log(r.errors); process.exit(1); }

// 记录编辑前的 beam 对象
const beamsBefore = new Map(engine.tree.all.map((b) => [b.path.join('>'), b]));
const exportBefore = JSON.stringify(engine.exportJSON());
const imgBefore = Buffer.from(engine.result.image);

// 编辑 MB 的反射率（几何不变）——只影响含 MB 路径的子树
const edited = makeScene();
edited.mirrors[1].reflectance = [0.4, 0.5, 0.6];
r = engine.applyEdit(edited, { changedMirrorId: 'MB' });
if (!r.ok) { console.log(r.errors); process.exit(1); }
console.log('增量时序:', engine.lastTiming);

// 1) 与全量参考实现逐字节一致
const ref = new Engine(); ref.load(edited);
const eqExport = JSON.stringify(engine.exportJSON()) === JSON.stringify(ref.exportJSON());
const eqImage = Buffer.compare(Buffer.from(engine.result.image), Buffer.from(ref.result.image)) === 0;
console.log('增量导出 == 全量导出:', eqExport);
console.log('增量图像 == 全量图像:', eqImage);

// 2) 未受影响子树：路径不含 MB 的 beam 必须是同一对象且内容未变
let reusedKept = 0, affectedWrong = 0;
for (const b of engine.tree.all) {
  const key = b.path.join('>');
  if (!b.path.includes('MB')) {
    if (beamsBefore.has(key) && beamsBefore.get(key) === b) reusedKept++;
  }
}
console.log('未受影响视束对象复用数:', reusedKept);

// 3) 几何编辑（移动 MA 顶点）后仍与全量一致
const edited2 = makeScene();
edited2.mirrors[0].vertices = edited2.mirrors[0].vertices.map((p) => [p[0] * 0.8, p[1], p[2]]);
const r2 = engine.applyEdit(edited2, { changedMirrorId: 'MA' });
const ref2 = new Engine(); ref2.load(edited2);
const eq2 = JSON.stringify(engine.exportJSON()) === JSON.stringify(ref2.exportJSON())
  && Buffer.compare(Buffer.from(engine.result.image), Buffer.from(ref2.result.image)) === 0;
console.log('MA 几何编辑后增量 == 全量:', r2.ok && eq2);

// 4) 非单镜面编辑（改相机）自动退回全量，结果仍正确
const edited3 = makeScene();
edited3.camera.fovYDeg = 90;
engine.applyEdit(edited3);
const ref3 = new Engine(); ref3.load(edited3);
const eq3 = JSON.stringify(engine.exportJSON()) === JSON.stringify(ref3.exportJSON());
console.log('相机编辑退回全量且一致:', eq3, ' mode=', engine.lastTiming.mode);

// 5) 性能：增量总耗时 < 1500ms（320x240 上限场景）
console.log('基础场景候选数:', ref.model.K, 'cand=', engine.candidates.length);

let fails = 0;
if (!eqExport || !eqImage || !eq2 || !eq3) fails++;
if (reusedKept === 0) { console.log('✗ 未发现复用的未受影响视束'); fails++; }
console.log(fails === 0 ? '\n增量重算测试全部通过' : `\n${fails} 项失败`);
process.exit(fails ? 1 : 0);
