// 验收场景构造（Node，测试与 README 演示共用）。
// 每个构造器返回 {zip:Uint8Array, expect:{...}}，把“正确答案”写死，
// 供测试独立对照，而不是拿实现自己的输出当答案。

import { buildScene, packScene } from './gen-case.mjs';

/** 唯一值基准：左 = 帧号 + 1000，右 = −(帧号 + 1000) */
function uniqueAnchor(frames) {
  return {
    L: Int16Array.from({ length: frames }, (_, i) => (i % 30000) + 1000),
    R: Int16Array.from({ length: frames }, (_, i) => -((i % 30000) + 1000)),
  };
}

function makeScene(frames, anchor, copies, anchorBad = [[], []]) {
  return {
    anchor,
    copies: copies.map((c) => ({ L: c.L, R: c.R })),
    copyMeta: copies.map((c, i) => ({ name: `copy-${i + 1}.wav`, blocks: c.blocks, bad: c.bad || [[], []] })),
    copySegments: copies.map((c) => c.blocks.map((b) => ({ nom: b[1], len: b[2] }))),
    anchorBad,
  };
}

function zipOf(scene) {
  return packScene(scene, { anchorBad: scene.anchorBad || [[], []] });
}

// ---------------------------------------------------------------------------

/**
 * 难点 1：两块各自最优为 0 却互相重叠，全局应选 −2、0，总分 0（相对基准）。
 * 基准 100 帧唯一值；副本两块各 4 帧，内容等于基准 [30,34) 与 [32,36)，
 * 名义起点 30、32。
 *   - 两块都取 0：块 0 盘面 [30,34)、块 1 盘面 [32,36) 重叠 → 违规。
 *   - 块 0 取 −2 → 盘面 [28,32)；块 1 取 0 → [32,36)，不重叠。
 *     块 0 的 4 帧与基准全不等（−4），块 1 满分（+4），合计 0。
 *   - 另一组可行解 [0, 2] 同样总分 0、绝对偏移和 2；按有符号序列字典序选 [−2, 0]。
 */
export function overlapCase() {
  const frames = 100;
  const anchor = uniqueAnchor(frames);
  const L = new Int16Array(8);
  const R = new Int16Array(8);
  for (let i = 0; i < 4; i++) {
    L[i] = anchor.L[30 + i];
    R[i] = anchor.R[30 + i];
    L[4 + i] = anchor.L[32 + i];
    R[4 + i] = anchor.R[32 + i];
  }
  const copies = [{ L, R, blocks: [[0, 30, 4], [4, 32, 4]], bad: [[], []] }];
  return {
    name: 'overlap',
    zip: zipOf(makeScene(frames, anchor, copies)),
    // 两块方案总分为 0：[-2,0] 与 [0,2] 同分同绝对偏移和，按有符号序列字典序选 [-2,0]
    expect: { ok: true, offsets: [-2, 0], total: 0, absSum: 2 },
  };
}

/**
 * 难点 2：无解。副本两块长度 40、4，名义起点 20、21；
 * 第一块最早可到 20−12=8，盘面 [8,48)；第二块最晚 21+12=33，盘面 [33,37) 仍交叠。
 * 首次无法排下的块应为第 2 块（下标 1）。
 */
export function noSolutionCase() {
  const frames = 120;
  const anchor = uniqueAnchor(frames);
  const L = new Int16Array(44);
  const R = new Int16Array(44);
  for (let i = 0; i < 44; i++) { L[i] = anchor.L[20 + i]; R[i] = anchor.R[20 + i]; }
  const copies = [{ L, R, blocks: [[0, 20, 40], [40, 21, 4]], bad: [[], []] }];
  return {
    name: 'nosolution',
    zip: zipOf(makeScene(frames, anchor, copies)),
    expect: { ok: false, copyIndex: 0, blockIndex: 1 },
  };
}

/**
 * 难点 3：投票。四份读档与基准几乎逐帧相同，仅在第 5 帧改动，从而把零偏移钉死。
 *   左声道第 5 帧票 100、100、200、200 → 2:2 无过半，写 0 并标争议；
 *   右声道第 5 帧票 50、50、90、110（第 4 份右声道该帧标坏）→ 50 得 2/3，严格过半，采用 50。
 * 其余帧四份都与基准一致，故只有第 5 帧可能争议。
 */
export function voteCase() {
  const frames = 60;
  const anchor = uniqueAnchor(frames);
  const testFrame = 5;
  const mk = (l, r) => {
    const L = anchor.L.slice();
    const R = anchor.R.slice();
    L[testFrame] = l;
    R[testFrame] = r;
    return { L, R, blocks: [[0, 0, frames]], bad: [[], []] };
  };
  const copies = [
    mk(100, 50),
    mk(100, 50),
    mk(200, 90),
    { ...mk(200, 110), bad: [[], [[testFrame, testFrame + 1]]] },
  ];
  return {
    name: 'vote',
    zip: zipOf(makeScene(frames, anchor, copies)),
    expect: {
      ok: true,
      offsets: [0, 0, 0, 0],
      testFrame,
      leftStatus: 1, leftValue: 0, leftVotes: 4, leftTop: 2,
      rightStatus: 0, rightValue: 50, rightVotes: 3, rightTop: 2,
      leftDisputeFrames: 1,
      rightDisputeFrames: 0,
    },
  };
}

/**
 * 难点 4：改坏区后重新对齐。唯一值基准，副本名义起点 20、长 4、匹配基准 [10,14)，
 * 初始偏移应为 −10。把基准左声道 [8,36) 设为坏区后，所有候选评分为 0，
 * 应改用偏移 0（绝对偏移和最小）。
 */
export function badEditCase() {
  const frames = 60;
  const anchor = uniqueAnchor(frames);
  const L = new Int16Array(4);
  const R = new Int16Array(4);
  for (let i = 0; i < 4; i++) { L[i] = anchor.L[10 + i]; R[i] = anchor.R[10 + i]; }
  const copies = [{ L, R, blocks: [[0, 20, 4]], bad: [[], []] }];
  return {
    name: 'badedit',
    zip: zipOf(makeScene(frames, anchor, copies)),
    expect: { ok: true, initialOffset: -10, afterBadOffset: 0, badSpan: [8, 36] },
  };
}

/**
 * 难点 5：满额性能场景：7 副本、每份 256 块、90 秒。
 * 块之间留 gap（默认 40 帧）以容纳 ±12 的独立偏移；每块给一个分散的真实偏移，
 * 内容严格取基准在 [nom+off, nom+off+len) 的帧。返回 truth 供对照。
 */
export function budgetScene(seconds = 90, opts = {}) {
  const frames = Math.round(seconds * 44100);
  const copies = opts.copies || 7;
  const blocksPer = opts.blocksPer || 256;
  const gap = opts.gap === undefined ? 40 : opts.gap;
  const scene = buildScene({ frames, copies, blocks: blocksPer, unique: false, seed: 424242 });
  const per = Math.floor(frames / blocksPer);
  const len = per - gap;
  const truth = [];
  let seed = 0xdeadbeef;
  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed;
  };
  for (let c = 0; c < copies; c++) {
    const L = scene.copies[c].L;
    const R = scene.copies[c].R;
    const offsets = [];
    let cursor = 0;
    for (let b = 0; b < blocksPer; b++) {
      const nom = per * b;
      const off = (rand() % 25) - 12;
      offsets.push(off);
      const p0 = nom + off;
      for (let i = 0; i < len; i++) {
        const p = p0 + i;
        L[cursor + i] = p >= 0 && p < frames ? scene.anchor.L[p] : 0;
        R[cursor + i] = p >= 0 && p < frames ? scene.anchor.R[p] : 0;
      }
      cursor += len;
    }
    truth.push(offsets);
  }
  // 用真实块清单覆盖默认块清单
  scene.copyMeta = scene.copyMeta.map((m, c) => ({
    name: m.name,
    blocks: Array.from({ length: blocksPer }, (_, b) => [b * len, per * b, len]),
    bad: [[], []],
  }));
  return { name: 'budget', zip: packScene(scene, {}), scene, truth, frames, copies, blocksPer, gap, per, len };
}

export const CASES = {
  overlap: overlapCase,
  nosolution: noSolutionCase,
  vote: voteCase,
  badedit: badEditCase,
};
