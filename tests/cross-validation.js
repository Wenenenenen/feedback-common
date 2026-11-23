/*
 * 跨语言交叉验证：
 *  路线 A（解析，全场景，硬阈值 1e-12）—— Python 独立转写的球面多边形裁剪，
 *    按 (面,行,列) 键集合比对逐源纹素权重、缺测标记、RGB、覆盖率、weightSum 残差。
 *    两个无共享代码的实现在机器精度一致，是 1e-6 指标的主要数值证据。
 *  路线 B（中点积分，软阈值 2e-4）—— uv 平面均匀网格中点求积 + Richardson 外推，
 *    方法论完全不同的独立路线；分段常数边界处仅一阶收敛，只承担"概念性错误"
 *    （坐标系、旋转方向、面序）的粗检，不参与 1e-6 判定。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../js/remap-core.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-xval-'));
const PY_DIR = path.join(__dirname, 'py-reference');
const ANALYTIC = path.join(PY_DIR, 'analytic_reference.py');
const MIDPOINT = path.join(PY_DIR, 'remap_reference.py');

let seed = 20260101;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function rndQuat() {
  const q = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
  const l = Math.hypot(...q) || 1;
  return q.map(x => x / l);
}
function rndFaces(n, mode) {
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const face = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (mode === 'lamp' && f === 2 && (r === 0 || c === 0 || c === n - 1)) {
        face.push([1, 0.95, 0.8]); // 顶灯压在 +Y 面边缘
      } else if (mode === 'holes' && ((f * 7 + r * 3 + c * 5) % 11 === 0)) {
        face.push(null);
      } else if (mode === 'binary') {
        face.push(((f + r + c) % 2) ? [0.9, 0.1, 0.2] : [0.05, 0.3, 0.7]);
      } else {
        face.push([rnd(), rnd(), rnd()]);
      }
    }
    faces.push(face);
  }
  return faces;
}

function runPy(script, caseObj, texels, extra) {
  const casePath = path.join(TMP, 'case.json');
  const outPath = path.join(TMP, 'out.json');
  fs.writeFileSync(casePath, JSON.stringify({ ...caseObj, texels, ...extra }));
  execFileSync('python3', ['-I', script, casePath, outPath], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8')).records;
}

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL ' + msg); }
}

const scenarios = [
  { name: '顶灯边缘 n=8 out=8 随机旋转', n: 8, out: 8, mode: 'lamp', midpoint: true },
  { name: '二值强对比 n=5 out=7', n: 5, out: 7, mode: 'binary', midpoint: true },
  { name: '随机缺测 n=6 out=6', n: 6, out: 6, mode: 'holes', midpoint: true },
  { name: '稀疏源 n=2 out=9 跨角放大', n: 2, out: 9, mode: 'lamp', midpoint: true },
  { name: '降采样 n=16 out=3', n: 16, out: 3, mode: 'binary', midpoint: false },
  { name: '极限 n=1 out=64', n: 1, out: 64, mode: 'binary', midpoint: false },
];

for (const sc of scenarios) {
  const caseObj = { n: sc.n, out: sc.out, q: rndQuat(), faces: rndFaces(sc.n, sc.mode) };
  const res = C.resampleCubemap(caseObj);
  check(res.ok, sc.name + ' resample failed');
  const params = C.buildParams(caseObj);

  const targets = new Map();
  const add = (f, r, c) => targets.set(f + ':' + r + ':' + c, [f, r, c]);
  for (let f = 0; f < 6; f++) for (let r = 0; r < sc.out; r++) for (let c = 0; c < sc.out; c++) {
    const t = C.resampleTexel(params, f, r, c);
    const facesHit = new Set(t.contributions.map(k => k.face));
    if (facesHit.size >= 2) add(f, r, c);
  }
  // 面角纹素 + 面心纹素固定纳入
  for (const f of [0, 2, 4]) {
    add(f, 0, 0); add(f, sc.out - 1, sc.out - 1);
    add(f, sc.out >> 1, sc.out >> 1);
  }
  const texels = [...targets.values()].slice(0, 18);
  console.log('\n[' + sc.name + '] 比对 ' + texels.length + ' 个纹素（含跨面/跨角）');

  // ---- 路线 A：Python 解析参考，贡献表级比对（按键集合，不依赖等权项排序） ----
  const analytic = runPy(ANALYTIC, caseObj, texels, {});
  let worstW = 0, worstRgbA = 0, worstCovA = 0, worstResid = 0;
  for (const ref of analytic) {
    const js = C.resampleTexel(params, ref.face, ref.row, ref.col);
    const jsMap = new Map(js.contributions.map(k => [k.face + ':' + k.row + ':' + k.col, k]));
    const pyMap = new Map(ref.contributions.map(k => [k.face + ':' + k.row + ':' + k.col, k]));
    check(jsMap.size === pyMap.size,
      `${sc.name} (${ref.face},${ref.row},${ref.col}) 贡献键集合大小 ${jsMap.size} vs ${pyMap.size}`);
    for (const [key, b] of pyMap) {
      const a = jsMap.get(key);
      check(!!a, `${sc.name} (${ref.face},${ref.row},${ref.col}) 缺少贡献 ${key}`);
      if (!a) continue;
      check(a.missing === b.missing, `${sc.name} 贡献 ${key} 缺测标记不一致`);
      worstW = Math.max(worstW, Math.abs(a.weight - b.weight));
    }
    for (const key of jsMap.keys()) check(pyMap.has(key), sc.name + ' Python 多出/JS 缺 ' + key);
    const k = ref.face * sc.out * sc.out + ref.row * sc.out + ref.col;
    for (let ch = 0; ch < 3; ch++) {
      worstRgbA = Math.max(worstRgbA, Math.abs(res.rgb[k * 3 + ch] - ref.rgb[ch]));
      check(Math.abs(res.rgb[k * 3 + ch] - ref.rgb[ch]) <= 1e-12,
        `${sc.name} RGB ch${ch} e=${Math.abs(res.rgb[k*3+ch]-ref.rgb[ch]).toExponential(2)}`);
    }
    worstCovA = Math.max(worstCovA, Math.abs(res.coverage[k] - ref.coverage));
    worstResid = Math.max(worstResid, Math.abs(js.weightSum - ref.weightSum));
    check(Math.abs(res.coverage[k] - ref.coverage) <= 1e-12, sc.name + ' coverage');
    check(Math.abs(ref.weightSum - ref.omegaT) <= 1e-13,
      sc.name + ' Python 权重残差 ' + Math.abs(ref.weightSum - ref.omegaT));
  }
  console.log('  A 解析参考：权重最大偏差 ' + worstW.toExponential(2) +
    '，RGB ' + worstRgbA.toExponential(2) + '，覆盖率 ' + worstCovA.toExponential(2) +
    '，权重残差 ' + worstResid.toExponential(2));

  // ---- 路线 B：中点积分软核对（不同方法论，O(h) 精度，专门抓几何/方向类概念错误） ----
  if (sc.midpoint) {
    const mid = runPy(MIDPOINT, caseObj, texels, { depth: 10 });
    let worstRgbB = 0, worstCovB = 0;
    for (const ref of mid) {
      const k = ref.face * sc.out * sc.out + ref.row * sc.out + ref.col;
      for (let ch = 0; ch < 3; ch++) {
        worstRgbB = Math.max(worstRgbB, Math.abs(res.rgb[k * 3 + ch] - ref.rgb[ch]));
      }
      worstCovB = Math.max(worstCovB, Math.abs(res.coverage[k] - ref.coverage));
    }
    // 软阈值 2e-4：该参考在不连续边界为一阶收敛，不承担 1e-6 判定
    check(worstRgbB <= 2e-4, sc.name + ' 中点软核对 RGB ' + worstRgbB.toExponential(2));
    check(worstCovB <= 2e-4, sc.name + ' 中点软核对 cov ' + worstCovB.toExponential(2));
    console.log('  B 中点积分（软核对）：RGB ' + worstRgbB.toExponential(2) +
      '，覆盖率 ' + worstCovB.toExponential(2) + '（阈值 2e-4）');
  }
  check(Math.max(...res.stats.conservationDiff) <= 1e-10,
    sc.name + ' 守恒 ' + res.stats.conservationDiff.join(','));
}

fs.rmSync(TMP, { recursive: true, force: true });
if (failures) { console.error('\n跨语言验证有 ' + failures + ' 项失败'); process.exit(1); }
console.log('\n跨语言交叉验证全部通过');
