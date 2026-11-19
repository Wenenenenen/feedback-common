/*
 * browser-smoke.mjs — 用 Playwright 做页面冒烟测试：
 * 控制台错误、首屏渲染、参数联动、真实样例导入（sha 与期望对齐）、WAV/JSON 导出。
 * 运行：node tools/browser-smoke.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const samples = join(root, "samples", "extracted");

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wav": "audio/wav",
};
const server = createServer((req, res) => {
  try {
    const url = req.url.split("?")[0];
    const file = join(root, decodeURIComponent(url === "/" ? "/index.html" : url));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector("#packet-rows tr");
console.log("首屏演示数据渲染：", await page.locator("#packet-rows tr").count(), "行/页");

// 统计块存在
const statCount = await page.locator(".stat").count();
console.log("统计块数量：", statCount);

// 首屏演示数据必须覆盖全部四种包状态
const demoStatuses = await page.evaluate(async () => {
  const { buildDemoDoc } = await import("/js/demo.js");
  const { analyzePlayout } = await import("/js/engine.js");
  const r = analyzePlayout(buildDemoDoc(), 10, "zero");
  const set = new Set(r.packets.map((p) => p.status));
  return [...set];
});
console.log("演示数据覆盖状态：", demoStatuses.join(","));
const fourStatusOk = ["accepted", "late", "duplicate", "invalid"].every((s) => demoStatuses.includes(s));

// 改延迟 -> 重算
await page.locator("#delay-slider").evaluate((el) => {
  el.value = "10";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForFunction(() => document.getElementById("delay-value").textContent === "10 ms");
console.log("延迟滑块联动：", await page.locator("#delay-value").textContent());

// 切策略（引擎结果上验证衰减标记，不依赖逐槽表当前页是否含补偿槽）
await page.click("label[for=policy-decay]");
const decayBadge = await page.evaluate(async () => {
  const { buildDemoDoc } = await import("/js/demo.js");
  const { analyzePlayout } = await import("/js/engine.js");
  const r = analyzePlayout(buildDemoDoc(), 10, "repeat_decay");
  return r.slots.find((s) => s.conceal && s.conceal.startsWith("repeat_decay"))?.conceal ?? null;
});
console.log("repeat_decay 策略槽位标记：", decayBadge);
const decayOk = typeof decayBadge === "string" && decayBadge.startsWith("repeat_decay r=1");
await page.click("label[for=policy-zero]");

// 表格分页/筛选
await page.selectOption("#filter-select", "late");
await page.waitForFunction(() => document.querySelectorAll("#packet-rows tr").length > 0);
const lateRows = await page.locator("#packet-rows tr").count();
console.log("late 筛选行数（首页）：", lateRows);
await page.selectOption("#filter-select", "all");

// 主题切换
await page.click("#theme-btn");
const theme = await page.evaluate(() => document.documentElement.dataset.theme);
console.log("主题切换：", theme);

// 导入真实 mono.json，对照期望 sha
const monoPath = join(samples, "mono.json");
await page.setInputFiles("#file-input", monoPath);
await page.waitForFunction(() => document.getElementById("file-label").textContent.includes("mono.json"));
await page.locator("#delay-slider").evaluate((el) => {
  el.value = "10";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.click("label[for=policy-zero]");

// 在页面上下文里直接跑引擎，取 PCM sha（与期望文件比）
const sha10zero = await page.evaluate(async () => {
  const eng = await import("/js/engine.js");
  const text = await (await fetch("/samples/extracted/mono.json")).text();
  const doc = JSON.parse(text);
  const res = eng.analyzePlayout(doc, 10, "zero");
  const buf = await crypto.subtle.digest("SHA-256", res.pcm);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
});
const expected = JSON.parse(readFileSync(join(samples, "mono-expected.json"), "utf8"));
const want = expected.find((e) => e.delay_ms === 10 && e.policy === "zero").pcm_sha256;
console.log("浏览器内引擎 sha 对齐：", sha10zero === want);

// WAV 导出长度与 RIFF 头
const wavInfo = await page.evaluate(async () => {
  const eng = await import("/js/engine.js");
  const wav = await import("/js/wav.js");
  const text = await (await fetch("/samples/extracted/mono.json")).text();
  const doc = JSON.parse(text);
  const res = eng.analyzePlayout(doc, 10, "zero");
  const blob = wav.buildWavBlob(res.pcm, 48000, 1);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const head = new TextDecoder().decode(buf.slice(0, 4));
  const dataLen = new DataView(buf.buffer, buf.byteOffset).getUint32(40, true);
  return { size: buf.length, head, dataLen, pcmLen: res.pcm.length };
});
console.log("WAV：", wavInfo.head, "总长度", wavInfo.size, "data 段", wavInfo.dataLen, "PCM", wavInfo.pcmLen,
  "长度精确：", wavInfo.dataLen === wavInfo.pcmLen && wavInfo.size === 44 + wavInfo.pcmLen);

// 判定 JSON 导出结构
const jsonShape = await page.evaluate(async () => {
  const eng = await import("/js/engine.js");
  const text = await (await fetch("/samples/extracted/mono.json")).text();
  const doc = JSON.parse(text);
  const res = eng.analyzePlayout(doc, 30, "repeat_decay");
  const out = eng.buildExportJson(res);
  return {
    delay: out.delay_ms,
    policy: out.policy,
    packetCount: Object.keys(out.packets).length,
    detailCount: out.packet_details.length,
    slotCount: out.slots.length,
    everySlotHasDeadline: out.slots.every((s) => Number.isInteger(s.deadline_us) && ("source" in s)),
    reasonsPresent: out.packet_details.every((p) => typeof p.reason === "string" && p.reason.length > 0),
  };
});
console.log("判定 JSON 结构：", JSON.stringify(jsonShape));

// 立体声也验一次 sha
const stereoSha = await page.evaluate(async () => {
  const eng = await import("/js/engine.js");
  const text = await (await fetch("/samples/extracted/stereo.json")).text();
  const doc = JSON.parse(text);
  const res = eng.analyzePlayout(doc, 30, "repeat_decay");
  const buf = await crypto.subtle.digest("SHA-256", res.pcm);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
});
const stereoWant = JSON.parse(readFileSync(join(samples, "stereo-expected.json"), "utf8"))
  .find((e) => e.delay_ms === 30 && e.policy === "repeat_decay").pcm_sha256;
console.log("立体声 repeat_decay sha 对齐：", stereoSha === stereoWant);

// 截图（此时主题为 dark；先复位到 light 再按序拍）
await page.click("label[for=policy-zero]");
if ((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark") {
  await page.click("#theme-btn");
}
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(300); // 等 ResizeObserver 完成重绘
await page.screenshot({ path: join(here, "shot-desktop-light.png"), fullPage: true });
await page.click("#theme-btn");
await page.waitForTimeout(200);
await page.screenshot({ path: join(here, "shot-desktop-dark.png"), fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: join(here, "shot-mobile-dark.png"), fullPage: true });
await page.click("#theme-btn");
await page.waitForTimeout(200);
await page.screenshot({ path: join(here, "shot-mobile-light.png"), fullPage: true });

await browser.close();
server.close();

if (errors.length) {
  console.log("\n浏览器错误：");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
const checks = [
  statCount === 6,
  fourStatusOk,
  decayOk,
  lateRows > 0,
  sha10zero === want,
  stereoSha === stereoWant,
  wavInfo.dataLen === wavInfo.pcmLen,
  jsonShape.everySlotHasDeadline && jsonShape.reasonsPresent,
];
console.log("\n", checks.every(Boolean) ? "全部冒烟检查通过" : "存在失败项");
process.exit(checks.every(Boolean) && errors.length === 0 ? 0 : 1);
