/* End-to-end smoke test for the slanted-edge MTF workbench.
 * Usage: node tools/e2e.js   (expects `npx playwright` chromium installed)
 */
"use strict";
const path = require("path");
const http = require("http");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".u16": "application/octet-stream" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.normalize(path.join(ROOT, url === "/" ? "index.html" : url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1360, height: 940 }, acceptDownloads: true });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const fail = (msg) => { throw new Error(msg); };
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.click("#sampleBtn");
  await page.waitForSelector("#reportTable tbody tr", { timeout: 8000 });
  const rowCount = await page.locator("#reportTable tbody tr").count();
  if (rowCount !== 4) fail(`expected 4 report rows, got ${rowCount}`);

  const report = await page.$$eval("#reportTable tbody tr", (trs) =>
    trs.map((tr) => Array.from(tr.children).map((td) => td.textContent.trim()))
  );
  console.log("report rows:");
  report.forEach((r) => console.log("  " + r.join(" | ")));
  const statuses = report.map((r) => r[10]);
  if (statuses.filter((s) => s === "有效").length !== 3) fail("expected 3 valid ROIs");
  if (statuses[2] !== "无效" || !report[2][11].includes("斜率")) fail("ROI3 should be invalid by slope");

  // MTF50 values match the python reference within 0.005
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference_results.json"), "utf8"));
  report.forEach((r, i) => {
    if (!ref.results[i].valid) return;
    const got = parseFloat(r[8]);
    const want = ref.results[i].mtf50;
    if (Math.abs(got - want) > 0.005) fail(`ROI${i} mtf50 ${got} vs ref ${want}`);
  });

  // charts rendered: 3 svg paths inside detail card for selected ROI 1
  await page.waitForSelector("#chartMtf path.series-line");
  const paths = await page.locator("#detailCard path.series-line").count();
  if (paths !== 3) fail(`expected 3 curve paths, got ${paths}`);

  // rejected points visible for ROI2 (index 1): red circles
  await page.click("#reportTable tbody tr:nth-child(2)");
  await page.waitForTimeout(150);
  const rejects = await page.locator("circle.pt.reject").count();
  if (rejects !== 4) fail(`expected 4 rejected edge points, got ${rejects}`);

  // point-reading tooltip on MTF chart
  const mtfBox = await page.locator("#chartMtf svg").boundingBox();
  await page.mouse.move(mtfBox.x + mtfBox.width * 0.5, mtfBox.y + mtfBox.height * 0.5);
  await page.waitForTimeout(120);
  const tipVisible = await page.locator("#tip").isVisible();
  if (!tipVisible) fail("chart tooltip did not appear");
  const tipText = await page.locator("#tip").textContent();
  if (!tipText.includes("MTF")) fail("tooltip missing MTF row: " + tipText);

  // click invalid ROI row -> reason banner + locates selection
  await page.click("#reportTable tbody tr:nth-child(3)");
  await page.waitForTimeout(120);
  const reasonVisible = await page.locator("#detailReason").isVisible();
  if (!reasonVisible) fail("invalid reason banner missing");

  // add a ROI by drawing (click draw button then drag on canvas)
  const before = await page.locator("#reportTable tbody tr").count();
  await page.click("#drawBtn");
  const ov = await page.locator("#overlay").boundingBox();
  await page.mouse.move(ov.x + ov.width * 0.1, ov.y + ov.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(ov.x + ov.width * 0.3, ov.y + ov.height * 0.35);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await page.locator("#reportTable tbody tr").count();
  if (after !== before + 1) fail(`draw did not add ROI (${before} -> ${after})`);

  // delete it
  await page.click("#deleteBtn");
  const finalCount = await page.locator("#reportTable tbody tr").count();
  if (finalCount !== before) fail("delete failed");

  // CSV export: intercept download
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    page.click("#exportBtn"),
  ]);
  const csvPath = await download.path();
  const csv = fs.readFileSync(csvPath, "utf8");
  if (!csv.includes("mtf50_cyc_per_px") || !csv.includes("roi_1_mtf")) fail("CSV missing expected sections");

  // dark theme toggle
  await page.click("#themeBtn");
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (!["light", "dark"].includes(theme)) fail("theme toggle failed: " + theme);

  // mobile width: no horizontal overflow
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) fail(`horizontal overflow at phone width: ${overflow}px`);

  if (errors.length) fail("page errors: " + errors.join(" | "));
  await browser.close();
  server.close();
  console.log("\nE2E OK — sample analysis, charts, tooltip, draw/delete, CSV, theme, mobile layout.");
})().catch((e) => {
  server.close();
  console.error(e);
  process.exit(1);
});
