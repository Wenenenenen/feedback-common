/* Playwright 端到端：真实浏览器中驱动整个页面 */
"use strict";
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const DATA = "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk/sample-data";
const URL = "http://127.0.0.1:8753/index.html";
const results = [];
const check = (cond, msg) => { results.push([!!cond, msg]); };

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell",
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);

  // 1. 初始空态
  check(await page.locator("#waveCard").isHidden(), "初始无数据时波形卡隐藏");
  check((await page.locator(".toast").count()) >= 0, "页面正常加载");

  // 2. 导入 scene37
  await page.locator("#wavInput").setInputFiles(path.join(DATA, "scene37.wav"));
  await page.locator("#jsonInput").setInputFiles(path.join(DATA, "scene37.json"));
  await page.waitForSelector("#waveCard:not([hidden])");
  const chips = await page.locator("#metaChips .chip").allInnerTexts();
  check(chips.some((t) => t.includes("48000")), "元数据显示采样率: " + chips.join("|"));
  check(chips.some((t) => t.includes("几何张成二维")), "几何判定二维");

  // 3. 设置区间 [4800, 16800) = 0.25s 最短限制之上，分析
  await page.locator("#startInput").fill("4800");
  await page.locator("#startInput").dispatchEvent("change");
  await page.locator("#endInput").fill("16800");
  await page.locator("#endInput").dispatchEvent("change");
  await page.locator("#analyzeBtn").click();
  await page.waitForSelector("#arrayCard:not([hidden])");
  const banner = await page.locator(".status-banner .big").innerText();
  check(/^\d+\.\d+°$/.test(banner.trim()), "方位横幅显示角度: " + banner.trim());
  const bearing = parseFloat(banner);
  check(Math.abs(bearing - 37) < 0.5, "scene37 方位接近期望 37°，实测 " + bearing);

  // 4. 阵列图、GCC 小图、表格行数
  check(await page.locator("#arrayBox circle.mic-dot").count() === 5, "阵列图 5 个麦克风");
  check(await page.locator("#pairCurvesBox path.gcc-curve").count() === 10, "10 条 GCC 曲线");
  check(await page.locator("#pairTable tbody tr").count() === 10, "表格 10 行通道对");
  check(await page.locator(".gcc-peak").count() === 10, "每条曲线有实测峰标记");
  check(await page.locator(".gcc-pred").count() === 10, "每条曲线有拟合预测标记");

  // 5. 禁用一对后重算
  const firstCb = page.locator("#pairTable tbody tr").nth(0).locator("input[type=checkbox]");
  await firstCb.uncheck();
  const banner2 = parseFloat((await page.locator(".status-banner .big").innerText()).trim());
  check(isFinite(banner2), "禁用后仍给出角度 " + banner2);
  check(await page.locator("#pairTable tbody tr").nth(0).evaluate((n) => n.classList.contains("off")),
    "被禁用行置灰");

  // 6. 改权重
  const w = page.locator("#pairTable tbody tr").nth(1).locator("input.weight");
  await w.fill("3.5");
  await w.dispatchEvent("change");
  const banner3 = parseFloat((await page.locator(".status-banner .big").innerText()).trim());
  check(isFinite(banner3), "权重修改后重算角度 " + banner3);

  // 7. 导出 JSON 结构
  await page.locator("#exportBtn").click();
  await page.waitForSelector("#jsonOut:not([hidden])");
  const exported = JSON.parse(await page.locator("#jsonOut").innerText());
  check(exported.convention.gcc_formula.includes("IFFT"), "导出含坐标/算法约定");
  check(exported.analysis_interval.start_frame === 4800 &&
    exported.analysis_interval.end_frame === 16800, "导出区间正确");
  check(exported.pair_measurements.length === 10, "导出 10 对测量");
  check(exported.pair_measurements[0].enabled === false, "禁用状态进入导出");
  check(exported.pair_measurements[1].weight === 3.5, "权重进入导出");
  check(exported.bearing.valid === true && typeof exported.bearing.bearing_deg === "number",
    "导出最终方位");
  check(exported.pair_measurements[0].physical_max_lag_samples > 0, "含物理时延上限");
  check(typeof exported.pair_measurements[0].residual_samples === "number", "含拟合残差");

  // 8. 静音场景必须拒绝
  await page.locator("#wavInput").setInputFiles(path.join(DATA, "silence.wav"));
  await page.waitForTimeout(100);
  await page.locator("#analyzeBtn").click();
  await page.waitForSelector(".status-banner.err");
  const errMsg = await page.locator(".status-banner .msg").innerText();
  check(errMsg.includes("静音") || errMsg.includes("常数"), "静音被拒绝: " + errMsg);

  // 9. 共线阵列必须拒绝
  await page.locator("#wavInput").setInputFiles(path.join(DATA, "scene37.wav"));
  await page.locator("#jsonInput").setInputFiles(path.join(DATA, "collinear.json"));
  await page.waitForTimeout(100);
  await page.locator("#analyzeBtn").click();
  await page.waitForSelector(".status-banner.err");
  const errMsg2 = await page.locator(".status-banner .msg").innerText();
  check(errMsg2.includes("共线"), "共线阵列被拒绝: " + errMsg2);
  const collChip = await page.locator("#metaChips .chip.bad").allInnerTexts();
  check(collChip.some((t) => t.includes("共线")), "元数据芯片提示共线");

  // 10. scene217（反方向）
  await page.locator("#wavInput").setInputFiles(path.join(DATA, "scene217.wav"));
  await page.locator("#jsonInput").setInputFiles(path.join(DATA, "scene217.json"));
  await page.waitForTimeout(100);
  await page.locator("#analyzeBtn").click();
  await page.waitForSelector(".status-banner.ok");
  const b217 = parseFloat((await page.locator(".status-banner .big").innerText()).trim());
  check(Math.abs(b217 - 217) < 0.5, "scene217 方位接近期望 217°，实测 " + b217);

  // 11. 错误文件提示
  const badWav = "/tmp/empty.wav";
  fs.writeFileSync(badWav, Buffer.from("not a wav file at all"));
  await page.locator("#wavInput").setInputFiles(badWav);
  await page.waitForTimeout(150);
  const toastTxt = await page.locator(".toast").innerText();
  check(toastTxt.length > 0, "坏文件有错误提示: " + toastTxt);

  await page.screenshot({ path: "/tmp/app-scene217.png", fullPage: true });

  // 暗色主题截图
  await page.locator("#themeBtn").click();
  await page.locator("#wavInput").setInputFiles(path.join(DATA, "scene37.wav"));
  await page.locator("#jsonInput").setInputFiles(path.join(DATA, "scene37.json"));
  await page.waitForTimeout(100);
  await page.locator("#analyzeBtn").click();
  await page.waitForSelector(".status-banner.ok");
  await page.screenshot({ path: "/tmp/app-dark.png", fullPage: true });

  check(errors.length === 0, "无控制台错误" + (errors.length ? ": " + errors.join(" | ") : ""));

  let failed = 0;
  for (const [ok, msg] of results) {
    console.log((ok ? "PASS " : "FAIL ") + msg);
    if (!ok) failed++;
  }
  console.log("\n" + (failed === 0 ? "ALL E2E PASSED (" + results.length + ")" : failed + " FAILED"));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
