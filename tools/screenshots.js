/* Screenshot pass for visual review. */
const path = require("path");
const os = require("os");
const { chromium } = require(path.join(
  os.homedir(),
  ".nvm/versions/node/v22.23.2/lib/node_modules/playwright"
));
const fileUrl = "file://" + path.resolve(process.argv[2]);
const outDir = process.argv[3];

(async () => {
  const browser = await chromium.launch();

  async function shoot(name, opts) {
    const page = await browser.newPage(opts);
    await page.goto(fileUrl);
    await page.click("#loadSampleBtn");
    await page.waitForFunction(
      () => !document.getElementById("runBtn").disabled
    );
    await page.click("#runBtn");
    await page.waitForSelector("#resultPanel:not([hidden])");
    if (opts.theme) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, opts.theme);
    }
    if (opts.response) {
      await page.click('#viewSeg button[data-view="response"]');
      await page.fill("#levelSlider", "2");
      await page.dispatchEvent("#levelSlider", "input");
    }
    await page.click("#spotTable tbody tr:first-child");
    await page.waitForSelector("#detailPanel:not([hidden])");
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, name), fullPage: true });
    console.log("shot", name);
    await page.close();
  }

  await shoot("desktop-light.png", {
    viewport: { width: 1360, height: 1000 },
  });
  await shoot("desktop-dark.png", {
    viewport: { width: 1360, height: 1000 },
    theme: "dark",
  });
  await shoot("desktop-response-dark.png", {
    viewport: { width: 1360, height: 1000 },
    theme: "dark",
    response: true,
  });
  await shoot("mobile-light.png", {
    viewport: { width: 390, height: 844 },
  });
  await browser.close();
  console.log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
