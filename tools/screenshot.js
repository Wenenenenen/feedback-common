/* 视觉核对截图：node tools/screenshot.js（输出到 /tmp/mgs-*.png） */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");

const ROOT = path.join(__dirname, "..");
const SAMPLES = path.join(ROOT, "samples", "extracted");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const f = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split("?")[0])));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`http://127.0.0.1:${port}/app/index.html`);

  // 场景 1：material 全要素
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "material.png"));
  await page.setInputFiles("#fileMask", path.join(SAMPLES, "mask.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "markers.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportJson").disabled);
  await page.check("#tgGrid");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "/tmp/mgs-material.png", fullPage: false });

  // 点查 (30,24) 像素并截图侧栏信息
  const box = await page.locator("#view").boundingBox();
  const ps = box.width / 65;
  await page.mouse.click(box.x + 30 * ps + ps / 2, box.y + 24 * ps + ps / 2);
  await page.waitForTimeout(150);
  await page.screenshot({ path: "/tmp/mgs-inspect.png", fullPage: false });

  // 场景 2：plateau + 代价热图
  await page.uncheck("#tgGrid");
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "plateau.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "plateau.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportJson").disabled);
  await page.check("#tgCost");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "/tmp/mgs-plateau-cost.png", fullPage: false });

  // 场景 3：tie-tail 八邻切换演示（保持 4 邻默认，展示尾巴分界）
  await page.uncheck("#tgCost");
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "tie-tail.png"));
  await page.setInputFiles("#fileMask", path.join(SAMPLES, "tie-tail-mask.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "tie-tail.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportJson").disabled);
  await page.waitForTimeout(200);
  await page.screenshot({ path: "/tmp/mgs-tietail.png", fullPage: false });

  await browser.close();
  server.close();
  console.log("screenshots written to /tmp/mgs-*.png");
})();
