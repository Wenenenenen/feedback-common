// build.js — 把 solver + app 内联进 index.html, 产出零依赖单文件。
// 用法: node tools/build.js
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
const solver = fs.readFileSync(path.join(root, "app", "hinge-ik-solver.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app", "app.js"), "utf8");

// 去掉 solver/app 里仅用于 Node 的导出尾巴, 避免浏览器引用 module
const stripExports = (s) => s.replace(/if \(typeof module[\s\S]*?\}\);?\s*$/, "");

const bundle = `
<script>
/* ===== hinge-ik-solver.js (内联) ===== */
${stripExports(solver)}
</script>
<script>
/* ===== app.js (内联) ===== */
${app}
</script>`;

const out = html.replace('<div class="toast" id="toast"></div>', `<div class="toast" id="toast"></div>\n${bundle}`);
const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, "hinge-ik-workbench.html");
fs.writeFileSync(outPath, out, "utf8");
console.log("built", outPath, (out.length / 1024).toFixed(1) + "KB");
