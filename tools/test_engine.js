/* Node validation: the exact engine.js inlined into the web page, checked
   against reference.json (operator + 3 RL iterations) and python ref_rl.py. */
"use strict";
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const E = require("./engine.js");

function readPng(file) {
  const d = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, bd = 0, ct = 0, idat = Buffer.alloc(0);
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const type = d.slice(pos + 4, pos + 8).toString();
    const chunk = d.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = chunk.readUInt32BE(0); h = chunk.readUInt32BE(4);
      bd = chunk[8]; ct = chunk[9];
      if (chunk[12] !== 0) throw new Error("interlace unsupported in test");
    } else if (type === "IDAT") idat = Buffer.concat([idat, chunk]);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bd !== 8) throw new Error("only 8-bit in test decoder");
  const ch = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ct];
  const raw = zlib.inflateSync(idat);
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[i++];
    const line = raw.slice(i, i + stride); i += stride;
    if (ft === 1) for (let x = ch; x < stride; x++) line[x] = (line[x] + line[x - ch]) & 255;
    else if (ft === 2) for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
    else if (ft === 3) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255;
    } else if (ft === 4) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[x] = (line[x] + pr) & 255;
    }
    line.copy(out, y * stride);
    prev = Buffer.from(line);
  }
  return { w, h, ch, data: out };
}

const cases = path.resolve(__dirname, "../_untrusted/cases");
let failures = 0;
function check(name, got, want, tol) {
  const err = Math.abs(got - want);
  const ok = err <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${got} want=${want} err=${err}`);
}

// ---- 1. Operator + adjoint on reference probe/dual (tiny kernel, 4x3) ----
const ref = JSON.parse(fs.readFileSync(path.join(cases, "reference.json"), "utf8"));
const tinyK = JSON.parse(fs.readFileSync(path.join(cases, "tiny.json"), "utf8"));
const H = 3, W = 4;
const op = E.buildOperator(tinyK.weights, tinyK.anchor, H, W);
const probe = new Float64Array(ref.probe);
const dual = new Float64Array(ref.dual);
const ap = E.forward(op, probe, new Float64Array(H * W));
const atd = E.adjoint(op, dual, new Float64Array(H * W));
let maxA = 0, maxAt = 0;
for (let i = 0; i < 12; i++) {
  maxA = Math.max(maxA, Math.abs(ap[i] - ref.A_probe[i]));
  maxAt = Math.max(maxAt, Math.abs(atd[i] - ref.AT_dual[i]));
}
check("A(probe) max abs err", maxA, 0, 1e-14);
check("A^T(dual) max abs err", maxAt, 0, 1e-14);
let dot1 = 0, dot2 = 0;
for (let i = 0; i < 12; i++) { dot1 += ap[i] * dual[i]; dot2 += probe[i] * atd[i]; }
check("adjoint identity <Ax,y>=<x,A^Ty>", Math.abs(dot1 - dot2), 0, 1e-14);
check("adjoint dot vs reference", Math.abs(dot1 - ref.dot_Ax_y), 0, 1e-14);

// ---- 2. Full masked RL on tiny.png vs reference iterations + mse ----
const img = readPng(path.join(cases, "tiny.png"));
const mskPng = readPng(path.join(cases, "tiny-mask.png"));
const y = new Float64Array(H * W);
const m = new Float64Array(H * W);
for (let i = 0; i < H * W; i++) {
  y[i] = img.data[i] / 255;
  m[i] = mskPng.data[i] > 127 ? 1 : 0;
}
const runner = E.makeRunner(op, [y], m);
// Web flow: evaluate() at the constant initial image (iter 0); each step()
// is one RL update, then evaluate() re-computes Ax and MSE at the new x.
check("tiny iter 0 MSE", runner.evaluate(), ref.mse[0], 1e-14);
let me0 = 0;
const x0 = runner.getX()[0];
for (let i = 0; i < 12; i++) me0 = Math.max(me0, Math.abs(x0[i] - ref.iterations[0][i]));
check("tiny iter 0 x max abs err", me0, 0, 1e-14);
for (let it = 1; it <= 3; it++) {
  runner.step();
  check(`tiny iter ${it} MSE`, runner.evaluate(), ref.mse[it], 1e-14);
  const xc = new Float64Array(runner.getX()[0]);
  let me = 0;
  for (let i = 0; i < 12; i++) me = Math.max(me, Math.abs(xc[i] - ref.iterations[it][i]));
  check(`tiny iter ${it} x max abs err`, me, 0, 1e-14);
}

// ---- 3. Medium grayscale, 7 iterations vs independent python run ----
const med = JSON.parse(fs.readFileSync(path.join(cases, "medium.json"), "utf8"));
const mimg = readPng(path.join(cases, "medium.png"));
const opMed = E.buildOperator(med.weights, med.anchor, mimg.h, mimg.w);
const yMed = new Float64Array(mimg.w * mimg.h);
for (let i = 0; i < yMed.length; i++) yMed[i] = mimg.data[i] / 255;
const rMed = E.makeRunner(opMed, [yMed], null);
const pyMed = JSON.parse(fs.readFileSync(path.resolve(__dirname, "py_medium.json"), "utf8"));
let mseMax = Math.abs(rMed.evaluate() - pyMed.mse[0]), xMax = 0;
for (let i = 0; i < rMed.getX()[0].length; i++)
  xMax = Math.max(xMax, Math.abs(rMed.getX()[0][i] - pyMed.x[0][Math.floor(i / mimg.w)][i % mimg.w]));
for (let it = 1; it <= 7; it++) {
  rMed.step();
  mseMax = Math.max(mseMax, Math.abs(rMed.evaluate() - pyMed.mse[it]));
  const xc = rMed.getX()[0];
  for (let i = 0; i < xc.length; i++) xMax = Math.max(xMax, Math.abs(xc[i] - pyMed.x[it][Math.floor(i / mimg.w)][i % mimg.w]));
}
check("medium(gray) 8 MSE values vs python", mseMax, 0, 1e-12);
check("medium(gray) all x vs python", xMax, 0, 1e-12);

// ---- 4. Medium RGB, 5 iterations, per-channel independence ----
const rgb = readPng(path.join(cases, "medium-rgb.png"));
const chans = [new Float64Array(rgb.w * rgb.h), new Float64Array(rgb.w * rgb.h), new Float64Array(rgb.w * rgb.h)];
for (let i = 0; i < rgb.w * rgb.h; i++)
  for (let c = 0; c < 3; c++) chans[c][i] = rgb.data[i * 3 + c] / 255;
const opRgb = E.buildOperator(med.weights, med.anchor, rgb.h, rgb.w);
const rRgb = E.makeRunner(opRgb, chans, null);
const pyRgb = JSON.parse(fs.readFileSync(path.resolve(__dirname, "py_rgb.json"), "utf8"));
let rgbMseMax = Math.abs(rRgb.evaluate() - pyRgb.mse[0]), rgbXMax = 0;
for (let c = 0; c < 3; c++)
  for (let i = 0; i < rRgb.getX()[c].length; i++) {
    const yy = Math.floor(i / rgb.w), xx = i % rgb.w;
    rgbXMax = Math.max(rgbXMax, Math.abs(rRgb.getX()[c][i] - pyRgb.x[0][c][yy][xx]));
  }
for (let it = 1; it <= 5; it++) {
  rRgb.step();
  rgbMseMax = Math.max(rgbMseMax, Math.abs(rRgb.evaluate() - pyRgb.mse[it]));
  const xs = rRgb.getX();
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < xs[c].length; i++) {
      const yy = Math.floor(i / rgb.w), xx = i % rgb.w;
      rgbXMax = Math.max(rgbXMax, Math.abs(xs[c][i] - pyRgb.x[it][c][yy][xx]));
    }
}
check("medium(rgb) 6 MSE values vs python", rgbMseMax, 0, 1e-12);
check("medium(rgb) all x vs python", rgbXMax, 0, 1e-12);

// ---- 5. Reflection rule spot checks (n=1, even edge fold, negative k) ----
check("R(k,1) always 0", E.reflectIndex(7, 1), 0, 0);
check("R(4,4)=2 fold", E.reflectIndex(4, 4), 2, 0);   // p=4 -> 6-4=2
check("R(5,4)=1 fold", E.reflectIndex(5, 4), 1, 0);
check("R(-1,4)=1 (neg modulo)", E.reflectIndex(-1, 4), 1, 0);
check("R(-3,4)=3", E.reflectIndex(-3, 4), 3, 0);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
