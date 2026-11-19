/* Node 数值校验：精确解 vs samples 中 reference.json；合法性用例；概率和误差 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const G = require('../src/gacha.js');

const DIR = path.resolve(__dirname, '../samples/extracted');
const reference = JSON.parse(fs.readFileSync(path.join(DIR, 'reference.json'), 'utf8'));

let failures = 0;
function check(label, got, want, tol) {
  const ok = Math.abs(got - want) <= (tol || 1e-10);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${got} want=${want}`);
}
function checkEq(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${got} want=${want}`);
}

const ruleFiles = ['simple', 'standard', 'carry', 'weapon'];
const allResults = {};

for (const name of ruleFiles) {
  const rule = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
  const v = G.validateRule(rule);
  assert.ok(v.ok, `${name} 应合法: ${JSON.stringify(v.errors)}`);

  const ref = reference[name];
  const ff = G.firstFive(rule);
  const ld = G.limitedDists(rule, [0.5, 0.9, 0.99]);
  allResults[name] = { rule, ff, ld };

  console.log(`\n===== ${name} =====`);
  // 第一个五星（参考值的 length/p1 基于裁掉 carry 前导零的视图；期望为不含垫抽的剩余抽数）
  check(`${name}.firstFive.expected`, ff.expectedRemaining, ref.firstFive.expected, 1e-9);
  check(`${name}.firstFive.sum`, ff.sum, 1, 1e-12);
  check(`${name}.firstFive.p1`, ff.pmfView[0], ref.firstFive.p1, 1e-15);
  checkEq(`${name}.firstFive.length`, ff.pmfView.length, ref.firstFive.length);
  check(`${name}.firstFive.pLast`, ff.pmf[ff.pmf.length - 1], ref.firstFive.pLast, 1e-14);
  if (rule.carry.pity > 0) {
    check(`${name}.firstFive.expectedTotal(含垫抽)`, ff.expected, ref.firstFive.expected + rule.carry.pity, 1e-9);
  }

  // 限定目标
  for (const key of Object.keys(ref).filter((k) => /^limited\d+$/.test(k))) {
    const m = Number(key.slice(7));
    const r = ld[m];
    const rr = ref[key];
    check(`${name}.${key}.expected`, r.expected, rr.expected, 1e-8);
    check(`${name}.${key}.sum`, r.sum, 1, 1e-12);
    checkEq(`${name}.${key}.q50`, r.quantiles[0.5], rr.q50);
    checkEq(`${name}.${key}.q90`, r.quantiles[0.9], rr.q90);
    checkEq(`${name}.${key}.q99`, r.quantiles[0.99], rr.q99);
    checkEq(`${name}.${key}.maxPulls`, r.maxPulls, rr.maxPulls);
  }
}

// 不合法规则：逐项报错
console.log('\n===== 非法规则 =====');
const badProb = JSON.parse(fs.readFileSync(path.join(DIR, 'invalid-prob.json'), 'utf8'));
const v1 = G.validateRule(badProb);
console.log('invalid-prob:', JSON.stringify(v1.errors));
assert.ok(!v1.ok);
assert.ok(v1.errors.some((e) => e.field === 'base' && /大于 1/.test(e.message)));

const badHard = JSON.parse(fs.readFileSync(path.join(DIR, 'invalid-hard.json'), 'utf8'));
const v2 = G.validateRule(badHard);
console.log('invalid-hard:', JSON.stringify(v2.errors));
assert.ok(!v2.ok);
assert.ok(v2.errors.some((e) => e.field === 'softStart' && /hard/.test(e.message)));

// 额外边界：limitedRate 越界、carry 越界、负数、targets（从合法规则出发逐项破坏）
const extra = JSON.parse(JSON.stringify(badHard));
Object.assign(extra, { hard: 90, limitedRate: -0.2 });
extra.carry = { pity: 95, misses: 3 };
extra.targets = [0, 2];
const v3 = G.validateRule(extra);
console.log('extra-invalid:', JSON.stringify(v3.errors));
for (const f of ['limitedRate', 'carry.pity', 'carry.misses', 'targets[0]']) {
  assert.ok(v3.errors.some((e) => e.field === f), `缺少字段报错: ${f}`);
}

// guaranteeAfter 非法时单独报错
const v4 = G.validateRule(Object.assign(JSON.parse(JSON.stringify(extra)), {
  limitedRate: 0.5,
  carry: { pity: 0, misses: 0 },
  targets: [1],
  guaranteeAfter: 0
}));
console.log('guaranteeAfter=0:', JSON.stringify(v4.errors));
assert.ok(v4.errors.some((e) => e.field === 'guaranteeAfter'));

// softStep 为负、非数字、缺失字段
const v5 = G.validateRule({ name: 'x', base: 0.01, softStart: 10, softStep: -1, hard: 20,
  limitedRate: 0.5, guaranteeAfter: 1, carry: { pity: 0, misses: 0 }, targets: [1] });
assert.ok(v5.errors.some((e) => e.field === 'softStep'));
const v6 = G.validateRule({ name: 'x', softStart: 10, hard: 20,
  limitedRate: 0.5, guaranteeAfter: 1, carry: { pity: 0, misses: 0 }, targets: [1] });
assert.ok(v6.errors.some((e) => e.field === 'base'));

// 软保底内提前到 1 的规则（effectiveHard < hard），验证 PMF 末端为 0 且和为 1
const early = {
  name: 'early-one', base: 0.5, softStart: 2, softStep: 0.6, hard: 5,
  limitedRate: 0.5, guaranteeAfter: 1, carry: { pity: 0, misses: 0 }, targets: [1]
};
const ve = G.validateRule(early);
assert.ok(ve.ok);
const eh = G.effectiveHard(early);
// k=2: 0.5+0.6=1.1 -> 1，故 effectiveHard=2
checkEq('effectiveHard(soft 段提前到1)', eh, 2);
const ffe = G.firstFive(early);
check('early.firstFive.sum', ffe.sum, 1, 1e-14);
check('early.firstFive.pmf[2]', ffe.pmf[2], 0.5, 1e-15);
check('early.firstFive.pmf[3..5]=0', ffe.pmf[3] + ffe.pmf[4] + ffe.pmf[5], 0, 0);

// 大保底 guaranteeAfter=2 的手算小用例
// base=1 每抽必五星；limitedRate=0.5；g=2；carry 零
// 第一个限定的周期数分布：1 周期 0.5；2 周期 0.25；3 周期（大保底）0.25
const hand = {
  name: 'hand', base: 1, softStart: 1, softStep: 0, hard: 1,
  limitedRate: 0.5, guaranteeAfter: 2, carry: { pity: 0, misses: 0 }, targets: [1, 2]
};
const vh = G.validateRule(hand);
assert.ok(vh.ok);
const lh = G.limitedDists(hand, [0.5, 0.9, 0.99]);
check('hand L1 pmf[1]', lh[1].pmf[1], 0.5, 1e-15);
check('hand L1 pmf[2]', lh[1].pmf[2], 0.25, 1e-15);
check('hand L1 pmf[3]', lh[1].pmf[3], 0.25, 1e-15);
check('hand L1 sum', lh[1].sum, 1, 1e-14);
check('hand L1 expected', lh[1].expected, 1.75, 1e-12);
// L2：两个限定周期之和。第二限定总是从 s=0 开始，同分布
// 期望 = 1.75 + 1.75 = 3.5
check('hand L2 expected', lh[2].expected, 3.5, 1e-12);
check('hand L2 sum', lh[2].sum, 1, 1e-14);

// 模拟器自检：standard 跑 5 万次，期望落在 4 倍标准误内、PMF 概率和 = 1
const stdRule = allResults.standard.rule;
const sim = G.simulate(stdRule, 50000, 20261120);
const cmpFF = G.comparePmf(allResults.standard.ff.pmf, sim.firstHist, 50000);
const cmpMean = G.compareExpectation(allResults.standard.ff, sim.firstHist, 50000);
console.log('\n模拟自检 standard N=50000: 首个五星标红项 =', cmpFF.flagged,
  ' 模拟均值 =', cmpMean.simMean.toFixed(4), ' z =', cmpMean.z.toFixed(3));
let simSum = 0;
for (let i = 1; i < sim.firstHist.length; i++) simSum += sim.firstHist[i];
checkEq('模拟首个五星计数=N', simSum, 50000);
assert.ok(Math.abs(cmpMean.z) <= 4, '模拟均值应在 4SE 内');

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
