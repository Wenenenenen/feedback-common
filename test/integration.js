/* 集成测试：模拟页面完整工作流（编辑窗口→重算对比、不可达诊断、SOP1 导出→导入回放校验） */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'solver.js'));

let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } }
function drain(gen) { let r; do { r = gen.next(); } while (!r.done); return r.value; }

// 1. 加载样例 → 求解 → 导出 SOP1 → 重新导入回放 → 逐像素校验
console.log('工作流 1：求解 → 导出 → 导入回放');
const sample = require(path.join(__dirname, '..', 'samples', 'sparse-overlay.json'));
const norm = S.normalize(sample);
const solver = S.createSolver(norm);
const sol = drain(solver.solve());
check(sol.ok && sol.totalCost === 28, `求解成功，总代价 ${sol.totalCost}`);
const sim = S.simulate(norm, sol.plan);
const bin = S.buildSOP1(norm, sol.plan, sim);
const parsed = S.parseSOP1(bin);
const replayFrames = S.simulateSOP1(parsed);
let allOk = true;
for (let f = 1; f <= norm.F; f++) if (replayFrames[f-1].disp.join(',') !== norm.T[f].join(',')) allOk = false;
check(allOk, 'SOP1 回放逐像素复现目标');
check(parsed.records.every((r, i) => r.d === sol.plan[i].d && r.x0 === sol.plan[i].x0 && r.y0 === sol.plan[i].y0),
  '回放的窗口与处置序列与方案一致');

// 2. 修改候选窗口 → 重算 → 比较前后码量
console.log('工作流 2：编辑候选窗口 → 重算对比');
// 把第 3 帧的 1×1 窗口改成 2×2，重算代价应变化（或不可行）
norm.windows[3].push({ x0: 2, y0: 0, x1: 5, y1: 3, area: 9 });
const sol2 = drain(S.createSolver(norm).solve());
check(sol2.ok, '重算后仍有解');
check(sol2.totalCost !== undefined && sol2.totalCost >= 28 - 6 * 4, `重算代价 ${sol2.totalCost}（原 28）`);
console.log(`  码量对比：${sol.totalCost} → ${sol2.totalCost}（Δ ${sol2.totalCost - sol.totalCost}）`);
// 删掉所有小窗口只留全屏，代价应变大
const norm2 = S.normalize(sample);
norm2.windows = norm2.windows.map(ws => ws.filter(w => w.area === 28));
const sol3 = drain(S.createSolver(norm2).solve());
check(sol3.ok && sol3.totalCost > sol.totalCost, `只留全屏窗口代价 ${sol3.totalCost} > ${sol.totalCost}`);

// 3. 不可行输入 → 最早不可达帧 → 检查前一帧可达画布
console.log('工作流 3：不可达诊断');
{
  const input = {
    width: 4, height: 3, palette: [[1, 2, 3], [4, 5, 6]],
    frames: [
      { pixels: [[1,0,0,0],[0,0,0,0],[0,0,0,0]], windows: [[0,0,1,1]] },
      { pixels: [[1,0,0,0],[0,2,0,0],[0,0,0,0]], windows: [[1,1,2,2]] },
      { pixels: [[0,0,0,0],[0,0,0,0],[0,0,0,0]], windows: [[1,1,2,2]] },
    ],
  };
  const n3 = S.normalize(input);
  const sv = S.createSolver(n3);
  const r = drain(sv.solve());
  // 第 2 帧：旧像素 (0,0)=1 目标为 1，(1,1)=2 在窗口内可写 → 可达；
  // 第 3 帧：目标全 0，第 2 帧后画布在 (0,0)/(1,1) 有非 0，窗口 [1,1,2,2] 清不到 (0,0) → 不可达
  check(!r.ok && r.failFrame === 3, `最早不可达帧 = ${r.failFrame}（期望 3）`);
  check(r.failStates.length > 0, `前一帧可达状态 ${r.failStates.length} 个`);
  // 检查每个可达画布：stateCanvas 应与模拟一致（这里验证清零逻辑）
  const c0 = sv.stateCanvas(0, -1);
  check(c0.every(v => v === 0), '状态 (0,-1) 为起始全 0 画布');
  const c1 = sv.stateCanvas(1, 0);
  check(c1[0] === 0, '状态 (1,0)：第 1 帧目标经窗口 0 清零后 (0,0) 为 0');
  const c2 = sv.stateCanvas(2, -1);
  check(c2[0] === 1 && c2[5] === 2, '状态 (2,-1) 为第 2 帧目标画布');
  // 诊断：每个状态都应给出原因
  const diag = sv.diagnose(r.failStates[0].g, r.failStates[0].wi, 3);
  check(diag.bad > 0 || !diag.covered, `诊断给出原因：bad=${diag.bad} covered=${diag.covered}`);
}

console.log(failures === 0 ? '\n集成测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
