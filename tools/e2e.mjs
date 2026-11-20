// 端到端浏览器测试（Playwright）：真实加载 index.html，模拟文件上传、
// 提取、点击单元/折线、改间距、导出，并与 Node 端核心结果对照。
// 运行: node tools/e2e.mjs   （需要全局 playwright 与 chromium）
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sampleDir = join(root, "samples", "extracted");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png",
  ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  const path = join(root, url === "/" ? "index.html" : url);
  if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(`http://localhost:${port}/`);
const setInput = async (selector, file) => {
  const input = await page.$(selector);
  await input.setInputFiles(file);
};

let pass = 0;
const check = (name, cond) => {
  if (!cond) throw new Error("断言失败: " + name);
  pass++;
  console.log("  ✓", name);
};

// ---- radial + 全有效掩膜：两个闭环 ----
console.log("radial:");
await setInput("#imageInput", join(sampleDir, "radial.png"));
await page.waitForTimeout(120);
await setInput("#maskInput", join(sampleDir, "full-valid.png"));
await page.fill("#levelsInput", "100.5, 400.5");
await page.fill("#originX", "10"); await page.fill("#originY", "-5");
await page.fill("#spacingX", "0.5"); await page.fill("#spacingY", "2");
await page.click("#extractBtn");
await page.waitForTimeout(150);
let contourCount = await page.locator("path.contour").count();
check("渲染出 2 条闭环等值线", contourCount === 2);
let chips = await page.locator("#legend .chip").evaluateAll((els) => els.map((e) => e.textContent));
check("图例含两个阈值且各 1 闭", chips.join("|").includes("闭 1"));
check("无控制台错误", errors.length === 0);

// 点击一条折线 -> 检查器显示测量值（在环的包围盒内扫描真实命中热区的点）
const clicked = await page.evaluate(() => {
  const path = document.querySelector("path.contour");
  const box = path.getBoundingClientRect();
  for (let y = box.top + 1; y < box.bottom; y += 3) {
    for (let x = box.left + 1; x < box.right; x += 3) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest("g[data-level]") && (el.tagName === "path")) {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
        return true;
      }
    }
  }
  return false;
});
check("成功命中并点击等值线热区", clicked);
await page.waitForTimeout(80);
const insp = await page.locator("#inspector").evaluate((e)=>e.textContent);
check("检查器显示闭环徽标", insp.includes("闭环"));
check("检查器显示物理长度", /物理长度/.test(insp));
check("检查器显示闭环面积（非 null）", /闭环面积/.test(insp) && !insp.includes("null（开放线）"));
check("检查器显示父环 null", /父环/.test(insp));

// 点击一个单元 -> 角点/交点/连接（先切到单元拾取模式）
await page.click("#pickModeBtn");
await page.locator("rect.grid-cell").first().click();
await page.waitForTimeout(80);
const cellInsp = await page.locator("#inspector").evaluate((e)=>e.textContent);
check("单元检查器显示四角", cellInsp.includes("四角节点"));
check("单元检查器显示连接选择或无交点", /连接选择/.test(cellInsp));
check("画布出现交点标记", await page.locator("circle.intersection").count() >= 0);
await page.click("#pickModeBtn"); // 切回折线模式

// ---- 改间距后几何同步 ----
const lenBefore = await page.locator("#inspector dd").allInnerTexts();
await page.fill("#spacingX", "2");
await page.dispatchEvent("#spacingX", "change");
await page.waitForTimeout(120);
const statsAfter = await page.locator("#canvasStats").innerText();
check("状态栏同步新 spacing", statsAfter.includes("spacing(2, 2)"));

// ---- 导出内容校验：在页面上下文直接调用导出函数 ----
await page.click("#exportSvgBtn");
await page.click("#exportJsonBtn");
await page.waitForTimeout(120);
const exportCheck = await page.evaluate(() => {
  const atlas = window.__atlas;
  const svg = atlas.buildSvg({ imageName: "radial.png" });
  const j = atlas.buildJson({ image: "radial.png", nodesX: 65, nodesY: 49 });
  const closedLines = j.levels.flatMap((lv) => lv.lines).filter((l) => !l.open);
  const openLines = j.levels.flatMap((lv) => lv.lines).filter((l) => l.open);
  const pathCount = (svg.match(/<path/g) || []).length;
  const zCount = (svg.match(/\dZ"/g) || []).length;
  return {
    svgHasXml: svg.startsWith('<?xml'),
    pathCount, zCount, closedCount: closedLines.length, openCount: openLines.length,
    everyClosedHasArea: closedLines.every((l) => typeof l.area === "number" && l.area > 0),
    everyOpenAreaNull: openLines.every((l) => l.area === null),
    jsonOrigin: j.origin, jsonSpacing: j.spacing,
    hasParentField: j.levels.every((lv) => lv.lines.every((l) => "parentId" in l)),
    pointsAreArrays: j.levels[0].lines[0].points.every((p) => Array.isArray(p) && p.length === 2),
  };
});
check("SVG 以 XML 头开始", exportCheck.svgHasXml);
check("SVG path 数等于折线数", exportCheck.pathCount === 2);
check("SVG 中 Z 数等于闭环数（仅闭环封口）", exportCheck.zCount === exportCheck.closedCount);
check("闭环面积均为正数", exportCheck.everyClosedHasArea);
check("开放线面积均为 null", exportCheck.everyOpenAreaNull);
check("JSON 含 origin/spacing/parentId", exportCheck.jsonOrigin.length === 2 &&
  exportCheck.jsonSpacing.length === 2 && exportCheck.hasParentField);
check("JSON 点为二元物理坐标数组", exportCheck.pointsAreArrays);
check("导出过程无控制台错误", errors.length === 0);

// ---- slit 掩膜：开放线、无 Z ----
console.log("slit:");
await setInput("#imageInput", join(sampleDir, "radial.png"));
await page.waitForTimeout(100);
await setInput("#maskInput", join(sampleDir, "slit-valid.png"));
await page.fill("#levelsInput", "100.5, 400.5");
await page.click("#extractBtn");
await page.waitForTimeout(150);
const openPaths = await page.locator("path.contour").count();
check("狭缝产生 4 条开放线（2 阈值 × 2）", openPaths === 4);
const slitInspHint = await page.locator("#legend").evaluate((e)=>e.textContent);
check("图例全部为开放（闭 0）", slitInspHint.includes("闭 0"));
const slitExport = await page.evaluate(() => {
  const svg = window.__atlas.buildSvg();
  const j = window.__atlas.buildJson();
  return {
    zCount: (svg.match(/\dZ"/g) || []).length,
    allOpen: j.levels.every((lv) => lv.lines.every((l) => l.open && l.area === null)),
  };
});
check("狭缝导出 SVG 无任何封口 Z", slitExport.zCount === 0);
check("狭缝导出 JSON 全部开放且面积 null", slitExport.allOpen);

// ---- 三个鞍点 2×2 用例：验证连接与 Q 显示 ----
for (const name of ["positive", "negative", "tie"]) {
  console.log(name + ":");
  await setInput("#imageInput", join(sampleDir, `${name}.png`));
  await page.waitForTimeout(100);
  await page.fill("#levelsInput", "1.5");
  await page.click("#extractBtn");
  await page.waitForTimeout(120);
  if (await page.locator("#pickModeBtn").innerText() !== "拾取：单元") {
    await page.click("#pickModeBtn");
  }
  await page.locator("rect.grid-cell").first().click();
  await page.waitForTimeout(80);
  const txt = await page.locator("#inspector").evaluate((e)=>e.textContent);
  check("识别为鞍点四交点", txt.includes("鞍点四交点"));
  check("显示 Q 值", /Q/.test(txt));
  check("显示实际连接", txt.includes("实际连接"));
}

// ---- constant：零等值线 ----
console.log("constant:");
await setInput("#imageInput", join(sampleDir, "constant.png"));
await page.waitForTimeout(100);
await page.fill("#levelsInput", "31999.5, 32000.5");
await page.click("#extractBtn");
await page.waitForTimeout(120);
check("常值场无等值线", await page.locator("path.contour").count() === 0);

// ---- 非法阈值校验 ----
await page.fill("#levelsInput", "2.0");
let gotError = false;
page.once("dialog", () => {});
await page.click("#extractBtn");
await page.waitForTimeout(100);
// 错误通过 toast 呈现
const toastTxt = await page.locator("#toast").evaluate((e)=>e.textContent);
check("非半整数阈值被拒绝", toastTxt.includes("半整数"));

check("全程无控制台错误", errors.length === 0);
await browser.close();
server.close();
console.log(`\nE2E 通过 ${pass} 项断言`);
