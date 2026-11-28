/* Node 测试：JS 求解器 vs Python Fraction 精确解；校验器非法输入用例。
   运行: node tests/test-core.js
   先生成参考: python3 -I tests/ref_solve.py
*/
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const FC = require(path.join(__dirname, '..', 'fluorescent-core.js'));

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---------- 1. 与精确解对比 ----------
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref-cases.json'), 'utf8'));
const matrices = ['direct', 'incident', 'reflected', 'fluorescent', 'outgoing', 'rgb'];
ref.cases.forEach((data, ci) => {
  const got = FC.solve(data);
  const exp = ref.expected[ci];
  let maxErr = 0, where = '';
  matrices.forEach((m) => {
    for (let i = 0; i < got[m].length; i++) {
      for (let k = 0; k < got[m][i].length; k++) {
        const e = Math.abs(got[m][i][k] - exp[m][i][k]);
        if (e > maxErr) { maxErr = e; where = `${m}[${i}][${k}] got=${got[m][i][k]} exp=${exp[m][i][k]}`; }
      }
    }
  });
  check(`case ${ci} (N=${got.N}, B=${got.B}, links=${data.links.length}) 最大绝对误差 < 1e-7`,
    maxErr < 1e-7, `maxErr=${maxErr} at ${where}`);
  check(`case ${ci} 求解器自检残差 < 1e-10`, got.residual < 1e-10, `residual=${got.residual}`);
  // 守恒检查：每贴片跨波段合计 出射 ≤ 入射（同波段反射 + 向更长波段荧光，单波段可因荧光净流入而超出）
  let badCons = 0;
  for (let i = 0; i < got.N; i++) {
    const sumE = got.incident[i].reduce((a, b) => a + b, 0);
    const sumO = got.outgoing[i].reduce((a, b) => a + b, 0);
    if (sumO > sumE + 1e-9) badCons++;
  }
  check(`case ${ci} 能量守恒 跨波段 ΣO≤ΣE 逐贴片`, badCons === 0, `${badCons} violations`);
});

// ---------- 2. 灯光倍数 ----------
{
  const data = ref.cases[0];
  const base = FC.solve(data);
  const dim = FC.solve(data, [0.5, 0.5, 0.5]);
  let maxErr = 0;
  for (let i = 0; i < base.N; i++) for (let k = 0; k < base.B; k++) {
    maxErr = Math.max(maxErr, Math.abs(dim.incident[i][k] - 0.5 * base.incident[i][k]));
  }
  check('灯光整体减半 -> 所有稳态量线性减半', maxErr < 1e-12, `err=${maxErr}`);
  // 只关某一波段灯
  const only0 = FC.solve(data, [1, 0, 0]);
  check('只开波段0灯：波段1/2直射为0', only0.direct.every((row) => row[1] === 0 && row[2] === 0));
}

// ---------- 3. 校验器：非法输入必须报出贴片+波段 / 传播来源 ----------
const valid = JSON.parse(JSON.stringify(ref.cases[0]));
function expectError(mutator, needle) {
  const d = JSON.parse(JSON.stringify(valid));
  mutator(d);
  const r = FC.validate(d);
  const hit = !r.ok && r.errors.some((e) => e.includes(needle));
  check('非法输入被拒且包含「' + needle + '」', hit, r.ok ? '意外通过' : r.errors.join(' | '));
}
expectError((d) => { d.patches[0].reflect[1] = 1.05; }, 'label');
expectError((d) => { d.patches[0].reflect[1] = 1.05; }, '530');
expectError((d) => { d.patches[0].convert = [[0, 0, 0.2]]; }, 'label'); // 目标波段不更长
expectError((d) => { d.patches[0].convert = [[0, 2, 0.95]]; }, '410');  // 反射+荧光>1
expectError((d) => { d.links = [['label', 'panel', 0.6], ['label', 'label', 0.4]]; }, 'label'); // 来源合计 1.0>0.95
expectError((d) => { d.links = [['ghost', 'panel', 0.1]]; }, 'ghost');
expectError((d) => { d.patches.push({ id: 'x', direct: [1], reflect: [1], convert: [] }); }, 'x'); // 数组长度不符
expectError((d) => { d.bands = [410, 400, 620]; }, '递增');

// 合法边界：来源合计正好 0.95、反射+荧光正好 1
{
  const d = JSON.parse(JSON.stringify(valid));
  d.links = [['label', 'panel', 0.95]];
  check('来源合计 = 0.95 合法', FC.validate(d).ok);
  const d2 = JSON.parse(JSON.stringify(valid));
  d2.patches[0].reflect[0] = 0.6;
  d2.patches[0].convert = [[0, 1, 0.4]];
  check('反射+荧光 = 1.0 合法', FC.validate(d2).ok);
}

// ---------- 4. 非法后保留上次有效结果（页面逻辑在 UI 层，这里模拟） ----------
{
  const good = FC.solve(valid);
  const broken = JSON.parse(JSON.stringify(valid));
  broken.patches[0].reflect[0] = 5;
  const r = FC.validate(broken);
  check('非法材料不产生新解，旧解仍可用', !r.ok && good.outgoing.length === 2 && good.outgoing[0].length === 3);
}

// ---------- 5. 规模上限 ----------
{
  const d = JSON.parse(JSON.stringify(valid));
  const big = {
    bands: d.bands, observerRGB: d.observerRGB,
    patches: Array.from({ length: 97 }, (_, i) => ({
      id: 'q' + i, direct: [1, 0, 0], reflect: [0.1, 0.1, 0.1], convert: [],
    })),
    links: [],
  };
  check('97 贴片超限被拒', !FC.validate(big).ok && FC.validate(big).errors.some((e) => e.includes('96')));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
