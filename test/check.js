/* 正确性测试：样例验证 + 暴力对拍 + SOP1 往返 */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'solver.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
}
function drain(gen) { let r; do { r = gen.next(); } while (!r.done); return r.value; }
function planSeq(plan) { return plan.map(st => [st.y0, st.x0, st.y1, st.x1, st.d]); }

// ---------- 1. 样例 ----------
console.log('样例 sparse-overlay.json:');
const sample = require(path.join(__dirname, '..', 'samples', 'sparse-overlay.json'));
{
  const errs = S.validate(sample);
  check(errs.length === 0, '样例校验应通过: ' + errs.join('; '));
  const norm = S.normalize(sample);
  const res = drain(S.createSolver(norm).solve());
  check(res.ok, '样例应有解');
  check(res.totalCost === 28, `样例总代价应为 28，实际 ${res.totalCost}`);
  const seq = planSeq(res.plan);
  const expect = [[1,2,2,3,0],[1,2,2,3,1],[1,3,2,4,1],[1,4,2,5,0]];
  check(JSON.stringify(seq) === JSON.stringify(expect),
    `样例序列应为 ${JSON.stringify(expect)}，实际 ${JSON.stringify(seq)}`);
  // 模拟逐像素复现
  const sim = S.simulate(norm, res.plan);
  for (let f = 1; f <= norm.F; f++) {
    check(sim[f-1].disp.join(',') === norm.T[f].join(','), `第 ${f} 帧显示中画布应等于目标`);
  }
  // SOP1 往返
  const bin = S.buildSOP1(norm, res.plan, sim);
  check(bin.length === 4+2+2+2+3*3 + 4*6 + 4*1, `SOP1 长度应为 ${4+2+2+2+9+24+4}，实际 ${bin.length}`);
  const parsed = S.parseSOP1(bin);
  check(parsed.W === 7 && parsed.H === 4 && parsed.F === 4, 'SOP1 头解析');
  const replay = S.simulateSOP1(parsed);
  for (let f = 1; f <= norm.F; f++) {
    check(replay[f-1].disp.join(',') === norm.T[f].join(','), `SOP1 回放第 ${f} 帧应复现目标`);
  }
  // 暴力对拍
  const bf = S.bruteForce(norm);
  check(bf.ok && bf.cost === res.totalCost, `暴力代价 ${bf.cost} 应等于 DP ${res.totalCost}`);
  check(JSON.stringify(bf.seq) === JSON.stringify(seq), '暴力序列应与 DP 一致');
}

// ---------- 2. 随机小输入对拍 ----------
console.log('随机小输入对拍:');
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function randomInput(rand) {
  const W = 1 + Math.floor(rand() * 6), H = 1 + Math.floor(rand() * 5);
  const ncol = 1 + Math.floor(rand() * 3);
  const F = 1 + Math.floor(rand() * 5);
  const palette = [];
  for (let i = 0; i < ncol; i++) palette.push([Math.floor(rand()*256), Math.floor(rand()*256), Math.floor(rand()*256)]);
  const frames = [];
  for (let f = 0; f < F; f++) {
    const pixels = [];
    for (let y = 0; y < H; y++) {
      const row = [];
      for (let x = 0; x < W; x++) row.push(rand() < 0.35 ? 1 + Math.floor(rand() * ncol) : 0);
      pixels.push(row);
    }
    const nw = 1 + Math.floor(rand() * 4);
    const windows = [];
    for (let i = 0; i < nw; i++) {
      const x0 = Math.floor(rand() * W), y0 = Math.floor(rand() * H);
      const x1 = x0 + 1 + Math.floor(rand() * (W - x0)), y1 = y0 + 1 + Math.floor(rand() * (H - y0));
      windows.push([x0, y0, x1, y1]);
    }
    frames.push({ pixels, windows });
  }
  return { width: W, height: H, palette, frames };
}
{
  let okCnt = 0, failCnt = 0;
  const N = 3000;
  for (let t = 0; t < N; t++) {
    const input = randomInput(rng(t * 7919 + 13));
    const norm = S.normalize(input);
    const r1 = drain(S.createSolver(norm).solve());
    const r2 = S.bruteForce(norm);
    if (r1.ok !== r2.ok) {
      failures++;
      console.error(`  ✗ #${t} 可行性不一致: DP=${r1.ok} 暴力=${r2.ok}`, JSON.stringify(input));
      continue;
    }
    if (!r1.ok) {
      failCnt++;
      check(r1.failFrame === r2.failFrame, `#${t} 最早不可达帧: DP=${r1.failFrame} 暴力=${r2.failFrame}`);
      continue;
    }
    okCnt++;
    if (r1.totalCost !== r2.cost) {
      failures++;
      console.error(`  ✗ #${t} 代价不一致: DP=${r1.totalCost} 暴力=${r2.cost}`, JSON.stringify(input));
      continue;
    }
    const seq = planSeq(r1.plan);
    if (JSON.stringify(seq) !== JSON.stringify(r2.seq)) {
      failures++;
      console.error(`  ✗ #${t} 序列不一致: DP=${JSON.stringify(seq)} 暴力=${JSON.stringify(r2.seq)}`, JSON.stringify(input));
      continue;
    }
    // 模拟验证
    const sim = S.simulate(norm, r1.plan);
    for (let f = 1; f <= norm.F; f++) {
      if (sim[f-1].disp.join(',') !== norm.T[f].join(',')) {
        failures++;
        console.error(`  ✗ #${t} 第 ${f} 帧显示未复现目标`);
        break;
      }
    }
  }
  console.log(`  对拍 ${N} 例：有解 ${okCnt}，不可行 ${failCnt}`);
}

// ---------- 3. 不可达帧检查 ----------
console.log('不可达诊断:');
{
  // 第 2 帧目标像素 (2,1)=1 不在其唯一窗口内；而保留 T1 的画布在 (0,0) 有旧像素
  // （目标为 0，补丁写 0=跳过无法清除）→ 第 2 帧不可达
  const input = {
    width: 3, height: 2, palette: [[10, 20, 30]],
    frames: [
      { pixels: [[1,0,0],[0,0,0]], windows: [[0,0,1,1]] },
      { pixels: [[0,0,0],[0,0,1]], windows: [[0,0,1,1]] },
    ],
  };
  const norm = S.normalize(input);
  const r = drain(S.createSolver(norm).solve());
  check(!r.ok && r.failFrame === 2, `应在第 2 帧不可达，实际 ${JSON.stringify(r.ok ? r : r.failFrame)}`);
  check(r.failStates.length >= 1, '应有可达状态可供检查');
  const bf = S.bruteForce(norm);
  check(!bf.ok && bf.failFrame === 2, '暴力应同样在第 2 帧不可达');
  const diag = S.createSolver(norm).diagnose(r.failStates[0].g, r.failStates[0].wi, 2);
  check(diag.bad >= 0, '诊断应返回坏像素数');
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
