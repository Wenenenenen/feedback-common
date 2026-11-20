/**
 * 求解流水线：Worker 与主线程回退共用，保证两条路径数值完全一致。
 * 通信通过 post 回调；transferables 在 Worker 模式下可零拷贝移交。
 */
import { buildModel } from './model.js';
import { conjugateGradient } from './solver.js';

export function runReconstruction(p, post) {
  const {
    W, H, channels, kernel, lambda, tol, maxIter,
    shifts, weightBands, frameBands,
  } = p;

  const frames = shifts.map((shift, f) => ({ shift, weights: weightBands[f] }));
  const model = buildModel(W, H, kernel, frames);
  const F = shifts.length;
  const channelSummaries = [];

  for (let ch = 0; ch < channels; ch++) {
    const yVecs = frameBands.map((bands) => bands[ch]);
    const b = model.makeRhs(yVecs);
    let constY = 0;
    model.frames.forEach((fd, f) => {
      const y = yVecs[f];
      for (let q = 0; q < model.M; q++) constY += fd.weights[q] * y[q] * y[q];
    });

    const result = conjugateGradient(model, b, lambda, tol, maxIter, {
      constY,
      abortSignal: p.abortSignal || null,
      onIteration: (info) => post({ type: 'progress', channel: ch, ...info }),
    });

    const B = new Float64Array(model.N);
    const residuals = [];
    const weightedRmse = [];
    for (let f = 0; f < F; f++) {
      const r = model.residual(result.x, f, yVecs[f], B);
      residuals.push(r);
      let acc = 0;
      const w = model.frames[f].weights;
      for (let q = 0; q < model.M; q++) acc += w[q] * r[q] * r[q];
      weightedRmse.push(Math.sqrt(acc / model.M));
    }

    let partialCount = 0;
    for (let f = 0; f < F; f++) {
      for (let v = 0; v < H; v++) {
        for (let u = 0; u < W; u++) {
          if (model.bilinearCoverage(f, u, v) < 1 - 1e-15) partialCount++;
        }
      }
    }
    let zeroMaskCount = 0;
    for (const fd of model.frames) {
      for (let q = 0; q < model.M; q++) if (fd.weights[q] === 0) zeroMaskCount++;
    }

    let below = 0;
    let above = 0;
    for (let n = 0; n < model.N; n++) {
      if (result.x[n] < 0) below++;
      else if (result.x[n] > 1) above++;
    }

    const xBuffer = result.x.buffer;
    const residualBuffers = residuals.map((r) => r.buffer);
    post(
      {
        type: 'channelDone',
        channel: ch,
        iterations: result.iterations,
        stopReason: result.stopReason,
        finalRelResidual: result.finalRelResidual,
        history: result.history,
        residualBuffers,
        weightedRmse,
        stats: {
          partialSamples: partialCount,
          zeroMaskSamples: zeroMaskCount,
          belowZero: below,
          aboveOne: above,
          totalGrid: model.N,
        },
        xBuffer,
      },
      [xBuffer, ...residualBuffers]
    );
    channelSummaries.push({ iterations: result.iterations, stopReason: result.stopReason });
  }

  post({
    type: 'done',
    dims: { W, H, GW: model.GW, GH: model.GH, channels, frames: F },
    channelResults: channelSummaries,
  });
  return model;
}
