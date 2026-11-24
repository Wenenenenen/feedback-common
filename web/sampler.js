// 采样运行器：分块执行、可取消、runId 代际保护。
// 取消语义（按需求）：取消后可改参数重跑；旧任务任何迟到结果都不得覆盖新结果。
// 拒收样本只记录不重抽，且始终留在总次数分母中。

'use strict';

import {
  v3, makeFrame, validateParams, sampleAttempt, binOf, BIN_REJECT, NB, NP,
} from './microfacet-core.js';

const CHUNK = 4000; // 每个同步块的尝试次数，块间让出主线程以响应取消与重绘

// 运行结果（完成或取消均产出；取消时 partial=true）
function allocateStore(count) {
  return {
    count,
    // 每次尝试一份记录（含拒收）。Float32 足够查询展示，种子状态用 u32 存。
    lx: new Float32Array(count),
    ly: new Float32Array(count),
    lz: new Float32Array(count),
    hx: new Float32Array(count),
    hy: new Float32Array(count),
    hz: new Float32Array(count),
    pH: new Float32Array(count), // 采样半向量密度（采样到的 h）
    pL: new Float32Array(count), // 反射方向密度（有效 h=normalize(v+l) 换算；拒收为 0）
    weight: new Float32Array(count), // BRDF·lz/p(l)；拒收为 0
    u1: new Float32Array(count),
    u2: new Float32Array(count),
    seedState: new Uint32Array(count), // 该次尝试推进后的 xorshift 状态
    bin: new Int16Array(count), // -1 = 拒收
    acceptedCount: 0,
    rejectCount: 0,
    energySum: 0,
  };
}

// 启动一次运行。onProgress(completed, total, partialStats) 周期性回调。
// 返回 { runId, promise }；cancel(runId) 请求取消。
export class SamplerController {
  constructor() {
    this.runId = 0;
    this.running = false;
  }

  cancel() {
    this.runId++; // 代际递增：旧块醒来即自行作废
    this.running = false;
    return this.runId;
  }

  run(params, onProgress) {
    const myId = ++this.runId;
    this.running = true;
    const errs = validateParams(params);
    if (errs.length) {
      this.running = false;
      return Promise.resolve({ runId: myId, ok: false, errors: errs });
    }

    const frame = makeFrame(params.angleDeg);
    const vWorld = v3.normalize(params.view);
    const { ax, ay, F0 } = params;
    const n = params.count;
    const store = allocateStore(n);

    return new Promise((resolve) => {
      let i = 0;
      let state = params.seed >>> 0;

      const step = () => {
        if (myId !== this.runId) {
          // 已被取消或被新运行取代：不覆盖任何当前结果
          resolve({ runId: myId, ok: false, cancelled: true, superseded: true, partial: truncate(store, i) });
          return;
        }
        const end = Math.min(i + CHUNK, n);
        for (; i < end; i++) {
          const a = sampleAttempt(state, vWorld, frame, ax, ay, F0);
          state = a.state;
          store.seedState[i] = a.state;
          store.u1[i] = a.u1;
          store.u2[i] = a.u2;
          store.hx[i] = a.hWorld[0];
          store.hy[i] = a.hWorld[1];
          store.hz[i] = a.hWorld[2];
          store.lx[i] = a.lWorld[0];
          store.ly[i] = a.lWorld[1];
          store.lz[i] = a.lWorld[2];
          store.pH[i] = a.pH;
          store.pL[i] = a.pL;
          store.weight[i] = a.weight;
          const bin = a.accepted ? binOf(a.lWorld) : BIN_REJECT;
          store.bin[i] = bin;
          if (a.accepted) {
            store.acceptedCount++;
            store.energySum += a.weight;
          } else {
            store.rejectCount++;
          }
        }

        if (i >= n) {
          this.running = false;
          if (myId !== this.runId) {
            resolve({ runId: myId, ok: false, cancelled: true, superseded: true, partial: truncate(store, i) });
            return;
          }
          resolve({
            runId: myId,
            ok: true,
            cancelled: false,
            params: { ...params, view: vWorld.slice() },
            store,
            energyEstimate: store.energySum / n, // 拒收记 0，分母为总尝试次数
            rejectRate: store.rejectCount / n,
          });
          return;
        }

        if (onProgress) {
          onProgress(i, n, {
            accepted: store.acceptedCount,
            rejected: store.rejectCount,
            energySoFar: store.energySum / i,
          });
        }
        setTimeout(step, 0);
      };
      setTimeout(step, 0);
    });
  }
}

function truncate(store, filled) {
  return { ...store, count: filled, filled, truncated: true };
}

export { NB, NP, BIN_REJECT };
