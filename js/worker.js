// 引擎 Worker：持有文档字节、类型化数组、检查点与撤销栈，主线程不碰大状态
// 同时兼容浏览器 Worker（self）与 Node worker_threads（parentPort），便于自动化集成测试
import { parseL21P, editRecordBytes } from './parser.js';
import {
  simulate, jumpToFrame, buildExport, decodeRecord,
  lowerBoundFrame,
} from './engine.js';

const scope = await (async () => {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') return self;
  const { parentPort } = await import('node:worker_threads');
  return {
    postMessage: (m) => parentPort.postMessage(m),
    // Node 回调直接给消息体；浏览器事件包在 e.data 中，这里统一成 { data }
    set onmessage(fn) { parentPort.on('message', (data) => fn({ data })); },
  };
})();

let buffer = null;          // 当前版本原始字节（ArrayBuffer）
let doc = null;             // 类型化数组视图
let checkpoints = [];
let totalFrames = 0;
const undoStack = [];       // { index, oldA, oldB }
const redoStack = [];

function load(nextBuffer) {
  const parsed = parseL21P(nextBuffer);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  buffer = nextBuffer;
  doc = parsed.doc;
  totalFrames = doc.totalFrames;
  undoStack.length = 0;
  redoStack.length = 0;
  const { checkpoints: cps } = simulate(doc, 10000);
  checkpoints = cps;
  return { ok: true, recordCount: doc.recordCount, totalFrames };
}

// 编辑/撤销/重做后的重演算：保留历史栈
function rebuild(nextBuffer) {
  const parsed = parseL21P(nextBuffer);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  buffer = nextBuffer;
  doc = parsed.doc;
  totalFrames = doc.totalFrames;
  const { checkpoints: cps } = simulate(doc, 10000);
  checkpoints = cps;
  return { ok: true, recordCount: doc.recordCount, totalFrames };
}

function snapshotState(state) {
  return {
    channels: state.channels.map((ch) => ({
      mode: ch.mode,
      curRow: ch.curRow,
      curCol: ch.curCol,
      baseRow: ch.baseRow,
      rollRows: ch.rollRows,
      back: ch.back.slice(),
      display: ch.display.slice(),
    })),
    fields: state.fields.map((f) => ({ ...f })),
  };
}

scope.onmessage = (e) => {
  const msg = e.data;
  const reply = (obj) => scope.postMessage({ reqId: msg.reqId, ...obj });
  try {
    if (msg.type === 'load') {
      reply(load(msg.buffer));
      return;
    }
    if (!doc) {
      reply({ type: 'error', message: '尚未成功加载文档' });
      return;
    }
    if (msg.type === 'window') {
      const { start, count } = msg;
      const end = Math.min(doc.recordCount, start + count);
      const rows = [];
      for (let i = start; i < end; i++) {
        const d = decodeRecord(doc.rawA[i], doc.rawB[i], doc.statuses[i]);
        rows.push({
          i,
          frame: doc.frames[i],
          field: doc.fields[i],
          rawA: doc.rawA[i],
          rawB: doc.rawB[i],
          status: doc.statuses[i],
          label: d.label,
          kind: d.kind,
          channel: d.channel,
          parityA: d.parityA,
          parityB: d.parityB,
        });
      }
      reply({ type: 'window', rows, total: doc.recordCount });
      return;
    }
    if (msg.type === 'jump') {
      const F = Math.max(0, Math.min(totalFrames, msg.frame | 0));
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const state = jumpToFrame(doc, checkpoints, F);
      const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      reply({ type: 'jump', frame: F, state: snapshotState(state), ms });
      return;
    }
    if (msg.type === 'edit') {
      const { index, newA, newB } = msg;
      undoStack.push({ index, oldA: doc.rawA[index], oldB: doc.rawB[index] });
      const next = editRecordBytes(buffer, index, newA, newB);
      const result = rebuild(next);
      if (!result.ok) { undoStack.pop(); reply({ type: 'edit', result }); return; }
      redoStack.length = 0; // 新编辑清空重做栈
      reply({ type: 'edit', result, undoDepth: undoStack.length, redoDepth: 0 });
      return;
    }
    if (msg.type === 'undo' || msg.type === 'redo') {
      const from = msg.type === 'undo' ? undoStack : redoStack;
      const to = msg.type === 'undo' ? redoStack : undoStack;
      if (!from.length) {
        reply({ type: msg.type, ok: false });
        return;
      }
      const entry = from.pop();
      // 先记录当前字节，供对侧重做/再撤销使用
      to.push({ index: entry.index, oldA: doc.rawA[entry.index], oldB: doc.rawB[entry.index] });
      const next = editRecordBytes(buffer, entry.index, entry.oldA, entry.oldB);
      const result = rebuild(next);
      reply({
        type: msg.type, ok: true, result,
        undoDepth: undoStack.length, redoDepth: redoStack.length,
      });
      return;
    }
    if (msg.type === 'export') {
      const out = buildExport(doc, totalFrames, msg.start, msg.end);
      reply({ type: 'export', json: out });
      return;
    }
    if (msg.type === 'frameAtRecord') {
      reply({ type: 'frameAtRecord', frame: doc.frames[msg.index] });
      return;
    }
    if (msg.type === 'recordAtFrame') {
      reply({ type: 'recordAtFrame', index: lowerBoundFrame(doc.frames, msg.frame) });
      return;
    }
  } catch (err) {
    reply({ type: 'error', message: String(err && err.stack || err) });
  }
};
