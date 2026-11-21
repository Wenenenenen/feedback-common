import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

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

const exe = "/home/wendy/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe });

for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({
    viewport: { width: 1360, height: 940 },
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.setInputFiles("#pngFile", join(sampleDir, "partial.png"));
  await page.setInputFiles("#jsonFile", join(sampleDir, "partial.json"));
  await page.click("#runBtn");
  await page.waitForFunction(
    () => document.getElementById("exportBtn").disabled === false);
  // click a probe point inside the covered band
  const box = await page.locator("#rawCanvas").boundingBox();
  await page.mouse.click(box.x + 64.5 * (box.width / 128),
    box.y + 48.5 * (box.height / 96));
  await page.waitForSelector("#probeData:not([hidden])");
  await page.screenshot({ path: `/tmp/shot-${theme}.png`, fullPage: true });
  await ctx.close();
}

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 }, colorScheme: "dark",
});
const mp = await mobile.newPage();
await mp.goto(`http://127.0.0.1:${port}/index.html`);
await mp.setInputFiles("#pngFile", join(sampleDir, "down.png"));
await mp.setInputFiles("#jsonFile", join(sampleDir, "down.json"));
await mp.click("#runBtn");
await mp.waitForFunction(
  () => document.getElementById("exportBtn").disabled === false);
await mp.screenshot({ path: "/tmp/shot-mobile.png", fullPage: true });
await mobile.close();

await browser.close();
server.close();
console.log("shots done");
