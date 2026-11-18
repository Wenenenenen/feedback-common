// 去马赛克：输入 normalizePlanes 得到的三个平面（采样值，其余位置为 0），
// 输出每个像素完整的 RGB 平面（Float64，0..1）。
// 边界一律经 mirrorIndex 镜像取样，不做任何裁剪。

import { mirrorIndex } from './mirror.js';

const R = 0;
const G = 1;
const B = 2;

// 严格按《格式说明.md》定义的双线性：
// - R 位置：G 取上下左右 4 个 G 的平均，B 取 4 个对角 B 的平均；B 位置对称
// - R 行的 G 位置：R 取左右平均，B 取上下平均；B 行的 G 位置对称
// - 本身颜色直接取样本值
export function bilinear(raw, planes) {
  const { width: w, height: h, cfa } = raw;
  const out = planes.map((p) => new Float64Array(p));
  const get = (p, x, y) => p[mirrorIndex(y, h) * w + mirrorIndex(x, w)];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const own = cfa[y & 1][x & 1];
      const idx = y * w + x;
      if (own === G) {
        // 该 G 像素水平方向的主色（R 行或 B 行），另一主色在垂直方向
        const rowPrimary = cfa[y & 1][(x + 1) & 1];
        const other = rowPrimary === R ? B : R;
        // 先求和再取平均，与参考实现的浮点运算顺序保持一致
        out[rowPrimary][idx] =
          (get(planes[rowPrimary], x - 1, y) + get(planes[rowPrimary], x + 1, y)) / 2;
        out[other][idx] =
          (get(planes[other], x, y - 1) + get(planes[other], x, y + 1)) / 2;
      } else {
        const other = own === R ? B : R;
        out[G][idx] =
          (get(planes[G], x - 1, y) +
            get(planes[G], x + 1, y) +
            get(planes[G], x, y - 1) +
            get(planes[G], x, y + 1)) /
          4;
        out[other][idx] =
          (get(planes[other], x - 1, y - 1) +
            get(planes[other], x + 1, y - 1) +
            get(planes[other], x - 1, y + 1) +
            get(planes[other], x + 1, y + 1)) /
          4;
      }
    }
  }
  return out;
}

// Hamilton-Adams（自适应颜色平面，US 5629734）：
// 1) R/B 位置的 G 用水平/垂直梯度判决插值，梯度含拉普拉斯二阶项；
// 2) 再以色差 G-C 的双线性平均补 R/B，抑制拉链边与彩边。
// 所有邻域（含 ±2）同样走镜像取样。
export function hamiltonAdams(raw, planes) {
  const { width: w, height: h, cfa } = raw;
  const get = (p, x, y) => p[mirrorIndex(y, h) * w + mirrorIndex(x, w)];
  const gOut = new Float64Array(planes[G]);

  // 第一步：在 R/B 位置沿弱梯度方向插值 G
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const own = cfa[y & 1][x & 1];
      if (own === G) continue;
      const c = planes[own];
      const gH =
        (get(planes[G], x - 1, y) + get(planes[G], x + 1, y)) / 2 +
        (2 * c[y * w + x] - get(c, x - 2, y) - get(c, x + 2, y)) / 4;
      const gV =
        (get(planes[G], x, y - 1) + get(planes[G], x, y + 1)) / 2 +
        (2 * c[y * w + x] - get(c, x, y - 2) - get(c, x, y + 2)) / 4;
      const dH =
        Math.abs(get(planes[G], x - 1, y) - get(planes[G], x + 1, y)) +
        Math.abs(2 * c[y * w + x] - get(c, x - 2, y) - get(c, x + 2, y));
      const dV =
        Math.abs(get(planes[G], x, y - 1) - get(planes[G], x, y + 1)) +
        Math.abs(2 * c[y * w + x] - get(c, x, y - 2) - get(c, x, y + 2));
      gOut[y * w + x] = dH < dV ? gH : dV < dH ? gV : (gH + gV) / 2;
    }
  }

  const rOut = new Float64Array(w * h);
  const bOut = new Float64Array(w * h);

  // 第二步：以色差 G-C 双线性回填两个主色
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const own = cfa[y & 1][x & 1];
      const idx = y * w + x;
      const g = gOut[idx];
      if (own === R) {
        rOut[idx] = planes[R][idx];
        const dB =
          (get(gOut, x - 1, y - 1) - get(planes[B], x - 1, y - 1) +
            get(gOut, x + 1, y - 1) - get(planes[B], x + 1, y - 1) +
            get(gOut, x - 1, y + 1) - get(planes[B], x - 1, y + 1) +
            get(gOut, x + 1, y + 1) - get(planes[B], x + 1, y + 1)) / 4;
        bOut[idx] = g - dB;
      } else if (own === B) {
        bOut[idx] = planes[B][idx];
        const dR =
          (get(gOut, x - 1, y - 1) - get(planes[R], x - 1, y - 1) +
            get(gOut, x + 1, y - 1) - get(planes[R], x + 1, y - 1) +
            get(gOut, x - 1, y + 1) - get(planes[R], x - 1, y + 1) +
            get(gOut, x + 1, y + 1) - get(planes[R], x + 1, y + 1)) / 4;
        rOut[idx] = g - dR;
      } else {
        // G 位置：本行主色取左右色差，另一主色取上下色差
        const rowPrimary = cfa[y & 1][(x + 1) & 1];
        const other = rowPrimary === R ? B : R;
        const dRow =
          (get(gOut, x - 1, y) - get(planes[rowPrimary], x - 1, y) +
            get(gOut, x + 1, y) - get(planes[rowPrimary], x + 1, y)) /
          2;
        const dCol =
          (get(gOut, x, y - 1) - get(planes[other], x, y - 1) +
            get(gOut, x, y + 1) - get(planes[other], x, y + 1)) /
          2;
        if (rowPrimary === R) {
          rOut[idx] = g - dRow;
          bOut[idx] = g - dCol;
        } else {
          bOut[idx] = g - dRow;
          rOut[idx] = g - dCol;
        }
      }
    }
  }

  // 自适应插值在硬过渡处可能轻微超出 0..1，统一限幅，避免 16 位量化时回绕
  for (let i = 0; i < rOut.length; i++) {
    rOut[i] = Math.min(1, Math.max(0, rOut[i]));
    gOut[i] = Math.min(1, Math.max(0, gOut[i]));
    bOut[i] = Math.min(1, Math.max(0, bOut[i]));
  }
  return [rOut, gOut, bOut];
}

export const ALGORITHMS = {
  bilinear: { id: 'bilinear', name: '双线性（约定基准）', run: bilinear },
  hamiltonAdams: { id: 'hamiltonAdams', name: 'Hamilton-Adams 边缘自适应', run: hamiltonAdams },
};

// 0..1 平面 -> 16 位交织 RGB（floor(v*65535+0.5)，按样例约定）
// 防御性 clamp 到 0..1：自适应插值在硬边处可能轻微超出范围，
// 不 clamp 会被 Uint16Array 回绕成错误值。
export function toUint16(planes) {
  const n = planes[0].length;
  const out = new Uint16Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, planes[c][i]));
      out[i * 3 + c] = Math.floor(v * 65535 + 0.5);
    }
  }
  return out;
}

// PSNR：按 16 位、三通道全部像素，10*log10(65535^2/MSE)；完全一致返回 Infinity
export function psnr16(a, b) {
  if (a.length !== b.length) throw new Error('PSNR 输入尺寸不一致');
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  const mse = sum / a.length;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((65535 * 65535) / mse);
}
