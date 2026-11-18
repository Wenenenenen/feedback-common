/*
 * tests/export-all.js — 用网页同款核心模块对样例目录全部合法场景求交，
 * 导出 crosscheck 可读的 results JSON，供独立 Python 实现逐条比对。
 * 运行：node tests/export-all.js <样例目录> <输出文件>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SdfValidate = require('../app/validate.js');
const Sdf = require('../app/sdf.js');
const RayMarch = require('../app/raymarch.js');

const caseDir = process.argv[2];
const outFile = process.argv[3];
if (!caseDir || !outFile) {
  console.error('用法: node tests/export-all.js <样例目录> <输出文件>');
  process.exit(2);
}

const results = {};
for (const fname of fs.readdirSync(caseDir).sort()) {
  if (!fname.endsWith('.json') || fname === 'reference.json') continue;
  const scene = JSON.parse(fs.readFileSync(path.join(caseDir, fname), 'utf8'));
  const v = SdfValidate.validateScene(scene);
  if (!v.ok) continue; // 非法场景由校验测试覆盖
  const tree = Sdf.compile(scene);
  const key = fname.slice(0, -5);
  results[key] = {};
  for (const ray of scene.rays) {
    results[key][ray.id] = RayMarch.trace(tree, ray, {});
  }
}
fs.writeFileSync(outFile, JSON.stringify({ results }));
console.log(`已导出 ${Object.values(results).reduce((n, r) => n + Object.keys(r).length, 0)} 条射线结果到 ${outFile}`);
