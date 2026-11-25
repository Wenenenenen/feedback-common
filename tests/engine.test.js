/* 引擎正确性测试：定点验收场景 + 小实例全枚举差分 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error('FAIL: ' + name + (extra ? '\n' + extra : ''));
  passed++;
  console.log('  ✓ ' + name);
}

function baseProject(over) {
  return Object.assign(
    { width: 4, height: 3, modulus: 8, fill_mode: 'premult', offset: 0, tolerance: 0, fill: [], key: [] },
    over || {}
  );
}

function seqOf(result) {
  return result.rows.map((r) => r.key_sorted_position);
}

// 序列比较：null 排最后（比任何整数大）
function cmpSeq(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null && y === null) continue;
    if (x === null) return 1; // 空位更大
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// 全枚举所有顺序保持匹配，求三级最优（先按 (t, 原始输入位置) 排序，与约定一致）
function bruteForce(fillInput, keyInput, modulus, offset, tol) {
  const fills = fillInput
    .map((r, p) => ({ ...r, p }))
    .sort((a, b) => a.t - b.t || a.p - b.p);
  const keys = keyInput
    .map((r, p) => ({ ...r, p }))
    .sort((a, b) => a.t - b.t || a.p - b.p);
  const n = fills.length;
  const m = keys.length;
  const eligible = fills.map((f) =>
    keys
      .map((k, j) => ({ j, dt: k.t - f.t - offset, ok: k.id % modulus === f.id % modulus && Math.abs(k.t - f.t - offset) <= tol }))
      .filter((x) => x.ok)
  );

  let best = null; // {count,cost,seq}
  const cur = new Array(n).fill(null);

  function consider(count, cost) {
    const cand = { count, cost, seq: cur.slice() };
    if (!best) return void (best = cand);
    if (cand.count > best.count) best = cand;
    else if (cand.count === best.count && cand.cost < best.cost) best = cand;
    else if (cand.count === best.count && cand.cost === best.cost && cmpSeq(cand.seq, best.seq) < 0) best = cand;
  }

  function dfs(i, jLast, count, cost) {
    if (i === n) return consider(count, cost);
    // 留空
    cur[i] = null;
    dfs(i + 1, jLast, count, cost);
    // 配某个 j>jLast
    for (const e of eligible[i]) {
      if (e.j <= jLast) continue;
      cur[i] = e.j;
      dfs(i + 1, e.j, count + 1, cost + Math.abs(e.dt));
      cur[i] = null;
    }
  }
  dfs(0, -1, 0, 0);
  return best;
}

console.log('样例包 project.json：');
{
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample', 'project.json'), 'utf8'));
  const r = E.analyze(p);
  assert.deepStrictEqual(seqOf(r), [0, 1, 2]);
  ok('样例三帧全部配对且键排序位置 0,1,2', true);
  assert.strictEqual(r.summary.pair_count, 3);
  assert.strictEqual(r.summary.total_abs_dt, 1);
  const dts = r.rows.map((x) => x.dt);
  assert.deepStrictEqual(dts, [0, 1, 0]);
  ok('样例带符号时差为 0,1,0（键t-填充t-offset=2）', true, JSON.stringify(dts));
  const keyOrig = r.rows.map((x) => x.key_original_position);
  assert.deepStrictEqual(keyOrig, [1, 2, 0]);
  ok('样例键原始输入位置为 1,2,0（输入乱序被排序）', true, JSON.stringify(keyOrig));
  const fillOrig = r.rows.map((x) => x.fill_original_position);
  assert.deepStrictEqual(fillOrig, [0, 1, 2]);
}

console.log('验收点2：同时异余、键输入相反、两边同配会逆序：');
{
  // fills: 同时刻，余数 0、1（输入顺序）
  // keys 输入顺序相反：先余1(id=9)，后余0(id=8)；同时刻 -> 排序位置 0=余1, 1=余0
  // offset2 tol1，取 kt=101 -> dt=-1 端点
  const p = baseProject({
    modulus: 8,
    offset: 2,
    tolerance: 1,
    fill: [
      { t: 100, id: 0, image: 'f.ppm' },
      { t: 100, id: 1, image: 'f.ppm' },
    ],
    key: [
      { t: 101, id: 9, image: 'k.pgm' }, // 原始位置0 -> 排序0（余1，配 fill1）
      { t: 101, id: 8, image: 'k.pgm' }, // 原始位置1 -> 排序1（余0，配 fill0）
    ],
  });
  const r = E.analyze(p);
  assert.strictEqual(r.summary.pair_count, 1, '只能有一对');
  // 字典序：[1,null] 小于 [null,0]（首位整数 < 空位），所以较早 fill0 用排序位置1的键
  assert.deepStrictEqual(seqOf(r), [1, null]);
  ok('逆序二选一后只有一对，且较早填充获得排序位置1的键', true, JSON.stringify(seqOf(r)));
  const row = r.rows[0];
  assert.strictEqual(row.key_original_position, 1);
  assert.strictEqual(row.key_sorted_position, 1);
  assert.strictEqual(row.dt, -1);
  ok('该键原始序号=1、排序位置=1、端点时差=-1，与导出表一致', true);
  assert.strictEqual(r.rows[1].key_sorted_position, null);
}

console.log('验收点3：总数优先，然后总绝对时差：');
{
  const p1 = baseProject({
    modulus: 2, // id 都取 0 => 同余
    offset: 0,
    tolerance: 3,
    fill: [
      { t: 10, id: 0, image: 'f' },
      { t: 13, id: 0, image: 'f' },
    ],
    key: [
      { t: 7, id: 0, image: 'k' },
      { t: 11, id: 0, image: 'k' },
    ],
  });
  const r1 = E.analyze(p1);
  assert.strictEqual(r1.summary.pair_count, 2);
  assert.strictEqual(r1.summary.total_abs_dt, 5);
  assert.deepStrictEqual(seqOf(r1), [0, 1]);
  ok('10配7、13配11：2对、总误差5', true);

  const p2 = baseProject({
    modulus: 2,
    offset: 0,
    tolerance: 3,
    fill: [
      { t: 10, id: 0, image: 'f' },
      { t: 13, id: 0, image: 'f' },
    ],
    key: [
      { t: 7, id: 0, image: 'k' },
      { t: 9, id: 0, image: 'k' },
      { t: 11, id: 0, image: 'k' },
    ],
  });
  const r2 = E.analyze(p2);
  assert.strictEqual(r2.summary.pair_count, 2);
  assert.strictEqual(r2.summary.total_abs_dt, 3);
  assert.deepStrictEqual(seqOf(r2), [1, 2]);
  ok('加入键9后改 10配9、13配11：总误差3', true, JSON.stringify(seqOf(r2)));
  assert.deepStrictEqual(r2.rows.map((x) => x.dt), [-1, -2]);
}

console.log('验收点4：同时同余重采同一格，文件顺序决定：');
{
  // 两个同时同刻同余 fill，仅一个零时差键 -> 原始位置靠前的 fill 得键
  const p1 = baseProject({
    fill: [
      { t: 50, id: 8, image: 'f' },
      { t: 50, id: 8, image: 'f' },
    ],
    key: [{ t: 50, id: 16, image: 'k' }],
  });
  const r1 = E.analyze(p1);
  assert.deepStrictEqual(seqOf(r1), [0, null]);
  assert.strictEqual(r1.rows[0].fill_original_position, 0);
  ok('单键时文件顺序靠前(原始位置0)的填充得键', true);

  // 加入同刻同余第二键 -> 依两路各自文件顺序配对（排序后对角）
  const p2 = baseProject({
    fill: [
      { t: 50, id: 8, image: 'f' },
      { t: 50, id: 8, image: 'f' },
    ],
    key: [
      { t: 50, id: 16, image: 'k' },
      { t: 50, id: 0, image: 'k' },
    ],
  });
  const r2 = E.analyze(p2);
  assert.deepStrictEqual(seqOf(r2), [0, 1]);
  assert.deepStrictEqual(r2.rows.map((x) => x.key_original_position), [0, 1]);
  ok('两键时按两路文件顺序对角配对', true);
}

console.log('模帧号回绕：');
{
  const p = baseProject({
    modulus: 8,
    offset: 0,
    tolerance: 0,
    fill: [{ t: 10, id: 7, image: 'f' }],
    key: [{ t: 10, id: 23, image: 'k' }], // 23%8=7
  });
  const r = E.analyze(p);
  assert.strictEqual(r.summary.pair_count, 1);
  ok('id 7 与 id 23 模8同余可配', true);
}

console.log('随机小实例 vs 全枚举（3000 组）：');
{
  let seed = 123456789;
  function rnd() {
    // xorshift32
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17; seed >>>= 0;
    seed ^= seed << 5; seed >>>= 0;
    return (seed >>> 0) / 4294967296;
  }
  function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

  for (let it = 0; it < 3000; it++) {
    const n = ri(0, 8);
    const m = ri(0, 8);
    const M = ri(2, 5);
    const offset = ri(-3, 3);
    const tol = ri(0, 4);
    const fill = [];
    const key = [];
    for (let i = 0; i < n; i++) fill.push({ t: ri(0, 16), id: ri(0, 2 * M + 2), image: 'f' });
    for (let j = 0; j < m; j++) key.push({ t: ri(0, 16), id: ri(0, 2 * M + 2), image: 'k' });

    const proj = baseProject({ modulus: M, offset, tolerance: tol, fill, key });
    const result = E.analyze(proj);
    const got = { count: result.summary.pair_count, cost: result.summary.total_abs_dt, seq: seqOf(result) };
    const want = bruteForce(fill, key, M, offset, tol);

    let bad = got.count !== want.count || got.cost !== want.cost || cmpSeq(got.seq, want.seq) !== 0;
    if (bad) {
      // 全枚举在 n=0 时 best 结构仍存在
      throw new Error(
        '差分不一致 iter=' + it +
        '\nproj=' + JSON.stringify({ M, offset, tol, fill, key }) +
        '\ngot =' + JSON.stringify(got) +
        '\nwant=' + JSON.stringify(want)
      );
    }

    // 校验导出表的顺序约束与 dt 定义
    let lastJ = -1;
    let sum = 0;
    for (const row of result.rows) {
      if (row.paired) {
        assert.ok(row.key_sorted_position > lastJ, '键必须严格递增');
        lastJ = row.key_sorted_position;
        const k = key[row.key_original_position];
        const f = fill[row.fill_original_position];
        assert.strictEqual(row.dt, k.t - f.t - offset, 'dt 定义');
        assert.ok(Math.abs(row.dt) <= tol, '容差');
        assert.strictEqual(k.id % M, f.id % M, '模帧号');
        sum += Math.abs(row.dt);
      }
    }
    assert.strictEqual(sum, got.cost, 'total_abs_dt 为各行之和');
  }
  ok('3000 组随机实例的配对数/总时差/字典序与全枚举完全一致', true);
}

console.log('\n引擎测试全部通过：' + passed + ' 项断言组');
