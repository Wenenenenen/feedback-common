#!/usr/bin/env node
/* 构建：把 js/cluster-core.js、js/app.js 与样例 JSON 内联为 dist/cluster-light-inspector.html */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });

let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "js", "cluster-core.js"), "utf8");
const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");

const sampleDir = path.join(root, "samples", "extracted");
const samples = {};
for (const f of fs.readdirSync(sampleDir).sort()) {
  if (!f.endsWith(".json") || f === "reference.json") continue;
  const name = f.replace(/\.json$/, "");
  samples[name] = JSON.parse(fs.readFileSync(path.join(sampleDir, f), "utf8"));
}
const sampleScript =
  "<script>globalThis.__SAMPLES__=" + JSON.stringify(samples) + ";</script>";

// 开发版 js/samples.js（file:// 直接打开 index.html 时也能选样例）
fs.writeFileSync(
  path.join(root, "js", "samples.js"),
  "globalThis.__SAMPLES__=" + JSON.stringify(samples, null, 0) + ";\n",
  "utf8"
);

html = html.replace(
  '<script src="js/cluster-core.js"></script>\n<script src="js/samples.js"></script>',
  "<script>\n" + core + "\n</script>\n" + sampleScript
);
if (!html.includes("/*__APP_JS__*/")) throw new Error("app placeholder missing");
html = html.replace("/*__APP_JS__*/", app);

const out = path.join(distDir, "cluster-light-inspector.html");
fs.writeFileSync(out, html, "utf8");
const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log("built " + path.relative(root, out) + "  (" + kb + " KB, " +
  Object.keys(samples).length + " samples embedded)");
