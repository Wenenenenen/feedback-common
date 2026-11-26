/* 无头浏览器端到端测试：真实页面上传 → 拟合 → 图层渲染 → 像素检查 → 导出下载。
 * 运行：NODE_PATH=$(npm root -g) node e2e/browser-test.js
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = "http://127.0.0.1:8899";
const SAMPLES = path.resolve(__dirname, "..", "_untrusted", "duplex-cases");
const SHOTS = path.resolve(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const failures = [];
  const check = (name, cond, extra = "") => {
    console.log(`  [${cond ? "ok " : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
    if (!cond) failures.push(name);
  };
  page.on("pageerror", (e) => failures.push("页面JS异常: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("400 (Bad Request)")) {
      failures.push("console.error: " + m.text());
    }
  });

  await page.goto(BASE);
  check("页面标题", (await page.title()).includes("双面纸稿去透印"));

  // 错误路径：未选文件直接提交
  await page.click("#solveBtn");
  await sleep(100);
  check("空提交报错", await page.isVisible("#errorBanner"));

  // 正常上传（含背面掩膜与交叉校验）
  await page.setInputFiles('input[name=front]', path.join(SAMPLES, "front.pgm"));
  await page.setInputFiles('input[name=back]', path.join(SAMPLES, "back.pgm"));
  await page.setInputFiles('input[name=mask_back]', path.join(SAMPLES, "back-valid.pgm"));
  await page.setInputFiles('input[name=kernels]', path.join(SAMPLES, "kernels.json"));
  await page.check('input[name=cross_check]');

  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/solve") && r.status() === 200, { timeout: 30000 }),
    page.click("#solveBtn"),
  ]);
  await page.waitForSelector("#viewerCard:not([hidden])");
  check("诊断卡出现", await page.isVisible("#diagCard"));
  check("查看卡出现", await page.isVisible("#viewerCard"));
  check("导出卡出现", await page.isVisible("#exportCard"));

  const diagText = await page.locator("#diagGrid").innerText();
  check("KKT 达标显示", /KKT 分量最优性误差[\s\S]*?6\.\d+e-7|0\.0+/.test(diagText) || diagText.includes("e-7") || diagText.includes("e-8"),
        diagText.replace(/\n/g, " | ").slice(0, 160));
  check("容差达标标记为 good", (await page.locator(".diag-item.good").count()) >= 2);

  // 两个 canvas 都渲染出非空像素
  for (const side of ["front", "back"]) {
    const nonEmpty = await page.evaluate((s) => {
      const c = document.getElementById(s + "Canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 255) opaque++;
      return opaque;
    }, side);
    check(`${side} canvas 有不透明像素`, nonEmpty === 8, `opaque=${nonEmpty}`);
  }
  await page.screenshot({ path: path.join(SHOTS, "01-estimate.png"), fullPage: true });

  // 切换图层：残差发散色
  await page.click('.seg-btn[data-layer="residual"]');
  await sleep(150);
  const rampBg = await page.locator("#ramp").evaluate((el) => el.style.background);
  check("残差色带切换为发散色", rampBg.includes("linear-gradient") && !rampBg.includes("#000, #fff"));
  await page.screenshot({ path: path.join(SHOTS, "02-residual.png"), fullPage: true });

  // 切换透印量与掩膜
  await page.click('.seg-btn[data-layer="bleed"]');
  await sleep(100);
  await page.click('.seg-btn[data-layer="mask"]');
  await sleep(100);
  const maskInfo = await page.evaluate(() => {
    const c = document.getElementById("backCanvas");
    return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  });
  // 背面原朝向下第一个像素 (0,0) 在样本掩膜中为 0（缺测）→ 透明
  check("缺测像素透明渲染", maskInfo[3] === 0, `alpha(0,0)=${maskInfo[3]}`);
  await page.screenshot({ path: path.join(SHOTS, "03-mask.png"), fullPage: true });

  // 像素检查器：点正面 (2,0)
  await page.click('.seg-btn[data-layer="estimate"]');
  const box = await page.locator("#frontCanvas").boundingBox();
  await page.mouse.click(box.x + (2.5 / 4) * box.width, box.y + (0.5 / 2) * box.height);
  await page.waitForSelector("#inspector .inspector-body:not([hidden])");
  const insp = await page.locator("#inspector").innerText();
  check("检查器出现本面估计 X", insp.includes("本面估计 X"));
  check("检查器出现透印量 Kf·Y", insp.includes("Kf·Y"));
  check("检查器出现残差", insp.includes("残差"));
  // 点背面缺测像素 (0,0)，残差应为 null
  const bbox = await page.locator("#backCanvas").boundingBox();
  await page.mouse.click(bbox.x + (0.5 / 4) * bbox.width, bbox.y + (0.5 / 2) * bbox.height);
  const insp2 = await page.locator("#inspector").innerText();
  check("背面缺测像素残差显示 null", insp2.includes("null（缺测）"));
  check("坐标换算提示正面坐标 x=3", insp2.includes("正面坐标 (x=3"));
  await page.screenshot({ path: path.join(SHOTS, "04-inspector.png"), fullPage: true });

  // 导出下载（三个文件）
  for (const [kind, name, magic] of [
    ["front_pgm", "front-corrected.pgm", "P5"],
    ["back_pgm", "back-corrected.pgm", "P5"],
    ["fit_json", "fit-values.json", "{"],
  ]) {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      page.click(`.export-btn[data-export="${kind}"]`),
    ]);
    const dest = path.join(SHOTS, name);
    await dl.saveAs(dest);
    const head = fs.readFileSync(dest).slice(0, 2).toString();
    check(`下载 ${name}`, dl.suggestedFilename() === name && (magic === "{" ? head.startsWith("{") : head === magic));
  }

  // 深色主题截图
  await page.emulateMedia({ colorScheme: "dark" });
  await sleep(150);
  await page.screenshot({ path: path.join(SHOTS, "05-dark.png"), fullPage: true });

  // 错误路径：坏文件应返回 400 且页面显示错误横幅
  await page.setInputFiles('input[name=front]', {
    name: "bad.pgm", mimeType: "application/octet-stream", buffer: Buffer.from("P5\nnot-a-header\n"),
  });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/solve") && r.status() === 400, { timeout: 10000 }),
    page.click("#solveBtn"),
  ]);
  check("坏 PGM 返回错误提示", await page.isVisible("#errorBanner"));

  await browser.close();
  if (failures.length) {
    console.error("\n失败项：\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("\n浏览器端到端全部通过。截图位于", SHOTS);
})().catch((e) => { console.error(e); process.exit(1); });
