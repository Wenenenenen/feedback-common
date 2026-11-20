// 计算 Worker：在后台线程跑完整 Census-SGM 管线，主线程只做渲染与交互。
// 代价卷 / 聚合卷保留在本 Worker 内，检查台按需请求单个像素的回放数据。
import * as core from './core.js';

let current = null; // { width, height, D, params, cost, S, Sr, forward, reverse, ... }

function stripped(result) {
  const fwd = result.forward;
  const rev = result.reverse;
  return {
    width: result.width,
    height: result.height,
    D: result.D,
    params: result.params,
    d0i: fwd.d0i,
    S0: fwd.S0,
    S2: fwd.S2,
    uniqOk: fwd.uniqOk,
    delta: fwd.delta,
    dFwd: fwd.d,
    reasonFwd: fwd.reason,
    dRev: rev.d,
    reasonRev: rev.reason,
    dRAt: result.dRAt,
    final: result.final,
    reason: result.reason,
    timings: result.timings,
  };
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'compute') {
      const { width: W, height: H, left, right, params, truth, label } = msg;
      const leftGray = new Uint8Array(left);
      const rightGray = new Uint8Array(right);
      const result = core.compute(leftGray, rightGray, W, H, params);
      current = result;
      const stats = {
        zeroDisparity: 0,
        valid: 0,
        reasonCounts: [0, 0, 0, 0],
      };
      for (let i = 0; i < W * H; i++) {
        if (!Number.isNaN(result.final[i])) {
          stats.valid++;
          if (result.final[i] === 0) stats.zeroDisparity++;
        }
        stats.reasonCounts[result.reason[i]]++;
      }
      let evaluation = null;
      if (truth) {
        const t = new Uint16Array(truth);
        evaluation = core.evaluate(result.final, t, W, H);
      }
      const payload = stripped(result);
      const transfer = [
        payload.d0i.buffer, payload.S0.buffer, payload.S2.buffer, payload.uniqOk.buffer,
        payload.delta.buffer, payload.dFwd.buffer, payload.reasonFwd.buffer,
        payload.dRev.buffer, payload.reasonRev.buffer, payload.dRAt.buffer,
        payload.final.buffer, payload.reason.buffer,
      ];
      self.postMessage({ type: 'result', id: msg.id, payload, stats, evaluation, label, transfer }, transfer);
      return;
    }

    if (msg.type === 'explain') {
      if (!current) throw new Error('尚无计算结果');
      const { x, y, reverse } = msg;
      const W = current.width, H = current.height;
      if (!(x >= 0 && x < W && y >= 0 && y < H)) throw new Error('像素坐标越界');
      const ex = core.explainPixel(current, x, y, !!reverse);
      // 只把选中像素的曲线回传，代价卷留在 Worker
      self.postMessage({
        type: 'explain',
        id: msg.id,
        x, y,
        reverse: !!reverse,
        cost: ex.rawCost,
        sum: ex.sum,
        storedS: ex.storedS,
        dirs: ex.dirs.map((d) => ({
          dx: d.dir.dx, dy: d.dir.dy, name: d.dir.name,
          L: d.L, winners: d.winners,
        })),
      });
      return;
    }

    throw new Error('未知的 Worker 消息类型');
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: err && err.message ? err.message : String(err),
      name: err && err.name ? err.name : 'Error',
    });
  }
};
