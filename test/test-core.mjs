// 用样例包验证 calib-core.js 是否符合 约定.txt 与 truth.json。
// 运行：node test/test-core.mjs
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DFC = require("../calib-core.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "dfc-test-"));
execSync(`unzip -o -q ${JSON.stringify(join(root, "samples/dark-flat-calibration-cases.zip"))} -d ${JSON.stringify(dir)}`);

const cap = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8"));
const { w, h } = cap;
const th = { clip: cap.clip, darkMax: cap.darkMax, gainMin: cap.gainMin, gainMax: cap.gainMax };

const load = (f) => DFC.parseU16(new Uint8Array(readFileSync(join(dir, f))).buffer, w, h);

const darks = cap.darks.map((d) => ({ name: d.file, t: d.t, data: load(d.file) }));
const flats = cap.flats.map((f) => ({ name: f.file, t: f.t, level: f.level, data: load(f.file) }));
const shot = load(cap.shot.file);

let failures = 0;
function check(label, actual, expected) {
  const okv = Object.is(actual, expected) || actual === expected;
  if (!okv) failures++;
  console.log(`${okv ? "PASS" : "FAIL"}  ${label}: got ${actual}, want ${expected}`);
}

// 1) 校准估计
const calib = DFC.computeCalibration({ w, h, darks, flats, clip: th.clip });
for (const c of truth.calibrated) {
  const i = c.y * w + c.x;
  check(`bias  (${c.x},${c.y})`, calib.bias[i], c.bias);
  check(`slope (${c.x},${c.y})`, calib.slope[i], c.slope);
  check(`gain  (${c.x},${c.y})`, calib.gain[i], c.gain);
}

// 2) 阈值判定 + 校正
const ok = DFC.judgeOk(calib, th);
const res = DFC.correctShot({ shot, tShot: cap.shot.t, clip: th.clip, calib, ok, repair: true });
const qi = (x, y) => y * w + x;
check("repaired qual", res.qual[qi(...truth.repaired)], 2);
check("repaired value", res.corr[qi(...truth.repaired)], truth.valid_signal);
check("unrepairable qual", res.qual[qi(...truth.unrepairable)], 0);
check("unrepairable NaN", Number.isNaN(res.corr[qi(...truth.unrepairable)]), true);
check("saturated qual", res.qual[qi(...truth.saturated)], 3);
check("saturated NaN", Number.isNaN(res.corr[qi(...truth.saturated)]), true);
const hasValid = res.qual.some((q, i) => q === 1 && res.corr[i] === truth.valid_signal);
check("valid_signal present", hasValid, true);

// 3) 关闭补值时坏点保持无效
const resNoRep = DFC.correctShot({ shot, tShot: cap.shot.t, clip: th.clip, calib, ok, repair: false });
check("repair off -> qual 0", resNoRep.qual[qi(...truth.repaired)], 0);

// 4) 校准导出/导入往返，结果一致
const { calib: calib2, th: th2 } = DFC.importCalibration(DFC.exportCalibration(calib, th));
const ok2 = DFC.judgeOk(calib2, th2);
const res2 = DFC.correctShot({ shot, tShot: cap.shot.t, clip: th2.clip, calib: calib2, ok: ok2, repair: true });
check("roundtrip qual identical", Buffer.from(res2.qual).equals(Buffer.from(res.qual)), true);
check(
  "roundtrip corr identical",
  res.corr.every((v, i) => (Number.isNaN(v) && Number.isNaN(res2.corr[i])) || v === res2.corr[i]),
  true
);

// 5) 改判坏阈值：收紧 gainMax 后原本合格的像素 (gain=1.25) 应判坏
const okTight = DFC.judgeOk(calib, { ...th, gainMax: 1.0 });
check("rejudge tight gainMax", okTight[qi(4, 5)], 0);
check("rejudge keeps others", okTight[qi(5, 5)], 1);

// 6) 导出：float32 在质量 0/3 处为 NaN，质量图为 8 位
const f32 = new Float32Array(DFC.exportCorrectedF32(res));
const u8 = new Uint8Array(DFC.exportQualityU8(res));
let nanOk = true;
for (let i = 0; i < f32.length; i++) {
  if ((u8[i] === 0 || u8[i] === 3) !== Number.isNaN(f32[i])) nanOk = false;
}
check("export NaN <-> qual 0/3", nanOk, true);
check("export sizes", f32.length === w * h && u8.length === w * h, true);

// 7) 像素明细：样本数与参与标记
const det = DFC.pixelDetail({ i: qi(4, 5), calib, th, darks, flats, clip: th.clip });
check("detail dark samples", det.darkSamples.length, cap.darks.length);
check("detail flat samples", det.flatSamples.length, cap.flats.length);
check("detail flags", det.sampleOk === 1 && det.slopeOk && det.gainOk, true);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
