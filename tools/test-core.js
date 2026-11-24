/*
 * 核心测试（Node，零依赖；只用 node:test 的等价自写断言）。
 * 运行：node tools/test-core.js
 *
 * 覆盖：跟踪约定与隐藏用例、QP 唯一最优（隐藏用例 + 穷举 + 参考对照 + KKT）、
 * 参数冲突分类、裁剪逐字节对照、PNM/ZIP 读写与防护、1800 帧性能预算。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QP = require('../js/qp.js');
const TRACK = require('../js/tracking.js');
const FIT = require('../js/fit.js');
const CROP = require('../js/crop.js');
const PNM = require('../js/pnm.js');
const ZIP = require('../js/zip.js');

const ROOT = path.resolve(__dirname, '..');
const REF = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'reference.json'), 'utf8'));

let passed = 0;
let failed = 0;
const failures = [];

function check(cond, label, detail) {
  if (cond) { passed++; return true; }
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function near(a, b, tol, label) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  return check(ok, label, ok ? '' : `期望 ${b}，实际 ${a}（差 ${Math.abs(a - b)}）`);
}
function section(name) { console.log(`\n— ${name}`); }

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function medianOf(arr) { return TRACK.median(arr); }

/* ------------------------------------------------------------------ tracking */

async function loadSample() {
  const buf = fs.readFileSync(path.join(ROOT, 'samples', 'stabilized-aperture-cases.zip'));
  const files = await ZIP.unzip(buf);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  const frames = [];
  for (const name of manifest.frames) {
    const dec = PNM.decodePnm(files.get(name));
    frames.push(dec);
  }
  return { manifest, frames, files };
}

function baseManifest(over) {
  return {
    frames: ['a', 'b', 'c', 'd', 'e'],
    pairs: [[], [[0, 0, 1, 0], [5, 5, 6, 5], [9, 9, 10, 9]], [], [], []],
    cuts: [], threshold: 0,
    crop: [4, 4], margin: 0, pins: [], lambda: 0,
    ...over,
  };
}

async function testTracking(sample) {
  section('跟踪');
  const parsed = TRACK.parseManifest(sample.manifest,
    sample.frames.map((f) => ({ width: f.width, height: f.height })));
  check(parsed.ok, 'manifest 校验通过', parsed.errors.map((e) => e.message).join(';'));
  const tr = TRACK.track(parsed.manifest);
  const refCase = REF.cases.find((c) => c.name === 'sample-default');
  check(tr.p[0].length === sample.manifest.frames.length, '逐帧轨迹长度等于帧数');
  for (let t = 0; t < tr.p[0].length; t++) {
    near(tr.p[0][t], refCase.p[0][t], 1e-12, `轨迹 p_x[${t}] 与参考一致`);
    near(tr.p[1][t], refCase.p[1][t], 1e-12, `轨迹 p_y[${t}] 与参考一致`);
  }
  check(tr.shots.length === 1 && tr.shots[0].start === 0 && tr.shots[0].end === 6, '样例为单镜头 0..6');
  check(medianOf([1, 2, 3, 4]) === 2.5, '偶数中位数取两中值平均');
  check(medianOf([3, 1, 2]) === 2, '奇数中位数');

  // 隐藏验收用例：位移 (1,0)、(1,0)、(2,1)、(100,100)，门限 1 → 剔除最后一组，重算位移 (1,0)
  {
    const man = baseManifest({
      frames: ['a', 'b', 'c', 'd'],
      pairs: [
        [],
        [[0, 0, 1, 0], [10, 10, 11, 10], [20, 20, 21, 20]],
        [[0, 0, 1, 0], [10, 10, 11, 10], [20, 20, 22, 21], [30, 30, 130, 130]],
        [[0, 0, 1, 0], [10, 10, 11, 10], [20, 20, 21, 21]],
      ],
      threshold: 1,
    });
    const r = TRACK.parseManifest(man);
    check(r.ok, '离群用例 manifest 合法', r.errors.map((e) => e.message).join(';'));
    const t = TRACK.track(r.manifest);
    near(t.p[0][1], 1, 1e-12, '第 1 帧 x 位移 1');
    near(t.p[1][1], 0, 1e-12, '第 1 帧 y 位移 0');
    near(t.p[0][2], 2, 1e-12, '第 2 帧剔除 (100,100) 后 x 累计 2');
    near(t.p[1][2], 0, 1e-12, '第 2 帧剔除 (100,100) 后 y 累计 0');
    check(t.inlierCounts[2] === 3, '第 2 帧内点为 3 组');
  }

  // 隐藏验收用例：位移 (1,0)、(1,0)、(2,1)、(100,100)，门限 1
  {
    const man = baseManifest({
      frames: ['a', 'b'],
      pairs: [[], [[0, 0, 1, 0], [10, 10, 11, 10], [20, 20, 22, 21], [30, 30, 130, 130]]],
      threshold: 1,
    });
    const t = TRACK.track(TRACK.parseManifest(man).manifest);
    near(t.p[0][1], 1, 1e-12, '隐藏用例：剔除 (100,100) 后重算 dx=1');
    near(t.p[1][1], 0, 1e-12, '隐藏用例：剔除 (100,100) 后重算 dy=0');
    check(t.inlierCounts[1] === 3, '隐藏用例：内点 3 组');
  }

  // 内点不足三组 → 另起镜头，p 置零；随后显式切点同样另起镜头且累计轨迹归零
  {
    const man = baseManifest({
      frames: ['a', 'b', 'c', 'd', 'e', 'f'],
      pairs: [
        [],
        [[0, 0, 2, 0], [5, 5, 7, 5], [9, 9, 11, 9]], // p=2（各点 dx=2,dy=0）
        [[0, 0, 1, 0], [5, 5, 6, 0]],                // 只有 2 组 → 弱帧/新镜头
        [[0, 0, 3, 0], [5, 5, 8, 5], [9, 9, 12, 9]], // 新镜头首段 p=3（全部 dx=3,dy=0）
        [[0, 0, 1, 0], [5, 5, 6, 5], [9, 9, 10, 9]], // 切点帧
        [[0, 0, 1, 0], [5, 5, 6, 5], [9, 9, 10, 9]], // 切点后首段 p=1
      ],
      cuts: [4], threshold: 0,
    });
    const r = TRACK.parseManifest(man);
    const t = TRACK.track(r.manifest);
    check(t.shots.length === 3, `内点不足与显式切点各起新镜头（得 ${t.shots.length} 个）`);
    near(t.p[0][2], 0, 1e-12, '内点不足帧 p_x 归零');
    near(t.p[0][3], 3, 1e-12, '新镜头重新累加 p_x=3');
    near(t.p[0][4], 0, 1e-12, '显式切点帧 p_x 归零');
    near(t.p[0][5], 1, 1e-12, '切点后重新累加 p_x=1');
    near(t.p[1][5], 0, 1e-12, '切点后 y 归零起算');
    check(t.weakFlags[2] === 1 && t.cutFlags[4] === 1, '弱帧与切点标记正确');
  }

  // 切点落在第 0 帧：不产生空镜头
  {
    const man = baseManifest({ frames: ['a', 'b'], pairs: [[], [[0, 0, 1, 1], [1, 1, 2, 2], [2, 2, 3, 3]]], cuts: [0] });
    const t = TRACK.track(TRACK.parseManifest(man).manifest);
    check(t.shots.length === 1 && t.shots[0].start === 0, '第 0 帧切点不产生空镜头');
  }

  // 阈值边界：恰好等于阈值不算离群
  {
    const man = baseManifest({
      frames: ['a', 'b'],
      pairs: [[], [[0, 0, 1, 0], [5, 5, 6, 5], [9, 9, 10, 9], [4, 4, 5, 4], [7, 7, 9, 7]]],
      threshold: 1,
    });
    const t = TRACK.track(TRACK.parseManifest(man).manifest);
    // 位移 [1,1,1,1,2]，中位数 1；偏离恰为 1 的点仍算内点 → 5 组
    check(t.inlierCounts[1] === 5, '恰好等于阈值算内点');
  }

  // 校验错误定位
  {
    const r1 = TRACK.parseManifest({ frames: ['a'], pairs: [[[1, 2, 3]]] });
    check(!r1.ok && r1.errors[0].path.includes('pairs[0]'), '点对格式错误定位到 pairs[0]');
    const r2 = TRACK.parseManifest({ frames: ['a', 'b'], pairs: [[], []], cuts: [5] });
    check(!r2.ok && r2.errors[0].path.includes('cuts[0]'), '切点越界定位到 cuts[0]');
    const r3 = TRACK.parseManifest({ frames: ['a', 'b'], pairs: [[], []], pins: [[1, 0, 0], [1, 0, 0]] });
    check(!r3.ok && /重复/.test(r3.errors[0].message), '重复固定帧被拒绝');
    const r4 = TRACK.parseManifest({ frames: ['a', 'b'], pairs: [[], []], lambda: 20000 });
    check(!r4.ok && r4.errors[0].path.includes('lambda'), 'λ 越界被拒绝');
    const r5 = TRACK.parseManifest({ frames: ['a', 'b'], pairs: [[], []], margin: -1 });
    check(!r5.ok && r5.errors[0].path.includes('margin'), '负边距被拒绝');
  }
}

/* ------------------------------------------------------------------ QP */

async function testQp() {
  section('二次规划');
  // 隐藏用例 1：p=[0,2,0], λ=1, 宽边界 → [-4/7, 8/7, -4/7]
  {
    const r = QP.solveAxis(new Float64Array([0, 2, 0]), 1, 100, []);
    const want = [-4 / 7, 8 / 7, -4 / 7];
    for (let i = 0; i < 3; i++) near(r.u[i], want[i], 1e-12, `p=[0,2,0] 第 ${i} 项 = ${want[i].toFixed(6)}`);
  }
  // 隐藏用例 2：中间帧固定 0、两侧允许 ±1 → [-1,0,-1]
  {
    const r = QP.solveAxis(new Float64Array([0, 2, 0]), 1, 1, [{ index: 1, value: 0 }]);
    const want = [-1, 0, -1];
    for (let i = 0; i < 3; i++) near(r.u[i], want[i], 1e-12, `锁中间帧 第 ${i} 项 = ${want[i]}`);
  }
  // λ=0：目标退化为 Σu²，最优恒为 u=0（数据项被完全舍弃）
  {
    const r = QP.solveAxis(new Float64Array([5, -5, 0]), 0, 2, []);
    near(r.u[0], 0, 1e-12, 'λ=0 时 u=0（仅 Σu²）');
    near(r.u[1], 0, 1e-12, 'λ=0 时 u=0（下侧同）');
    near(r.u[2], 0, 1e-12, 'λ=0 时 u=0（末帧同）');
  }
  // λ>0 且边界紧：解被夹到 ±bound
  {
    const r = QP.solveAxis(new Float64Array([5, 0, 0]), 25, 0.5, []);
    near(r.u[0], 0.5, 1e-12, '贴界帧解恰为 +bound');
    check(Math.abs(r.u[1]) <= 0.5 + 1e-12 && Math.abs(r.u[2]) <= 0.5 + 1e-12, '其余帧不越界');
  }
  // 极小/空问题
  {
    check(QP.solveAxis(new Float64Array(0), 25, 1, []).u.length === 0, '空问题返回空解');
    check(QP.solveAxis(new Float64Array([3]), 25, 0, []).u[0] === 0, '单帧 bound=0 解为 0');
    check(QP.solveAxis(new Float64Array([3]), 25, 1, []).u[0] === 0, '单帧无二阶项解为 0');
    const r = QP.solveAxis(new Float64Array([0.5, -0.5]), 25, 1, []);
    check(Array.from(r.u).every((v) => v === 0), '两帧无二阶项解为 0');
  }
  // 与稠密参考逐例对照（每例独立给出 λ 与 pins）
  let worst = 0;
  for (const c of REF.cases) {
    const lam = c.lambda;
    const pins = c.pins || [];
    for (const [s, e] of c.shots) {
      const pX = Float64Array.from(c.p[0].slice(s, e));
      const pY = Float64Array.from(c.p[1].slice(s, e));
      const pinX = pins.filter((p) => p.frame >= s && p.frame < e).map((p) => ({ index: p.frame - s, value: p.x }));
      const pinY = pins.filter((p) => p.frame >= s && p.frame < e).map((p) => ({ index: p.frame - s, value: p.y }));
      const rx = QP.solveAxis(pX, lam, c.boundX, pinX);
      const ry = QP.solveAxis(pY, lam, c.boundY, pinY);
      for (let i = 0; i < e - s; i++) {
        worst = Math.max(worst, Math.abs(rx.u[i] - c.ux[s + i]), Math.abs(ry.u[i] - c.uy[s + i]));
      }
    }
  }
  check(worst < 1e-9, `与稠密参考最大偏移误差 ${worst.toExponential(2)} < 1e-9`);

  // KKT 残差（随机中大型问题）
  {
    let seed = 424242;
    const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
    let maxKkt = 0;
    let maxCostDiff = 0;
    for (let trial = 0; trial < 24; trial++) {
      const m = [50, 180, 600, 1800][trial % 4];
      const lam = [0, 1, 25, 10000][trial % 4];
      const bound = [0.02, 0.5, 3, 1e3][(trial >> 2) % 4];
      const p = new Float64Array(m);
      for (let i = 0; i < m; i++) p[i] = (rnd() - 0.5) * 2 * bound * 3;
      const pins = trial % 3 === 0 ? [{ index: (m / 2) | 0, value: bound * 0.5 }] : [];
      const r = QP.solveAxis(p, lam, bound, pins);
      // KKT 残差
      const H = QP.buildH(m, lam);
      const b = QP.buildB(p, m, lam);
      const g = QP.matvec(H, r.u);
      for (let i = 0; i < m; i++) g[i] -= b[i];
      const pinned = new Set(pins.map((q) => q.index));
      for (let i = 0; i < m; i++) {
        if (pinned.has(i)) continue;
        let viol = 0;
        if (r.u[i] >= bound - 1e-9) viol = Math.max(0, g[i]);
        else if (r.u[i] <= -bound + 1e-9) viol = Math.max(0, -g[i]);
        else viol = Math.abs(g[i]);
        maxKkt = Math.max(maxKkt, viol);
      }
      // 投影梯度基线代价
      const cost = QP.objective(p, r.u, lam);
      const pgCost = projectedGradient(p, lam, bound, pins, H, b);
      // 代价量级可到 1e13，用相对差比较（我们的解不应显著高于基线）
      const rel = cost > 0 ? (cost - pgCost) / Math.max(1, Math.abs(cost)) : 0;
      maxCostDiff = Math.max(maxCostDiff, rel);
    }
    check(maxKkt <= 1e-7, `随机大问题 KKT 残差 ${maxKkt.toExponential(2)} ≤ 1e-7`);
    check(maxCostDiff <= 1e-6, `代价不高于投影梯度基线（最大相对差 ${maxCostDiff.toExponential(2)}）`);
  }

  // 小规模穷举全局最优（m ≤ 7，三态活跃集全枚举）
  {
    let seed = 20261125;
    const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
    let bad = 0;
    for (let trial = 0; trial < 260; trial++) {
      const m = 1 + (trial % 7);
      const lam = [0, 0.3, 1, 7, 100][trial % 5];
      const bound = [0.05, 0.4, 1, 5][(trial >> 2) % 4];
      const p = new Float64Array(m);
      for (let i = 0; i < m; i++) p[i] = (rnd() - 0.5) * 4 * bound;
      const pins = (trial % 4 === 0 && m >= 2) ? [{ index: m - 1, value: -bound * 0.3 }] : [];
      const r = QP.solveAxis(p, lam, bound, pins);
      const best = bruteCost(p, lam, bound, pins);
      if (r.cost > best + 1e-9) bad++;
    }
    check(bad === 0, `260 例小规模穷举最优全部一致（失败 ${bad}）`);
  }

  // 不变性：常量平移不改变 u；取负使 u 取负
  {
    const p = Float64Array.from([0.2, -0.7, 1.3, 0.4, -0.1, 0.9]);
    const a = QP.solveAxis(p, 12, 5, []);
    const shifted = Float64Array.from(Array.from(p).map((v) => v + 7.5));
    const b = QP.solveAxis(shifted, 12, 5, []);
    const neg = Float64Array.from(Array.from(p).map((v) => -v));
    const c = QP.solveAxis(neg, 12, 5, []);
    let d1 = 0; let d2 = 0;
    for (let i = 0; i < p.length; i++) {
      d1 = Math.max(d1, Math.abs(a.u[i] - b.u[i]));
      d2 = Math.max(d2, Math.abs(c.u[i] + a.u[i]));
    }
    check(d1 < 1e-12, '常量平移不改变解');
    check(d2 < 1e-12, '取负使解取负');
  }
}

function projectedGradient(p, lam, bound, pins, H, b) {
  const m = p.length;
  const pinMap = new Map(pins.map((q) => [q.index, q.value]));
  const u = new Float64Array(m);
  for (const [i, v] of pinMap) u[i] = v;
  const free = [];
  for (let i = 0; i < m; i++) if (!pinMap.has(i)) free.push(i);
  // 步长用 1/L，L 取 Gershgorin 上界
  let L = 0;
  for (let i = 0; i < m; i++) {
    let s = H.diag[i];
    if (i + 1 < m) s += Math.abs(H.off1[i]);
    if (i + 2 < m) s += Math.abs(H.off2[i]);
    if (i - 1 >= 0) s += Math.abs(H.off1[i - 1]);
    if (i - 2 >= 0) s += Math.abs(H.off2[i - 2]);
    L = Math.max(L, s);
  }
  const step = 1 / L;
  for (let it = 0; it < 30000; it++) {
    const g = QP.matvec(H, u);
    for (let i = 0; i < m; i++) g[i] -= b[i];
    let maxStep = 0;
    for (const i of free) {
      let v = u[i] - step * g[i];
      v = Math.max(-bound, Math.min(bound, v));
      maxStep = Math.max(maxStep, Math.abs(v - u[i]));
      u[i] = v;
    }
    if (maxStep < 1e-13) break;
  }
  return QP.objective(p, u, lam);
}

function bruteCost(p, lam, bound, pins) {
  const m = p.length;
  const pinMap = new Map(pins.map((q) => [q.index, q.value]));
  const free = [];
  for (let i = 0; i < m; i++) if (!pinMap.has(i)) free.push(i);
  const k = free.length;
  let best = Infinity;
  const states = 3 ** k;
  const u = new Float64Array(m);
  for (const [i, v] of pinMap) u[i] = v;
  const H = QP.buildH(m, lam);
  const b = QP.buildB(p, m, lam);
  for (let mask = 0; mask < states; mask++) {
    let code = mask;
    const active = [];
    for (let j = 0; j < k; j++) {
      const st = code % 3; // 0 free,1 upper,2 lower
      code = (code - st) / 3;
      const idx = free[j];
      if (st === 1) active.push([idx, 1]);
      if (st === 2) active.push([idx, -1]);
    }
    const fixed = new Float64Array(m);
    for (const [i, v] of pinMap) fixed[i] = v;
    for (const [i, s] of active) fixed[i] = s > 0 ? bound : -bound;
    const freeIdx = free.filter((i) => !active.some(([j]) => j === i));
    const cand = new Float64Array(fixed);
    if (freeIdx.length) {
      const Hf = [];
      for (const i of freeIdx) Hf.push(freeIdx.map((j) => Hlookup(H, i, j)));
      const rhs = freeIdx.map((i) => {
        let s = b[i];
        for (let j = 0; j < m; j++) if (!freeIdx.includes(j)) s -= Hlookup(H, i, j) * fixed[j];
        return s;
      });
      const sol = denseSolve(Hf, rhs);
      if (!sol) continue;
      for (let a = 0; a < freeIdx.length; a++) cand[freeIdx[a]] = sol[a];
    }
    // 自由变量的界可行性（约束不满足的组合不是候选点）
    let withinBounds = true;
    for (const i of free) {
      if (pinMap.has(i)) continue;
      const act = active.find(([j]) => j === i);
      if (!act && (cand[i] > bound + 1e-9 || cand[i] < -bound - 1e-9)) withinBounds = false;
    }
    if (!withinBounds) continue;
    // KKT 有效性
    const g = QP.matvec(H, cand);
    for (let i = 0; i < m; i++) g[i] -= b[i];
    let ok = true;
    for (let i = 0; i < m; i++) {
      if (pinMap.has(i)) continue;
      const act = active.find(([j]) => j === i);
      if (act) {
        if (act[1] > 0 && g[i] > 1e-9) ok = false;
        if (act[1] < 0 && g[i] < -1e-9) ok = false;
      } else if (Math.abs(g[i]) > 1e-9) ok = false;
    }
    if (!ok) continue;
    const c = QP.objective(p, cand, lam);
    if (c < best) best = c;
  }
  return best;
}

function Hlookup(H, i, j) {
  if (i === j) return H.diag[i];
  if (j === i + 1) return H.off1[i];
  if (i === j + 1) return H.off1[j];
  if (j === i + 2) return H.off2[i];
  if (i === j + 2) return H.off2[j];
  return 0;
}

function denseSolve(A, rhs) {
  const n = rhs.length;
  const M = A.map((row, i) => row.concat([rhs[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/* ------------------------------------------------------------------ fit */

async function testFit(sample) {
  section('拟合');
  const parsed = TRACK.parseManifest(sample.manifest,
    sample.frames.map((f) => ({ width: f.width, height: f.height })));
  const tr = TRACK.track(parsed.manifest);
  const refCase = REF.cases.find((c) => c.name === 'sample-default');
  const res = FIT.fit(tr, sample.frames[0].width, sample.frames[0].height, {
    cropW: sample.manifest.crop[0], cropH: sample.manifest.crop[1],
    margin: sample.manifest.margin, lambda: sample.manifest.lambda, pins: [],
  });
  check(res.ok, '样例求解成功');
  near(res.boundX, refCase.boundX, 1e-12, '横向允许范围');
  near(res.boundY, refCase.boundY, 1e-12, '纵向允许范围');
  let worst = 0;
  for (let t = 0; t < res.ux.length; t++) {
    worst = Math.max(worst, Math.abs(res.ux[t] - refCase.ux[t]), Math.abs(res.uy[t] - refCase.uy[t]));
  }
  check(worst < 1e-9, `样例偏移与参考一致（最大 ${worst.toExponential(2)}）`);

  // 各参考用例逐一对照
  let worstAll = 0;
  for (const c of REF.cases) {
    if (!c.manifest) continue;
    const p2 = TRACK.parseManifest(c.manifest);
    if (!p2.ok) continue;
    const tr2 = TRACK.track(p2.manifest);
    const cfg = c.manifest;
    const r = FIT.fit(tr2, REF.width, REF.height, {
      cropW: cfg.crop[0], cropH: cfg.crop[1], margin: cfg.margin,
      lambda: cfg.lambda, pins: TRACK.normalisePins(cfg.pins, cfg.frames.length).pins,
    });
    check(r.ok, `${c.name} 求解成功`);
    if (!r.ok) continue;
    for (let t = 0; t < r.ux.length; t++) {
      worstAll = Math.max(worstAll, Math.abs(r.ux[t] - c.ux[t]), Math.abs(r.uy[t] - c.uy[t]));
    }
  }
  check(worstAll < 1e-9, `全部合成用例与参考一致（最大 ${worstAll.toExponential(2)}）`);

  // 冲突分类：负允许范围
  {
    const r = FIT.fit(tr, 64, 40, { cropW: 64, cropH: 40, margin: 1, lambda: 25, pins: [] });
    check(!r.ok && r.errors[0].reason === FIT.REASONS.NEGATIVE_BOUND, '画幅+边距超限判为负范围');
    check(/允许范围/.test(r.errors[0].message), '负范围提示说明原因');
  }
  // 冲突分类：锁点越界（指出具体帧）
  {
    const r = FIT.fit(tr, 64, 40, {
      cropW: 56, cropH: 36, margin: 1, lambda: 25,
      pins: [{ frame: 3, x: 4.0, y: 0 }],
    });
    check(!r.ok && r.errors.some((e) => e.reason === FIT.REASONS.PIN_OUT_OF_RANGE && e.frame === 3),
      '锁点越界指出具体帧');
    check(r.errors.some((e) => /第 3 帧/.test(e.message)), '锁点越界文案含帧号');
  }
  // 锁点恰在边界可用
  {
    const r = FIT.fit(tr, 64, 40, {
      cropW: 56, cropH: 36, margin: 1, lambda: 25,
      pins: [{ frame: 3, x: 3.0, y: 1.0 }],
    });
    check(r.ok, '锁点恰在允许边界可行');
    if (r.ok) near(r.ux[3], 3.0, 1e-12, '锁点值精确固定');
  }
  // 输出画幅超过源
  {
    const r = FIT.fit(tr, 64, 40, { cropW: 65, cropH: 36, margin: 0, lambda: 25, pins: [] });
    check(!r.ok && r.errors[0].reason === FIT.REASONS.CROP_INVALID, '画幅超过源尺寸判为不可行');
  }
  // 锁定非零后加大边距：恰好在越界处失效
  {
    const ok3 = FIT.fit(tr, 64, 40, { cropW: 56, cropH: 36, margin: 1, lambda: 25, pins: [{ frame: 2, x: 2.5, y: 0 }] });
    check(ok3.ok, '边距 1 时可锁定 2.5');
    const bad4 = FIT.fit(tr, 64, 40, { cropW: 56, cropH: 36, margin: 2, lambda: 25, pins: [{ frame: 2, x: 2.5, y: 0 }] });
    check(!bad4.ok, '边距 2 时锁定 2.5 越界');
  }
}

/* ------------------------------------------------------------------ crop */

async function testCrop(sample) {
  section('裁剪');
  const refCase = REF.cases.find((c) => c.name === 'sample-default');
  const W = sample.frames[0].width;
  const H = sample.frames[0].height;
  const cropW = sample.manifest.crop[0];
  const cropH = sample.manifest.crop[1];
  let allMatch = true;
  for (let t = 0; t < sample.frames.length; t++) {
    const img = CROP.renderCrop(sample.frames[t].data, W, H, cropW, cropH, refCase.ux[t], refCase.uy[t]);
    const got = sha(img);
    if (got !== refCase.crops[t]) { allMatch = false; console.log(` 帧 ${t} 哈希 ${got} ≠ ${refCase.crops[t]}`); }
  }
  check(allMatch, '样例 6 帧裁后图与参考 SHA-256 全等');

  // 取样公式：整数偏移时等价于整数裁剪
  {
    const src = new Uint8Array(W * H * 3).map((_, i) => i % 251);
    const img = CROP.renderCrop(src, W, H, 16, 10, 0, 0);
    let ok = true;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 16; x++) {
      const sx = x + (W - 16) / 2;
      const sy = y + (H - 10) / 2;
      for (let c = 0; c < 3; c++) {
        const want = src[(sy * W + sx) * 3 + c];
        if (img[(y * 16 + x) * 3 + c] !== want) ok = false;
      }
    }
    check(ok, '整数偏移等价整数裁剪（奇偶性不同：64→17，40→9）');
  }
  // 半像素取样与四邻平均
  {
    const src = new Uint8Array(W * H * 3).map((_, i) => i % 251);
    // 源 64×40，crop 56×36 → 基准 x=4, y=2；ux=0.5 使 sx=4.5（横向半像素）
    const px = CROP.samplePixel(src, W, H, 56, 36, 0, 0, 0.5, 0);
    near(px.sx, 4.5, 1e-12, '源坐标 sx = 0 + (64−56)/2 + 0.5');
    near(px.sy, 2, 1e-12, '源坐标 sy = 0 + (40−36)/2');
    near(px.fx, 0.5, 1e-12, '半像素取样 fx=0.5');
    const sy = 2;
    const v0 = src[(sy * W + 4) * 3];
    const v1 = src[(sy * W + 5) * 3];
    near(px.rgb[0], Math.floor((v0 + v1) / 2 + 0.5), 1e-12, '半像素水平平均 + floor(v+0.5)');
  }
  // 0.5 取整：floor(v+0.5)
  {
    const src = new Uint8Array(4 * 1 * 3);
    src.set([10, 20, 30, 12, 22, 32, 14, 24, 34, 16, 26, 36]);
    const out = CROP.renderCrop(src, 4, 1, 1, 1, 0, 0);
    // 基准 x = (4−1)/2 = 1.5 → 像素 1 与 2 的通道 0：12 与 14 → 13
    near(out[0], 13, 0, '双线性 12/14 平均 13（floor(13.5)）');
    // 半像素竖向：4×4 源，每行通道 0 填行号×10；crop 4×2 → 基准 y=1，再给 uy=0.5 → sy=1.5
    const src2 = new Uint8Array(4 * 4 * 3);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) src2[(y * 4 + x) * 3] = y * 10;
    const out2 = CROP.renderCrop(src2, 4, 4, 4, 2, 0, 0.5);
    // 输出(0,0): sy=0+1+0.5=1.5，行 1、2 的 10、20 → 15
    near(out2[0], 15, 0, '半像素竖向平均 15');
  }
  // 隐藏验收用例：横纵斜率各异的 RGB 线性坡度图，输出宽高与输入奇偶性不同，
  // 一帧固定偏移 (0.25,-0.25)。逐像素用独立双线性公式与约定舍入核对。
  {
    const SW = 13; const SH = 9; const CW = 8; const CH = 5; // 13→8（奇数出偶数），9→5
    const src = new Uint8Array(SW * SH * 3);
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const o = (y * SW + x) * 3;
      src[o] = (x * 11 + y * 3) % 256;      // R：横斜率大
      src[o + 1] = (x * 2 + y * 17) % 256;  // G：纵斜率大
      src[o + 2] = (x * 7 - y * 5 + 128) & 255; // B：斜向
    }
    const ux = 0.25; const uy = -0.25;
    const got = CROP.renderCrop(src, SW, SH, CW, CH, ux, uy);
    // 独立参考：逐像素重写公式
    const exp = new Uint8Array(CW * CH * 3);
    const baseX = (SW - CW) / 2 + ux;
    const baseY = (SH - CH) / 2 + uy;
    for (let y = 0; y < CH; y++) {
      const sy = y + baseY;
      const iy = Math.floor(sy); const fy = sy - iy;
      for (let x = 0; x < CW; x++) {
        const sx = x + baseX;
        const ix = Math.floor(sx); const fx = sx - ix;
        for (let c = 0; c < 3; c++) {
          const v = src[(iy * SW + ix) * 3 + c] * (1 - fx) * (1 - fy)
            + src[(iy * SW + ix + 1) * 3 + c] * fx * (1 - fy)
            + src[((iy + 1) * SW + ix) * 3 + c] * (1 - fx) * fy
            + src[((iy + 1) * SW + ix + 1) * 3 + c] * fx * fy;
          exp[(y * CW + x) * 3 + c] = Math.floor(v + 0.5);
        }
      }
    }
    check(sha(got) === sha(exp), '坡度图 + 固定偏移 (0.25,−0.25) 的裁后图逐像素一致');
    // 源坐标符号：ux 使基准右移 0.25，uy 使基准上移 0.25
    near(CROP.sourceCoord(0, 0, SW, SH, CW, CH, ux, uy)[0], (SW - CW) / 2 + 0.25, 1e-12, '取样 x 含 +0.25');
    near(CROP.sourceCoord(0, 0, SW, SH, CW, CH, ux, uy)[1], (SH - CH) / 2 - 0.25, 1e-12, '取样 y 含 −0.25');
  }
  // 预览与整幅在相同尺寸下逐字节一致
  {
    const src = sample.frames[0].data;
    const full = CROP.renderCrop(src, W, H, cropW, cropH, refCase.ux[0], refCase.uy[0]);
    const prev = CROP.renderCropPreview(src, W, H, cropW, cropH, refCase.ux[0], refCase.uy[0], cropW, cropH);
    check(sha(full) === sha(prev), '预览与整幅同尺寸逐字节一致');
  }
}

/* ------------------------------------------------------------------ pnm/zip */

async function testPnmZip(sample) {
  section('PNM / ZIP');
  const enc = PNM.encodePnm(3, 2, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));
  const dec = PNM.decodePnm(enc);
  check(dec.width === 3 && dec.height === 2 && dec.data[17] === 18, 'P6 编解码往返');
  // 注释与多空白
  {
    const withComment = new TextEncoder().encode('P6\n# a comment\n2 1\n255\n' + '\0'.repeat(6));
    const d = PNM.decodePnm(withComment);
    check(d.width === 2 && d.height === 1, 'P6 头允许注释');
  }
  {
    let threw = false;
    try { PNM.decodePnm(new TextEncoder().encode('P6\n2 1\n254\n123456')); } catch { threw = true; }
    check(threw, 'maxval≠255 拒绝');
    threw = false;
    try { PNM.decodePnm(new TextEncoder().encode('P6\n2 1\n255\n12345')); } catch { threw = true; }
    check(threw, '字节数不符拒绝');
    threw = false;
    try { PNM.decodePnm(new TextEncoder().encode('P3\n2 1\n255\n1 2 3 4 5 6')); } catch { threw = true; }
    check(threw, '非 P6 拒绝');
  }

  // ZIP store 往返
  {
    const entries = [
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) },
    ];
    const stored = ZIP.zipStore(entries);
    const back = await ZIP.unzip(stored);
    check(back.size === 2 && new TextDecoder().decode(back.get('a.txt')) === 'hello', 'store ZIP 往返');
    const deflated = await ZIP.zip(entries);
    const back2 = await ZIP.unzip(deflated);
    check(back2.size === 2 && back2.get('dir/b.bin')[3] === 255, 'deflate ZIP 往返');
  }
  // 路径穿越
  {
    let threw = false;
    try { ZIP.zipStore([{ name: '../evil', data: new Uint8Array(1) }]); } catch { threw = true; }
    check(threw, '写 ZIP 拒绝路径穿越');
  }
  // CRC 篡改
  {
    const z = ZIP.zipStore([{ name: 'x', data: new TextEncoder().encode('abcdef') }]);
    const copy = Uint8Array.from(z);
    // 找到本地头后数据起点（30 + 1 名字字节），翻转一字节
    copy[31] ^= 0xff;
    let threw = false;
    try { await ZIP.unzip(copy); } catch (e) { threw = /CRC/.test(e.message); }
    check(threw, 'CRC 篡改被拒绝');
  }
  // 样例 ZIP 解出 8 个文件
  check(sample.files.size === 8, `样例 ZIP 含 8 个文件（实际 ${sample.files.size}）`);
}

/* ------------------------------------------------------------------ perf */

async function testPerf() {
  section('性能（1800 帧）');
  const N = 1800;
  const W = 154; const H = 88; // 13552 px × 1800 ≈ 2439 万
  check(W * H * N <= 25000001, '合成样本像素预算 ≤ 2500 万');
  const pairs = [[]];
  const cuts = [];
  for (let t = 1; t < N; t++) {
    if (t % 400 === 0) { cuts.push(t); pairs.push([]); continue; }
    const pts = [];
    for (let k = 0; k < 40; k++) {
      const x = 10 + (k % 8) * 15;
      const y = 10 + Math.floor(k / 8) * 12;
      const dx = Math.sin(t * 0.03 + k * 0.7) * 2.5 + Math.cos(t * 0.011) * 3;
      const dy = Math.cos(t * 0.023 + k * 0.5) * 2.0;
      pts.push([x, y, x + dx, y + dy]);
    }
    // 每隔几帧加一个跟到背景上的离群点
    if (t % 7 === 0) pts.push([5, 5, 5 + 80, 5 - 60]);
    pairs.push(pts);
  }
  const man = {
    frames: Array.from({ length: N }, (_, i) => `f${i}.ppm`),
    pairs, cuts, threshold: 1.5,
    crop: [140, 70], margin: 1, pins: [], lambda: 25,
  };
  const parsed = TRACK.parseManifest(man, Array.from({ length: N }, () => ({ width: W, height: H })));
  check(parsed.ok, '1800 帧 manifest 校验通过', parsed.errors.map((e) => e.message).join(';'));
  const t0 = performance.now();
  const tr = TRACK.track(parsed.manifest);
  const tTrack = performance.now() - t0;
  check(tr.shots.length === cuts.length + 1, `1800 帧分为 ${tr.shots.length} 个镜头`);

  // 改安全边距：重新拟合
  let worst = 0;
  for (const margin of [0, 1, 2, 3, 4]) {
    const t1 = performance.now();
    const r = FIT.fit(tr, W, H, { cropW: 140, cropH: 70, margin, lambda: 25, pins: [] });
    const ms = performance.now() - t1;
    check(r.ok, `边距 ${margin} 求解成功`);
    worst = Math.max(worst, ms);
  }
  console.log(` 跟踪 ${tTrack.toFixed(1)} ms；改边距最慢 ${worst.toFixed(1)} ms`);
  check(worst < 8000, `1800 帧改安全边距 ${worst.toFixed(1)} ms < 8000 ms`);

  // 紧边界压力：大幅高频抖动 + 小余量，几乎每帧都贴界，逼活跃集法跑到底
  {
    const jitterPairs = [[]];
    for (let t = 1; t < N; t++) {
      const pts = [];
      for (let k = 0; k < 30; k++) {
        const x = 8 + (k % 6) * 20;
        const y = 8 + Math.floor(k / 6) * 14;
        const dx = (t % 2 === 0 ? 4 : -4) + Math.sin(t * 0.2 + k) * 2;
        const dy = (t % 3 === 0 ? 3 : -3);
        pts.push([x, y, x + dx, y + dy]);
      }
      jitterPairs.push(pts);
    }
    const jman = {
      frames: Array.from({ length: N }, (_, i) => `j${i}.ppm`),
      pairs: jitterPairs, cuts: [600, 1200], threshold: 1.5,
      crop: [152, 86], margin: 0, pins: [], lambda: 50,
    };
    const jp = TRACK.parseManifest(jman, Array.from({ length: N }, () => ({ width: W, height: H })));
    check(jp.ok, '抖动样本 manifest 合法');
    const jtr = TRACK.track(jp.manifest);
    const t1 = performance.now();
    const r = FIT.fit(jtr, W, H, { cropW: 152, cropH: 86, margin: 0, lambda: 50, pins: [] });
    const ms = performance.now() - t1;
    check(r.ok, '紧边界求解成功');
    const atBound = r.totals.nAtBoundX + r.totals.nAtBoundY;
    console.log(` 紧边界（余量 1，大幅抖动） ${ms.toFixed(1)} ms，贴界 ${atBound} 轴帧`);
    check(atBound > 1000, `紧边界下大量帧贴界（${atBound}）`);
    check(ms < 8000, `紧边界 ${ms.toFixed(1)} ms < 8000 ms`);
    let maxAbs = 0;
    for (let t = 0; t < r.ux.length; t++) maxAbs = Math.max(maxAbs, Math.abs(r.ux[t]), Math.abs(r.uy[t]));
    check(maxAbs <= 1 + 1e-9, `偏移不越界（max ${maxAbs.toFixed(6)} ≤ 1）`);
  }
}

/* ------------------------------------------------------------------ main */

(async () => {
  const sample = await loadSample();
  await testTracking(sample);
  await testQp();
  await testFit(sample);
  await testCrop(sample);
  await testPnmZip(sample);
  await testPerf();

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILED'} — ${passed} 通过，${failed} 失败`);
  if (failed) {
    for (const f of failures) console.log(` ✗ ${f}`);
    process.exit(1);
  }
})();
