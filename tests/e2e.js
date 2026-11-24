/* Playwright end-to-end test for the workbench UI.
 * Run: node tests/e2e.js   (uses globally installed playwright + chromium) */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const PAGE_URL = "file://" + path.join(ROOT, "index.html");
const SAMPLE_ZIP = path.join(ROOT, "samples", "dither-lsb.zip");
const BOUND_WAV = "/tmp/dither-work/cases/boundaries.wav";

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS:", msg); }
  else { fail++; console.error("  FAIL:", msg); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(PAGE_URL);

  // ---- 1. ZIP import populates settings from bundle ----
  await page.setInputFiles("#fileInput", SAMPLE_ZIP);
  await page.waitForSelector("#loadedName", { state: "visible" });
  await page.waitForFunction(() => document.getElementById("loadedName").textContent.includes(".zip"));
  ok((await page.textContent("#metaChannels")).includes("2"), "zip import: 2 channels");
  ok((await page.inputValue("#kNumber")) === "5", "k imported as 5");
  const seeds = await page.$$eval('[data-role="seed"]', (els) => els.map((e) => e.value));
  ok(JSON.stringify(seeds) === JSON.stringify(["23", "91"]), "seeds 23/91 imported: " + seeds);
  const resets = await page.$$eval('[data-role="resets"]', (els) => els.map((e) => e.value));
  ok(resets[0] === "4800" && resets[1] === "", "resets [4800] / [] imported");

  // ---- 2. render and inspect status ----
  await page.click("#renderBtn");
  await page.waitForFunction(() =>
    document.getElementById("renderStatus").textContent.includes("渲染完成"), { timeout: 15000 });
  const status = await page.textContent("#renderStatus");
  ok(/渲染完成/.test(status), "render completed: " + status);
  ok(await page.isEnabled("#exportFullBtn"), "full export enabled after render");

  // ---- 3. inspector values vs Python reference detail ----
  const detail = JSON.parse(fs.readFileSync("/tmp/dither-work/refout/sample.detail.json", "utf8"));
  await page.fill("#inspectFrame", "10");
  await page.dispatchEvent("#inspectFrame", "change");
  await page.waitForTimeout(50);
  const tableText = await page.textContent("#inspectTable");
  const r10 = detail[0][10];
  ok(tableText.includes(String(r10.d)), "inspector shows d=" + r10.d);
  ok(tableText.includes(String(r10.w1)), "inspector shows w1=" + r10.w1);
  ok(tableText.includes(String(r10.q)), "inspector shows q=" + r10.q);
  ok(tableText.includes(String(r10.e_out)), "inspector shows e_out=" + r10.e_out);

  // reset frame 4800 shows the reset notice and e_in == 0
  await page.fill("#inspectFrame", "4800");
  await page.dispatchEvent("#inspectFrame", "change");
  await page.waitForTimeout(50);
  const resetHint = await page.textContent("#resetHint");
  ok(/重置帧/.test(resetHint), "reset-frame notice shown at 4800");
  const t4800 = await page.textContent("#inspectTable");
  const einAtReset = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#inspectTable tr")];
    const row = rows.find((r) => r.querySelector("[data-label]") &&
      r.querySelector("[data-label]").textContent.startsWith("反馈误差输入"));
    return row ? row.querySelector("[data-field]").textContent : null;
  });
  ok(einAtReset === "0", "e_in = 0 at reset frame (got " + einAtReset + ")");
  const r4800 = detail[0][4800];
  ok(r4800.e_in === 0, "reference confirms e_in=0 at reset");

  // ---- 4. change k -> dirty -> re-render; outputs must match ref k=12 style recompute ----
  await page.fill("#kNumber", "12");
  await page.dispatchEvent("#kNumber", "input");
  ok((await page.textContent("#renderStatus")).includes("重新渲染"), "dirty state after k change");
  ok(await page.isDisabled("#exportFullBtn"), "export disabled while dirty");
  await page.click("#renderBtn");
  await page.waitForFunction(() =>
    document.getElementById("renderStatus").textContent.includes("渲染完成"), { timeout: 15000 });
  // clamp ceiling for k=12 is 28672
  const hiHint = await page.textContent("#hiHint");
  ok(hiHint === "28672", "hi hint = 32768-4096 = 28672");

  // ---- 5. selection + export; sliced WAV equals full-track frames ----
  await page.fill("#selStart", "100");
  await page.fill("#selEnd", "5000");
  await page.dispatchEvent("#selEnd", "change");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportSelBtn"),
  ]);
  const dlPath = "/tmp/dither-work/ui-selection.wav";
  await download.saveAs(dlPath);
  const selBuf = fs.readFileSync(dlPath);
  ok(selBuf.subarray(0, 4).toString() === "RIFF", "download is RIFF WAV");

  // full-track export for node-side comparison
  const [fullDl] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportFullBtn"),
  ]);
  const fullPath = "/tmp/dither-work/ui-full.wav";
  await fullDl.saveAs(fullPath);

  // compare node-side
  const DC = require(path.join(ROOT, "js", "dither-core.js"));
  const selWav = DC.parseWav(fs.readFileSync(dlPath).buffer.slice(0));
  const fullWav = DC.parseWav(fs.readFileSync(fullPath).buffer.slice(0));
  let mismatch = 0;
  for (let c = 0; c < selWav.channels; c++) {
    for (let i = 0; i < selWav.frames; i++) {
      if (selWav.channelData[c][i] !== fullWav.channelData[c][100 + i]) mismatch++;
    }
  }
  ok(selWav.frames === 4900 && mismatch === 0,
    "selection export bit-identical to full-track frames [100,5000)");

  // ---- 6. invalid inputs are rejected ----
  await page.setInputFiles("#fileInput", BOUND_WAV);
  await page.waitForFunction(() =>
    document.getElementById("loadedName").textContent.includes("boundaries.wav"));
  // bad seed
  const seedInput = await page.$('[data-role="seed"][data-ch="0"]');
  await seedInput.fill("0");
  await seedInput.dispatchEvent("input");
  await page.click("#renderBtn");
  await page.waitForSelector("#paramAlert:not([hidden])");
  ok(/种子/.test(await page.textContent("#paramAlert")), "zero seed rejected");
  // bad k
  await page.fill("#kNumber", "13");
  await page.dispatchEvent("#kNumber", "input");
  await page.click("#renderBtn");
  ok(/2–12/.test(await page.textContent("#paramAlert")), "k=13 rejected");

  // invalid half-open selection
  await page.fill("#kNumber", "5");
  await page.dispatchEvent("#kNumber", "input");
  await page.fill("#selStart", "500");
  await page.fill("#selEnd", "500");
  await page.dispatchEvent("#selEnd", "change");
  ok(/起点 < 终点/.test(await page.textContent("#paramAlert")), "empty half-open selection rejected");

  // ---- 7. bad WAV (8-bit) rejected ----
  const badWav = makeBadWav();
  await page.setInputFiles("#fileInput", badWav);
  await page.waitForSelector("#importAlert:not([hidden])");
  ok(/16 位/.test(await page.textContent("#importAlert")), "non-16-bit WAV rejected");

  ok(errors.length === 0, "no page/console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${fail === 0 ? "ALL E2E PASSED" : fail + " E2E FAILURES"} (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

function makeBadWav() {
  // 8-bit PCM, mono, 48kHz, 10 samples
  const n = 10;
  const dataSize = n;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(48000, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128;
  const p = "/tmp/dither-work/bad8bit.wav";
  fs.writeFileSync(p, buf);
  return p;
}
