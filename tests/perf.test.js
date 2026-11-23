// tests/perf.test.js — 24 声道 15 秒性能预算与端到端混合（node tests/perf.test.js）
const assert = require('assert');
const E = require('../src/engine.js');
const W = require('../src/wav.js');
const fs = require('fs');
const path = require('path');

// ---------- 24 只等距（近似等角）扬声器：球面整数坐标 + 等半径校验放宽用构造 ----------
// 用 24 个单位球方向（球面均匀分布），再缩放到整数半径。为满足整数+共球，
// 取立方体内 ±1/±2 组合中半径一致的格点。
function build24() {
  // 半径 √5：两个分量 ±2、一个分量 ±1 的全部排列 = 3 位置 × 2²×3 = 24 点
  const speakers = [];
  let id = 1;
  const perms = [
    [2, 2, 1], [2, 1, 2], [1, 2, 2],
  ];
  for (const base of perms) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      speakers.push({ id: id++, xyz: [base[0] * sx, base[1] * sy, base[2] * sz] });
    }
  }
  // 该集合关于原点对称且充分包围，原点严格在内
  const path = [
    { frame: 0, xyz: [5, 0, 0] },
    { frame: 180000, xyz: [0, 5, 0] },
    { frame: 360000, xyz: [0, 0, 5] },
    { frame: 540000, xyz: [-5, 0, 0] },
    { frame: 719999, xyz: [0, -5, 0] },
  ];
  return { speakers, path };
}

const layout = build24();
assert.strictEqual(layout.speakers.length, 24);
const tBuild0 = process.hrtime.bigint();
const scene = E.buildScene(layout);
const tBuild1 = process.hrtime.bigint();
console.log('构建场景：', Number(tBuild1 - tBuild0) / 1e6, 'ms，面片数', scene.faces.length);

const N = 48000 * 15; // 720000 帧
const res = E.computeAll(scene, N);
console.log('逐帧增益（720k 帧 × 24 声道）：', res.elapsedMs.toFixed(1), 'ms');
assert.strictEqual(res.zeroFrames.length, 0);
assert.ok(res.elapsedMs < 8000, '逐帧计算应在 8 秒内，实际 ' + res.elapsedMs + 'ms');

// ---------- 端到端：合成 15 秒 16bit 单声道 → 混合 → float32 多声道 WAV ----------
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) pcm[i] = Math.round(32767 * 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000));
const wavBytes = (() => {
  const buf = new ArrayBuffer(44 + N * 2);
  const dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + N * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, 48000, true);
  dv.setUint32(28, 48000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, N * 2, true);
  for (let i = 0; i < N; i++) dv.setInt16(44 + i * 2, pcm[i], true);
  return buf;
})();

const parsed = W.parseMonoPcm16(wavBytes);
assert.strictEqual(parsed.nFrames, N);
assert.ok(Math.abs(parsed.samples[1] - pcm[1] / 32768) < 1e-9, 'PCM 应以 32768 归一');

// 混合：逐帧乘增益，输出按 id 升序的 24 声道
const tMix0 = process.hrtime.bigint();
const channels = scene.ids.map(() => new Float32Array(N));
const gains = new Float64Array(scene.n);
let lastFace = -1;
for (let f = 0; f < N; f++) {
  const r = E.frameGains(scene, f, gains, lastFace);
  if (!r.zero && !r.fallback) lastFace = r.faceIndex;
  const s = parsed.samples[f];
  for (let ch = 0; ch < scene.n; ch++) channels[ch][f] = s * gains[ch];
}
const tMix1 = process.hrtime.bigint();
console.log('混音（含逐帧增益）：', Number(tMix1 - tMix0) / 1e6, 'ms');

const blob = W.writeFloatWav(channels, 48000);
// Node 环境下把 Blob 转回 buffer 校验头
(async () => {
  const ab = await blob.arrayBuffer();
  const dv = new DataView(ab);
  const str = (o, l) => { let s = ''; for (let i = 0; i < l; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
  assert.strictEqual(str(0, 4), 'RIFF');
  assert.strictEqual(str(8, 4), 'WAVE');
  assert.strictEqual(dv.getUint16(20, true), 3, 'formatTag=IEEE float');
  assert.strictEqual(dv.getUint16(22, true), 24, '24 声道');
  assert.strictEqual(dv.getUint32(24, true), 48000);
  assert.strictEqual(dv.getUint16(34, true), 32, '32 位');
  const expectBytes = 44 + N * 24 * 4;
  assert.strictEqual(ab.byteLength, expectBytes);
  // 能量守恒：每帧所有声道平方和 ≈ 源样本平方。增益用 Float64 计算，
  // 输出为 Float32，24 声道累加误差取 float32 量级容差。
  let maxErr = 0;
  for (let f = 0; f < 1000; f++) {
    let sum = 0;
    for (let ch = 0; ch < 24; ch++) sum += channels[ch][f] ** 2;
    maxErr = Math.max(maxErr, Math.abs(sum - parsed.samples[f] ** 2));
  }
  assert.ok(maxErr < 1e-6, '单位能量归一应保持每帧总能量，最大误差 ' + maxErr);
  console.log('WAV 头与能量守恒校验通过；输出大小', (ab.byteLength / 1e6).toFixed(1), 'MiB');
  console.log('\n性能测试全部通过');
})();
