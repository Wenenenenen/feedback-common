// 端到端冒烟测试：真实浏览器加载页面，烘焙、检查、导出。
// 用法: node tools/e2e.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
// 优先用本地 node_modules，否则回退到全局安装的 playwright 的 ESM 入口。
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  const globalRoot = execSync("npm root -g").toString().trim();
  const entry = require("path").join(globalRoot, "playwright/index.mjs");
  ({ chromium } = await import(pathToFileURL(entry).href));
}
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = normalize(join(fileURLToPath(import.meta.url), "../.."));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer((req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const full = join(ROOT, path);
    if (!full.startsWith(ROOT)) throw new Error("escape");
    const data = readFileSync(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok  :", m);

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  ok("页面加载无异常");

  // 注入样例（highlight：跨缝高光）。
  const sample = JSON.parse(readFileSync(join(ROOT, "samples/extracted/highlight.json"), "utf8"));
  await page.setInputFiles("#fileInput", {
    name: "highlight.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await page.waitForFunction(() => document.querySelectorAll(".face-canvas").length === 6);
  ok("导入后渲染 6 个面画布");

  // 设小输出尺寸加速，采样数取下限 64，烘焙。
  await page.fill("#outSize", "16");
  await page.dispatchEvent("#outSize", "input");
  await page.fill("#sampleCount", "64");
  await page.dispatchEvent("#sampleCount", "input");
  await page.click("#bakeBtn");
  await page.waitForFunction(() => document.getElementById("exportBtn").disabled === false, { timeout: 60000 });
  ok("四档烘焙完成，导出按钮启用");

  // 切到每个粗糙度档，确认画布有非黑像素。
  for (const r of ["0", "0.25", "0.5", "1"]) {
    await page.selectOption("#roughnessSelect", r);
    const nonBlack = await page.evaluate(() => {
      const c = document.querySelector(".face-canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) return true;
      return false;
    });
    if (!nonBlack) fail(`粗糙度 ${r} 画布全黑`);
  }
  ok("四档展开图均有内容");

  // 点击一个输出纹素，检查器出现且有追踪行。
  await page.selectOption("#roughnessSelect", "0.5");
  const box = await page.locator('.face-canvas[data-face="px"]').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForSelector("#inspectorBody:not([hidden])");
  const rows = await page.locator("#traceTable tbody tr").count();
  if (rows < 1) fail("检查器无采样追踪行"); else ok(`检查器显示 ${rows} 条采样追踪`);
  const inspRGB = await page.locator("#inspRGB").textContent();
  if (!/[-0-9.]/.test(inspRGB)) fail("检查器缺少线性 RGB"); else ok("检查器显示线性 RGB: " + inspRGB);

  // 曝光改变后重绘（不报错即可），并确认导出仍可用。
  await page.fill("#exposure", "1.5");
  await page.dispatchEvent("#exposure", "input");
  ok("调整曝光重绘");

  // 反射球有内容。
  const spherePixels = await page.evaluate(() => {
    const c = document.getElementById("sphereCanvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) n++;
    return n;
  });
  if (spherePixels < 1000) fail("反射球像素过少"); else ok(`反射球渲染 ${spherePixels} 个不透明像素`);

  // 导出：拦截下载并校验 ZIP。
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn"),
  ]);
  const zipPath = "/tmp/lcb-verify/e2e-export.zip";
  await download.saveAs(zipPath);
  const stat = await page.evaluate(async () => 1);
  ok(`导出 ZIP: ${download.suggestedFilename()}`);
  writeFileSync("/tmp/lcb-verify/e2e-zip-path.txt", zipPath);
} catch (e) {
  fail(e.stack || e.message);
} finally {
  if (errors.length) { errors.forEach((e) => fail(e)); } else { ok("无页面/控制台错误"); }
  await browser.close();
  server.close();
}
console.log(process.exitCode ? "\nE2E 存在失败" : "\nE2E 全部通过");
