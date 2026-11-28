// tools/benchmark.mjs —— 满额纹样端到端性能基准
// 用法：node tools/generate-benchmark.mjs > /tmp/woven-full.json 2>/dev/null
//      node tools/benchmark.mjs /tmp/woven-full.json
import fs from 'node:fs';
import { buildModel } from '../src/model.js';
import { solve } from '../src/solver.js';
import { computeRetained } from '../src/gaps.js';
import { exportSVG } from '../src/svg.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/benchmark.mjs <data.json>');
  process.exit(1);
}

const t0 = performance.now();
const text = fs.readFileSync(file, 'utf8');
const data = JSON.parse(text);
const tParse = performance.now();

const model = buildModel(data);
const tModel = performance.now();

const pinMap = new Map(model.pins.map((p) => [p.cid, p.above]));
const result = solve(model, pinMap);
const tSolve = performance.now();

const retained = computeRetained(model, result.above);
const tGap = performance.now();

const svg = exportSVG(model, retained);
const tSvg = performance.now();

const segCount = model.strands.reduce(
  (n, s) => n + (s.closed ? s.points.length : s.points.length - 1), 0,
);
const keptPaths = [...retained.values()].reduce((n, p) => n + p.length, 0);

console.log(JSON.stringify({
  线条数: model.strands.length,
  线段数: segCount,
  交点数: model.crossings.length,
  矛盾数: result.conflictCount,
  保留折线段数: keptPaths,
  SVG字节: svg.length,
  阶段毫秒: {
    解析: +(tParse - t0).toFixed(1),
    建模求交: +(tModel - tParse).toFixed(1),
    求解: +(tSolve - tModel).toFixed(1),
    缺口: +(tGap - tSolve).toFixed(1),
    SVG: +(tSvg - tGap).toFixed(1),
  },
  总毫秒: +(tSvg - t0).toFixed(1),
  达标10秒: (tSvg - t0) < 10000,
}, null, 2));
