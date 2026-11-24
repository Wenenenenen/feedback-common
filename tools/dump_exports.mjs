// 生成供独立 Python 检查器使用的导出产物到 /tmp/rks-check
import { mkdirSync, writeFileSync } from 'node:fs';
import { Studio, parseCurveObject, buildExportSVG, curveToObject } from '../rks.mjs';

const dir = '/tmp/rks-check';
mkdirSync(dir, { recursive: true });

function dump(name, curveOrStudio) {
  const c = curveOrStudio.curve || curveOrStudio;
  const obj = curveToObject(c, 'SPEC');
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(obj, null, 2));
  const built = buildExportSVG(c);
  writeFileSync(`${dir}/${name}.svg`, built.svg);
  return built;
}

// 1. 样例
const sample = JSON.parse((await import('node:fs')).readFileSync(new URL('../samples/rational-knot.json', import.meta.url), 'utf8'));
const st = new Studio(sample);
dump('sample', st);

// 2. 样例插入 1/2 后的曲线（齐次必须与原曲线完全一致 —— Python 精确核对）
st.insertKnot('1/2');
dump('sample-inserted-half', st);

// 3. 插入 1/3 与 2/3 后再插一次 1/3（重数 2）
const st3 = new Studio(sample);
st3.insertKnot('1/3');
st3.insertKnot('2/3');
st3.insertKnot('1/3');
dump('sample-multi', st3);

// 4. 真正的尖角曲线
const corner = parseCurveObject({
  degree: 2,
  knots: ['0', '0', '0', '1/2', '1/2', '1', '1', '1'],
  points: [['0', '0', '1'], ['1', '0', '1'], ['1', '1', '1'], ['2', '1', '1'], ['2', '2', '1']],
}).curve;
dump('corner', corner);

// 4b. 验收 AP5：极端权重三次窄峰（两端重合，u=.02 偏移 >1，中点却贴近）
const spike = parseCurveObject({
  degree: 3,
  knots: ['0', '0', '0', '0', '1', '1', '1', '1'],
  points: [['0', '0', '1'], ['10000', '0', '100'], ['0', '0', '1'], ['0', '0', '1000000']],
}).curve;
const spikeBuilt = dump('ap5-spike', spike);
console.log('ap5-spike segments', spikeBuilt.segmentCount, 'maxDev', spikeBuilt.maxDeviation);

// 5. 各次数随机曲线
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function makeCurve(seed, p, N) {
  const rnd = rng(seed);
  const K = N - p - 1;
  const runs = [];
  let rem = K;
  while (rem > 0) { let m = rnd() < .7 ? 1 : 1 + Math.floor(rnd() * p); m = Math.max(1, Math.min(m, p, rem)); runs.push(m); rem -= m; }
  const G = runs.length;
  const knots = [];
  for (let i = 0; i <= p; i++) knots.push('0');
  runs.forEach((m, g) => { const num = 2 * (g + 1), den = G + 1; for (let z = 0; z < m; z++) knots.push(`${num}/${den}`); });
  for (let i = 0; i <= p; i++) knots.push('2');
  const points = [];
  for (let i = 0; i < N; i++) {
    const xn = Math.floor(rnd() * 200) - 100, yn = Math.floor(rnd() * 200) - 100, wn = Math.floor(rnd() * 9) + 1;
    points.push([`${xn * wn}/21`, `${yn * wn}/21`, `${wn}/3`]);
  }
  return { degree: p, knots, points };
}
for (const p of [2, 3, 4, 5]) {
  const c = parseCurveObject(makeCurve(42 + p, p, 24 + p * 3)).curve;
  const b = dump(`rand-p${p}`, c);
  console.log(`rand-p${p}: ${b.segmentCount} segments, maxDev ${b.maxDeviation.toFixed(4)}`);
}

// 6. 大规模 512 CP
const big = makeCurve(7, 3, 512);
const bigC = parseCurveObject(big).curve;
const tb = Date.now();
const bb = dump('big512', bigC);
console.log(`big512: ${bb.segmentCount} segments, maxDev ${bb.maxDeviation.toFixed(4)}, ${Date.now() - tb}ms`);

console.log('dumped to', dir);
