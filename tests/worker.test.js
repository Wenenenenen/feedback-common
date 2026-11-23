// Worker 端到端集成测试（Node worker_threads 运行同一份 js/worker.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, '..', 'samples', 'extracted', '双场.l21p');

function startWorker() {
  return new Worker(new URL('../js/worker.js', import.meta.url));
}
function rpc(worker, msg) {
  return new Promise((resolve, reject) => {
    const onMsg = (d) => { worker.off('message', onMsg); worker.off('error', onErr); resolve(d); };
    const onErr = (e) => { worker.off('message', onMsg); reject(e); };
    worker.on('message', onMsg);
    worker.on('error', onErr);
    worker.postMessage(msg);
  });
}

test('Worker 全流程：加载→窗口→跳帧→编辑→撤销→重做→导出', async () => {
  const w = startWorker();
  try {
    const buf = readFileSync(samplePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const load = await rpc(w, { type: 'load', buffer: ab });
    assert.equal(load.ok, true);
    assert.equal(load.recordCount, 6);
    assert.equal(load.totalFrames, 18);

    const win = await rpc(w, { type: 'window', start: 0, count: 6 });
    assert.equal(win.rows.length, 6);
    assert.match(win.rows[1].label, /HI/);

    const j5 = await rpc(w, { type: 'jump', frame: 5 });
    // 帧2场1交换后 CC1 显示 "HI"
    assert.equal(j5.state.channels[0].display[14 * 32], 0x48);
    assert.equal(j5.state.channels[0].display[14 * 32 + 1], 0x49);
    assert.equal(j5.state.channels[0].back[14 * 32], 0);
    assert.ok(j5.ms >= 0);

    // 编辑记录0（原为 94 20 弹出控制）改成文本 "AB"
    const ed = await rpc(w, { type: 'edit', index: 0, newA: 0xc1, newB: 0xc2 });
    assert.equal(ed.result.ok, true);
    assert.equal(ed.undoDepth, 1);
    const win2 = await rpc(w, { type: 'window', start: 0, count: 1 });
    assert.match(win2.rows[0].label, /AB/);

    // 撤销：恢复原控制
    const undo = await rpc(w, { type: 'undo' });
    assert.equal(undo.ok, true);
    assert.equal(undo.redoDepth, 1);
    const win3 = await rpc(w, { type: 'window', start: 0, count: 1 });
    assert.match(win3.rows[0].label, /弹出/);

    // 重做：再次变成 AB
    const redo = await rpc(w, { type: 'redo' });
    assert.equal(redo.ok, true);
    assert.equal(redo.undoDepth, 1);
    const win4 = await rpc(w, { type: 'window', start: 0, count: 1 });
    assert.match(win4.rows[0].label, /AB/);

    // 再撤销回到干净稿后导出
    await rpc(w, { type: 'undo' });
    const exMsg = await rpc(w, { type: 'export', start: 0, end: 18 });
    const ex = exMsg.json;
    assert.equal(ex.start, 0);
    assert.equal(ex.end, 18);
    assert.ok(Array.isArray(ex.cues));
    // 帧3场1交换上屏 HI，S(4) 起可见；帧9清显示，S(10) 起空 → cue [4,10)
    const cc1 = ex.cues.filter((c) => c.channel === 'CC1');
    assert.equal(cc1.length, 1);
    assert.deepEqual([cc1[0].start, cc1[0].end], [4, 10]);
    assert.equal(cc1[0].rows[0].row, 15);
    assert.equal(cc1[0].rows[0].cells.length, 32);
    // 帧4场2 "TV" 直写 CC3，S(5) 起可见，无清除 → cue [5,18)
    const cc3 = ex.cues.filter((c) => c.channel === 'CC3');
    assert.equal(cc3.length, 1);
    assert.deepEqual([cc3[0].start, cc3[0].end], [5, 18]);

    const raf = await rpc(w, { type: 'recordAtFrame', frame: 3 });
    assert.equal(raf.index, 2);
  } finally {
    await w.terminate();
  }
});

test('Worker 结构错误返回偏移且不影响旧稿', async () => {
  const w = startWorker();
  try {
    const good = readFileSync(samplePath);
    const ab1 = good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength);
    assert.equal((await rpc(w, { type: 'load', buffer: ab1 })).ok, true);

    const bad = Uint8Array.from(good);
    bad[16] = 9; // 非法场号
    const r = await rpc(w, { type: 'load', buffer: bad.buffer });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.offset === 16));

    // 旧稿仍可查
    const win = await rpc(w, { type: 'window', start: 0, count: 1 });
    assert.equal(win.rows.length, 1);
  } finally {
    await w.terminate();
  }
});
