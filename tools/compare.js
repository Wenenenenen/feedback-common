#!/usr/bin/env node
// Node 侧执行 JS 引擎，与 Python 参考结果逐分量比对（容差 1e-6）。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const QuadEngine = require(path.join(__dirname, '..', 'engine.js'));

const caseDir = process.argv[2];
const onlyStress = process.argv.includes('--stress-only');
const TOL = 1e-6;

function compare(name, js, py) {
  const fails = [];
  const frJ = js.frame, frP = py.frame;
  if (frJ.rgb.length !== frP.rgb.length) fails.push(`rgb length ${frJ.rgb.length} vs ${frP.rgb.length}`);
  let maxErr = 0;
  const n = Math.min(frJ.rgb.length, frP.rgb.length);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(frJ.rgb[i] - frP.rgb[i]);
    if (e > maxErr) maxErr = e;
    if (e > TOL) { if (fails.length < 5) fails.push(`rgb[${i}] ${frJ.rgb[i]} vs ${frP.rgb[i]} (Δ=${e})`); }
  }
  for (let i = 0; i < frJ.alpha.length; i++) {
    if (frJ.alpha[i] !== frP.alpha[i]) { if (fails.length < 5) fails.push(`alpha[${i}] ${frJ.alpha[i]} vs ${frP.alpha[i]}`); }
    if (frJ.winLane[i] !== frP.winLane[i]) { if (fails.length < 5) fails.push(`winLane[${i}] ${frJ.winLane[i]} vs ${frP.winLane[i]}`); }
  }
  for (let i = 0; i < js.discard.length; i++) {
    if (js.discard[i] !== py.discard[i]) { if (fails.length < 5) fails.push(`discard[${i}] ${js.discard[i]} vs ${py.discard[i]}`); }
  }
  if (js.texLogs.length !== py.texLogs.length) fails.push(`texLogs count ${js.texLogs.length} vs ${py.texLogs.length}`);
  let maxLod = 0, maxRes = 0;
  for (let t = 0; t < Math.min(js.texLogs.length, py.texLogs.length); t++) {
    const jl = js.texLogs[t], pl = py.texLogs[t];
    if (jl.line !== pl.line) fails.push(`texLog[${t}] line mismatch`);
    for (let g = 0; g < jl.lod.length; g++) {
      const e1 = Math.abs(jl.lod[g] - pl.lod[g]);
      if (e1 > maxLod) maxLod = e1;
      if (e1 > TOL) { if (fails.length < 5) fails.push(`lod[${t}][${g}] ${jl.lod[g]} vs ${pl.lod[g]}`); }
      if (jl.result) {
        const e2 = Math.abs(jl.result[g] - pl.result[g]);
        if (e2 > maxRes) maxRes = e2;
        if (e2 > TOL) { if (fails.length < 5) fails.push(`res[${t}][${g}] ${jl.result[g]} vs ${pl.result[g]}`); }
      }
    }
  }
  return { name, ok: fails.length === 0, fails, maxErr, maxLod, maxRes, lanes: js.discard.length };
}

const files = fs.readdirSync(caseDir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.py.json'))
  .sort();
let passed = 0, failed = 0;
for (const file of files) {
  const isStress = file === 'stress.json';
  if (onlyStress && !isStress) continue;
  if (!onlyStress && isStress) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(caseDir, file), 'utf8'));
  const tParse0 = performance.now();
  const t0 = performance.now();
  const res = QuadEngine.validateAndRun(pkg);
  const tJs = performance.now() - t0;
  const tParse = t0 - tParse0;
  if (!res.ok) {
    console.log(`FAIL ${file}: 引擎报错 ${JSON.stringify(res.errors)}`);
    failed++;
    continue;
  }
  const py = spawnSync('python3', ['-I', path.join(__dirname, 'reference.py'), path.join(caseDir, file)],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 * 1024 });
  if (py.status !== 0) {
    console.log(`FAIL ${file}: python 参考实现出错\n${py.stderr}`);
    failed++;
    continue;
  }
  const pyOut = JSON.parse(py.stdout);
  const cmp = compare(file.replace('.json', ''), res.state, pyOut);
  if (cmp.ok) {
    passed++;
    console.log(`PASS ${cmp.name.padEnd(16)} lanes=${cmp.lanes.toString().padStart(8)} ` +
      `maxRgbErr=${cmp.maxErr.toExponential(2)} maxLodErr=${cmp.maxLod.toExponential(2)} ` +
      `maxResErr=${cmp.maxRes.toExponential(2)} jsEngine=${tJs.toFixed(1)}ms parse=${tParse.toFixed(1)}ms`);
  } else {
    failed++;
    console.log(`FAIL ${file}\n  ${cmp.fails.join('\n  ')}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
