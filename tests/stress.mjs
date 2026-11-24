// 随机压力：插入->删除精确往返、失败安全性、512 CP 性能、SVG 契约
import { Frac, parseCurveObject, insertKnot, removeKnotAt, curveToObject, buildExportSVG, Studio } from '../rks.mjs';

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('✗', m); } }

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function makeCurve(seed, p, N) {
  const rnd = rng(seed);
  const K = N - p - 1;
  const runs = [];
  let rem = K;
  while (rem > 0) { let m = rnd() < .75 ? 1 : 1 + Math.floor(rnd() * p); m = Math.max(1, Math.min(m, p, rem)); runs.push(m); rem -= m; }
  const G = runs.length;
  const knots = [];
  for (let i = 0; i <= p; i++) knots.push(new Frac(0));
  runs.forEach((m, g) => { const v = new Frac(2 * (g + 1), G + 1); for (let z = 0; z < m; z++) knots.push(v); });
  for (let i = 0; i <= p; i++) knots.push(new Frac(2));
  const points = [];
  for (let i = 0; i < N; i++) {
    const x = new Frac(Math.floor(rnd() * 200) - 100, 7);
    const y = new Frac(Math.floor(rnd() * 200) - 100, 7);
    const w = new Frac(Math.floor(rnd() * 9) + 1, 3);
    points.push({ X: x.mul(w), Y: y.mul(w), W: w });
  }
  return { degree: p, knots, points };
}

let insertCount = 0, removeRoundtrip = 0;
for (let iter = 0; iter < 300; iter++) {
  const p = 2 + (iter % 4);
  const N = p + 1 + ((iter * 7) % 60);
  const c = makeCurve(1234 + iter * 97, p, N);
  // 选一个不会超重数的随机分数节点
  let den = 5 + (iter % 11);
  let num = 1 + (iter * 13) % (2 * den - 1);
  let u = new Frac(num, den);
  if (u.lte(c.knots[0]) || u.gte(c.knots.at(-1))) u = new Frac(1, 2);
  const mult = c.knots.filter((k) => k.eq(u)).length;
  if (mult >= p) continue;
  const ir = insertKnot(c, u);
  if (!ir.ok) { console.error('insert fail', iter, ir.error); fail++; continue; }
  insertCount++;
  const after = ir.curve;
  // 找一个该值的内部出现下标并删除
  const idxs = [];
  for (let i = p + 1; i <= after.points.length - 1; i++) if (after.knots[i].eq(u)) idxs.push(i);
  let succeeded = false;
  for (const r of idxs) {
    const rm = removeKnotAt(after, r);
    if (rm.ok) {
      succeeded = true;
      const same = JSON.stringify(curveToObject(rm.curve)) === JSON.stringify(curveToObject(c));
      ok(same, `iter${iter} p${p} N${N} 删除 r=${r} 精确复原`);
      if (same) removeRoundtrip++;
      break;
    }
  }
  ok(succeeded, `iter${iter} 至少一个出现位置可删回`);
}
console.log(`插入 ${insertCount} 次，成功往返 ${removeRoundtrip}`);

// 失败操作安全性：任何失败都不得动 undo/redo 栈
for (let iter = 0; iter < 100; iter++) {
  const p = 2 + (iter % 4);
  const N = p + 3 + (iter % 20);
  const c = makeCurve(9000 + iter, p, N);
  const st = new Studio(curveToObject(c));
  st.redoStack.push('sentinel');
  st.undoStack.push('sentinel-u');
  const s0 = st.snapshot();
  const bad1 = st.removeKnotAt(99999);
  const bad2 = st.insertKnot('9'); // 超出参数域 [0,2]
  const bad3 = st.movePoint(0, 'not-a-fraction!!', '0');
  ok(!bad1.ok && !bad2.ok && !bad3.ok, '三种非法操作均失败');
  ok(st.snapshot() === s0, '失败后曲线不变');
  ok(st.redoStack.length === 1 && st.redoStack[0] === 'sentinel', '失败不吞 redo');
  ok(st.undoStack.length === 1 && st.undoStack[0] === 'sentinel-u', '失败不写 undo');
}

// 512 CP 性能与 SVG 契约
{
  const t0 = Date.now();
  const c = makeCurve(424242, 3, 512);
  ok(c.points.length === 512, '构造 512 CP');
  const ins = insertKnot(c, '1');
  ok(!ins.ok, '512 CP 时拒绝继续插入: ' + (ins.error || ''));
  const built = buildExportSVG(c);
  const dt = Date.now() - t0;
  console.log(`512 CP p=3: SVG ${built.segmentCount} 段, maxDev=${built.maxDeviation.toFixed(4)}, 耗时 ${dt}ms`);
  ok(built.maxDeviation <= 0.25, '512 CP SVG 误差契约');
  ok(dt < 8000, '导出耗时可接受 (<8s): ' + dt + 'ms');
}

console.log(`\nSTRESS: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
