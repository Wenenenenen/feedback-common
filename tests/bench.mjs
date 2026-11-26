// 12 万帧性能基准：最坏情况（两侧都 12 万、含冻结/重复帧）与不对称情况
import { parseFingerprints, align } from '../web/algo.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function makeFp(n, seed, freezeChance) {
  const r = rng(seed);
  const arr = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (prev !== null && r() < freezeChance) {
      arr.push(prev);
    } else {
      let v = 0n;
      for (let k = 0; k < 4; k++) v = (v << 16n) | BigInt(Math.floor(r() * 65536));
      prev = v.toString(16).padStart(16, '0');
      arr.push(prev);
    }
  }
  return arr;
}
function makeDelivery(aArr, seed, rate) {
  const r = rng(seed);
  const b = [];
  for (const f of aArr) {
    if (r() < rate) continue;
    b.push(f);
    if (r() < rate) b.push(f);
  }
  return b;
}

const settings = { maxDistance: 4, gapOpen: 9, gapExtend: 2 };
// 受控编辑：每删/插若干帧后插回补偿，把累积偏移钳在带宽内
function makeBoundedDelivery(aArr, seed, rate) {
  const r = rng(seed);
  const b = [];
  let drift = 0;
  for (const f of aArr) {
    if (drift > -50 && r() < rate) { drift -= 1; continue; } // 缺帧
    b.push(f);
    if (drift < 50 && r() < rate) { b.push(f); drift += 1; } // 冻结多帧
  }
  return b;
}
const cases = [
  ['12万 vs 12万 高冻结（同源）', () => { const a = makeFp(120000, 11, 0.3); return [a, a.slice()]; }],
  ['12万 编辑派生（受控偏移）', () => { const a = makeFp(120000, 33, 0.2); return [a, makeBoundedDelivery(a, 44, 0.08)]; }],
  ['12万 vs 11.994万（长度差60，同源）', () => { const a = makeFp(120000, 55, 0.1); return [a, a.slice(0, 119940)]; }],
];

for (const [name, gen] of cases) {
  const [aArr, bArr] = gen();
  const A = parseFingerprints(aArr, 'A');
  const B = parseFingerprints(bArr, 'B');
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const r = align(A, B, settings, [], (p) => {});
  const t1 = performance.now();
  const memAfter = process.memoryUsage().heapUsed;
  const matchN = r.steps.filter((s) => s.t === 'm').length;
  console.log(
    `${name}: ${t1 - t0 >= 0 ? Math.round(t1 - t0) : ''}ms | A=${aArr.length} B=${bArr.length} | ` +
    `fee=${r.totalFee} segs=${r.gapSegments} 配对=${matchN} | 堆增量=${Math.round((memAfter - memBefore) / 1048576)}MB`,
  );
}

// 带锁点的 12 万（锁点切分后多段）
{
  const aArr = makeFp(120000, 77, 0.2);
  const bArr = makeBoundedDelivery(aArr, 88, 0.06);
  const A = parseFingerprints(aArr, 'A');
  const B = parseFingerprints(bArr, 'B');
  const free = align(A, B, settings, []);
  const ms = free.steps.filter((s) => s.t === 'm');
  const locks = [ms[1000], ms[30000], ms[70000], ms[100000]].map((s) => ({ i: s.ai, j: s.bi }));
  const t0 = performance.now();
  const r = align(A, B, settings, locks);
  const t1 = performance.now();
  console.log(`12万 带4锁点: ${Math.round(t1 - t0)}ms | fee=${r.totalFee} segs=${r.gapSegments} 锁=${r.locks.length}`);
}
