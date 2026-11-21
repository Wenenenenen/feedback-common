/* 用 node 直接验证核心算法：node test/run-checks.js <样例目录> */
'use strict';
const fs = require('fs');
const path = require('path');
const Sep = require('../js/separator.js');

const dir = process.argv[2];
if (!dir) { console.error('用法: node test/run-checks.js <样例目录>'); process.exit(1); }

const N = 512, HOP = 128, SR = 16000, ITERS = 60;
const load = (name) => Sep.decodeWav(fs.readFileSync(path.join(dir, name)).buffer);

const mix = load('mixture.wav');
const refA = load('anchor_a.wav');
const refB = load('anchor_b.wav');
const cleanA = load('clean_a.wav');
const cleanB = load('clean_b.wav');

console.log(`mixture: ${mix.samples.length} 采样 (${(mix.samples.length / SR).toFixed(2)}s), ${mix.sampleRate}Hz`);

// 1) STFT
const spec = Sep.stft(mix.samples, N, HOP);
console.log(`STFT: ${spec.nFrames} 帧 × ${spec.nBins} 频点`);

// 2) 模板（整段参考）
const tplA = Sep.extractTemplate(refA.samples, SR, N, HOP, 0, refA.samples.length / SR);
const tplB = Sep.extractTemplate(refB.samples, SR, N, HOP, 0, refB.samples.length / SR);
const templates = [tplA, tplB];
console.log(`模板A 峰值频点: ${topBins(tplA, 4).join(',')}  模板B 峰值频点: ${topBins(tplB, 4).join(',')}`);

function topBins(tpl, n) {
  return Array.from(tpl).map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, n).map(x => x[1]);
}

// 3) NNLS 逐帧拟合
const fit = Sep.createFit(spec, templates);
Sep.fitFrames(fit, spec, templates, 0, spec.nFrames, ITERS);

// 4) 重建
const rec = Sep.createReconstructor(spec, templates, mix.samples.length, N, HOP);
Sep.reconstructRange(rec, spec, templates, fit.H, 0, spec.nFrames);
const out = Sep.finalizeReconstruction(rec, mix.samples);

// 5) 校验
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fail++; };

check(out.length === mix.samples.length, `分轨长度 == 混音长度 (${out.length} == ${mix.samples.length})`);
check(out.stems.every(s => s.length === mix.samples.length) && out.residual.length === mix.samples.length,
  '所有分轨与剩余声长度一致');
check(out.maxErr < 1e-5, `分轨+剩余 还原混音，最大误差 ${out.maxErr.toExponential(2)} < 1e-5`);

// 与 clean 参考对比（clean 仅供验收）
function snr(est, ref) {
  let num = 0, den = 0;
  for (let i = 0; i < ref.length; i++) { num += ref[i] * ref[i]; const d = ref[i] - est[i]; den += d * d; }
  return 10 * Math.log10(num / Math.max(den, 1e-30));
}
// 自动配对：哪条分轨对应 clean_a
const s00 = snr(out.stems[0], cleanA.samples), s01 = snr(out.stems[0], cleanB.samples);
const [idxA, idxB] = s00 >= s01 ? [0, 1] : [1, 0];
const snrA = snr(out.stems[idxA], cleanA.samples);
const snrB = snr(out.stems[idxB], cleanB.samples);
console.log(`分轨对 clean_a SNR = ${snrA.toFixed(1)} dB，对 clean_b SNR = ${snrB.toFixed(1)} dB`);
check(snrA > 10 && snrB > 10, '两条分轨 SNR 均 > 10 dB');

// 共享频点（第 14 频点）的分配：应按占比拆分而非判给一路
const mid = Math.floor(spec.nFrames / 2);
const cell = Sep.sharesAt(spec, templates, fit.H, mid, 14);
console.log(`第14频点(437.5Hz) 第${mid}帧 分配: A=${(cell.shares[idxA] * 100).toFixed(1)}% ` +
  `B=${(cell.shares[idxB] * 100).toFixed(1)}% 剩余=${(cell.shares[2] * 100).toFixed(1)}%`);
check(cell.shares[idxA] > 0.2 && cell.shares[idxB] > 0.2, '共享频点被两路按比例拆分（各 >20%）');

// 静音参考应当报错的错误路径
try {
  Sep.extractTemplate(load('silence.wav').samples, SR, N, HOP, 0, 1);
  check(false, '静音参考应抛出异常');
} catch (e) {
  check(true, `静音参考正确报错: ${e.message}`);
}

// 浮点 WAV 导出回读
const wavBuf = Sep.encodeWavFloat32(out.stems[idxA], SR);
const re = Sep.decodeWav(wavBuf);
check(re.format === 3 && re.bits === 32 && re.samples.length === mix.samples.length,
  '浮点 WAV 导出可回读，长度一致');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
