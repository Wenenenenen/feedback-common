import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = createServer((req, res) => {
  const f = join(root, req.url === "/" ? "/index.html" : req.url.split("?")[0]);
  res.writeHead(200, { "content-type": types[f.slice(f.lastIndexOf("."))] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForSelector("#packet-rows tr");

// 无横向页面滚动
const scroll = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
console.log("390px 横向溢出：", scroll.overflowX, JSON.stringify(scroll));

// 试听：点播放，检查 AudioContext 在跑、播放头推进
await page.click("#play-btn");
await page.waitForTimeout(600);
const play = await page.evaluate(() => ({
  label: document.getElementById("play-btn").textContent,
  time: document.getElementById("play-time").textContent,
}));
console.log("播放状态：", JSON.stringify(play));
await page.click("#play-btn"); // 停止

// 切换 repeat_decay 后再试听，确认缓冲重建
await page.click("label[for=policy-decay]");
await page.click("#play-btn");
await page.waitForTimeout(300);
const play2 = await page.evaluate(() => document.getElementById("play-time").textContent);
await page.click("#play-btn");
console.log("decay 策略下播放时间：", play2);

// 导出按钮点击（在 headless 中下载可能被拦，但不应报错）
await page.click("#export-wav");
await page.click("#export-json");
await page.waitForTimeout(300);

await browser.close();
server.close();
console.log(errors.length ? "错误：" + errors.join(";") : "无运行时错误");
process.exit(errors.length || scroll.overflowX ? 1 : 0);
