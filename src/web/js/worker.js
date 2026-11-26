/*
 * worker.js — 渲染 Worker。计算与主线程隔离，避免满额 60 秒渲染卡住界面。
 *
 * 消息协议（主线程 → Worker）：
 *   {type:'render', jobId, scene, wavs:{name:ArrayBuffer}, progressMs}
 *     使用缓存的 WAV 解码结果（若 wavs 省略，则用上次 setWavs 缓存）
 *   {type:'setWavs', wavs:{name:ArrayBuffer}}
 *   {type:'inspect', jobId, t, side}      查询当前已渲染场景某帧到达
 * Worker → 主线程：
 *   {type:'progress', jobId, frac}
 *   {type:'wavParsed', name, meta}        WAV 解析结果（ok/frames/error）
 *   {type:'render', jobId, stats, energyL, energyR, countL, countR,
 *                     pcm:{left,right}（转移 ArrayBuffer）}
 *   {type:'inspect', jobId, items}
 *   {type:'error', jobId, message}
 *
 * 设计要点：worker 保存最近一次成功渲染的 Int16 左右声道与 prepared，
 * 供选区试听/导出切片与到达查询，保证“试听/导出 == 当前全轨对应采样”。
 */

import { parseWav, prepare, render, inspectFrame, validateScene } from "./engine.js";

let wavCache = {}; // name -> {meta, samples:Float64Array}
let lastScene = null;
let lastPrepared = null;
let lastJob = 0;

function decodeWavs(wavs) {
  const out = {};
  for (const [name, buf] of Object.entries(wavs || {})) {
    const parsed = parseWav(new Uint8Array(buf));
    if (parsed.ok) out[name] = { meta: { ok: true, frames: parsed.frames }, samples: parsed.samples };
    else out[name] = { meta: { ok: false, error: parsed.error }, samples: new Float64Array(0) };
  }
  return out;
}

function metaMap(cache) {
  const m = {};
  for (const [k, v] of Object.entries(cache)) m[k] = v.meta;
  return m;
}

function sampleMap(cache) {
  const m = {};
  for (const [k, v] of Object.entries(cache)) m[k] = v.samples;
  return m;
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "setWavs") {
      // 仅解析元数据用于主线程展示；不提交到渲染缓存。
      const parsed = decodeWavs(msg.wavs);
      for (const [name, v] of Object.entries(parsed)) {
        self.postMessage({ type: "wavParsed", name, meta: v.meta });
      }
      return;
    }

    if (msg.type === "render") {
      const jobId = msg.jobId;
      lastJob = jobId;
      const ack = () => jobId === lastJob; // 被更新的任务取代则中止
      // 候选 WAV 缓存：只有本次渲染通过校验才提交，非法导入不污染上一份可试听结果的素材。
      const candidate = msg.wavs ? decodeWavs(msg.wavs) : wavCache;
      if (msg.wavs) {
        for (const [name, v] of Object.entries(candidate)) {
          self.postMessage({ type: "wavParsed", name, meta: v.meta });
        }
      }
      const errs = validateScene(msg.scene, metaMap(candidate));
      if (errs.length) {
        self.postMessage({ type: "error", jobId, message: "场景校验失败", errors: errs });
        return;
      }
      const prepared = prepare(msg.scene, sampleMap(candidate));
      const result = render(prepared, {
        progressMs: Math.max(60, msg.progressMs || 120),
        onProgress: (frac) => {
          if (ack()) self.postMessage({ type: "progress", jobId, frac });
        },
      });
      if (!ack()) return;
      wavCache = candidate; // 提交
      lastScene = msg.scene;
      lastPrepared = prepared;
      // 注意：左/右声道与 energy/count 的 ArrayBuffer 会被转移给主线程，
      // worker 侧不再持有它们；到达查询只用 lastPrepared（几何与场景）。
      const transfer = [result.left.buffer, result.right.buffer, result.energyL.buffer, result.energyR.buffer, result.countL.buffer, result.countR.buffer];
      self.postMessage(
        {
          type: "render",
          jobId,
          stats: result.stats,
          energyL: result.energyL,
          energyR: result.energyR,
          countL: result.countL,
          countR: result.countR,
          left: result.left,
          right: result.right,
        },
        transfer,
      );
      return;
    }

    if (msg.type === "inspect") {
      const jobId = msg.jobId;
      if (!lastPrepared) {
        self.postMessage({ type: "inspect", jobId, items: [], error: "尚无渲染结果" });
        return;
      }
      const t = Math.max(0, Math.min(lastPrepared.frames - 1, msg.t | 0));
      const items = inspectFrame(lastPrepared, t, msg.side === "right" ? "right" : "left");
      self.postMessage({ type: "inspect", jobId, t, side: msg.side, items });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", jobId: msg.jobId, message: String(err && err.stack ? err.stack : err) });
  }
};
