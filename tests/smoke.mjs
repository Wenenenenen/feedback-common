// 冒烟测试：跑三个样例，输出视束/配额/时序与像素抽样
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';

const cases = process.argv.slice(2);
const engine = new Engine();

for (const path of cases) {
  const scene = JSON.parse(readFileSync(path, 'utf8'));
  const r = engine.load(scene);
  console.log('='.repeat(72));
  console.log('CASE', scene.sceneId, path);
  if (!r.ok) {
    console.log('LOAD REJECTED:');
    for (const e of r.errors) console.log('  -', `[${e.kind}:${e.id}]`, e.reason);
    continue;
  }
  const t = engine.lastTiming;
  console.log(`candidates=${t.candidateCount} selected=${t.selectedCount} K=${engine.model.K}`);
  console.log(`timing ms: model=${t.modelMs.toFixed(2)} expand=${t.expandMs.toFixed(2)} budget=${t.budgetMs.toFixed(2)} render=${t.renderMs.toFixed(2)} total=${t.totalMs.toFixed(2)}`);
  const exp = engine.exportJSON();
  console.log('totalSelectedScore =', exp.totalSelectedScore);
  for (const b of exp.selectedBeams) {
    console.log(`  beam path=[${b.path.join(',')}] depth=${b.depth} score=${b.score} eye=${b.virtualEye.map((x) => x.toFixed(3)).join('/')} polyVerts=${b.clippedPolygon.length}`);
  }
  // 非空像素抽样
  const { width, height } = engine.model;
  let nonEmpty = 0;
  const sampleTraces = [];
  for (let j = 0; j < height; j += Math.max(1, Math.floor(height / 8))) {
    for (let i = 0; i < width; i += Math.max(1, Math.floor(width / 8))) {
      const info = engine.pickPixel(i, j);
      if (info.trace.length > 0) {
        nonEmpty++;
        if (sampleTraces.length < 4) sampleTraces.push(info);
      }
    }
  }
  console.log('sampled non-empty pixels:', nonEmpty);
  for (const s of sampleTraces) {
    console.log(`  px(${s.pixel[0]},${s.pixel[1]}):`, s.trace.map((x) =>
      x.kind === 'mirror' ? `mirror ${x.mirrorId}@d${x.depth} z=${x.z.toFixed(3)}` : `tri#${x.triangleId}@d${x.depth} z=${x.z.toFixed(3)}`).join(' -> '));
  }
}
