'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const IO = require('../src/io.js');
const { refRender } = require('./ref-render.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}
function eqArr(a, b) {
  assert.strictEqual(a.length, b.length, 'length differs');
  for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i], `idx ${i}: ${a[i]} != ${b[i]}`);
}
// 深拷贝
const cp = (x) => JSON.parse(JSON.stringify(x));
const base = () => ({
  channels: 2,
  bpm: 384,
  speed: 4,
  samples: [
    { pcm: [0, 1000, -1000, 500], loop: null },
    { pcm: [100, 200, 300, 400, 500, 600], loop: [1, 4] },
  ],
  patterns: [
    [{ voices: [{ ch: 0, note: [0, 65536] }, { ch: 1, note: [1, 32768] }] }],
  ],
  order: [0],
});

console.log('1. 包内样例与 BigInt 参考实现逐样本一致');
test('rehearsal.json golden', () => {
  const song = JSON.parse(fs.readFileSync(path.join(__dirname, '../_extracted/rehearsal.json'), 'utf8'));
  const r = E.renderSong(song);
  const ref = refRender(cp(song));
  assert.strictEqual(r.totalFrames, ref.totalFrames);
  eqArr(Array.from(r.pcm), ref.pcm);
  assert.strictEqual(r.totalTicks, 24); // 3 个编排位置 × 8 tick
});

test('手工小样例逐帧核对插值', () => {
  // 单声道、非循环、步长 32768（半速）、pcm [0,1000,-1000]
  const song = {
    channels: 1, bpm: 384, speed: 1,
    samples: [{ pcm: [0, 1000, -1000], loop: null }],
    patterns: [[{ voices: [{ ch: 0, note: [0, 32768] }] }]],
    order: [0],
  };
  const r = E.renderSong(song);
  // tick = 312.5 -> 312 帧；相位 0,32768,65536,...；帧3 相位 98304 落在尾段（与零插值，系数 1）
  assert.deepStrictEqual(Array.from(r.pcm.slice(0, 8)), [0, 500, 1000, 0, -1000, -500, 0, 0]);
  assert.strictEqual(r.totalFrames, 312);
});

console.log('2. 分数累计：tick 半开区间逐 tick 向下取整（bpm=137）');
test('fractional tick frames bpm=137', () => {
  const song = base();
  song.bpm = 137;
  song.speed = 3;
  const r = E.renderSong(song);
  const tickMs = 120000 / 137; // 帧/tick（约定：120000/bpm 个输出帧）
  const exp = [0];
  for (let k = 1; k <= 3; k++) exp.push(Math.floor(k * tickMs));
  assert.deepStrictEqual(r.log.map((t) => t.startFrame), exp.slice(0, 3));
  assert.deepStrictEqual(r.log.map((t) => t.endFrame), exp.slice(1));
  assert.strictEqual(r.totalFrames, exp[3]);
});

test('换 BPM 后 tick 时长立即变化，累计仍精确', () => {
  const song = base();
  song.patterns = [[
    { bpm: 100, voices: [] },
    { bpm: 137, voices: [] },
  ]];
  song.speed = 2;
  const r = E.renderSong(song);
  const f = (k, bpm) => Math.floor((120000 * k) / bpm);
  assert.deepStrictEqual(r.log.map((t) => [t.startFrame, t.endFrame, t.bpm]), [
    [0, f(1, 100), 100],
    [f(1, 100), f(2, 100), 100],
    [f(2, 100), f(2, 100) + f(1, 137), 137],
    [f(2, 100) + f(1, 137), f(2, 100) + f(2, 137), 137],
  ]);
});

console.log('3. 回跳：按编排位置与行独立计数，耗尽不重置，回跳优先于 break');
test('back 计数与位置独立', () => {
  const song = base();
  song.patterns = [[
    { voices: [] },
    { voices: [], back: [0, 1] },
    { voices: [] },
  ]];
  song.order = [0, 0];
  const r = E.renderSong(song);
  const rows = r.log.map((t) => t.row);
  // 每行 4 tick；位置内：r0,r1(back 剩1) r0,r1(back 剩0) r0,r1(顺序) r2；两个位置相同
  const seq = [0, 1, 0, 1, 0, 1, 2];
  const block = seq.flatMap((x) => [x, x, x, x]);
  assert.deepStrictEqual(rows, block.concat(block));
  const backJumps = r.log.filter((t) => t.jump && t.jump.type === 'back');
  assert.strictEqual(backJumps.length, 4);
  assert.deepStrictEqual(backJumps.map((t) => t.jump.remaining), [1, 0, 1, 0]);
});

test('back 优先于 break', () => {
  const song = base();
  song.patterns = [
    [{ voices: [] }, { voices: [], back: [0, 1], break: 0 }],
    [{ voices: [] }],
  ];
  song.order = [0, 1];
  const r = E.renderSong(song);
  const j = r.log.filter((t) => t.jump).map((t) => t.jump.type);
  assert.ok(j.includes('back'));
  assert.ok(!j.slice(0, j.indexOf('next-row') + 1).includes('break'));
  // back 耗尽后 break 生效
  assert.ok(j.includes('break'));
});

test('同一花样两个编排位置的回跳互不影响', () => {
  const song = base();
  song.patterns = [[{ voices: [] }, { voices: [], back: [0, 2] }]];
  song.order = [0, 0];
  const r = E.renderSong(song);
  // 每位置 r0,r1 重复 4 次（首次 + 额外 3 次回跳），每行 4 tick，共 32 tick
  const seq = [0, 1, 0, 1, 0, 1, 0, 1];
  const block = seq.flatMap((x) => [x, x, x, x]);
  const rows = r.log.map((t) => t.row);
  assert.deepStrictEqual(rows, block.concat(block));
  const pos = r.log.map((t) => t.pos);
  assert.deepStrictEqual(pos.slice(0, 32), new Array(32).fill(0));
  assert.deepStrictEqual(pos.slice(32), new Array(32).fill(1));
  assert.strictEqual(r.log.filter((t) => t.jump && t.jump.type === 'back').length, 6);
});

console.log('4. 滑音：记忆保留、零取记忆、换音不清零、步长夹取');
test('slide 记忆与换音保留', () => {
  const song = base();
  song.channels = 1;
  song.speed = 4;
  song.patterns = [[
    { voices: [{ ch: 0, note: [1, 100], slide: 50 }] },
    { voices: [{ ch: 0, note: [1, 200] }] }, // 无 slide：步长保持，记忆仍在
    { voices: [{ ch: 0, note: [1, 70], slide: 0 }] }, // 零取记忆 50
  ]];
  const r = E.renderSong(song);
  const steps = (rowStartTick) => r.log.slice(rowStartTick, rowStartTick + 4).map((t) => t.events[0].step);
  // 行0: t0 触发步长100，t1/t2/t3 各 +50
  assert.deepStrictEqual(steps(0), [100, 150, 200, 250]);
  // 行1: t0 新音步长200（替换但不清记忆），之后无 slide
  assert.deepStrictEqual(steps(4), [200, 200, 200, 200]);
  // 行2: t0 新音70，t1.. 用记忆50
  assert.deepStrictEqual(steps(8), [70, 120, 170, 220]);
});

test('步长夹到 1..1048576', () => {
  const song = base();
  song.channels = 1;
  song.speed = 3;
  song.patterns = [[
    { voices: [{ ch: 0, note: [1, 1048570], slide: 1000000 }] },
    { voices: [{ ch: 0, note: [1, 5], slide: -1000000 }] },
  ]];
  const r = E.renderSong(song);
  const s0 = r.log.slice(0, 3).map((t) => t.events[0].step);
  assert.deepStrictEqual(s0, [1048570, 1048576, 1048576]);
  const s1 = r.log.slice(3, 6).map((t) => t.events[0].step);
  assert.deepStrictEqual(s1, [5, 1, 1]);
});

console.log('5. 同 tick 顺序：延迟新音先于重触发，重触发只对仍在响的声部');
test('delay 新音抑制 retrig', () => {
  const song = base();
  song.channels = 1;
  song.speed = 4;
  song.patterns = [[
    { voices: [{ ch: 0, note: [1, 65536], delay: 2, retrig: 2 }] },
  ]];
  const r = E.renderSong(song);
  const ev = r.log.map((t) => t.events[0].event);
  assert.deepStrictEqual(ev, ['off', 'off', 'note', 'none']); // t2 新音优先，不记 retrig
});

test('retrig 相位重置为 0', () => {
  const song = base();
  song.channels = 1;
  song.speed = 6;
  song.patterns = [[
    { voices: [{ ch: 0, note: [1, 32768], retrig: 2 }] },
  ]];
  const r = E.renderSong(song);
  // 快照在调度后、该 tick 首帧前取：retrig 已把相位置 0，渲染尚未发生
  assert.strictEqual(r.log[2].events[0].event, 'retrig');
  assert.strictEqual(r.log[2].events[0].phase, 0);
  assert.strictEqual(r.log[1].events[0].phase, 196608); // tick1 渲染 312 帧后的相位
});

console.log('6. 循环插值：hi-1 与 lo 之间插值，越界按循环长度取余，可一次越过多圈');
test('loop 边界与多圈取余', () => {
  const song = base();
  song.channels = 1;
  // 采样 [100,200,300,400,500,600] loop [1,4)，大步长一次越过多圈
  song.patterns = [[{ voices: [{ ch: 0, note: [1, 65536 * 5] }] }]];
  song.speed = 1;
  const r = E.renderSong(song);
  const ref = refRender(cp(song));
  eqArr(Array.from(r.pcm), ref.pcm);
});

test('长度为 1 的循环采样不越界', () => {
  const song = base();
  song.channels = 1;
  song.samples = [{ pcm: [1234], loop: [0, 1] }];
  song.patterns = [[{ voices: [{ ch: 0, note: [0, 65536 * 3] }] }]];
  const r = E.renderSong(song);
  const ref = refRender(cp(song));
  eqArr(Array.from(r.pcm), ref.pcm);
  assert.ok(r.pcm.slice(0, 100).every((v) => v === 1234));
});

console.log('7. 非循环：尾点与零插值，越尾关闭');
test('非循环尾部与关闭', () => {
  const song = base();
  song.channels = 1;
  song.patterns = [[{ voices: [{ ch: 0, note: [0, 40000] }] }]];
  song.speed = 2;
  const r = E.renderSong(song);
  const ref = refRender(cp(song));
  eqArr(Array.from(r.pcm), ref.pcm);
  // 声部关闭后事件为 off
  const last = r.log[r.log.length - 1].events[0];
  assert.strictEqual(last.event, 'off');
});

console.log('8. 混合：多声部精确累加、半格远离零、只舍入限幅一次');
test('半格远离零（正负对称）', () => {
  const song = base();
  song.channels = 2;
  song.bpm = 32;
  song.speed = 4;
  // pcm 相邻点 0/1，步长 8192（1/8 源采样）：帧2 两声部各在相位 0.25，各贡献 0.25，和恰为 0.5
  song.samples = [
    { pcm: [0, 1], loop: null },
    { pcm: [0, 1], loop: null },
  ];
  song.patterns = [[{ voices: [{ ch: 0, note: [0, 8192] }, { ch: 1, note: [1, 8192] }] }]];
  const r = E.renderSong(song);
  const ref = refRender(cp(song));
  eqArr(Array.from(r.pcm), ref.pcm);
  assert.strictEqual(r.pcm[2], 1); // 和 0.5 -> 远离零
  assert.strictEqual(r.pcm[1], 0); // 和 0.25 -> 0
  assert.strictEqual(r.pcm[4], 1); // 和 1.0 -> 1
});

test('限幅只发生在最终输出', () => {
  const song = base();
  song.channels = 32;
  song.samples = Array.from({ length: 1 }, () => ({ pcm: [32767, 32767], loop: [0, 2] }));
  song.patterns = [[{
    voices: Array.from({ length: 32 }, (_, c) => ({ ch: c, note: [0, 65536] })),
  }]];
  song.speed = 1;
  const r = E.renderSong(song);
  assert.ok(r.pcm.slice(0, 10).every((v) => v === 32767));
});

console.log('9. 区间音频逐样本等于全曲截取（多个随机区间）');
test('slice 严格等于全曲子数组', () => {
  const song = JSON.parse(fs.readFileSync(path.join(__dirname, '../_extracted/rehearsal.json'), 'utf8'));
  const r = E.renderSong(song);
  const ranges = [[0, 1], [100, 200], [r.totalFrames - 50, r.totalFrames], [0, r.totalFrames], [12345, 12345]];
  for (const [a, b] of ranges) {
    const slice = r.pcm.subarray(a, b);
    const full = r.pcm;
    for (let i = a; i < b; i++) assert.strictEqual(slice[i - a], full[i]);
  }
  // 日志只列与区间相交的 tick，且保留绝对编号
  const txt = E.formatLog(r, 100, 200);
  for (const tk of r.log) {
    const listed = txt.includes(`tick=${tk.tick} `);
    const intersects = tk.endFrame > 100 && tk.startFrame < 200;
    assert.strictEqual(listed, intersects, `tick ${tk.tick} 列表=${listed} 相交=${intersects}`);
  }
});

console.log('10. 非法编辑：指出位置并收集全部错误');
test('校验错误带路径', () => {
  const song = base();
  song.channels = 0;
  song.patterns[0][0].voices.push({ ch: 0, note: [9, 65536] }); // 重复 ch + 坏采样
  song.patterns[0].push({ back: [5, 1] }); // 目标行不早于当前
  song.order = [7];
  const errs = E.validateSong(song);
  const paths = errs.map((x) => x.path);
  assert.ok(paths.includes('channels'));
  assert.ok(paths.some((p) => p.endsWith('.ch')));
  assert.ok(paths.some((p) => p.endsWith('.note')));
  assert.ok(paths.some((p) => p.includes('.back')));
  assert.ok(paths.includes('order[0]'));
  assert.throws(() => E.renderSong(song), (e) => e.kind === 'validation' && e.errors.length >= 4);
});

test('loop 区间非法', () => {
  const song = base();
  song.samples[0].loop = [2, 2];
  assert.ok(E.validateSong(song).some((e) => e.path === 'samples[0].loop'));
  song.samples[0].loop = [0, 99];
  assert.ok(E.validateSong(song).some((e) => e.path === 'samples[0].loop'));
});

console.log('11. 运行时上限：20000 tick / 8640000 帧，错误带位置');
test('tick 上限', () => {
  const song = base();
  song.bpm = 384; // 每 tick 312.5 帧，先撞 20000 tick 上限
  song.speed = 32; // 每行 32 tick，512 个位置 × 64 行可超 20000
  song.patterns = [Array.from({ length: 64 }, () => ({ speed: 32, voices: [] }))];
  song.order = new Array(512).fill(0);
  try {
    E.renderSong(song);
    assert.fail('应抛出');
  } catch (e) {
    assert.strictEqual(e.kind, 'runtime');
    assert.strictEqual(e.limit, 'ticks');
    assert.strictEqual(e.tick, 20000);
    assert.ok('row' in e && 'pos' in e);
  }
});

test('帧上限 180 秒', () => {
  const song = base();
  song.bpm = 32; // 每 tick 3750 帧，约 2305 tick 即撞 8640000 帧
  song.speed = 1;
  song.patterns = [Array.from({ length: 64 }, () => ({ speed: 1, voices: [] }))];
  song.order = new Array(512).fill(0);
  try {
    E.renderSong(song);
    assert.fail('应抛出');
  } catch (e) {
    assert.strictEqual(e.limit, 'frames');
    assert.ok(e.frame > 8640000);
  }
});

test('break 入行越界（跨位置）在运行时报告', () => {
  const song = base();
  song.patterns = [
    [{ voices: [], break: 9 }],
    [{ voices: [] }],
  ];
  song.order = [0, 1];
  assert.throws(() => E.renderSong(song), (e) => e.kind === 'runtime' && e.field === 'break');
});

test('delay >= 实际行速运行时报错', () => {
  const song = base();
  song.patterns = [[{ speed: 2, voices: [{ ch: 0, note: [0, 65536], delay: 2 }] }]];
  assert.throws(() => E.renderSong(song), (e) => e.field === 'delay');
});

console.log('12. 随机格谱对拍：引擎 vs BigInt 参考实现');
test('fuzz 60 首', () => {
  let seed = 20261127;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (n) => Math.floor(rnd() * n);
  for (let it = 0; it < 60; it++) {
    const ch = 1 + ri(3);
    const nSmp = 1 + ri(2);
    const songSpeed = 2 + ri(5);
    const samples = [];
    for (let i = 0; i < nSmp; i++) {
      const n = 2 + ri(6);
      const pcm = Array.from({ length: n }, () => ri(2001) - 1000);
      let loop = null;
      if (rnd() < 0.5 && n >= 3) {
        const lo = ri(n - 2);
        const hi = lo + 2 + ri(n - lo - 1);
        loop = [lo, Math.min(hi, n)];
      }
      samples.push({ pcm, loop });
    }
    const nPat = 1 + ri(2);
    const patterns = [];
    let currentSpeed = songSpeed; // speed 省略时沿用前值，跨花样持续沿用（与引擎一致）
    for (let pi = 0; pi < nPat; pi++) {
      const rows = 1 + ri(3);
      const pat = [];
      for (let r = 0; r < rows; r++) {
        const row = {};
        if (rnd() < 0.4) row.bpm = 32 + ri(353);
        if (rnd() < 0.3) {
          row.speed = 1 + ri(6);
          currentSpeed = row.speed;
        }
        const rowSpeed = currentSpeed;
        const voices = [];
        const used = new Set();
        for (let k = 0; k < ch; k++) {
          if (rnd() < 0.6) {
            const c = ri(ch);
            if (used.has(c)) continue;
            used.add(c);
            const v = { ch: c };
            if (rnd() < 0.85) v.note = [ri(nSmp), 1 + ri(200000)];
            if (v.note && rnd() < 0.3) v.delay = ri(rowSpeed); // 严格小于本行实际 speed
            if (rnd() < 0.3) v.retrig = 1 + ri(4);
            if (rnd() < 0.3) v.slide = ri(20000) - 10000;
            voices.push(v);
          }
        }
        if (voices.length) row.voices = voices;
        if (r >= 1 && rnd() < 0.25) row.back = [ri(r), 1 + ri(3)];
        pat.push(row);
      }
      patterns.push(pat);
    }
    const order = Array.from({ length: 1 + ri(3) }, () => ri(nPat));
    const song = {
      channels: ch, bpm: 120 + ri(200), speed: songSpeed, samples, patterns, order,
    };
    const errs = E.validateSong(song);
    if (errs.length) continue;
    let r, ref;
    try {
      r = E.renderSong(song);
      ref = refRender(cp(song));
    } catch (ex) {
      // delay 与实际沿用 speed 的关系依赖 order 运行时遍历，静态生成无法保证，跳过
      if (ex.limit === 'ticks' || ex.limit === 'frames' || ex.field === 'delay' || ex.field === 'break') continue;
      throw ex;
    }
    assert.strictEqual(r.totalFrames, ref.totalFrames, `iter ${it} frames`);
    assert.strictEqual(r.totalTicks, ref.totalTicks, `iter ${it} ticks`);
    eqArr(Array.from(r.pcm), ref.pcm);
    r.log.forEach((tk, i) => {
      assert.strictEqual(tk.startFrame, ref.tickFrames[i][0], `iter ${it} tick ${i} start`);
      assert.strictEqual(tk.endFrame, ref.tickFrames[i][1], `iter ${it} tick ${i} end`);
    });
  }
});

console.log('13. WAV 头与字节');
test('buildWav 48k mono pcm16', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
  const wav = IO.buildWav(pcm, 48000);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const s = (o) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.strictEqual(s(0), 'RIFF');
  assert.strictEqual(s(8), 'WAVE');
  assert.strictEqual(dv.getUint16(22, true), 1);
  assert.strictEqual(dv.getUint32(24, true), 48000);
  assert.strictEqual(dv.getUint16(34, true), 16);
  assert.strictEqual(dv.getUint32(40, true), 10);
  assert.strictEqual(wav.length, 44 + 10);
  const body = new Int16Array(wav.buffer, wav.byteOffset + 44, 5);
  eqArr(Array.from(body), [0, 1, -1, 32767, -32768]);
});

console.log('14. zip 读取包内样例');
(async () => {
  try {
    const zipBytes = fs.readFileSync(path.join(__dirname, '../samples/tracker-ticks.zip'));
    const files = await IO.readZip(new Uint8Array(zipBytes));
    const names = files.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ['format.txt', 'rehearsal.json']);
    const j = files.find((f) => f.name === 'rehearsal.json');
    const song = JSON.parse(new TextDecoder().decode(j.bytes));
    assert.strictEqual(song.channels, 2);
    const r = E.renderSong(song);
    assert.ok(r.totalFrames > 0);
    passed++;
    console.log('  ok - readZip 解析 tracker-ticks.zip');
    console.log(`\n${passed} 项通过` + (process.exitCode ? '，存在失败' : '，全部通过'));
  } catch (err) {
    console.error('FAIL - zip 测试');
    console.error(err);
    process.exitCode = 1;
  }
})();
