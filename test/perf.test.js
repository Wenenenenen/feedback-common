/* 满额性能测试：node test/perf.test.js（预算：导入到可检查碎片 <= 12 秒） */
'use strict';
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'js', 'geom', 'exact.js'));
require(path.join(__dirname, '..', 'js', 'geom', 'intersect.js'));
const C = require(path.join(__dirname, '..', 'js', 'geom', 'cage.js'));
const F = require(path.join(__dirname, '..', 'js', 'geom', 'fragmenter.js'));

const file = process.argv[2] || path.join(__dirname, '..', 'samples', 'perf-full.json');
const tImport0 = process.hrtime.bigint();
const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);
const tImport1 = process.hrtime.bigint();

const t0 = process.hrtime.bigint();
const vRest = C.validateCage(data.rest, data.cells);
const t1 = process.hrtime.bigint();
const transforms = C.cellTransforms(data.rest, data.pose || data.rest, data.cells);
const t2 = process.hrtime.bigint();
const result = F.fragmentModel(data, transforms);
const t3 = process.hrtime.bigint();

const ms = (a, b) => Number(b - a) / 1e6;
const totalMs = ms(tImport0, t3);
console.log(JSON.stringify({
  file: path.basename(file),
  bytes: raw.length,
  verts: data.rest.length,
  cells: data.cells.length,
  inputFaces: data.faces.length,
  importMs: ms(tImport0, tImport1).toFixed(1),
  validateMs: ms(t0, t1).toFixed(1),
  transformMs: ms(t1, t2).toFixed(1),
  fragmentMs: ms(t2, t3).toFixed(1),
  totalMs: totalMs.toFixed(1),
  fragments: result.fragments.length,
  uniqueVerts: result.globalVerts.length,
  badFaces: result.badFaces.length,
  budget12s: totalMs <= 12000 ? 'PASS' : 'FAIL',
  cageBad: vRest.badCells.length,
}, null, 2));

process.exit(totalMs <= 12000 && result.badFaces.length === 0 && vRest.badCells.length === 0 ? 0 : 1);
