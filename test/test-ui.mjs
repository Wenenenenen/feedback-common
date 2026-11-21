// 无浏览器冒烟测试：用最小 DOM 桩驱动 app.js 走完整流程。
// 运行：node test/test-ui.mjs
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "dfc-ui-"));
execSync(`unzip -o -q ${JSON.stringify(join(root, "samples/dark-flat-calibration-cases.zip"))} -d ${JSON.stringify(dir)}`);
const cap = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));

// ---------- 最小 DOM 桩 ----------
const html = readFileSync(join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const ctxStub = () => ({
  fillStyle: "", strokeStyle: "", lineWidth: 1,
  fillRect() {}, strokeRect() {}, putImageData() {},
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
});

class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {};
    this.value = ""; this.textContent = ""; this.className = "";
    this.disabled = false; this.checked = false; this.files = [];
    this.style = {}; this.title = ""; this._html = ""; this._ctx = ctxStub();
  }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  insertRow() { const r = new El("tr"); this.children.push(r); return r; }
  insertCell() { const c = new El("td"); this.children.push(c); return c; }
  getContext() { return this._ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 100, height: this.height || 100 }; }
  click() { return this.dispatch("click", { target: this }); }
  async dispatch(ev, e) { for (const fn of this.listeners[ev] || []) await fn(e); }
}

const els = {};
const downloaded = [];
const sandbox = {
  console, setTimeout, URL, Blob, Buffer,
  document: {
    getElementById: (id) => (ids.has(id) ? (els[id] ||= new El("div")) : null),
    createElement: (t) => new El(t),
    querySelectorAll: (sel) =>
      sel === "#views canvas" ? ["cvRaw", "cvCorr", "cvCalib", "cvQual"].map((i) => (els[i] ||= new El("canvas"))) : [],
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.URL.createObjectURL = (b) => { downloaded.push(b); return "blob:mock"; };
sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, "calib-core.js"), "utf8"), sandbox, { filename: "calib-core.js" });
vm.runInContext(readFileSync(join(root, "app.js"), "utf8"), sandbox, { filename: "app.js" });

// ---------- 驱动 ----------
const fakeFile = (name) => ({
  name,
  arrayBuffer: async () => new Uint8Array(readFileSync(join(dir, name))).buffer,
  text: async () => readFileSync(join(dir, name), "utf8"),
});
const setFiles = async (id, names) => {
  els[id].files = names.map(fakeFile);
  await els[id].dispatch("change", { target: els[id] });
};
const fire = async (id, ev = "change") => els[id].dispatch(ev, { target: els[id] });

let failures = 0;
const check = (label, cond) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); };

// 1) 先导入记录 JSON（应自动填尺寸/阈值），再导入各帧（应自动填 t/level）
els.optRepair = els.optRepair || new El("div");
els.optRepair.checked = true; // HTML 中 checkbox 带 checked 属性
await setFiles("fileMeta", ["capture.json"]);
check("meta sets size", els.inW.value === cap.w && els.inH.value === cap.h);
check("meta sets thresholds", +els.thDarkMax.value === cap.darkMax && +els.thGainMax.value === cap.gainMax);
check("meta warns files not yet imported", /尚未导入/.test(els.msg.textContent));

await setFiles("fileDarks", cap.darks.map((d) => d.file));
await setFiles("fileFlats", cap.flats.map((f) => f.file));
await setFiles("fileShot", [cap.shot.file]);
check("frame counts shown", /5 张/.test(els.cntDarks.textContent) && /5 张/.test(els.cntFlats.textContent));

// 2) 计算校准
await els.btnCompute.click();
check("compute ok message", els.msg.textContent === "校准完成。");
check("export buttons enabled", !els.btnExportF32.disabled && !els.btnExportQual.disabled && !els.btnExportCalib.disabled);

// 3) 点击画布查看像素：补值点 (7,8)
const clickPixel = async (x, y) => {
  await els.cvRaw.dispatch("click", { clientX: x + 0.5, clientY: y + 0.5 });
};
await clickPixel(7, 8);
check("inspector shows repaired pixel", els.inspector.innerHTML.includes("(7, 8)") && els.inspector.innerHTML.includes("2 坏点补值"));
check("inspector lists dark samples", els.inspector.innerHTML.includes("暗场样本") && els.inspector.innerHTML.includes("d1.u16"));
check("inspector lists flat samples", els.inspector.innerHTML.includes("平场样本") && els.inspector.innerHTML.includes("f5.u16"));

await clickPixel(10, 10);
check("inspector shows saturated pixel", els.inspector.innerHTML.includes("3 拍摄饱和"));
await clickPixel(32, 24);
check("inspector shows invalid pixel", els.inspector.innerHTML.includes("0 无可用值"));
await clickPixel(4, 5);
check("inspector shows fit values", els.inspector.innerHTML.includes("149") && els.inspector.innerHTML.includes("1.25"));

// 4) 改判坏阈值：收紧 gainMax 使 gain=1.25 的像素判坏
els.thGainMax.value = "1.0";
await els.btnRejudge.click();
await clickPixel(4, 5);
check("rejudged pixel marked bad", els.inspector.innerHTML.includes("判坏") && els.inspector.innerHTML.includes("超限"));
await clickPixel(5, 5);
check("other pixel still valid", els.inspector.innerHTML.includes("有效"));
els.thGainMax.value = String(cap.gainMax);
await els.btnRejudge.click();

// 5) 导出校准 -> 清空 -> 导入校准 -> 直接校正新图
await els.btnExportCalib.click();
check("calibration downloaded", downloaded.length === 1);
const calibText = await downloaded[0].text();
els.inW.value = "0"; await fire("inW"); // 触发尺寸变化清空状态
check("state cleared on size change", els.btnExportF32.disabled);
els.fileCalib.files = [{ name: "calibration.json", text: async () => calibText }];
await els.fileCalib.dispatch("change", { target: els.fileCalib });
check("calib imported", /校准已导入/.test(els.msg.textContent));
check("calib import sets size", els.inW.value === cap.w && els.inH.value === cap.h);
els.shotT.value = String(cap.shot.t);
await setFiles("fileShot", [cap.shot.file]);
check("corrected from imported calib", !els.btnExportF32.disabled);
await clickPixel(7, 8);
check("imported calib gives same repair", els.inspector.innerHTML.includes("2 坏点补值"));
check("no sample tables without frames", els.inspector.innerHTML.includes("训练帧不在内存"));

// 6) 导出结果
const nDl = downloaded.length;
await els.btnExportF32.click();
await els.btnExportQual.click();
check("results downloaded", downloaded.length === nDl + 2);
const f32 = new Float32Array(await downloaded[nDl].arrayBuffer());
const u8 = new Uint8Array(await downloaded[nDl + 1].arrayBuffer());
check("export sizes", f32.length === cap.w * cap.h && u8.length === cap.w * cap.h);
check("repaired value exported", f32[8 * cap.w + 7] === 3200 && u8[8 * cap.w + 7] === 2);
check("saturated exported as NaN+3", Number.isNaN(f32[10 * cap.w + 10]) && u8[10 * cap.w + 10] === 3);

// 7) 错误路径：尺寸不符的文件
els.inW.value = "10"; els.inH.value = "10"; await fire("inW");
await setFiles("fileDarks", ["d1.u16"]);
check("size mismatch reported", /不符/.test(els.msg.textContent));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
