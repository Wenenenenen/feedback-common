// 满额性能测试：120s 音频(24000帧)、192 拍、24000 候选
const S = require('./solver.js');

const frameCount = 24000;
const beats = 192;
// 均匀拍长 p=20 (120帧=600ms)，首尾锚点
const p0 = 20;
const anchors = [[0, 0], [beats, beats * p0 * 6]];
// 24000 个候选：每帧一个，权重随机
const onsets = [];
let seed = 123456789;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
for (let f = 0; f < frameCount; f++) {
  onsets.push([f, Math.floor(rnd() * 1001), Math.floor(rnd() * 1001)]);
}
// 截断到 24000（恰好等于帧数）
const v = S.validate({ beats, frameCount, anchors, onsets });
console.log('validate:', v.ok, (v.errors || []).join(';'));

const t0 = Date.now();
const res = S.solve({ beats, frameCount, anchorFrame: v.anchorFrame, onsets });
const t1 = Date.now();
console.log('feasible:', res.feasible, 'score:', res.score);
console.log('wall ms (Date):', t1 - t0, 'stats:', res.stats);
console.log('beats out:', res.beats ? res.beats.length : 0);

// 再跑 3 次取稳态
for (let i = 0; i < 3; i++) {
  const a = Date.now();
  const r = S.solve({ beats, frameCount, anchorFrame: v.anchorFrame, onsets });
  const b = Date.now();
  console.log('run', i + 2, 'ms', b - a, 'score', r.score);
}
