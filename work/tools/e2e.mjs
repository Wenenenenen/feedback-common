// 端到端 DOM 测试：node work/tools/e2e.mjs
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = "/home/wendy/jianzhi/feedback-tasks/chunk-save-upgrader/app";
const SAMPLES = "/home/wendy/jianzhi/feedback-tasks/chunk-save-upgrader/work/samples-extract";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".sav": "application/octet-stream" };

const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const fp = join(ROOT, p === "/" ? "index.html" : p);
  if (!existsSync(fp)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream" });
  res.end(readFileSync(fp));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } }

try {
  await page.goto(base);
  await page.waitForSelector("#loadDemoBtn");

  // ---- 1. 有效样例 ----
  await page.click("#loadDemoBtn");
  await page.waitForSelector("#app:not([hidden])");
  ok((await page.locator(".chunk-item").count()) === 8, "有效样例渲染 8 个区块");
  ok((await page.locator(".entity-card").count()) === 2, "渲染 2 个实体");
  ok((await page.locator(".pill.clean").count()) === 1, "状态条显示通过");
  ok((await page.locator(".diag-empty").count()) === 1, "诊断为空");
  ok(await page.isEnabled("#exportBtn"), "有效世界允许导出");
  // 区块/实体明确标识
  const firstCoord = await page.locator(".chunk-item .coord").first().textContent();
  ok(firstCoord.includes("-4"), "区块坐标明确标识: " + firstCoord);
  const eid = await page.locator(".entity-card .eid").first().textContent();
  ok(eid === "#1", "实体 ID 明确标识");
  // 切片网格 64 格
  ok((await page.locator("#voxelGrid .cell").count()) === 64, "8x8 切片 64 格");

  // ---- 2. 修改方块 ----
  await page.locator('#voxelGrid .cell').nth(10).click();
  await page.fill("#idInput", "12345");
  await page.click("#applyIdBtn");
  ok((await page.inputValue("#idInput")) === "12345", "方块 ID 可编辑");
  // 非法 ID 被拒
  await page.fill("#idInput", "99999");
  await page.click("#applyIdBtn");
  ok(await page.isVisible("#veErr:not([hidden])"), "非法方块 ID 被拒绝并提示");
  // 高度切片切换
  await page.click("#layerUp");
  ok((await page.textContent("#layerLabel")).includes("z = 1"), "切片可按高度切换");
  await page.click("#layerDown");

  // ---- 3. 含实体区块禁止删除 ----
  // 实体 #1 在 (-4,0,0)，其删除按钮应禁用
  const delBtn = page.locator('.chunk-item[data-key="-4,0,0"] [data-del]');
  ok(await delBtn.isDisabled(), "含实体区块的删除按钮禁用");
  // 无实体区块可删除（找一个没有实体的区块，先备份计数）
  const before = await page.locator(".chunk-item").count();
  // (-3,0,0) 无实体
  const del3 = page.locator('.chunk-item[data-key="-3,0,0"] [data-del]');
  ok(await del3.isEnabled(), "无实体区块允许删除");
  await del3.click();
  ok((await page.locator(".chunk-item").count()) === before - 1, "删除后区块数减一");

  // ---- 4. 移动实体 ----
  await page.click('.entity-card [data-move="1"]');
  await page.waitForSelector("#moveForm-1:not([hidden])");
  await page.selectOption("#mf-chunk-1", "3,0,0");
  await page.fill("#mf-cell-1", "42");
  await page.click("#mf-apply-1");
  const loc1 = await page.locator('.entity-card[data-eid="1"] .loc').textContent();
  ok(loc1.includes("3,0,0") && loc1.includes("42"), "实体移动生效: " + loc1);
  // 添加悬空链接被拒
  await page.click('.entity-card [data-move="1"]');
  await page.fill("#mf-link-1", "777");
  await page.click("#mf-addlink-1");
  ok(await page.isVisible("#mf-err-1:not([hidden])"), "悬空链接添加被拒绝");
  // 添加合法链接
  await page.fill("#mf-link-1", "2");
  await page.click("#mf-addlink-1");
  const links1 = await page.locator('.entity-card[data-eid="1"] .links').textContent();
  ok(links1.includes("→2"), "合法链接添加成功");

  // ---- 5. 导出并回读（roundtrip）----
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn"),
  ]);
  const outPath = "/tmp/gwsv-export.sav";
  await download.saveAs(outPath);
  const note = await page.textContent("#roundtripNote");
  ok(note.includes("回读校验通过"), "导出时页面内回读校验通过");
  // 重新导入导出文件
  await page.setInputFiles("#fileInput", outPath);
  await page.waitForSelector("#app:not([hidden])");
  ok(await page.isEnabled("#exportBtn"), "回读文件可再次导出");
  ok((await page.locator(".entity-card").count()) === 2, "回读后实体数一致");
  const loc1b = await page.locator('.entity-card[data-eid="1"] .loc').textContent();
  ok(loc1b.includes("3,0,0") && loc1b.includes("42"), "回读后实体位置保持");
  const links1b = await page.locator('.entity-card[data-eid="1"] .links').textContent();
  ok(links1b.includes("→2"), "回读后引用关系保持");
  // 二次导出字节一致（幂等）
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const p2 = "/tmp/gwsv-export2.sav";
  await dl2.saveAs(p2);
  const b1 = readFileSync(outPath), b2 = readFileSync(p2);
  ok(b1.equals(b2), "规范化编码字节级幂等");

  // ---- 6. 损坏 CRC：不作为正常世界 ----
  await page.selectOption("#sampleSelect", "crc");
  ok((await page.locator(".pill.crit").count()) >= 1, "CRC 损坏显示严重状态");
  const crcDiag = await page.locator(".diag-item .d-msg").first().textContent();
  ok(crcDiag.includes("CRC 校验失败"), "诊断指出 CRC 失败: " + crcDiag);
  const off = await page.locator(".diag-item .d-off").first().textContent();
  ok(off.includes("offset 84"), "诊断给出字节偏移: " + off);
  ok(await page.isDisabled("#exportBtn"), "损坏世界禁止导出");
  ok((await page.locator(".chunk-badge.err").count()) >= 1, "不可读区块有明确标记");
  // 切片显示斜纹不可读而非方块
  await page.locator('.chunk-item[data-key="-4,0,0"]').click();
  ok((await page.locator(".unreadable-cell").count()) === 64, "损坏区块不渲染为正常方块");

  // ---- 7. 四个真实损坏样例（文件输入）----
  async function loadSample(name) {
    await page.setInputFiles("#fileInput", `${SAMPLES}/${name}`);
    await page.waitForSelector("#app:not([hidden])");
  }
  async function loadSampleViaPath(path) {
    await page.setInputFiles("#fileInput", path);
    await page.waitForSelector("#app:not([hidden])");
  }
  await loadSample("dangling.sav");
  const dang = await page.locator(".diag-item .d-msg").allTextContents();
  ok(dang.some((t) => t.includes("实体 1") && t.includes("99")), "悬空引用指出实体 ID: " + dang.join("|"));
  ok(await page.isDisabled("#exportBtn"), "悬空引用禁止导出");
  ok((await page.locator(".link-target.dangling").count()) >= 1, "悬空链接有视觉标记");

  await loadSample("bad-index.sav");
  const idxDiag = await page.locator(".diag-item .d-msg").allTextContents();
  ok(idxDiag.some((t) => t.includes("非法调色板索引") && t.includes("cell=0")), "非法索引指出 cell: " + idxDiag.join("|"));
  const idxOff = await page.locator(".diag-item .d-off").allTextContents();
  ok(idxOff.some((t) => t.includes("offset 24")), "非法索引给出偏移 24");
  ok(await page.isDisabled("#exportBtn"), "非法索引禁止导出");

  await loadSample("truncated.sav");
  ok((await page.locator(".pill.fatal").count()) >= 1, "截断文件显示致命错误面板");
  const fatalTxt = await page.locator(".pill.fatal").textContent();
  ok(fatalTxt.includes("截断") && fatalTxt.includes("2467"), "截断指出字节偏移: " + fatalTxt);
  ok(await page.isDisabled("#exportBtn"), "截断文件禁止导出");

  await loadSample("bad-crc.sav");
  ok((await page.locator(".pill.crit").count()) >= 1, "真实 bad-crc.sav 识别为损坏");

  // ---- 8. stress：128 区块 256 实体（输入区块非规范排序，输出应规范化）----
  await loadSample("stress.sav");
  ok((await page.locator(".chunk-item").count()) === 128, "stress 渲染 128 区块");
  ok((await page.locator(".entity-card").count()) === 256, "stress 渲染 256 实体");
  ok(await page.isEnabled("#exportBtn"), "stress 可导出");
  const [dl3] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const p3 = "/tmp/gwsv-stress.sav";
  await dl3.saveAs(p3);
  // 回读规范化输出：应零错误、128/256 齐全，且再次导出字节幂等
  await loadSampleViaPath(p3);
  ok((await page.locator(".chunk-item").count()) === 128, "stress 回读后仍 128 区块");
  ok((await page.locator(".entity-card").count()) === 256, "stress 回读后仍 256 实体");
  ok((await page.locator(".pill.clean").count()) === 1, "stress 规范化输出回读零错误");
  const [dl3b] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const p3b = "/tmp/gwsv-stress-2.sav";
  await dl3b.saveAs(p3b);
  ok(readFileSync(p3).equals(readFileSync(p3b)), "stress 规范化编码字节级幂等");
  // 输出区块应已按坐标字典序
  const coordTxt = await page.locator(".chunk-item .coord").first().textContent();
  ok(coordTxt.includes("0, 0, 0"), "stress 输出区块已规范排序，首块为 (0,0,0): " + coordTxt);

  // ---- 9. v1 升级 ----
  await loadSample("world-v1.sav");
  ok((await page.locator(".pill.clean").count()) === 1, "v1 解析通过");
  const [dl4] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const p4 = "/tmp/gwsv-v1-upgraded.sav";
  await dl4.saveAs(p4);
  const upgraded = readFileSync(p4);
  const v2canon = readFileSync(`${SAMPLES}/world-v2.sav`);
  ok(upgraded.equals(v2canon), "v1 升级结果与 v2 规范字节相同");

  // ---- 10. 主题切换无崩溃 ----
  await page.click("#themeBtn");
  ok((await page.locator("#voxelGrid .cell").count()) === 64, "主题切换后界面仍正常");
} catch (e) {
  fail++;
  console.log("EXCEPTION:", e.message);
} finally {
  ok(consoleErrors.length === 0, "浏览器控制台无错误: " + consoleErrors.join(" | "));
  await browser.close();
  server.close();
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
