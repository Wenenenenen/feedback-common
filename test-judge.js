'use strict';
/* 用样例与边界用例验证 judge.js */
const fs = require('fs');
const path = require('path');
const BJ = require('./judge.js');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'samples', 'beat-stop-judge.json'), 'utf8'));

let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('ok   ' + label);
  else { fails++; console.log('FAIL ' + label + '\n  expected ' + e + '\n  got      ' + a); }
}

// 1. 目标时间：变速 + 停拍加到同刻音符之前
const prep = BJ.prepare(sample);
const targets = {};
for (const n of prep.notes) targets[n.id] = n.hold ? [n.headUs, n.tailUs] : n.headUs;
eq(targets, sample.expected.targets, '目标时间（变速+停拍）');

// 2. 样例判定结果
const res = BJ.judge(sample, sample.inputs);
const results = {};
for (const n of res.notes) results[n.id] = n.result;
eq(results, sample.expected.results, '样例判定结果');
eq(res.notes.find(n => n.id === 'h').headJudge, '精准', '长键头判');
eq(res.notes.find(n => n.id === 'h').relErrUs, -80000, '松开误差恰为 -80ms（边界计入）');

// 3. 提前 1 微秒松开 -> 断键
const early = sample.inputs.map(r => r.slice());
early[early.length - 1] = [sample.earlyReleaseUs, 1, 'up'];
const resEarly = BJ.judge(sample, early);
const hEarly = resEarly.notes.find(n => n.id === 'h');
eq(hEarly.result, '断键', '提前 1µs 松开为断键');
eq(hEarly.detail, '提前松开', '断键原因');
eq(hEarly.relErrUs, -80001, '松开误差 -80001µs 可查清');

// 4. 过窗未松 -> 断键
const noUp = sample.inputs.filter(r => !(r[1] === 1 && r[2] === 'up'));
eq(BJ.judge(sample, noUp).notes.find(n => n.id === 'h').result, '断键', '不松开为断键');

// 5. 分数刻：判定前保留精确时间（30ms 边界外 1/3 µs 也算良好）
const fr = sample.fraction;
const resF = BJ.judge(fr, fr.inputs);
eq(resF.notes[0].result, fr.expectedResult, '分数刻保持精确');
eq(resF.notes[0].headErrUs > 30000, true, '误差略大于 30ms');

// 6. 判定窗口边界：±30ms 精准、±80ms 良好、超出不计
const mk = dt => ({ ppq: 480, tempo: [[0, 500000]], stops: [], offsetUs: 0,
  notes: [['n', 0, 480]], inputs: [[500000 + dt, 0, 'down']] });
eq(BJ.judge(mk(30000), mk(30000).inputs).notes[0].result, '精准', '+30ms 边界算精准');
eq(BJ.judge(mk(-30000), mk(-30000).inputs).notes[0].result, '精准', '-30ms 边界算精准');
eq(BJ.judge(mk(30001), mk(30001).inputs).notes[0].result, '良好', '+30001µs 算良好');
eq(BJ.judge(mk(80000), mk(80000).inputs).notes[0].result, '良好', '+80ms 边界算良好');
eq(BJ.judge(mk(-80000), mk(-80000).inputs).notes[0].result, '良好', '-80ms 边界算良好');
eq(BJ.judge(mk(80001), mk(80001).inputs).notes[0].result, '错过', '+80001µs 不在窗口');

// 7. 候选选择：就近 -> 同距取较早目标 -> 再按谱面顺序
const cand = { ppq: 480, tempo: [[0, 500000]], stops: [], offsetUs: 0,
  notes: [['x', 0, 480], ['y', 0, 576]], inputs: [[550000, 0, 'down']] };
eq(BJ.judge(cand, cand.inputs).notes.map(n => n.result), ['良好', '错过'], '同距离取较早目标');
const cand2 = Object.assign({}, cand, { inputs: [[555000, 0, 'down']] });
eq(BJ.judge(cand2, cand2.inputs).notes.map(n => n.result), ['错过', '良好'], '就近选择');
const sameTick = { ppq: 480, tempo: [[0, 500000]], stops: [], offsetUs: 0,
  notes: [['p', 0, 480], ['q', 0, 480]], inputs: [[500000, 0, 'down']] };
eq(BJ.judge(sameTick, sameTick.inputs).notes.map(n => n.result), ['精准', '错过'], '同刻按谱面顺序');

// 8. 校准值：从输入时间减去
const off = { ppq: 480, tempo: [[0, 500000]], stops: [], offsetUs: 25000,
  notes: [['n', 0, 480]], inputs: [[525000, 0, 'down']] };
eq(BJ.judge(off, off.inputs).notes[0].result, '精准', '输入先减校准值');

// 9. 实时模式：窗口未到的音符为待判定
const live = BJ.judge(sample, [], 100000);
eq(live.notes.find(n => n.id === 'a').result, '待判定', '实时模式未到窗口为待判定');
const live2 = BJ.judge(sample, [], 780001);
eq(live2.notes.find(n => n.id === 'a').result, '错过', '实时模式窗口过后为错过');

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
