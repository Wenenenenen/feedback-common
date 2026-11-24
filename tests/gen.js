// gen.js — 测试实例生成器(Node 与浏览器均可)
// 候选字段: [id, take, src, dst, len, cost]

export function makeInstance(seed, opts = {}) {
  const rnd = mulberry32(seed);
  const takes = opts.takes ?? 3;
  const cuesN = opts.cues ?? 10;
  const perCue = opts.perCue ?? 6;
  const gap = opts.gap ?? 100;
  const changes = opts.changes ?? 4;
  const switchCost = opts.switchCost ?? 2;
  const takeLen = opts.takeLen ?? 48000 * 60;
  const slotW = opts.slotW ?? 3000;
  const minLen = opts.minLen ?? 800;
  const maxLen = opts.maxLen ?? 2600;
  const idMode = opts.idMode ?? 'sequential'; // sequential | shuffled
  const costMax = opts.costMax ?? 9;
  // 单调源坐标: 同轨候选的 src 随句子序号推进, 保证同轨长链可行(贴近真实录音)
  const monotonicSrc = opts.monotonicSrc ?? false;

  const cues = [];
  let nextId = 0;
  const pendingIds = [];
  const slotStep = slotW + gap + 400;
  const srcStep = maxLen + 200;
  // 每轨当前源指针: 单调模式下跨句累积, 保证同轨候选首尾相接、绝不重叠倒退
  const srcPtr = new Array(takes).fill(0);

  for (let k = 0; k < cuesN; k++) {
    const slotS = 200 + k * slotStep;
    const slotE = slotS + slotW;
    const cands = [];
    for (let q = 0; q < perCue; q++) {
      const take = Math.floor(rnd() * takes);
      const len = minLen + Math.floor(rnd() * (maxLen - minLen + 1));
      // dst 有时贴左, 有时贴右, 便于触发超槽
      const dst = slotS + Math.floor(rnd() * Math.max(1, slotW - len + 1));
      let src;
      if (monotonicSrc) {
        src = srcPtr[take];
        srcPtr[take] += srcStep;
      } else {
        src = Math.floor(rnd() * Math.max(1, takeLen - len + 1));
      }
      const cost = Math.floor(rnd() * (costMax + 1));
      cands.push([0, take, src, dst, len, cost]);
    }
    // 保证至少一条严格在槽内
    cands[0][1] = 0;
    cands[0][4] = Math.min(maxLen, slotW - 50);
    cands[0][3] = slotS;
    if (monotonicSrc) {
      cands[0][2] = srcPtr[0];
      srcPtr[0] += srcStep;
    } else {
      cands[0][2] = Math.floor(rnd() * Math.max(1, takeLen - cands[0][4] + 1));
    }

    if (idMode === 'shuffled') {
      // 先生成编号再打乱到候选里
      const ids = cands.map(() => nextId++);
      shuffle(ids, rnd);
      cands.forEach((c, i) => (c[0] = ids[i]));
    } else {
      cands.forEach((c) => (c[0] = nextId++));
    }
    cues.push({ slot: [slotS, slotE], candidates: cands });
  }

  const frames = 200 + cuesN * slotStep;
  return {
    takes: Array.from({ length: takes }, (_, i) => `t${i}.wav`),
    frames,
    gap,
    changes,
    switchCost,
    cues,
  };
}

export function normalize(raw) {
  return {
    ...raw,
    cues: raw.cues.map((cue) => ({
      slot: cue.slot,
      candidates: cue.candidates.map((c) => ({
        id: c[0],
        take: c[1],
        src: c[2],
        dst: c[3],
        len: c[4],
        cost: c[5],
      })),
    })),
  };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
