// tests/sample.test.js — 用真实 samples 压缩包验证 ZIP/WAV 解析（node tests/sample.test.js）
// 注意：压缩包为不可信数据，路径通过命令行参数或固定相对路径传入，不在其目录内运行。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const W = require('../src/wav.js');

(async () => {
  const zipPath = path.join(__dirname, '..', 'samples', 'speaker-simplex-cases.zip');
  const buf = fs.readFileSync(zipPath);
  const entries = await W.readZipEntries(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.ok(entries.has('layout.json'), '压缩包应含 layout.json');
  assert.ok(entries.has('source.wav'), '压缩包应含 source.wav');

  const layout = JSON.parse(new TextDecoder().decode(entries.get('layout.json')));
  const scene = E.buildScene(layout);
  assert.strictEqual(scene.n, 6);

  const wavBuf = entries.get('source.wav');
  const parsed = W.parseMonoPcm16(wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.length));
  assert.strictEqual(parsed.sampleRate, 48000);
  assert.strictEqual(parsed.nFrames, 48000);
  console.log('解析 source.wav：', parsed.nFrames, '帧，48kHz/16bit/单声道');

  // 轨迹末帧 47999 与音频帧数 48000（最后一帧索引 47999）一致
  const res = E.computeAll(scene, parsed.nFrames);
  assert.strictEqual(res.zeroFrames.length, 0);
  assert.strictEqual(res.fallbackFrames.length, 0);
  console.log('逐帧计算：', res.nFrames, '帧，零方向', res.zeroFrames.length, '个，耗时', res.elapsedMs.toFixed(1), 'ms');

  // 完整混音并导出，再回读校验声道数与数值
  const channels = scene.ids.map(() => new Float32Array(parsed.nFrames));
  const gains = new Float64Array(scene.n);
  let lastFace = -1;
  for (let f = 0; f < parsed.nFrames; f++) {
    const r = E.frameGains(scene, f, gains, lastFace);
    if (!r.zero && !r.fallback) lastFace = r.faceIndex;
    const s = parsed.samples[f];
    for (let ch = 0; ch < scene.n; ch++) channels[ch][f] = s * gains[ch];
  }
  const blob = W.writeFloatWav(channels, 48000);
  const out = await blob.arrayBuffer();
  const dv = new DataView(out);
  assert.strictEqual(dv.getUint16(22, true), 6, '导出 6 声道');
  assert.strictEqual(dv.getUint32(24, true), 48000);
  assert.strictEqual(dv.getUint16(34, true), 32);
  // 回读第 100 帧第 1 声道浮点值，与手工计算对照
  const g100 = new Float64Array(6);
  E.frameGains(scene, 100, g100, -1);
  const off = 44 + (100 * 6) * 4;
  const ch0 = dv.getFloat32(off, true);
  assert.ok(Math.abs(ch0 - parsed.samples[100] * g100[0]) < 1e-7,
    '回读值 ' + ch0 + ' 与计算值 ' + (parsed.samples[100] * g100[0]) + ' 偏差超 float32 容差');
  console.log('导出多声道 float32 WAV：', (out.byteLength / 1024).toFixed(1), 'KiB，数值回读一致');
  console.log('\n样例端到端测试通过');
})().catch((e) => { console.error(e); process.exit(1); });
