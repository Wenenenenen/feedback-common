'use strict';
// 确定性伪随机数发生器。
// mulberry32：32 位整数状态，同种子、同调用序列 => 逐位一致。
// 所有随机性（初始供体抽取、随机搜索抖动）都必须经此模块，禁止 Math.random。

export function hashSeed(input) {
  // 允许传入数字或字符串种子；字符串经 xmur3 混成 uint32。
  if (typeof input === 'number' && Number.isInteger(input)) {
    return input >>> 0;
  }
  let h = 1779033703 ^ 0;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function mulberry32(seed) {
  let state = hashSeed(seed);
  return function nextU32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  };
}

// [0,1) 双精度浮点
export function nextFloat(nextU32) {
  return nextU32() / 4294967296;
}

// 均匀整数 [0, n)，n 为正整数。用取模拒绝法在 2^32 上消除取模偏差，
// 保证抽样严格均匀，且完全确定。
export function nextInt(nextU32, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  let x;
  do {
    x = nextU32();
  } while (x >= limit);
  return x % n;
}
