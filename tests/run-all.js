#!/usr/bin/env node
'use strict';
/* 汇总测试入口：node tests/run-all.js */
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const steps = [
  ['单元与损坏测试', ['node', 'tests/rpa1.test.js']],
  ['随机交叉校验（Python 参考）', ['node', 'tests/random_crosscheck.js']],
  ['解码器模糊测试', ['node', 'tests/fuzz.js']],
  ['示例交叉校验', ['node', 'tests/crosscheck.js']],
  ['浏览器端到端', ['node', 'tests/e2e.js']],
  ['页内解码正确性', ['node', 'tests/inpage_correct.js']]
];

let failed = 0;
for (const [name, cmd] of steps) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    execFileSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', timeout: 300000 });
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}`);
  }
}
console.log(`\n总计：${steps.length - failed}/${steps.length} 组通过`);
process.exit(failed ? 1 : 0);
