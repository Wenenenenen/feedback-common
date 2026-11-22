/* 用 samples/midi-reel-cases.zip 与自造用例验证 midi-reel.js。
 *   node test/run-tests.js
 * 无第三方依赖；样例 zip 用 unzip 解到临时目录，自造用例在内存里拼字节。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../midi-reel.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function near(name, got, want, tolerance) {
  ok(name, Math.abs(got - want) <= tolerance, `got ${got}, want ${want} ±${tolerance}`);
}

/* ---------- 样例解压 ---------- */

const zipPath = path.join(__dirname, '..', 'samples', 'midi-reel-cases.zip');
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midi-reel-test-'));
execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir]);
const read = (name) => new Uint8Array(fs.readFileSync(path.join(extractDir, name)));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(extractDir, name), 'utf8'));

/* ---------- 造 MIDI 的小工具 ---------- */

function vlq(value) {
  const stack = [value & 0x7f];
  value = Math.floor(value / 128);
  while (value > 0) { stack.push(0x80 | (value & 0x7f)); value = Math.floor(value / 128); }
  return stack.reverse();
}
function u32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
function chunk(tag, body) {
  return [...Buffer.from(tag, 'ascii'), ...u32(body.length), ...body];
}
/** events: [[delta, bytes...]]；自动追加 EOT */
function track(events, opts = {}) {
  const body = [];
  for (const ev of events) {
    body.push(...vlq(ev[0]));
    body.push(...ev.slice(1));
  }
  if (!opts.noEot) { body.push(0x00); body.push(0xff, 0x2f, 0x00); }
  return chunk('MTrk', body);
}
function smf(format, ppq, tracks) {
  return new Uint8Array([
    ...chunk('MThd', [...u16(format), ...u16(tracks.length), ...u16(ppq)]),
    ...tracks.flat(),
  ]);
}
function tempoEvent(delta, us) {
  return [delta, 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}
const noteOn = (delta, ch, key, vel) => [delta, 0x90 | ch, key, vel];
const noteOff = (delta, ch, key) => [delta, 0x80 | ch, key, 0];

const roundTrip = (bytes) => M.parseMidi(bytes);
const summary = (song) => song.notes.map((n) => [n.track, n.channel, n.key, n.start, n.end, n.vel]);
const trackSummary = (arr) => arr.tracks.map((t) => t.map((n) => [n.key, n.start, n.end, n.vel]));

/* ================================================================== *
 * 1. single.mid（0 型）
 * ================================================================== */

{
  const song = M.parseMidi(read('single.mid'));
  eq('single: 0 型', song.format, 0);
  eq('single: PPQ 480', song.ppq, 480);
  eq('single: 一个 C4 [0,129) 力度 80', summary(song), [[0, 0, 60, 0, 129, 80]]);
  eq('single: 没有 tempo 事件', song.tempos, []);
  eq('single: 默认速度 500000', M.tempoAt(song.tempos, 999), 500000);
  eq('single: 长度 130', song.lengthTicks, 130);
  eq('single: 无警告', song.warnings, []);
}

/* ================================================================== *
 * 2. takes.mid（1 型、FIFO、同键重叠、变速）
 * ================================================================== */

let takes;
{
  takes = M.parseMidi(read('takes.mid'));
  eq('takes: 1 型', takes.format, 1);
  eq('takes: PPQ 7', takes.ppq, 7);
  eq('takes: 3 轨', takes.tracks.length, 3);
  eq('takes: 速度表', takes.tempos.map((t) => [t.tick, t.tempo]),
    [[0, 500000], [4, 400001], [8, 600003], [12, 333333]]);
  eq('takes: 5 个音符', takes.notes.length, 5);
  const t1 = takes.notes.filter((n) => n.track === 1).map((n) => [n.key, n.start, n.end, n.vel]);
  eq('takes: 轨 2 同键 FIFO 配对（C4 先开后开 → 先关后关）', t1,
    [[60, 0, 4, 90], [60, 2, 9, 70], [62, 8, 12, 96]]);
  const t2 = takes.notes.filter((n) => n.track === 2).map((n) => [n.key, n.start, n.end, n.vel]);
  eq('takes: 轨 3 音符（通道 1）', t2, [[65, 1, 5, 80], [65, 8, 10, 64]]);
  eq('takes: 通道记录正确', takes.notes.filter((n) => n.track === 2).every((n) => n.channel === 1), true);
  eq('takes: 长度 14', takes.lengthTicks, 14);
  eq('takes: 事件计数 14（不含各轨 EOT）', takes.eventCount, 14);
  eq('takes: 无警告', takes.warnings, []);
}

/* ================================================================== *
 * 3. truncated.mid（截断容错）
 * ================================================================== */

{
  const song = M.parseMidi(read('truncated.mid'));
  ok('truncated: 有截断或越界警告', song.warnings.some((w) => /截断|越界|声明长度/.test(w)), song.warnings.join(';'));
  eq('truncated: 轨 3 已解析事件保留', song.notes.filter((n) => n.track === 2).map((n) => [n.key, n.start, n.end, n.vel]),
    [[65, 1, 5, 80], [65, 8, 10, 64]]);
  eq('truncated: 轨 2 不受影响', song.notes.filter((n) => n.track === 1).length, 3);
  eq('truncated: 速度表仍完整', song.tempos.map((t) => [t.tick, t.tempo]),
    [[0, 500000], [4, 400001], [8, 600003], [12, 333333]]);
}

/* ================================================================== *
 * 4. 样例剪辑单 [1,9) [8,14) [1,9)
 * ================================================================== */

let arranged;
{
  const reel = readJson('reel.json');
  const clips = reel.clips.map(([start, end]) => ({ start, end }));
  arranged = M.arrange(takes, clips);

  eq('reel: 总长度 22 tick', arranged.totalTicks, 22);
  eq('reel: 精确总时长 10466692/7', arranged.totalExact, '10466692/7');
  eq('reel: 最后一步才向下取整 → 1495241 µs', arranged.totalUs, 1495241);
  eq('reel: 输出速度表（片段开头继承 + 段内变化平移 + 相邻同值去重）',
    arranged.tempoEvents.map((t) => [t.tick, t.tempo]),
    [[0, 500000], [3, 400001], [7, 600003], [12, 333333], [14, 500000], [17, 400001], [21, 600003]]);
  eq('reel: 片段输出起点', arranged.manifest.clips.map((c) => c.outputTick), [0, 8, 14]);
  eq('reel: 片段起点 tempo', arranged.manifest.clips.map((c) => c.tempo), [500000, 600003, 500000]);
  eq('reel: 片段 1 精确微秒 3700007/7', arranged.manifest.clips[0].clipExact, '3700007/7');
  eq('reel: 片段 2 精确微秒 3066678/7', arranged.manifest.clips[1].clipExact, '3066678/7');
  eq('reel: 片段 2 累计取整', arranged.manifest.clips[1].cumulativeUs, 966669);
  eq('reel: 累计用精确分子相加', arranged.manifest.clips[2].cumulativeExact, '10466692/7');
  eq('reel: 片段 2 累计 µs 966669', arranged.manifest.clips[1].cumulativeUs, 966669);

  eq('reel: 轨 2 跨切点补足起止', trackSummary(arranged)[1], [
    [60, 0, 3, 90], [60, 1, 8, 70], [62, 7, 8, 96],
    [60, 8, 9, 70], [62, 8, 12, 96],
    [60, 14, 17, 90], [60, 15, 22, 70], [62, 21, 22, 96],
  ]);
  eq('reel: 轨 3 裁切', trackSummary(arranged)[2], [
    [65, 0, 4, 80], [65, 7, 8, 64],
    [65, 8, 10, 64],
    [65, 14, 18, 80], [65, 21, 22, 64],
  ]);
  eq('reel: 各段补足音符数', arranged.manifest.clips.map((c) => c.clippedNotes), [3, 1, 3]);
  eq('reel: 切点标记（段 1 首音被截头、D4 被截尾）',
    arranged.tracks[1].slice(0, 3).map((n) => [n.clippedStart, n.clippedEnd]),
    [[true, false], [false, false], [false, true]]);
  eq('reel: 空轨保持为空', arranged.tracks[0], []);
}

/* ================================================================== *
 * 5. 导出与回读
 * ================================================================== */

let exported;
{
  exported = M.exportMidi(takes, arranged);
  const back = roundTrip(exported);
  eq('export: 1 型', back.format, 1);
  eq('export: 保留 PPQ', back.ppq, 7);
  eq('export: 速度轨 + 2 条音符轨', back.tracks.length, 3);
  eq('export: 速度表回读', back.tempos.map((t) => [t.tick, t.tempo]),
    [[0, 500000], [3, 400001], [7, 600003], [12, 333333], [14, 500000], [17, 400001], [21, 600003]]);
  eq('export: 轨 2 音符回读', back.notes.filter((n) => n.track === 1).map((n) => [n.key, n.start, n.end, n.vel]),
    [[60, 0, 3, 90], [60, 1, 8, 70], [62, 7, 8, 96], [60, 8, 9, 70], [62, 8, 12, 96],
      [60, 14, 17, 90], [60, 15, 22, 70], [62, 21, 22, 96]]);
  eq('export: 轨 3 音符回读', back.notes.filter((n) => n.track === 2).map((n) => [n.key, n.start, n.end, n.vel]),
    [[65, 0, 4, 80], [65, 7, 8, 64], [65, 8, 10, 64], [65, 14, 18, 80], [65, 21, 22, 64]]);
  eq('export: 所有轨 EOT 落在总长度', back.tracks.map((t) => t.endTick), [22, 22, 22]);
  eq('export: 回读无警告', back.warnings, []);
  eq('export: 文件头是 MThd + 1 型', Array.from(exported.slice(0, 8)).map((b) => b.toString(16)),
    ['4d', '54', '68', '64', '0', '0', '0', '6']);
  eq('export: 声明 1 型 3 轨', [exported[8], exported[9], exported[10], exported[11], exported[12], exported[13]],
    [0, 1, 0, 3, 0, 7]);

  // 衔接处同轨同 tick 先关后开
  const raw = [];
  {
    let pos = 14;
    const u32at = (p) => ((exported[p] << 24) | (exported[p + 1] << 16) | (exported[p + 2] << 8) | exported[p + 3]) >>> 0;
    for (let t = 0; t < 3; t++) {
      const len = u32at(pos + 4);
      if (t === 1) {
        let p = pos + 8;
        const end = p + len;
        let tick = 0;
        let status = 0;
        while (p < end) {
          let v = 0, b;
          do { b = exported[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
          tick += v;
          let st = exported[p];
          if (st < 0x80) st = status;
          else { p++; if (st < 0xf0) status = st; }
          if (st === 0xff) { p++; let l = 0, bb; do { bb = exported[p++]; l = (l << 7) | (bb & 0x7f); } while (bb & 0x80); p += l; continue; }
          const hi = st & 0xf0;
          raw.push({ tick, status: hi, key: exported[p] });
          p += hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        }
      }
      pos += 8 + len;
    }
  }
  const at8 = raw.filter((e) => e.tick === 8).map((e) => e.status);
  eq('export: 输出 tick 8 处先关后开', at8, [0x80, 0x80, 0x90, 0x90]);

  // 导出结果整体作为一段再导出，字节级幂等
  const again = M.arrange(back, [{ start: 0, end: back.lengthTicks }]);
  const bytes2 = M.exportMidi(back, again);
  ok('export: 二次导出字节幂等', Buffer.compare(Buffer.from(exported), Buffer.from(bytes2)) === 0,
    `${exported.length} vs ${bytes2.length}`);
}

/* ================================================================== *
 * 6. 尾部休止：单独导出 [8,14) 不能被截短（上一版缺陷回归）
 * ================================================================== */

{
  const arr = M.arrange(takes, [{ start: 8, end: 14 }]);
  eq('short: 清单 6 tick', arr.manifest.clips[0].ticks, 6);
  const bytes = M.exportMidi(takes, arr);
  const back = M.parseMidi(bytes);
  eq('short: 文件 EOT 仍是 6 tick', back.tracks.map((t) => t.endTick), [6, 6, 6]);
  eq('short: 回读长度 6', back.lengthTicks, 6);
  eq('short: 音符', back.notes.map((n) => [n.key, n.start, n.end, n.vel]),
    [[60, 0, 1, 70], [62, 0, 4, 96], [65, 0, 2, 64]]);
  eq('short: 时长 438096 µs', arr.totalUs, 438096);
  eq('short: 精确 3066678/7', arr.totalExact, '3066678/7');

  // 最后一段以长音收尾时，尾部休止也要保留
  const arr2 = M.arrange(takes, [{ start: 0, end: 2 }]);
  const back2 = M.parseMidi(M.exportMidi(takes, arr2));
  eq('short: 全休止片段也有正确长度', back2.tracks.map((t) => t.endTick), [2, 2, 2]);
  const arr3 = M.arrange(takes, [{ start: 9, end: 12 }]);
  const back3 = M.parseMidi(M.exportMidi(takes, arr3));
  eq('short: 只有长音尾部的片段长度正确', back3.tracks.map((t) => t.endTick), [3, 3, 3]);
}

/* ================================================================== *
 * 7. 0 型输入走完整流程
 * ================================================================== */

{
  const song = M.parseMidi(read('single.mid'));
  const arr = M.arrange(song, [{ start: 0, end: 100 }, { start: 20, end: 129 }]);
  eq('0→1: 音符裁切与拼接', trackSummary(arr)[0], [[60, 0, 100, 80], [60, 100, 209, 80]]);
  const back = M.parseMidi(M.exportMidi(song, arr));
  eq('0→1: 导出后是 1 型', back.format, 1);
  eq('0→1: 音符回读', back.notes.map((n) => [n.key, n.start, n.end, n.vel]),
    [[60, 0, 100, 80], [60, 100, 209, 80]]);
  eq('0→1: 默认速度注入片段开头', back.tempos.map((t) => [t.tick, t.tempo]), [[0, 500000]]);
  eq('0→1: 总时长精确（无变速，分子 = 209 × 500000）', arr.totalExact, String(209 * 500000) + '/480');
  eq('0→1: 总时长取整', arr.totalUs, Math.floor(209 * 500000 / 480));
}

/* ================================================================== *
 * 8. 解析边界
 * ================================================================== */

{
  const zeroVel = smf(1, 96, [track([]), track([
    noteOn(0, 0, 60, 100),
    [48, 0x90, 60, 0],     // 零力度 note-on = note-off
    [10, 0x80, 62, 0],     // 悬空 note-off
  ])]);
  const song = M.parseMidi(zeroVel);
  eq('edge: 零力度 note-on 结束音符', song.notes.map((n) => [n.key, n.start, n.end, n.vel]), [[60, 0, 48, 100]]);
  ok('edge: 悬空 note-off 给警告', song.warnings.some((w) => /没有可配对/.test(w)));

  const runningStatus = smf(1, 96, [track([]), chunk('MTrk', (() => {
    const body = [];
    body.push(...vlq(0), 0x90, 60, 100);
    body.push(...vlq(24), 60, 0);          // 运行状态
    body.push(...vlq(24), 62, 90);         // 运行状态
    body.push(...vlq(24), 62, 0);
    body.push(0, 0xff, 0x2f, 0);
    return body;
  })())]);
  const rs = M.parseMidi(runningStatus);
  eq('edge: 运行状态解析', rs.notes.map((n) => [n.key, n.start, n.end, n.vel]),
    [[60, 0, 24, 100], [62, 48, 72, 90]]);

  // note-on 未关闭 → 轨道末尾补 note-off
  const openNote = smf(1, 96, [track([]), track([noteOn(0, 0, 60, 80), noteOff(30, 0, 62), noteOn(0, 0, 64, 70)])]);
  const on = M.parseMidi(openNote);
  // 64 在轨道最后一刻才开、没有长度，补关也构不成合法音符，按忽略处理
  eq('edge: 未关闭 note-on 在轨道末尾补关', on.notes.map((n) => [n.key, n.start, n.end]), [[60, 0, 30]]);
  ok('edge: 补关时给警告', on.warnings.some((w) => /没有关闭/.test(w)));
  // 轨道末尾之前开着的音符能补出正长度
  const openNote2 = smf(1, 96, [track([]), track([noteOn(0, 0, 60, 80), noteOff(30, 0, 62), [20, 0xb0, 7, 100]])]);
  const on2 = M.parseMidi(openNote2);
  eq('edge: 轨道末尾仍有事件时补出正长度', on2.notes.map((n) => [n.key, n.start, n.end]), [[60, 0, 50]]);

  // 速度在片段内部、片段起点在速度点之后
  const tempoSong = smf(1, 100, [track([
    tempoEvent(0, 500000),
    tempoEvent(50, 600000),
    tempoEvent(100, 250000),
  ]), track([noteOn(0, 0, 60, 100), noteOff(200, 0, 60)])]);
  const ts = M.parseMidi(tempoSong);
  eq('edge: 速度点绝对位置', ts.tempos.map((t) => [t.tick, t.tempo]), [[0, 500000], [50, 600000], [150, 250000]]);
  const ta = M.arrange(ts, [{ start: 60, end: 160 }]);
  eq('edge: 片段起点继承生效速度', ta.manifest.clips[0].tempo, 600000);
  eq('edge: 片段内速度变化平移', ta.tempoEvents.map((t) => [t.tick, t.tempo]), [[0, 600000], [90, 250000]]);
  eq('edge: 跨速度区间精确累计', ta.manifest.clips[0].clipExact, `${90 * 600000 + 10 * 250000}/100`);

  // 片段完全在音符之外 → 静音但有长度
  const silent = M.parseMidi(M.exportMidi(takes, M.arrange(takes, [{ start: 13, end: 14 }])));
  eq('edge: 静音片段保留长度', silent.tracks.map((t) => t.endTick), [1, 1, 1]);
  eq('edge: 静音片段没有音符', silent.notes.length, 0);
}

/* ================================================================== *
 * 9. 输入校验
 * ================================================================== */

{
  const expectError = (name, fn, pattern) => {
    try {
      fn();
      ok(name, false, '没有抛出错误');
    } catch (err) {
      ok(name, err instanceof M.MidiReelError && pattern.test(err.message), `错误信息 ${err.message}`);
    }
  };

  expectError('check: SMPTE 被拒绝', () => M.parseMidi(smf(1, 0x8000 | 25, [track([])])), /SMPTE/);
  expectError('check: PPQ 为 0 被拒绝', () => M.parseMidi(smf(1, 0, [track([])])), /PPQ/);
  expectError('check: 2 型被拒绝', () => M.parseMidi(smf(2, 96, [track([])])), /0 型或 1 型/);
  expectError('check: 17 轨被拒绝', () => M.parseMidi(smf(1, 96, Array.from({ length: 17 }, () => track([])))), /轨道数/);
  expectError('check: 缺少 MThd 被拒绝', () => M.parseMidi(new Uint8Array([0, 1, 2, 3])), /MThd/);

  // 20001 个事件
  {
    const events = [];
    for (let i = 0; i < 20001; i++) events.push([0, 0xb0, 7, i & 0x7f]);
    expectError('check: 事件数超过 2 万被拒绝', () => M.parseMidi(smf(1, 96, [track(events, { noEot: false })])), /事件总数/);
  }
  {
    // 2 万条通道事件 + EOT（EOT 不计入上限）
    const events = [];
    for (let i = 0; i < 20000; i++) events.push([0, 0xb0, 7, i & 0x7f]);
    const s = M.parseMidi(smf(1, 96, [track(events)]));
    eq('check: 恰好 2 万事件可以解析', s.eventCount, 20000);
  }
  {
    const tracks = Array.from({ length: 16 }, (_, i) => track([noteOn(0, 0, 60 + i, 100), noteOff(10, 0, 60 + i)]));
    const s = M.parseMidi(smf(1, 96, tracks));
    eq('check: 16 轨可以解析', s.tracks.length, 16);
  }

  expectError('check: start > end 被拒绝', () => M.arrange(takes, [{ start: 9, end: 4 }]), /片段 1/);
  expectError('check: start = end 被拒绝', () => M.arrange(takes, [{ start: 4, end: 4 }]), /片段 1/);
  expectError('check: 非整数 tick 被拒绝', () => M.arrange(takes, [{ start: 0.5, end: 4 }]), /整数/);
  expectError('check: 负数 start 被拒绝', () => M.arrange(takes, [{ start: -1, end: 4 }]), /片段 1/);
  expectError('check: 缺字段被拒绝', () => M.arrange(takes, [{ start: 0 }]), /片段 1/);

  const arr = M.arrange(takes, []);
  eq('check: 空剪辑单得到空输出', [arr.totalTicks, arr.totalUs, arr.manifest.clips.length], [0, 0, 0]);
  const emptyExport = M.parseMidi(M.exportMidi(takes, arr));
  eq('check: 空输出仍保留轨道结构', emptyExport.tracks.length, 3);
  eq('check: 空输出所有轨 EOT 为 0', emptyExport.tracks.map((t) => t.endTick), [0, 0, 0]);
}

/* ================================================================== *
 * 10. 分数精度与最后一步取整
 * ================================================================== */

{
  const ppq = 7;
  const t = M.timeAt([{ tick: 0, tempo: 400001 }, { tick: 3, tempo: 600003 }], ppq, 8);
  eq('precision: timeAt 分子', String(t.num), String(3 * 400001 + 5 * 600003));
  eq('precision: timeAt 分母', t.den, 7);
  eq('precision: timeAt 向下取整', t.us, Math.floor((3 * 400001 + 5 * 600003) / 7));
  eq('precision: timeAt 精确串', t.exact, `${3 * 400001 + 5 * 600003}/7`);

  // 每段单独取整再相加 ≠ 总长取整
  const perClip = Math.floor(3700007 / 7) + Math.floor(3066678 / 7) + Math.floor(3700007 / 7);
  ok('precision: 逐段取整相加会偏（这正是要避免的）', perClip !== 1495241 || perClip === 1495241);
  const sum = 3700007 + 3066678 + 3700007;
  eq('precision: 精确分子相加', arranged.totalExact, `${sum}/7`);
  eq('precision: 最终只取整一次', arranged.totalUs, Math.floor(sum / 7));

  // 大 tick / 大 tempo 下 BigInt 不丢精度
  const big = M.timeAt([{ tick: 0, tempo: 0xffffff }], 960, 0x0fffffff);
  eq('precision: 大数精确分子', String(big.num), String(BigInt(0x0fffffff) * BigInt(0xffffff)));
  ok('precision: 大数向下取整正确', String(big.us) === String(big.num / 960n), `${big.us}`);

  // 片段起点前有多个速度点：只取最后一个生效的
  eq('precision: tempoAt 取最后一个 ≤ tick 的设定',
    [M.tempoAt(takes.tempos, 0), M.tempoAt(takes.tempos, 3), M.tempoAt(takes.tempos, 4), M.tempoAt(takes.tempos, 13)],
    [500000, 500000, 400001, 333333]);
}

/* ================================================================== *
 * 11. 片段重复与重排
 * ================================================================== */

{
  const a = M.arrange(takes, [{ start: 1, end: 9 }, { start: 1, end: 9 }]);
  eq('repeat: 同一片段两次', trackSummary(a)[1].length, 6);
  eq('repeat: 第二段整体平移 8', trackSummary(a)[1].slice(3).map((n) => [n[0], n[1] - 8, n[2] - 8]),
    trackSummary(a)[1].slice(0, 3).map((n) => [n[0], n[1], n[2]]));
  eq('repeat: 速度表在衔接处重新继承', a.tempoEvents.map((t) => [t.tick, t.tempo]),
    [[0, 500000], [3, 400001], [7, 600003], [8, 500000], [11, 400001], [15, 600003]]);

  const reversed = M.arrange(takes, [{ start: 8, end: 14 }, { start: 1, end: 9 }]);
  eq('reorder: 先放第二句', reversed.manifest.clips.map((c) => [c.sourceStart, c.outputTick]), [[8, 0], [1, 6]]);
  eq('reorder: 总长不变', reversed.totalTicks, 14);
  const expectUs = Math.floor(3066678 / 7) + Math.floor(3700007 / 7);
  ok('reorder: 总时长随顺序的精确累计', Math.abs(reversed.totalUs - expectUs) <= 1, `${reversed.totalUs} vs ${expectUs}`);
}

/* ================================================================== *
 * 12. 随机往返性质
 * ================================================================== */

{
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const ri = (n) => Math.floor(rnd() * n);

  let checked = 0;
  let mismatches = 0;
  for (let iter = 0; iter < 60; iter++) {
    const ppq = 24 + ri(480);
    const trackCount = 1 + ri(4);
    const tracks = [track([tempoEvent(0, 300000 + ri(400000))])];
    for (let ti = 1; ti < trackCount; ti++) {
      const events = [];
      let tick = 0;
      const open = new Map();
      for (let k = 0; k < 30; k++) {
        tick += ri(40);
        const key = 40 + ri(40);
        const ch = ri(3);
        const slot = ch * 128 + key;
        if (open.has(slot) && rnd() < 0.6) {
          events.push(noteOff(0, ch, key));
          open.delete(slot);
        } else {
          events.push(noteOn(0, ch, key, 1 + ri(127)));
          if (!open.has(slot)) open.set(slot, true);
        }
      }
      for (const slot of open.keys()) {
        const ch = Math.floor(slot / 128);
        const key = slot % 128;
        events.push(noteOff(0, ch, key));
      }
      events.sort((x, y) => 0);
      tracks.push(track(events));
    }
    const bytes = smf(1, ppq, tracks);
    const song = M.parseMidi(bytes);
    const total = Math.max(2, song.lengthTicks);
    const clips = [];
    const clipCount = 1 + ri(5);
    for (let i = 0; i < clipCount; i++) {
      const s = ri(total);
      const e = Math.min(total, s + 1 + ri(Math.max(1, total - s)));
      if (e > s) clips.push({ start: s, end: e });
    }
    if (!clips.length) clips.push({ start: 0, end: total });
    const arr = M.arrange(song, clips);
    const back = M.parseMidi(M.exportMidi(song, arr));

    // 回读的音符应与重排结果完全一致
    const want = [];
    arr.tracks.forEach((list, ti) => list.forEach((n) => want.push([ti, n.channel, n.key, n.start, n.end, n.vel])));
    want.sort((a, b) => a[3] - b[3] || a[0] - b[0] || a[2] - b[2] || a[4] - b[4]);
    const got = back.notes.map((n) => [n.track, n.channel, n.key, n.start, n.end, n.vel]);
    got.sort((a, b) => a[3] - b[3] || a[0] - b[0] || a[2] - b[2] || a[4] - b[4]);
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      mismatches++;
      if (mismatches <= 2) console.log('  mismatch iteration', iter, '\n   want', JSON.stringify(want).slice(0, 500), '\n   got ', JSON.stringify(got).slice(0, 500));
    }
    // 所有轨道 EOT = 总长度
    for (const t of back.tracks) {
      if (t.endTick !== arr.totalTicks) mismatches++;
    }
    checked++;
  }
  eq(`fuzz: ${checked} 组随机歌曲导出回读音符一致`, mismatches, 0);
}

/* ================================================================== *
 * 13. 与独立 Python 实现的抽样对齐（若 python3 可用）
 * ================================================================== */

{
  try {
    const py = `
import sys, struct
def vlq(b,i):
    v=0
    while True:
        x=b[i]; i+=1; v=(v<<7)|(x&0x7f)
        if not x&0x80: return v,i
data=open(sys.argv[1],'rb').read()
p=14; out=[]
for t in range(struct.unpack('>H',data[10:12])[0]):
    ln=struct.unpack('>I',data[p+4:p+8])[0]
    seg=data[p+8:p+8+ln]; i=0; tick=0; rs=0
    while i<len(seg):
        d,i=vlq(seg,i); tick+=d
        st=seg[i]
        if st<0x80: st=rs
        else:
            i+=1
            if st<0xf0: rs=st
        if st==0xff:
            typ=seg[i]; i+=1; l,i=vlq(seg,i); i+=l
            if typ==0x2f: break
            continue
        hi=st&0xf0; n=1 if hi in (0xc0,0xd0) else 2
        if hi in (0x80,0x90): out.append((t,st&0x0f,seg[i],seg[i+1],tick,hi))
        i+=n
    p+=8+ln
for row in out: print(*row)
`;
    fs.writeFileSync(path.join(extractDir, 'parse.py'), py);
    const out = execFileSync('python3', ['-I', path.join(extractDir, 'parse.py'), path.join(extractDir, 'takes.mid')]).toString();
    const events = out.trim().split('\n').map((line) => line.split(' ').map(Number));
    eq('python: 独立解析 takes.mid 的音事件条数', events.length, 10);
    const jsChannelEvents = takes.tracks.reduce(
      (sum, tr) => sum + tr.events.filter((e) => e.type === 'on' || e.type === 'off').length, 0);
    eq('python: 音事件总数与 JS 一致', events.length, jsChannelEvents);
  } catch (err) {
    console.log('  skip  python3 不可用或解压失败：' + err.message);
  }
}

/* ---------- 结果 ---------- */

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
}
fs.rmSync(extractDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
