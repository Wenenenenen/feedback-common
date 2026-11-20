/* Screenshot helper for manual visual checks.
 * NODE_PATH=$GLOBAL_NODE_MODULES node tools/screenshot.js */
"use strict";
const path = require("path"), fs = require("fs"), http = require("http");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const srv = http.createServer((req, res) => {
  const f = path.join(ROOT, "web", req.url === "/" ? "index.html" : req.url.split("?")[0]);
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; res.end(); return; }
    res.end(d);
  });
});
(async () => {
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  p.on("pageerror", e => errors.push(e.message));
  await p.goto("http://127.0.0.1:" + srv.address().port);
  const [ch] = await Promise.all([
    p.waitForEvent("filechooser"), p.click("#btnZip")
  ]);
  await ch.setFiles(path.join(ROOT, "samples", "sinogram-rebuild-desk-cases.zip"));
  await p.waitForFunction(() =>
    document.querySelector("#caseName").textContent.includes("47"));
  const box = await (await p.$("#cvRecon")).boundingBox();
  await p.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await p.waitForTimeout(400);
  const outDir = path.join(ROOT, "tools", "_shots");
  fs.mkdirSync(outDir, { recursive: true });
  await p.screenshot({ path: path.join(outDir, "ramlak.png"), fullPage: true });
  await p.click('#modeSeg button[data-mode="unfilt"]');
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(outDir, "unfiltered.png"), fullPage: true });
  if (errors.length) { console.error("PAGE ERRORS:", errors); process.exit(1); }
  await b.close(); srv.close();
  console.log("screenshots in", outDir);
})();
