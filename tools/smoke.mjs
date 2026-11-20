#!/usr/bin/env node
/* End-to-end smoke test for the slab tracer page using headless Chromium. */
"use strict";
import http from "http";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const DIR = path.dirname(new URL(import.meta.url).pathname);
const APP = path.join(DIR, "..", "app");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const file = path.join(APP, url === "/" ? "index.html" : url);
  if (!file.startsWith(APP)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

function run() {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}/`;
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
      const downloads = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      try {
        await page.goto(base + "index.html", { waitUntil: "networkidle" });
        await page.waitForSelector(".rayitem");
        const rayCount0 = await page.locator(".rayitem").count();
        console.log("loaded rays:", rayCount0);

        // canvas actually painted
        const painted = await page.evaluate(() => {
          const c = document.getElementById("view");
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          let nonBlack = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) nonBlack++;
          return nonBlack;
        });
        console.log("painted pixels:", painted);
        if (painted < 100) throw new Error("canvas looks empty");

        // in-browser reference cross-check
        const refMatch = await page.evaluate(async () => {
          const ref = await (await fetch("data/reference.json")).json();
          const scene = await (await fetch("data/scene.json")).json();
          return scene.rays.map((r, k) => {
            const t = Tracer.trace(scene, r, "exhaustive");
            const w = ref[k];
            const hitOk = JSON.stringify(t.hit && t.hit.pixel) === JSON.stringify(w.hit && w.hit.pixel);
            const numOk = !t.hit || (Math.abs(t.hit.enter - w.hit.enter) < 1e-9
              && Math.abs(t.hit.exit - w.hit.exit) < 1e-9);
            return { id: r.id, hitOk, numOk, cands: t.candidates.length === w.candidates.length };
          });
        });
        const refBad = refMatch.filter((r) => !r.hitOk || !r.numOk || !r.cands);
        console.log("in-browser reference:", refBad.length ? refBad : "ALL MATCH");
        if (refBad.length) throw new Error("browser reference mismatch");

        // click a filled pixel to generate a reflection ray
        const box = await page.locator("canvas").boundingBox();
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await page.waitForTimeout(100);
        const rayCount1 = await page.locator(".rayitem").count();
        console.log("rays after click:", rayCount1);
        if (rayCount1 <= rayCount0) throw new Error("click did not add a ray");
        const hud = await page.locator("#hud").innerText();
        console.log("HUD:", hud.replace(/\n/g, " | "));

        // run exhaustive comparison
        await page.click("#runCompare");
        await page.waitForSelector("#compareTable:not([hidden])");
        const summary = await page.locator("#compareSummary").innerText();
        console.log("compare:", summary);
        if (!summary.includes("全部通过")) throw new Error("compare reported failures");

        // JSON export
        await page.click("#exportJson");
        await page.waitForTimeout(150);
        // PNG export
        await page.click("#exportPng");
        await page.waitForTimeout(300);
        console.log("downloads triggered:", downloads);
        if (downloads.length !== 2) throw new Error("export downloads missing");

        // switch to 256x192 capacity scene
        await page.selectOption("#sceneSelect", "capacity.json");
        await page.waitForTimeout(200);
        const dims = await page.evaluate(() => {
          const c = document.getElementById("view");
          return [c.width, c.height];
        });
        console.log("capacity canvas:", dims);
        if (dims[0] !== 256 || dims[1] !== 192) throw new Error("capacity scene did not load");
        await page.click("#runCompare");
        await page.waitForTimeout(300);
        const summary2 = await page.locator("#compareSummary").innerText();
        console.log("capacity compare:", summary2.slice(0, 60));
        if (!summary2.includes("全部通过")) throw new Error("capacity compare failures");

        // bulk ray editing round trip
        await page.fill("#bulkJson", '[{"id":"manual-1","origin":[0,0,2],"direction":[0.3,0,1]}]');
        await page.click("#loadBulk");
        await page.waitForTimeout(100);
        const n = await page.locator(".rayitem").count();
        console.log("bulk load rays:", n);
        if (n !== 1) throw new Error("bulk load failed");

        await page.screenshot({ path: path.join(DIR, "smoke-light.png"), fullPage: true });
        await page.click("#themeBtn");
        await page.waitForTimeout(80);
        await page.screenshot({ path: path.join(DIR, "smoke-dark.png"), fullPage: true });

        // phone width
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(80);
        await page.screenshot({ path: path.join(DIR, "smoke-phone.png"), fullPage: true });

        if (errors.length) throw new Error("console errors: " + errors.join(" | "));
        console.log("SMOKE PASS");
      } catch (e) {
        await page.screenshot({ path: path.join(DIR, "smoke-error.png"), fullPage: true }).catch(() => {});
        reject(e);
      } finally {
        await browser.close();
        server.close();
      }
      resolve();
    });
  });
}

run().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
