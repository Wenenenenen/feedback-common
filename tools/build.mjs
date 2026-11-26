// Builds web/app.html from web/app.template.html and the tested ESM modules.
// Module bodies are inlined verbatim (only import/export keywords stripped),
// so the page executes the exact functions node-smoke.mjs exercises.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function stripModule(code) {
  return code
    .replace(/^export\s+(?=const|function|class)/gm, "")
    .replace(/^import[^;]*;\s*$/gm, "");
}

const modules = ["pnm.js", "solver.js", "png.js", "recomposite.js"]
  .map((f) => `// ===== inlined from tools/src/${f} =====\n` + stripModule(read(`tools/src/${f}`)))
  .join("\n\n");

const workerBody = read("web/worker.js");
const mainBody = read("web/main.js");
const demo = read("web/sample-data.js");
let template = read("web/app.template.html");

// The worker is built from a Blob at runtime: it needs the module functions in
// its own scope, so the module bundle is also emitted as a string. Page-scope
// code gets an executable copy of the same bundle above it.
const jsString = (code) => JSON.stringify(code);
template = template
  .replace("/*__MODULES_EXEC__*/", modules)
  .replace("/*__MODULE_STRING__*/", "const MODULE_SOURCES = " + jsString(modules) + ";")
  .replace("/*__WORKER_STRING__*/", "const WORKER_SOURCE = " + jsString(workerBody) + ";")
  .replace("/*__MAIN__*/", mainBody)
  .replace("/*__DEMO__*/", demo);

writeFileSync(join(root, "web/app.html"), template);
console.log("wrote web/app.html", template.length, "bytes");
