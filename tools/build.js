#!/usr/bin/env node
/* Build app/index.html by inlining the validated engine and PNG encoder. */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
let html = fs.readFileSync(path.join(root, "app/index.template.html"), "utf8");
const engine = fs.readFileSync(path.join(root, "tools/engine.js"), "utf8");
const encoder = fs.readFileSync(path.join(root, "tools/png_encoder.js"), "utf8");

html = html.replace("/* == engine:engine.js == */", () => engine);
html = html.replace("/* == encoder:png_encoder.js == */", () => encoder);

if (html.includes("== engine:") || html.includes("== encoder:")) {
  console.error("placeholder substitution failed");
  process.exit(1);
}
fs.writeFileSync(path.join(root, "app/index.html"), html);
console.log("built app/index.html (" + html.length + " bytes)");
