// 导出大尺寸待检问题与 js/qp.js 的解，供 tools/verify-kkt.py 用 numpy 独立核验。
'use strict';
const QP = require('../js/qp.js');

let seed = 987654321;
const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };

const cases = [];
const specs = [
  { name: 'wide-m1800', m: 1800, lambda: 25, bound: 400, pins: false },
  { name: 'tight-m1800', m: 1800, lambda: 50, bound: 1, pins: false },
  { name: 'lambda0-m1800', m: 1800, lambda: 0, bound: 0.5, pins: false },
  { name: 'lambda1e4-m1800', m: 1800, lambda: 10000, bound: 2, pins: false },
  { name: 'pinned-m1200', m: 1200, lambda: 25, bound: 1.5, pins: true },
  { name: 'pinned-tight-m900', m: 900, lambda: 8, bound: 0.3, pins: true },
  { name: 'mid-m600', m: 600, lambda: 3, bound: 2.2, pins: false },
];
for (const s of specs) {
  const p = new Float64Array(s.m);
  // 混合低频漂移 + 高频抖动 + 大台阶，覆盖贴界与内部解
  for (let i = 0; i < s.m; i++) {
    p[i] = Math.sin(i * 0.01) * s.bound * 2.4
      + Math.cos(i * 0.13) * s.bound * 0.6
      + (i > s.m * 0.55 ? s.bound * 1.2 : 0)
      + (rnd() - 0.5) * s.bound * 0.1;
  }
  const pins = [];
  if (s.pins) {
    const a = Math.floor(s.m / 3);
    const b = Math.floor((2 * s.m) / 3);
    pins.push({ index: a, value: s.bound * 0.5 });
    pins.push({ index: b, value: -s.bound * 0.25 });
  }
  const r = QP.solveAxis(p, s.lambda, s.bound, pins);
  const pinObj = {};
  for (const q of pins) pinObj[q.index] = q.value;
  cases.push({
    name: s.name, m: s.m, lambda: s.lambda, bound: s.bound,
    pins: pinObj,
    p: Array.from(p),
    u: Array.from(r.u),
  });
}
process.stdout.write(JSON.stringify({ cases }));
