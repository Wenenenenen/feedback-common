/* Node 测试台（无第三方依赖）：DSSS 水印正确性 + 鲁棒性矩阵。运行：node tests/run-tests.js */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'js', 'wav-codec.js'));
require(path.join(__dirname, '..', 'js', 'watermark.js'));
const WM = globalThis.WM;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ---------- 工具 ----------
function mulberry(a) {
  return function () {
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function synth(seconds, fs, ch, seedNo, tonal) {
  const n = Math.round(seconds * fs);
  const mk = () => {
    const rng = mulberry(seedNo || 7);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      if (tonal) {
        x[i] = 0.22 * Math.sin(2 * Math.PI * 330 * t)
          + 0.15 * Math.sin(2 * Math.PI * 880 * t + 1.3)
          + 0.10 * Math.sin(2 * Math.PI * 2200 * t + 0.7)
          + 0.05 * (rng() * 2 - 1);
      } else {
        x[i] = 0.2 * (rng() * 2 - 1);
      }
      if (t > seconds * 0.55 && t < seconds * 0.62) x[i] *= 0.02; // 一段静音
    }
    return x;
  };
  const samples = ch === 2 ? [mk(), mk()] : [mk()];
  return { sampleRate: fs, channels: ch, bitsPerSample: 16, length: n, samples };
}
function roundTripWav(wav) { return WM.decodeWav(WM.encodeWav(wav.samples, wav.sampleRate)); }
function cutMid(wav, startSec, durSec) {
  const s = Math.round(startSec * wav.sampleRate), n = Math.round(durSec * wav.sampleRate);
  const samples = wav.samples.map(ch => ch.subarray(s, s + n).slice());
  return { sampleRate: wav.sampleRate, channels: wav.channels, bitsPerSample: 16, length: n, samples };
}
function scaleGain(wav, g) {
  return Object.assign({}, wav, { samples: wav.samples.map(ch => { const y = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) y[i] = ch[i] * g; return y; }) });
}
function addNoise(wav, rms, seedNo) {
  const rng = mulberry(seedNo || 99);
  return Object.assign({}, wav, { samples: wav.samples.map(ch => {
    const y = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) y[i] = ch[i] + rms * (rng() * 2 - 1);
    return y;
  }) });
}
function monoMix(wav) {
  const m = WM.downmix(wav);
  return { sampleRate: wav.sampleRate, channels: 1, bitsPerSample: 16, length: wav.length, samples: [m] };
}
function rms(x) { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
function rmsDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s / a.length); }

const ID = '1A2B3C4D';
const PASS = 'open-sesame-2026';
const ALPHA = 0.01;

// ---------- T1 样例文件往返 ----------
console.log('\n[T1] 样例 WAV 嵌入/检测/格式保持');
{
  const buf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'watermark-bed.wav'));
  const wav = WM.decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const res = WM.embed(wav, ID, PASS, { alpha: ALPHA });
  const marked = { sampleRate: wav.sampleRate, channels: wav.channels, length: wav.length, samples: res.samples };
  check('声道/长度/采样率保持', marked.channels === 2 && marked.length === wav.length && marked.sampleRate === 16000);
  const back = roundTripWav(marked);
  check('16-bit WAV 往返一致', back.length === wav.length && back.channels === 2 && back.sampleRate === 16000);
  const rep = WM.verify(back, PASS);
  check('完整文件可检出', rep.detected === true, rep);
  check('编号正确', rep.idHex === ID, rep.idHex);
  const d = rmsDiff(wav.samples[0], marked.samples[0]);
  console.log('    水印残差 RMS =', d.toFixed(5), ' 宿主 RMS =', rms(wav.samples[0]).toFixed(4),
    ' 同步相关 =', rep.syncCorr.toFixed(3), ' 裕量 =', rep.payloadMargin.toFixed(2));
  check('失真受控 (残差 RMS < 0.02)', d < 0.02, { d });
  check('错口令不检出', WM.verify(back, 'wrong-passphrase').detected === false);
  check('未嵌入文件不检出', WM.verify(wav, PASS).detected === false);
  const cleanRep = WM.verify(wav, PASS);
  check('未嵌入文件信号强度低于门限', cleanRep.strength < WM.STRENGTH_THRESHOLD, { strength: cleanRep.strength });
  fs.writeFileSync(path.join(__dirname, 'out-marked.wav'), Buffer.from(WM.encodeWav(marked.samples, marked.sampleRate)));
}

// ---------- T2 中间剪片 ≥6s，任意起点 ----------
console.log('\n[T2] 中间剪片重新同步');
{
  const buf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'watermark-bed.wav'));
  const wav = WM.decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const marked = Object.assign({}, wav, { samples: WM.embed(wav, ID, PASS, { alpha: ALPHA }).samples });
  for (const [st, dur] of [[3.0, 6.0], [2.37, 6.5], [0.5, 7.0], [5.13, 6.07], [4.0, 6.0]]) {
    const clip = roundTripWav(cutMid(marked, st, dur));
    const rep = WM.verify(clip, PASS);
    check(`剪片 ${st}s 起 / ${dur}s 检出且编号正确`, rep.detected && rep.idHex === ID,
      { detected: rep.detected, corr: rep.syncCorr && +rep.syncCorr.toFixed(3), margin: rep.payloadMargin && +rep.payloadMargin.toFixed(2), reason: rep.reason });
    if (rep.detected) console.log('    片段内首同步位置 =', rep.position.firstSyncSec.toFixed(3), 's，覆盖块数 =', rep.blocksCovered);
  }
}

// ---------- T3 鲁棒性矩阵 ----------
console.log('\n[T3] 鲁棒性矩阵（合成 12s 立体声）');
{
  const base = synth(12, 16000, 2, 11, true);
  const marked = Object.assign({}, base, { samples: WM.embed(base, ID, PASS, { alpha: ALPHA }).samples });
  const matrix = [
    ['增益 x2', w => scaleGain(w, 2)],
    ['增益 x0.25', w => scaleGain(w, 0.25)],
    ['增益 x0.1', w => scaleGain(w, 0.1)],
    ['负增益 -1', w => scaleGain(w, -1)],
    ['底噪 RMS 0.01', w => addNoise(w, 0.01, 21)],
    ['底噪 RMS 0.03', w => addNoise(w, 0.03, 22)],
    ['立体声下混', w => monoMix(w)],
    ['下混+x0.5+噪声0.02', w => addNoise(scaleGain(monoMix(w), 0.5), 0.02, 23)],
    ['剪片6s+x2+噪声0.02', w => addNoise(scaleGain(cutMid(w, 4.0, 6.2), 2), 0.02, 24)],
    ['剪片6.5s+下混+x0.25', w => scaleGain(monoMix(cutMid(w, 2.1, 6.5)), 0.25)],
    ['剪片6s+噪声0.03', w => addNoise(cutMid(w, 3.3, 6.0), 0.03, 25)],
  ];
  for (const [name, fn] of matrix) {
    const t = roundTripWav(fn(marked));
    const rep = WM.verify(t, PASS);
    check(name, rep.detected && rep.idHex === ID,
      { detected: rep.detected, id: rep.idHex, corr: rep.syncCorr && +rep.syncCorr.toFixed(3), margin: rep.payloadMargin && +rep.payloadMargin.toFixed(2), reason: rep.reason });
  }
}

// ---------- T4 时长边界 4s / 30s，单/双声道 ----------
console.log('\n[T4] 时长边界与声道');
for (const [sec, ch] of [[4, 1], [4, 2], [30, 1], [30, 2]]) {
  const base = synth(sec, 16000, ch, sec + ch, false);
  const marked = Object.assign({}, base, { samples: WM.embed(base, ID, PASS, { alpha: ALPHA }).samples });
  const rep = WM.verify(roundTripWav(marked), PASS);
  check(`合成 ${sec}s ${ch === 2 ? '立体声' : '单声道'} 检出`, rep.detected && rep.idHex === ID,
    { detected: rep.detected, reason: rep.reason, corr: rep.syncCorr && +rep.syncCorr.toFixed(3) });
}

// ---------- T5 强度可调 ----------
console.log('\n[T5] 强度档位与可检性/失真权衡');
for (const alpha of [0.003, 0.006, 0.01, 0.02]) {
  const base = synth(10, 16000, 2, 31, true);
  const r = WM.embed(base, ID, PASS, { alpha });
  const marked = Object.assign({}, base, { samples: r.samples });
  const rep = WM.verify(roundTripWav(marked), PASS);
  const tough = WM.verify(roundTripWav(addNoise(scaleGain(cutMid(marked, 2, 6.5), 0.5), 0.02, 41)), PASS);
  const d = rmsDiff(base.samples[0], marked.samples[0]);
  console.log(`    alpha=${alpha} 残差RMS=${d.toFixed(5)} 强度=${rep.strength.toFixed(3)} 完整:${rep.detected} 剪片+噪声:${tough.detected}(强度${tough.strength && tough.strength.toFixed(3)})`);
  if (alpha >= 0.006) check(`alpha=${alpha} 完整文件可检`, rep.detected && rep.idHex === ID, rep);
  else check(`alpha=${alpha} 弱信号如实报强度不足`, rep.detected === false && rep.strength < WM.STRENGTH_THRESHOLD, rep);
}

// ---------- T6 输入校验 ----------
console.log('\n[T6] 异常输入');
{
  const base = synth(8, 16000, 1, 61, true);
  let threw = false;
  try { WM.embed(base, 'XYZ', PASS); } catch (e) { threw = true; }
  check('非法编号被拒绝', threw);
  threw = false;
  try { WM.embed(base, ID, ''); } catch (e) { threw = true; }
  check('空口令被拒绝', threw);
  threw = false;
  try { WM.embed(Object.assign({}, base, { sampleRate: 8000 }), ID, PASS); } catch (e) { threw = true; }
  check('非 16kHz 被拒绝', threw);
  threw = false;
  try { WM.embed(base, ID, PASS, { alpha: 0.5 }); } catch (e) { threw = true; }
  check('越界强度被拒绝', threw);
}

// ---------- T7 篡改编号必被 CRC 捕获 ----------
console.log('\n[T7] 完整性');
{
  const base = synth(8, 16000, 1, 71, true);
  const m1 = Object.assign({}, base, { samples: WM.embed(base, ID, PASS, { alpha: ALPHA }).samples });
  const m2 = Object.assign({}, base, { samples: WM.embed(base, 'FFFFFFFF', PASS, { alpha: ALPHA }).samples });
  // 把 m2 的水印混入 m1 相当于替换载荷；直接验证两个不同编号各自 CRC 独立
  const r1 = WM.verify(roundTripWav(m1), PASS);
  const r2 = WM.verify(roundTripWav(m2), PASS);
  check('不同编号互不混淆', r1.idHex === ID && r2.idHex === 'FFFFFFFF', { r1: r1.idHex, r2: r2.idHex });
}

// ---------- T8 假阳性与口令隔离 ----------
console.log('\n[T8] 假阳性/口令隔离');
{
  const buf2 = fs.readFileSync(path.join(__dirname, '..', 'samples', 'watermark-bed.wav'));
  const wav2 = WM.decodeWav(buf2.buffer.slice(buf2.byteOffset, buf2.byteOffset + buf2.byteLength));
  const r2 = WM.embed(wav2, ID, 'correct-horse', { alpha: 0.01 });
  const marked2 = WM.decodeWav(WM.encodeWav(r2.samples, wav2.sampleRate));
  let falseHits = 0;
  for (let k = 0; k < 20; k++) if (WM.verify(marked2, 'wrong-pass-' + k).detected) falseHits++;
  for (let k = 0; k < 5; k++) if (WM.verify(wav2, 'any-pass-' + k).detected) falseHits++;
  const other = WM.decodeWav(WM.encodeWav(WM.embed(wav2, 'DEADBEEF', 'other-secret', { alpha: 0.01 }).samples, wav2.sampleRate));
  if (WM.verify(other, 'correct-horse').detected) falseHits++;
  const rng2 = mulberry(123);
  const nz = new Float32Array(8 * 16000); for (let i = 0; i < nz.length; i++) nz[i] = 0.1 * (rng2() * 2 - 1);
  if (WM.verify({ sampleRate: 16000, channels: 1, length: nz.length, samples: [nz] }, 'correct-horse').detected) falseHits++;
  check('27 个错口令/裸宿主/交叉/纯噪场景零误检出', falseHits === 0, { falseHits });
  const ok = WM.verify(marked2, 'correct-horse');
  check('正确口令稳定检出且编号正确', ok.detected && ok.idHex === ID, ok);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
