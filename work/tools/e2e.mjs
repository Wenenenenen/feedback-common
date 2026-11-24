import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const ROOT = "/home/wendy/jianzhi/feedback-tasks/opus-chain-cutroom";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR " + e.message));
let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log("  FAIL:", m); } }

await page.goto("file://" + ROOT + "/index.html");
await page.waitForSelector("#demoMultiBtn");
await page.click("#demoMultiBtn");
await page.waitForSelector("#cards:not([hidden])");
await page.waitForTimeout(300);
ok((await page.textContent("#cChains")) === "3", "多链样例有 3 条链");
ok((await page.locator(".chaincard").count()) === 3, "渲染 3 张链卡");
console.log("status:", await page.textContent("#statusText"));
// locate across boundary
await page.locator('.tab[data-pane="locate"]').click();
await page.fill("#locSample", "96000");
await page.click("#locGo");
const locTxt = (await page.textContent("#locOut")).replace(/\s+/g, " ");
console.log("locate@96000:", locTxt.slice(0, 160));
ok(locTxt.includes("第 1 条"), "样本 96000 落在第 2 条链(第1索引)");

// cut across chain boundary and download
await page.locator('.tab[data-pane="cut"]').click();
await page.fill("#cutS", "90000"); await page.fill("#cutT", "110000");
await page.click("#cutGo");
await page.waitForTimeout(150);
console.log("cut note:", (await page.textContent("#cutNote")).slice(0,120));
ok((await page.locator("#cutPlans .chaincard").count()) === 2, "跨链区间产生 2 条输出链");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#cutDl")]);
const p = "/tmp/opus-tools/dl.opus";
await dl.saveAs(p);
const bytes = readFileSync(p);
console.log("downloaded bytes:", bytes.length);
ok(bytes.length > 100, "下载文件非空");

// verify downloaded file with core in node
const O = await import("node:module").then(m => m.createRequire(import.meta.url)(ROOT + "/opus-core.js"));
const idx = O.parse(new Uint8Array(bytes));
console.log("reparsed chains:", idx.chains.length, "global:", idx.globalSamples, "scanErr:", idx.scanError && idx.scanError.message);
ok(idx.chains.length === 2, "下载文件含 2 条链");
ok(idx.globalSamples === 20000, "下载文件可播 20000 样本");
ok(!idx.scanError, "无坏页");

await page.screenshot({ path: "/tmp/opus-tools/shot_cut.png" });
console.log("errors:", errs.length ? errs : "none");
console.log(`PASS ${pass} FAIL ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
