/* End-to-end browser smoke test with Playwright.
 * Serves web/ over http, drives the real UI against the sample ZIP, and
 * verifies the numbers shown to the user. Run: node tools/e2e-smoke.js
 */
"use strict";
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const ZIP = path.join(ROOT, "samples", "sinogram-rebuild-desk-cases.zip");

const MIME = { ".html": "text/html", ".js": "text/javascript",
  ".json": "application/json", ".raw": "application/octet-stream" };

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split("?")[0];
      const file = path.join(WEB, url === "/" ? "index.html" : url);
      if (!file.startsWith(WEB)) { res.statusCode = 403; return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.statusCode = 404; return res.end("not found"); }
        res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const srv = await startServer();
  const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  const check = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
    if (!cond) process.exitCode = 1;
  };

  await page.goto(`http://127.0.0.1:${port}/`);

  // ---- load the real sample zip through the file chooser ----
  await page.waitForSelector("#btnZip");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btnZip")
  ]);
  await chooser.setFiles(ZIP);
  await page.waitForFunction(() => document.querySelector("#caseName").textContent.includes("角度"));
  const caseLabel = await page.$eval("#caseName", e => e.textContent);
  check("zip imported via UI", /47 角度 × 97 探测器/.test(caseLabel), caseLabel);
  const status = await page.$eval("#status", e => e.textContent);
  check("status mentions reorder", status.includes("重排"), status);

  // ---- phantom stats: negatives preserved, scale physical, weights sum pi ----
  await page.waitForSelector("#stats .v");
  const statsText = await page.$eval("#stats", e => e.innerText);
  check("angle weights sum to pi in UI", /角权之和\s*3\.1415926536/.test(statsText), statsText);
  check("negative pixels reported (no clipping)", /负值像素数\s*[1-9]/.test(statsText), statsText);
  check("recon max near physical scale ~1", /重建最大值\s*1\.05/.test(statsText), statsText);

  // ---- unfiltered control: values much larger, still works ----
  await page.click('#modeSeg button[data-mode="unfilt"]');
  await page.waitForFunction(() =>
    document.querySelector("#reconTitle").textContent.includes("未滤波"));
  const unfStats = await page.$eval("#stats", e => e.innerText);
  const unfMax = parseFloat(/重建最大值\s*([0-9.eE+-]+)/.exec(unfStats)[1]);
  check("unfiltered max far above filtered (~91)", unfMax > 50, "max=" + unfMax);
  await page.click('#modeSeg button[data-mode="ramlak"]');
  await page.waitForFunction(() =>
    document.querySelector("#reconTitle").textContent.includes("Ram-Lak"));

  // ---- geometry controls: output size, pixel size, extra offset ----
  await page.fill("#outW", "48");
  await page.fill("#outH", "40");
  await page.dispatchEvent("#outH", "change");
  await page.waitForFunction(() =>
    document.querySelector("#reconMeta").textContent.startsWith("48×40"));
  check("output resize 48x40", true);
  await page.fill("#outW", "64");
  await page.fill("#outH", "64");
  await page.dispatchEvent("#outH", "change");

  const metaBefore = await page.$eval("#reconMeta", e => e.textContent);
  await page.fill("#offRange", "1");
  await page.dispatchEvent("#offRange", "input");
  await page.waitForFunction((old) =>
    document.querySelector("#reconMeta").textContent !== old, metaBefore);
  const offMeta = await page.$eval("#reconMeta", e => e.textContent);
  check("extra offset applied", /附加偏移=1\.00/.test(offMeta), offMeta);
  await page.fill("#offRange", "0");
  await page.dispatchEvent("#offRange", "input");

  // ---- pixel click -> sinogram overlay + detector info ----
  const canvas = await page.$("#cvRecon");
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForFunction(() =>
    document.querySelector("#pickMeta").textContent.includes("像素"));
  const pick = await page.$eval("#pickInfo", e => e.innerText);
  check("pick shows detector index and q(t)", /命中探测器索引/.test(pick) &&
    /插值 q\(t\)/.test(pick), pick);
  // angle slider updates the picked detector position
  await page.fill("#angSlider", "10");
  await page.dispatchEvent("#angSlider", "input");
  const pick2 = await page.$eval("#pickInfo", e => e.innerText);
  check("angle slider changes detector readout", pick2 !== pick);

  // ---- PFM export: intercept download, parse header + floats ----
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btnPfm")
  ]);
  const dlPath = path.join(require("os").tmpdir(), dl.suggestedFilename());
  await dl.saveAs(dlPath);
  const bytes = fs.readFileSync(dlPath);
  const headerEnd = bytes.indexOf(0x0a, bytes.indexOf(0x0a, bytes.indexOf(0x0a) + 1) + 1) + 1;
  const header = bytes.slice(0, headerEnd).toString("latin1");
  check("PFM header Pf / 64 64 / -1.0", header === "Pf\n64 64\n-1.0\n", header);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + headerEnd);
  const floats = [];
  for (let i = 0; i < 64 * 64; i++) floats.push(dv.getFloat32(i * 4, true));
  check("PFM float count + contains negatives",
    floats.length === 4096 && floats.some(v => v < 0),
    "min=" + Math.min(...floats));

  // ---- parameter save / reload round trip ----
  const [dl2] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btnSaveParams")
  ]);
  const pPath = path.join(require("os").tmpdir(), dl2.suggestedFilename());
  await dl2.saveAs(pPath);
  const params = JSON.parse(fs.readFileSync(pPath, "utf8"));
  check("params file carries geometry + window",
    params.width === 64 && params.height === 64 &&
    typeof params.extra_offset === "number" && !!params.color_window,
    JSON.stringify(params).slice(0, 120));
  // change geometry then reload params
  await page.fill("#offRange", "2");
  await page.dispatchEvent("#offRange", "input");
  const [chooser2] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btnLoadParams")
  ]);
  await chooser2.setFiles(pPath);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("参数已重载"));
  const restored = await page.$eval("#offRange", e => e.value);
  check("params reload restores extra offset", parseFloat(restored) === params.extra_offset,
    "slider=" + restored);

  // ---- duplicate-angle rejection through the UI ----
  const dupJson = path.join(ROOT, "_case_data", "duplicate-angle.json");
  const dupRaw = path.join(ROOT, "_case_data", "duplicate-angle.raw");
  const [chooser3] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btnFiles")
  ]);
  await chooser3.setFiles([dupJson, dupRaw]);
  await page.waitForFunction(() =>
    document.querySelector("#status").classList.contains("err"));
  const errText = await page.$eval("#status", e => e.textContent);
  check("duplicate angle rejected with clear error", errText.includes("重复角度"), errText);

  // ---- impulse exact values via UI multi-file import ----
  const [chooser4] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btnFiles")
  ]);
  await chooser4.setFiles([
    path.join(ROOT, "_case_data", "impulse.json"),
    path.join(ROOT, "_case_data", "impulse.raw")
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#caseName").textContent.includes("1 角度 × 5 探测器"));
  const impStats = await page.$eval("#stats", e => e.innerText);
  check("impulse max = pi/4 (0.785398...)", /重建最大值\s*0\.785398/.test(impStats), impStats);
  check("impulse min = -1/pi (-0.3183...)", /重建最小值\s*-0\.31831/.test(impStats), impStats);

  check("no browser errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  srv.close();
  console.log(process.exitCode ? "\nE2E FAILURES" : "\nE2E ALL PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
