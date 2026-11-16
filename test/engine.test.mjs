// 用法: node test/engine.test.mjs [样例目录]
// 默认样例目录: samples/pedal-voice-cases
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = require(join(root, 'engine.js'));
const casesDir = process.argv[2] || join(root, 'samples', 'pedal-voice-cases');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`); }
function load(name) { return JSON.parse(readFileSync(join(casesDir, name), 'utf8')); }
function run(proj, paramsOverride) {
  const params = Object.assign({}, proj.params, paramsOverride);
  const tl = engine.computeTimeline(proj, params);
  if (tl.errors && tl.errors.length) return { errors: tl.errors };
  const render = engine.renderAudio(tl);
  return { tl, render, report: engine.buildReport(tl, render) };
}
const voiceById = (tl, id) => tl.voices.find((v) => v.id === id);

// ---- stolen-fifo ----
{
  const proj = load('stolen-fifo.json');
  const ref = load('reference/stolen-fifo.json');
  const { tl, report } = run(proj);
  console.log('stolen-fifo');
  eq(tl.voices.length, 3, '声部数');
  for (const rv of ref.voices) {
    const v = voiceById(tl, rv.id);
    ok(v, `声部 ${rv.id} 存在`);
    if (!v) continue;
    for (const k of ['on_frame', 'key_up_frame', 'release_frame', 'end_frame', 'reason']) {
      eq(v[{ on_frame: 'onFrame', key_up_frame: 'keyUpFrame', release_frame: 'releaseFrame', end_frame: 'endFrame', reason: 'reason' }[k]], rv[k], `声部 ${rv.id}.${k}`);
    }
  }
  eq(JSON.stringify(report.unmatched_off_events), JSON.stringify(ref.unmatched_off_events), '未配对 off');
  eq(tl.totalFrames, ref.total_frames, 'total_frames');
}

// ---- pedal-overlap ----
{
  const proj = load('pedal-overlap.json');
  const ref = load('reference/pedal-overlap.json');
  const { tl } = run(proj);
  console.log('pedal-overlap');
  eq(tl.voices.length, 3, '声部数');
  for (const rv of ref.voices) {
    const v = voiceById(tl, rv.id);
    ok(v, `声部 ${rv.id} 存在`);
    if (!v) continue;
    eq(v.onFrame, rv.on_frame, `声部 ${rv.id}.on_frame`);
    eq(v.keyUpFrame, rv.key_up_frame, `声部 ${rv.id}.key_up_frame`);
    eq(v.releaseFrame, rv.release_frame, `声部 ${rv.id}.release_frame`);
    eq(v.endFrame, rv.end_frame, `声部 ${rv.id}.end_frame`);
    eq(v.reason, rv.reason, `声部 ${rv.id}.reason`);
  }
  eq(tl.totalFrames, ref.total_frames, 'total_frames');
}

// ---- same-tick ----
{
  const proj = load('same-tick.json');
  const ref = load('reference/same-tick.json');
  const { tl } = run(proj);
  console.log('same-tick');
  eq(voiceById(tl, 0).releaseFrame, ref.id0_release_frame, 'id0 release_frame');
  eq(voiceById(tl, 4).releaseFrame, ref.id4_release_frame, 'id4 release_frame');
  eq(voiceById(tl, 4).endFrame, ref.id4_end_frame, 'id4 end_frame');
  eq(voiceById(tl, 4).reason, 'project_end', 'id4 reason');
  eq(tl.totalFrames, ref.total_frames, 'total_frames');
}

// ---- release-priority ----
{
  const proj = load('release-priority.json');
  const ref = load('reference/release-priority.json');
  const { tl } = run(proj);
  console.log('release-priority');
  const stolen = tl.voices.find((v) => v.reason === 'stolen');
  ok(stolen, '存在被偷声部');
  eq(stolen && stolen.id, ref.stolen_id, '被偷声部 id');
  eq(stolen && stolen.endFrame, ref.steal_frame, '偷声帧');
  ok(voiceById(tl, ref.surviving_older_id).reason !== 'stolen', '更旧的声部存活');
  // 事件 5 是 velocity=0 的 on，按 off 处理并释放声部 3
  const ev5 = tl.events.find((e) => e.index === ref.zero_velocity_event);
  eq(ev5.type, 'on', '事件5类型为 on');
  eq(ev5.velocity, 0, '事件5 velocity=0');
  const v3 = voiceById(tl, ref.zero_velocity_releases_id);
  eq(v3.keyUpFrame, ev5.frame, '零力度事件配对声部3的 key_up_frame');
  eq(v3.releaseFrame, ev5.frame, '零力度事件释放声部3');
}

// ---- tempo-unsorted ----
{
  const proj = load('tempo-unsorted.json');
  const ref = load('reference/tempo-unsorted.json');
  const { tl } = run(proj);
  console.log('tempo-unsorted');
  const byIndex = new Map(tl.events.map((e) => [e.index, e.frame]));
  ref.event_frames_by_input_index.forEach((f, i) => eq(byIndex.get(i), f, `事件${i} 帧号`));
  eq(tl.totalFrames, ref.total_frames, 'total_frames');
  eq(tl.R, ref.release_frames, 'release 帧数');
  const v0 = voiceById(tl, 0);
  eq(440 * Math.pow(2, (v0.key - 69) / 12), ref.a4_frequency_hz, 'A4 频率');
}

// ---- zero-envelope ----
{
  const proj = load('zero-envelope.json');
  const ref = load('reference/zero-envelope.json');
  const { tl, render } = run(proj);
  console.log('zero-envelope');
  eq(tl.totalFrames, ref.total_frames, 'total_frames');
  eq(voiceById(tl, 0).endFrame, ref.id0_end_frame, 'id0 end_frame');
  eq(render.samples[0], ref.first_sample, '首采样');
  let silent = true;
  for (let n = ref.silent_from_frame; n < render.samples.length; n++) {
    if (render.samples[n] !== 0) { silent = false; break; }
  }
  ok(silent, `${ref.silent_from_frame} 帧后全为 0`);
  let maxErr = 0;
  for (let n = 0; n < ref.silent_from_frame; n++) {
    const expect = 0.15 * (100 / 127) * Math.sin((2 * Math.PI * 440 * n) / 48000);
    maxErr = Math.max(maxErr, Math.abs(render.samples[n] - expect));
  }
  ok(maxErr < 1e-6, `正弦公式误差 ${maxErr} < 1e-6（Float32 存储精度内）`);
}

// ---- 非法输入 ----
for (const name of ['invalid-end-tick.json', 'invalid-tempo.json', 'invalid-channel.json']) {
  const proj = load(name);
  const tl = engine.computeTimeline(proj, proj.params);
  console.log(name);
  ok(tl.errors && tl.errors.length > 0, `应报校验错误（实际: ${JSON.stringify(tl.errors)}）`);
}

// ---- 导出与报告健全性 ----
{
  const proj = load('stolen-fifo.json');
  const { tl, render, report } = run(proj);
  console.log('export/report');
  const wav = engine.encodeWav24(render.samples);
  eq(wav.byteLength, 44 + tl.totalFrames * 3, 'WAV 长度 = 44 + 帧数*3');
  const b = new Uint8Array(wav);
  eq(String.fromCharCode(b[0], b[1], b[2], b[3]), 'RIFF', 'WAV RIFF 头');
  eq(b[22], 1, '单声道');
  eq(b[24] | (b[25] << 8), 48000 & 0xffff, '采样率 48000');
  eq(b[34], 24, '24 位');
  ok(report.voices.every((v) => v.end_frame !== null && v.reason !== null), '每个声部都有 end_frame 与 reason');
  ok(typeof report.clipped_samples === 'number', '削波计数存在');
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
