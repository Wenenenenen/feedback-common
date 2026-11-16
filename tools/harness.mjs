// 从最终 HTML 中抽出实际发布的内联脚本，在 DOM 桩里加载，
// 然后用 samples 包的 checks.json / 异常样例验证其换算与校验逻辑。
// 运行：node -I 不可用于 node；直接 node tools/harness.mjs <samples_dir>
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const samples = process.argv[2] || join(root, "samples", "extracted");

const html = readFileSync(join(root, "app", "index.html"), "utf-8");
const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]);
if (!blocks.some((s) => s.includes("use strict"))) throw new Error("主脚本块定位失败");

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {}, clearRect() {}, strokeRect() {}, beginPath() {},
  moveTo() {}, lineTo() {}, stroke() {}, fillRect() {},
};
function makeEl(id) {
  return {
    id, value: "", textContent: "", className: "", hidden: false,
    disabled: false, style: {}, dataset: {}, width: 0, height: 0,
    clientWidth: 400, clientHeight: 300,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], closest: () => null,
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    appendChild() {}, remove() {}, click() {}, files: [],
  };
}
const els = new Map();
const documentStub = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: { dataset: {} },
  createElement: () => makeEl("dyn"),
};
const sandbox = {
  document: documentStub,
  matchMedia: () => ({ matches: false }),
  console,
  Uint8Array, Uint8ClampedArray, Math, JSON, Array, Object, Number, String,
  Blob: class {}, atob: (s) => Buffer.from(s, "base64").toString("binary"),
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  setTimeout,
};
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
for (const b of blocks) vm.runInContext(b, sandbox);

const { validateLayout, convertPixel, ingest } = sandbox;
if (!validateLayout || !convertPixel) throw new Error("内部函数未暴露到全局");

const readJson = (n) => JSON.parse(readFileSync(join(samples, n), "utf-8"));
const readRaw = (n) => new Uint8Array(readFileSync(join(samples, n)));

let fail = 0;
const checks = readJson("checks.json");
for (const c of checks) {
  const cfg = readJson(c.file + ".json");
  const raw = readRaw(c.file + ".raw");
  const errs = validateLayout(raw, cfg);
  if (errs.length) { console.log("UNEXPECTED ERR", c.file, errs); fail++; continue; }
  const out = convertPixel(raw, cfg, c.frame, c.x, c.y, {
    matrix: c.matrix, range: c.range, siting: c.siting,
  });
  const diff = Math.max(...out.rgb.map((v, i) => Math.abs(v - c.rgb[i])));
  if (diff > 1) { console.log("FAIL", c, "got", out.rgb); fail++; }
}
console.log(`checks.json: ${checks.length - fail}/${checks.length} 通过（±1 码值）`);

// 异常样例
const cfg10 = readJson("odd-10.json");
const neg = [
  ["invalid-high-bits.raw", cfg10, "高 6 位"],
  ["invalid-short.raw", cfg10, "文件长度"],
];
for (const [f, cfg, kw] of neg) {
  const errs = validateLayout(readRaw(f), cfg);
  const ok = errs.some((e) => e.includes(kw));
  console.log(ok ? `OK  ${f} -> ${errs[0]}` : `FAIL ${f} 未报预期错误: ${errs}`);
  if (!ok) fail++;
}
for (const [f, kw] of [["invalid-stride.json", "stride"], ["invalid-overlap.json", "重叠"]]) {
  const errs = validateLayout(readRaw("odd-10.raw"), readJson(f));
  const ok = errs.some((e) => e.includes(kw));
  console.log(ok ? `OK  ${f} -> ${errs[0]}` : `FAIL ${f} 未报预期错误: ${errs}`);
  if (!ok) fail++;
}

// 逐行重叠边界：整体跨度相交但逐行不重叠 -> 通过；真实逐行重叠 -> 报错
{
  const base = readJson("odd-8.json"); // 8 位无填充位约束，便于构造干净用例
  const mk = (vOff, fb) => ({
    ...base, frame_bytes: fb,
    planes: {
      Y: { offset: 0, stride: 12 },   // 7 字节/行, 5 行 -> 末行 [48,55)
      U: { offset: 60, stride: 8 },   // 4 字节/行, 3 行 -> 末行 [76,80)
      V: { offset: vOff, stride: 8 },
    },
  });
  const fb = 140;
  const buf = new Uint8Array(fb * base.frames);
  // 按新布局把原有效采样填入（其余为 0，合法）
  const old = readRaw("odd-8.raw");
  const op = base.planes;
  for (let f = 0; f < base.frames; f++) {
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 7; c++)
        buf[f * fb + 0 + r * 12 + c] = old[f * 132 + op.Y.offset + r * op.Y.stride + c];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        buf[f * fb + 60 + r * 8 + c] = old[f * 132 + op.U.offset + r * op.U.stride + c];
        buf[f * fb + 100 + r * 8 + c] = old[f * 132 + op.V.offset + r * op.V.stride + c];
      }
    }
  }
  const noOverlapErrs = validateLayout(buf, mk(100, fb));   // V 末行 [116,120)，与 U 不重叠
  const overlapErrs = validateLayout(buf, mk(61, fb));      // V 首行 [61,65) 撞上 U 首行 [60,64)
  if (noOverlapErrs.length) { console.log("FAIL 大stride误报:", noOverlapErrs); fail++; }
  else console.log("OK  逐行不重叠（整体跨度相交）通过");
  if (!overlapErrs.some((e) => e.includes("重叠"))) { console.log("FAIL JS 未检出逐行重叠", overlapErrs); fail++; }
  else console.log("OK  JS 逐行重叠检出");
}

// 冒烟：走完整 ingest 流程（含渲染），确认无异常且状态标记为成功
const rec = sandbox.EMBEDDED_SAMPLES["odd-8"];
const bytes = new Uint8Array(Buffer.from(rec.b64, "base64"));
ingest(bytes, rec.cfg, "odd-8.raw");
const pill = els.get("statusPill");
if (!pill.className.includes("ok")) { console.log("FAIL ingest 状态:", pill.className, pill.textContent); fail++; }
else console.log("OK  ingest 冒烟:", pill.textContent);
if (els.get("exportPng").disabled) { console.log("FAIL 导出按钮未启用"); fail++; }

process.exit(fail ? 1 : 0);
