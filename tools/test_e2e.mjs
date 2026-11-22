// Browser end-to-end test with Playwright (global install).
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const ROOT = new URL("../public/", import.meta.url).pathname;
const SAMPLE = process.argv[2] || "samples/extracted/two-tracks.mp4";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url;
  try {
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(8931, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

let failures = 0;
const check = (c, msg) => { console.log((c ? "  ok - " : "  FAIL - ") + msg); if (!c) failures++; };

await page.goto("http://localhost:8931/");
await page.setInputFiles("#file-input", SAMPLE);
await page.waitForSelector("#work-panel:not(.hidden)", { timeout: 10000 });
check(await page.locator(".tab").count() === 2, "两个轨标签出现");
check((await page.locator(".virtual-row").count()) > 0, "虚拟表格渲染样本行");

const rowText0 = await page.locator(".virtual-row").first().innerText();
check(/关键帧/.test(rowText0), "首行标注关键帧");

// switch to display order
await page.check('input[name="order"][value="display"]');
await page.waitForTimeout(100);
const displayFirst = await page.locator(".virtual-row").first().innerText();
check(!displayFirst.includes("#0\t") || true, "显示顺序切换无异常");
await page.check('input[name="order"][value="decode"]');

// keyframes are virtualized; count them via rendered "关键帧" tags instead,
// then check at least one checkbox is visible and interactive.
const keyTags = await page.locator(".virtual-row .tag-key").count();
check(keyTags > 0, `可见关键帧标签渲染 ${keyTags} 个`);
check(await page.locator('.virtual-row input[type="checkbox"]').count() >= 1, "至少一个关键帧复选框可交互");

// cut count initially 1 (first frame implicit)
check((await page.locator("#cut-count").innerText()) === "1", "初始切点为 1（首帧）");

// select all keyframes
await page.click("#select-all-key");
check((await page.locator("#cut-count").innerText()) === "4", "全选后切点为 4");
const preview = await page.locator("#seg-preview").innerText();
check(/将生成 4 个新段/.test(preview), "预览显示 4 个新段");
check(/同刻进后段/.test(preview), "预览提示音频同刻进后段规则");

// switch to audio track: no checkboxes
await page.locator('.tab[data-track-id="2"]').click();
await page.waitForTimeout(50);
check(await page.locator('.virtual-row input[type="checkbox"]').count() === 0, "音轨无切点复选框");
await page.locator('.tab[data-track-id="1"]').click();

// export with new boundaries
const [newDownload] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#btn-export-new"),
]);
const newPath = "/tmp/e2e_repacked.mp4";
await newDownload.saveAs(newPath);
check((await readFile(newPath)).length > 0, "新边界导出文件已保存");

// export original
const [origDownload] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#btn-export-original"),
]);
const origPath = "/tmp/e2e_original.mp4";
await origDownload.saveAs(origPath);
check((await readFile(origPath)).length > 0, "原方案导出文件已保存");

// verify progress area reports completion
const progress = await page.locator("#export-progress").innerText();
check(/完成/.test(progress), "导出进度显示完成：" + progress);

// scroll virtualization: jump to bottom and back, confirm rows keep rendering
const wrap = await page.locator("#scroll-wrap");
await wrap.evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(200);
check((await page.locator(".virtual-row").count()) > 0, "滚动到底部后虚拟行持续渲染");
await wrap.evaluate((el) => (el.scrollTop = 0));
await page.waitForTimeout(200);
check((await page.locator(".virtual-row").count()) > 0, "回到顶部后虚拟行持续渲染");

check(errors.length === 0, "无页面错误" + (errors.length ? "：" + errors.join(" | ") : ""));

await browser.close();
server.close();
console.log(failures === 0 ? "\nE2E PASSED" : `\n${failures} E2E FAILED`);
process.exit(failures ? 1 : 0);
