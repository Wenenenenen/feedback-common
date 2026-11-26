// 集成检查：app 目录的全部模块可加载，应用将用到的引擎流程在三个样例上跑通
import { Engine } from '../app/engine.js';
import { History } from '../app/state.js';
import { SAMPLES } from '../app/samples.js';

let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.log('✗', msg); fails++; } };

for (const [name, scene] of Object.entries(SAMPLES)) {
  const engine = new Engine();
  const r = engine.load(scene);
  assert(r.ok, `${name} 载入失败 ${JSON.stringify(r.errors)}`);
  assert(engine.tree.all.length > 1, `${name} 应展开出反射视束`);
  assert(typeof engine.totalScore === 'number', `${name} 总分应为数字`);
  const exp = engine.exportJSON();
  const keys = ['sceneId', 'maxBounceDepth', 'beamBudgetK', 'candidateBeamCount',
    'selectedBeamCount', 'totalSelectedScore', 'selectedBeams'];
  assert(keys.every((k) => k in exp), `${name} 导出字段缺失`);
  assert(exp.candidateBeamCount === engine.candidates.length, `${name} 候选数一致`);
  assert(exp.selectedBeamCount === engine.activeSet.size, `${name} 选中数一致`);
  // 路径字典序排列
  const paths = exp.selectedBeams.map((b) => b.path.join('>'));
  assert(paths.every((p, i) => i === 0 || paths[i - 1] <= p), `${name} 导出按路径字典序`);
  // 像素拾取
  const pick = engine.pickPixel(2, 2);
  assert(pick && Array.isArray(pick.trace), `${name} 像素拾取返回光路数组`);
  // 历史栈
  const hist = new History(engine.scene);
  assert(hist.canUndo === false && hist.canRedo === false, `${name} 初始历史栈状态`);
  const edited = JSON.parse(JSON.stringify(engine.scene));
  edited.mirrors[0].reflectance = [0.5, 0.5, 0.5];
  const er = engine.applyEdit(edited, { changedMirrorId: edited.mirrors[0].id });
  assert(er.ok, `${name} 合法镜面编辑`);
  hist.push(engine.scene);
  assert(hist.canUndo && !hist.canRedo, `${name} 入栈后可撤销`);
  const undone = hist.undo();
  assert(undone.beamBudgetK === scene.beamBudgetK, `${name} 撤销恢复旧场景`);
  assert(hist.canRedo, `${name} 撤销后可重做`);
  hist.redo();
  assert(hist.current.mirrors[0].reflectance[0] === 0.5, `${name} 重做恢复编辑`);
}

// 非法编辑保留原场景（应用 showError 依赖结构化 errors）
const engine = new Engine();
engine.load(SAMPLES.case1_single_mirror);
const goodExport = JSON.stringify(engine.exportJSON());
const bad = JSON.parse(JSON.stringify(SAMPLES.case1_single_mirror));
bad.mirrors[0].vertices[2][2] = 0.7;
const rejected = engine.applyEdit(bad);
assert(!rejected.ok && rejected.errors[0].id === 'M_front', '非法编辑返回镜面编号');
assert(JSON.stringify(engine.exportJSON()) === goodExport, '非法编辑后原场景保留');

console.log(fails === 0 ? '应用集成检查全部通过（3 样例 × 载入/导出/拾取/历史 + 拒绝保留）' : `${fails} 项失败`);
process.exit(fails ? 1 : 0);
