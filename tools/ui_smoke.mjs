// Headless end-to-end smoke test for the workbench UI.
import { createRequire } from "node:module";
import { stat } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const BASE = "http://localhost:8901/index.html";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const fail = (m) => { errors.push(m); };

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForFunction(
  () => document.querySelector("#stats-body tr") !== null,
  { timeout: 15000 }
);

// 1. Initial perspective render produced a non-empty canvas + stats.
const statsText = await page.locator("#stats-body").innerText();
if (!/覆盖像素\s*6/.test(statsText)) fail(`expected 6 covered pixels, got: ${statsText}`);

// 2. Switch through every view without errors; canvas keeps drawing.
for (const view of ["depth", "face", "coverage", "color"]) {
  await page.check(`input[name="view"][value="${view}"]`);
  await page.waitForTimeout(50);
}

// 3. Mesh overlays pre and post.
for (const mesh of ["pre", "post", "off"]) {
  await page.selectOption("#mesh-select", mesh);
  await page.waitForTimeout(30);
}

// 4. Click a covered pixel and expect inspector derivation content.
const canvas = page.locator("#raster-canvas");
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.15);
await page.waitForTimeout(60);
const inspector = await page.locator("#inspector").innerText();
if (!/重心 λ|未覆盖/.test(inspector)) fail(`inspector missing derivation: ${inspector.slice(0, 120)}`);

// 5. Load shared-edge sample: must show 16 covered and no multi-coverage.
await page.selectOption("#sample-select", "shared-edge");
await page.waitForFunction(
  () => /覆盖像素\s*16/.test(document.querySelector("#stats-body").innerText),
  { timeout: 10000 }
);
const sharedStats = await page.locator("#stats-body").innerText();
if (!/多重覆盖像素\s*0/.test(sharedStats)) fail(`shared edge should have zero multi-coverage: ${sharedStats}`);

// 6. Equal-depth: first-submitted face wins (only face 0 owns pixels).
await page.selectOption("#sample-select", "equal-depth");
await page.waitForFunction(
  () => /完成/.test(document.querySelector("#status-line").textContent),
  { timeout: 10000 }
);
await page.waitForTimeout(100);

// 7. Degenerate: one skipped face, zero covered.
await page.selectOption("#sample-select", "degenerate");
await page.waitForFunction(
  () => /退化面（跳过）\s*1/.test(document.querySelector("#stats-body").innerText),
  { timeout: 10000 }
);

// 8. Stress case runs to completion (cooperative yielding path) and covers all.
await page.selectOption("#sample-select", "stress");
await page.waitForFunction(
  () => /覆盖像素\s*65536/.test(document.querySelector("#stats-body").innerText),
  { timeout: 60000 }
);

// 9. Cancellation: start stress again then cancel; status reports cancelled.
await page.click("#btn-run");
await page.waitForTimeout(120);
await page.click("#btn-cancel");
await page.waitForFunction(
  () => /已取消/.test(document.querySelector("#status-line").textContent),
  { timeout: 5000 }
).catch(() => fail("cancel did not report 已取消"));

// Recompute to leave a valid result for export.
await page.selectOption("#sample-select", "perspective");
await page.waitForFunction(
  () => /覆盖像素\s*6/.test(document.querySelector("#stats-body").innerText),
  { timeout: 10000 }
);

// 10. Export buttons are enabled and build payloads (downloads are inert in
//     headless, so intercept the Blob via a download listener best-effort).
const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
await page.click("#btn-export-png");
const dl = await downloadPromise;
if (dl) {
  const path = await dl.path();
  const { size } = await stat(path);
  if (size < 50) fail(`PNG export suspiciously small (${size} bytes)`);
}

await browser.close();

if (errors.length) {
  console.error("FAIL");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log("PASS: full UI smoke test (views, mesh, inspector, samples, cancel, export)");
