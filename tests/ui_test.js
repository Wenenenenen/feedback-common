/* 浏览器端到端验证：页面渲染、查询、星座图点击解释、结果卡片与报告链接 */
const path = require("path");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8000";
const S = path.resolve(__dirname, "..", "samples", "extracted");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(BASE);
  await page.waitForSelector(".lib-item");
  const libCount = await page.locator(".lib-item").count();
  console.log("library items rendered:", libCount);

  // 上传查询
  await page.setInputFiles("#query-file", path.join(S, "query.wav"));
  await page.waitForSelector(".result-card.reliable");
  const verdict = await page.locator("#verdict").innerText();
  console.log("verdict:", verdict.split("\n").slice(0, 2).join(" | "));

  const cards = await page.locator(".result-card").allInnerTexts();
  cards.forEach((t) => console.log("CARD:", t.replace(/\s+/g, " ").slice(0, 150)));

  // 可靠卡片数应为 2（a 与 duplicate）
  const reliable = await page.locator(".result-card.reliable").count();
  console.log("reliable cards:", reliable);

  // 报告链接可用
  const mdHref = await page.locator("#report-md").getAttribute("href");
  const mdResp = await page.request.get(BASE + mdHref);
  console.log("report md status:", mdResp.status());

  // 音频元素可加载且 URL 无空白污染
  const audioInfo = await page.locator(".result-card audio").first().evaluate((el) => ({
    src: el.src, hasWhitespace: /\s/.test(el.getAttribute("src")),
  }));
  console.log("audio src sample:", audioInfo.src.slice(0, 110));
  if (audioInfo.hasWhitespace) throw new Error("音频 src 含有空白字符");

  // 点击星座图上的连线中点 -> 解释面板（直接取页面内记录的命中区坐标）
  const canvas = await page.locator("#constellation");
  const box = await canvas.boundingBox();
  const target = await page.evaluate(() => {
    const entries = [...window.__finderState.pairIndexById.values()];
    // 取靠近画布中部的一条，避免点到边缘
    const pick = entries.find((e) => e.mx > 150 && e.mx < 700 && e.my > 80 && e.my < 320) || entries[0];
    return pick ? { x: pick.mx, y: pick.my, idx: pick.idx } : null;
  });
  if (!target) throw new Error("无配对连线可点击");
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await page.waitForSelector("#pair-info:not(.hidden)");
  const txt = await page.locator("#pair-info").innerText();
  console.log("explain panel (pair #" + target.idx + "):", txt.replace(/\s+/g, " ").slice(0, 300));

  // 静音查询 -> 无可靠匹配
  await page.setInputFiles("#query-file", path.join(S, "silence.wav"));
  await page.waitForSelector("#verdict.bad");
  console.log("silence verdict:", (await page.locator("#verdict").innerText()).split("\n")[0]);
  const reliableAfterSilence = await page.locator(".result-card.reliable").count();
  console.log("reliable after silence:", reliableAfterSilence);

  // 无关查询
  await page.setInputFiles("#query-file", path.join(S, "query-unrelated.wav"));
  await page.waitForSelector("#verdict.bad");
  console.log("unrelated verdict:", (await page.locator("#verdict").innerText()).split("\n")[0]);

  // 截图
  await page.setInputFiles("#query-file", path.join(S, "query.wav"));
  await page.waitForFunction(
    () => window.__finderState.query && window.__finderState.query.has_reliable_match === true,
    null, { timeout: 15000 });
  await page.waitForSelector(".result-card.reliable");
  await page.screenshot({ path: "/tmp/ui-query.png", fullPage: true });
  console.log("screenshot saved: /tmp/ui-query.png");

  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); process.exit(1); }
  if (libCount !== 3 || reliable !== 2 || reliableAfterSilence !== 0) {
    console.error("ASSERTION FAILED"); process.exit(1);
  }
  console.log("\nUI 端到端验证通过 ✔");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
