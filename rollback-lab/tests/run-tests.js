#!/usr/bin/env node
/*
 * Node 自测入口：读取 samples/extracted 下的原始样例，
 * 跑 rblab-selftest 的全部用例并打印结果。用 `node tests/run-tests.js` 运行。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const selftest = require('../js/rblab-selftest.js');

const sampleDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../../samples/extracted');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(sampleDir, name), 'utf8'));
}

const samples = {
  moves: load('moves.json'),
  reference: load('reference.json'),
  invalid: load('invalid.json'),
  basic: load('basic.json'),
  block: load('block.json'),
  ko: load('ko.json'),
  trade: load('trade.json'),
  randomLong: load('random-long.json')
};

// moves.json 必须与引擎内固化的帧数据一致
const engine = require('../js/rblab-engine.js');
for (const k of Object.keys(samples.moves)) {
  const a = JSON.stringify(samples.moves[k]);
  const b = JSON.stringify(engine.MOVES[k]);
  if (a !== b) {
    console.error('FAIL 引擎内 MOVES.' + k + ' 与 moves.json 不一致');
    process.exit(1);
  }
}

const cases = selftest.buildCases(samples);
const results = selftest.runAll(cases);
let failed = 0;
results.forEach((r, i) => {
  if (r.ok) {
    console.log('PASS  ' + (i + 1) + '. ' + r.name);
  } else {
    failed += 1;
    console.log('FAIL  ' + (i + 1) + '. ' + r.name);
    console.log('        ' + r.error);
  }
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' 通过');
process.exit(failed === 0 ? 0 : 1);
