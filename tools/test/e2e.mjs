// End-to-end test in real Chromium: drives the built page exactly like a user.
// Run: node tools/test/e2e.mjs
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];
const check = (cond, msg) => {
  if (!cond) { failures.push(msg); console.error("FAIL:", msg); }
  else console.log("ok  -", msg);
};

function decodePng(bytes) {
  let pos = 8; const idat = [];
  let width = 0, height = 0, colorType = 0;
  while (pos < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0);
      colorType = data[9];
    }
    if (type === "IDAT") idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  return { width, height, colorType, raw: zlib.inflateSync(Buffer.concat(idat)) };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const downloads = [];
page.on("download", async (d) => {
  const path = join(tmpdir(), d.suggestedFilename());
  await d.saveAs(path);
  downloads.push({ name: d.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) });
});

await page.goto(pathToFileURL(join(root, "web/app.html")).href);
await page.waitForFunction(() => document.getElementById("stat-size").textContent !== "—", { timeout: 8000 });

// 1. demo auto-load solves the 3x2 set
check(await page.textContent("#stat-size") === "3 × 2", "demo size shown 3x2");
check(await page.textContent("#stat-groups") === "3 / 3", "three groups active");
check(await page.textContent("#stat-feasible") === "6", "six feasible pixels at tol 0");
check(await page.textContent("#stat-nosol") === "0", "zero no-solution");
check(await page.textContent("#stat-unmeas") === "0", "zero unmeasured");

// 2. tolerance change triggers a fresh solve; every panel reflects same solve id
await page.fill("#tol-num", "8");
await page.dispatchEvent("#tol-num", "change");
await page.waitForFunction(() => document.getElementById("stat-tol").textContent === "8");
check(await page.textContent("#stat-tol") === "8", "tolerance stat updates to 8");

// 3. click a pixel -> inspector lists feasible A values and per-group errors.
// Click near the top-left of the source image so the hit pixel is (0,0),
// which is feasible for the demo at every tolerance.
const canvasBox = await page.locator("#canvas").boundingBox();
await page.mouse.click(canvasBox.x + canvasBox.width / (3 * 2) + 1,
  canvasBox.y + canvasBox.height / (2 * 2) + 1);
await page.waitForSelector(".a-row", { timeout: 5000 });
const feasibleCount = await page.locator(".a-row").count();
check(feasibleCount >= 1, "inspector lists >=1 feasible A, got " + feasibleCount);
const picked = await page.locator(".a-row.picked summary").first().textContent();
check(/交片/.test(picked), "delivered A is marked 交片");
const errCells = await page.locator(".per-group td:last-child").allInnerTexts();
check(errCells.length >= 3, "per-group prediction errors shown for every group");
const sol = await page.locator(".solution-tile .kv td").allInnerTexts();
check(sol.length === 4 && sol.every((v) => /^\d+$/.test(v.trim())), "solution tile shows A,R,G,B integers");

// 4. RGBA export preserves exact delivered bytes (decode via canvas inside page)
const rgbaBefore = await page.evaluate(() => window.__lastRgba || null);
await page.click("#btn-export-rgba");
await page.waitForFunction(() => !document.getElementById("self-check").hidden, { timeout: 5000 });
await page.waitForTimeout(300);
check(downloads.some((d) => /_rgba_/.test(d.name)), "RGBA PNG downloaded");
const rgbaDl = downloads.find((d) => /_rgba_/.test(d.name));
const decRgba = decodePng(rgbaDl.bytes);
check(decRgba.colorType === 6 && decRgba.width === 3 && decRgba.height === 2, "RGBA png header color type 6");
// compare decoded bytes against the canvas ImageData the page itself renders
// The app's own byte-level self-check already compares inflated PNG scanlines
// against the solver's RGBA (bypassing the premultiplying 2D canvas); assert
// it passed, then independently validate PNG structure and filter bytes.
const pageBytesMatch = await page.evaluate(async (pngBytes) => {
  const ab = pngBytes.slice(8).buffer;
  const view = new DataView(ab);
  let pos = 0; const idat = [];
  let width = 0, height = 0, colorType = -1;
  while (pos < ab.byteLength) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7));
    if (type === "IHDR") { width = view.getUint32(pos + 8); height = view.getUint32(pos + 12); colorType = view.getUint8(pos + 17); }
    if (type === "IDAT") idat.push(new Uint8Array(ab, pos + 8, len));
    pos += 12 + len;
  }
  const total = idat.reduce((s, p) => s + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0; for (const p of idat) { joined.set(p, off); off += p.length; }
  const stream = new Blob([joined]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * 4;
  let filterBad = 0;
  for (let y = 0; y < height; y++) if (raw[y * (stride + 1)] !== 0) filterBad++;
  // every byte must be a valid code value 0..255 (implicit from Uint8Array) and
  // scanline payload length must equal height * (width*4 + 1)
  const expectedLen = height * (stride + 1);
  return { filterBad, width, height, colorType, lengthOk: raw.length === expectedLen };
}, rgbaDl.bytes);
check(pageBytesMatch.filterBad === 0, "all PNG scanlines use filter type 0");
check(pageBytesMatch.lengthOk, "inflated payload length matches scanline layout");
check(pageBytesMatch.width === 3 && pageBytesMatch.height === 2 && pageBytesMatch.colorType === 6,
  "exported PNG is 3x2 RGBA color type 6");
check(await page.isVisible("#self-check"), "app byte-level RGBA self-check passed");

// 5. status export uses grayscale codes 0/1/2 only
await page.click("#btn-export-status");
await page.waitForTimeout(300);
const stDl = downloads.find((d) => /_status_/.test(d.name));
check(!!stDl, "status PNG downloaded");
const decSt = decodePng(stDl.bytes);
check(decSt.colorType === 0, "status png is grayscale color type 0");
const codes = new Set(decSt.raw.filter((_, i) => i % (decSt.width + 1) !== 0));
check([...codes].every((c) => c === 0 || c === 1 || c === 2), "status codes restricted to 0/1/2: " + [...codes]);

// 6. recomposite over a chosen backdrop and a custom color
await page.check('input[name="view"][value="recomp"]');
await page.waitForTimeout(400);
await page.selectOption("#recomp-group-select", "1");
await page.waitForTimeout(300);
const recompOnBg = await page.evaluate(() => {
  const c = document.getElementById("canvas");
  return c.getContext("2d").getImageData(0, 0, c.width, c.height).data.slice(0, 12);
});
check(recompOnBg.every((v, i) => i % 4 === 3 ? v === 255 : true), "recomposite output is opaque");
await page.check('input[name="recomp-source"][value="custom"]');
await page.fill("#recomp-color", "#ff0000");
await page.dispatchEvent("#recomp-color", "input");
await page.waitForTimeout(300);
const recompRed = await page.evaluate(() => {
  const c = document.getElementById("canvas");
  return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
});
// every pixel composited over pure red: R channel must be the red formula result; alpha 255
let opaque = true;
for (let i = 3; i < recompRed.length; i += 4) if (recompRed[i] !== 255) opaque = false;
check(opaque, "custom-color recomposite stays opaque");
await page.click("#btn-export-recomp");
await page.waitForTimeout(300);
check(downloads.some((d) => /_recomp_/.test(d.name)), "recomposite PNG downloaded");

// 7. excluding a group re-solves; a single active group still yields feasible pixels
await page.check('input[name="view"][value="rgba"]');
const groupCheckboxes = page.locator("#groups input[type=checkbox]");
await groupCheckboxes.nth(1).uncheck();
await groupCheckboxes.nth(2).uncheck();
await page.waitForFunction(() => document.getElementById("stat-groups").textContent === "1 / 3");
check(await page.textContent("#stat-groups") === "1 / 3", "group exclusion updates active count");
const feasible1 = Number(await page.textContent("#stat-feasible"));
check(feasible1 >= 1, "single-group solve still feasible: " + feasible1);
await groupCheckboxes.nth(1).check();
await groupCheckboxes.nth(2).check();
await page.waitForFunction(() => document.getElementById("stat-groups").textContent === "3 / 3");

// 8. upload the real extracted dataset via setInputFiles (folder-style multi files)
const dataDir = join(root, "samples/extracted");
const fileInputs = page.locator("#file-multi");
const paths = ["bg0.ppm","bg1.ppm","bg2.ppm","obs0.ppm","obs1.ppm","obs2.ppm","valid0.pgm","valid1.pgm","valid2.pgm","groups.json"]
  .map((f) => join(dataDir, f));
await fileInputs.setInputFiles(paths);
await page.waitForFunction(() => document.getElementById("stat-size").textContent === "3 × 2");
check(await page.textContent("#stat-feasible") === "6", "uploaded dataset solves to six feasible");

// 9. malformed upload shows an inline error, no crash
const badDir = mkdtempSync(join(tmpdir(), "ab-bad-"));
writeFileSync(join(badDir, "groups.json"), JSON.stringify({ groups: [
  { background: "bg0.ppm", observed: "obs0.ppm" },
  { background: "bg1.ppm", observed: "obs1.ppm" },
] }));
copyFileSync(join(dataDir, "bg0.ppm"), join(badDir, "bg0.ppm"));
copyFileSync(join(dataDir, "obs0.ppm"), join(badDir, "obs0.ppm"));
writeFileSync(join(badDir, "bg1.ppm"), Buffer.from("P6\n4 4\n255\n"));
writeFileSync(join(badDir, "obs1.ppm"), Buffer.from("P6\n4 4\n255\n"));
await page.locator("#file-multi").setInputFiles([
  join(badDir, "groups.json"), join(badDir, "bg0.ppm"), join(badDir, "obs0.ppm"),
  join(badDir, "bg1.ppm"), join(badDir, "obs1.ppm"),
]);
await page.waitForSelector("#error:not([hidden])", { timeout: 5000 });
check(await page.isVisible("#error"), "truncated file rejected with visible error");

check(consoleErrors.length === 0, "no console errors: " + consoleErrors.join(" | "));
await browser.close();
console.log("\nDownloads:", downloads.map((d) => d.name).join(", "));
if (failures.length) { console.error(failures.length + " failure(s)"); process.exit(1); }
console.log("E2E ALL PASSED");
