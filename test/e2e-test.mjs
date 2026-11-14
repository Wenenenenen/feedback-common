// 端到端一致性：检测 → 事件帧号 → CSV 文本 → 解析回事件 → 脱敏 → 重编码 → 复检
// 验证：1) 输出格式保持 2) CSV 与导出音频基于同一事件列表 3) 脱敏后不再检出按键
// 用法：node test/e2e-test.mjs <样例目录>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const DTMF = require('../dtmf.js');

const dir = process.argv[2];
let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log('  FAIL', m); } };

for (const file of ['clean-8k.wav', 'noisy-16k.wav', 'edge-60s.wav']) {
  console.log(file);
  const wav = DTMF.decodeWav(readFileSync(join(dir, file)).buffer);
  const { sampleRate: sr, numFrames: N, numChannels: nCh } = wav;

  // —— 与 app.js 相同的事件帧号换算 ——
  const detected = await DTMF.detectAudio(wav.int16.map(DTMF.toFloat), sr);
  const events = detected.map((e) => ({
    key: e.key, channel: e.channel,
    startFrame: Math.max(0, Math.round((e.startMs * sr) / 1000)),
    endFrame: Math.min(N, Math.round((e.endMs * sr) / 1000)),
  })).filter((e) => e.endFrame > e.startFrame);

  // —— 与 app.js 相同的 CSV 生成 ——
  const rows = [...events].sort((a, b) => a.channel - b.channel || a.startFrame - b.startFrame);
  const lines = ['channel,key,start_frame,end_frame,start_ms,end_ms'];
  for (const ev of rows) {
    lines.push([ev.channel, ev.key, ev.startFrame, ev.endFrame,
      ((ev.startFrame / sr) * 1000).toFixed(3), ((ev.endFrame / sr) * 1000).toFixed(3)].join(','));
  }
  const csv = lines.join('\n') + '\n';

  // —— 解析 CSV 回事件（模拟下游/复核方）——
  const parsed = csv.trim().split('\n').slice(1).map((l) => {
    const [channel, key, sf, ef] = l.split(',');
    return { channel: Number(channel), key, startFrame: Number(sf), endFrame: Number(ef) };
  });
  check(parsed.length === rows.length && parsed.every((p, i) => {
    const r = rows[i];
    return p.channel === r.channel && p.key === r.key &&
      p.startFrame === r.startFrame && p.endFrame === r.endFrame;
  }), 'CSV 往返后事件(声道/键/起止帧)不变');

  // —— 用 CSV 事件脱敏（both 模式），重编码后复检 ——
  const out = DTMF.redact(wav.int16, sr, N, parsed, 'both');
  const re = DTMF.decodeWav(DTMF.encodeWav(out, sr, N));
  check(re.sampleRate === sr && re.numChannels === nCh && re.numFrames === N, '输出格式保持');
  const reDet = await DTMF.detectAudio(re.int16.map(DTMF.toFloat), sr);
  check(reDet.length === 0, `脱敏后不应再检出按键（检出 ${reDet.length} 个）`);

  // —— event 模式：无事件声道必须与原文件逐采样一致 ——
  const outEv = DTMF.redact(wav.int16, sr, N, parsed, 'event');
  const touchedCh = new Set(parsed.map((e) => e.channel));
  for (let c = 0; c < nCh; c++) {
    if (touchedCh.has(c)) continue;
    let same = true;
    for (let i = 0; i < N; i++) if (outEv[c][i] !== wav.int16[c][i]) { same = false; break; }
    check(same, `event 模式下声道 ${c}（无事件）应逐采样不变`);
  }
}

console.log(failures ? `\n${failures} 项失败` : '全部通过');
process.exit(failures ? 1 : 0);
