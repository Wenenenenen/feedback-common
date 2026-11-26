// 对指定 fiber-directors JSON 跑完整建模 + 全局优化并打印结构。
//   node test/run-samples.mjs [path/to/file.json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDirectorJSON, buildModel, solveModel, edgeDetail, buildSymbolRows, buildExportBundle,
} from '../js/directors.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] || join(__dir, '..', 'samples', 'fiber-directors.json');
const raw = JSON.parse(readFileSync(arg, 'utf8'));
const { doc, errors } = parseDirectorJSON(JSON.stringify(raw));
if (errors.length) {
  console.error('校验失败：');
  for (const e of errors) console.error(' -', e.path, e.message);
  process.exit(1);
}
const model = buildModel(doc);
const sol = solveModel(model);
const symbols = buildSymbolRows(model, sol.flips);

console.log('文件:', arg);
console.log(`网格: ${model.width}x${model.height}  有效格=${model.activeIds.length}  空格=${model.size - model.activeIds.length}  连接边=${model.edges.length}  分量=${model.components.length}`);
console.log('全局违反总代价 =', sol.totalCost, ' 引擎 =', sol.engine);
console.log('\n符号图：');
console.log(symbols.glyphText);
console.log('\n正负号图（+ 保持 / − 翻转 / · 空格）：');
console.log(symbols.signText);

for (const cs of sol.components) {
  const comp = model.components[cs.component];
  console.log(`\n分量 ${cs.key}: ${comp.nodes.length} 格, root=(${comp.rootXY.x},${comp.rootXY.y}), ` +
    `面=${cs.faceCount}, 缺陷面=${cs.defectCount}, 违反边=${cs.violated.length}, 代价=${cs.cost}`);
  for (const eid of cs.violated) {
    const d = edgeDetail(model, sol.flips, eid);
    console.log(`  ✕ 边(${d.ax},${d.ay})-(${d.bx},${d.by}) dot=${d.dot} ${d.preference} ` +
      `flip=${d.flipA}/${d.flipB} ${d.actualRelation} weight=${d.weight} cost=${d.chargedCost}`);
  }
}

const bundle = buildExportBundle(model, sol, { effective: new Map() }, []);
console.log('\n导出摘要 totals =', JSON.stringify(bundle.totals));
