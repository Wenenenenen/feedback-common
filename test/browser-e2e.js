/*
 * 浏览器端到端测试（Playwright + 无头 Chromium）：
 *   node test/browser-e2e.js
 * 覆盖：三类样例导入、画布渲染、点查、播/删种子、连通切换、
 * RAW/边界PNG/未到达PNG/JSON 四种导出的字节正确性、参照例分界。
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");

const ROOT = path.join(__dirname, "..");
const SAMPLES = path.join(ROOT, "samples", "extracted");
const MGSPng = require("../app/png.js");
const W = 65, H = 49; // material 样例尺寸

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failures++; console.error("  ✗ " + name + (extra ? " — " + extra : "")); }
}
// Node Buffer 可能基于池化 ArrayBuffer，需按 byteOffset 切出独立视图
function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
async function clickPixel(page, x, y, imgW) {
  const box = await page.locator("#view").boundingBox();
  const ps = box.width / imgW;
  await page.mouse.click(box.x + x * ps + ps / 2, box.y + y * ps + ps / 2);
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const downloads = [];
  page.on("download", (d) => downloads.push(d));

  await page.goto(`http://127.0.0.1:${port}/app/index.html`);
  await page.waitForSelector("#view");

  const msgText = () => page.$eval("#msgLog", (el) => el.textContent);
  const seedCount = () => page.$eval("#seedCountLine", (el) => el.textContent);

  console.log("== A. material + mask + markers 全流程 ==");
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "material.png"));
  await page.setInputFiles("#fileMask", path.join(SAMPLES, "mask.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "markers.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportJson").disabled);
  check("无页面报错（载入阶段）", errors.length === 0, errors.join(" | "));
  check("连通模式从 JSON 读到为 4", await page.$eval('input[name="connectivity"]:checked', (el) => el.value) === "4");

  // 统计表有两个标签
  const rows = await page.$$eval("#statsTable tbody tr", (trs) =>
    trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
  check("统计表含标签 1、2", rows.length === 2 && rows[0][0].includes("1") && rows[1][0].includes("2"),
    JSON.stringify(rows));
  const totalArea = rows.reduce((a, r) => a + Number(r[1]), 0);
  const countsLine = await page.$eval("#countsLine", (el) => el.textContent);
  check("计数行包含 分界/未到达/掩膜外", /分界/.test(countsLine) && /未到达/.test(countsLine) && /掩膜外/.test(countsLine),
    countsLine);

  // 通过点查核对隔离区像素 (60,40) 未到达；种子 (8,24) 归标签1、成本0
  await page.click('.tool[data-tool="inspect"]');
  const inspectAt = async (x, y, imgW) => {
    const box = await page.locator("#view").boundingBox();
    const ps = box.width / imgW; // 实际每像素屏幕尺寸（自适应缩放后）
    await page.mouse.click(box.x + x * ps + ps / 2, box.y + y * ps + ps / 2);
    return page.$eval("#inspector", (el) => el.textContent);
  };
  const ins1 = await inspectAt(8, 24, W);
  check("点查种子 (8,24)：标签1、成本0", /标签 1/.test(ins1) && /最低成本[\s\S]*0/.test(ins1), ins1);
  const ins2 = await inspectAt(60, 40, W);
  check("点查隔离区 (60,40)：未到达", /未到达/.test(ins2), ins2);
  const ins3 = await inspectAt(52, 10, W);
  check("点查竖缝 (52,10)：掩膜外排除", /掩膜外/.test(ins3), ins3);

  console.log("== B. 四种导出 ==");
  const dl = {};
  await page.click("#btnExportRaw");
  await page.click("#btnExportBoundary");
  await page.click("#btnExportUnreached");
  await page.click("#btnExportJson");
  for (let i = 0; i < 40 && downloads.length < 4; i++) await new Promise((r) => setTimeout(r, 100));
  check("触发 4 个下载", downloads.length === 4, `实际 ${downloads.length}`);
  for (const d of downloads) {
    const p = await d.path();
    dl[d.suggestedFilename()] = fs.readFileSync(p);
  }
  const names = Object.keys(dl);
  const rawName = names.find((n) => n.endsWith(".raw"));
  const bndName = names.find((n) => n.includes("boundary"));
  const unrName = names.find((n) => n.includes("unreached"));
  const jsonName = names.find((n) => n.endsWith(".json"));
  check("四类文件名齐全", !!(rawName && bndName && unrName && jsonName), names.join(","));

  const raw = dl[rawName];
  check("RAW 字节数 = 宽×高×2", raw.length === W * H * 2, `实际 ${raw.length}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const at = (x, y) => dv.getUint16((y * W + x) * 2, true);
  check("RAW 小端：种子 (8,24)=1、(43,24)=2", at(8, 24) === 1 && at(43, 24) === 2);
  check("RAW：隔离区 (60,40)=0、竖缝 (52,10)=0", at(60, 40) === 0 && at(52, 10) === 0);

  const bnd = MGSPng.decode(bufToArrayBuffer(dl[bndName]));
  check("边界 PNG 尺寸 65×49 且只含 0/255",
    bnd.width === W && bnd.height === H && new Set(bnd.gray).size <= 2 &&
    [...new Set(bnd.gray)].every((v) => v === 0 || v === 255));

  const unr = MGSPng.decode(bufToArrayBuffer(dl[unrName]));
  check("未到达 PNG：(60,40)=255、(52,10)=128、种子 (8,24)=0",
    unr.gray[40 * W + 60] === 255 && unr.gray[10 * W + 52] === 128 &&
    unr.gray[24 * W + 8] === 0);
  const unrVals = new Set(unr.gray);
  check("未到达 PNG 仅含 {0,128,255}", [...unrVals].every((v) => [0, 128, 255].includes(v)),
    [...unrVals].join(","));

  const report = JSON.parse(dl[jsonName].toString("utf8"));
  check("JSON 记录 connectivity 与全部 3 个种子",
    report.connectivity === 4 && report.markers.seeds.length === 3 &&
    report.markers.seeds.some((s) => s.x === 8 && s.y === 10 && s.label === 1));
  check("JSON 逐标签统计含 area/meanGray/bbox",
    report.stats.perLabel.every((s) =>
      Number.isInteger(s.area) && typeof s.meanGray === "number" && s.bbox.length === 4));
  const repArea = report.stats.perLabel.reduce((a, s) => a + s.area, 0);
  check("JSON 面积合计与页面统计表一致", repArea === totalArea, `${repArea} vs ${totalArea}`);
  check("JSON bbox 左闭右开且不越界", report.stats.perLabel.every((s) =>
    s.bbox[0] >= 0 && s.bbox[1] >= 0 && s.bbox[2] <= W && s.bbox[3] <= H &&
    s.bbox[2] > s.bbox[0] && s.bbox[3] > s.bbox[1]));

  console.log("== C. plateau 参照例（x=3 整列分界）==");
  downloads.length = 0;
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "plateau.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "plateau.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportBoundary").disabled);
  await page.click("#btnExportBoundary");
  for (let i = 0; i < 40 && downloads.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
  const pb = MGSPng.decode(bufToArrayBuffer(fs.readFileSync(await downloads[0].path())));
  let col3AllTie = true, otherNoTie = true;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
    if (x === 3) { if (pb.gray[y * 7 + x] !== 255) col3AllTie = false; }
    else if (pb.gray[y * 7 + x] !== 0) otherNoTie = false;
  }
  check("plateau：x=3 整列 255，其余全 0", col3AllTie && otherNoTie);

  console.log("== D. tie-tail + mask（分界不阻断，尾巴全程分界）==");
  downloads.length = 0;
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "tie-tail.png"));
  await page.setInputFiles("#fileMask", path.join(SAMPLES, "tie-tail-mask.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "tie-tail.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportUnreached").disabled);
  await page.click("#btnExportUnreached");
  await page.click("#btnExportBoundary");
  for (let i = 0; i < 40 && downloads.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  // 按下载文件名区分两类 PNG
  const fUnr = downloads.find((d) => d.suggestedFilename().includes("unreached"));
  const fBnd = downloads.find((d) => d.suggestedFilename().includes("boundary"));
  const unr2 = MGSPng.decode(bufToArrayBuffer(fs.readFileSync(await fUnr.path())));
  const bnd2 = MGSPng.decode(bufToArrayBuffer(fs.readFileSync(await fBnd.path())));
  let tailTie = true;
  for (let y = 1; y <= 6; y++) if (bnd2.gray[y * 7 + 3] !== 255) tailTie = false;
  check("tie-tail：(3,1)..(3,6) 全为分界", tailTie);
  check("tie-tail：无 255 未到达像素（尾巴全程可达）",
    !unr2.gray.some((v) => v === 255), [...new Set(unr2.gray)].join(","));
  check("tie-tail：掩膜外像素=128", unr2.gray[0] === 128 && unr2.gray[2 * 7] === 128);

  console.log("== E. 交互：播种子、删种子、八邻切换、顺序重算一致 ==");
  // 回到 material
  await page.setInputFiles("#fileImage", path.join(SAMPLES, "material.png"));
  await page.setInputFiles("#fileMask", path.join(SAMPLES, "mask.png"));
  await page.setInputFiles("#fileMarkers", path.join(SAMPLES, "markers.json"));
  await page.waitForFunction(() => !document.getElementById("btnExportJson").disabled);
  const before = await seedCount();
  await page.click('.tool[data-tool="seed"]');
  await clickPixel(page, 20, 20, W); // (20,20) 播入标签1
  const afterAdd = await seedCount();
  check("播种子后数量 +1", /种子数：4/.test(afterAdd), afterAdd);
  // 冲突位置再播标签2应被拒绝
  await page.selectOption("#labelSelect", "2");
  await clickPixel(page, 8, 24, W);
  check("冲突标签被拒绝（数量不变）", (await seedCount()) === afterAdd);
  // 切换八邻后重算成功且可导出
  await page.check('input[name="connectivity"][value="8"]');
  await page.waitForTimeout(150);
  check("切八邻后导出按钮仍可用", await page.$eval("#btnExportJson", (el) => !el.disabled));
  const msg = await msgText();
  check("切八邻触发重算消息", /重算完成/.test(msg));
  // 删除刚播的种子
  await page.click('.tool[data-tool="erase"]');
  await clickPixel(page, 20, 20, W);
  check("删种子后数量复原", (await seedCount()) === before, `${before} -> ${await seedCount()}`);

  check("全程无页面报错", errors.length === 0, errors.join(" | "));

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} 项失败` : "\n浏览器 E2E 全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
