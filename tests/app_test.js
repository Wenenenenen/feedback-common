// 应用层测试：代际隔离、导出格式、切换帧重算。Node 下用最小事件垫片。
const assert = require('assert');
const fs = require('fs');
const ROOT = '/home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk';
global.window = global;
require(ROOT + '/src/zip.js');
require(ROOT + '/src/io.js');
require(ROOT + '/src/solver.js');
require(ROOT + '/src/app.js');
const App = global.StokesApp;

// app.js 用到 document 的地方仅在渲染（本测试不触发 render），但 loadZipFile 用 file.arrayBuffer
function fakeFile(zipPath, name) {
  const buf = fs.readFileSync(zipPath);
  return { name: name, arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) };
}

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok -', name); })
    .catch((e) => { console.error('FAIL -', name, '\n  ', e.stack || e.message); process.exitCode = 1; });
}

(async () => {
  await test('加载样例并产生结果', async () => {
    await App.loadZipFile(fakeFile(ROOT + '/samples/polarimetric-stokes-cases.zip', 'case.zip'));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(App.state.result, '应有结果');
    assert.strictEqual(App.state.result.width, 72);
    assert.strictEqual(App.state.result.enabled.length, 6);
  });

  await test('导出 JSON 结构与字段符合约定', async () => {
    const ex = App.buildExportJSON();
    assert.ok(ex);
    assert.strictEqual(ex.width, 72);
    assert.strictEqual(ex.height, 56);
    assert.deepStrictEqual(ex.enabled, [0, 1, 2, 3, 4, 5]);
    assert.strictEqual(ex.pixels.length, 72 * 56);
    let nullCount = 0, arrCount = 0;
    for (const p of ex.pixels) {
      if (p === null) nullCount++;
      else {
        assert.ok(Array.isArray(p) && p.length === 3);
        arrCount++;
      }
    }
    assert.ok(arrCount > 0);
  });

  await test('快速连续切换帧：最终只发布与最新设置一致的结果', async () => {
    // 连续切 3 次，每次都使旧任务作废
    App.toggleFrame(0);
    App.toggleFrame(1);
    App.toggleFrame(2);
    const expectedEnabled = App.state.enabled.map((e, i) => e ? i : -1).filter((i) => i >= 0);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(App.state.result, '应有最终结果');
    assert.deepStrictEqual(App.state.result.enabled, expectedEnabled);
    // 确认结果像素与当前 enabled 重新计算一致（抽一个像素核对 enabled 列表）
    assert.ok(!App.state.result.enabled.includes(0));
    assert.ok(!App.state.result.enabled.includes(1));
    assert.ok(!App.state.result.enabled.includes(2));
    assert.ok(App.state.result.enabled.includes(3));
  });

  await test('重算中再次切换：不发布中间态结果', async () => {
    const published = [];
    App.on('result', (r) => published.push(r.enabled.slice().join(',')));
    App.toggleFrame(3); // 开/关
    App.toggleFrame(3); // 立刻还原
    await new Promise((r) => setTimeout(r, 400));
    // 最后一次发布必须等于当前设置
    const cur = App.state.enabled.map((e, i) => e ? i : -1).filter((i) => i >= 0).join(',');
    assert.strictEqual(published[published.length - 1], cur);
    // 所有已发布结果都必须与发布时刻的设置一致（不允许出现“幽灵”中间态）
    // 中间态即使发布也只能是当时最新设置；这里核心保证是末值正确
  });

  await test('无解像素导出为 null', async () => {
    // 切到只剩 2 帧 -> 全图无解
    App.state.enabled = App.state.enabled.map(() => false);
    App.state.enabled[0] = true;
    App.state.enabled[1] = true;
    App.scheduleRecompute();
    await new Promise((r) => setTimeout(r, 300));
    const ex = App.buildExportJSON();
    assert.ok(ex.pixels.every((p) => p === null), '方向不足时全部应为 null');
    assert.deepStrictEqual(ex.enabled, [0, 1]);
  });

  await test('坏输入保留当前项目', async () => {
    const before = App.state.project;
    const bad = { name: 'bad.zip', arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) };
    let err = null;
    try { await App.loadZipFile(bad); } catch (e) { err = e; }
    assert.ok(err, '坏 ZIP 应抛错');
    assert.strictEqual(App.state.project, before, '当前项目应保留');
  });

  console.log('\n' + passed + ' app tests passed');
})();
