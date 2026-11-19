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
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: "light" });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.click("#loadDemoBtn");
await page.waitForSelector("#app:not([hidden])");
// 点一个有颜色的方块层（选含多 ID 的区块 0,0,0 并切到高层）
await page.locator('.chunk-item[data-key="0,0,0"]').click();
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/shot-light.png", fullPage: false });
await browser.close(); server.close(); console.log("ok");
