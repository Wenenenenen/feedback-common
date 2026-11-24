#!/usr/bin/env node
// 压力计时：25 万组 × 48 指令（含采样），测量解析、构建、执行全链路。
const fs = require('fs');
const path = require('path');
const QuadEngine = require(path.join(__dirname, '..', 'engine.js'));

const file = process.argv[2] || path.join(__dirname, 'cases', 'stress.json');
const raw = fs.readFileSync(file, 'utf8');
const tParse0 = performance.now();
const pkg = JSON.parse(raw);
const tParse = performance.now() - tParse0;
console.log(`quads=${pkg.quads.length} insns=${pkg.program.length} texInsns=${pkg.program.filter((i) => i[0] === '纹理').length} file=${(raw.length / 1e6).toFixed(1)}MB`);

const t0 = performance.now();
const res = QuadEngine.validateAndRun(pkg);
const wall = performance.now() - t0;
if (!res.ok) {
  console.error('引擎报错:', JSON.stringify(res.errors, null, 2));
  process.exit(1);
}
const { state } = res;
let coveredPx = 0;
for (let i = 0; i < state.frame.alpha.length; i++) if (state.frame.alpha[i]) coveredPx++;
const mem = process.memoryUsage();
console.log(`parse=${tParse.toFixed(0)}ms build=${res.timings.build.toFixed(0)}ms run=${res.timings.run.toFixed(0)}ms total(wall)=${wall.toFixed(0)}ms`);
console.log(`覆盖像素=${coveredPx}/${state.W * state.H} texLogs=${state.texLogs.length} logBudgetOk=${state.logBudgetOk}`);
console.log(`heapUsed=${(mem.heapUsed / 1e6).toFixed(0)}MB rss=${(mem.rss / 1e6).toFixed(0)}MB`);

// 导出校验：f32 往返
const rgba = QuadEngine.exportRGBAf32(state);
const dv = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength);
let maxExportErr = 0;
for (let p = 0; p < state.W * state.H; p++) {
  for (let c = 0; c < 3; c++) {
    const e = Math.abs(dv.getFloat32((4 * p + c) * 4, true) - state.frame.rgb[3 * p + c]);
    if (e > maxExportErr) maxExportErr = e;
  }
  if (dv.getFloat32((4 * p + 3) * 4, true) !== state.frame.alpha[p]) throw new Error('alpha 导出不一致');
}
console.log(`导出 RGBAf32=${rgba.length} 字节, 分量最大舍入误差=${maxExportErr.toExponential(2)}`);
if (wall > 10000) { console.error('超出 10 秒预算'); process.exit(2); }
console.log('OK: 10 秒预算内出现可检查画面');
