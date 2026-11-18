'use strict';
const fs = require('fs');
const path = require('path');
const lab = require('../js/rblab-lab.js');
const engine = require('../js/rblab-engine.js');

const sampleDir = path.resolve(__dirname, '../../samples/extracted');
const load = n => JSON.parse(fs.readFileSync(path.join(sampleDir, n), 'utf8'));
const log = load('basic.json');

const exp = new lab.Experiment({
  log: log,
  net: { delayMs: 120, jitterMs: 60, lossPct: 20, seed: 20261119 },
  rollbackMax: 8
});
exp.runToEnd();

let fail = 0;
function check(cond, msg) {
  if (!cond) { fail++; console.log('FAIL', msg); }
}

check(exp.finished, '实验应自然结束');
check(exp.firstDivergence === null, '确定引擎下两边最终不应有未解决分歧，实际: ' + JSON.stringify(exp.firstDivergence));

// 导出结构完整性
const out = exp.exportFramesJSON();
check(out.reference.length === log.frames.length, '导出参考帧数应等于日志帧数');
check(out.meta.firstDivergence === null, 'meta 分歧应为空');
check(Array.isArray(out.reference[0].events), '每帧应带事件数组');
check(typeof out.reference[0].checksum === 'string' && out.reference[0].checksum.length === 8, '校验和应为 8 位十六进制');

// 客户端最终校验和与参考逐帧一致
for (let i = 0; i < log.frames.length; i++) {
  check(exp.c1.checksums[i] === exp.ref.frames[i].checksum, 'c1 帧 ' + i + ' 校验和偏离');
  check(exp.c2.checksums[i] === exp.ref.frames[i].checksum, 'c2 帧 ' + i + ' 校验和偏离');
}

// 事件对账：撤销事件集合与参考实现一致
const refKeys = {};
exp.ref.frames.forEach(r => r.events.forEach(e => { refKeys[e.key] = true; }));
exp.c1.eventList().forEach(ev => {
  if (ev.revoked) check(!refKeys[ev.key], '撤销事件不应在参考结果中: ' + ev.key);
  else check(refKeys[ev.key], '生效事件应在参考结果中: ' + ev.key);
});

// 导出 JSON 可序列化且为纯整数数值
const json = JSON.stringify(out);
check(json.length > 1000, '导出 JSON 应有实质内容');
check(JSON.parse(json).reference.length === log.frames.length, '导出 JSON 可往返解析');

// 分歧检测的人为注入：篡改 c2 已确认帧的远端输入与状态，制造无法自愈的真分歧
const exp3 = new lab.Experiment({
  log: load('basic.json'),
  net: { delayMs: 0, jitterMs: 0, lossPct: 0, seed: 3 },
  rollbackMax: 8
});
exp3.runToEnd();
// 直接改写 c2 帧 5 的校验和与状态，模拟一次确定性破坏（如两边逻辑版本不一致）
exp3.c2.checksums[5] = 'deadbeef';
exp3.c2.remoteKnown[5] = true;
exp3.c1.remoteKnown[5] = true;
if (exp3.c2.states[5]) {
  exp3.c2.states[5].fighters[0].hp = 111;
}
const div = exp3.detectDivergence();
check(div !== null && div.frame === 5, '应在帧 5 检出真分歧');
check(div && div.diff && div.diff.fighters.length === 2, '分歧应带两边字段 diff');
check(div && div.checksum1 !== div.checksum2, '分歧两边校验和应不同');

console.log(fail === 0 ? 'LAB OK: ' + exp.tickCount + ' 驱动帧, ' + log.frames.length + ' 逻辑帧, c1 回滚 ' + exp.c1.rollbackCount + ' 次' : ('LAB FAIL x' + fail));
process.exit(fail === 0 ? 0 : 1);
