// 端到端：node tests/e2e.mjs
// 自动起静态服务器（仓库根），用全局 Playwright/Chromium。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    res.writeHead(200, { 'content-type': mime[extname(fp)] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  } catch {
    res.writeHead(404); res.end('not found: ' + p);
  }
});
await new Promise((r) => server.listen(8791, '127.0.0.1', r));

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; failures.push(m); console.error('  ✗ ' + m); } }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('CONSOLE: ' + m.text()); });

await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('#cp-tbody tr');

console.log('\n[首屏/样例]');
{
  const rows = await page.locator('#cp-tbody tr').count();
  ok(rows === 3, '样例渲染 3 个控制点行: ' + rows);
  const meta = await page.locator('#curve-meta').innerText();
  ok(/p=2/.test(meta) && /控制点\s*3/.test(meta), '元信息正确: ' + meta.replace(/\s+/g, ' '));
  const point = await page.locator('#q-point').innerText();
  ok(point.includes('5/7') && point.includes('5/7'), '首屏自动查询 1/2 精确坐标 (5/7,5/7): ' + point);
  const l = await page.locator('#q-left-exact').innerText();
  const rr = await page.locator('#q-right-exact').innerText();
  ok(l.includes('-8/7') && l.includes('8/7'), '左导数黄金值: ' + l);
  ok(rr.includes('-8/7'), '右导数黄金值: ' + rr);
  ok((await page.locator('#btn-undo').isDisabled()), '初始撤销按钮禁用');
  ok((await page.locator('#btn-redo').isDisabled()), '初始重做按钮禁用');
}

console.log('\n[端点单侧]');
{
  await page.fill('#query-u', '0');
  await page.click('#btn-query');
  ok((await page.locator('#q-left-exact').innerText()).includes('不存在'), 'u=0 左导数不存在');
  ok(!(await page.locator('#q-right-exact').innerText()).includes('不存在'), 'u=0 右导数存在');
  await page.fill('#query-u', '1');
  await page.click('#btn-query');
  ok((await page.locator('#q-right-exact').innerText()).includes('不存在'), 'u=1 右导数不存在');
  ok(!(await page.locator('#q-left-exact').innerText()).includes('不存在'), 'u=1 左导数存在');
  await page.fill('#query-u', '1/2');
  await page.click('#btn-query');
}

console.log('\n[插入分数节点 → 撤销/重做]');
let jsonAfterInsert;
{
  await page.fill('#insert-u', '1/2');
  await page.click('#btn-insert-knot');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 4);
  ok(await page.locator('#cp-tbody tr').count() === 4, '插入后 4 个控制点');
  const hist = await page.locator('#history-info').innerText();
  ok(/undo 1/.test(hist), 'undo 计数为 1: ' + hist);
  jsonAfterInsert = await page.inputValue('#export-json');
  const obj = JSON.parse(jsonAfterInsert);
  ok(obj.knots.includes('1/2'), '导出 JSON 含新节点 1/2');
  ok(obj.points.length === 4 && obj.knots.length === 7, '节点/控制点数量正确');
  // 齐次不变性由 node 测试保证；这里验证导出分数均为约分字符串
  ok(obj.points.every(([x, y, w]) => typeof x === 'string' && !/\/$/.test(x)), '分量为字符串');

  await page.click('#btn-undo');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 3);
  ok(await page.locator('#cp-tbody tr').count() === 3, '撤销后回到 3 点');
  ok(!(await page.locator('#btn-redo').isDisabled()), '重做按钮可用');
  await page.click('#btn-redo');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 4);
  ok(await page.locator('#cp-tbody tr').count() === 4, '重做后又是 4 点');
}

console.log('\n[删除刚插入的节点 → 精确复原]');
{
  // 选中 knot r=3 并删除
  await page.click('.knot-chip[data-select-r="3"]');
  await page.click('#btn-remove-knot');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 3);
  const json = await page.inputValue('#export-json');
  const obj = JSON.parse(json);
  ok(JSON.stringify(obj.knots) === JSON.stringify(['0', '0', '0', '1', '1', '1']),
    '删除后节点完全复原: ' + JSON.stringify(obj.knots));
  ok(obj.points[1][0] === '3/4' && obj.points[1][2] === '3/4', '控制点精确复原');
}

console.log('\n[失败删除不改曲线、不吞 redo]');
{
  // 插入 1/2，撤销回 3 点（redo 栈里有插入后的状态）
  await page.fill('#insert-u', '1/2');
  await page.click('#btn-insert-knot');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 4);
  await page.click('#btn-undo');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 3);
  ok(await page.locator('#btn-redo').isEnabled(), '前置：redo 可用');

  // 直接构造一次必然失败的删除（非法下标，经全局 API）
  const fail = await page.evaluate(() => {
    const before = window.RKS.studio.snapshot();
    const r = window.RKS.studio.removeKnotAt(999);
    return { ok: r.ok, canRedo: window.RKS.studio.canRedo, after: window.RKS.studio.snapshot() === before };
  });
  ok(fail.ok === false, '非法删除返回失败');
  ok(fail.canRedo === true, '失败后 redo 仍保留');
  ok(fail.after === true, '失败后快照不变');
  // UI 上重做仍可点且有效
  ok(await page.locator('#btn-redo').isEnabled(), 'UI 重做按钮仍可用');
  await page.click('#btn-redo');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 4);
  ok(true, 'redo 未被吞掉，成功恢复插入态');

  // 移动一个点后，删除 1/2 应被拒绝
  await page.click('#cp-tbody tr[data-i="1"]');
  await page.fill('#cp-x', '2');
  await page.fill('#cp-y', '2');
  await page.click('#btn-move-cp');
  const rm = await page.evaluate(() => {
    const st = window.RKS.studio;
    const r = st.curve.knots.findIndex((k, i) => i >= 3 && k.eq(window.RKS.Frac.parse('1/2')));
    const before = st.snapshot();
    const res = st.removeKnotAt(r);
    return { ok: res.ok, error: res.error, unchanged: st.snapshot() === before, canRedo: st.canRedo };
  });
  ok(rm.ok === false, '移动后删除被拒绝: ' + (rm.error || ''));
  ok(rm.unchanged, '被拒后曲线不变');
}

console.log('\n[移点保 W / 改权重保投影]');
{
  const wBefore = await page.evaluate(() => window.RKS.studio.curve.points[0].W.toString());
  await page.click('#cp-tbody tr[data-i="0"]');
  await page.fill('#cp-x', '1/3');
  await page.fill('#cp-y', '-2/5');
  await page.click('#btn-move-cp');
  const moved = await page.evaluate(() => {
    const p = window.RKS.studio.curve.points[0];
    return { W: p.W.toString(), X: p.X.toString(), Y: p.Y.toString() };
  });
  ok(moved.W === wBefore && wBefore === '1', '移点保留 W (=1): ' + moved.W);
  ok(moved.X === '1/3' && moved.Y === '-2/5', 'X=x*W=1/3, Y=y*W=-2/5: ' + moved.X + ',' + moved.Y);

  // 改权重保投影
  await page.fill('#cp-w', '4');
  await page.click('#btn-set-weight');
  const w = await page.evaluate(() => {
    const p = window.RKS.studio.curve.points[0];
    return { W: p.W.toString(), projX: p.X.div(p.W).toString(), projY: p.Y.div(p.W).toString() };
  });
  ok(w.W === '4', '权重改为 4');
  ok(w.projX === '1/3' && w.projY === '-2/5', '改权重后投影不变: ' + w.projX + ',' + w.projY);
}

console.log('\n[重复尖角节点：UI 两侧导数]');
{
  // 导入专门的尖角曲线
  const corner = {
    degree: 2,
    knots: ['0', '0', '0', '1/2', '1/2', '1', '1', '1'],
    points: [['0', '0', '1'], ['1', '0', '1'], ['1', '1', '1'], ['2', '1', '1'], ['2', '2', '1']],
  };
  await page.fill('#import-json', JSON.stringify(corner));
  await page.click('#btn-import-json');
  await page.waitForFunction(() => window.RKS.studio.curve.points.length === 5);
  await page.fill('#query-u', '1/2');
  await page.click('#btn-query');
  const l = await page.locator('#q-left-exact').innerText();
  const rr = await page.locator('#q-right-exact').innerText();
  ok(/\(0, 4\)/.test(l), '左导数竖直向上 (0,4): ' + l);
  ok(/\(4, 0\)/.test(rr), '右导数水平向右 (4,0): ' + rr);
}

console.log('\n[SVG 导出与 DOM 预览]');
{
  const svgText = await page.inputValue('#export-svg');
  ok(svgText.includes('<svg') && svgText.includes('data-u0') && svgText.includes('rks-segment'),
    '导出 SVG 含 rks-segment 与 data-u0');
  const domSegs = await page.locator('#svg-export-host polyline.rks-segment').count();
  ok(domSegs > 0, 'DOM 预览中存在段元素: ' + domSegs);
  const attrs = await page.evaluate(() => {
    const el = document.querySelector('#svg-export-host [data-u0][data-u1]');
    return el ? { u0: el.getAttribute('data-u0'), u1: el.getAttribute('data-u1'), points: el.getAttribute('points') } : null;
  });
  ok(attrs && attrs.points && attrs.u0 != null && attrs.u1 != null, '段属性完整: ' + JSON.stringify(attrs));

  // 在浏览器内按检查器方式验证 0.25 契约
  const worst = await page.evaluate(() => {
    const R = window.RKS;
    const c = R.studio.curve;
    let worst = 0;
    document.querySelectorAll('#svg-export-host polyline.rks-segment').forEach((el) => {
      const u0 = parseFloat(el.getAttribute('data-u0'));
      const u1 = parseFloat(el.getAttribute('data-u1'));
      const pts = el.getAttribute('points').trim().split(/\s+/);
      const a = pts[0].split(',').map(Number);
      const b = pts[1].split(',').map(Number);
      for (let j = 0; j <= 80; j++) {
        const t = j / 80, u = u0 + t * (u1 - u0);
        const ref = R.evalPointFloat(c, null, u);
        if (!ref) continue;
        const qx = a[0] + t * (b[0] - a[0]);
        const qy = a[1] + t * (b[1] - a[1]);
        worst = Math.max(worst, Math.hypot(ref[0] - qx, ref[1] - qy));
      }
    });
    return worst;
  });
  ok(worst <= 0.25, '浏览器内逐段验证最大误差 ' + worst.toFixed(4) + ' ≤ 0.25');
  const stats = await page.locator('#svg-stats').innerText();
  ok(/最大偏差/.test(stats), '显示自检统计: ' + stats);
}

console.log('\n[513 上限与非法输入]');
{
  const bad = { degree: 2, knots: [], points: [] };
  for (let i = 0; i < 513; i++) bad.points.push([String(i), '0', '1']);
  bad.knots = ['0', '0', '0'];
  for (let i = 0; i < 510; i++) bad.knots.push(String(i + 1));
  bad.knots.push('511', '511', '511');
  await page.fill('#import-json', JSON.stringify(bad));
  await page.click('#btn-import-json');
  const status = await page.locator('#status-message').innerText();
  ok(/512/.test(status), '513 控制点被拒绝并提示: ' + status.slice(0, 80));
  ok(await page.locator('#cp-tbody tr').count() === 5, '拒绝后仍是原 5 点曲线（不改原曲线）');

  await page.fill('#insert-u', 'not-a-number');
  await page.click('#btn-insert-knot');
  const s2 = await page.locator('#status-message').innerText();
  ok(/失败|无法解析/.test(s2), '非法节点输入有失败提示');
}

console.log('\n[键盘撤销/重做]');
{
  // 当前是导入的尖角曲线（导入会重置历史）。做一次权重编辑再用快捷键撤销/重做。
  await page.click('#cp-tbody tr[data-i="0"]');
  await page.fill('#cp-w', '3');
  await page.click('#btn-set-weight');
  const w3 = await page.evaluate(() => window.RKS.studio.curve.points[0].W.toString());
  ok(w3 === '3', '前置：权重=3');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.RKS.studio.curve.points[0].W.toString() === '1');
  ok(true, 'Ctrl+Z 撤销权重编辑，W 恢复 1');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => window.RKS.studio.curve.points[0].W.toString() === '3');
  ok(true, 'Ctrl+Y 重做，W 恢复 3');
}

console.log('\n[稳定 rksAPI 契约]');
{
  const api = await page.evaluate(() => {
    const A = window.rksAPI;
    A.load({ degree: 2, knots: ['0', '0', '0', '1', '1', '1'],
      points: [['1', '0', '1'], ['3/4', '3/4', '3/4'], ['0', '1', '1']] });
    const q = A.query('1/2');
    const seg = A.segments();
    const hist0 = A.history();
    const ins = A.insertKnot('2/5');
    const hist1 = A.history();
    const rm = A.removeKnotValue('2/5');
    const hist2 = A.history();
    let serializable = true;
    let json = '';
    try { json = JSON.stringify(q); } catch { serializable = false; }
    return {
      has: !!A,
      qx: q.point.x, ldx: q.left.dx, rdy: q.right.dy,
      segCount: seg.count, limit: seg.limit, hasSvg: typeof seg.svg === 'string',
      insOk: ins.ok, rmOk: rm.ok,
      nAfter: A.json().points.length,
      hist0, hist1, hist2,
      serializable: serializable && json.includes('5/7'),
    };
  });
  ok(api.has, 'window.rksAPI 存在');
  ok(api.qx === '5/7' && api.ldx === '-8/7' && api.rdy === '8/7', 'query() 返回精确纯字符串');
  ok(api.segCount > 0 && api.limit === 0.25 && api.hasSvg, 'segments() 契约');
  ok(api.hist0.undo === 0 && api.insOk && api.hist1.undo === 1, 'API 插入进入 undo 栈');
  ok(api.rmOk && api.nAfter === 3, 'API 按值删除复原到样例 3 点: ' + api.nAfter);
  ok(api.hist2.undo === 2, '删除也是一次独立成功编辑');
  ok(api.serializable, 'query 结果可 JSON 序列化');
}

console.log('\n[JS 错误检查]');
ok(pageErrors.length === 0, '无页面/控制台错误' + (pageErrors.length ? ':\n' + pageErrors.slice(0, 5).join('\n') : ''));

await page.screenshot({ path: join(here, 'e2e-final.png'), fullPage: false });
await browser.close();

/* ---------------- file:// 入口 ---------------- */
console.log('\n[file:// 直接打开]');
const b2 = await chromium.launch();
const pg2 = await b2.newPage();
const errs2 = [];
pg2.on('pageerror', (e) => errs2.push(e.message));
await pg2.goto(pathToFileURL(join(root, 'index.html')).href, { waitUntil: 'load' });
await pg2.waitForSelector('#cp-tbody tr');
const rows = await pg2.locator('#cp-tbody tr').count();
ok(rows === 3, 'file:// 下经典脚本正常启动并渲染内置样例');
const qp = await pg2.locator('#q-point').innerText();
ok(qp.includes('5/7'), 'file:// 下查询正常: ' + qp);
ok(errs2.length === 0, 'file:// 无页面错误' + (errs2.length ? '; ' + errs2.join(' | ') : ''));
await b2.close();

server.close();
console.log(`\nE2E 结果: ${pass} 通过, ${fail} 失败`);
if (fail) { console.error('\n失败:\n - ' + failures.join('\n - ')); process.exit(1); }
