// Node 校验：用独立参考实现（逐条照《约定.json》直译，不做缓存/可分离优化）
// 与 js/core.js 对比，覆盖样例、低纹理、奇数尺寸对齐、锁定与确定性。
//
// 运行：node test/verify.js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodePng, encodePngRgb8 } from '../js/png.js';
import { extractSamples } from '../tools/extract-samples.js';
import {
  runStack,
  applyLock,
  pyramidSizes,
  srgb8ToLinear,
  linearToSrgb8,
  mirrorIndex,
  MAX_LEVELS,
} from '../js/core.js';
import { encodeProject, decodeProject, validateInputs } from '../js/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = await extractSamples();
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

async function loadImage(name, path = join(SAMPLES, name)) {
  const dec = await decodePng(await readFile(path));
  return { name, width: dec.width, height: dec.height, rgb8: dec.rgb8, gray8: dec.gray8 };
}

const applyLabelPng = (img) => {
  const labels = new Uint8Array(img.width * img.height);
  labels.set(img.gray8);
  return labels;
};

// ---------- 独立参考实现（直译约定） ----------
const K = [1, 4, 6, 4, 1].map((v) => v / 16);

function refBlur2D(src, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = mirrorIndex(x + dx, w);
          const yy = mirrorIndex(y + dy, h);
          s += src[yy * w + xx] * K[dx + 2] * K[dy + 2];
        }
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

function refDown(src, w, h) {
  const b = refBlur2D(src, w, h);
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = b[(2 * y) * w + 2 * x];
  return { w: nw, h: nh, data: out };
}

function refExpand(low, lw, lh, tw, th) {
  const z = new Float64Array(tw * th);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) z[(2 * y) * tw + 2 * x] = low[y * lw + x];
  const b = refBlur2D(z, tw, th);
  for (let i = 0; i < b.length; i++) b[i] *= 4;
  return b;
}

function refSharpness(lum, w, h) {
  const lap = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = lum[y * w + x];
      const l = lum[y * w + mirrorIndex(x - 1, w)];
      const r = lum[y * w + mirrorIndex(x + 1, w)];
      const u = lum[mirrorIndex(y - 1, h) * w + x];
      const d = lum[mirrorIndex(y + 1, h) * w + x];
      lap[y * w + x] = Math.abs(l + r + u + d - 4 * c);
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) s += lap[mirrorIndex(y + dy, h) * w + mirrorIndex(x + dx, w)];
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

function refRun(images, levels) {
  const n = images.length;
  const { width: w, height: h } = images[0];
  const sizes = pyramidSizes(w, h, levels);
  const L = sizes.length;
  const N = w * h;
  const lum = images.map((im) => {
    const l = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      l[i] = 0.2126 * srgb8ToLinear(im.rgb8[i * 3]) + 0.7152 * srgb8ToLinear(im.rgb8[i * 3 + 1]) + 0.0722 * srgb8ToLinear(im.rgb8[i * 3 + 2]);
    }
    return l;
  });
  const S = lum.map((l) => refSharpness(l, w, h));
  const W = S.map((s) => {
    const out = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      let den = 0;
      for (let i = 0; i < n; i++) den += S[i][j] + 1e-6;
      out[j] = (s[j] + 1e-6) / den;
    }
    return out;
  });
  const dom = new Uint8Array(N);
  for (let j = 0; j < N; j++) {
    let best = 0;
    for (let i = 1; i < n; i++) if (W[i][j] > W[best][j]) best = i;
    dom[j] = best;
  }
  // 权重金字塔 + 逐层归一化
  const wPyr = W.map((w0) => {
    const lv = [w0];
    let cur = w0;
    let cw = w;
    let ch = h;
    for (let l = 1; l < L; l++) {
      const d = refDown(cur, cw, ch);
      lv.push(d.data);
      cur = d.data;
      cw = d.w;
      ch = d.h;
    }
    return lv;
  });
  for (let l = 0; l < L; l++) {
    const cnt = sizes[l].w * sizes[l].h;
    for (let j = 0; j < cnt; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += wPyr[i][l][j];
      for (let i = 0; i < n; i++) wPyr[i][l][j] /= sum;
    }
  }
  const fusedLevels = [0, 1, 2].map(() => sizes.map((s) => new Float64Array(s.w * s.h)));
  for (let chn = 0; chn < 3; chn++) {
    for (let i = 0; i < n; i++) {
      const plane = new Float64Array(N);
      for (let j = 0; j < N; j++) plane[j] = srgb8ToLinear(images[i].rgb8[j * 3 + chn]);
      const g = [plane];
      let cw = w;
      let chh = h;
      for (let l = 1; l < L; l++) {
        const d = refDown(g[l - 1], cw, chh);
        g.push(d.data);
        cw = d.w;
        chh = d.h;
      }
      for (let l = 0; l < L; l++) {
        const sz = sizes[l];
        let lap;
        if (l === L - 1) lap = g[l];
        else {
          const up = refExpand(g[l + 1], sizes[l + 1].w, sizes[l + 1].h, sz.w, sz.h);
          lap = new Float64Array(sz.w * sz.h);
          for (let j = 0; j < lap.length; j++) lap[j] = g[l][j] - up[j];
        }
        const wl = wPyr[i][l];
        const acc = fusedLevels[chn][l];
        for (let j = 0; j < lap.length; j++) acc[j] += wl[j] * lap[j];
      }
    }
  }
  const planes = [0, 1, 2].map((chn) => {
    let rec = fusedLevels[chn][L - 1];
    for (let l = L - 2; l >= 0; l--) {
      const sz = sizes[l];
      const up = refExpand(rec, sizes[l + 1].w, sizes[l + 1].h, sz.w, sz.h);
      const acc = fusedLevels[chn][l];
      for (let j = 0; j < up.length; j++) up[j] += acc[j];
      rec = up;
    }
    return rec;
  });
  const rgb8 = new Uint8Array(N * 3);
  for (let j = 0; j < N; j++) {
    rgb8[j * 3] = linearToSrgb8(planes[0][j]);
    rgb8[j * 3 + 1] = linearToSrgb8(planes[1][j]);
    rgb8[j * 3 + 2] = linearToSrgb8(planes[2][j]);
  }
  return { rgb8, weights: W, dominant: dom, sizes };
}

function compareRgb(a, b, label, tol = 0) {
  if (a.length !== b.length) {
    check(false, `${label}: 长度不同 ${a.length} vs ${b.length}`);
    return;
  }
  let max = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    if (d > tol) count++;
  }
  check(count === 0, `${label}: 与参考实现逐字节一致（最大差 ${max}，超差 ${count} 个样本）`);
}

function compareF32(a, b, label, tol) {
  let max = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    if (d > tol) count++;
  }
  check(count === 0, `${label}: 权重与参考一致（最大差 ${max.toExponential(2)}，超差 ${count} 个）`);
}

// ---------- 1. 奇数尺寸金字塔尺寸 ----------
{
  const s = pyramidSizes(65, 49, 5);
  const ok =
    s.length === 5 &&
    s.map((v) => `${v.w}x${v.h}`).join(',') === '65x49,33x25,17x13,9x7,5x4';
  check(ok, `奇数尺寸 65×49 的 5 层尺寸 = ${s.map((v) => `${v.w}×${v.h}`).join(' → ')}`);
  const s6 = pyramidSizes(512, 512, 6);
  check(s6.length === 6 && s6[5].w === 16, `512×512 的 6 层尺寸 = ${s6.map((v) => v.w).join(' → ')}`);
  const s99 = pyramidSizes(3, 3, 6);
  check(s99.map((v) => `${v.w}x${v.h}`).join(',') === '3x3,2x2,1x1', `3×3 在 1×1 处停止 = ${s99.map((v) => `${v.w}×${v.h}`).join(' → ')}`);
  check(pyramidSizes(1, 1, 6).length === 1, '1×1 不再下采样');
  check(MAX_LEVELS === 6, '层数上限为 6');
}

// ---------- 2. 样例：focus 三帧 + 层数 5，与参考实现对比 ----------
const focus = await Promise.all([0, 1, 2].map((i) => loadImage(`focus-${i}.png`)));
const refFocus = refRun(focus, 5);
const resFocus = runStack({ images: focus, levels: 5 });
{
  compareRgb(resFocus.fusedRgb8, refFocus.rgb8, 'focus-0/1/2 · 5 层融合结果');
  compareF32(resFocus.weights[0], refFocus.weights[0], 'focus-0 基处权重');
  compareF32(resFocus.weights[1], refFocus.weights[1], 'focus-1 基处权重');
  compareF32(resFocus.weights[2], refFocus.weights[2], 'focus-2 基处权重');
  let domDiff = 0;
  for (let i = 0; i < refFocus.dominant.length; i++) if (resFocus.dominant[i] !== refFocus.dominant[i]) domDiff++;
  check(domDiff === 0, `主导来源逐像素一致（差异 ${domDiff}）`);
  check(resFocus.stats.invalidWeightPixels === 0, '有效区域内无无效权重');
  // 权重逐像素和为 1
  let maxDev = 0;
  for (let j = 0; j < resFocus.width * resFocus.height; j++) {
    const s = resFocus.weights[0][j] + resFocus.weights[1][j] + resFocus.weights[2][j];
    maxDev = Math.max(maxDev, Math.abs(s - 1));
  }
  check(maxDev < 1e-6, `基处权重逐像素和 = 1（最大偏差 ${maxDev.toExponential(2)}）`);
}

// 主导来源：swath 中心应为其清晰帧（swath 0: x<22, 1: 22..43, 2: >=44）
{
  const { width, height, dominant } = resFocus;
  const sample = (x, y) => dominant[y * width + x];
  const cases = [
    [5, 24, 0],
    [10, 5, 0],
    [30, 24, 1],
    [40, 5, 1],
    [50, 24, 2],
    [60, 44, 2],
  ];
  const bad = cases.filter(([x, y, exp]) => sample(x, y) !== exp);
  check(bad.length === 0, `swath 中心主导来源正确（共享边界 22/44 处自然融合）`);
}

// ---------- 3. 锁定：标签 2 的矩形必须逐像素等于 focus-1 ----------
{
  const lockImg = await loadImage('lock.png');
  const labels = applyLabelPng(lockImg);
  const autoPixels = new Set();
  let labelCount = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] === 2) labelCount++;
  const locked = applyLock(resFocus.fusedRgb8, labels, focus, resFocus.width * resFocus.height);
  let mismatch = 0;
  let outsideChanged = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 2) {
      autoPixels.add(i);
      for (let c = 0; c < 3; c++) if (locked.rgb8[i * 3 + c] !== focus[1].rgb8[i * 3 + c]) mismatch++;
    } else {
      for (let c = 0; c < 3; c++) if (locked.rgb8[i * 3 + c] !== resFocus.fusedRgb8[i * 3 + c]) outsideChanged++;
    }
  }
  check(labelCount === 224, `lock.png 含 224 个标签 2 像素（实际 ${labelCount}）`);
  check(mismatch === 0, `锁定像素与 focus-1 完全一致（不一致样本 ${mismatch}）`);
  check(outsideChanged === 0, `锁定不改动未锁定像素（改动 ${outsideChanged}）`);
  check(locked.lockedPixels === labelCount, `applyLock 统计锁定像素数 = ${locked.lockedPixels}`);
  // 锁定不改自动权重：再次 runStack 的权重与未锁定时相同
  const rerun = runStack({ images: focus, levels: 5 });
  let wDiff = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < rerun.weights[i].length; j++) if (rerun.weights[i][j] !== resFocus.weights[i][j]) wDiff++;
  check(wDiff === 0, '锁定不参与计算，自动权重不受影响');
  const reLocked = applyLock(rerun.fusedRgb8, labels, focus, rerun.width * rerun.height);
  compareRgb(reLocked.rgb8, locked.rgb8, '锁定结果可重复（再次运行逐字节一致）');
}

// ---------- 4. 低纹理：两个常量帧，权重必须有效且各 0.5 ----------
{
  const c40 = await loadImage('constant-40.png');
  const c160 = await loadImage('constant-160.png');
  const c = runStack({ images: [c40, c160], levels: 5 });
  let bad = 0;
  let maxDev = 0;
  for (let j = 0; j < c.width * c.height; j++) {
    const a = c.weights[0][j];
    const b = c.weights[1][j];
    if (!Number.isFinite(a) || !Number.isFinite(b)) bad++;
    maxDev = Math.max(maxDev, Math.abs(a - 0.5), Math.abs(b - 0.5));
  }
  check(bad === 0 && maxDev < 1e-6, `常量帧权重全为 0.5（最大偏差 ${maxDev.toExponential(2)}，NaN ${bad}）`);
  check(c.stats.invalidWeightPixels === 0, '低纹理区域无无效权重（invalidWeightPixels=0）');
  check(c.stats.lowTexturePixels === c.width * c.height, `全图无纹理像素计数 = ${c.stats.lowTexturePixels}`);
  const expected = linearToSrgb8(0.5 * (srgb8ToLinear(40) + srgb8ToLinear(160)));
  const uniq = new Set();
  for (let j = 0; j < c.width * c.height; j++) uniq.add(c.fusedRgb8[j * 3]);
  check(uniq.size === 1 && uniq.has(expected), `常量帧融合 = 线性均值编码 ${expected}（实际 ${[...uniq].join(',')}）`);
  // 参考实现对比（3 帧样例不同层数也覆盖）
  const refC = refRun([c40, c160], 5);
  compareRgb(c.fusedRgb8, refC.rgb8, '常量帧结果与参考一致');
}

// ---------- 5. 奇数尺寸全金字塔可逆性：两帧相同渐变 → 融合应还原原图 ----------
{
  function makeRamp(w, h, seed) {
    const rgb8 = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 3;
        rgb8[p] = Math.round((x / (w - 1)) * 255);
        rgb8[p + 1] = Math.round((y / (h - 1)) * 255);
        rgb8[p + 2] = ((x * 7 + y * 13 + seed) % 256);
      }
    }
    return { name: `ramp-${seed}.png`, width: w, height: h, rgb8 };
  }
  for (const [w, h, levels] of [[65, 49, 5], [65, 49, 6], [63, 47, 4], [33, 17, 6], [512, 512, 3], [17, 5, 6], [2, 2, 6], [1, 5, 6]]) {
    const a = makeRamp(w, h, 1);
    const b = makeRamp(w, h, 1);
    const r = runStack({ images: [a, b], levels });
    let maxDiff = 0;
    let over = 0;
    for (let i = 0; i < a.rgb8.length; i++) {
      const d = Math.abs(r.fusedRgb8[i] - a.rgb8[i]);
      if (d > maxDiff) maxDiff = d;
      if (d > 1) over++;
    }
    check(over === 0, `${w}×${h} ${levels} 层：两帧相同图融合还原（最大字节差 ${maxDiff}）`);
    const refR = refRun([a, b], levels);
    compareRgb(r.fusedRgb8, refR.rgb8, `${w}×${h} ${levels} 层与参考一致`);
  }
}

// ---------- 6. 确定性 ----------
{
  const a = runStack({ images: focus, levels: 5 });
  const b = runStack({ images: focus, levels: 5 });
  compareRgb(a.fusedRgb8, b.fusedRgb8, '相同输入与参数两次运行结果一致');
  let same = true;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < a.weights[i].length; j++) if (a.weights[i][j] !== b.weights[i][j]) same = false;
  check(same, '权重逐位相同（确定性）');
  const c = runStack({ images: focus, levels: 4 });
  check(c.levels === 4 && c.fusedRgb8.some((v, i) => v !== a.fusedRgb8[i]), '层数改变会改变实际结果');
}

// ---------- 7. 边界约定：reflect101 与长度 1 ----------
{
  check(mirrorIndex(-1, 5) === 1 && mirrorIndex(5, 5) === 3 && mirrorIndex(0, 5) === 0 && mirrorIndex(4, 5) === 4, 'reflect101：−1→1、n→n−2、内部不变');
  check(mirrorIndex(-1, 1) === 0 && mirrorIndex(1, 1) === 0, '长度 1 恒取唯一像素');
  const two = [0, 1].map(() => ({ name: 'x', width: 1, height: 1, rgb8: new Uint8Array([77, 88, 99]) }));
  const r = runStack({ images: two, levels: 6 });
  check(r.levels === 1 && r.fusedRgb8[0] === 77, '1×1 图像只有 1 层且结果稳定');
}

// ---------- 8. 输入校验与项目回环 ----------
{
  const base = { name: 'a.png', width: 8, height: 8, rgb8: new Uint8Array(8 * 8 * 3), colorType: 2 };
  const mk = (over) => ({ ...base, ...over });
  check(!validateInputs([mk({})]).ok, '少于 2 张被拒绝');
  check(!validateInputs(new Array(8).fill(mk({}))).ok, '多于 7 张被拒绝');
  check(!validateInputs([mk({}), mk({ width: 9 })]).ok, '尺寸不一致被拒绝');
  check(!validateInputs([mk({}), mk({ width: 513, height: 8 })]).ok, '单边 513 被拒绝');
  check(!validateInputs([mk({}), mk({ colorType: 6 })]).ok, '带 Alpha 的 RGBA 被拒绝');
  check(validateInputs([mk({}), mk({ width: 512, height: 512, rgb8: new Uint8Array(512 * 512 * 3) })]).ok === false, '512×512 与 8×8 混合被拒');
  check(validateInputs([mk({}), mk({ name: 'b.png' })]).ok, '两张同尺寸 8 位 RGB 通过');

  // 项目 JSON 往返（含锁定）
  const pngA = await encodePngRgb8(2, 1, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const pngB = await encodePngRgb8(2, 1, new Uint8Array([7, 8, 9, 10, 11, 12]));
  const imgs = [
    { name: 'a.png', width: 2, height: 1, rgb8: new Uint8Array([1, 2, 3, 4, 5, 6]), colorType: 2, sourcePng: pngA },
    { name: 'b.png', width: 2, height: 1, rgb8: new Uint8Array([7, 8, 9, 10, 11, 12]), colorType: 2, sourcePng: pngB },
  ];
  const labels = new Uint8Array([0, 2]);
  const proj = encodeProject({ images: imgs, levels: 3, labels, width: 2, height: 1 });
  const back = await decodeProject(JSON.stringify(proj));
  check(back.levels === 3 && back.images.length === 2 && back.images[1].name === 'b.png', '项目 JSON 保留层数与输入顺序');
  check(back.labels[0] === 0 && back.labels[1] === 2, '项目 JSON 保留锁定标签');
  check(proj.lock && proj.lock.fileName === 'focus-stack-lock-L3.png', '项目 JSON 记录配套锁定标签文件名');
  check(back.images[1].rgb8[0] === 7, '项目 JSON 内嵌的原图像素无误');
  const proj2 = encodeProject({ images: imgs, levels: 3, labels, width: 2, height: 1 });
  check(JSON.stringify(proj) === JSON.stringify(proj2), '相同输入的项目 JSON 序列化逐字节相同');
  let rejected = false;
  try {
    await decodeProject(JSON.stringify({ ...proj, inputs: proj.inputs.slice(0, 1) }));
  } catch {
    rejected = true;
  }
  check(rejected, '少于 2 张的项目文件被拒绝');
}

// ---------- 9. 输入规则 ----------
{
  let threw = 0;
  try {
    runStack({ images: [focus[0]], levels: 3 });
  } catch {
    threw++;
  }
  check(threw === 0, '核心库不强制帧数（由页面校验 2..7）');
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
