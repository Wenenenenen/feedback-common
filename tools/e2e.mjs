/* End-to-end browser test for index.html using Playwright.
 * Usage: node tools/e2e.mjs
 * Serves the repo root and drives the real page against sample files. */
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const sampleDir = join(root, "samples", "extracted");
const MIME = { ".html": "text/html", ".js": "text/javascript",
  ".png": "image/png", ".json": "application/json" };

const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[extname(p)] || "text/plain" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// Minimal PNG parser: returns { width, height, rgba } for 8-bit RGB/RGBA.
function parsePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("bad sig");
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || !channels) throw new Error("unsupported png");
  const bpp = channels, stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos++];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + left;
      else if (filter === 2) v = cur + up;
      else if (filter === 3) v = cur + ((left + up) >> 1);
      else v = cur + paeth(left, up, upLeft);
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
};

const browser = await chromium.launch({
  executablePath: "/home/wendy/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/index.html`);

  for (const name of ["down", "up", "partial", "still"]) {
    console.log(`== ${name} ==`);
    await page.setInputFiles("#pngFile", join(sampleDir, `${name}.png`));
    await page.setInputFiles("#jsonFile", join(sampleDir, `${name}.json`));
    await page.click("#runBtn");
    await page.waitForFunction(
      () => document.getElementById("exportBtn").disabled === false);
    const status = await page.textContent("#status");
    check("run reports completion", /完成/.test(status), status);

    const probes = JSON.parse(
      readFileSync(join(sampleDir, `${name}-probes.json`), "utf8"));

    // Probe each listed point through the real click handler.
    for (const [px, py, ex, ey] of probes) {
      const box = await page.locator("#rawCanvas").boundingBox();
      const scale = box.width / 128;
      await page.mouse.click(box.x + (px + 0.5) * scale,
        box.y + (py + 0.5) * scale);
      const vals = await page.$$eval("#probeData dd", (els) =>
        els.map((e) => e.textContent.trim()));
      const gotX = parseFloat(vals[5]), gotY = parseFloat(vals[6]);
      check(`probe (${px},${py}) float coords match`,
        Math.hypot(gotX - ex, gotY - ey) < 1e-6,
        `got (${gotX},${gotY}) want (${ex},${ey})`);
      const tShown = vals[1];
      check("probe shows a finite row time", /s$/.test(tShown) &&
        Number.isFinite(parseFloat(tShown)), tShown);
    }

    // Read back the rectified canvas pixels via the page.
    const canvasInfo = await page.evaluate(() => {
      const c = document.getElementById("rectCanvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let transparent = 0, opaque = 0;
      const fullyTransparentRows = [];
      for (let y = 0; y < c.height; y++) {
        let rowTransparent = 0;
        for (let x = 0; x < c.width; x++) {
          const a = d[(y * c.width + x) * 4 + 3];
          if (a === 0) { transparent++; rowTransparent++; } else opaque++;
        }
        if (rowTransparent === c.width) fullyTransparentRows.push(y);
      }
      return { width: c.width, height: c.height, transparent, opaque,
        fullyTransparentRows };
    });
    check("rectified canvas keeps original size",
      canvasInfo.width === 128 && canvasInfo.height === 96);

    if (name === "partial") {
      // Rows outside gyro coverage must be transparent; covered rows
      // (24..71) must never be fully transparent. The exact boundary can
      // shift by one row because inverse resampling interpolates between
      // adjacent row rotations.
      const r = canvasInfo.fullyTransparentRows;
      const coveredRowFullyTransparent = r.some((y) => y >= 24 && y <= 71);
      check("partial: top and bottom rows fully transparent",
        r.includes(0) && r.includes(95), JSON.stringify(r));
      check("partial: no gyro-covered row is fully transparent",
        !coveredRowFullyTransparent, JSON.stringify(r));
      check("partial: covered rows contain opaque pixels",
        canvasInfo.opaque > 0);
      check("status warns about uncovered rows", /覆盖/.test(status), status);
    } else {
      check(`${name}: status does not flag uncovered rows`,
        !/超出 gyro 覆盖/.test(status), status);
    }

    // Export and inspect the downloaded RGBA PNG.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#exportBtn"),
    ]);
    const tmp = join(sampleDir, `_dl_${name}.png`);
    await download.saveAs(tmp);
    const png = parsePng(readFileSync(tmp));
    check("export is original-size RGBA",
      png.width === 128 && png.height === 96 && png.channels === 4);
    let dlTransparent = 0;
    for (let i = 3; i < png.data.length; i += 4)
      if (png.data[i] === 0) dlTransparent++;
    check("export alpha matches on-screen canvas",
      dlTransparent === canvasInfo.transparent,
      `dl=${dlTransparent} screen=${canvasInfo.transparent}`);
  }

  // ---- invalid input handling ----
  console.log("== validation ==");

  // t_ref outside coverage -> whole image uncovered warning.
  // pressSequentially fires the real input/change events the page listens to.
  await page.click("#p-tref", { clickCount: 3 });
  await page.keyboard.press("Delete");
  await page.keyboard.type("0.5");
  await page.keyboard.press("Tab");
  await page.waitForFunction(
    () => /t_ref=.*落在 gyro 覆盖区间/.test(
      document.getElementById("status").textContent));
  const warn = await page.textContent("#status");
  check("t_ref outside gyro range warns", /覆盖区间/.test(warn), warn);
  const allAlpha = await page.evaluate(() => {
    const c = document.getElementById("rectCanvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  });
  check("t_ref outside range renders fully transparent", allAlpha);

  // ---- PNG format / dimension validation ----
  console.log("== png validation ==");
  const rejectCases = [
    ["/tmp/rgba.png", /仅支持 RGB/],
    ["/tmp/gray.png", /仅支持 RGB/],
    ["/tmp/bit16.png", /仅支持 8 位/],
    ["/tmp/big.png", /边长必须在 2–640/],
  ];
  for (const [file, re] of rejectCases) {
    await page.setInputFiles("#pngFile", file);
    await page.waitForFunction(
      (pat) => new RegExp(pat).test(
        document.getElementById("status").textContent), re.source);
    const s = await page.textContent("#status");
    check(`rejects ${file.split("/").pop()}`, re.test(s), s);
  }
  // A valid RGB PNG is accepted and can be processed.
  await page.setInputFiles("#pngFile", "/tmp/good.png");
  await page.waitForFunction(() =>
    /图像已载入/.test(document.getElementById("status").textContent));
  check("accepts valid 8-bit RGB PNG", true);

  // ---- JSON validation ----
  console.log("== json validation ==");
  const jsonCases = [
    ["/tmp/corrupt.json", /JSON 解析失败/],
    ["/tmp/bad-direction.json", /direction/],
    ["/tmp/bad-time.json", /严格递增/],
  ];
  for (const [file, re] of jsonCases) {
    await page.setInputFiles("#jsonFile", file);
    await page.waitForFunction(
      (pat) => new RegExp(pat).test(
        document.getElementById("status").textContent), re.source);
    const s = await page.textContent("#status");
    check(`rejects ${file.split("/").pop()}`, re.test(s), s);
  }
  // Run button stays disabled when JSON is invalid, even with a good image.
  check("run disabled with invalid JSON",
    await page.locator("#runBtn").isDisabled());

  check("no console errors", consoleErrors.length === 0,
    consoleErrors.join(" | "));
} finally {
  await browser.close();
  server.close();
  for (const name of ["down", "up", "partial", "still"]) {
    const tmp = join(sampleDir, `_dl_${name}.png`);
    try { rmSync(tmp); } catch {}
  }
}

console.log(failures === 0 ? "\nE2E PASSED" : `\n${failures} E2E FAILURE(S)`);
process.exit(failures ? 1 : 0);
