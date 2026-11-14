/* DSP 核心测试：node test/run-tests.js */
'use strict';
const fs = require('fs');
const path = require('path');
const DSP = require('../dsp.js');

const SAMPLES = path.join(__dirname, '.samples');
if (!fs.existsSync(path.join(SAMPLES, 'cases.json'))) {
  fs.mkdirSync(SAMPLES, { recursive: true });
  require('child_process').execSync(
    `unzip -o "${path.join(__dirname, '..', 'samples', 'spectral-patches.zip')}" -d "${SAMPLES}"`);
}
let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures++; console.error('  ✗ ' + msg); }
}
function approx(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b}±${tol})`); }

function load(name) {
  const b = fs.readFileSync(path.join(SAMPLES, name));
  return DSP.decodeWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function rms(arr, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / (to - from));
}
function db(x) { return 20 * Math.log10(x); }

const FILES = ['stereo-48k.wav', 'mono-44k.wav', 'dc-nyquist.wav', 'silence.wav',
  'short.wav', 'one-frame.wav', 'long-mono.wav'];

console.log('1. WAV 解码→编码→再解码 完全一致');
for (const f of FILES) {
  const d = load(f);
  const buf = DSP.encodeWav({ sampleRate: d.sampleRate, bitsPerSample: d.bitsPerSample, channelInts: d.ints });
  const d2 = DSP.decodeWav(buf);
  ok(d2.sampleRate === d.sampleRate && d2.channels === d.channels &&
     d2.bitsPerSample === d.bitsPerSample && d2.frames === d.frames, `${f}: 参数一致`);
  let same = true;
  for (let c = 0; c < d.channels; c++)
    for (let i = 0; i < d.frames; i++) if (d.ints[c][i] !== d2.ints[c][i]) { same = false; break; }
  ok(same, `${f}: 全部采样逐位一致`);
}

console.log('2. 无有效选框 → 处理链逐位还原（含极短文件）');
for (const f of FILES) {
  const d = load(f);
  const out = DSP.processAudio(d.floats, d.sampleRate, []);
  ok(out.length === d.channels && out[0].length === d.frames, `${f}: 帧数保持 ${d.frames}`);
  let exact = true;
  for (let c = 0; c < d.channels; c++) {
    const ints = DSP.floatsToInts(out[c], d.bitsPerSample);
    for (let i = 0; i < d.frames; i++) if (ints[i] !== d.ints[c][i]) { exact = false; break; }
  }
  ok(exact, `${f}: STFT 往返后量化逐位等于原音`);
}

console.log('3. 选框全部停用 → 逐位还原');
{
  const d = load('stereo-48k.wav');
  const boxes = [{ start: 1, end: 4, low: 850, high: 1150, attenDb: 60, channels: [0, 1], enabled: false }];
  const out = DSP.processAudio(d.floats, d.sampleRate, boxes);
  let exact = true;
  for (let c = 0; c < d.channels; c++) {
    const ints = DSP.floatsToInts(out[c], d.bitsPerSample);
    for (let i = 0; i < d.frames; i++) if (ints[i] !== d.ints[c][i]) { exact = false; break; }
  }
  ok(exact, '停用选框不影响输出');
}

console.log('4. 有源信号：哨音衰减 + 区域外逐位不变');
{
  // 48kHz 单声道 16bit：1kHz 哨音(0.5振幅) + 200Hz 底声
  const sr = 48000, n = sr * 4;
  const ints = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = 0.5 * Math.sin(2 * Math.PI * 1000 * t) + 0.2 * Math.sin(2 * Math.PI * 200 * t);
    ints[i] = Math.round(v * 32767);
  }
  const floats = new Float64Array(n);
  for (let i = 0; i < n; i++) floats[i] = ints[i] / 32768;
  const boxes = [{ start: 1, end: 3, low: 900, high: 1100, attenDb: 24, channels: [0], enabled: true }];
  const out = DSP.processAudio([floats], sr, boxes)[0];
  ok(out.length === n, '帧数保持');
  // 框内中部 1kHz 应衰减约 24dB（用窄带能量估计：与 1kHz 正弦相关）
  function toneAmp(arr, from, to, freq) {
    let cr = 0, ci = 0;
    for (let i = from; i < to; i++) {
      const ph = 2 * Math.PI * freq * i / sr;
      cr += arr[i] * Math.cos(ph); ci -= arr[i] * Math.sin(ph);
    }
    return 2 * Math.hypot(cr, ci) / (to - from);
  }
  const inAmp = toneAmp(out, 1.5 * sr, 2.5 * sr, 1000);
  const outAmp = toneAmp(out, 0.2 * sr, 0.8 * sr, 1000);
  approx(db(inAmp / outAmp), -24, 1.5, '框内 1kHz 衰减 ≈24dB');
  approx(toneAmp(out, 1.5 * sr, 2.5 * sr, 200), 0.2, 0.02, '框内 200Hz 底声保留');
  // 区域外（远离边界 >0.5s）逐位等于原音
  const outInts = DSP.floatsToInts(out, 16);
  let exact = true;
  for (let i = 0; i < 0.5 * sr; i++) if (outInts[i] !== ints[i]) { exact = false; break; }
  for (let i = 3.5 * sr; i < n; i++) if (outInts[i] !== ints[i]) { exact = false; break; }
  ok(exact, '远离选框区域逐位不变');
}

console.log('5. 重叠选框取最大衰减，不叠加');
{
  const sr = 48000, n = sr * 4;
  const floats = new Float64Array(n);
  for (let i = 0; i < n; i++) floats[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sr);
  const boxes = [
    { start: 1, end: 3, low: 850, high: 1150, attenDb: 24, channels: [0], enabled: true },
    { start: 1.5, end: 2.5, low: 900, high: 1100, attenDb: 12, channels: [0], enabled: true },
  ];
  const out = DSP.processAudio([floats], sr, boxes)[0];
  function amp(from, to) {
    let cr = 0, ci = 0;
    const i0 = Math.round(from * sr), i1 = Math.round(to * sr);
    for (let i = i0; i < i1; i++) {
      const ph = 2 * Math.PI * 1000 * i / sr;
      cr += out[i] * Math.cos(ph); ci -= out[i] * Math.sin(ph);
    }
    return 2 * Math.hypot(cr, ci) / (i1 - i0);
  }
  approx(db(amp(1.7, 2.3) / 0.5), -24, 1.5, '重叠区衰减 ≈24dB（非 36dB）');
  approx(db(amp(1.1, 1.4) / 0.5), -24, 1.5, '仅外框区 ≈24dB');
}

console.log('6. 直流与 Nyquist 端点覆盖');
{
  const d = load('dc-nyquist.wav');
  const dur = d.frames / d.sampleRate;
  const boxes = [
    { start: 0, end: dur, low: 0, high: 100, attenDb: 60, channels: [0], enabled: true },
    { start: 0, end: dur, low: 23800, high: 24000, attenDb: 60, channels: [1], enabled: true },
  ];
  const out = DSP.processAudio(d.floats, d.sampleRate, boxes);
  const dcBefore = Math.abs(d.floats[0].reduce((a, b) => a + b, 0) / d.frames);
  const dcAfter = Math.abs(out[0].reduce((a, b) => a + b, 0) / d.frames);
  ok(dcBefore > 0.1 && dcAfter < dcBefore * 0.01, `直流分量被消除 (${dcBefore.toFixed(3)} → ${dcAfter.toFixed(5)})`);
  const nyqBefore = rms(d.floats[1], 0, d.frames);
  const nyqAfter = rms(out[1], 0, d.frames);
  // ch1 含 Nyquist 分量 + 1kHz 参考音：用相关法单独测 Nyquist 分量振幅
  function nyqAmp(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * (i % 2 === 0 ? 1 : -1);
    return Math.abs(2 * s / arr.length);
  }
  function toneAmpAt(arr, freq) {
    let cr = 0, ci = 0;
    for (let i = 0; i < arr.length; i++) {
      const ph = 2 * Math.PI * freq * i / d.sampleRate;
      cr += arr[i] * Math.cos(ph); ci -= arr[i] * Math.sin(ph);
    }
    return 2 * Math.hypot(cr, ci) / arr.length;
  }
  const nb = nyqAmp(d.floats[1]), na = nyqAmp(out[1]);
  ok(nb > 0.1 && db(na / nb) < -50, `Nyquist 分量被消除 (${db(na / nb).toFixed(1)}dB)`);
  const kb = toneAmpAt(d.floats[1], 1000), ka = toneAmpAt(out[1], 1000);
  approx(db(ka / kb), 0, 0.5, '1kHz 参考音保留');
}

console.log('7. 声道选择：只处理指定声道');
{
  const d = load('stereo-48k.wav');
  const boxes = [{ start: 1, end: 4, low: 850, high: 1150, attenDb: 40, channels: [0], enabled: true }];
  const out = DSP.processAudio(d.floats, d.sampleRate, boxes);
  const ints1 = DSP.floatsToInts(out[1], 16);
  let same = true;
  for (let i = 0; i < d.frames; i++) if (ints1[i] !== d.ints[1][i]) { same = false; break; }
  ok(same, '未选声道逐位不变');
  let diff = 0;
  const ints0 = DSP.floatsToInts(out[0], 16);
  for (let i = 0; i < d.frames; i++) if (ints0[i] !== d.ints[0][i]) diff++;
  ok(diff > 1000, `被选声道发生变化 (${diff} 采样)`);
}

console.log('8. 有源选框时帧数保持（全部样例）');
for (const f of FILES) {
  const d = load(f);
  const boxes = [{ start: 0, end: d.frames / d.sampleRate, low: 100, high: 1000, attenDb: 12, channels: [0], enabled: true }];
  const out = DSP.processAudio(d.floats, d.sampleRate, boxes);
  ok(out[0].length === d.frames, `${f}: ${d.frames} 帧保持`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures ? 1 : 0);
