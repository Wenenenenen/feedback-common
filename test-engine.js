/* 用 samples/slab-support-yard.json 校验引擎。运行：node test-engine.js */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('./engine.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'samples', 'slab-support-yard.json'), 'utf8'));

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log('ok   ' + name);
  else { failures++; console.log('FAIL ' + name + '\n  实际: ' + a + '\n  期望: ' + e); }
}

// 场景一：拆 B 后的连锁失稳
const slabs = sample.slabs.map(Engine.fromSampleFormat);
const simAll = Engine.simulate(slabs);
check('初始载荷(拆前)', simAll.initialLoads, sample.expected.initialLoads);
check('完整布局首轮无移除', simAll.waves.length, 0);

// 场景一：拆 B 后的连锁失稳
const removed = slabs.filter(s => s.id !== sample.remove);
const sim = Engine.simulate(removed);

check('轮数', sim.waves.length, sample.expected.waves.length);
sample.expected.waves.forEach((w, i) => {
  check('第' + (i + 1) + '轮超载', sim.waves[i].overload, w.overload);
  check('第' + (i + 1) + '轮无支撑', sim.waves[i].unsupported, w.unsupported);
});
check('最终无幸存者', sim.survivors.length, 0);

// 场景二：1/3 分数均分
const thirds = sample.thirds.slabs.map(Engine.fromSampleFormat);
const res = Engine.computeLoads(thirds);
const ground = thirds.filter(s => s.z === 0).map(s => res.loads.get(s.id).toString());
check('地面载荷(分数)', ground, sample.thirds.expectedGroundLoads);

console.log(failures ? '\n' + failures + ' 项失败' : '\n全部通过');
process.exit(failures ? 1 : 0);
