// Verifies the module code actually embedded in web/app.html behaves
// identically to tools/src: extracts MODULE_SOURCES, evals it in a sandbox,
// then runs solve/inspect/encode/recomposite on the real sample data.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import vm from "node:vm";
import { parsePnm as refParser } from "../src/pnm.js";
import { solveImage as refSolve } from "../src/solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "web/app.html"), "utf8");
const m = html.match(/const MODULE_SOURCES = ("(?:[^"\\]|\\.)*");/);
if (!m) throw new Error("MODULE_SOURCES not found in built page");
const source = JSON.parse(m[1]);

const sandbox = { console, Math, TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint32Array,
  DataView, ArrayBuffer, Blob: class {}, Response: class {}, CompressionStream: undefined };
vm.createContext(sandbox);
vm.runInContext(source + "\n;this.api={parsePnm,solveImage,inspectPixel,composite,encodeRgbaPng,encodeStatusPng,recomposite};", sandbox);
const api = sandbox.api;

function readAb(p) {
  const buf = readFileSync(p);
  return Uint8Array.prototype.slice.call(buf, 0, buf.length).buffer;
}

function load(dataDir) {
  const spec = JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8"));
  const groups = [];
  let width = 0, height = 0;
  for (const g of spec.groups) {
    const bg = api.parsePnm(readAb(join(dataDir, g.background)));
    const ob = api.parsePnm(readAb(join(dataDir, g.observed)));
    if (!width) { width = bg.width; height = bg.height; }
    let mask = null;
    if (g.valid) mask = api.parsePnm(readAb(join(dataDir, g.valid))).data;
    groups.push({ bg: bg.data, obs: ob.data, mask, enabled: true });
  }
  return { width, height, groups };
}

let failures = 0;
const check = (c, msg) => { if (!c) { failures++; console.error("FAIL:", msg); } };

for (const dir of [join(root, "samples/extracted"), "/tmp/ab-synth64"]) {
  for (const tol of [0, 4, 8]) {
    const { width, height, groups } = load(dir);
    const got = api.solveImage(width, height, groups, tol);
    const want = refSolve(width, height, groups, tol);
    check(got.counts.feasible === want.counts.feasible &&
      got.counts.noSolution === want.counts.noSolution &&
      got.counts.unmeasured === want.counts.unmeasured, "counts mismatch " + dir);
    let diff = 0;
    for (let i = 0; i < got.rgba.length; i++) if (got.rgba[i] !== want.rgba[i]) diff++;
    for (let i = 0; i < got.status.length; i++) if (got.status[i] !== want.status[i]) diff++;
    check(diff === 0, "byte mismatch x" + diff + " " + dir);

    // inspector feasible-list ordering and tie-break
    const info = api.inspectPixel(width, groups, tol, width - 1, height - 1);
    if (info.status === 1) {
      for (let i = 1; i < info.feasible.length; i++)
        check(info.feasible[i].a > info.feasible[i - 1].a, "A order");
      check(info.solution[0] === info.feasible[0].a, "tie-break A");
    }
  }
}

// PNG round trip through the inlined encoder (stored-zlib fallback path forced)
const { width, height, groups } = load(join(root, "samples/extracted"));
const res = api.solveImage(width, height, groups, 0);
const png = await api.encodeRgbaPng(width, height, res.rgba);
const spng = await api.encodeStatusPng(width, height, res.status);

function decodePng(bytes) {
  let pos = 8; const idat = [];
  while (pos < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === "IDAT") idat.push(Buffer.from(bytes.subarray(pos + 8, pos + 8 + len)));
    pos += 12 + len;
  }
  return zlib.inflateSync(Buffer.concat(idat));
}
const raw = decodePng(png);
const stride = width * 4;
let mismatch = 0;
for (let p = 0; p < width * height; p++) {
  const y = (p / width) | 0;
  const lineStart = y * (stride + 1) + 1;
  const x = p % width;
  for (let k = 0; k < 4; k++) if (raw[lineStart + x * 4 + k] !== res.rgba[p * 4 + k]) mismatch++;
}
check(mismatch === 0, "inlined RGBA png byte mismatch x" + mismatch);
const sraw = decodePng(spng);
let smis = 0;
for (let p = 0; p < width * height; p++) {
  const y = (p / width) | 0;
  if (sraw[y * (width + 1) + 1 + (p % width)] !== res.status[p]) smis++;
}
check(smis === 0, "inlined status png mismatch x" + smis);

// recomposite matches integer formula
const recomp = api.recomposite(width, height, res.rgba, { r: 33, g: 77, b: 201 });
for (let p = 0; p < 2; p++) {
  const a = res.rgba[4 * p + 3];
  for (let c = 0; c < 3; c++)
    check(recomp[4 * p + c] === api.composite(a, res.rgba[4 * p + c], [33, 77, 201][c]), "recomp");
}

// demo data embedded in page must parse
const demoMatch = html.match(/window\.DEMO_FILES = (\{[\s\S]*?\});/);
check(!!demoMatch, "demo block present");
const demo = eval("(" + demoMatch[1] + ")");
check(!!demo["groups.json"] && demo["bg0.ppm"], "demo files present");

console.log(JSON.stringify({ embeddedChecks: "done", failures, pngBytes: png.length, statusBytes: spng.length }, null, 2));
if (failures) process.exit(1);
