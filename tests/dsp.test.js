/*
 * Node 单元测试：node tests/dsp.test.js
 * 不依赖任何第三方库；朴素 DFT 作为 FFT 的独立参照。
 */
'use strict';
const path = require('path');
const DSP = require(path.join(__dirname, '..', 'src', 'dsp.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  }
}
function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// ---------- 朴素 DFT（参照实现，O(N²)，仅用于小数据） ----------
function naiveDft1d(re, im, inverse) {
  const N = re.length;
  const sign = inverse ? 1 : -1;
  const outRe = new Float64Array(N), outIm = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const ang = (sign * 2 * Math.PI * k * n) / N;
      const c = Math.cos(ang), s = Math.sin(ang);
      sr += re[n] * c - im[n] * s;
      si += re[n] * s + im[n] * c;
    }
    if (inverse) { sr /= N; si /= N; }
    outRe[k] = sr; outIm[k] = si;
  }
  return [outRe, outIm];
}

console.log('1) 1D FFT vs 朴素 DFT（随机信号，多个 2 次幂长度）');
for (const N of [1, 2, 4, 8, 16, 64, 128]) {
  const re0 = new Float64Array(N), im0 = new Float64Array(N);
  for (let i = 0; i < N; i++) { re0[i] = Math.sin(i * 2.7) + 0.5; im0[i] = Math.cos(i * 1.3); }
  const [fRe, fIm] = naiveDft1d(re0, im0, false);
  const re = re0.slice(), im = im0.slice();
  DSP.fft1d(re, im, false);
  let err = 0;
  for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(re[i] - fRe[i]), Math.abs(im[i] - fIm[i]));
  check('FFT N=' + N + ' 前向误差', err < 1e-9 * Math.max(1, N), 'err=' + err);

  // 逆变换还原
  DSP.fft1d(re, im, true);
  err = 0;
  for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(re[i] - re0[i]), Math.abs(im[i] - im0[i]));
  check('FFT N=' + N + ' 往返还原', err < 1e-12 * Math.max(1, N), 'err=' + err);
}

console.log('2) 2D FFT vs 逐轴朴素 DFT');
{
  const W = 8, H = 4;
  const re0 = new Float64Array(W * H), im0 = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    re0[y * W + x] = Math.sin(x * 0.9 + y * 1.7) + 1;
    im0[y * W + x] = 0;
  }
  // 参照：先逐行、再逐列朴素 DFT
  const refRe = re0.slice(), refIm = im0.slice();
  const rowR = new Float64Array(W), rowI = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) { rowR[x] = refRe[y * W + x]; rowI[x] = refIm[y * W + x]; }
    const [a, b] = naiveDft1d(rowR, rowI, false);
    for (let x = 0; x < W; x++) { refRe[y * W + x] = a[x]; refIm[y * W + x] = b[x]; }
  }
  const colR = new Float64Array(H), colI = new Float64Array(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { colR[y] = refRe[y * W + x]; colI[y] = refIm[y * W + x]; }
    const [a, b] = naiveDft1d(colR, colI, false);
    for (let y = 0; y < H; y++) { refRe[y * W + x] = a[y]; refIm[y * W + x] = b[y]; }
  }
  const plane = { width: W, height: H, re: re0.slice(), im: im0.slice() };
  DSP.fft2d(plane, false);
  let err = 0;
  for (let i = 0; i < W * H; i++) err = Math.max(err, Math.abs(plane.re[i] - refRe[i]), Math.abs(plane.im[i] - refIm[i]));
  check('2D FFT 前向', err < 1e-9, 'err=' + err);
  DSP.fft2d(plane, true);
  err = 0;
  for (let i = 0; i < W * H; i++) err = Math.max(err, Math.abs(plane.re[i] - re0[i]), Math.abs(plane.im[i] - im0[i]));
  check('2D FFT 往返', err < 1e-12, 'err=' + err);
}

console.log('3) 纯余弦信号的频谱峰值位置（stripe 约定：水平频率 ±16）');
{
  // 128x96 -> 填充 128x128；沿 x 方向、频率 16 的余弦
  const w = 128, h = 96;
  const { W, H } = DSP.paddedSize(w, h);
  check('填充尺寸 128x96 -> 128x128', W === 128 && H === 128);
  const n = W * H;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    re[y * W + x] = Math.cos((2 * Math.PI * 16 * x) / W);
  }
  DSP.fft2d({ width: W, height: H, re, im }, false);
  let maxV = -1, argU = -1, argV = -1;
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const m = Math.hypot(re[v * W + u], im[v * W + u]);
    if (m > maxV && !(u === 0 && v === 0)) { maxV = m; argU = u; argV = v; }
  }
  check('峰值在 (16,0) 或 (112,0)', (argU === 16 || argU === 112) && argV === 0,
    'got (' + argU + ',' + argV + ') mag=' + maxV);
  // 两个共轭点幅值都应接近 N*h/2
  const m16 = Math.hypot(re[16], im[16]);
  const m112 = Math.hypot(re[112], im[112]);
  check('±16 两点等幅', approx(m16, m112, 1e-8) && m16 > w * h * 0.4, 'm16=' + m16);
}

console.log('4) reflect101 填充');
{
  // 源 [10,20,30,40]，reflect101 扩展到 8: 10,20,30,40,30,20,10,20
  const src = Float64Array.from([10, 20, 30, 40]);
  const out = DSP.padChannel(src, 4, 1, 8, 1, 'reflect101');
  const expect = [10, 20, 30, 40, 30, 20, 10, 20];
  let ok = true;
  for (let i = 0; i < 8; i++) if (out[i] !== expect[i]) ok = false;
  check('1D reflect101 序列', ok, JSON.stringify(Array.from(out)));

  // 二维：2x2 -> 4x4，不重复边缘
  const src2 = Float64Array.from([1, 2, 3, 4]);
  const out2 = DSP.padChannel(src2, 2, 2, 4, 4, 'reflect101');
  const expect2 = [1, 2, 1, 2, 3, 4, 3, 4, 1, 2, 1, 2, 3, 4, 3, 4];
  ok = true;
  for (let i = 0; i < 16; i++) if (out2[i] !== expect2[i]) ok = false;
  check('2D reflect101', ok, JSON.stringify(Array.from(out2)));

  const z = DSP.padChannel(src2, 2, 2, 4, 4, 'zero');
  check('zero 填充右下为 0', z[15] === 0 && z[3] === 0 && z[0] === 1);

  // 长度 1 恒取自身
  const one = Float64Array.from([7]);
  const o1 = DSP.padChannel(one, 1, 1, 1, 1, 'reflect101');
  check('长度 1 恒取自身', o1[0] === 7);
}

console.log('5) 陷波滤波器：共轭联动、直流保留、奈奎斯特自共轭不重复、环形距离');
{
  const W = 8, H = 8;
  // (2,1) 的共轭是 (6,7)
  const Hf = DSP.buildFilter(W, H, [{ u: 2, v: 1, sigma: 0.6, strength: 1 }]);
  check('H(0,0)=1 直流保留', Hf[0] === 1);
  check('中心处 H≈0（全抑制）', Hf[1 * W + 2] < 1e-12, 'H=' + Hf[1 * W + 2]);
  check('共轭点等幅抑制', approx(Hf[1 * W + 2], Hf[7 * W + 6], 1e-15));
  // 环形距离：中心 (1,0) 的唯一中心含 (1,0) 与其共轭 (7,0)。
  // 点 (7,0) 到两个中心的环绕距离都是 2（x 轴 min(6,2)=2），两个高斯连乘。
  const Hf2 = DSP.buildFilter(W, H, [{ u: 1, v: 0, sigma: 5, strength: 0.5 }]);
  const d2 = (a, b, N) => {
    const dd = DSP.wrapDelta(a, b, N);
    return dd * dd;
  };
  const g7 = 1 - 0.5 * Math.exp(-(d2(7, 1, W) + d2(0, 0, H)) / (2 * 25)); // 到 (1,0)
  const g7c = 1 - 0.5 * Math.exp(-(d2(7, 7, W) + d2(0, 0, H)) / (2 * 25)); // 到 (7,0)
  const expected7 = g7 * g7c;
  check('环形距离高斯（共轭双中心连乘）', approx(Hf2[7], expected7, 1e-12),
    'got ' + Hf2[7] + ' want ' + expected7);

  // 奈奎斯特自共轭：(4,0) 在 W=8 时 -4 mod 8 = 4，唯一中心只有一个
  const centers = DSP.uniqueCenters([{ u: 4, v: 0, sigma: 1, strength: 1 }], W, H);
  check('奈奎斯特点自共轭仅一次', centers.length === 1 && centers[0].u === 4 && centers[0].v === 0,
    JSON.stringify(centers));

  // 两个组指向同一奈奎斯特点：唯一中心仍只算一次（不重复抑制）
  const c2 = DSP.uniqueCenters([
    { u: 4, v: 0, sigma: 1, strength: 1 },
    { u: 4, v: 0, sigma: 2, strength: 0.5 },
  ], W, H);
  check('重复奈奎斯特中心去重', c2.length === 1, JSON.stringify(c2));

  // 空滤波器全 1
  const empty = DSP.buildFilter(W, H, []);
  check('空滤波器恒为 1', empty.every((v) => v === 1));
}

console.log('6) 完整流水线：空陷波无损往返（浮点层面）');
{
  const w = 12, h = 8;
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = (i * 37) % 256;
    img.data[i * 4 + 1] = (i * 71 + 30) % 256;
    img.data[i * 4 + 2] = (i * 113 + 90) % 256;
    img.data[i * 4 + 3] = 255;
  }
  const decoded = DSP.decodeLinearRGB(img);
  const res = DSP.process(decoded, 'reflect101', []);
  let err = 0;
  for (let ch = 0; ch < 3; ch++)
    for (let i = 0; i < w * h; i++)
      err = Math.max(err, Math.abs(res.outputChannels[ch][i] - decoded.channels[ch][i]));
  check('空陷波线性域往返误差极小', err < 1e-14, 'err=' + err);
  check('空陷波 maxImag≈0', res.maxImag < 1e-15, 'maxImag=' + res.maxImag);

  // 编码后像素必须与原图完全一致
  const out = DSP.encodeOutput(res);
  let pixelSame = true;
  for (let i = 0; i < w * h * 4; i++) if (out.data[i] !== img.data[i]) { pixelSame = false; break; }
  check('空陷波编码像素逐字节不变', pixelSame);
}

console.log('7) 陷波抑制余弦条纹后能量下降、直流均值保留');
{
  const w = 128, h = 96;
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // 128 级灰阶余弦条纹 + 直流偏置
    const val = 128 + 60 * Math.cos((2 * Math.PI * 16 * x) / 128);
    const b = Math.max(0, Math.min(255, Math.round(val)));
    const p = (y * w + x) * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = b;
    img.data[p + 3] = 255;
  }
  const decoded = DSP.decodeLinearRGB(img);
  const before = decoded.channels[0];
  const varBefore = before.reduce((s, v) => s + (v - res_mean(before)) ** 2, 0) / before.length;
  function res_mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

  const res = DSP.process(decoded, 'reflect101', [{ u: 16, v: 0, sigma: 0.6, strength: 1 }]);
  const after = res.outputChannels[0];
  const varAfter = after.reduce((s, v) => s + (v - res_mean(after)) ** 2, 0) / after.length;
  check('条纹能量显著下降', varAfter < varBefore * 0.05, 'before=' + varBefore + ' after=' + varAfter);
  check('直流均值保留（三通道）', res.beforeMeans.every((m, i) => approx(m, res.afterMeans[i], 1e-6)),
    JSON.stringify(res.beforeMeans) + ' vs ' + JSON.stringify(res.afterMeans));
  check('陷波报告含 (16,0) 与 (112,0)', res.notchReport.some((q) => q.u === 16 && q.v === 0)
    && res.notchReport.some((q) => q.u === 112 && q.v === 0));
  check('陷波中心幅值近零', res.notchReport.every((q) => q.magnitudeAfter < 1e-6),
    JSON.stringify(res.notchReport.map((q) => q.magnitudeAfter)));
}

console.log('8) 非二次幂尺寸裁回原尺寸（odd 97x61 -> 128x64）');
{
  const { W, H } = DSP.paddedSize(97, 61);
  check('97x61 -> 128x64', W === 128 && H === 64, W + 'x' + H);
  const img = { width: 97, height: 61, data: new Uint8ClampedArray(97 * 61 * 4) };
  for (let i = 0; i < 97 * 61; i++) {
    img.data[i * 4] = (i * 13) % 256;
    img.data[i * 4 + 1] = (i * 29 + 7) % 256;
    img.data[i * 4 + 2] = (i * 53 + 11) % 256;
    img.data[i * 4 + 3] = 255;
  }
  const decoded = DSP.decodeLinearRGB(img);
  const res = DSP.process(decoded, 'zero', []);
  check('输出通道为原尺寸', res.outputChannels[0].length === 97 * 61);
  const out = DSP.encodeOutput(res);
  check('编码 ImageData 为原尺寸', out.width === 97 && out.height === 61);
  let same = true;
  for (let i = 0; i < 97 * 61 * 4; i++) if (out.data[i] !== img.data[i]) { same = false; break; }
  check('odd 空陷波像素不变', same);
}

console.log('');
if (failures) { console.error(failures + ' 项失败'); process.exit(1); }
console.log('全部测试通过');
