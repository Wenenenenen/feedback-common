'use strict';
const assert = require('assert');
const path = require('path');
const VegetationModule = require(path.join(__dirname, '..', 'src', 'core.js'));
const V = VegetationModule();
const { bruteForce } = require('./brute.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

/* ---------------- 哈希与样例 ---------------- */
check('哈希与独立 BigInt 实现一致', () => {
  const u32 = n => Number(BigInt.asUintN(32, BigInt(n)));
  const im = (a, b) => Number(BigInt.asUintN(32,
    BigInt.asIntN(32, BigInt(a)) * BigInt.asIntN(32, BigInt(b))));
  function ref(seed, x, y, layer, salt) {
    let w = u32(seed ^ im(x, 73856093) ^ im(y, 19349663) ^
      im(layer + 1, 83492791) ^ im(salt + 1, 2654435761));
    w = u32(im(w ^ (w >>> 16), 2246822507));
    w = u32(im(w ^ (w >>> 13), 3266489909));
    return u32(w ^ (w >>> 16));
  }
  for (const seed of [0, 1, -1, 12, 2147483647, -2147483648, 123456]) {
    for (const x of [0, -1000000, 1000000, -3, 5]) {
      for (const y of [0, -1, 999999, 7]) {
        for (const l of [0, 1]) {
          for (const s of [0, 1, 2, 3]) {
            assert.strictEqual(V.hash(seed, x, y, l, s), ref(seed, x, y, l, s),
              'seed=' + seed + ' x=' + x + ' y=' + y + ' l=' + l + ' s=' + s);
          }
        }
      }
    }
  }
});

check('样例候选：位置在格内、半径来自物种', () => {
  const cfg = V.normalizeConfig(require(path.join(__dirname, '..', 'samples', 'biome-spawn.json')));
  const c = V.candidateAt(cfg, 0, 0, 0);
  assert.ok(c);
  assert.strictEqual(c.radius, 320);
  assert.ok(c.px >= 0 * 256 && c.px < 1 * 256);
  assert.ok(c.py >= 0 * 256 && c.py < 1 * 256);
  // 负格
  const n = V.candidateAt(cfg, 1, -3, -2);
  assert.ok(n);
  assert.ok(n.px >= -3 * 256 && n.px < -2 * 256);
  assert.ok(n.py >= -2 * 256 && n.py < -1 * 256);
});

check('总权重为 0 时无候选', () => {
  const cfg = V.normalizeConfig({
    seed: 1,
    species: [[{ id: 'a', radius: 100 }], [{ id: 'b', radius: 50 }]],
    base: [[0], [0]],
    patches: [],
    window: [0, 0, 4, 4]
  });
  assert.strictEqual(V.candidateAt(cfg, 0, 0, 0), null);
  const res = V.bake(cfg, [0, 0, 4, 4]);
  assert.strictEqual(res.survivors.length, 0);
});

check('patches 后项覆盖前项、未给层的 patch 不串层', () => {
  const cfg = V.normalizeConfig({
    seed: 5,
    species: [[{ id: 'a', radius: 10 }], [{ id: 'b', radius: 10 }]],
    base: [[1], [1]],
    patches: [
      { rect: [0, 0, 10, 10], weights: [[0], [1]] },
      { rect: [5, 5, 10, 10], weights: [[1], [0]] },
      { rect: [0, 0, 10, 10], weights: [null, [0]] }
    ],
    window: [0, 0, 10, 10]
  });
  // (2,2) 命中 patch0：树权重 0，草权重 1
  assert.deepStrictEqual(V.weightsAt(cfg, 0, 2, 2), [0]);
  // (6,6) 命中 patch0、patch1、patch2（后项优先）：patch2 未给树层则回退 patch1 的树权重 1
  assert.deepStrictEqual(V.weightsAt(cfg, 0, 6, 6), [1]);
  // (6,6) 草层：patch2 给了 [0]，覆盖
  assert.deepStrictEqual(V.weightsAt(cfg, 1, 6, 6), [0]);
});

/* ---------------- 候选/淘汰的一致性 ---------------- */
const sampleCfg = V.normalizeConfig(require(path.join(__dirname, '..', 'samples', 'biome-spawn.json')));

check('样例窗口：与暴力实现逐项一致', () => {
  const got = V.bake(sampleCfg, [-3, -2, 8, 6]).survivors;
  const exp = bruteForce(sampleCfg);
  assert.deepStrictEqual(got.map(sig), exp.map(sig));
});

function sig(c) { return [c.layer, c.x, c.y, c.px, c.py, c.species].join(':'); }

/* ---------------- 多种随机配置 ---------------- */
function randCfg(seed) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  function layerSpecies() {
    const n = ri(1, 4);
    const arr = [];
    for (let i = 0; i < n; i++) arr.push({ id: 's' + i, radius: ri(1, 3000) });
    return arr;
  }
  const sp0 = layerSpecies(), sp1 = layerSpecies();
  const patches = [];
  const np = ri(0, 4);
  for (let i = 0; i < np; i++) {
    const rect = [ri(-30, 20), ri(-30, 20), ri(1, 25), ri(1, 25)];
    const w0 = sp0.map(() => ri(0, 3));
    const w1 = sp1.map(() => ri(0, 3));
    const weights = rnd() < 0.3 ? [null, w1] : (rnd() < 0.3 ? [w0, null] : [w0, w1]);
    patches.push({ rect, weights });
  }
  return V.normalizeConfig({
    seed: ri(-1000, 1000),
    species: [sp0, sp1],
    base: [sp0.map(() => ri(0, 3)), sp1.map(() => ri(0, 3))],
    patches,
    window: [ri(-10, 0), ri(-10, 0), ri(1, 20), ri(1, 20)]
  });
}

check('随机配置（40 组）：与暴力实现一致', () => {
  for (let t = 0; t < 40; t++) {
    const cfg = randCfg(1000 + t);
    const got = V.bake(cfg, cfg.window).survivors;
    // 暴力实现故意用 2 倍外扩，避免与内核共享同一个外扩公式而产生假一致
    const exp = bruteForce(cfg, null, 2);
    try {
      assert.deepStrictEqual(got.map(sig), exp.map(sig));
    } catch (e) {
      e.message = 'seed=' + (1000 + t) + ' window=' + JSON.stringify(cfg.window) + '\n' + e.message;
      throw e;
    }
  }
});

/* ---------------- 分块合并一致性 ---------------- */
check('分块烘焙合并 = 整窗烘焙', () => {
  for (let t = 0; t < 25; t++) {
    const cfg = randCfg(5000 + t);
    const W = cfg.window;
    const full = V.bake(cfg, W).survivors;
    // 拆成 4 块
    const mx = W[0] + Math.floor(W[2] / 2);
    const my = W[1] + Math.floor(W[3] / 2);
    const chunks = [
      [W[0], W[1], mx - W[0], my - W[1]],
      [mx, W[1], W[0] + W[2] - mx, my - W[1]],
      [W[0], my, mx - W[0], W[1] + W[3] - my],
      [mx, my, W[0] + W[2] - mx, W[1] + W[3] - my]
    ].filter(c => c[2] > 0 && c[3] > 0);
    const parts = chunks.map(c => V.bake(cfg, c));
    const merged = V.mergeResults(parts).survivors;
    try {
      assert.deepStrictEqual(merged.map(sig), full.map(sig));
    } catch (e) {
      e.message = 'seed=' + (5000 + t) + '\n' + e.message;
      throw e;
    }
  }
});

check('先算哪一块不改变结果（顺序无关）', () => {
  const cfg = randCfg(7777);
  const W = cfg.window;
  const mx = W[0] + Math.floor(W[2] / 2);
  const chunks = [
    [W[0], W[1], mx - W[0], W[3]],
    [mx, W[1], W[0] + W[2] - mx, W[3]]
  ];
  const a = V.mergeResults(chunks.map(c => V.bake(cfg, c))).survivors.map(sig);
  const b = V.mergeResults(chunks.slice().reverse().map(c => V.bake(cfg, c))).survivors.map(sig);
  assert.deepStrictEqual(a, b);
});

/* ---------------- 极端半径（含草半径远大于树） ---------------- */
check('极端半径组合：与参考实现一致', () => {
  const combos = [[256, 8192], [1, 8192], [8192, 256], [512, 4096], [4096, 512], [1, 1]];
  for (const [rt, rg] of combos) {
    for (const seed of [1, 7, 99]) {
      const cfg = V.normalizeConfig({
        seed: seed,
        species: [[{ id: 't', radius: rt }], [{ id: 'g', radius: rg }]],
        base: [[1], [1]], patches: [],
        window: [0, 0, 6, 6]
      });
      const got = V.bake(cfg, cfg.window).survivors.map(sig);
      const exp = bruteForce(cfg, cfg.window, 1.5).map(sig);
      assert.deepStrictEqual(got, exp, 'rt=' + rt + ' rg=' + rg + ' seed=' + seed);
    }
  }
});

check('极端半径下的分块一致', () => {
  const combos = [[256, 8192], [1, 8192], [8192, 256], [512, 4096], [4096, 512]];
  for (const [rt, rg] of combos) {
    for (const seed of [1, 7]) {
      const w = [-20, -20, 13, 11];
      const cfg = V.normalizeConfig({
        seed: seed,
        species: [[{ id: 't', radius: rt }], [{ id: 'g', radius: rg }]],
        base: [[1], [1]], patches: [], window: w
      });
      const full = V.bake(cfg, w).survivors.map(sig);
      const mx = w[0] + Math.floor(w[2] / 2), my = w[1] + Math.floor(w[3] / 2);
      const chunks = [
        [w[0], w[1], mx - w[0], my - w[1]],
        [mx, w[1], w[0] + w[2] - mx, my - w[1]],
        [w[0], my, mx - w[0], w[1] + w[3] - my],
        [mx, my, w[0] + w[2] - mx, w[1] + w[3] - my]
      ].filter(c => c[2] > 0 && c[3] > 0);
      const merged = V.mergeResults(chunks.map(c => V.bake(cfg, c))).survivors.map(sig);
      assert.deepStrictEqual(merged, full, 'rt=' + rt + ' rg=' + rg + ' seed=' + seed);
    }
  }
});

check('小窗口 + 大半径：外扩足够覆盖远处保留树', () => {
  let total = 0;
  for (const rt of [512, 1024, 2048]) {
    for (const rg of [512, 1024]) {
      for (const w of [[0, 0, 1, 1], [0, 0, 2, 2], [-1, 0, 1, 3]]) {
        for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
          total++;
          const cfg = V.normalizeConfig({
            seed: seed,
            species: [[{ id: 't', radius: rt }], [{ id: 'g', radius: rg }]],
            base: [[1], [1]], patches: [], window: w
          });
          const got = V.bake(cfg, w).survivors.map(sig);
          const exp = bruteForce(cfg, w, 2.5).map(sig);
          assert.deepStrictEqual(got, exp, 'rt=' + rt + ' rg=' + rg + ' w=' + w + ' seed=' + seed);
        }
      }
    }
  }
  assert.ok(total >= 180);
});

/* ---------------- 单格查询与烘焙一致 ---------------- */
check('点格查询结果与整窗烘焙一致', () => {
  const cfg = sampleCfg;
  const full = V.bake(cfg, cfg.window, { details: true });
  for (let y = cfg.window[1]; y < cfg.window[1] + cfg.window[3]; y++) {
    for (let x = cfg.window[0]; x < cfg.window[0] + cfg.window[2]; x++) {
      const q = V.queryTile(cfg, x, y);
      for (const layer of [0, 1]) {
        const qd = V.candidateAt(cfg, layer, x, y);
        const fd = full.details.get(layer + ':' + y + ':' + x);
        if (!qd) { assert.strictEqual(qd, null); continue; }
        assert.ok(fd, '整窗详情缺失 ' + layer + ':' + x + ',' + y);
        assert.strictEqual(qd.rank, fd.rank);
        // kept 与 reason 应与整窗一致
        const qEntry = layer === 0 ? q.tree : q.grass;
        assert.strictEqual(qEntry.kept, fd.kept, 'kept 不一致 ' + layer + ':' + x + ',' + y);
        assert.strictEqual(qEntry.reason, fd.reason, 'reason 不一致 ' + layer + ':' + x + ',' + y);
      }
    }
  }
});

/* ---------------- 导出格式 ---------------- */
check('导出按层、格 y、格 x 升序', () => {
  const res = V.bake(sampleCfg, sampleCfg.window);
  const text = V.exportText(res, { header: true });
  const lines = text.trim().split('\n');
  assert.deepStrictEqual(lines[0].split('\t'), ['layer', 'gx', 'gy', 'px', 'py', 'species']);
  const rows = lines.slice(1).map(l => l.split('\t').map(Number));
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], c = rows[i];
    assert.ok(p[0] < c[0] || (p[0] === c[0] && (p[2] < c[2] || (p[2] === c[2] && p[1] <= c[1]))));
  }
  // 默认不带表头，每行只含数据
  const plain = V.exportText(res).trim().split('\n');
  assert.strictEqual(plain[0].split('\t').length, 6);
  assert.ok(!/^layer/.test(plain[0]));
});

/* ---------------- 取消 ---------------- */
check('shouldCancel 会中止并抛出 Cancelled', () => {
  let n = 0;
  assert.throws(() => {
    V.bake(sampleCfg, [-3, -2, 8, 6], { shouldCancel: () => (++n > 0) });
  }, (e) => e.name === 'Cancelled');
});

/* ---------------- 恰等半径保留 ---------------- */
check('距离恰等较大半径时保留', () => {
  const a = { px: 0, py: 0, radius: 100 };
  const b = { px: 100, py: 0, radius: 50 };
  assert.strictEqual(V.conflicts(a, b), false);
  const c = { px: 99, py: 0, radius: 50 };
  assert.strictEqual(V.conflicts(a, c), true);
});

/* ---------------- 配置校验 ---------------- */
check('配置校验拒绝越界值', () => {
  const bad = (o) => assert.throws(() => V.normalizeConfig(o), (e) => e.name === 'ConfigError');
  bad({ seed: 1, species: [[], []], base: [[], []], window: [0, 0, 1025, 1] });
  bad({ seed: 1, species: [[{ id: 'a', radius: 0 }], []], base: [[1], []], window: [0, 0, 1, 1] });
  bad({ seed: 1, species: [[{ id: 'a', radius: 9000 }], []], base: [[1], []], window: [0, 0, 1, 1] });
  bad({ seed: 1, species: [[], []], base: [[], []], window: [1000001, 0, 1, 1] });
  bad({ seed: 1.5, species: [[], []], base: [[], []], window: [0, 0, 1, 1] });
});

console.log('');
if (failures) { console.log(failures + ' 项失败'); process.exit(1); }
console.log('全部通过');
