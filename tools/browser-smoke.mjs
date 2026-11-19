// Browser smoke test: serves the project, loads a real WAV through the UI,
// runs analysis, checks canvases, readouts, inspector and export payloads.
// Run: node tools/browser-smoke.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";

// Playwright is installed globally on this machine; ESM ignores NODE_PATH,
// so resolve it through a require rooted at the global modules directory.
const globalRoot = join(process.env.NVM_DIR || "/home/wendy/.nvm", "versions/node/v22.23.2/lib/node_modules");
const globalRequire = createRequire(join(globalRoot, "dummy.js"));
const { chromium } = globalRequire("playwright");

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 8791;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".wav": "audio/wav", ".json": "application/json" };

const server = createServer((req, res) => {
  const p = normalize(join(ROOT, decodeURIComponent(req.url.split("?")[0])));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!existsSync(p) || req.url === "/") {
    res.setHeader("content-type", "text/html");
    return res.end(readFileSync(join(ROOT, "index.html")));
  }
  res.setHeader("content-type", MIME[extname(p)] || "application/octet-stream");
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const result = { pass: [], fail: [] };
const check = (name, cond, detail = "") => (cond ? result.pass : result.fail).push(`${name}${detail ? " — " + detail : ""}`);

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#analyzeBtn[disabled]");

  // load the 48k/16bit sample through the real file input
  await page.setInputFiles("#fileInput", join(ROOT, "samples/extracted/phrases-48000-16.wav"));
  await page.waitForFunction(() => !document.getElementById("analyzeBtn").disabled);
  const meta = await page.textContent("#fileMeta");
  check("文件元信息显示", /48000 Hz/.test(meta) && /16 位/.test(meta) && /4\.600 s/.test(meta), meta);

  // waveform canvas painted (non-empty pixels)
  const wavePainted = await page.evaluate(() => {
    const cv = document.getElementById("waveCanvas");
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check("波形画布已绘制", wavePainted > 500, `${wavePainted} opaque pixels`);

  // run analysis
  await page.click("#analyzeBtn");
  await page.waitForFunction(
    () => !document.getElementById("csvBtn").disabled,
    { timeout: 30000 }
  );
  const status = await page.textContent("#statusLine");
  check("分析完成状态", /分析完成：460 帧/.test(status), status);

  // pitch canvas painted
  const pitchPainted = await page.evaluate(() => {
    const cv = document.getElementById("pitchCanvas");
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check("音高画布已绘制", pitchPainted > 500, `${pitchPainted} opaque pixels`);

  // hover into the 330 Hz missing-fundamental segment (t=2.3s) and read tiles
  await page.hover("#pitchCanvas", { position: await pointAt("#pitchCanvas", 2.3 / 4.6) });
  const hz = await page.textContent("#tHz");
  const note = await page.textContent("#tNote");
  const voiced = await page.textContent("#tVoiced");
  check("缺基频段音高≈330Hz", /3\d\d\.\d\d/.test(hz), hz);
  check("音名显示", /E4/.test(note), note);
  check("有声状态", /有声/.test(voiced));

  // inspector shows candidates incl. a shadowed subharmonic
  const insp = await page.textContent("#inspector");
  check("检查器含候选与剔除标记", /子谐波剔除/.test(insp) && /周期性分数/.test(insp));
  const rows = await page.$$eval("#inspRows tr", (trs) => trs.map((t) => t.className));
  check("检查器标记最终采用行", rows.some((c) => c.includes("picked")));

  // hover into noise segment (t=3.1s) -> unvoiced, nulls
  await page.hover("#pitchCanvas", { position: await pointAt("#pitchCanvas", 3.1 / 4.6) });
  const hz2 = await page.textContent("#tHz");
  const voiced2 = await page.textContent("#tVoiced");
  check("噪声段留空", hz2.trim() === "null" && /无声/.test(voiced2), hz2);

  // silence segment (t=0.1s)
  await page.hover("#pitchCanvas", { position: await pointAt("#pitchCanvas", 0.1 / 4.6) });
  const hz3 = await page.textContent("#tHz");
  check("静音段留空", hz3.trim() === "null", hz3);

  // A4 reference change updates note names: 440 -> 466 retunes E4 region
  await page.fill("#a4", "466");
  await page.dispatchEvent("#a4", "input");
  await page.hover("#pitchCanvas", { position: await pointAt("#pitchCanvas", 2.3 / 4.6) });
  const note2 = await page.textContent("#tNote");
  check("A4=466 时音名重算", note2.length > 0 && note2 !== "—", note2);
  await page.fill("#a4", "440");
  await page.dispatchEvent("#a4", "input");

  // window switch + re-analyze with 40ms
  await page.selectOption("#windowSel", "40");
  await page.click("#analyzeBtn");
  await page.waitForFunction(
    () => document.getElementById("statusLine").textContent.includes("分析完成"),
    { timeout: 30000 }
  );
  const status40 = await page.textContent("#statusLine");
  check("40ms 窗重分析", /460 帧/.test(status40) && /窗 40 ms/.test(status40), status40);

  // exports: intercept blob content by overriding download click behavior
  const exports = await page.evaluate(() => new Promise((resolve) => {
    const out = {};
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const m = this.download.match(/-(pitch\.(csv|json))$/);
      if (m) fetch(this.href).then((r) => r.text()).then((t) => { out[m[2]] = t; if (out.csv && out.json) resolve(out); });
    };
    document.getElementById("csvBtn").click();
    document.getElementById("jsonBtn").click();
    setTimeout(() => resolve(out), 3000);
  }));
  check("CSV 导出含时间基准", /time_base: time_s = center_frame/.test(exports.csv || "") && /center_frame,time_s,hz,confidence,voiced,note,cents/.test(exports.csv || ""));
  const j = JSON.parse(exports.json);
  check("JSON 导出结构", j.schema === "monophonic-pitch-contour/v1" && j.frame_count === 460 &&
    j.time_base.hop_samples === 480 && j.frames.every((f) => f.voiced === (f.hz !== null)));

  // screenshots for a visual pass (light + dark)
  mkdirSync(join(ROOT, ".tmp-check"), { recursive: true });
  await page.screenshot({ path: join(ROOT, ".tmp-check/light.png"), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(ROOT, ".tmp-check/dark.png"), fullPage: true });

  // mobile width
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("手机宽度无横向滚动", overflow);
  await page.screenshot({ path: join(ROOT, ".tmp-check/mobile.png"), fullPage: true });

  check("无控制台错误", errors.length === 0, errors.join(" | "));

  // ---- second file: 24-bit/44.1k phrases, plus glide/vibrato coverage ----
  for (const [file, expectHz, expectDur] of [
    ["phrases-44100-24.wav", /19\d\.\d\d/, "4.600 s"],
    ["glide-vibrato.wav", null, "3.000 s"],
  ]) {
    await page.setInputFiles("#fileInput", join(ROOT, "samples/extracted/" + file));
    await page.waitForFunction(() => !document.getElementById("analyzeBtn").disabled);
    const meta2 = await page.textContent("#fileMeta");
    check(`${file} 元信息`, meta2.includes(expectDur), meta2);
    await page.selectOption("#windowSel", "80");
    await page.click("#analyzeBtn");
    await page.waitForFunction(
      () => document.getElementById("statusLine").textContent.includes("分析完成"),
      { timeout: 30000 }
    );
    const st = await page.textContent("#statusLine");
    check(`${file} 分析完成`, /300 帧|460 帧/.test(st), st);
    // hover mid-file and require a voiced reading with finite cents
    await page.hover("#pitchCanvas", { position: await pointAt("#pitchCanvas", 0.5) });
    const hzMid = await page.textContent("#tHz");
    const conf = await page.textContent("#tConf");
    check(`${file} 中段有声读数`, /\d+\.\d\d/.test(hzMid) && /\d\.\d+/.test(conf), hzMid.replace(/<[^>]+>/g, "") + " / " + conf);
    if (expectHz) {
      // weak-fundamental segment is 1.2..2.0 s -> hover at 1.6 s fraction
      const frac = 1.6 / 4.6;
      await page.hover("#pitchCanvas", { position: await pointAt("#pitchCanvas", frac) });
      const tRead = await page.textContent("#tTime");
      const hzWeak = await page.textContent("#tHz");
      check(`${file} 弱基频段≈196Hz`, expectHz.test(hzWeak), `${hzWeak} at ${tRead} (frac ${frac.toFixed(3)})`);
    }
  }
} catch (e) {
  result.fail.push("异常: " + e.message);
} finally {
  await browser.close();
  server.close();
}

// Map a time fraction to a point inside the canvas plot area (padL=46, padR=10).
async function pointAt(sel, frac) {
  const box = await page.locator(sel).boundingBox();
  const padL = 46, padR = 10;
  return { x: padL + frac * (box.width - padL - padR), y: box.height / 2 };
}

console.log("PASS (" + result.pass.length + ")");
for (const p of result.pass) console.log("  ✓", p);
if (result.fail.length) {
  console.log("FAIL (" + result.fail.length + ")");
  for (const f of result.fail) console.log("  ✗", f);
  process.exit(1);
}
