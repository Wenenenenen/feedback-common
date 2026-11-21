/* Edge-case checks driven through the real UI. */
const path = require("path");
const os = require("os");
const { chromium } = require(path.join(
  os.homedir(),
  ".nvm/versions/node/v22.23.2/lib/node_modules/playwright"
));
const fileUrl = "file://" + path.resolve(process.argv[2]);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fileUrl);

  // 1. invalid dimensions (385) rejected
  await page.fill("#inW", "385");
  $status = await page.$eval("#runBtn", (b) => b.disabled);
  console.log("run disabled without image:", $status);

  // 2. load sample, push both thresholds above any response -> zero results
  await page.click("#loadSampleBtn");
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled);
  await page.fill("#inBrightThr", "1.9");
  await page.dispatchEvent("#inBrightThr", "input");
  await page.fill("#inDarkThr", "1.9");
  await page.dispatchEvent("#inDarkThr", "input");
  await page.click("#runBtn");
  await page.waitForFunction(() =>
    document.getElementById("statusLine").textContent.includes("0 个斑点"));
  console.log("high-threshold status:",
    await page.$eval("#statusLine", (e) => e.textContent));
  const exportDisabled = await page.$eval("#exportBtn", (b) => b.disabled);
  console.log("export disabled when empty:", exportDisabled);
  const tableRows = await page.$$eval("#spotTable tbody tr", (t) => t.length);
  console.log("table rows when empty:", tableRows);
  if (!exportDisabled || tableRows !== 0) throw new Error("empty-result UI wrong");

  // 3. restore thresholds, rerun, then break spacing -> validation error
  await page.fill("#inBrightThr", "0.12");
  await page.dispatchEvent("#inBrightThr", "input");
  await page.fill("#inDarkThr", "0.12");
  await page.dispatchEvent("#inDarkThr", "input");
  await page.fill("#inDx", "0");
  await page.click("#runBtn");
  await page.waitForFunction(() =>
    document.getElementById("statusLine").classList.contains("err"));
  console.log("zero dx error:",
    await page.$eval("#statusLine", (e) => e.textContent));

  // 4. bad ratio
  await page.fill("#inDx", "0.6");
  await page.fill("#inRatio", "1");
  await page.click("#runBtn");
  await page.waitForFunction(() =>
    document.getElementById("statusLine").textContent.includes("ratio"));
  console.log("bad ratio error:",
    await page.$eval("#statusLine", (e) => e.textContent));

  // 5. valid rerun still works
  await page.fill("#inRatio", "1.25");
  await page.click("#runBtn");
  await page.waitForFunction(() =>
    document.getElementById("statusLine").textContent.startsWith("完成"));
  const finalStatus = await page.$eval("#statusLine", (e) => e.textContent);
  console.log("recovery status:", finalStatus);
  if (!finalStatus.includes("2 个斑点")) throw new Error("recovery failed");

  // 6. response-map invalid (grey) pixel count at the coarsest level grows
  await page.click('#viewSeg button[data-view="response"]');
  await page.fill("#levelSlider", "8");
  await page.dispatchEvent("#levelSlider", "input");
  const grey = await page.$eval("#view", (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let g = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 120 && d[i + 1] === 120 && d[i + 2] === 120) g++;
    }
    return g;
  });
  console.log("grey invalid pixels at level 8:", grey);
  if (grey < 5000) throw new Error("expected large invalid region at coarse level");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  console.log("\nEDGE TESTS PASSED");
  await browser.close();
})().catch((e) => { console.error("EDGE FAILED:", e); process.exit(1); });
