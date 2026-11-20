// worker.mjs — 重投影计算 Worker：帧内分批 + 帧间让出，页面始终保持响应
// runId 完全由主线程分配，worker 不自增，保证取消/改参数后新旧 run 判定一致。
import { validateSequence, clampParams, computePixelDebug, Reason } from './core.mjs';

let activeRunId = -1;
let computeTimer = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'run') {
    activeRunId = msg.runId; // 主线程权威 runId
    startRun(msg);
  } else if (msg.type === 'cancel') {
    if (msg.runId === activeRunId) activeRunId = -1;
    if (computeTimer) {
      clearTimeout(computeTimer);
      computeTimer = null;
    }
    self.postMessage({ type: 'cancelled', runId: msg.runId });
  }
};

function startRun(msg) {
  const myRunId = msg.runId;
  const { seq, params: rawParams } = msg;
  const check = validateSequence(seq);
  if (!check.ok) {
    self.postMessage({ type: 'error', runId: myRunId, errors: check.errors });
    return;
  }
  seq._meta = check;
  const params = clampParams(rawParams);
  const n = check.pixelCount;
  const F = seq.frames.length;
  const CHUNK = 1024; // 每片像素数，约 1ms 量级

  let prevColor = new Float64Array(n * 3);
  let prevCount = new Int32Array(n);
  let fi = 0;
  const t0 = performance.now();

  const stillActive = () => myRunId === activeRunId;

  const finishFrame = (color, count, reason) => {
    // 先保留本帧副本作为下一帧的 prev，再把原缓冲零拷贝转移给主线程
    const prevColorCopy = new Float64Array(color);
    const prevCountCopy = new Int32Array(count);
    self.postMessage(
      { type: 'frame', runId: myRunId, frame: fi,
        color: color.buffer, count: count.buffer, reason: reason.buffer },
      [color.buffer, count.buffer, reason.buffer]
    );
    if (!stillActive()) return; // 已被取消 / 新 run 取代
    prevColor = prevColorCopy;
    prevCount = prevCountCopy;
    fi++;
    if (fi >= F) {
      self.postMessage({
        type: 'done', runId: myRunId, frameCount: F,
        elapsedMs: Math.round(performance.now() - t0), params,
      });
      return;
    }
    computeTimer = setTimeout(runFrame, 0);
  };

  const runFrame = () => {
    if (!stillActive()) return;
    const frame = seq.frames[fi];

    if (fi === 0) {
      // 首帧快速路径（含深度为空判定）
      const color = new Float64Array(n * 3);
      const count = new Int32Array(n);
      const reason = new Uint8Array(n);
      for (let p = 0; p < n; p++) {
        const c = frame.color[p];
        color[p * 3] = c[0];
        color[p * 3 + 1] = c[1];
        color[p * 3 + 2] = c[2];
        count[p] = 1;
        reason[p] = (frame.depth[p] === null || frame.depth[p] === undefined)
          ? Reason.DEPTH_NULL : Reason.FIRST_FRAME;
      }
      finishFrame(color, count, reason);
      return;
    }

    // 逐像素分批，每片后让出事件循环以响应 cancel / 新 run
    const color = new Float64Array(n * 3);
    const count = new Int32Array(n);
    const reason = new Uint8Array(n);
    let p = 0;
    const doChunk = () => {
      if (!stillActive()) return;
      const end = Math.min(n, p + CHUNK);
      for (; p < end; p++) {
        const x = p % seq.width;
        const y = (p - x) / seq.width;
        // 复用核心的逐像素实现（与 computeFrame 同一函数，保证口径一致）
        const dbg = computePixelDebug(seq, fi, x, y, prevColor, prevCount, params);
        color[p * 3] = dbg.outputColor[0];
        color[p * 3 + 1] = dbg.outputColor[1];
        color[p * 3 + 2] = dbg.outputColor[2];
        count[p] = dbg.count;
        reason[p] = dbg.reason;
      }
      if (p < n) {
        computeTimer = setTimeout(doChunk, 0);
      } else {
        finishFrame(color, count, reason);
      }
    };
    doChunk();
  };

  computeTimer = setTimeout(runFrame, 0);
}
