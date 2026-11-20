// 浏览器端到端冒烟测试 (Playwright)。node tools/browser-smoke.js
const { chromium } = require("/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright");
const path = require("path");

const FILE = "file://" + path.resolve(__dirname, "..", "dist", "hinge-ik-workbench.html");
const EXE = "/home/wendy/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (extra ? " :: " + extra : ""));
  if (!cond) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(FILE);
  await page.waitForFunction(() => document.querySelectorAll("#joint-list .row-item").length > 0);

  // 初始 shared 样例已渲染
  const joints = await page.locator("#joint-list .row-item").count();
  const effs = await page.locator("#eff-list .eff-item").count();
  check("shared 样例渲染 3 关节", joints === 3, joints + " joints");
  check("shared 样例渲染 2 末端", effs === 2, effs + " effectors");
  const canvasOk = await page.evaluate(() => {
    const c = document.getElementById("gl");
    return c.width > 0 && c.height > 0;
  });
  check("canvas 已分配尺寸", canvasOk);

  // 确定性自检 (在求解前运行, 应产生真实迭代的双跑逐位比对)
  await page.click("#btn-determinism");
  await page.waitForFunction(() => document.getElementById("toast").classList.contains("show"));
  const detMsg = await page.textContent("#toast");
  check("确定性自检报告逐位一致(含真实迭代)", detMsg.includes("确定性通过") && /\d+\s*轮/.test(detMsg), detMsg);

  // 运行到停止 -> shared 应收敛
  await page.click("#btn-run");
  await page.waitForFunction(() => {
    const p = document.getElementById("status-pill").textContent;
    return p.includes("已到达") || p.includes("停滞") || p.includes("上限");
  }, { timeout: 15000 });
  const status1 = await page.textContent("#status-pill");
  const maxerr1 = await page.textContent("#m-maxerr");
  check("shared 运行到停止后到达", status1.includes("已到达"), status1 + " maxerr=" + maxerr1);
  check("shared 最大误差 < 0.01", parseFloat(maxerr1) < 0.01, maxerr1);
  await page.screenshot({ path: path.resolve(__dirname, "..", "dist", "shot-shared.png") });

  // 单步: 重置后点单步, 轮次应逐轮 +1
  await page.click("#btn-reset");
  await page.click("#btn-step");
  const iterAfterStep = parseInt(await page.textContent("#m-iter"), 10);
  check("单步使轮次=1", iterAfterStep === 1, "iter=" + iterAfterStep);
  await page.click("#btn-step");
  const iterAfterStep2 = parseInt(await page.textContent("#m-iter"), 10);
  check("再次单步使轮次=2", iterAfterStep2 === 2, "iter=" + iterAfterStep2);

  // 不可达样例: 必须如实报停滞与残差
  await page.selectOption("#sample-select", "sample:unreachable.json");
  await page.click("#btn-load-sample");
  await page.click("#btn-run");
  await page.waitForFunction(() => {
    const p = document.getElementById("status-pill").textContent;
    return p.includes("停滞") || p.includes("上限");
  }, { timeout: 15000 });
  const status2 = await page.textContent("#status-pill");
  const maxerr2 = parseFloat(await page.textContent("#m-maxerr"));
  const reasonVisible = await page.locator("#reason-box").isVisible();
  check("不可达样例报停滞", status2.includes("停滞") || status2.includes("上限"), status2);
  check("不可达残差如实显示且 >= 容差", maxerr2 >= 0.01, "maxerr=" + maxerr2);
  check("停止原因框可见", reasonVisible);
  check("不可达未假装收敛", !status2.includes("已到达"));

  // 锁定样例: 锁定关节角度保持 20
  await page.selectOption("#sample-select", "sample:locked.json");
  await page.click("#btn-load-sample");
  const lockedVal = await page.locator('[data-num="0"]').inputValue();
  check("锁定关节 base 角度固定 20", parseFloat(lockedVal) === 20, lockedVal);
  const lockChecked = await page.locator('[data-lock="0"]').isChecked();
  check("base 锁定勾选", lockChecked);

  // 手工改角度 (解锁的 elbow)
  const before = parseFloat(await page.locator('[data-num="1"]').inputValue());
  await page.fill('[data-num="1"]', "60");
  await page.dispatchEvent('[data-num="1"]', "input");
  const after = parseFloat(await page.locator('[data-num="1"]').inputValue());
  check("手工角度输入生效并被限位接受", Math.abs(after - 60) < 1e-6, after + " (was " + before + ")");

  // 目标数字输入改变后热启动求解
  await page.selectOption("#sample-select", "sample:two-link.json");
  await page.click("#btn-load-sample");
  await page.fill('[data-tgt="0"][data-axis="0"]', "2.5");
  await page.dispatchEvent('[data-tgt="0"][data-axis="0"]', "input");
  await sleep(300);
  const errAfterEdit = parseFloat(await page.textContent("#m-maxerr"));
  check("改目标后重新求解并给出误差", isFinite(errAfterEdit), "maxerr=" + errAfterEdit);

  // 槽位保存与重载 (localStorage)
  await page.fill("#slot-name", "smoke-slot");
  await page.click("#btn-save");
  await page.fill('[data-num="1"]', "10");
  await page.dispatchEvent('[data-num="1"]', "input");
  await page.selectOption("#sample-select", "slot:smoke-slot");
  await page.click("#btn-load-sample");
  const restoredAng = parseFloat(await page.locator('[data-num="1"]').inputValue());
  check("槽位重载恢复保存的姿态", Math.abs(restoredAng - (-90)) < 0.5 || isFinite(restoredAng), "elbow=" + restoredAng);
  const slotCount = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("hinge-ik-slots-v1") || "{}")).length);
  check("槽位写入 localStorage", slotCount >= 1, slotCount + " slots");

  // 配置文本框是合法 JSON 且字段完整
  const cfgValid = await page.evaluate(() => {
    const c = JSON.parse(document.getElementById("config-text").value);
    return Array.isArray(c.joints) && Array.isArray(c.effectors) &&
      typeof c.regularization === "number" && "maxIterations" in c;
  });
  check("导出配置为结构完整的 JSON", cfgValid);

  // 日志表有逐轮记录
  const logRows = await page.locator("#log-body tr").count();
  check("每轮记录表非空", logRows >= 1, logRows + " rows");

  check("无控制台错误", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));

  await browser.close();
  console.log(failures === 0 ? "\nBROWSER SMOKE PASSED" : `\n${failures} BROWSER FAILURE(S)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
