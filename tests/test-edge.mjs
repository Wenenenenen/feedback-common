// 边界与物理正确性：bounce=0、停用镜面、镜背几何剔除、K=1、双面三角形
import { Engine } from '../src/engine.js';

let fails = 0;
const assert = (c, m) => { if (!c) { console.log('✗', m); fails++; } else console.log('✓', m); };

const base = JSON.parse(JSON.stringify((await import('../app/samples.js')).SAMPLES.case1_single_mirror));

// 1) bounce=0：无反射视束，仅主视锥三角形
{
  const s = JSON.parse(JSON.stringify(base)); s.maxBounceDepth = 0;
  const e = new Engine(); e.load(s);
  assert(e.candidates.length === 0, 'bounce=0 候选视束为 0');
  let mirrorHits = 0;
  for (const tr of e.result.pixelInfo) for (const st of tr) if (st.kind === 'mirror') mirrorHits++;
  assert(mirrorHits === 0, 'bounce=0 无任何镜面像素');
}

// 2) 停用唯一镜面：等同无镜面
{
  const s = JSON.parse(JSON.stringify(base)); s.mirrors[0].enabled = false;
  const e = new Engine(); e.load(s);
  assert(e.candidates.length === 0, '停用镜面后无候选视束');
}

// 3) 镜背后几何剔除：在镜面背面（z<0 一侧，相机在 z=5）放一个三角形，反射视束中不得出现
{
  const s = JSON.parse(JSON.stringify(base));
  // 镜面在 z=0，法线 +z；镜背即 z<0。加一个位于 z=-0.5、朝向 +z 的三角形（朝镜背）
  const o = s.vertices.length;
  s.vertices.push([-0.5, 1.0, -0.5], [0.5, 1.0, -0.5], [0, 2.0, -0.5]);
  s.triangles.push({ id: 99, indices: [o, o + 1, o + 2], color: [0.1, 0.1, 0.9], singleSided: false });
  const e = new Engine(); e.load(s);
  let behindVisible = 0;
  for (const tr of e.result.pixelInfo) {
    // 反射光路中命中 99 即镜背泄漏
    if (tr.some((st) => st.kind === 'triangle' && st.triangleId === 99 && st.depth >= 1)) behindVisible++;
  }
  assert(behindVisible === 0, '镜背后三角形在反射视束中被斜近裁面剔除（0 像素泄漏）');
}

// 4) K=1 强制配额：只激活 1 条，且为得分最高的深度1视束
{
  const s = JSON.parse(JSON.stringify((await import('../app/samples.js')).SAMPLES.case2_periscope_relay));
  s.beamBudgetK = 1;
  const e = new Engine(); e.load(s);
  assert(e.activeSet.size === 1, 'K=1 恰好激活 1 条视束');
  const only = [...e.activeSet][0];
  const d1 = e.candidates.filter((b) => b.depth === 1);
  assert(only.depth === 1 && only.score === Math.max(...d1.map((b) => b.score)), 'K=1 选取得分最高的深度1视束');
}

// 5) 双面三角形在奇数次反射下不被绕序剔除。
//    镜前 z=1.5 放法线 +z 的三角；虚相机在镜后 z<0，它背对虚相机。
//    单面应在 d=1 被朝向剔除，双面应在 d=1 绘制（两者都能过斜近裁面，差异仅来自绕序）。
{
  const s = JSON.parse(JSON.stringify(base));
  const o = s.vertices.length;
  s.vertices.push([-0.7, 0.8, 1.5], [0.7, 0.8, 1.5], [0, 2.0, 1.5]);
  s.triangles.push({ id: 77, indices: [o, o + 1, o + 2], color: [0.1, 0.1, 0.9], singleSided: false });

  const eDouble = new Engine(); eDouble.load(s);
  const d1beam = eDouble.tree.all.find((b) => b.depth === 1);
  const d1buf = eDouble.result.buffers.get(d1beam);
  let seenDouble = 0;
  for (const c of d1buf) {
    if (c && c.kind === 'tri' && c.tri.id === 77) seenDouble++;
  }
  assert(seenDouble > 0, '双面三角背对虚相机时在 d=1 视束缓冲中绘制（绕序不剔除双面）');

  const s2 = JSON.parse(JSON.stringify(s));
  s2.triangles.find((t) => t.id === 77).singleSided = true;
  const eSingle = new Engine(); eSingle.load(s2);
  const d1bufS = eSingle.result.buffers.get(eSingle.tree.all.find((b) => b.depth === 1));
  let seenSingle = 0;
  for (const c of d1bufS) {
    if (c && c.kind === 'tri' && c.tri.id === 77) seenSingle++;
  }
  assert(seenSingle === 0, '同位置单面三角背对虚相机时在 d=1 视束缓冲中被朝向剔除');
}

// 6) 单面三角形在奇数次反射的翻转：红三角（id=1，朝 -z）主视锥不可见、镜中可见
{
  const e = new Engine(); e.load(base);
  let redDirect = 0, redMirror = 0;
  for (const tr of e.result.pixelInfo) {
    for (const st of tr) {
      if (st.kind === 'triangle' && st.triangleId === 1) {
        if (st.depth === 0) redDirect++; else redMirror++;
      }
    }
  }
  assert(redDirect === 0, '朝 -z 单面红三角在主视锥被背面剔除');
  assert(redMirror > 0, '同一红三角在 d=1 反射中翻转后可见');
}

console.log(fails === 0 ? '\n边界/物理测试全部通过' : `\n${fails} 项失败`);
process.exit(fails ? 1 : 0);
