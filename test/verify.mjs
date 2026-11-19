// 离线校验：对照 samples 包内 reference.json 与两个样例 WAV 验证 dsp.js。
// 运行：node test/verify.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const D = require('../dsp.js');

const CASES = '/tmp/mdct-cases';
function readBuf(p) {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail); }
}
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

// ---- 1. boundary-mono.wav 对照 reference.json ----
console.log('== reference.json 对照（boundary-mono.wav, N=128）==');
const ref = JSON.parse(readFileSync(CASES + '/reference.json', 'utf8'));
const wav = D.parseWav(readBuf(CASES + '/boundary-mono.wav'));
check('WAV 参数', wav.rate === 48000 && wav.channels === 1 && wav.bits === 16 && wav.frames === 513,
  JSON.stringify({ rate: wav.rate, ch: wav.channels, bits: wav.bits, frames: wav.frames }));

const N = ref.N, L = wav.frames;
const { coeff, K } = D.analyzeChannel(wav.data[0], N);
check('块数 K = ceil(L/N)+1 = 6', K === 6, 'K=' + K);
const refFlat = ref.coefficients.flat();
check('MDCT 系数', maxDiff(coeff, refFlat) < 1e-9, 'maxDiff=' + maxDiff(coeff, refFlat));

const { q, overflow } = D.quantize(coeff, N, ref.steps);
check('量化无溢出', overflow.size === 0, JSON.stringify([...overflow]));
check('量化整数 q', maxDiff(q, ref.quantized.flat()) === 0, 'maxDiff=' + maxDiff(q, ref.quantized.flat()));

const recon = D.synthesizeChannel(D.dequantize(q, N, ref.steps), N, L);
check('重建长度 == L', recon.length === L, recon.length + ' vs ' + L);
check('量化重建波形', maxDiff(recon, ref.quantized_reconstruction) < 1e-9,
  'maxDiff=' + maxDiff(recon, ref.quantized_reconstruction));

// 浮点旁路应近乎无损
const reconF = D.synthesizeChannel(coeff, N, L);
const m0 = D.metrics(wav.data[0], reconF);
check('浮点旁路 SNR > 250 dB', m0.snr > 250, 'snr=' + m0.snr);

// ---- 2. stereo-24.wav 浮点旁路往返 ----
console.log('== stereo-24.wav 浮点旁路（N=512）==');
const wav2 = D.parseWav(readBuf(CASES + '/stereo-24.wav'));
check('WAV 参数', wav2.rate === 44100 && wav2.channels === 2 && wav2.bits === 24,
  JSON.stringify({ rate: wav2.rate, ch: wav2.channels, bits: wav2.bits }));
for (const n of [128, 256, 512]) {
  let ok = true, minSnr = Infinity;
  for (let c = 0; c < 2; c++) {
    const a = D.analyzeChannel(wav2.data[c], n);
    const r = D.synthesizeChannel(a.coeff, n, wav2.frames);
    if (r.length !== wav2.frames) ok = false;
    const m = D.metrics(wav2.data[c], r);
    minSnr = Math.min(minSnr, m.snr);
  }
  check(`N=${n} 浮点旁路长度一致且 SNR>250dB`, ok && minSnr > 250, 'minSnr=' + minSnr);
}

// ---- 3. 系数 ZIP 导出/导入往返（int16le 与 float32le） ----
console.log('== 系数 ZIP 往返 ==');
const steps = [0.02, 0.03, 0.04, 0.05];
const zip16 = D.packCoefficients({
  rate: wav.rate, channels: 1, frames: L, N, blocks: K,
  storage: 'int16le', steps, quant: [q],
});
const back16 = await D.unpackCoefficients(zip16);
check('int16le 头部字段', back16.header.version === 1 && back16.header.frames === L &&
  back16.header.N === N && back16.header.blocks === K && back16.header.storage === 'int16le');
check('int16le 解码系数 == q*step', maxDiff(back16.coeff[0], D.dequantize(q, N, steps)) === 0);

const zipF = D.packCoefficients({
  rate: wav.rate, channels: 1, frames: L, N, blocks: K,
  storage: 'float32le', steps, coeff: [coeff],
});
const backF = await D.unpackCoefficients(zipF);
check('float32le 系数（float32 精度内）', maxDiff(backF.coeff[0], coeff) < 1e-6,
  'maxDiff=' + maxDiff(backF.coeff[0], coeff));

// 损坏文件须明确拒绝
async function expectReject(name, buf, pattern) {
  try { await D.unpackCoefficients(buf); check(name, false, '未拒绝'); }
  catch (e) { check(name, pattern.test(e.message), e.message); }
}
const trunc = zip16.slice(0, zip16.length - 100);
await expectReject('截断的 ZIP', trunc, /损坏|越界|目录/);
const badVer = D.zipStore([
  { name: 'header.json', data: new TextEncoder().encode(JSON.stringify({ ...back16.header, version: 2 })) },
  { name: 'coefficients.bin', data: zip16 && new Uint8Array(0) },
]);
await expectReject('version=2', badVer, /版本/);
const badLen = D.zipStore([
  { name: 'header.json', data: new TextEncoder().encode(JSON.stringify(back16.header)) },
  { name: 'coefficients.bin', data: new Uint8Array(10) },
]);
await expectReject('数据长度不符', badLen, /长度不符/);
const badBlocks = D.zipStore([
  { name: 'header.json', data: new TextEncoder().encode(JSON.stringify({ ...back16.header, blocks: 99 })) },
  { name: 'coefficients.bin', data: new Uint8Array(99 * 1 * N * 2) },
]);
await expectReject('块数与 frames/N 不符', badBlocks, /块数不符/);

// ---- 4. 量化溢出报告频带，不截断 ----
console.log('== 溢出与 WAV24 ==');
const big = new Float64Array(N); big[0] = 1.0; big[N - 1] = 1.0;
const ov = D.quantize(big, N, [1e-6, 0.02, 0.02, 1e-6]);
check('溢出涉及频带 0 和 3', ov.overflow.has(0) && ov.overflow.has(3) && ov.overflow.size === 2,
  JSON.stringify([...ov.overflow.keys()]));
check('q 不被截断', ov.q[0] === 1000000 && ov.q[N - 1] === 1000000, ov.q[0] + ',' + ov.q[N - 1]);

// ---- 5. 24 位 WAV 导出：限幅 + 远离零舍入 + 可回读 ----
const w24 = D.encodeWav24([new Float64Array([0, 0.5, -0.5, 1.0, -1.0, 2.0, -2.0])], 48000);
const re24 = D.parseWav(w24);
check('WAV24 参数', re24.bits === 24 && re24.rate === 48000 && re24.frames === 7);
check('WAV24 限幅到 [-1, 1-2^-23]',
  re24.data[0][3] === (8388607 / 8388608) && re24.data[0][4] === -1 &&
  re24.data[0][5] === (8388607 / 8388608) && re24.data[0][6] === -1,
  JSON.stringify([...re24.data[0]]));
check('WAV24 0.5 精确', re24.data[0][1] === 0.5 && re24.data[0][2] === -0.5);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
