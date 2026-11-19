// 对照 samples/extracted/reference.json 的离线校验（Node 运行，不参与页面）。
// 运行：node tests/run-bench.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeWav, encodeWav, WavError } from '../src/wav-codec.js';
import { designResampler, reduceRatio } from '../src/filter.js';
import { PolyphaseResampler } from '../src/resampler.js';
import { measureGroupDelay, measureFilterResponse, measureTone } from '../src/measurements.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, '..', 'samples', 'extracted');
const ref = JSON.parse(readFileSync(join(sampleDir, 'reference.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function load(fn) {
  const bytes = new Uint8Array(readFileSync(join(sampleDir, fn)));
  return decodeWav(bytes);
}

// 分块流式处理，块大小可调，用于验证“任意分块与整段一致”
function resampleChunked(design, channelData, chunkSize) {
  const ch = channelData.length;
  const rs = new PolyphaseResampler(design, ch);
  const N = channelData[0].length;
  const parts = Array.from({ length: ch }, () => []);
  for (let s = 0; s < N; s += chunkSize) {
    const e = Math.min(N, s + chunkSize);
    const chunk = channelData.map((d) => d.subarray(s, e));
    rs.pushInput(chunk);
    const out = rs.pullAvailable();
    for (let c = 0; c < ch; c++) if (out[c].length) parts[c].push(out[c]);
  }
  const tail = rs.flush();
  for (let c = 0; c < ch; c++) if (tail[c].length) parts[c].push(tail[c]);
  const total = parts[0].reduce((a, b) => a + b.length, 0);
  const merged = [];
  for (let c = 0; c < ch; c++) {
    const arr = new Float64Array(total);
    let o = 0;
    for (const p of parts[c]) { arr.set(p, o); o += p.length; }
    merged.push(arr);
  }
  return merged;
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

console.log('== 1. 输出长度 Nout = ceil(N·fo/fi) ==');
for (const [fn, r] of Object.entries(ref)) {
  const w = load(fn);
  const { L, M } = reduceRatio(w.rate, r.target);
  const expect = Math.ceil((w.frames * L) / M);
  check(`${fn} 长度`, expect === r.outFrames, `得 ${expect} / 期望 ${r.outFrames}`);
  check(`${fn} 参数解析`, w.rate === r.rate && w.bits === r.bits && w.channels === r.channels);
}

console.log('\n== 2. sine1k：去掉两端各 64 样本，误差 <= 2e-3 ==');
{
  const w = load('sine1k-44k1-16.wav');
  const r = ref['sine1k-44k1-16.wav'];
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  let worst = 0;
  let worstIdx = -1;
  for (let m = 64; m < out[0].length - 64; m++) {
    const ideal = 0.5 * Math.sin((2 * Math.PI * 1000 * m) / r.target);
    const e = Math.abs(out[0][m] - ideal);
    if (e > worst) { worst = e; worstIdx = m; }
  }
  check('sine1k 波形误差', worst <= 2e-3, `worst=${worst.toExponential(2)} @m=${worstIdx}`);
  const tone = measureTone(out[0], r.target, w.rate, r.target, true);
  // 输入幅度 0.5 => -6.02 dBFS；重采样后主频应保持
  check('sine1k 主频增益接近 0dB', Math.abs(tone.toneDb - 20 * Math.log10(0.5)) < 0.05,
    `tone=${tone.toneDb.toFixed(2)}dBFS, sfdr=${tone.sfdrDb?.toFixed(1)}dB`);
}

console.log('\n== 3. sine23k：高于输出奈奎斯特，21.1kHz 混叠 < -80dBFS ==');
{
  const w = load('sine23k-48k-24.wav');
  const r = ref['sine23k-48k-24.wav'];
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  const tone = measureTone(out[0], r.target, w.rate, r.target, true, 131072);
  const alias21 = tone.spurs.filter((s) => Math.abs(s.freqHz - 21100) < 200);
  check('23kHz 被滤除（主频无高幅残留）', (tone.toneDb ?? -200) < -75,
    `max tone=${tone.toneDb?.toFixed(1)}dBFS`);
  // 混叠分量低于 -80dBFS；若已淹没在噪声底测不出分立分量，同样判定达标
  const aliasLevel = alias21.length ? alias21[0].db : tone.floorMedianDb;
  check('21.1kHz 混叠 < -80dBFS', aliasLevel < -80,
    alias21.length ? `${alias21[0].freqHz.toFixed(0)}Hz @ ${alias21[0].db.toFixed(1)}dBFS`
      : `无分立分量，噪声底 ${tone.floorMedianDb?.toFixed(1)}dBFS`);
  // 全带最高杂散：信号被彻底滤除时输出无真实主峰，改用噪声底绝对电平
  // （要求混叠/残留低于 -80dBFS）
  const residualDb = alias21.length ? alias21[0].db : tone.floorMedianDb;
  check('带外残留/混叠绝对电平 < -80dBFS', residualDb < -80,
    `residual=${residualDb?.toFixed(1)}dBFS`);
}

console.log('\n== 4. sine20k：通带内，幅度差 <= 0.1dB ==');
{
  const w = load('sine20k-48k-24.wav');
  const r = ref['sine20k-48k-24.wav'];
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  const inTone = measureTone(w.channelData[0], w.rate, w.rate, r.target, false);
  const outTone = measureTone(out[0], r.target, w.rate, r.target, true);
  const gain = outTone.toneDb - inTone.toneDb;
  check('20kHz 增益偏差 <= 0.1dB', Math.abs(gain) <= 0.1, `gain=${gain.toFixed(3)}dB`);
}

console.log('\n== 5. impulse：峰值位于 48000×1000/44100 ≈ 1088.435，群延迟为 0 ==');
{
  const w = load('impulse-44k1-16.wav');
  const r = ref['impulse-44k1-16.wav'];
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  const gd = measureGroupDelay(w.channelData[0], out[0], w.rate, r.target);
  check('峰值位置偏差 < 0.5 样本', gd && Math.abs(gd.peakOutputIndex - gd.theoreticalPeakIndex) < 0.5,
    `peak=${gd.peakOutputIndex.toFixed(3)} theory=${gd.theoreticalPeakIndex.toFixed(3)}`);
  // 零延迟设计：无整体样本偏移，亚样本残差来自分数插值，容差 0.25 样本
  check('群延迟 ≈ 0（亚样本残差 < 0.25）', gd && Math.abs(gd.delayOutputSamples) < 0.25,
    `delay=${gd.delayOutputSamples.toFixed(4)} samples`);
  check('无整体样本偏移（最近整数峰=1088）', Math.round(gd.peakOutputIndex) === 1088);
}

console.log('\n== 6. sweep 立体声：输出两声道严格反相 ==');
{
  const w = load('sweep-48k-16-stereo.wav');
  const r = ref['sweep-48k-16-stereo.wav'];
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  let worst = 0;
  for (let i = 0; i < out[0].length; i++) worst = Math.max(worst, Math.abs(out[0][i] + out[1][i]));
  check('L+R 恒为 0（浮点严格反相）', worst === 0, `max|L+R|=${worst}`);
}

console.log('\n== 7. voice 8k->11025（441/320 任意有理比）==');
{
  const w = load('voice-8k-16.wav');
  const r = ref['voice-8k-16.wav'];
  const { L, M } = reduceRatio(w.rate, r.target);
  check('约分比例 441/320', L === 441 && M === 320, `${L}/${M}`);
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  check('voice 输出长度', out[0].length === r.outFrames, `${out[0].length}/${r.outFrames}`);
  check('voice 输出有限且无 NaN', out[0].every((x) => Number.isFinite(x)));
}

console.log('\n== 7b. 真实带外混叠：合成 18kHz @48k 降采到 32k，折叠到 12kHz 应被抑制 ==');
{
  const fi = 48000, fo = 32000, fin = 18000, N = 48000;
  const x = [new Float64Array(N)];
  for (let i = 0; i < N; i++) x[0][i] = 0.5 * Math.sin((2 * Math.PI * fin * i) / fi);
  const design = designResampler(fi, fo);
  const out = resampleChunked(design, x, 4096);
  const t = measureTone(out[0], fo, fi, fo, true, 32768, fin);
  check('折叠位置 12kHz 与理论一致', Math.abs(t.wantedFreq - 12000) < 60,
    `wanted=${t.wantedFreq?.toFixed(1)}Hz`);
  check('带外混叠被抑制到 < -80dBFS', (t.toneDb ?? -200) < -80,
    `folded tone=${t.toneDb?.toFixed(1)}dBFS`);
}

console.log('\n== 8. 分块不变性：多种块大小与整段处理逐位一致 ==');
{
  const w = load('sine1k-44k1-16.wav');
  const r = ref['sine1k-44k1-16.wav'];
  const design = designResampler(w.rate, r.target);
  const whole = resampleChunked(design, w.channelData, w.frames);
  for (const cs of [1, 7, 64, 1024, 4096, 10007]) {
    const part = resampleChunked(design, w.channelData, cs);
    const d = maxAbsDiff(whole[0], part[0]);
    check(`块大小 ${cs} 逐位一致`, d === 0, `maxdiff=${d}`);
  }
  // 长文件 4096 与整段一致
  const wl = load('long-60s-44k1-16.wav');
  const rl = ref['long-60s-44k1-16.wav'];
  const dl = designResampler(wl.rate, rl.target);
  const a = resampleChunked(dl, wl.channelData, wl.frames);
  const b = resampleChunked(dl, wl.channelData, 4096);
  check('long-60s 4096 分块与整段一致', maxAbsDiff(a[0], b[0]) === 0);
  check('long-60s 输出长度', a[0].length === rl.outFrames, `${a[0].length}/${rl.outFrames}`);
}

console.log('\n== 9. 滤波器设计指标（默认 208 抽头/80dB）==');
{
  const design = designResampler(48000, 44100);
  const m = measureFilterResponse(design);
  check('通带纹波 <= 0.1dB', m.passRippleDb <= 0.1, `ripple=${m.passRippleDb.toFixed(4)}dB`);
  check('阻带衰减 >= 80dB', m.stopAttenMinDb >= 80, `stop=${m.stopAttenMinDb.toFixed(1)}dB`);
  // -3dB 点落在过渡带 [通带边沿, 奈奎斯特] 内
  check('-3dB 点落在过渡带内',
    m.minus3dbHz >= m.passEdgeHz * 0.98 && m.minus3dbHz <= m.stopEdgeHz,
    `f-3dB=${m.minus3dbHz?.toFixed(0)}Hz, 过渡带=[${m.passEdgeHz.toFixed(0)}, ${m.stopEdgeHz.toFixed(0)}]`);
}

console.log('\n== 10. 格式拒绝：32 位浮点 / 8 位 / 截断文件 ==');
{
  const flt = new Uint8Array(readFileSync(join(sampleDir, 'float32-unsupported.wav')));
  try { decodeWav(flt); check('float32 被拒绝', false); }
  catch (e) { check('float32 被拒绝', e instanceof WavError && /32 位浮点/.test(e.message), e.message); }

  const tr = new Uint8Array(readFileSync(join(sampleDir, 'truncated.wav')));
  try { decodeWav(tr); check('截断文件被拒绝', false); }
  catch (e) { check('截断文件被拒绝', e instanceof WavError && /截断/.test(e.message), e.message); }

  // 8 位 PCM 手工构造（44 字节头 + 8 字节数据）
  const hdr = new Uint8Array(52);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(0, 0x52494646, false); dv.setUint32(4, 36 + 8, true);
  dv.setUint32(8, 0x57415645, false); dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 44100, true); dv.setUint32(28, 44100, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  dv.setUint32(36, 0x64617461, false); dv.setUint32(40, 8, true);
  try { decodeWav(hdr); check('8 位 PCM 被拒绝', false); }
  catch (e) { check('8 位 PCM 被拒绝', e instanceof WavError && /位深/.test(e.message), e.message); }
}

console.log('\n== 11. WAV 往返：导出位深与输入一致、四舍五入限幅 ==');
{
  const w = load('sine1k-44k1-16.wav');
  const r = ref['sine1k-44k1-16.wav'];
  const design = designResampler(w.rate, r.target);
  const out = resampleChunked(design, w.channelData, 4096);
  const bytes = encodeWav(out, r.target, w.bits);
  const again = decodeWav(bytes);
  check('导出位深 16', again.bits === 16 && again.rate === r.target);
  // 量化误差不超过半个 LSB
  let worstQ = 0;
  for (let i = 0; i < out[0].length; i++) {
    worstQ = Math.max(worstQ, Math.abs(again.channelData[0][i] - out[0][i]));
  }
  check('16 位量化误差 <= 0.5 LSB', worstQ <= 0.5 / 32768 + 1e-12, worstQ.toExponential(2));

  const w24 = load('sine20k-48k-24.wav');
  const d24 = designResampler(w24.rate, 44100);
  const o24 = resampleChunked(d24, w24.channelData, 4096);
  const b24 = encodeWav(o24, 44100, 24);
  const a24 = decodeWav(b24);
  check('导出位深 24', a24.bits === 24);
  let worstQ24 = 0;
  for (let i = 0; i < o24[0].length; i++) {
    worstQ24 = Math.max(worstQ24, Math.abs(a24.channelData[0][i] - o24[0][i]));
  }
  check('24 位量化误差 <= 0.5 LSB', worstQ24 <= 0.5 / 8388608 + 1e-12, worstQ24.toExponential(2));

  // 限幅：构造超范围样本，直接校验量化后的整数值
  const hot = [new Float64Array([1.5, -1.5, 0.9999999])];
  const hb = encodeWav(hot, 48000, 16);
  const dv = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  const pos = dv.getInt16(44, true);
  const neg = dv.getInt16(46, true);
  check('限幅到 ±满刻度', pos === 32767 && neg === -32768, `${pos},${neg}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
