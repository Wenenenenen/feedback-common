// sample-data.js — 内置示例: 合成 4 轨 PCM 与 6 句候选, 无需外部文件即可体验
import { SAMPLE_RATE } from './wav-codec.js';

// 每轨用不同基频的谐波信号 + 振幅包络模拟语节奏感
const TAKE_F0 = [130.81, 155.56, 196.0, 220.0]; // C3, Eb3, G3, A3
const TAKE_RATE = 48000 * 20; // 20 秒

function synthTake(take) {
  const f0 = TAKE_F0[take];
  const samples = new Int16Array(TAKE_RATE);
  const phase = [0, 0, 0];
  const dphi = [f0, f0 * 2, f0 * 3].map((f) => (2 * Math.PI * f) / SAMPLE_RATE);
  // 慢速漂移 + 节奏门控, 让波形有明显起伏便于辨认
  for (let i = 0; i < TAKE_RATE; i++) {
    const t = i / SAMPLE_RATE;
    const gate = 0.5 + 0.5 * Math.sin(2 * Math.PI * (1.7 + take * 0.23) * t);
    const wobble = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.31 * t + take);
    let v = 0;
    for (let h = 0; h < 3; h++) {
      phase[h] += dphi[h] * (1 + 0.0015 * Math.sin(2 * Math.PI * 0.7 * t));
      v += (1 / (h + 1)) * Math.sin(phase[h]);
    }
    v = (v / 1.83) * gate * wobble * 0.5;
    // 轻微淡入淡出避免爆音
    const edge = Math.min(1, i / 240, (TAKE_RATE - i) / 240);
    samples[i] = Math.round(v * edge * 32767);
  }
  return { name: `t${take}.wav`, samples, frames: TAKE_RATE, sampleRate: SAMPLE_RATE };
}

export function buildSample() {
  const takeAudio = new Map();
  for (let t = 0; t < 4; t++) takeAudio.set(t, synthTake(t));

  // 6 句, 每句 4 候选; 同轨候选源坐标单调, 保证有零切轨可行链
  // 候选: [id, take, src, dst, len, cost]
  const slotW = 6000;
  const gap = 240;
  const step = slotW + gap + 1760;
  const lens = [4200, 3800, 4600, 4000];
  const cues = [];
  let id = 0;
  const srcPos = [0, 0, 0, 0];

  for (let k = 0; k < 6; k++) {
    const slotS = 480 + k * step;
    const cands = [];
    for (let t = 0; t < 4; t++) {
      const len = lens[t] + ((k + t) % 3) * 120;
      // 各候选落点在槽内错开, 其中轨 3 的偶数句故意贴右, 制造与下一句的 gap 张力
      const dst = slotS + (t * 360 + (k % 2) * 120);
      const src = srcPos[t];
      srcPos[t] += len + 480;
      const cost = 2 + ((k * 3 + t * 5) % 7);
      cands.push([id++, t, src, dst, len, cost]);
    }
    // 打乱候选编号顺序, 演示字典序与数组顺序无关
    if (k % 2) {
      const tmp = cands[1]; cands[1] = cands[2]; cands[2] = tmp;
    }
    cues.push({ slot: [slotS, slotS + slotW], candidates: cands });
  }

  const frames = 480 + 6 * step + 2400;
  const instance = {
    takes: ['t0.wav', 't1.wav', 't2.wav', 't3.wav'],
    frames,
    gap,
    changes: 3,
    switchCost: 4,
    cues: cues.map((cue) => ({
      slot: cue.slot,
      candidates: cue.candidates.map((c) => ({
        id: c[0], take: c[1], src: c[2], dst: c[3], len: c[4], cost: c[5],
      })),
    })),
  };
  return { instance, takeAudio };
}
