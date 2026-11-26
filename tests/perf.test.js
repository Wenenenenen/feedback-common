'use strict';
/* 满额性能基线：32 轨、近 2 万 tick / 近 864 万帧，整曲渲染须在 15 秒内 */
const assert = require('assert');
const E = require('../src/engine.js');

function bigSong({ bpm, orderLen, speed }) {
  const samples = Array.from({ length: 32 }, (_, s) => ({
    pcm: Array.from({ length: 48000 }, (_, i) => ((i * (7919 + s * 131)) % 65536) - 32768),
    loop: [100, 47000],
  }));
  const patterns = [Array.from({ length: 64 }, () => ({
    speed,
    voices: Array.from({ length: 32 }, (_, c) => ({
      ch: c,
      note: [c % 32, 65536 + ((c * 977) % 900000)],
      retrig: c % 5 === 0 ? 4 : undefined,
      slide: c % 3 === 0 ? 1000 : undefined,
    })),
  }))];
  return { channels: 32, bpm, speed, samples, patterns, order: new Array(orderLen).fill(0) };
}

const t0 = process.hrtime.bigint();
const nearMaxFrames = E.renderSong(bigSong({ bpm: 33, orderLen: 36, speed: 1 }));
const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`近满帧（${nearMaxFrames.totalFrames} 帧 / ${nearMaxFrames.totalTicks} tick / 32 轨）: ${ms1.toFixed(0)} ms`);
assert.ok(nearMaxFrames.totalFrames > 8000000);
assert.ok(ms1 < 15000, `渲染用时 ${ms1}ms 超过 15 秒`);

// 高 tick 数路径（小帧，验证调度与日志在 ~1.8 万 tick 下的耗时）
const t1 = process.hrtime.bigint();
const highTicks = E.renderSong(bigSong({ bpm: 384, orderLen: 9, speed: 32 })); // 9*64*32=18432 tick
const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
console.log(`高 tick（${highTicks.totalTicks} tick / ${highTicks.totalFrames} 帧）: ${ms2.toFixed(0)} ms`);
assert.strictEqual(highTicks.totalTicks, 18432);
assert.ok(ms2 < 15000, `渲染用时 ${ms2}ms 超过 15 秒`);

console.log('性能基线全部满足（< 15s）');
