// 计算 Worker：块打分与分段投票。与主线程共用 core.js，保证结果逐位一致。
// 打分与投票都在调用方给定的绝对坐标下工作；共享内存由主线程分配，Worker 只读写视图。

import * as Core from './core.js';

function scoreTables(msg) {
  const { copyIndex, blockStart, blockEnd, anchorKeys, anchorValid, copyKeys, copyValid,
    blocks, anchorFrames, copyFrames } = msg;
  const count = blockEnd - blockStart;
  const out = new Int32Array(count * 2 * Core.OFFSET_COUNT);
  for (let b = blockStart; b < blockEnd; b++) {
    const { eq, neq } = Core.scoreBlock(
      anchorKeys, anchorValid, 0, copyKeys, copyValid, 0,
      blocks[b], anchorFrames, copyFrames,
    );
    const o = (b - blockStart) * 2 * Core.OFFSET_COUNT;
    out.set(eq, o);
    out.set(neq, o + Core.OFFSET_COUNT);
  }
  return { copyIndex, blockStart, blockCount: count, tables: out.buffer };
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'score') {
      const res = scoreTables(msg);
      self.postMessage({ id: msg.id, ...res }, [res.tables]);
    } else if (msg.type === 'vote') {
      Core.voteRange(msg.reads, msg.start, msg.end, msg.out);
      self.postMessage({ id: msg.id, ok: true });
    } else {
      self.postMessage({ id: msg.id, error: `未知消息类型：${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: err && err.message ? err.message : String(err) });
  }
};
