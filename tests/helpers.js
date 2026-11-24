// tests/helpers.js — 构造合成源轨与暴力参照统计
import { SourcePyramid } from '../js/pyramid.js';

export function makePcm(frameCount, seed = 1, amp = 32767) {
  // 确定性伪随机（线性同余），覆盖正负满量程与 0
  let state = seed >>> 0;
  const pcm = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    const r = (state >>> 8) & 0xffff; // 0..65535
    let v = Math.floor((r / 65535) * (2 * amp + 1)) - amp;
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    pcm[i] = v;
  }
  return pcm;
}

export function makeSource(frameCount, name, seed = 7) {
  const ch0 = makePcm(frameCount, seed, 32767);
  const ch1 = makePcm(frameCount, seed + 100000, 32767);
  return {
    name,
    frameCount,
    pcm: [ch0, ch1],
    pyramid: new SourcePyramid([ch0, ch1], frameCount, name),
  };
}

export function bruteStat(pcm, start, end) {
  if (end <= start) return null;
  let min = 32767, max = -32768, count = 0;
  let sumSq = 0n;
  for (let i = start; i < end; i++) {
    const v = pcm[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
    sumSq += BigInt(v) * BigInt(v);
  }
  return { min, max, count, sumSq };
}

export function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok  ', msg);
}

// 断言相等：不依赖参数顺序，消息只报告两个值是否相等
export function assertEq(a, b, msg) {
  assert(a === b, `${msg} (${a} !== ${b})`);
}

export function assertStat(got, want, msg) {
  if (want === null) { assert(got === null, msg + ' (应为空)'); return; }
  assert(got !== null, msg + ' (不应为空)');
  if (!got) return;
  assertEq(got.min, want.min, msg + ' min');
  assertEq(got.max, want.max, msg + ' max');
  assertEq(got.count, want.count, msg + ' count');
  assert(got.sumSq === want.sumSq, `${msg} sumSq (got ${got.sumSq}, want ${want.sumSq})`);
}
