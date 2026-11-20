// End-to-end smoke test for the page in real Chromium via Playwright.
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");

const pagePath = "http://127.0.0.1:8953/index.html";
const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(pagePath);
  await page.waitForFunction(() => document.getElementById("selftestText").textContent.includes("自检通过"), { timeout: 8000 });
  assert((await page.textContent("#selftestText")).includes("reference.json"), "self-test pill text");

  // default loaded case = affine
  await page.waitForFunction(() => document.getElementById("stActive").textContent !== "—");
  const stats = await page.evaluate(() => ({
    total: document.getElementById("stTotal").textContent,
    active: document.getElementById("stActive").textContent,
    time: document.getElementById("stTime").textContent,
    hits: document.getElementById("stHits").textContent,
  }));
  console.log("affine stats:", JSON.stringify(stats));

  // canvas actually painted (non-uniform pixels)
  const painted = await page.evaluate(() => {
    const c = document.getElementById("mainCanvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add(d[i] + "," + d[i+1] + "," + d[i+2]);
    return set.size;
  });
  assert(painted > 3, `canvas has varied colors (got ${painted})`);

  // click near a projected center and check trace panel populates with contributions
  const box = await page.locator("#overlayCanvas").boundingBox();
  await page.mouse.click(box.x + 42.5 / 64 * box.width, box.y + 29.5 / 48 * box.height);
  await page.waitForSelector(".contrib-table tr");
  const trace = await page.evaluate(() => ({
    head: document.querySelector(".trace-head .px").textContent.trim(),
    rows: document.querySelectorAll(".contrib-table tbody tr").length,
    picked: document.querySelector(".contrib-table tr.picked td")?.textContent,
    steps: document.querySelectorAll("details.steps").length,
  }));
  console.log("trace:", JSON.stringify(trace));
  assert(trace.rows >= 1, "contribution rows exist");
  assert(!!trace.picked, "picked row marked");

  // switch view mode: transmittance & depth
  for (const mode of ["trans", "depth"]) {
    await page.click(`#modeSeg button[data-mode="${mode}"]`);
    const tag = await page.textContent("#modeTag");
    assert(tag.length > 0, `mode tag for ${mode}`);
  }
  await page.click('#modeSeg button[data-mode="color"]');

  // capacity case: 2000 points performance
  await page.selectOption("#sampleSelect", "capacity.json");
  await page.waitForFunction(() => document.getElementById("stTotal").textContent === "2000");
  const cap = await page.evaluate(() => ({
    active: document.getElementById("stActive").textContent,
    time: document.getElementById("stTime").textContent,
  }));
  console.log("capacity:", JSON.stringify(cap));
  assert(cap.active === "2000", "all 2000 active");

  // invalid case: warning shown, zero active
  await page.selectOption("#sampleSelect", "invalid.json");
  await page.waitForFunction(() => document.getElementById("stInvalid").textContent === "1");
  const invalid = await page.evaluate(() => ({
    invalid: document.getElementById("stInvalid").textContent,
    warn: document.querySelectorAll("#warnBoxes .warnbox.err").length,
  }));
  console.log("invalid:", JSON.stringify(invalid));
  assert(invalid.warn >= 1, "SPD warning rendered");

  // toggle an instance off (back to overlap)
  await page.selectOption("#sampleSelect", "overlap.json");
  await page.waitForFunction(() => document.getElementById("stTotal").textContent === "2");
  await page.uncheck(".inst-item input");
  await page.waitForFunction(() => document.getElementById("stActive").textContent === "0");
  await page.check(".inst-item input");
  await page.waitForFunction(() => document.getElementById("stActive").textContent === "2");

  // camera slider change triggers re-render (viewOverride path)
  await page.fill("#yaw", "25");
  await page.dispatchEvent("#yaw", "input");
  await page.waitForTimeout(120);
  const afterYaw = await page.evaluate(() => document.getElementById("stTime").textContent);
  assert(afterYaw !== "—", "re-render after camera change");

  // export modal: float buffer JSON
  await page.click("#expFloat");
  await page.waitForSelector("#modalBack.open");
  const floatSize = await page.evaluate(() => document.getElementById("modalText").value.length);
  const floatParsed = await page.evaluate(() => JSON.parse(document.getElementById("modalText").value));
  console.log("float export bytes:", floatSize, "pixels:", floatParsed.pixels.length);
  assert(floatParsed.pixels.length === 64*48, "float buffer pixel count");
  assert(Array.isArray(floatParsed.pixels[0].linearRGB) && floatParsed.pixels[0].expectedDepth !== undefined, "float schema");
  await page.click("#modalClose");

  // click the overlap reference pixel (32,24) then export its trace
  await page.selectOption("#sampleSelect", "overlap.json");
  await page.waitForFunction(() => document.getElementById("stTotal").textContent === "2");
  const refCheck = await page.evaluate(() => {
    const c = document.getElementById("overlayCanvas");
    const r = c.getBoundingClientRect();
    return { x: r.left + (32.5 / c.width) * r.width, y: r.top + (24.5 / c.height) * r.height };
  });
  await page.mouse.click(refCheck.x, refCheck.y);
  await page.waitForSelector(".contrib-table tr");
  await page.click("#expTrace");
  const traceJson = await page.evaluate(() => JSON.parse(document.getElementById("modalText").value));
  console.log("trace export keys:", Object.keys(traceJson).join(","), "contributions:", traceJson.contributions.length);
  assert("contributions" in traceJson && "skipped" in traceJson && "result" in traceJson, "trace schema");
  assert(traceJson.contributions.length === 2, "trace has both overlapping splats");
  assert(Math.abs(traceJson.result.linearRGB[0] - 0.2) < 1e-5 && Math.abs(traceJson.result.linearRGB[2] - 0.64) < 1e-5, "trace matches reference weights");
  assert(Math.abs(traceJson.result.expectedDepth - 5.523809523809524) < 1e-4, "trace expected depth matches reference");
  assert(traceJson.result.pick.endsWith("/back"), "trace picks back by weight");
  const head = await page.evaluate(() => document.querySelector(".trace-head").textContent.replace(/\s+/g, " ").trim());
  console.log("reference pixel head:", head);
  assert(head.includes("0.2") && head.includes("0.64"), "reference weights visible in panel");
  await page.click("#modalClose");

  // PNG export
  await page.click("#expPng");
  await page.waitForFunction(() => document.getElementById("exportCanvas").width > 0);
  const pngUrl = await page.evaluate(() => document.getElementById("exportCanvas").toDataURL("image/png").slice(0, 30));
  assert(pngUrl.startsWith("data:image/png"), "PNG export produced");
  await page.click("#modalClose");

  // ellipse overlay toggle
  await page.uncheck("#ellipseOn");
  await page.check("#ellipseOn");
  await page.click('#sigmaSeg button[data-sigma="1"]');

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  await browser.close();
  if (fails.length) { console.error("FAILS:", fails); process.exit(1); }
  console.log("\nALL E2E CHECKS PASSED");
})().catch(e => { console.error(e); process.exit(1); });
