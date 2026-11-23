/* 匹配窗规则专项：±3 帧、max(0,w-2d)、同分取较早候选、未匹配为 null */
const S = require('./solver.js');

function run(beats, anchors, onsets, fc = 600) {
  const v = S.validate({ beats, frameCount: fc, anchors, onsets });
  if (!v.ok) throw new Error('validate: ' + v.errors.join(';'));
  return S.solve({ beats, frameCount: fc, anchorFrame: v.anchorFrame, onsets });
}

// 1. 距离衰减：正拍在帧 48（p=8, beat0 frame0；用单拍 beats=1 简化）
//    锚点 [0,0],[1,48]。正拍位置 frame0。候选放在 frame3，权重 10 -> 10-2*3=4
let r = run(1, [[0, 0], [1, 48]], [[3, 10, 0]]);
console.log('T1 onScore', r.beats[0].onScore, 'onMatch', r.beats[0].onMatch);
if (r.beats[0].onScore !== 4 || r.beats[0].onMatch !== 3) throw new Error('T1 衰减错误');

// 2. 窗边界：距离 3 有效（w-6），距离 4 无效
r = run(1, [[0, 0], [1, 48]], [[4, 100, 0]]);
if (r.beats[0].onScore !== 0 || r.beats[0].onMatch !== null) throw new Error('T2 距离4 应未匹配');
r = run(1, [[0, 0], [1, 48]], [[-3, 100, 0]].filter(o => o[0] >= 0).concat([[3, 9, 0]]));
// frame3 权重9 -> 9-6=3
if (r.beats[0].onScore !== 3) throw new Error('T2b 窗边界分数错误，得 ' + r.beats[0].onScore);
console.log('T2 window boundary OK');

// 3. 同分取较早候选：两个候选在正拍两侧给出同分
//    正拍 frame0；frame2 权重 4 -> 4-4=0 不计；用 frame1 权重10->8 与 frame-1 非法
//    构造 frame1(w10 ->8) vs frame? 需要同分：frame1 d1: w-2；frame? 同侧无法同分
//    跨侧：frame1 与 frame-1 对称，但负帧非法。改用正拍在帧 30 的场景
//    锚点 [0,30]（30 是6的倍数）, [1,78]；正拍 frame30
//    候选 frame28(d2,w? ->w-4) 与 frame32(d2,w-4) 给同权重 -> 同分，取较早 28
r = run(1, [[0, 30], [1, 78]], [[28, 10, 0], [32, 10, 0]]);
console.log('T3 onScore', r.beats[0].onScore, 'onMatch', r.beats[0].onMatch);
if (r.beats[0].onMatch !== 28) throw new Error('T3 同分应取较早候选帧 28');

// 4. 不同分取高分（即便帧更晚）：frame28 w10->6 vs frame32 w20->16
r = run(1, [[0, 30], [1, 78]], [[28, 10, 0], [32, 20, 0]]);
if (r.beats[0].onMatch !== 32 || r.beats[0].onScore !== 16) {
  throw new Error('T4 应取高分候选 32，得 ' + JSON.stringify(r.beats[0]));
}
console.log('T4 higher score wins OK');

// 5. 正/反拍权重独立：同一候选可同时服务正拍窗与反拍窗
//    beats=1, p=12(72帧), s=0 反拍在 frame36。锚点 [0,0],[1,72]
//    候选 frame36 wOn=50,wOff=80：反拍位置取 wOff 衰减
r = run(1, [[0, 0], [1, 72]], [[36, 50, 80]]);
const b = r.beats[0];
console.log('T5 swing', b.swing, 'on', b.onScore, b.onMatch, 'off', b.offScore, b.offMatch);
// 正拍 frame0 无候选=0；反拍 frame36 命中 wOff80 距离0 ->80
if (b.offScore !== 80 || b.offMatch !== 36) throw new Error('T5 反拍权重错误');
if (b.onScore !== 0 || b.onMatch !== null) throw new Error('T5 正拍应未匹配');

// 6. 反拍 s=1 在 2P/3：p=12 -> 4p单位=48帧；s=0 在 36 帧
//    两个反拍候选分别放 36 和 48，让 s 选择可区分
//    beats=1 锚点 [0,0],[1,72]；候选 frame48 wOff=90，frame36 不放
r = run(1, [[0, 0], [1, 72]], [[48, 0, 90]]);
const b6 = r.beats[0];
console.log('T6 swing', b6.swing, 'offFrame match', b6.offMatch, 'offScore', b6.offScore);
// s=1 时反拍 48 命中 90；s=0 时反拍 36 未命中。90>0 应选 s=1
if (b6.swing !== 1 || b6.offMatch !== 48 || b6.offScore !== 90) throw new Error('T6 s=1 反拍位置错误');

// 7. penalty 首拍为 0，变速代价 3|Δp|/6单位，切换 +7
r = run(2, [[0, 0], [2, 21 * 6 * 2]], []); // 间距42u两拍，恒定21可行
let pen0 = r.beats[0].penalty, pen1 = r.beats[1].penalty;
if (pen0 !== 0) throw new Error('T7 首拍 penalty 必须 0');
if (pen1 !== 0) throw new Error('T7 恒定拍长第二拍 penalty 应 0，得 ' + pen1);
console.log('T7 penalty baseline OK, score', r.score);

console.log('MATCH WINDOW RULES ALL PASSED');
