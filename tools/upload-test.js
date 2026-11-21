/* Manual file-upload flow: real setInputFiles on the raw sample files. */
const path = require("path");
const os = require("os");
const { chromium } = require(path.join(
  os.homedir(),
  ".nvm/versions/node/v22.23.2/lib/node_modules/playwright"
));
const appUrl = "file://" + path.resolve(process.argv[2]);
const dataDir = process.argv[3];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(appUrl);

  await page.fill("#inW", "129");
  await page.fill("#inH", "97");
  await page.setInputFiles("#imgFile", path.join(dataDir, "spots.f32"));
  await page.waitForFunction(() =>
    document.getElementById("imgFileName").textContent.includes("spots.f32"));
  await page.setInputFiles("#maskFile", path.join(dataDir, "mask.u8"));
  await page.waitForFunction(() =>
    document.getElementById("maskFileName").textContent.includes("mask.u8"));
  await page.setInputFiles("#jsonFile", path.join(dataDir, "image.json"));

  const vals = await page.evaluate(() => ({
    w: document.getElementById("inW").value,
    h: document.getElementById("inH").value,
    dx: document.getElementById("inDx").value,
    dy: document.getElementById("inDy").value,
    sigma0: document.getElementById("inSigma0").value,
    levels: document.getElementById("inLevels").value,
    ratio: document.getElementById("inRatio").value,
    thr: document.getElementById("inBrightThr").value,
  }));
  console.log("form after sidecar:", JSON.stringify(vals));
  if (vals.dx !== "0.6" || vals.sigma0 !== "1.5" || vals.levels !== "9")
    throw new Error("sidecar did not populate form");

  await page.click("#runBtn");
  await page.waitForFunction(() =>
    document.getElementById("statusLine").textContent.startsWith("完成"));
  const status = await page.$eval("#statusLine", (e) => e.textContent);
  console.log(status);
  if (!status.includes("2 个斑点")) throw new Error("upload-flow detection mismatch");

  // wrong-size image must be rejected with a clear error
  await page.setInputFiles("#imgFile", path.join(dataDir, "mask.u8"));
  await page.waitForFunction(() =>
    document.getElementById("statusLine").classList.contains("err"));
  const err = await page.$eval("#statusLine", (e) => e.textContent);
  console.log("size-mismatch error:", err);
  if (!err.includes("字节")) throw new Error("missing size error");

  console.log("\nUPLOAD TESTS PASSED");
  await browser.close();
})().catch((e) => { console.error("UPLOAD FAILED:", e); process.exit(1); });
