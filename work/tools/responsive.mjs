// 响应式与主题检查：node work/tools/responsive.mjs
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = "/home/wendy/jianzhi/feedback-tasks/chunk-save-upgrader/app";
const MIME = { ".html": "text/html", ".js": "text/javascript" };
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
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  FAIL:", m)); };

for (const [name, width, height] of [["phone", 390, 844], ["desktop", 1360, 900]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base);
  await page.click("#loadDemoBtn");
  await page.waitForSelector("#app:not([hidden])");
  // 无水平滚动
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientW = await page.evaluate(() => document.documentElement.clientWidth);
  ok(scrollW <= clientW, `${name} 无水平滚动 (scroll=${scrollW} client=${clientW})`);
  // 三栏在窄屏堆叠
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns.split(" ").length);
  ok(width < 520 ? cols === 1 : cols === 3, `${name} 工作区列数=${cols}`);
  // 关键控件可见
  ok(await page.isVisible("#exportBtn"), `${name} 导出按钮可见`);
  ok(await page.isVisible("#voxelGrid"), `${name} 切片网格可见`);
  ok(errs.length === 0, `${name} 无页面错误: ${errs.join("|")}`);
  await page.close();
}

// 暗色主题
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: "dark" });
await page.goto(base);
await page.click("#loadDemoBtn");
await page.waitForSelector("#app:not([hidden])");
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(bg !== "rgba(0, 0, 0, 0)" && bg !== "rgb(244, 246, 248)", `暗色模式 body 背景生效: ${bg}`);
// 手动切换
await page.click("#themeBtn");
const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
ok(theme === "light", "主题切换按钮写入 data-theme=light");
const persisted = await page.evaluate(() => { try { return localStorage.getItem("gwsv-theme"); } catch { return null; } });
ok(persisted === "light", "主题偏好持久化到 localStorage");
await page.close();

await browser.close();
server.close();
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
