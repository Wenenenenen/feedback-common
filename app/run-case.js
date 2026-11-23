// 从 stdin 读 {beats, anchors, onsets, frame_count}，输出求解结果（供对拍脚本使用）
const fs = require('fs');
const S = require('./solver.js');

const raw = fs.readFileSync(0, 'utf8');
const cfg = JSON.parse(raw);
const jsCfg = {
  beats: cfg.beats,
  frameCount: cfg.frame_count,
  anchors: cfg.anchors,
  onsets: cfg.onsets
};
const v = S.validate(jsCfg);
if (!v.ok) {
  console.log(JSON.stringify({ feasible: false, reason: 'validate: ' + v.errors.join('; ') }));
  process.exit(0);
}
const res = S.solve({
  beats: jsCfg.beats,
  frameCount: jsCfg.frameCount,
  anchorFrame: v.anchorFrame,
  onsets: jsCfg.onsets
});
if (res.feasible) {
  delete res.stats;
}
console.log(JSON.stringify(res));
