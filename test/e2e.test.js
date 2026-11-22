// End-to-end test in a real Chromium: serves the page, injects a sample .ts
// capture through the file input, and verifies the full interaction chain.
// Run with:  NODE_PATH=$(npm root -g) node test/e2e.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html;charset=utf-8", ".js": "text/javascript;charset=utf-8",
  ".css": "text/css", ".json": "application/json", ".ts": "video/mp2t",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const fp = normalize(join(root, p));
    if (!fp.startsWith(root)) return res.writeHead(403).end();
    const data = await readFile(fp);
    res.writeHead(200, { "Content-Type": TYPES[extname(fp)] || "application/octet-stream" }).end(data);
  } catch { res.writeHead(404).end(); }
});

let browser, page;
before(async () => {
  await new Promise((r) => server.listen(8131, r));
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  page = await context.newPage();
  await page.goto("http://localhost:8131/");
});
after(async () => { await browser?.close(); server.close(); });

test("page boots with empty state and no console errors", async () => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.waitForSelector("#dropzone");
  assert.ok(await page.locator("h1").textContent());
  await page.waitForTimeout(200);
  assert.deepEqual(errors, []);
});

test("loading switch.ts populates summary, table, chart and anomalies", async () => {
  const fileBuf = await readFile(join(root, "samples/switch.ts"));
  await page.setInputFiles("#file-input", {
    name: "switch.ts", mimeType: "video/mp2t", buffer: fileBuf,
  });
  await page.waitForSelector("#work-grid:not([hidden])");

  // Summary tiles
  const stats = await page.locator(".stat-value").allTextContents();
  assert.equal(Number(stats[0]), 13); // 13 full packets

  // Packet table renders rows
  const rowCount = await page.locator(".prow").count();
  assert.ok(rowCount > 0);

  // Clock chart has SVG points and a wrap marker
  await page.waitForSelector("svg.clock-svg");
  assert.ok(await page.locator("circle.clock-point").count() > 0);
  assert.ok(await page.locator(".kind-wrap").count() > 0);

  // Anomaly list includes the CRC error and a gap
  const anomalyNames = await page.locator(".anomaly-name").allTextContents();
  assert.ok(anomalyNames.some((n) => n.includes("CRC")));
  assert.ok(anomalyNames.some((n) => n.includes("缺包")));
});

test("clicking a chart point selects and details the source packet", async () => {
  await page.selectOption("#clock-kind", "PTS");
  await page.waitForTimeout(150);
  await page.locator("svg.clock-svg").scrollIntoViewIfNeeded();
  // Compute the on-screen position of the first point from viewBox scaling,
  // then click through Playwright's mouse so a genuine event is dispatched.
  const target = await page.evaluate(() => {
    const svg = document.querySelector("svg.clock-svg");
    const pt = svg.querySelector("circle.clock-point");
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: rect.left + (Number(pt.getAttribute("cx")) / vb.width) * rect.width,
      y: rect.top + (Number(pt.getAttribute("cy")) / vb.height) * rect.height,
    };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(100);
  const detailTitle = await page.locator("#packet-detail .detail-title").textContent();
  assert.match(detailTitle, /包 #/);
  // A table row is selected
  assert.ok(await page.locator(".prow.selected").count() >= 1);
});

test("PID filter scopes the table and anomalies", async () => {
  await page.selectOption("#pid-select", "256");
  await page.waitForTimeout(150);
  const rows = await page.locator(".prow").allTextContents();
  assert.ok(rows.every((r) => r.includes("256")));
  await page.selectOption("#pid-select", "all");
});

test("anomaly click jumps the table to that packet", async () => {
  const first = page.locator(".anomaly-item").first();
  await first.click();
  await page.waitForTimeout(150);
  assert.ok(await page.locator(".prow.selected").count() >= 1);
});

test("export builds a JSON blob download", async () => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#export-json"),
  ]);
  assert.match(download.suggestedFilename(), /anomalies\.json$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const json = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(json.file, "switch.ts");
  assert.ok(Array.isArray(json.anomalies));
  assert.ok(json.anomalies.length > 0);
  assert.ok(json.programTimeline.some((e) => e.type === "PMT"));
});

test("theme toggle flips the data-theme attribute", async () => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click("#theme-toggle");
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.notEqual(before, after);
});
