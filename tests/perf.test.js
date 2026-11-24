// tests/perf.test.js — 性能指标：源轨读入后，2 万段编辑态刷新 1024 列统计 ≤ 2s
import { SourcePyramid, LEAF } from '../js/pyramid.js';
import { Timeline, makeSegment, MAX_SEGMENTS } from '../js/timeline.js';
import { makePcm } from './helpers.js';

const SAMPLE_RATE = 48000;
const SRC_FRAMES = 10 * 60 * SAMPLE_RATE; // 10 分钟源轨（上限）

function fmt(ms) { return `${ms.toFixed(1)} ms`; }

// 8 条源轨，各 10 分钟（取较小帧数做冒烟；再单独跑满规模一次）
function buildSources(count, frames) {
  const sources = new Map();
  for (let k = 0; k < count; k++) {
    const pcm = [makePcm(frames, 100 + k * 7, 32767), makePcm(frames, 200 + k * 13, 32767)];
    const t0 = performance.now();
    const pyramid = new SourcePyramid(pcm, frames, `src${k}.wav`);
    const t1 = performance.now();
    console.log(`源轨 ${k} 金字塔构建: ${fmt(t1 - t0)}（${frames} 帧）`);
    sources.set(`S${k}`, { name: `src${k}.wav`, frameCount: frames, pyramid });
  }
  return sources;
}

// 2 万段：在 8 条源轨上随机引用半开区间，随机倒序/静音
function buildTimeline(sources, segCount) {
  const ids = [...sources.keys()];
  const tl = new Timeline(sources);
  let state = 98765;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  // 直接填段数组，避免 append 逐段 rebuild 的 O(n²)
  for (let i = 0; i < segCount; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    const cap = sources.get(id).frameCount;
    const len = 1 + Math.floor(rand() * 2000);
    const start = Math.floor(rand() * Math.max(1, cap - len));
    const seg = makeSegment(id, start, Math.min(start + len, cap));
    if (rand() < 0.2) seg.reverse = true;
    if (rand() < 0.1) seg.muted = true;
    tl.segments.push(seg);
  }
  tl.rebuild();
  return tl;
}

async function main() {
  const FULL = process.argv.includes('--full');
  const frames = FULL ? SRC_FRAMES : 600000; // 冒烟 60 万帧/轨；--full 跑满 10 分钟
  console.log(`=== 性能测试（${FULL ? '满规模 10 分钟/轨' : '冒烟 60 万帧/轨'}）===`);

  const t0 = performance.now();
  const sources = buildSources(8, frames);
  const t1 = performance.now();
  console.log(`8 条源轨金字塔总构建时间: ${fmt(t1 - t0)}`);

  const tl = buildTimeline(sources, MAX_SEGMENTS);
  console.log(`拼接轨: ${tl.segments.length} 段, 总长 ${tl.totalFrames()} 帧`);

  // 指标场景：刷新 1024 列统计（取整段为所选区间）
  const B = 1024;
  const n = tl.totalFrames();
  // 预热（JIT）
  tl.columnStats(0, n, B);
  const runs = 5;
  let maxMs = 0, sumMs = 0;
  for (let r = 0; r < runs; r++) {
    const s = performance.now();
    const cols = tl.columnStats(0, n, B);
    const e = performance.now();
    maxMs = Math.max(maxMs, e - s);
    sumMs += e - s;
    if (cols.length !== B) throw new Error('列数不符');
  }
  console.log(`columnStats B=1024 ×${runs}: 平均 ${fmt(sumMs / runs)}, 最慢 ${fmt(maxMs)}`);
  const limit = 2000;
  if (maxMs > limit) {
    console.error(`FAIL: 最慢 ${fmt(maxMs)} 超过 2s 指标`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: 最慢 ${fmt(maxMs)} ≤ 2s（余量 ${(100 * (1 - maxMs / limit)).toFixed(0)}%）`);
  }

  // B=2048 上限与 B=1
  for (const b of [1, 2048]) {
    const s = performance.now();
    tl.columnStats(0, n, b);
    console.log(`columnStats B=${b}: ${fmt(performance.now() - s)}`);
  }

  // 单帧定位耗时
  const s = performance.now();
  for (let i = 0; i < 100000; i++) tl.locate((i * 997) % n);
  console.log(`locate ×10 万次: ${fmt(performance.now() - s)}`);
}

main();
