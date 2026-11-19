/* 从 index.html 抽取全部 <script> 内联代码做语法检查；并对比两份引擎实现是否同源 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log(`抽取到 ${scripts.length} 段脚本（含引擎与应用层）`);

// 1) 语法检查（new vm.Script 只解析不执行）
scripts.forEach((s, i) => {
  try {
    new vm.Script(s, { filename: `inline-${i}.js` });
    console.log(`PASS  脚本段 ${i} 语法正确（${s.length} 字符）`);
  } catch (e) {
    console.error(`FAIL  脚本段 ${i} 语法错误: ${e.message}`);
    process.exit(1);
  }
});

// 2) 在沙箱里执行引擎段，验证与 Node 版结果一致
const engineSrc = scripts.find((s) => s.includes('function validateRule'));
if (!engineSrc) { console.error('FAIL 未找到内联引擎段'); process.exit(1); }
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(engineSrc, sandbox);
const browserG = sandbox.window.Gacha;
const nodeG = require('../src/gacha.js');

const cases = ['simple', 'standard', 'carry', 'weapon'];
const DIR = path.resolve(__dirname, '../samples/extracted');
let fail = 0;
for (const name of cases) {
  const rule = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
  const a = nodeG.firstFive(rule);
  const b = browserG.firstFive(rule);
  if (Math.abs(a.expected - b.expected) > 1e-15 || Math.abs(a.sum - b.sum) > 1e-15) {
    console.error(`FAIL 浏览器引擎 firstFive(${name}) 与 Node 版不一致`);
    fail++;
  }
  const la = nodeG.limitedDists(rule, [0.5, 0.9, 0.99]);
  const lb = browserG.limitedDists(rule, [0.5, 0.9, 0.99]);
  for (const m of rule.targets) {
    if (Math.abs(la[m].expected - lb[m].expected) > 1e-12 || la[m].quantiles[0.99] !== lb[m].quantiles[0.99]) {
      console.error(`FAIL 浏览器引擎 limited(${name},m=${m}) 与 Node 版不一致`);
      fail++;
    }
  }
}
// PRNG 同源：同种子前 5 个随机数一致
const ra = nodeG.mulberry32(20261120), rb = browserG.mulberry32(20261120);
for (let i = 0; i < 5; i++) {
  if (ra() !== rb()) { console.error('FAIL PRNG 序列不一致'); fail++; }
}
console.log(fail === 0 ? 'PASS  浏览器内联引擎与 Node 引擎数值一致，PRNG 同源' : `${fail} 项失败`);
process.exit(fail ? 1 : 0);
