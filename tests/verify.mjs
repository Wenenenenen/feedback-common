/*
 * tests/verify.mjs — 独立数值验收（从 Node 项目根目录运行）
 *   node --experimental-vm-modules tests/verify.mjs sample-data/
 *
 * 本测试独立实现《约定.json》的公式，不引用 hdr-engine.js，
 * 再将独立结果与引擎输出逐像素比对。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HDR = require('../hdr-engine.js');

const root = process.argv[2] || 'sample-data';

// ---------- 独立 PNG 解码器（Node 内置 zlib） ----------
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let p = 8;
  const idat = [];
  let W = 0, H = 0, bd = 0, ct = 0, interlace = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bd = data[8]; ct = data[9]; interlace = data[12];
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (bd !== 8 || ct !== 2 || interlace !== 0) throw new Error('非 8bit RGB 非隔行 PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const out = Buffer.alloc(W * H * 3);
  const prev = Buffer.alloc(W * bpp);
  let rp = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[rp++];
    const line = Buffer.alloc(W * bpp);
    for (let i = 0; i < W * bpp; i++) {
      const x = raw[rp++];
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = (x + a) & 255;
      else if (f === 2) v = (x + b) & 255;
      else if (f === 3) v = (x + ((a + b) >> 1)) & 255;
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (x + pr) & 255;
      }
      line[i] = v;
    }
    line.copy(prev);
    line.copy(out, y * W * bpp);
  }
  return { W, H, rgb: new Uint8Array(out) };
}

// ---------- 独立公式复算 ----------
const dec = z => z <= 0.04045 ? z / 12.92 : Math.pow((z + 0.055) / 1.055, 2.4);
const enc = l => l <= 0 ? 0 : l >= 1 ? 1 : l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
const wch = z => (z <= 0.02 || z >= 0.98) ? 0 : 1 - Math.abs(2 * z - 1);
const med = a => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
};

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + '  ' + extra); }
}
function approx(a, b, tol = 1e-9) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol * (1 + Math.abs(b));
}

function independentRecover(frames, W, H, refIndex, thr) {
  const refDx = frames[refIndex].dx, refDy = frames[refIndex].dy;
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  for (const f of frames) {
    x0 = Math.max(x0, f.dx - refDx); y0 = Math.max(y0, f.dy - refDy);
    x1 = Math.min(x1, f.dx - refDx + W); y1 = Math.min(y1, f.dy - refDy + H);
  }
  const cw = x1 - x0, ch = y1 - y0, n = cw * ch, N = frames.length;
  const raw = new Float32Array(n * 3), clean = new Float32Array(n * 3);
  const motion = new Uint8Array(n), noValid = new Uint8Array(n);
  const contrib = Array.from({ length: N }, () => new Float32Array(n));
  for (let oy = 0; oy < ch; oy++) {
    for (let ox = 0; ox < cw; ox++) {
      const rx = x0 + ox, ry = y0 + oy, o = oy * cw + ox;
      const ws = [], es = [];
      let sumW = 0, acc = [0, 0, 0];
      for (let f = 0; f < N; f++) {
        const fr = frames[f];
        const sx = rx + refDx - fr.dx, sy = ry + refDy - fr.dy;
        const si = (sy * W + sx) * 3;
        const z = [fr.rgb[si] / 255, fr.rgb[si + 1] / 255, fr.rgb[si + 2] / 255];
        const w = Math.min(wch(z[0]), wch(z[1]), wch(z[2]));
        const e = z.map(v => dec(v) / fr.exposure);
        ws.push(w); es.push(e);
        if (w > 0) { sumW += w; for (let c = 0; c < 3; c++) acc[c] += w * e[c]; }
      }
      const ri = (ry * W + rx) * 3;
      const refE = [
        dec(frames[refIndex].rgb[ri] / 255) / frames[refIndex].exposure,
        dec(frames[refIndex].rgb[ri + 1] / 255) / frames[refIndex].exposure,
        dec(frames[refIndex].rgb[ri + 2] / 255) / frames[refIndex].exposure
      ];
      const validF = ws.map((w, f) => w > 0 ? f : -1).filter(f => f >= 0);
      if (validF.length === 0) {
        noValid[o] = 1;
        for (let c = 0; c < 3; c++) { raw[o * 3 + c] = refE[c]; clean[o * 3 + c] = refE[c]; }
        continue;
      }
      const rr = acc.map(a => a / sumW);
      for (let c = 0; c < 3; c++) raw[o * 3 + c] = rr[c];
      for (let f = 0; f < N; f++) if (ws[f] > 0) contrib[f][o] = ws[f] / sumW;
      const logs = [[], [], []];
      for (const fi of validF) for (let c = 0; c < 3; c++) logs[c].push(Math.log2(Math.max(es[fi][c], 1e-6)));
      const m = logs.map(med);
      let isM = false;
      for (const fi of validF) {
        for (let c = 0; c < 3; c++) {
          if (Math.abs(Math.log2(Math.max(es[fi][c], 1e-6)) - m[c]) > thr) isM = true;
        }
      }
      if (isM) {
        motion[o] = 1;
        for (let c = 0; c < 3; c++) clean[o * 3 + c] = refE[c];
      } else for (let c = 0; c < 3; c++) clean[o * 3 + c] = rr[c];
    }
  }
  return { cw, ch, crop: { x0, y0, x1, y1 }, raw, clean, motion, noValid, contrib };
}

function independentToneMap(rad, w, h, key, ev) {
  const n = w * h;
  let s = 0;
  const L = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    L[p] = 0.2126 * rad[p * 3] + 0.7152 * rad[p * 3 + 1] + 0.0722 * rad[p * 3 + 2];
    s += Math.log(1e-6 + L[p]);
  }
  const Lavg = Math.exp(s / n), gain = key * 2 ** ev / Lavg;
  const out = new Uint8ClampedArray(n * 3);
  for (let p = 0; p < n; p++) {
    const Ld = (gain * L[p]) / (1 + gain * L[p]);
    const k = Ld / Math.max(L[p], 1e-6);
    for (let c = 0; c < 3; c++) out[p * 3 + c] = Math.round(enc(Math.min(1, Math.max(0, rad[p * 3 + c] * k))) * 255);
  }
  return out;
}

function loadCase(manifestName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'));
  const norm = HDR.normalizeManifest(manifest, manifest.frames.map(f => f.file));
  const decoded = norm.frames.map(f => decodePNG(path.join(root, f.file)));
  const W = decoded[0].W, H = decoded[0].H;
  const frames = norm.frames.map((f, i) => ({
    name: f.file, rgb: decoded[i].rgb, exposure: f.exposure, dx: f.dx, dy: f.dy
  }));
  return { norm, frames, W, H };
}

// ============== 用例 1：manifest.json ==============
console.log('\n[case 1] manifest.json （三档正常包围）');
{
  const { norm, frames, W, H } = loadCase('manifest.json');
  check('初始参考帧=0', norm.reference === 0);
  const crop0 = HDR.computeCrop(frames, 0, W, H);
  check('约定裁剪矩形 [3,1,78,58]',
    crop0.x0 === 3 && crop0.y0 === 1 && crop0.x1 === 78 && crop0.y1 === 58,
    JSON.stringify(crop0));
  check('裁剪尺寸 75x57', crop0.width === 75 && crop0.height === 57);

  const thr = 1;
  const res = HDR.recover(frames, W, H, { reference: 0, motionThresholdEv: thr });
  const ind = independentRecover(frames, W, H, 0, thr);
  let bad = 0, badRaw = 0;
  for (let i = 0; i < res.radiance.length; i++) {
    if (!approx(res.radiance[i], ind.clean[i], 1e-12)) bad++;
    if (!approx(res.radianceRaw[i], ind.raw[i], 1e-12)) badRaw++;
  }
  check('剔除后辐射度逐值=独立复算', bad === 0, bad + ' 个通道不符');
  check('剔除前辐射度逐值=独立复算', badRaw === 0, badRaw + ' 个通道不符');
  check('运动掩码=独立复算', res.motionMask.every((v, i) => v === ind.motion[i]));
  check('无有效帧掩码全 0', res.noValidMask.every(v => v === 0));
  check('贡献占比和≈1', (() => {
    for (let o = 0; o < res.width * res.height; o++) {
      const s = res.contributions.reduce((a, c) => a + c[o], 0);
      if (Math.abs(s - 1) > 1e-6) return false;   // Float32 累加容差
    }
    return true;
  })());

  // 无运动场景：剔除前后应完全一致
  let diffCount = 0;
  for (let i = 0; i < res.radiance.length; i++) if (res.radiance[i] !== res.radianceRaw[i]) diffCount++;
  check('无运动时剔除前后完全相同', diffCount === 0, diffCount + ' 通道不同');
  check('运动像素数=0', res.motionMask.reduce((a, b) => a + b, 0) === 0);

  // 色调映射
  const tm = HDR.toneMap(res.radiance, res.width, res.height, { key: 0.18, ev: 0 });
  const tmInd = independentToneMap(res.radiance, res.width, res.height, 0.18, 0);
  let tmbad = 0;
  for (let i = 0; i < tm.bytes.length; i++) if (tm.bytes[i] !== tmInd[i]) tmbad++;
  check('色调映射逐字节=独立复算', tmbad === 0, tmbad + ' 字节不符');
  check('输出无 NaN/Inf', res.radiance.every(Number.isFinite) && tm.bytes.every(v => v >= 0 && v <= 255));

  // 换参考帧：裁剪矩形随偏移变化，结果在共同坐标下一致
  const res1 = HDR.recover(frames, W, H, { reference: 1, motionThresholdEv: thr });
  const crop1 = HDR.computeCrop(frames, 1, W, H);
  check('换参考帧裁剪=[0,3,75,60]',
    crop1.x0 === 0 && crop1.y0 === 3 && crop1.x1 === 75 && crop1.y1 === 60, JSON.stringify(crop1));
  // 共同坐标 (X,Y) 在两参考系中：ref0 系 (X-dx0,Y-dy0)，ref1 系 (X-dx1,Y-dy1)
  let refBad = 0;
  for (let oy = 0; oy < res.height; oy++) {
    for (let ox = 0; ox < res.width; ox++) {
      const X = ox + crop0.x0 + frames[0].dx;   // 共同坐标
      const Y = oy + crop0.y0 + frames[0].dy;
      const x1p = X - frames[1].dx, y1p = Y - frames[1].dy;
      if (x1p < crop1.x0 || x1p >= crop1.x1 || y1p < crop1.y0 || y1p >= crop1.y1) continue;
      const i0 = (oy * res.width + ox) * 3;
      const i1 = ((y1p - crop1.y0) * res1.width + (x1p - crop1.x0)) * 3;
      for (let c = 0; c < 3; c++) if (!approx(res.radiance[i0 + c], res1.radiance[i1 + c], 1e-12)) refBad++;
    }
  }
  check('换参考帧共同坐标辐射度一致', refBad === 0, refBad + ' 通道不符');

  // PFM 结构
  const pfm = HDR.encodePFM(res.radiance, res.width, res.height);
  const head = `PF\n${res.width} ${res.height}\n-1.0\n`;
  check('PFM 头正确', Buffer.from(pfm.subarray(0, head.length)).toString('ascii') === head);
  const expectLen = head.length + res.width * res.height * 3 * 4;
  check('PFM 长度正确', pfm.length === expectLen, pfm.length + ' vs ' + expectLen);
  const dv = new DataView(pfm.buffer, pfm.byteOffset + head.length);
  // 底行优先：文件首扫描行 = 图像最后一行；小端 float32
  const lastRowY = res.height - 1;
  check('PFM 底行优先+小端', (() => {
    const k = (lastRowY * res.width + 0) * 3;
    return approx(dv.getFloat32(0, true), res.radiance[k], 1e-6);
  })());
  check('PFM 不含映射（与未映射辐射度一致）', (() => {
    const dvAll = new DataView(pfm.buffer, pfm.byteOffset);
    let o = head.length;
    for (let y = res.height - 1; y >= 0; y--)
      for (let k = 0; k < res.width * 3; k++) {
        if (!approx(dvAll.getFloat32(o, true), res.radiance[y * res.width * 3 + k], 1e-6)) return false;
        o += 4;
      }
    return true;
  })());
}

// ============== 用例 2：moving.json ==============
console.log('\n[case 2] moving.json （含 10x10 运动方块）');
{
  const { frames, W, H } = loadCase('moving.json');
  const res = HDR.recover(frames, W, H, { reference: 0, motionThresholdEv: 1 });
  const ind = independentRecover(frames, W, H, 0, 1);
  check('运动掩码=独立复算', res.motionMask.every((v, i) => v === ind.motion[i]));
  const nMotion = res.motionMask.reduce((a, b) => a + b, 0);
  check('检测到运动像素', nMotion > 0, 'n=' + nMotion);
  // 运动方块源坐标 frame-2 系 (28..37, 20..29)；frame-2 offset (-2,1)
  // 共同坐标 X=sx-2 (26..35), Y=sy+1 (21..30)；ref0 偏移(0,0) -> ref0 像素即共同坐标
  let inside = 0, outside = 0;
  for (let oy = 0; oy < res.height; oy++) for (let ox = 0; ox < res.width; ox++) {
    const rx = res.crop.x0 + ox, ry = res.crop.y0 + oy;
    const inBox = rx >= 26 && rx <= 35 && ry >= 21 && ry <= 30;
    if (res.motionMask[oy * res.width + ox]) { if (inBox) inside++; else outside++; }
  }
  check('运动像素全部落在 10x10 方块内', outside === 0, 'outside=' + outside);
  check('方块内检出 ' + inside + '/100 运动像素', inside >= 90, 'inside=' + inside);
  // 回退参考帧：运动像素的辐射度=参考帧线性RGB/曝光
  let fbBad = 0;
  for (let oy = 0; oy < res.height; oy++) for (let ox = 0; ox < res.width; ox++) {
    const o = oy * res.width + ox;
    if (!res.motionMask[o]) continue;
    const rx = res.crop.x0 + ox, ry = res.crop.y0 + oy, ri = (ry * W + rx) * 3;
    for (let c = 0; c < 3; c++) {
      const refE = dec(frames[0].rgb[ri + c] / 255) / frames[0].exposure;
      if (!approx(res.radiance[o * 3 + c], refE, 1e-6)) fbBad++;
    }
  }
  check('运动像素回退参考帧线性RGB/曝光', fbBad === 0, fbBad + ' 通道不符');
  // 剔除前后差异恰为运动像素
  let diffPix = new Set();
  for (let o = 0; o < res.width * res.height; o++)
    for (let c = 0; c < 3; c++)
      if (res.radiance[o * 3 + c] !== res.radianceRaw[o * 3 + c]) diffPix.add(o);
  let mismatch = 0;
  for (let o = 0; o < res.width * res.height; o++)
    if (diffPix.has(o) !== !!res.motionMask[o]) mismatch++;
  check('剔除前后差异集合 == 运动掩码', mismatch === 0 && diffPix.size === nMotion);

  // 阈值调大到不会触发：运动像素应归零
  const loose = HDR.recover(frames, W, H, { reference: 0, motionThresholdEv: 100 });
  check('阈值=100EV 时无运动标记', loose.motionMask.every(v => v === 0));
  // 阈值=0：运动像素只增不减
  const strict = HDR.recover(frames, W, H, { reference: 0, motionThresholdEv: 0 });
  check('阈值=0 运动集合为超集', strict.motionMask.every((v, i) => v >= res.motionMask[i]));
}

// ============== 用例 3：全黑 / 全白（无有效帧） ==============
console.log('\n[case 3] black.png / white.png （整组饱和与全黑的确定性结果）');
for (const [name, expectAll] of [['black.png', 0], ['white.png', 255]]) {
  const im = decodePNG(path.join(root, name));
  const frames = [0, 1].map(i => ({
    name: name + '#' + i, rgb: im.rgb, exposure: i === 0 ? 1 : 4, dx: 0, dy: 0
  }));
  const res = HDR.recover(frames, im.W, im.H, { reference: 0, motionThresholdEv: 1 });
  check(name + ' 全部像素无有效帧', res.noValidMask.every(v => v === 1));
  check(name + ' 无运动标记（无有效帧不计运动）', res.motionMask.every(v => v === 0));
  check(name + ' 回退掩码全 1', res.fallbackMask.every(v => v === 1));
  check(name + ' 辐射度有限且确定', res.radiance.every(Number.isFinite));
  const expect = expectAll === 0 ? 0 : dec(1) / 1;   // 白：参考帧线性 1.0 / 曝光 1
  check(name + ' 辐射度=' + expect, res.radiance.every(v => approx(v, expect, 1e-12)),
    '实际值 ' + res.radiance[0]);
  const tm = HDR.toneMap(res.radiance, res.width, res.height, {});
  const tmInd = independentToneMap(res.radiance, res.width, res.height, 0.18, 0);
  // 整组饱和/全黑必须有确定结果：与独立映射器逐字节一致，且全图同一输出
  const uniform = tm.bytes.every(v => v === tm.bytes[0]);
  check(name + ' 映射结果确定且与独立复算一致',
    uniform && tm.bytes.every((v, i) => v === tmInd[i]), '实际 ' + tm.bytes[0]);
  if (expectAll === 0) check(name + ' 全黑映射为 0', tm.bytes[0] === 0);
  const pfm = HDR.encodePFM(res.radiance, res.width, res.height);
  check(name + ' PFM 可生成且无 NaN', pfm.length > 0 && new DataView(pfm.buffer).getFloat32(pfm.length - 12, true) === expect);
}

// ============== 用例 4：基础函数与校验 ==============
console.log('\n[case 4] 基础函数 / 输入校验');
{
  check('w(0.02)=0', HDR.channelWeight(0.02) === 0);
  check('w(0.98)=0', HDR.channelWeight(0.98) === 0);
  check('w(0.5)=1', HDR.channelWeight(0.5) === 1);
  check('w(0.25)=0.5', HDR.channelWeight(0.25) === 0.5);
  check('偶数中位数取两中值平均', HDR.median(new Float64Array([4, 1, 3, 2]), 4) === 2.5);
  check('奇数中位数', HDR.median(new Float64Array([5, 1, 3]), 3) === 3);
  check('srgbDecode(0)=0 / (1)=1', HDR.srgbDecode(0) === 0 && HDR.srgbDecode(1) === 1);
  check('srgb 往返一致', approx(HDR.srgbEncode(HDR.srgbDecode(0.37)), 0.37, 1e-12));

  let threw = false;
  try { HDR.normalizeManifest({ frames: [] }); } catch (e) { threw = true; }
  check('帧数 <2 拒绝', threw);
  threw = false;
  try {
    const m = { frames: Array.from({ length: 8 }, (_, i) => ({ file: i + '.png', exposure: 1, offset: [0, 0] })) };
    HDR.normalizeManifest(m);
  } catch (e) { threw = true; }
  check('帧数 >7 拒绝', threw);
  threw = false;
  try { HDR.normalizeManifest({ reference: 2, frames: [{ file: 'a.png', exposure: 1, offset: [0, 0] }, { file: 'b.png', exposure: 1, offset: [0, 0] }] }); }
  catch (e) { threw = true; }
  check('reference 越界拒绝', threw);
  threw = false;
  try { HDR.normalizeManifest({ frames: [{ file: 'a.png', exposure: 0, offset: [0, 0] }, { file: 'b.png', exposure: 1, offset: [0, 0] }] }); }
  catch (e) { threw = true; }
  check('exposure<=0 拒绝', threw);
  threw = false;
  try { HDR.normalizeManifest({ frames: [{ file: 'a.png', exposure: 1, offset: [0.5, 0] }, { file: 'b.png', exposure: 1, offset: [0, 0] }] }); }
  catch (e) { threw = true; }
  check('非整数偏移拒绝', threw);
  // 无共同覆盖
  threw = false;
  try {
    const im = decodePNG(path.join(root, 'black.png'));
    const fr = [
      { rgb: im.rgb, exposure: 1, dx: 0, dy: 0 },
      { rgb: im.rgb, exposure: 1, dx: 100, dy: 100 }
    ];
    HDR.computeCrop(fr, 0, im.W, im.H);
  } catch (e) { threw = true; }
  check('无共同覆盖区拒绝', threw);
  // PNG 头校验
  const whiteBytes = fs.readFileSync(path.join(root, 'white.png'));
  const info = HDR.validatePNG(whiteBytes);
  check('PNG 校验通过 8x8', info.width === 8 && info.height === 8);
  threw = false;
  try { HDR.validatePNG(new Uint8Array([1, 2, 3])); } catch (e) { threw = true; }
  check('非 PNG 拒绝', threw);
}

// ============== 用例 5：PNG 编码往返 + 导出清单 ==============
console.log('\n[case 5] encodePNG 往返 / buildExportMeta');
{
  const W = 75, H = 57;
  const rgb = new Uint8Array(W * H * 3);
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rnd() * 256);
  const png = HDR.encodePNG(rgb, W, H);
  check('PNG 签名正确', png.subarray(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]));
  const info = HDR.validatePNG(png);
  check('编码结果通过自身头校验', info.width === W && info.height === H);
  // 独立解码器往返（含 Node zlib 对存储块流的解压）
  const tmp = path.join(import.meta.dirname, '_roundtrip.png');
  fs.writeFileSync(tmp, png);
  const back = decodePNG(tmp);
  fs.unlinkSync(tmp);
  check('往返尺寸一致', back.W === W && back.H === H);
  let bad = 0;
  for (let i = 0; i < rgb.length; i++) if (back.rgb[i] !== rgb[i]) bad++;
  check('往返像素逐字节一致', bad === 0, bad + ' 字节不符');
  // 超过 65535 的行（触发多分块）
  const big = new Uint8Array(300 * 300 * 3);
  for (let i = 0; i < big.length; i++) big[i] = i & 255;
  const pngBig = HDR.encodePNG(big, 300, 300);
  const tmp2 = path.join(import.meta.dirname, '_rt2.png');
  fs.writeFileSync(tmp2, pngBig);
  const back2 = decodePNG(tmp2);
  fs.unlinkSync(tmp2);
  let bad2 = 0;
  for (let i = 0; i < big.length; i++) if (back2.rgb[i] !== big[i]) bad2++;
  check('多 zlib 分块大图往返一致', bad2 === 0, bad2 + ' 字节不符');

  // 导出清单
  const { frames, W: FW, H: FH } = loadCase('manifest.json');
  const res = HDR.recover(frames, FW, FH, { reference: 0, motionThresholdEv: 1 });
  const tm = HDR.toneMap(res.radiance, res.width, res.height, { key: 0.18, ev: 0.5 });
  const meta = HDR.buildExportMeta({
    result: res, frames, key: 0.18, ev: 0.5, motionThresholdEv: 1,
    lavg: tm.lavg, pfmName: 'out.pfm', pngName: 'out.png'
  });
  check('清单裁剪坐标 [3,1,78,58]',
    meta.crop.x0 === 3 && meta.crop.y0 === 1 && meta.crop.x1 === 78 && meta.crop.y1 === 58);
  check('清单记录参数', meta.parameters.key === 0.18 && meta.parameters.display_ev === 0.5 &&
    meta.parameters.motion_threshold_ev === 1);
  check('清单运动像素=0', meta.stats.motion_pixels === 0);
  check('清单引用帧信息完整', meta.frames.length === 3 && meta.frames[0].is_reference === true);
  check('清单可序列化 JSON', (() => { JSON.stringify(meta); return true; })());
}

console.log('\n' + (failures === 0 ? '✅ 全部通过' : '❌ ' + failures + ' 项失败') + '\n');
process.exit(failures === 0 ? 0 : 1);
