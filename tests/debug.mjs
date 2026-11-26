// 详细诊断：全部候选视束、像素类型直方图、关键像素光路
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';

const path = process.argv[2];
const scene = JSON.parse(readFileSync(path, 'utf8'));
const engine = new Engine();
const r = engine.load(scene);
if (!r.ok) { console.log(r.errors); process.exit(1); }

console.log('## 全部候选反射视束（含未选中）');
const all = engine.tree.all.slice(1).sort((a, b) => String(a.path).localeCompare(String(b.path)));
for (const b of all) {
  const sel = engine.activeSet.has(b);
  console.log(`  [${sel ? 'x' : ' '}] [${b.path.join(',')}] d=${b.depth} score=${b.score} screenArea=${b.screenArea.toFixed(2)} luma=${b.luma.toFixed(4)} R=${b.R.map((x) => x.toFixed(3)).join('/')}`);
}

const { width, height } = engine.model;
const hist = new Map();
let nEmpty = 0;
for (let j = 0; j < height; j++) {
  for (let i = 0; i < width; i++) {
    const tr = engine.result.pixelInfo[j * width + i];
    if (!tr.length) { nEmpty++; continue; }
    const key = tr.map((x) => (x.kind === 'mirror' ? `M:${x.mirrorId}` : `T:${x.triangleId}`)).join('>');
    hist.set(key, (hist.get(key) || 0) + 1);
  }
}
console.log(`\n## 像素光路直方图（画布 ${width}x${height}, 空像素=${nEmpty}）`);
for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(6)}  ${k}`);

console.log('\n## 中心区域关键像素');
for (const [i, j] of [[width >> 1, height >> 1], [width >> 1, height >> 2], [width >> 1, (3 * height) >> 2], [width >> 2, height >> 1], [(3 * width) >> 2, height >> 1]]) {
  const tr = engine.result.pixelInfo[j * width + i];
  console.log(`  px(${i},${j}):`, tr.length ? tr.map((x) =>
    `${x.kind}${x.kind === 'mirror' ? x.mirrorId : '#' + x.triangleId}@d${x.depth} z=${x.z.toFixed(4)}`).join(' -> ') : '(空)');
}
