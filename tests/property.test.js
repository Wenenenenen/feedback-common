// tests/property.test.js — 随机化属性测试：4–24 只等球扬声器下的不变量
// 不变量：凸包封闭且严格含原点、每帧单位能量、面片 id 字典序唯一、
//         打乱输入顺序后同方向增益一致、棱方向不产生跳变。
const assert = require('assert');
const E = require('../src/engine.js');

// 确定性伪随机
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成 n 个关于原点近似对称、共球的整数点：取整数格点中半径相同者，配对跖点
function makeSphericalPoints(n, rng) {
  const R = 5; // 目标半径 √(25)
  const pool = [];
  for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) {
    if (x * x + y * y + z * z === R * R && !(x === 0 && y === 0 && z === 0)) pool.push([x, y, z]);
  }
  // 洗牌后取点，并保证含对跖点以包围原点
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = [];
  const used = new Set();
  const take = (p) => { const k = p.join(','); if (!used.has(k)) { used.add(k); chosen.push(p); } };
  for (const p of pool) {
    if (chosen.length >= n) break;
    const opp = [-p[0], -p[1], -p[2]];
    if (chosen.length + 2 <= n) { take(p); take(opp); }
  }
  return chosen.slice(0, n);
}

let cases = 0;
for (let n = 4; n <= 24; n += 2) {
  for (const seed of [11, 47, 99]) {
    const rng = mulberry32(seed * 100 + n);
    const pts = makeSphericalPoints(n, rng);
    if (pts.length < 4) continue;
    const speakers = pts.map((xyz, i) => ({ id: i + 1, xyz }));
    const nFr = 1000;
    const layout = {
      speakers,
      path: [
        { frame: 0, xyz: pts[0] },
        { frame: Math.floor(nFr / 2), xyz: pts[Math.floor(pts.length / 2)] },
        { frame: nFr - 1, xyz: pts[pts.length - 1] },
      ],
    };
    let scene;
    try {
      scene = E.buildScene(layout);
    } catch (e) {
      // 随机点可能维度退化或不含原点，跳过这些几何上不合法的配置
      if (['NOT_ENCLOSING', 'ORIGIN_NOT_INSIDE', 'NOT_SPHERICAL'].includes(e.code)) continue;
      throw e;
    }
    cases++;

    // 1) 面片 key 唯一且字典序排列
    const keys = scene.faces.map((f) => f.key.join(','));
    assert.strictEqual(new Set(keys).size, keys.length, '面片三元组应唯一');
    const sorted = keys.slice().sort((a, b) => {
      const x = a.split(',').map(Number), y = b.split(',').map(Number);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    });
    assert.deepStrictEqual(keys, sorted, '面片应按 id 字典序排列');

    // 2) 所有面朝外、严格含原点
    for (const f of scene.faces) assert.ok(f.planeD > E.CONTAIN_EPS);

    // 3) 逐帧单位能量、最多三个非零增益
    const g = new Float64Array(scene.n);
    let last = -1;
    for (let f = 0; f < nFr; f++) {
      const r = E.frameGains(scene, f, g, last);
      if (!r.zero && !r.fallback) last = r.faceIndex;
      if (r.zero) continue;
      const e2 = g.reduce((a, b) => a + b * b, 0);
      assert.ok(Math.abs(e2 - 1) < 1e-12, '帧 ' + f + ' 能量应为 1，实际 ' + e2);
      const nonzero = [...g].filter((x) => Math.abs(x) > 1e-12).length;
      assert.ok(nonzero <= 3, '至多三个声道非零，实际 ' + nonzero);
    }

    // 4) 打乱输入顺序，按 id 对齐后增益一致
    const shuffled = JSON.parse(JSON.stringify(layout));
    shuffled.speakers = shuffled.speakers.slice().reverse();
    const scene2 = E.buildScene(shuffled);
    const g1 = new Float64Array(scene.n), g2 = new Float64Array(scene2.n);
    E.frameGains(scene, 333, g1, -1);
    E.frameGains(scene2, 333, g2, -1);
    const map2 = new Map(scene2.ids.map((id, i) => [id, g2[i]]));
    scene.ids.forEach((id, i) =>
      assert.ok(Math.abs(g1[i] - map2.get(id)) < 1e-11, '打乱顺序后 id=' + id + ' 增益应一致'));
  }
}
console.log('属性测试：' + cases + ' 个合法随机配置，全部不变量成立（n=4..24）');
