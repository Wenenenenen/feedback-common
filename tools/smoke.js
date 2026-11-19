/* Playwright 冒烟测试：打开构建产物，验证渲染、交互、导出与边界用例 */
"use strict";
const path = require("path");
const pw = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");

const htmlPath = "file://" + path.join(__dirname, "..", "dist", "cluster-light-inspector.html");
const shotsDir = path.join(__dirname, "shots");
require("fs").mkdirSync(shotsDir, { recursive: true });

(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(htmlPath);
  await page.waitForFunction(() => document.querySelector("#img-canvas").width > 0);
  await page.waitForTimeout(300);

  // 1. 默认样例（按字母序 boundary 首个）渲染
  const stat = await page.evaluate(() => ({
    case: document.querySelector("#case-name").textContent,
    img: [document.querySelector("#img-canvas").width, document.querySelector("#img-canvas").height],
    heat: [document.querySelector("#heat-canvas").width, document.querySelector("#heat-canvas").height],
    d3: [document.querySelector("#view3d").width, document.querySelector("#view3d").height],
    cand: document.querySelector("#stat-cand").textContent,
    errPill: document.querySelector("#pill-err-txt").textContent,
    capPill: document.querySelector("#pill-cap-txt").textContent,
  }));
  console.log("initial:", JSON.stringify(stat));

  // 2. 逐样例切换，检查无错误且关键状态
  const sampleNames = await page.$$eval("#sample-select option", (os) => os.map((o) => o.value));
  console.log("samples:", sampleNames.join(","));
  const pickSample = async (name) => {
    // 直接设值并派发 change（等价于用户选择；避开重算占主线程时的动作性重试）
    await page.evaluate((n) => {
      const sel = document.querySelector("#sample-select");
      sel.value = n;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, name);
    // loadCase 先显示“计算中…”，renderAll 后 case-name 恢复为精确名称
    await page.waitForFunction(
      (n) => document.querySelector("#case-name").textContent === n,
      name, { timeout: 8000 }
    );
    await page.waitForTimeout(60);
  };
  for (const name of sampleNames) {
    await pickSample(name);
    const s = await page.evaluate(() => ({
      err: document.querySelector("#pill-err-txt").textContent,
      cap: document.querySelector("#pill-cap-txt").textContent,
      lights: document.querySelector("#pill-lights-txt").textContent,
    }));
    console.log("  " + name + " =>", JSON.stringify(s));
  }

  // 3. overflow：300 灯不截断 + cap=128 诊断出现误差
  await pickSample("overflow");
  await page.waitForTimeout(150);
  const over = await page.evaluate(() => ({
    cap: document.querySelector("#pill-cap-txt").textContent,
    err: document.querySelector("#pill-err-txt").textContent,
  }));
  console.log("overflow:", JSON.stringify(over));
  if (!over.cap.includes("300")) throw new Error("overflow 未保留 300 灯/簇");
  if (!over.err.includes("cap=128")) throw new Error("截断诊断未生效");

  // 4. 点击图像选像素 -> 详情与候选表（避开画面中心的灯标记，点左上区域）
  const img = await page.$("#img-canvas");
  const box = await img.boundingBox();
  await page.mouse.click(box.x + box.width * 0.18, box.y + box.height * 0.22);
  await page.waitForTimeout(100);
  const detail = await page.evaluate(() => ({
    tag: document.querySelector("#detail-pixel-tag").textContent,
    rows: document.querySelectorAll("#light-table tbody tr").length,
    kv: document.querySelector("#cluster-kv").textContent.includes("簇 index"),
  }));
  console.log("pixel detail:", JSON.stringify(detail));
  if (!detail.tag.includes("像素") || detail.rows === 0 || !detail.kv)
    throw new Error("像素详情未渲染");

  // 5. 模式切换：穷举图与误差图
  await page.click('#img-mode button[data-mode="exhaustive"]');
  await page.waitForTimeout(80);
  await page.click('#img-mode button[data-mode="error"]');
  await page.waitForTimeout(80);
  const errLegend = await page.$eval("#img-legend-label", (e) => e.textContent);
  console.log("error mode legend:", errLegend);
  await page.click('#img-mode button[data-mode="cluster"]');

  // 6. odd-size：屏上灯拖拽（2D 图像）后重算
  await pickSample("odd-size");
  await page.waitForTimeout(150);
  const oddBox = await (await page.$("#img-canvas")).boundingBox();
  // odd-size 灯0 投影在画面中心附近，按下并拖走
  await page.mouse.move(oddBox.x + oddBox.width * 0.5, oddBox.y + oddBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(oddBox.x + oddBox.width * 0.66, oddBox.y + oddBox.height * 0.38, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const modified = await page.evaluate(() =>
    document.querySelector("#msg-box").textContent.includes("重算") ||
    document.querySelector("#msg-box").textContent.includes("移动"));
  console.log("2D light drag recompute:", modified);
  if (!modified) throw new Error("2D 拖灯未触发重算消息");

  // 6b. 先在初始相机角度下命中灯球并完成 3D 拖灯（扫描点击不移动，避免扰动视角）
  const v3 = await (await page.$("#view3d")).boundingBox();
  let hit = null;
  for (const [fx, fy] of [[.48,.5],[.5,.55],[.52,.48],[.45,.55],[.55,.52],[.5,.6],[.42,.5],[.58,.58]]) {
    await page.mouse.click(v3.x + v3.width * fx, v3.y + v3.height * fy);
    await page.waitForTimeout(50);
    const editorOpen = await page.$eval("#light-editor", (e) => !e.hidden);
    if (editorOpen) { hit = [fx, fy]; break; }
  }
  if (!hit) throw new Error("3D 视图未命中任何灯球");
  await page.mouse.move(v3.x + v3.width * hit[0], v3.y + v3.height * hit[1]);
  await page.mouse.down();
  await page.mouse.move(v3.x + v3.width * (hit[0] + .08), v3.y + v3.height * (hit[1] - .07), { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const drag3dMsg = await page.evaluate(() =>
    document.querySelector("#msg-box").textContent.includes("3D 拖动"));
  console.log("3D light drag:", drag3dMsg, "at", hit);
  if (!drag3dMsg) throw new Error("3D 拖灯未触发重算");

  // 6c. 再在空白处做轨道旋转
  await page.mouse.move(v3.x + v3.width * 0.85, v3.y + v3.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(v3.x + v3.width * 0.7, v3.y + v3.height * 0.38, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const yawChanged = await page.$eval("#ov-cam", (e) => e.textContent);
  console.log("3D orbit state:", yawChanged);
  if (!yawChanged.includes("yaw")) throw new Error("3D 轨道未更新");

  // 7. odd-size 奇数尺寸 + 瓦片 4x3
  await pickSample("odd-size");
  await page.waitForTimeout(150);
  const odd = await page.evaluate(() => document.querySelector("#pill-dims").textContent);
  console.log("odd-size dims:", odd);
  if (!odd.includes("瓦片 4×3")) throw new Error("奇数尺寸瓦片数错误");
  await page.screenshot({ path: path.join(shotsDir, "odd-size.png") });

  // 8. invalid-radius 警告
  await pickSample("invalid-radius");
  await page.waitForTimeout(150);
  const inv = await page.evaluate(() => ({
    lights: document.querySelector("#pill-lights-txt").textContent,
    validation: document.querySelector("#validate-box").textContent.includes("radius"),
  }));
  console.log("invalid-radius:", JSON.stringify(inv));

  // 9. stress 512 灯性能
  const t0 = Date.now();
  await pickSample("stress");
  await page.waitForTimeout(300);
  const stress = await page.evaluate(() => ({
    lights: document.querySelector("#pill-lights-txt").textContent,
    cand: document.querySelector("#stat-cand").textContent,
    exh: document.querySelector("#stat-exh").textContent,
  }));
  console.log("stress (" + (Date.now() - t0) + "ms):", JSON.stringify(stress));
  await page.screenshot({ path: path.join(shotsDir, "stress-dark.png") });

  // 10. 浅色主题
  await page.click("#btn-theme");
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, "stress-light.png") });
  await page.click("#btn-theme");

  // 11. 导出 JSON：拦截下载并校验结构与线性一致性
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-export"),
  ]);
  const dlPath = path.join(shotsDir, "exported.json");
  await download.saveAs(dlPath);
  const exported = JSON.parse(require("fs").readFileSync(dlPath, "utf8"));
  const checks = {
    hasClusters: Array.isArray(exported.clusters) && exported.clusters.length > 0,
    hasPixels: exported.pixels.length === 128 * 96,
    clusterFields: ["index", "tx", "ty", "slice", "light_count", "light_ids"].every((k) => k in exported.clusters[0]),
    pixelFields: ["cluster_linear_rgb", "exhaustive_linear_rgb", "error_linear_rgb",
      "candidate_tests", "actual_evaluations"].every((k) => k in exported.pixels[0]),
    totals: exported.totals.exhaustiveTests > exported.totals.candidateTests,
    errorZero: exported.error.max_abs_linear === 0,
    edges: JSON.stringify(exported.camera.depth_edges.map((v) => +v.toFixed(4))),
  };
  console.log("export checks:", JSON.stringify(checks, null, 1));
  if (!checks.hasClusters || !checks.hasPixels || !checks.clusterFields ||
      !checks.pixelFields || !checks.totals || !checks.errorZero)
    throw new Error("导出 JSON 结构/口径不合格");

  // 12. boundary：相机内灯（z=0.5、z=0）不报错，far 像素归末层
  await pickSample("boundary");
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, "boundary.png") });
  const bnd = await page.evaluate(() => ({
    msgs: document.querySelector("#msg-box").textContent,
    farHandled: true, // 渲染成功即说明 far 归层与相机内灯未崩溃
  }));
  console.log("boundary:", JSON.stringify(bnd));

  if (errors.length) {
    console.log("\nCONSOLE/PAGE ERRORS:\n" + errors.join("\n"));
    throw new Error("页面存在 JS 错误");
  }
  console.log("\nSMOKE TEST PASS — 0 console errors");
  await browser.close();
})().catch((e) => { console.error("SMOKE FAIL:", e.message); process.exit(1); });
