/* Build: inline CSS + scripts into one HTML file.
 * Emits dist/剪点字幕台.html (standalone document) and
 * dist/caption-conformer-artifact.html (skeleton-free, for publishing
 * as an Artifact, which supplies its own doctype/head/body skeleton).
 *
 *   node app/build.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname);
const dist = path.join(root, "..", "dist");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let html = read("index.html");
const css = read("src/app.css");
const engine = read("src/engine.js");
const app = read("src/app.js");

html = html.replace(
  /<link rel="stylesheet" href="src\/app\.css">/,
  "<style>\n" + css + "\n</style>"
);
html = html.replace(
  /<script src="src\/engine\.js"><\/script>\s*<script src="src\/app\.js"><\/script>/,
  "<script>\n" + engine + "\n</script>\n<script>\n" + app + "\n</script>"
);

if (/src\/app\.(css|js)/.test(html)) throw new Error("inline step left an external reference");

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "剪点字幕台.html"), html, "utf8");

// Artifact variant: keep title/style/body content, drop the document shell.
const artifact = html
  .replace(/^<!doctype html>\s*/i, "")
  .replace(/<html[^>]*>\s*/i, "")
  .replace(/<\/html>\s*$/i, "")
  .replace(/<head>\s*/i, "")
  .replace(/<\/head>\s*/i, "")
  .replace(/<body>\s*/i, "")
  .replace(/<\/body>\s*/i, "")
  .trim();

fs.writeFileSync(path.join(dist, "caption-conformer-artifact.html"), artifact + "\n", "utf8");

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + " KB";
console.log("standalone " + kb(html) + " → dist/剪点字幕台.html");
console.log("artifact   " + kb(artifact) + " → dist/caption-conformer-artifact.html");
