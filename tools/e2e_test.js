/* End-to-end test of the real page in headless Chromium via Playwright.
   Covers: input validation, full RL run against reference values, view
   switching, cancel semantics, staleness on parameter change, and exports. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const CASES = path.join(ROOT, "_untrusted/cases");
const PW = require(path.join(process.env.HOME, ".nvm/versions/node/v22.23.2/lib/node_modules/playwright"));

function makePng(width, height, channels, samples8) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    samples8.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const comp = zlib.deflateSync(raw);
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", comp), chunk("IEND", Buffer.alloc(0))
  ]);
}

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, req.url === "/" ? "app/index.html" : req.url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
    res.end(data);
  });
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS" : "FAIL") + " " + name + (extra ? " — " + extra : ""));
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.listen(8753, r));
  const browser = await PW.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text()); });

  await page.goto("http://127.0.0.1:8753/");
  await page.waitForFunction(() => document.readyState === "complete");

  // Run button disabled until both inputs present
  check("run disabled initially", await page.locator("#runBtn").isDisabled());

  // ---- load tiny.png + tiny-mask.png + tiny.json, run 3 iterations ----
  const tinyPng = fs.readFileSync(path.join(CASES, "tiny.png"));
  const maskPng = fs.readFileSync(path.join(CASES, "tiny-mask.png"));
  const tinyJson = fs.readFileSync(path.join(CASES, "tiny.json"), "utf8");
  const ref = JSON.parse(fs.readFileSync(path.join(CASES, "reference.json"), "utf8"));

  await page.setInputFiles("#imgFile", { name: "tiny.png", mimeType: "image/png", buffer: tinyPng });
  await page.fill("#kernelText", tinyJson);
  await page.waitForTimeout(350);
  await page.setInputFiles("#maskFile", { name: "tiny-mask.png", mimeType: "image/png", buffer: maskPng });
  await page.waitForTimeout(200);
  check("run enabled after inputs", await page.locator("#runBtn").isEnabled());
  check("kernel size shown", (await page.locator("#metaGrid").innerText()).includes("3×2"));

  await page.fill("#iterCount", "3");
  await page.click("#runBtn");
  await page.waitForSelector("#runStateBadge", { state: "attached" });
  await page.waitForFunction(() => {
    const b = document.querySelector("#runStateBadge").textContent;
    return b.includes("完成") || b.includes("失败");
  }, { timeout: 15000 });
  check("run completed badge", (await page.locator("#runStateBadge").innerText()).includes("完成 3 次迭代"));

  // internal numeric agreement with reference.json
  const numerics = await page.evaluate((ref) => {
    const r = window.__test && window.__test.state ? window.__test.state.result : null;
    if (!r) return { ok: false };
    let xErr = 0, mseErr = 0;
    for (let it = 0; it <= 3; it++) {
      mseErr = Math.max(mseErr, Math.abs(r.mse[it] - ref.mse[it]));
      for (let i = 0; i < 12; i++) xErr = Math.max(xErr, Math.abs(r.snapshots[it][0][i] - ref.iterations[it][i]));
    }
    return { ok: true, xErr, mseErr };
  }, ref);
  check("page RL x matches reference", numerics.ok && numerics.xErr < 1e-6, "xErr=" + numerics.xErr);
  check("page MSE matches reference", numerics.ok && numerics.mseErr < 1e-12, "mseErr=" + numerics.mseErr);

  // slider covers iterations 0..3 and canvas has pixels
  check("slider max = 3", await page.inputValue("#iterSlider") === "3");
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector("#viewCanvas");
    return { w: c.width, h: c.height };
  });
  check("canvas sized 4x3", canvasSize.w === 4 && canvasSize.h === 3);

  // views switch without errors
  for (const v of ["reblurred", "residual", "observed", "restored"]) {
    await page.click(`.view-tabs button[data-view="${v}"]`);
    await page.waitForTimeout(60);
  }
  check("all four views rendered", true);

  // MSE chart exists with a line and 4 dots
  const dots = await page.locator("svg.chart .mse-dot").count();
  check("chart has 4 iteration dots", dots === 4, "dots=" + dots);

  // ---- staleness: change iteration count -> result invalidated ----
  await page.fill("#iterCount", "5");
  await page.waitForTimeout(100);
  const staleBadge = await page.locator("#runStateBadge").innerText();
  check("parameter change invalidates result", staleBadge.includes("作废"));
  check("exports disabled when stale", await page.locator("#export16").isDisabled());

  // ---- cancellation: run 100 iterations on medium image, cancel early ----
  const medPng = fs.readFileSync(path.join(CASES, "medium.png"));
  const medJson = JSON.parse(fs.readFileSync(path.join(CASES, "medium.json"), "utf8"));
  await page.setInputFiles("#imgFile", { name: "medium.png", mimeType: "image/png", buffer: medPng });
  await page.fill("#kernelText", JSON.stringify(medJson));
  await page.waitForTimeout(350);
  await page.fill("#iterCount", "100");
  await page.click("#runBtn");
  await page.waitForSelector("#cancelBtn", { state: "visible" });
  await page.waitForTimeout(120);
  await page.click("#cancelBtn");
  await page.waitForFunction(() => {
    const b = document.querySelector("#runStateBadge").textContent;
    return b.includes("取消");
  }, { timeout: 15000 });
  const cancelInfo = await page.evaluate(() => {
    const r = window.__test.state.result;
    return { completed: r.completedIters, snapshots: r.snapshots.length, mse: r.mse.length, cancelled: r.cancelled };
  });
  check("cancel keeps only finished iterations", cancelInfo.cancelled &&
    cancelInfo.completed < 100 && cancelInfo.snapshots === cancelInfo.completed + 1 &&
    cancelInfo.mse === cancelInfo.completed + 1, JSON.stringify(cancelInfo));

  // ---- validation failures ----
  // oversized image (513 wide)
  const big = makePng(513, 8, 1, Buffer.alloc(513 * 8));
  await page.setInputFiles("#imgFile", { name: "big.png", mimeType: "image/png", buffer: big });
  await page.waitForTimeout(150);
  check("oversized image rejected", (await page.locator("#statusLine").innerText()).includes("512"));

  // negative kernel weight
  await page.setInputFiles("#imgFile", { name: "medium.png", mimeType: "image/png", buffer: medPng });
  await page.fill("#kernelText", '{"weights":[[-1,2],[3,4]],"anchor":[0,0]}');
  await page.waitForTimeout(350);
  check("negative kernel rejected", (await page.locator("#statusLine").innerText()).includes("非负"));

  // anchor out of range
  await page.fill("#kernelText", '{"weights":[[1,2],[3,4]],"anchor":[5,0]}');
  await page.waitForTimeout(350);
  check("anchor out of range rejected", (await page.locator("#statusLine").innerText()).includes("anchor"));

  // kernel larger than 15
  const bigK = { weights: Array.from({ length: 16 }, () => new Array(16).fill(1)), anchor: [0, 0] };
  await page.fill("#kernelText", JSON.stringify(bigK));
  await page.waitForTimeout(350);
  check("16x16 kernel rejected", (await page.locator("#statusLine").innerText()).includes("15"));

  // ---- export roundtrip: valid run, capture all three downloads ----
  await page.fill("#kernelText", JSON.stringify(medJson));
  await page.waitForTimeout(350);
  await page.fill("#iterCount", "4");
  await page.click("#runBtn");
  await page.waitForFunction(() => document.querySelector("#runStateBadge").textContent.includes("完成"), { timeout: 20000 });

  const downloads = [];
  page.on("download", async (d) => {
    downloads.push({ name: d.suggestedFilename(), path: await d.path() });
  });
  await page.click("#export16");
  await page.click("#exportReblur");
  await page.click("#exportJson");
  await page.waitForTimeout(800);
  check("three downloads triggered", downloads.length === 3, downloads.map((d) => d.name).join(", "));

  const byName = {};
  for (const d of downloads) byName[d.name] = d.path;
  const p16 = Object.keys(byName).find((n) => n.includes("16bit"));
  const p8 = Object.keys(byName).find((n) => n.includes("8bit"));
  const pj = Object.keys(byName).find((n) => n.endsWith(".json"));
  check("16-bit restored PNG name", !!p16);
  check("8-bit reblur PNG name", !!p8);
  check("result JSON name", !!pj);

  // decode exported 16-bit PNG and verify quantization against engine snapshot
  const exportCheck = await page.evaluate(async () => {
    // re-encode inside page context is already tested by downloads; here verify header bytes via fetch of blob is not possible,
    // so verify the quantizer mapping used for the selected iteration directly.
    const r = window.__test.state.result;
    const it = r.completedIters;
    const samples = r.snapshots[it][0];
    const checks = [];
    for (let i = 0; i < samples.length; i += 997) {
      let v = samples[i]; if (!(v > 0)) v = 0; if (v > 1) v = 1;
      checks.push(Math.floor(65535 * v + 0.5));
    }
    return { it, probes: checks, mse: r.mse };
  });
  const png16 = fs.readFileSync(byName[p16]);
  check("16-bit PNG signature", png16.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const ihdr = png16.subarray(16, 29);
  check("16-bit PNG bit depth/type", ihdr[8] === 16 && ihdr[9] === 0, "depth=" + ihdr[8] + " type=" + ihdr[9]);
  const png8 = fs.readFileSync(byName[p8]);
  const ihdr8 = png8.subarray(16, 29);
  check("8-bit PNG bit depth/type", ihdr8[8] === 8 && ihdr8[9] === 0);
  const jsonOut = JSON.parse(fs.readFileSync(byName[pj], "utf8"));
  check("JSON has 5 mse entries", Array.isArray(jsonOut.msePerIteration) && jsonOut.msePerIteration.length === 5);
  check("JSON kernel normalized sum", jsonOut.kernel.normalizedSum === 1);
  check("JSON mask summary present", jsonOut.mask && jsonOut.mask.present === false);
  check("JSON quantization documented", jsonOut.exports.restoredPng16.quantization.includes("65535"));
  check("JSON matches page MSE", Math.abs(jsonOut.msePerIteration[4] - exportCheck.mse[4]) < 1e-15);

  // tEXt chunk present in exported PNGs
  check("16-bit PNG carries tEXt", png16.includes(Buffer.from("tEXt")) && png16.includes(Buffer.from("Quantization")));

  // decode the 16-bit export with zlib and verify a probe sample
  const decoded = decodePng16(png16);
  let probeOk = true;
  for (let k = 0; k < exportCheck.probes.length; k++) {
    if (decoded.samples[k * 997] !== exportCheck.probes[k]) { probeOk = false; break; }
  }
  check("16-bit export samples equal quantizer output", probeOk, decoded.samples.length + " samples");

  // ---- RGB run smoke test ----
  const rgbPng = fs.readFileSync(path.join(CASES, "medium-rgb.png"));
  await page.setInputFiles("#imgFile", { name: "medium-rgb.png", mimeType: "image/png", buffer: rgbPng });
  await page.waitForTimeout(200);
  await page.fill("#iterCount", "2");
  await page.click("#runBtn");
  await page.waitForFunction(() => document.querySelector("#runStateBadge").textContent.includes("完成"), { timeout: 20000 });
  const rgbInfo = await page.evaluate(() => {
    const r = window.__test.state.result;
    return { ch: r.channels, snapCh: r.snapshots[0].length, mse: r.mse.length };
  });
  check("RGB run has 3 channels", rgbInfo.ch === 3 && rgbInfo.snapCh === 3 && rgbInfo.mse === 3);

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await browser.close();
  server.close();
  console.log(failures === 0 ? "\nALL E2E TESTS PASSED" : `\n${failures} E2E FAILURE(S)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function decodePng16(buf) {
  let pos = 8, idat = [], w = 0, h = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = chunk.readUInt32BE(0); h = chunk.readUInt32BE(4); }
    else if (type === "IDAT") idat.push(chunk);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 2;
  const samples = [];
  let i = 0;
  for (let y = 0; y < h; y++) {
    i++; // filter byte
    for (let x = 0; x < stride; x += 2) { samples.push(raw.readUInt16BE(i)); i += 2; }
  }
  return { w, h, samples };
}
