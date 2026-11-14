// 合成对抗用例：随机采样率/声道/噪声/频偏/twist 下的检测健壮性
// 用法：node test/synth-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DTMF = require('../dtmf.js');

let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log('  FAIL', m); } };

// 简单可复现随机数
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function makeTone(buf, sr, ch, startMs, endMs, freqs, amp, noiseAmp) {
  const s0 = Math.round((startMs * sr) / 1000), s1 = Math.round((endMs * sr) / 1000);
  for (let i = s0; i < s1 && i < buf[ch].length; i++) {
    const t = i / sr;
    let v = 0;
    for (const [f, a] of freqs) v += a * Math.sin(2 * Math.PI * f * t);
    buf[ch][i] += v;
  }
}
function addNoise(buf, sr, amp) {
  for (const ch of buf) for (let i = 0; i < ch.length; i++) ch[i] += amp * (rand() * 2 - 1);
}
function toInt16(buf) {
  return buf.map((ch) => {
    const o = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      let v = Math.round(ch[i] * 32767);
      o[i] = Math.max(-32768, Math.min(32767, v));
    }
    return o;
  });
}

async function runCase(name, sr, nCh, durMs, tones, expected, noiseAmp = 0) {
  const N = Math.round((durMs * sr) / 1000);
  const buf = Array.from({ length: nCh }, () => new Float32Array(N));
  for (const t of tones) makeTone(buf, sr, t.channel, t.startMs, t.endMs, t.freqs, t.amp, 0);
  if (noiseAmp) addNoise(buf, sr, noiseAmp);
  const int16 = toInt16(buf);
  const det = await DTMF.detectAudio(int16.map(DTMF.toFloat), sr);
  const used = new Array(det.length).fill(false);
  const probs = [];
  for (const exp of expected) {
    let hit = -1;
    for (let i = 0; i < det.length; i++) {
      if (used[i]) continue;
      const d = det[i];
      if (d.channel === exp.channel && d.key === exp.key &&
          Math.abs(d.startMs - exp.startMs) <= 15 && Math.abs(d.endMs - exp.endMs) <= 15) { hit = i; break; }
    }
    if (hit >= 0) used[hit] = true;
    else probs.push(`漏报 ${exp.key}@ch${exp.channel}[${exp.startMs}-${exp.endMs}]`);
  }
  det.forEach((d, i) => {
    if (!used[i]) probs.push(`多报 ${d.key}@ch${d.channel}[${d.startMs.toFixed(0)}-${d.endMs.toFixed(0)}]`);
  });
  const ok = probs.length === 0;
  if (!ok) { failures++; console.log(`FAIL ${name}`); probs.forEach((p) => console.log('   ' + p)); }
  else console.log(`PASS ${name} (${det.length} 事件)`);
  return det;
}

const keyTone = (key, channel, startMs, endMs, { lScale = 1, hScale = 1, twistDb = 0, amp = 0.3 } = {}) => {
  const [fl, fh] = DTMF.KEY_TABLE[key];
  const la = amp * Math.pow(10, twistDb / 40);   // 总功率恒定，按 twist 分配
  const ha = amp * Math.pow(10, -twistDb / 40);
  return { channel, startMs, endMs, freqs: [[fl * lScale, la], [fh * hScale, ha]] };
};

// 1) 48kHz 双声道 16 键全覆盖 + 20dB 噪声 + 极限频偏/twist 组合
{
  const tones = [], expected = [];
  const keys = DTMF.KEYS;
  const combos = [
    { lScale: 1.01, hScale: 0.99, twistDb: 6 }, { lScale: 0.99, hScale: 1.01, twistDb: -6 },
    { lScale: 1.01, hScale: 1.01, twistDb: 0 }, { lScale: 0.99, hScale: 0.99, twistDb: 6 },
  ];
  keys.forEach((k, i) => {
    const ch = i % 2, start = 200 + i * 300, end = start + 100;
    const combo = combos[i % combos.length];
    tones.push(keyTone(k, ch, start, end, combo));
    expected.push({ key: k, channel: ch, startMs: start, endMs: end });
  });
  // 20dB SNR：音功率约 amp²/2×2=0.09 → 噪声功率 0.0009 → 均匀噪声幅度 ≈ sqrt(0.0009*3)≈0.052
  await runCase('48k 双声道 16键 ±1%频偏 ±6dB twist 20dB噪声', 48000, 2, 5300, tones, expected, 0.052);
}

// 2) 8kHz 同键相邻：40ms 间隔必须分开，100ms 间隔分开
{
  const tones = [
    keyTone('5', 0, 200, 300), keyTone('5', 0, 340, 440),   // 40ms 间隔
    keyTone('5', 0, 600, 700), keyTone('5', 0, 800, 900),   // 100ms 间隔
    keyTone('7', 0, 1000, 1100), keyTone('5', 0, 1140, 1240), // 异键 40ms 间隔
  ];
  const expected = [
    { key: '5', channel: 0, startMs: 200, endMs: 300 }, { key: '5', channel: 0, startMs: 340, endMs: 440 },
    { key: '5', channel: 0, startMs: 600, endMs: 700 }, { key: '5', channel: 0, startMs: 800, endMs: 900 },
    { key: '7', channel: 0, startMs: 1000, endMs: 1100 }, { key: '5', channel: 0, startMs: 1140, endMs: 1240 },
  ];
  await runCase('8k 同键/异键相邻间隔', 8000, 1, 1500, tones, expected);
}

// 3) 负例全集：20ms 短音、单频、三频、跨声道拆频、59ms→不算（边界外不测）
{
  const tones = [
    { channel: 0, startMs: 100, endMs: 120, freqs: [[697, 0.3], [1209, 0.3]] },        // 20ms 短音
    { channel: 0, startMs: 300, endMs: 420, freqs: [[697, 0.3]] },                     // 单频低
    { channel: 0, startMs: 500, endMs: 620, freqs: [[1633, 0.3]] },                    // 单频高
    { channel: 0, startMs: 700, endMs: 820, freqs: [[697, 0.25], [770, 0.25], [1209, 0.25]] }, // 三频
    { channel: 0, startMs: 900, endMs: 1020, freqs: [[852, 0.3]] },                    // 左只有低
    { channel: 1, startMs: 900, endMs: 1020, freqs: [[1477, 0.3]] },                   // 右只有高
    { channel: 1, startMs: 1100, endMs: 1220, freqs: [[941, 0.25], [1209, 0.25], [1336, 0.25]] }, // 三频(高组双)
  ];
  await runCase('负例：短音/单频/三频/跨声道', 16000, 2, 1400, tones, []);
}

// 4) 16kHz 60ms 最短按键 + 边界贴头尾
{
  const tones = [keyTone('3', 0, 0, 60), keyTone('8', 0, 940, 1000), keyTone('0', 0, 400, 460)];
  const expected = [
    { key: '3', channel: 0, startMs: 0, endMs: 60 },
    { key: '8', channel: 0, startMs: 940, endMs: 1000 },
    { key: '0', channel: 0, startMs: 400, endMs: 460 },
  ];
  await runCase('16k 60ms 最短按键+头尾边界', 16000, 1, 1000, tones, expected);
}

// 5) 60 秒 48kHz 双声道性能与首尾事件
{
  const tones = [keyTone('2', 0, 0, 120), keyTone('#', 1, 59880, 60000), keyTone('A', 0, 30000, 30120)];
  const expected = [
    { key: '2', channel: 0, startMs: 0, endMs: 120 },
    { key: '#', channel: 1, startMs: 59880, endMs: 60000 },
    { key: 'A', channel: 0, startMs: 30000, endMs: 30120 },
  ];
  const t0 = Date.now();
  await runCase('48k 双声道 60s 全长', 48000, 2, 60000, tones, expected, 0.02);
  console.log(`   耗时 ${Date.now() - t0}ms`);
}

console.log(failures ? `\n${failures} 项失败` : '全部通过');
process.exit(failures ? 1 : 0);
