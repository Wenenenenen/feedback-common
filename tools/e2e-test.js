/* End-to-end test of the single-file app via headless Chromium. */
const path = require("path");
const { chromium } = require(path.join(
  require("os").homedir(),
  ".nvm/versions/node/v22.23.2/lib/node_modules/playwright"
));

const fileUrl = "file://" + path.resolve(process.argv[2]);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  await page.goto(fileUrl);
  await page.waitForSelector("#runBtn[disabled]");

  // load built-in sample
  await page.click("#loadSampleBtn");
  await page.waitForFunction(
    () => document.getElementById("imgFileName").textContent.includes("spots.f32")
  );
  const runEnabled = await page.$eval("#runBtn", (b) => !b.disabled);
  console.log("run button enabled after sample load:", runEnabled);

  // run detection
  await page.click("#runBtn");
  await page.waitForSelector("#resultPanel:not([hidden])");
  await page.waitForFunction(
    () => document.getElementById("statusLine").textContent.startsWith("完成")
  );
  const status = await page.$eval("#statusLine", (e) => e.textContent);
  console.log("status:", status);

  const rows = await page.$$eval("#spotTable tbody tr", (trs) =>
    trs.map((tr) =>
      [...tr.children].map((td) => td.textContent.trim())
    )
  );
  console.log("table rows:", JSON.stringify(rows, null, 0));
  if (rows.length !== 2) throw new Error("expected 2 rows, got " + rows.length);
  const bright = rows.find((r) => r[1].includes("亮"));
  const dark = rows.find((r) => r[1].includes("暗"));
  const close = (a, b, tol) => Math.abs(Number(a) - b) <= tol;
  if (!close(bright[4], 18.24, 0.05)) throw new Error("bright x mismatch: " + bright[4]);
  if (!close(bright[5], 24.63, 0.05)) throw new Error("bright y mismatch: " + bright[5]);
  if (!close(dark[4], 48.84, 0.05)) throw new Error("dark x mismatch: " + dark[4]);
  if (!close(dark[5], 54.43, 0.05)) throw new Error("dark y mismatch: " + dark[5]);
  if (!bright[7].includes("成功") || !dark[7].includes("成功"))
    throw new Error("refinement status mismatch");

  // switch to response map and move the level slider
  await page.click('#viewSeg button[data-view="response"]');
  await page.waitForFunction(
    () => !document.getElementById("respLegend").hidden
  );
  await page.fill("#levelSlider", "5");
  await page.dispatchEvent("#levelSlider", "input");
  await page.waitForFunction(
    () => document.getElementById("levelLabel").textContent.includes("k=5")
  );
  const label5 = await page.$eval("#levelLabel", (e) => e.textContent);
  console.log("level label at 5:", label5);

  // click the first table row and inspect the detail panel
  await page.click("#spotTable tbody tr:first-child");
  await page.waitForSelector("#detailPanel:not([hidden])");
  const detailText = await page.$eval("#detailPanel", (e) => e.textContent);
  for (const token of ["细化状态", "物理中心", "尺度", "1 层", "当前"]) {
    if (!detailText.includes(token))
      throw new Error("detail missing token: " + token);
  }
  if (!/1 层/.test(detailText) || !detailText.includes("+1 层"))
    throw new Error("detail missing adjacent-scale rows");
  const bars = await page.$$eval("#scaleBars .scale-row", (rs) =>
    rs.map((r) => r.textContent.trim().replace(/\s+/g, " "))
  );
  console.log("scale bars:", bars);

  // CSV export: capture the download produced by the export button
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn"),
  ]);
  const csvPath = await download.path();
  const fs = require("fs");
  const csvText = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const csvLines = csvText.trim().split(/\r?\n/);
  console.log("csv header:", csvLines[0]);
  console.log("csv rows:", csvLines.length - 1);
  const expectedHeader = [
    "id", "type", "level", "col_px", "row_px",
    "x_physical", "y_physical", "sigma_physical",
    "response", "refined",
    "refined_level", "refined_col", "refined_row",
    "refined_x_physical", "refined_y_physical",
    "refined_sigma_physical", "refined_response",
    "delta_level", "delta_row", "delta_col",
  ].join(",");
  if (csvLines[0] !== expectedHeader)
    throw new Error("CSV header mismatch");
  if (csvLines.length !== 3) throw new Error("expected 2 CSV data rows");
  const csvTypes = csvLines.slice(1).map((l) => l.split(",")[1]);
  if (!csvTypes.includes("bright") || !csvTypes.includes("dark"))
    throw new Error("CSV types missing bright/dark");
  if (!csvLines.slice(1).every((l) => l.split(",")[9] === "1"))
    throw new Error("CSV refined flags should all be 1");

  // mask toggle re-renders without error
  await page.click("#showMask");
  await page.click("#showSpots");
  await page.click("#showSpots");
  await page.click("#showMask");

  // canvas actually painted (non-blank)
  const painted = await page.$eval("#view", (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== 120 || d[i + 1] !== 120 || d[i + 2] !== 120) nonBg++;
    }
    return nonBg;
  });
  console.log("non-grey painted pixels:", painted);
  if (painted < 1000) throw new Error("canvas looks blank");

  if (errors.length) {
    console.error("PAGE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nE2E TESTS PASSED");
  await browser.close();
})().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
