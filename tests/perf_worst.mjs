/*
 * 最坏情况性能压测：8 轨 × 每轨铺满 60 秒，累计 6000 段。
 * 用法：node tests/perf_worst.mjs
 */
import { loadEngine } from "./wavnode.mjs";

const engine = await loadEngine();
const FRAMES = 2880000;
const TRACKS = 8;
const TOTAL_SEG = 6000;
const perTrack = TOTAL_SEG / TRACKS; // 750

const wav = new Float64Array(200000);
for (let i = 0; i < wav.length; i++) wav[i] = Math.round(9000 * Math.sin(i / 17));

const tracks = [];
for (let k = 0; k < TRACKS; k++) {
  const segments = [];
  const n = perTrack;
  const segLen = Math.floor(FRAMES / n); // 3840
  for (let i = 0; i < n; i++) {
    const start = i * segLen;
    const end = i === n - 1 ? FRAMES : start + segLen;
    const L = end - start;
    // 速度 ≤ 0.5：位移 ≤ L/2
    const dx = Math.round(L * 0.49 * Math.sin(i + k));
    const p0 = [Math.round(300 * (k - 3.5)), Math.round(200 * Math.cos(i * 0.1)), Math.round(100 * Math.sin(i * 0.07))];
    const p1 = [p0[0] + dx, p0[1], p0[2]];
    segments.push({ start, end, offset: (i * 131) % (wav.length - L > 0 ? wav.length - L : 1), p0, p1 });
  }
  tracks.push({ wav: "w.wav", segments });
}

const scene = {
  frames: FRAMES,
  ears: [
    { t: 0, left: [-30, 0, 0], right: [30, 0, 0] },
    { t: FRAMES, left: [-30, 4000, 0], right: [30, 4000, 0] },
  ],
  tracks,
};

const wavMap = { "w.wav": wav };
const errs = engine.validateScene(scene, { "w.wav": { frames: wav.length } });
if (errs.length) {
  console.log("校验错误：", errs.slice(0, 5));
}

const prepared = engine.prepare(scene, wavMap);
const t0 = process.hrtime.bigint();
const got = engine.render(prepared);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`段数=${TOTAL_SEG} 轨=${TRACKS} 帧=${FRAMES}`);
console.log(`到达=${got.stats.arrivals} 用时=${ms.toFixed(1)} ms  峰值 L=${got.stats.peakL} R=${got.stats.peakR}`);
console.log(ms < 12000 ? "OK < 12000ms" : "超出 12 秒");
