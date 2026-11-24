// 1800 帧规模基准：逐场景测「改安全边距 → 轨迹更新」耗时（含跟踪 + 拟合）。
// 运行：node tools/bench.js
'use strict';
const QP = require('../js/qp.js');
const TRACK = require('../js/tracking.js');
const FIT = require('../js/fit.js');

const N = 1800;
const W = 154; const H = 88; // 13552 px × 1800 ≈ 24.39 M ≤ 25 M

function makeShots(cutEvery) {
  const cuts = [];
  for (let t = cutEvery; t < N; t += cutEvery) cuts.push(t);
  const pairs = [[]];
  for (let t = 1; t < N; t++) {
    if (cuts.includes(t)) { pairs.push([]); continue; }
    const pts = [];
    for (let k = 0; k < 48; k++) {
      const x = 8 + (k % 8) * 17;
      const y = 8 + Math.floor(k / 8) * 10;
      const dx = Math.sin(t * 0.02 + k * 0.6) * 2.5 + Math.cos(t * 0.009) * 4;
      const dy = Math.cos(t * 0.017 + k * 0.4) * 2.2;
      pts.push([x, y, x + dx, y + dy]);
    }
    if (t % 6 === 0) pts.push([5, 5, 5 + 70, 5 - 55]); // 跟到背景上的离群点
    pairs.push(pts);
  }
  return { cuts, pairs };
}

function build(cutEvery) {
  const { cuts, pairs } = makeShots(cutEvery);
  const man = {
    frames: Array.from({ length: N }, (_, i) => `f${i}.ppm`),
    pairs, cuts, threshold: 1.5, crop: [140, 70], margin: 1, pins: [], lambda: 25,
  };
  const parsed = TRACK.parseManifest(man, Array.from({ length: N }, () => ({ width: W, height: H })));
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join(';'));
  return TRACK.track(parsed.manifest);
}

function timeIt(fn) {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
}

const scenarios = [];
for (const cutEvery of [1800, 60, 2]) {
  const tr = build(cutEvery);
  scenarios.push({
    name: cutEvery === 1800 ? '单镜头 1800 帧' : (cutEvery === 60 ? '每 60 帧切一次（30 镜头）' : '每隔一帧切（900 镜头）'),
    tr,
    cfgs: [
      { label: '改边距 1', cfg: { cropW: 140, cropH: 70, margin: 1, lambda: 25, pins: [] } },
      { label: '改边距 3', cfg: { cropW: 140, cropH: 70, margin: 3, lambda: 25, pins: [] } },
      { label: '改边距 5', cfg: { cropW: 140, cropH: 70, margin: 5, lambda: 25, pins: [] } },
      { label: '改边距 7', cfg: { cropW: 120, cropH: 60, margin: 7, lambda: 25, pins: [] } },
    ],
  });
}

// 紧边界场景：大幅高频抖动，几乎每帧都贴界
{
  const pairs = [[]];
  for (let t = 1; t < N; t++) {
    const pts = [];
    for (let k = 0; k < 36; k++) {
      const x = 8 + (k % 6) * 22;
      const y = 8 + Math.floor(k / 6) * 13;
      const dx = (t % 2 === 0 ? 5 : -5) + Math.sin(t * 0.25 + k) * 3;
      const dy = (t % 3 === 0 ? 4 : -4);
      pts.push([x, y, x + dx, y + dy]);
    }
    pairs.push(pts);
  }
  const man = {
    frames: Array.from({ length: N }, (_, i) => `j${i}.ppm`),
    pairs, cuts: [700, 1400], threshold: 1.5,
    crop: [152, 86], margin: 0, pins: [], lambda: 50,
  };
  const parsed = TRACK.parseManifest(man, Array.from({ length: N }, () => ({ width: W, height: H })));
  const tr = TRACK.track(parsed.manifest);
  scenarios.push({
    name: '大幅抖动 紧边界余量 1（近全约束）',
    tr,
    cfgs: [{ label: '余量 1', cfg: { cropW: 152, cropH: 86, margin: 0, lambda: 50, pins: [] } }],
  });
}
// 锁点场景
{
  const tr = build(1800);
  scenarios.push({
    name: '单镜头 + 3 个固定帧',
    tr,
    cfgs: [{ label: '锁点', cfg: { cropW: 140, cropH: 70, margin: 1, lambda: 25, pins: [{ frame: 300, x: 4, y: -2 }, { frame: 900, x: -3, y: 1 }, { frame: 1500, x: 0.5, y: 0.25 }] } }],
  });
}
// λ 极端
for (const lam of [0, 10000]) {
  const tr = build(1800);
  scenarios.push({
    name: `单镜头 λ=${lam}`,
    tr,
    cfgs: [{ label: `λ=${lam}`, cfg: { cropW: 140, cropH: 70, margin: 1, lambda: lam, pins: [] } }],
  });
}

let worst = 0;
let budget = 8000;
console.log(`1800 帧基线（${W}×${H} = ${(W * H * N / 1e6).toFixed(1)} M 像素）`);
for (const sc of scenarios) {
  let line = ` ${sc.name.padEnd(30)}`;
  for (const c of sc.cfgs) {
    const t = timeIt(() => FIT.fit(sc.tr, W, H, c.cfg));
    if (!t.r.ok) { line += ` ${c.label}=失败`; continue; }
    const at = t.r.totals.nAtBoundX + t.r.totals.nAtBoundY;
    line += ` ${c.label}: ${t.ms.toFixed(1)}ms(贴界${at})`;
    worst = Math.max(worst, t.ms);
  }
  console.log(line);
}
console.log(`\n最慢 ${worst.toFixed(1)} ms，预算 ${budget} ms → ${worst < budget ? 'PASS' : 'FAIL'}`);
if (worst >= budget) process.exit(1);
