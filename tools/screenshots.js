/* 干净状态截图：桌面亮色/暗色 + 手机宽度 */
"use strict";
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");
const path = require("path");
const DATA = "/home/wendy/jianzhi/feedback-tasks/microphone-bearing-desk/sample-data";

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell",
  });

  async function shoot(theme, width, height, file, mobile) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      hasTouch: !!mobile, isMobile: !!mobile,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:8753/index.html");
    if (theme === "dark") await page.locator("#themeBtn").click();
    await page.locator("#wavInput").setInputFiles(path.join(DATA, "scene37.wav"));
    await page.locator("#jsonInput").setInputFiles(path.join(DATA, "scene37.json"));
    await page.waitForSelector("#waveCard:not([hidden])");
    // 选一个 1 秒区间
    await page.locator("#startInput").fill("6000");
    await page.locator("#startInput").dispatchEvent("change");
    await page.locator("#endInput").fill("15600");
    await page.locator("#endInput").dispatchEvent("change");
    await page.locator("#analyzeBtn").click();
    await page.waitForSelector(".status-banner.ok");
    await page.locator("#exportBtn").click();
    await page.waitForSelector("#jsonOut:not([hidden])");
    await page.waitForTimeout(150);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file + " written, errors: " + errors.length);
    if (errors.length) console.log(errors.join("\n"));
    await ctx.close();
  }

  await shoot("light", 1366, 1000, "/tmp/shot-desktop-light.png", false);
  await shoot("dark", 1366, 1000, "/tmp/shot-desktop-dark2.png", false);
  await shoot("light", 390, 844, "/tmp/shot-mobile.png", true);
  await browser.close();
})();
