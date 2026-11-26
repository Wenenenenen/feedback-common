/*
 * 参考实现：调度与每帧渲染全部用 BigInt 精确分数，不追求性能。
 * 仅用于与引擎交叉验证（测试），页面不加载本文件。
 */
'use strict';

const Q = 65536n;
const P_BI = 120000n;

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

function frac(n, d) {
  n = BigInt(n);
  d = BigInt(d);
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function add(x, n, d) {
  n = BigInt(n);
  d = BigInt(d);
  return frac(x.n * d + n * x.d, x.d * d);
}
function floor(x) { return x.n / x.d; }

function lerpNum(a, b, num, den) {
  // 入参可为 Number 或 BigInt，内部全程 BigInt
  a = BigInt(a);
  b = BigInt(b);
  num = BigInt(num);
  den = BigInt(den);
  return frac(a * den + (b - a) * num, den);
}

function refRender(song) {
  const { patterns, order, samples, channels } = song;
  const voices = [];
  for (let c = 0; c < channels; c++)
    voices.push({ active: false, sample: 0, phase: 0n, step: 0n, loop: null, slideMem: 0n });

  const backMaps = order.map(() => new Map());
  let posIdx = 0, rowIdx = 0, bpm = song.bpm, speed = song.speed, tickIndex = 0;
  let acc = frac(0n, 1n);
  // 每帧精确分数累加器：frame -> {n,d}
  const frameMix = new Map();

  const addFrame = (f, n, d) => {
    n = BigInt(n);
    d = BigInt(d);
    const cur = frameMix.get(f) || { n: 0n, d: 1n };
    frameMix.set(f, frac(cur.n * d + n * cur.d, cur.d * d));
  };

  const renderTick = (f0, f1) => {
    for (let f = f0; f < f1; f++) {
      for (const v of voices) {
        if (!v.active) continue;
        const smp = samples[v.sample];
        const N = smp.pcm.length;
        if (v.loop) {
          const [lo, hi] = v.loop;
          const L = BigInt(hi - lo);
          const span = L * Q;
          let ph = v.phase;
          if (ph >= BigInt(hi) * Q) ph = BigInt(lo) * Q + ((ph - BigInt(hi) * Q) % span);
          let val;
          if (ph >= BigInt(hi - 1) * Q) {
            val = lerpNum(smp.pcm[hi - 1], smp.pcm[lo], ph - BigInt(hi - 1) * Q, L * Q);
          } else {
            const i = ph / Q;
            const r = ph % Q;
            val = lerpNum(smp.pcm[Number(i)], smp.pcm[Number(i) + 1], r, Q);
          }
          addFrame(f, val.n, val.d);
          v.phase = ph + v.step;
        } else {
          if (v.phase < BigInt(N - 1) * Q) {
            const i = v.phase / Q;
            const r = v.phase % Q;
            const val = lerpNum(smp.pcm[Number(i)], smp.pcm[Number(i) + 1], r, Q);
            addFrame(f, val.n, val.d);
            v.phase += v.step;
          } else if (v.phase < BigInt(N) * Q) {
            const r = v.phase - BigInt(N - 1) * Q;
            const val = lerpNum(smp.pcm[N - 1], 0, r, Q);
            addFrame(f, val.n, val.d);
            v.phase += v.step;
            if (v.phase >= BigInt(N) * Q) { v.active = false; v.phase = 0n; }
          } else {
            v.active = false; v.phase = 0n;
          }
        }
      }
    }
  };

  const clampStep = (x) => x < 1n ? 1n : x > 1048576n ? 1048576n : x;
  const tickFrames = [];

  while (true) {
    const pattern = patterns[order[posIdx]];
    const row = pattern[rowIdx];
    if (row.bpm !== undefined) bpm = row.bpm;
    if (row.speed !== undefined) speed = row.speed;
    const rowVoices = Array.isArray(row.voices) ? row.voices : [];
    for (const e of rowVoices) if (e.slide !== undefined && e.slide !== 0) voices[e.ch].slideMem = BigInt(e.slide);

    for (let t = 0; t < speed; t++) {
      const triggered = new Set();
      for (const e of rowVoices) {
        const delay = e.delay || 0;
        if (e.note && delay === t) {
          const v = voices[e.ch];
          v.active = true; v.sample = e.note[0]; v.phase = 0n; v.step = BigInt(e.note[1]);
          v.loop = samples[v.sample].loop;
          triggered.add(e.ch);
        }
      }
      for (const e of rowVoices) {
        if (triggered.has(e.ch)) continue;
        if (e.retrig !== undefined && t >= 1 && t % e.retrig === 0 && voices[e.ch].active)
          voices[e.ch].phase = 0n;
      }
      if (t > 0) for (const e of rowVoices) {
        if (e.slide !== undefined && voices[e.ch].active)
          voices[e.ch].step = clampStep(voices[e.ch].step + voices[e.ch].slideMem);
      }

      const f0 = Number(floor(acc));
      acc = add(acc, P_BI, BigInt(bpm));
      const f1 = Number(floor(acc));
      if (f1 > 8640000) { const x = new Error('frames'); x.limit = 'frames'; throw x; }
      if (tickIndex >= 20000) { const x = new Error('ticks'); x.limit = 'ticks'; throw x; }
      tickFrames.push([f0, f1]);
      renderTick(f0, f1);
      tickIndex++;
    }

    let jumped = false;
    if (row.back) {
      const [target, extra] = row.back;
      const key = rowIdx;
      let remaining = backMaps[posIdx].has(key) ? backMaps[posIdx].get(key) : extra + 1;
      if (remaining > 0) {
        remaining--;
        backMaps[posIdx].set(key, remaining);
        rowIdx = target;
        jumped = true;
      }
    }
    if (!jumped && row.break !== undefined) {
      if (posIdx + 1 < order.length) { posIdx++; rowIdx = row.break; jumped = true; }
      else break;
    }
    if (!jumped) {
      if (rowIdx + 1 < pattern.length) rowIdx++;
      else if (posIdx + 1 < order.length) { posIdx++; rowIdx = 0; }
      else break;
    }
  }

  const total = Number(floor(acc));
  const out = [];
  for (let f = 0; f < total; f++) {
    const x = frameMix.get(f);
    let v = 0;
    if (x) {
      const neg = x.n < 0n;
      const a = neg ? -x.n : x.n;
      let q = a / x.d;
      if (2n * (a % x.d) >= x.d) q += 1n;
      v = Number(neg ? -q : q);
      v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    out.push(v);
  }
  return { pcm: out, totalFrames: total, tickFrames, totalTicks: tickIndex };
}

module.exports = { refRender };
