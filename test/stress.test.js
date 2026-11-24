/* 随机化压力测试：复杂层级/多骨权重/负轴/跨段，对比独立稠密参考。
   不验证引擎内部，只验证盒子包住参考极值、间隙≤0.01、见证可复现。 */
'use strict';
const E = require('../src/engine.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' — ' + x : '')); } };

// 可复现的伪随机
let seed = 123456789;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function rrange(a, b) { return a + rnd() * (b - a); }

function referenceExtrema(model, ta, tb, n) {
  const sc = E.makeScratch(model);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= n; i++) {
    const t = ta + (tb - ta) * (i / n);
    const world = E.evalWorldMatrices(model, t, sc);
    for (let vi = 0; vi < model.vertices.length; vi++) {
      const p = E.skinVertex(model, world, vi, sc.tmp, sc.pos);
      for (let r = 0; r < 3; r++) {
        if (p[r] < mn[r]) mn[r] = p[r];
        if (p[r] > mx[r]) mx[r] = p[r];
      }
    }
  }
  return { mn, mx };
}

function checkWitnesses(model, res) {
  const sc = E.makeScratch(model);
  for (let q = 0; q < 6; q++) {
    const f = res.faces[q];
    const w = E.evalWorldMatrices(model, f.witness.t, sc);
    const p = E.skinVertex(model, w, f.witness.vertex, sc.tmp, sc.pos);
    if (Math.abs(p[f.axis] - f.witness.coord) > 1e-9) return `面${q}见证坐标不符`;
    const gap = f.isMin ? f.value - p[f.axis] : p[f.axis] - f.value;
    // 盒面外扩 MARGIN，故见证在盒内最多 MARGIN；距面超 0.01 或在盒外异常深才失败
    if (gap > 0.01 + 1e-9 || gap < -(E.MARGIN + 0.005)) return `面${q}见证距面异常 ${gap}`;
  }
  return null;
}

const axes = ['x', 'y', 'z', '-x', '-y', '-z'];

for (let trial = 0; trial < 40; trial++) {
  seed = 123456789 + trial * 7919;
  const nb = 2 + Math.floor(rnd() * 8);
  const bones = [];
  for (let b = 0; b < nb; b++) {
    const parent = b === 0 ? null : Math.floor(rnd() * b); // 保证无环、父在前
    bones.push({ parent, axis: axes[Math.floor(rnd() * 6)] });
  }
  const nk = 2 + Math.floor(rnd() * 5);
  const keys = [];
  let t = 0;
  const times = [];
  for (let k = 0; k < nk; k++) { times.push(t); t += rrange(0.3, 1.5); }
  for (let k = 0; k < nk; k++) {
    const pose = [];
    for (let b = 0; b < nb; b++) {
      const tx = rrange(-20, 20), ty = rrange(-20, 20), tz = rrange(-20, 20);
      let turns;
      if (k === 0) turns = rrange(-1, 1);
      else { const prev = keys[k - 1].pose[b][3]; turns = prev + rrange(-1.8, 1.8); } // 满足≤2圈
      pose.push([tx, ty, tz, turns]);
    }
    keys.push({ t: times[k], pose });
  }
  const nV = 1 + Math.floor(rnd() * 30);
  const vertices = [];
  for (let i = 0; i < nV; i++) {
    const cnt = 1 + Math.floor(rnd() * Math.min(4, nb));
    const chosen = new Set();
    const infl = [];
    let remaining = 65536;
    for (let j = 0; j < cnt; j++) {
      let bi;
      do { bi = Math.floor(rnd() * nb); } while (chosen.has(bi));
      chosen.add(bi);
      const w = j === cnt - 1 ? remaining : Math.floor(rnd() * remaining);
      remaining -= w;
      infl.push([bi, w, rrange(-15, 15), rrange(-15, 15), rrange(-15, 15)]);
    }
    vertices.push(infl);
  }
  const raw = { bones, keys, vertices };
  const r = E.validateModel(raw);
  if (r.error) { ok(`试验${trial} 合法模型`, false, r.error); continue; }
  const model = r.model;

  // 随机闭子区间（可能跨多段）
  const ta = rrange(model.t0, model.t1);
  const tb = rrange(ta, model.t1);
  const res = E.computeEnvelope(model, ta, tb);
  const ref = referenceExtrema(model, ta, tb, 4000);

  let fine = true; const why = [];
  for (let c = 0; c < 3; c++) {
    if (res.box.min[c] > ref.mn[c] + 1e-9) { fine = false; why.push(`min${c}未包住`); }
    if (res.box.max[c] < ref.mx[c] - 1e-9) { fine = false; why.push(`max${c}未包住`); }
    if (res.box.min[c] - ref.mn[c] > 0.01) { fine = false; why.push(`min${c}间隙过大`); }
    if (ref.mx[c] - res.box.max[c] > 0.01) { fine = false; why.push(`max${c}间隙过大`); }
  }
  const wErr = checkWitnesses(model, res);
  if (wErr) { fine = false; why.push(wErr); }
  if (res.stats.deepLeaves.length) { fine = false; why.push('未收敛叶 ' + JSON.stringify(res.stats.deepLeaves[0])); }
  ok(`随机试验${trial}（${nb}骨/${nV}顶点/${nk}帧，跨段查询）`, fine, why.join(';'));
}

console.log(`\n随机压力测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
