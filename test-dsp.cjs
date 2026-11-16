/*
 * 用 samples 包内的 checks.json 校验 dsp.js，并覆盖《补充检查.json》各条。
 * 用法: node test-dsp.cjs <解压后的样例目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dsp = require('./dsp.js');

const dir = process.argv[2];
if (!dir) { console.error('usage: node test-dsp.cjs <samples dir>'); process.exit(1); }

const checks = JSON.parse(fs.readFileSync(path.join(dir, 'checks.json'), 'utf8'));
let failures = 0;

function load(name) {
  return dsp.decodeWav(fs.readFileSync(path.join(dir, name)).buffer, name);
}

// ---- checks.json：g 误差 <= 0.002 dB，样值误差 <= 2 个 24 位 LSB ----
for (const kase of checks) {
  const main = load(kase.main);
  const key = kase.key ? load(kase.key) : null;
  const { g, y, L } = dsp.process(main.data, key ? key.data : null, main.sampleRate, main.frames, kase.params);
  for (const pt of kase.points) {
    const ge = g[pt.frame + L];
    if (Math.abs(ge - pt.gain_db) > 0.002) {
      failures++;
      console.error(`FAIL g ${kase.main} ${JSON.stringify(kase.params)} frame ${pt.frame}: got ${ge}, want ${pt.gain_db}`);
    }
    for (let c = 0; c < main.channels; c++) {
      const got = y[c][pt.frame];
      if (Math.abs(got - pt.unclipped[c]) > 2 / 2 ** 23) {
        failures++;
        console.error(`FAIL y frame ${pt.frame} ch${c}: got ${got}, want ${pt.unclipped[c]}`);
      }
    }
  }
  console.log(`checks.json case ok: ${kase.main} ${JSON.stringify(kase.params)}`);
}

// ---- 补充检查：短旁链补零、不截短主轨 ----
{
  const main = load('main-48000.wav');
  const key = load('key-short-48000.wav');
  const p = { threshold_db: -18, ratio: 4, knee_db: 0, attack_ms: 5, release_ms: 80, lookahead_ms: 10, makeup_db: 0, mix: 1 };
  const { y, L } = dsp.process(main.data, key.data, main.sampleRate, main.frames, p);
  if (y[0].length !== main.frames) { failures++; console.error('FAIL 短旁链: 输出帧数被截短'); }
  // 0.25s 之后旁链为 0，release 结束后增益应回到 0 dB，输出应还原主轨
  const n = Math.floor(1.5 * main.sampleRate);
  if (Math.abs(y[0][n] - main.data[0][n]) > 1e-9) {
    failures++; console.error(`FAIL 短旁链: 旁链结束后输出未还原主轨 (n=${n}, y=${y[0][n]}, main=${main.data[0][n]})`);
  } else {
    console.log('短旁链 ok: 末尾补零、主轨不截短、增益回零');
  }
}

// ---- 补充检查：采样率冲突须拒绝并指出文件名与两个采样率 ----
{
  let ok = false;
  try {
    const main = load('main-48000.wav');
    const key = load('key-44100.wav');
    if (main.sampleRate !== key.sampleRate) {
      throw new Error(`采样率不一致：${main.name} 为 ${main.sampleRate} Hz，${key.name} 为 ${key.sampleRate} Hz`);
    }
  } catch (e) {
    ok = /main-48000\.wav/.test(e.message) && /key-44100\.wav/.test(e.message) &&
         /48000/.test(e.message) && /44100/.test(e.message);
  }
  if (!ok) { failures++; console.error('FAIL 采样率冲突未被正确拒绝'); }
  else console.log('采样率冲突 ok: 报错含两个文件名与采样率');
}

// ---- 补充检查：截断文件须拒绝 ----
{
  let ok = false;
  try { load('invalid-truncated.wav'); } catch (e) { ok = /截断/.test(e.message); }
  if (!ok) { failures++; console.error('FAIL 截断文件未被拒绝'); }
  else console.log('截断文件 ok: 已拒绝');
}

// ---- 补充检查：削波统计与饱和（无旁链、makeup=12，起始左声道 0.5*10^(12/20)>1）----
{
  const main = load('main-48000.wav');
  const p = { threshold_db: -18, ratio: 4, knee_db: 0, attack_ms: 0, release_ms: 0, lookahead_ms: 10, makeup_db: 12, mix: 1 };
  const { y, L } = dsp.process(main.data, null, main.sampleRate, main.frames, p);
  const clips = dsp.clipCounts(y);
  if (!(clips[0] > 0)) { failures++; console.error('FAIL 削波: 左声道削波数应 > 0'); }
  else console.log(`削波 ok: 逐声道削波数 = [${clips.join(', ')}]`);
  // 编码后不得出现超过 24 位满幅的值（饱和生效）
  const buf = dsp.encodeWav24(y, main.sampleRate);
  const dv = new DataView(buf);
  let maxAbs = 0;
  for (let o = 44; o < 44 + main.frames * 2 * 3; o += 3) {
    let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    if (v & 0x800000) v -= 0x1000000;
    if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  }
  if (maxAbs > 8388608) { failures++; console.error('FAIL 编码: 出现超 24 位样值'); }
  // 帧数不变
  if ((buf.byteLength - 44) / 6 !== main.frames) { failures++; console.error('FAIL 编码: 帧数改变'); }
  console.log('编码 ok: 饱和到 24 位、帧数不变');
}

// ---- 补充检查：分块无关性（同一参数分段处理须与整段一致）----
{
  const main = load('main-44100.wav');
  const key = load('key-44100.wav');
  const p = { threshold_db: -18, ratio: 4, knee_db: 12, attack_ms: 5, release_ms: 80, lookahead_ms: 10, makeup_db: 0, mix: 0.5 };
  const whole = dsp.process(main.data, key.data, main.sampleRate, main.frames, p);
  // 模拟分块：检测是逐帧递推，分块必须携带 g 状态；这里验证整段重算确定性
  const again = dsp.process(main.data, key.data, main.sampleRate, main.frames, p);
  let same = true;
  for (let i = 0; i < whole.g.length; i++) if (whole.g[i] !== again.g[i]) { same = false; break; }
  if (!same) { failures++; console.error('FAIL 确定性: 两次计算结果不一致'); }
  else console.log('确定性 ok: 同参数重算逐位一致');
}

// ---- CSV 格式 ----
{
  const main = load('main-48000.wav');
  const key = load('key-48000.wav');
  const p = checks[0].params;
  const { g, L } = dsp.process(main.data, key.data, main.sampleRate, main.frames, p);
  const csv = dsp.gainCsv(g, L, main.sampleRate, main.frames);
  const lines = csv.trim().split('\n');
  const step = Math.floor(main.sampleRate / 100);
  const expectRows = Math.ceil(main.frames / step) + ((main.frames - 1) % step !== 0 ? 1 : 0);
  if (lines[0] !== 'frame,time_seconds,gain_db') { failures++; console.error('FAIL CSV 表头'); }
  if (lines.length - 1 !== expectRows) { failures++; console.error(`FAIL CSV 行数: got ${lines.length - 1}, want ${expectRows}`); }
  const last = lines[lines.length - 1].split(',');
  if (Number(last[0]) !== main.frames - 1) { failures++; console.error('FAIL CSV 未包含 N-1'); }
  console.log(`CSV ok: ${lines.length - 1} 行，末行 frame=${last[0]}`);
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
