/* 求解器约定测试：node test/test-solver.js */
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const solver = require('../js/solver.js');

// ---- 最小 PNG 解码（8 位灰度/RGB，非隔行）----
function decodePng(file) {
  const d = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const typ = d.toString('ascii', pos + 4, pos + 8);
    const data = d.subarray(pos + 8, pos + 8 + len);
    if (typ === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('仅支持 8 位');
      ct = data[9];
    } else if (typ === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const ch = ct === 2 ? 3 : (ct === 0 ? 1 : (() => { throw new Error('不支持的颜色类型 ' + ct); })());
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * ch);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Uint8Array.from(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 255;
    }
    out.set(line, y * stride);
    prev = line;
  }
  // 统一为 RGB
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    if (ch === 3) { rgb[i * 3] = out[i * 3]; rgb[i * 3 + 1] = out[i * 3 + 1]; rgb[i * 3 + 2] = out[i * 3 + 2]; }
    else { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[i]; }
  }
  return { w, h, rgb };
}

const CASES = path.join(__dirname, '..', 'samples', 'cases');
const load = (n) => decodePng(path.join(CASES, n));
const toMask = (img) => {
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) m[i] = img.rgb[i * 3] ? 1 : 0;
  return m;
};
const S2L = (v) => solver.srgbByteToLinear(v);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail == null ? '' : detail); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= eps; }

// ============ 1. overshoot 3×3：中心未限幅值 = 1 + srgb_to_linear(64/255) ============
console.log('1. overshoot 参照值');
{
  const src = load('overshoot-source.png');
  const tgt = load('overshoot-target.png');
  const mask = toMask(load('overshoot-mask.png'));
  const r = solver.solve({
    srcBytes: src.rgb, srcW: 3, srcH: 3,
    tgtBytes: tgt.rgb, tgtW: 3, tgtH: 3,
    mask, dx: 0, dy: 0, mode: 'source', tol: 1e-12, maxIter: 100
  });
  const expect = 1 + S2L(64);
  const c = (1 * 3 + 1) * 3; // 中心像素
  for (let ch = 0; ch < 3; ch++) {
    check('中心通道' + ch + ' = 1+lin(64/255)', approx(r.solution[c + ch], expect, 1e-9),
      `got ${r.solution[c + ch]}, expect ${expect}`);
  }
  check('未限幅范围 max ≈ 参照值', approx(r.rangeMax[0], expect, 1e-9), r.rangeMax[0]);
  check('残差 < 1e-9', Math.max(...r.residuals) < 1e-9, r.residuals);
  check('regionPixels = 1', r.regionPixels === 1, r.regionPixels);
  check('bbox = 中心 1×1', r.bbox && r.bbox.x === 1 && r.bbox.y === 1 && r.bbox.width === 1 && r.bbox.height === 1, r.bbox);
}

// ============ 2. 常量源+常量底：零引导梯度 → 区域内恒等于边界值 ============
console.log('2. 常量零梯度');
{
  const src = load('constant-source.png'); // 全 200
  const tgt = load('constant-target.png'); // 全 60
  const mask = toMask(load('mask.png'));
  const r = solver.solve({
    srcBytes: src.rgb, srcW: src.w, srcH: src.h,
    tgtBytes: tgt.rgb, tgtW: tgt.w, tgtH: tgt.h,
    mask, dx: 0, dy: 0, mode: 'source', tol: 1e-10, maxIter: 5000
  });
  const t = S2L(60);
  let maxDev = 0;
  for (let y = 0; y < tgt.h; y++) for (let x = 0; x < tgt.w; x++) {
    if (!mask[y * src.w + x]) continue;
    for (let ch = 0; ch < 3; ch++) maxDev = Math.max(maxDev, Math.abs(r.solution[(y * tgt.w + x) * 3 + ch] - t));
  }
  check('区域内恒等于 lin(60/255)', maxDev < 1e-6, 'maxDev=' + maxDev);
  // 孔洞（圆环中心未选中）保持底图值
  const hole = (24 * tgt.w + 24) * 3; // 圆环孔洞附近
  check('孔洞像素保持底图', approx(r.solution[hole], t, 1e-12) && !mask[24 * src.w + 24], '');
  check('残差 < 1e-8', Math.max(...r.residuals) < 1e-8, r.residuals);
}

// ============ 3. 恒等：源=底图 → 解即底图 ============
console.log('3. 恒等');
{
  const src = load('identity-source.png');
  const tgt = load('target.png');
  check('identity-source 与 target 字节一致', Buffer.compare(Buffer.from(src.rgb), Buffer.from(tgt.rgb)) === 0, '');
  const mask = toMask(load('mask.png'));
  const r = solver.solve({
    srcBytes: src.rgb, srcW: src.w, srcH: src.h,
    tgtBytes: tgt.rgb, tgtW: tgt.w, tgtH: tgt.h,
    mask, dx: 0, dy: 0, mode: 'source', tol: 1e-10, maxIter: 5000
  });
  let maxDev = 0;
  for (let i = 0; i < tgt.w * tgt.h; i++) {
    for (let ch = 0; ch < 3; ch++) maxDev = Math.max(maxDev, Math.abs(r.solution[i * 3 + ch] - S2L(tgt.rgb[i * 3 + ch])));
  }
  check('解恒等于底图', maxDev < 1e-6, 'maxDev=' + maxDev);
}

// ============ 4. 整幅选中：左上角锚点固定为底图值 ============
console.log('4. 奇异区域锚点');
{
  const src = load('overshoot-source.png');
  const tgt = load('overshoot-target.png');
  const mask = new Uint8Array(9).fill(1);
  const r = solver.solve({
    srcBytes: src.rgb, srcW: 3, srcH: 3,
    tgtBytes: tgt.rgb, tgtW: 3, tgtH: 3,
    mask, dx: 0, dy: 0, mode: 'source', tol: 1e-10, maxIter: 100
  });
  check('anchored = true', r.anchored === true, '');
  check('regionPixels = 8', r.regionPixels === 8, r.regionPixels);
  check('左上 = 底图值', approx(r.solution[0], S2L(64), 1e-12), r.solution[0]);
  check('残差 < 1e-8', Math.max(...r.residuals) < 1e-8, r.residuals);
  check('解有界（无奇异发散）', r.solution.every((v) => isFinite(v) && Math.abs(v) < 100), '');
}

// ============ 5. 平移裁剪：源图外选区不参与 ============
console.log('5. 平移与画布裁剪');
{
  const src = load('source.png');
  const tgt = load('target.png');
  const mask = new Uint8Array(src.w * src.h).fill(1);
  const r1 = solver.solve({
    srcBytes: src.rgb, srcW: src.w, srcH: src.h,
    tgtBytes: tgt.rgb, tgtW: tgt.w, tgtH: tgt.h,
    mask, dx: 10, dy: 5, mode: 'source', tol: 1e-8, maxIter: 100
  });
  check('平移后区域像素 = 54×43', r1.regionPixels === 54 * 43, r1.regionPixels);
  check('bbox = (10,5,54,43)', r1.bbox && r1.bbox.x === 10 && r1.bbox.y === 5 &&
    r1.bbox.width === 54 && r1.bbox.height === 43, r1.bbox);
  const r2 = solver.solve({
    srcBytes: src.rgb, srcW: src.w, srcH: src.h,
    tgtBytes: tgt.rgb, tgtW: tgt.w, tgtH: tgt.h,
    mask, dx: -1000, dy: 0, mode: 'source', tol: 1e-8, maxIter: 100
  });
  check('完全移出 → 空区域', r2.regionPixels === 0 && r2.bbox === null, r2.regionPixels);
  check('空区域残差为 0', r2.residuals.every((v) => v === 0), r2.residuals);
  let same = true;
  for (let i = 0; i < tgt.w * tgt.h * 3; i++) if (r2.solution[i] !== S2L(tgt.rgb[i])) { same = false; break; }
  check('空区域解 = 底图', same, '');
}

// ============ 6. 混合梯度：取平方模较大者 ============
console.log('6. 混合梯度');
{
  // 3×3 底图有梯度、源为常量：混合模式应选底图梯度 → 单像素解 = 底图中心值
  const tgtBytes = new Uint8Array(3 * 3 * 3);
  const vals = [10, 40, 90, 30, 120, 200, 60, 100, 240];
  for (let i = 0; i < 9; i++) { tgtBytes[i * 3] = vals[i]; tgtBytes[i * 3 + 1] = vals[8 - i]; tgtBytes[i * 3 + 2] = 128; }
  const srcBytes = new Uint8Array(3 * 3 * 3).fill(77);
  const mask = new Uint8Array(9); mask[4] = 1;
  const base = { srcBytes, srcW: 3, srcH: 3, tgtBytes, tgtW: 3, tgtH: 3, mask, dx: 0, dy: 0, tol: 1e-12, maxIter: 100 };
  const rm = solver.solve({ ...base, mode: 'mixed' });
  const rs = solver.solve({ ...base, mode: 'source' });
  const tC = S2L(120); // 底图中心
  check('混合模式解 = 底图中心值', approx(rm.solution[4 * 3], tC, 1e-9), rm.solution[4 * 3]);
  // 源模式：零引导梯度 → 解 = 四邻均值
  const meanN = (S2L(30) + S2L(200) + S2L(40) + S2L(100)) / 4;
  check('源模式解 = 邻居均值', approx(rs.solution[4 * 3], meanN, 1e-9), rs.solution[4 * 3]);
  check('两种模式结果不同', Math.abs(rm.solution[4 * 3] - rs.solution[4 * 3]) > 1e-6, '');
}

// ============ 7. 选区贴画布边缘：度数只计画布内邻居 ============
console.log('7. 画布边缘');
{
  // 2×1 画布，全选 → 锚点固定左像素；右像素方程 deg=1
  // src: [0, 255]（线性 0,1），tgt: [64, 64]（线性 t）
  // 右像素：1*u = g + t(左)，g = 源梯度 = 1-0 = 1 → u = 1 + t
  const srcBytes = new Uint8Array([0, 0, 0, 255, 255, 255]);
  const tgtBytes = new Uint8Array([64, 64, 64, 64, 64, 64]);
  const mask = new Uint8Array([1, 1]);
  const r = solver.solve({
    srcBytes, srcW: 2, srcH: 1, tgtBytes, tgtW: 2, tgtH: 1,
    mask, dx: 0, dy: 0, mode: 'source', tol: 1e-12, maxIter: 100
  });
  const expect = 1 + S2L(64);
  check('锚点（左）= 底图值', approx(r.solution[0], S2L(64), 1e-12), r.solution[0]);
  check('边缘像素 deg=1 求解正确', approx(r.solution[3], expect, 1e-9), `${r.solution[3]} vs ${expect}`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
