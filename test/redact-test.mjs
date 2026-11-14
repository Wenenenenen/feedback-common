// 脱敏渲染不变量测试：node test/redact-test.mjs <样例目录>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const DTMF = require('../dtmf.js');

const dir = process.argv[2];
let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL', msg); }
}

// --- 用 noisy-16k（双声道、两声道都有事件）测试 ---
const wav = DTMF.decodeWav(readFileSync(join(dir, 'noisy-16k.wav')).buffer);
const { sampleRate: sr, numFrames: N, numChannels: nCh } = wav;
const events = (await DTMF.detectAudio(wav.int16.map(DTMF.toFloat), sr)).map((e) => ({
  ...e,
  startFrame: Math.round((e.startMs * sr) / 1000),
  endFrame: Math.round((e.endMs * sr) / 1000),
}));
console.log(`noisy-16k: ${events.length} 个事件`);

const F10 = Math.round(sr * 0.01), F5 = Math.round(sr * 0.005);

for (const mode of ['event', 'both']) {
  console.log(`模式: ${mode}`);
  const out = DTMF.redact(wav.int16, sr, N, events, mode);

  // 1) 格式保持：重编码后采样率/声道/总帧数不变
  const re = DTMF.decodeWav(DTMF.encodeWav(out, sr, N));
  check(re.sampleRate === sr && re.numChannels === nCh && re.numFrames === N, '输出格式(采样率/声道/总帧数)保持');

  // 2) 逐事件验证静音区、渐变区、未触及区
  // 计算每声道期望的增益包络
  const expectGain = Array.from({ length: nCh }, () => new Float32Array(N).fill(1));
  for (const ev of events) {
    const targets = mode === 'both' ? [0, 1] : [ev.channel];
    const a = Math.max(0, ev.startFrame - F10), b = Math.min(N, ev.endFrame + F10);
    const fa = Math.max(0, a - F5), fb = Math.min(N, b + F5);
    for (const c of targets) {
      const g = expectGain[c];
      for (let i = fa; i < a; i++) g[i] = Math.min(g[i], (a - i) / (a - fa));
      for (let i = a; i < b; i++) g[i] = 0;
      for (let i = b; i < fb; i++) g[i] = Math.min(g[i], (i - b) / (fb - b));
    }
  }
  let silentChecked = 0, fadeChecked = 0, untouchedChecked = 0;
  for (let c = 0; c < nCh; c++) {
    for (let i = 0; i < N; i++) {
      const g = expectGain[c][i];
      if (g === 1) {
        if (out[c][i] !== wav.int16[c][i]) { check(false, `ch${c} 帧${i} 未触及采样被改动`); break; }
        untouchedChecked++;
      } else if (g === 0) {
        if (out[c][i] !== 0) { check(false, `ch${c} 帧${i} 静音区非零: ${out[c][i]}`); break; }
        silentChecked++;
      } else {
        if (out[c][i] !== Math.round(wav.int16[c][i] * g)) { check(false, `ch${c} 帧${i} 渐变值错误`); break; }
        fadeChecked++;
      }
    }
  }
  console.log(`  静音采样 ${silentChecked}, 渐变采样 ${fadeChecked}, 原样保留 ${untouchedChecked}`);
  check(silentChecked > 0 && fadeChecked > 0 && untouchedChecked > 0, '三类区域均应存在');
}

// 3) 重叠事件并集：构造两个间隔 <10ms 扩展区相接的事件，中间不应恢复原信号
{
  const synth = [new Int16Array(N).fill(1000), new Int16Array(N).fill(2000)];
  const ev1 = { channel: 0, startFrame: 5000, endFrame: 6000 };
  const ev2 = { channel: 0, startFrame: 6000 + F10, endFrame: 7000 + F10 }; // 扩展区 [5990+F10...] 相接
  const out = DTMF.redact(synth, sr, N, [ev1, ev2], 'event');
  // ev1 扩展区 [5000-F10, 6000+F10]，ev2 扩展区 [6000, 7100+F10] → 并集连续静音
  let ok = true;
  for (let i = 5000 - F10; i < 7100 + F10; i++) if (out[0][i] !== 0) { ok = false; break; }
  check(ok, '重叠/相接扩展区按并集处理（中间无恢复）');
  check(out[1][5000] === 2000, 'event 模式下非事件声道不受影响');
  const outBoth = DTMF.redact(synth, sr, N, [ev1], 'both');
  check(outBoth[1][5500] === 0, 'both 模式下另一声道同步静音');
}

// 4) 边界裁剪：事件贴近文件头尾
{
  const synth = [new Int16Array(N).fill(1000)];
  const ev = [{ channel: 0, startFrame: 0, endFrame: 100 }, { channel: 0, startFrame: N - 100, endFrame: N }];
  const out = DTMF.redact(synth, sr, N, ev, 'event');
  check(out[0][0] === 0 && out[0][N - 1] === 0, '头尾边界裁剪正常');
  check(out[0][F10 + F5 + 200] === 1000, '事件区外不受影响');
}

console.log(failures ? `\n${failures} 项失败` : '全部通过');
process.exit(failures ? 1 : 0);
