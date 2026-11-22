'use strict';
// 用样例的 expected 字段校验引擎输出，另附若干边界用例。
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  期望: ${w}`);
    console.log(`  实际: ${g}`);
  }
}

// 1. 样例文件
const sample = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'samples', 'sprite-marker-transport.json'), 'utf8'));
check('样例事件序列', E.formatEvents(sample.tracks, E.computeEvents(sample.tracks)), sample.expected);

// 2. 停留与段首跳转不触发；段尾触发
const t2 = [{
  id: 'T', mode: 'loop', duration: 4,
  segments: [[0, 2, 0, 0, 1], [2, 4, 3, 1, 1]], // 停 2 秒，再跳到 3 走到 5≡1
  markers: [[0, 'm0'], [1, 'm1'], [3, 'm3']],
}];
// 段1 速度 0：不触发；段2 从 3 出发（段首的 3 不触发），走到 5，经过 4≡0(t=3)、5≡1(t=4 段尾)
check('停留+段首跳转', E.formatEvents(t2, E.computeEvents(t2)),
  [['3', 'T', 'm0'], ['4', 'T', 'm1']]);

// 3. 倒放：标记按经过顺序触发，起点不触发、终点触发
const t3 = [{
  id: 'R', mode: 'loop', duration: 4,
  segments: [[0, 4, 4, -1, 1]], // 4 → 0
  markers: [[0, 'm0'], [1, 'm1'], [3, 'm3']],
}];
check('倒放', E.formatEvents(t3, E.computeEvents(t3)),
  [['1', 'R', 'm3'], ['3', 'R', 'm1'], ['4', 'R', 'm0']]);

// 4. 往返轨折返点：两端标记各发一次，不在折返点重复
const t4 = [{
  id: 'P', mode: 'pingpong', duration: 2,
  segments: [[0, 4, 0, 1, 1]], // 0→4：0,1,2,1,0
  markers: [[0, '底'], [2, '顶']],
}];
check('往返两端', E.formatEvents(t4, E.computeEvents(t4)),
  [['2', 'P', '顶'], ['4', 'P', '底']]);

// 5. 有理数速度：负起点的 loop 取模
const t5 = [{
  id: 'F', mode: 'loop', duration: 4,
  segments: [[0, 6, -1, 3, 2]],
  markers: [[0, 'z']],
}];
check('分数速度取模', E.formatEvents(t5, E.computeEvents(t5)),
  [['2/3', 'F', 'z'], ['10/3', 'F', 'z'], ['6', 'F', 'z']]);

// 6. 同时刻排序：轨道号优先，再按标记声明顺序
const t6 = [
  { id: 'B', mode: 'loop', duration: 4, segments: [[0, 1, 0, 1, 1]], markers: [[1, 'b1'], [1, 'b2']] },
  { id: 'A', mode: 'loop', duration: 4, segments: [[0, 1, 0, 1, 1]], markers: [[1, 'a1']] },
];
check('同时刻排序', E.formatEvents(t6, E.computeEvents(t6)),
  [['1', 'B', 'b1'], ['1', 'B', 'b2'], ['1', 'A', 'a1']]);

// 7. 预览定位：边界取右侧段起点，最末边界取末段终点
const posTrack = { id: 'V', mode: 'loop', duration: 4, segments: [[0, 2, 0, 1, 1], [2, 4, 1, 1, 1]], markers: [] };
check('边界取右段起点', E.fstr(E.positionAt(posTrack, E.frac(2))), '1');
check('最末边界取末段终点', E.fstr(E.positionAt(posTrack, E.frac(4))), '3');
check('段内位置', E.fstr(E.positionAt(posTrack, E.frac(1, 2))), '1/2');

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
