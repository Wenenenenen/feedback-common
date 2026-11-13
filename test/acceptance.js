/* acceptance.js — 验收脚本（开发工具，不属于应用本体）。
 * 用法: node test/acceptance.js <fixtures目录>
 * 对目录内每个 WAV 运行与线上完全一致的分析核心，打印估计的 a、b、ppm，
 * 并与 truth.json 对照计算四个参考时标（10/30/60/85s）的误差。
 * 应用本体从不读取 truth.json；仅本验收脚本读取。 */
'use strict';
const fs = require('fs');
const path = require('path');
const WAV = require('../public/wav.js');
const ANALYSIS = require('../public/analysis-core.js');

const dir = process.argv[2];
if (!dir) { console.error('用法: node test/acceptance.js <fixtures目录>'); process.exit(1); }

const readWav = (name) => WAV.decodeWav(fs.readFileSync(path.join(dir, name)).buffer);
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
const LANDMARKS = truth.landmarks_reference_seconds;

const ref = readWav('reference.wav');
console.log(`reference: ${ref.duration.toFixed(2)}s @${ref.sampleRate}Hz\n`);

let allPass = true;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav') && f !== 'reference.wav');
for (const f of files) {
  const trk = readWav(f);
  const t0 = Date.now();
  const res = ANALYSIS.analyze(ref.mono, ref.sampleRate, trk.mono, trk.sampleRate, () => {});
  const ms = Date.now() - t0;
  const tm = truth.maps[f];
  const shouldFail = truth.insufficient_evidence.includes(f);
  console.log(`== ${f} (${trk.duration.toFixed(1)}s, ${trk.sampleRate}Hz, ${trk.channels}ch, ${trk.bits}bit)  耗时 ${ms}ms`);
  if (!res.ok) {
    console.log(`   结果: 证据不足 — ${res.reason}`);
    if (shouldFail) { console.log('   ✓ 预期为证据不足，正确'); }
    else { console.log('   ✗ 预期应成功!'); allPass = false; }
    continue;
  }
  const ppm = (res.a - 1) * 1e6;
  console.log(`   a=${res.a.toFixed(10)}  b=${res.b.toFixed(6)}s  drift=${ppm.toFixed(2)}ppm`);
  console.log(`   覆盖=${res.coverageSec.toFixed(1)}s  rms=${res.rmsMs.toFixed(2)}ms  相关=${res.meanScore.toFixed(3)}`);
  if (shouldFail) { console.log('   ✗ 预期应判证据不足!'); allPass = false; continue; }
  console.log(`   真值: a=${tm.scale}  b=${tm.offset_seconds}  drift=${tm.drift_ppm.toFixed(2)}ppm`);
  let worst = 0;
  for (const L of LANDMARKS) {
    // 真值下该时标事件在待校准轨的时刻，经估计映射回参考时间的误差
    const tTrk = (L - tm.offset_seconds) / tm.scale;
    const est = res.a * tTrk + res.b;
    const err = Math.abs(est - L) * 1000;
    worst = Math.max(worst, err);
    console.log(`   时标 ${L}s: 误差 ${err.toFixed(2)}ms ${err <= 10 ? '✓' : '✗'}`);
    if (err > 10) allPass = false;
  }
  console.log(`   最大时标误差: ${worst.toFixed(2)}ms\n`);
}
console.log(allPass ? '全部通过 ✓' : '存在失败项 ✗');
process.exit(allPass ? 0 : 1);
