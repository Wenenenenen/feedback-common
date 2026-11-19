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

let page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: "dark" });
await page.goto(base); await page.click("#loadDemoBtn");
await page.waitForSelector("#app:not([hidden])");
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/shot-desktop-dark.png", fullPage: false });

// 损坏样例
await page.selectOption("#sampleSelect", "crc");
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/shot-corrupt.png", fullPage: false });

// 手机
page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(base); await page.click("#loadDemoBtn");
await page.waitForSelector("#app:not([hidden])");
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/shot-phone.png", fullPage: false });

await browser.close(); server.close();
console.log("shots done");
