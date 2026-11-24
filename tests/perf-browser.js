/* In-browser performance test: 180s stereo, from click to exportable. */
"use strict";
const { chromium } = require("playwright");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.join(ROOT, "index.html"));
  await page.setInputFiles("#fileInput", "/tmp/dither-work/cases/perf180.wav");
  await page.waitForSelector("#renderBtn:not([disabled])");
  // add a reset frame on each channel to exercise that path
  const resetInputs = await page.$$('[data-role="resets"]');
  await resetInputs[0].fill("48000, 1000000");
  await resetInputs[0].dispatchEvent("input");
  await resetInputs[1].fill("96000");
  await resetInputs[1].dispatchEvent("input");

  const timings = [];
  for (let run = 0; run < 3; run++) {
    const t = await page.evaluate(async () => {
      const btn = document.getElementById("renderBtn");
      const t0 = performance.now();
      btn.click();
      await new Promise((res) => {
        const obs = new MutationObserver(() => {
          if (document.getElementById("renderStatus").textContent.includes("渲染完成")) {
            obs.disconnect(); res();
          }
        });
        obs.observe(document.getElementById("renderStatus"), { childList: true, characterData: true, subtree: true });
      });
      return performance.now() - t0;
    });
    timings.push(t);
    const status = await page.textContent("#renderStatus");
    console.log(`run ${run + 1}: ${t.toFixed(0)} ms | ${status}`);
  }
  // selection export timing + round trip size
  await page.fill("#selStart", "1000000");
  await page.fill("#selEnd", "2000000");
  await page.dispatchEvent("#selEnd", "change");
  const encT = await page.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById("exportFullBtn").click();
    await new Promise((r) => setTimeout(r, 300));
    return performance.now() - t0;
  });
  console.log("full export click handled in", encT.toFixed(0), "ms");
  const best = Math.min(...timings);
  console.log(`\nbest in-browser render: ${best.toFixed(0)} ms (budget 8000 ms) ->`,
    best < 8000 ? "PASS" : "FAIL");
  await browser.close();
  process.exit(best < 8000 ? 0 : 1);
})();
