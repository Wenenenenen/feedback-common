/* 满额性能 + 候选上限测试（验收点6、7） */
const assert = require('assert');
const E = require('../src/engine.js');

function buildFullScale() {
  const fill = [];
  const key = [];
  let group = 0;
  function addGroup(size) {
    const t = group * 3; // 组间隔 3
    for (let q = 0; q < size; q++) {
      fill.push({ t, id: 1000 + group * 7 + q, image: 'fill.ppm' }); // 先占位，下面统一改成同余
      key.push({ t, id: 2000 + group * 13 + q, image: 'key.pgm' });
    }
    group++;
  }
  for (let g = 0; g < 32000; g++) addGroup(5);
  for (let g = 0; g < 2000; g++) addGroup(10);
  // 全部同余（modulus 8：把 id 统一为 8 的倍数，同时保留“绝对帧号不同”的真实性）
  fill.forEach((r, i) => (r.id = 8 * (i + 1)));
  key.forEach((r, i) => (r.id = 8 * (i + 1) + 8));
  return {
    width: 4,
    height: 3,
    modulus: 8,
    fill_mode: 'premult',
    offset: 0,
    tolerance: 0,
    fill,
    key,
  };
}

console.log('验收点7：满额 18 万 ×2、恰好 100 万候选：');
{
  const proj = buildFullScale();
  assert.strictEqual(proj.fill.length, 180000);
  assert.strictEqual(proj.key.length, 180000);

  // 估算真实提交时 JSON 解析开销
  const json = JSON.stringify(proj);
  const kb = Buffer.byteLength(json);
  let t0 = process.hrtime.bigint();
  const reparsed = JSON.parse(json);
  let parseMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  工程 JSON 体积 ' + (kb / 1048576).toFixed(1) + ' MiB，JSON.parse ' + parseMs.toFixed(0) + ' ms');

  t0 = process.hrtime.bigint();
  const r = E.analyze(reparsed);
  const solveMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  analyze（排序+候选+DP+建表）耗时 ' + solveMs.toFixed(0) + ' ms');

  assert.strictEqual(r.summary.fill_count, 180000);
  assert.strictEqual(r.summary.key_count, 180000);
  assert.strictEqual(r.summary.candidate_count, 1000000, '候选恰好 100 万');
  assert.strictEqual(r.summary.pair_count, 180000, '全部 18 万填充都配上');
  assert.strictEqual(r.summary.unpaired_count, 0);
  assert.strictEqual(r.summary.total_abs_dt, 0, '时差全 0');

  // 组内按原输入顺序 -> 全局对角
  for (let i = 0; i < 180000; i++) {
    const row = r.rows[i];
    assert.strictEqual(row.paired, true);
    assert.strictEqual(row.dt, 0);
    assert.strictEqual(row.key_sorted_position, i, '组内按原输入顺序对角配对 @' + i);
    assert.strictEqual(row.key_original_position, i);
    assert.strictEqual(row.fill_original_position, i);
  }
  console.log('  ✓ 18 万对全部 dt=0，且组内按原输入顺序配对');

  const budgetMs = 12000;
  // Node 核心预算留足浏览器/解析/渲染余量：核心应显著快于 12s
  assert.ok(solveMs < 8000, '核心求解应 <8s，实际 ' + solveMs + 'ms');
  console.log('  ✓ 核心耗时 ' + solveMs.toFixed(0) + 'ms，满足 12s 端到端预算');
}

console.log('验收点6：候选 >100 万必须快速失败并抛 CANDIDATE_LIMIT：');
{
  const N = 1200; // 1200*1200 = 144 万 > 100 万
  const fill = [];
  const key = [];
  for (let i = 0; i < N; i++) {
    fill.push({ t: 100, id: 0, image: 'f.ppm' });
    key.push({ t: 100, id: 0, image: 'k.pgm' });
  }
  const proj = { width: 4, height: 3, modulus: 8, fill_mode: 'straight', offset: 0, tolerance: 0, fill, key };
  const t0 = process.hrtime.bigint();
  let threw = false;
  try {
    E.analyze(proj);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof E.GenlockError);
    assert.ok(/1000000|1,000,000/.test(e.message), '错误信息应含上限：' + e.message);
    assert.strictEqual(e.details[0].kind, 'candidate_limit');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(threw, '必须因候选超限抛错');
  assert.ok(ms < 1000, '超限应在枚举到第 100 万零 1 条时立即中止，实际 ' + ms + 'ms');
  console.log('  ✓ 枚举出上限后立即失败，耗时 ' + ms.toFixed(0) + 'ms');
}

console.log('\n性能/上限测试通过');
