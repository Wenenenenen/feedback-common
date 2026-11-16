/*
 * 三阶实球谐（l = 0..2）：基函数、等距柱状图积分、余弦卷积、绕 y 轴旋转。
 *
 * 全部约定与 constants.js 一致（取自样例包的说明）：
 *   C_i = ∫ L(ω)·Y_i(ω) dω          环境辐亮度系数，W/(m²·sr)
 *   E_i = C_i·A_l                   辐照度系数，W/m²
 *   A_l：l=0 → π，l=1 → 2π/3，l=2 → π/4
 *
 * 本模块不触碰 DOM，可直接在 Node 中测试。
 */

import {
  BASIS_FUNCTIONS,
  COEFFICIENT_COUNT,
  CONVOLUTION_FACTORS,
  FOUR_PI,
} from './constants.js';

const Y00 = 0.28209479177387814;
const K1 = 0.4886025119029199;
const K2XY = 1.0925484305920792;
const K2Z2 = 0.31539156525252005;
const K2X2 = 0.5462742152960396;

/** 把基函数写入 out（长度 ≥ 9）。 */
export function basisAt(x, y, z, out = new Float64Array(COEFFICIENT_COUNT)) {
  out[0] = Y00;
  out[1] = K1 * y;
  out[2] = K1 * z;
  out[3] = K1 * x;
  out[4] = K2XY * x * y;
  out[5] = K2XY * y * z;
  out[6] = K2Z2 * (3 * z * z - 1);
  out[7] = K2XY * x * z;
  out[8] = K2X2 * (x * x - y * y);
  return out;
}

/** 与说明.txt 中的基顺序逐项对照（测试用）。 */
export function basisExpressions() {
  return BASIS_FUNCTIONS.slice();
}

/**
 * 每个逻辑行（自顶起算）的立体角：
 *   Ω_r = 2π·(cos(πr/H) − cos(π(r+1)/H))
 * 各行之和为 4π（浮点误差量级 1e-16）。
 */
export function rowSolidAngles(height) {
  const rows = new Float64Array(height);
  let total = 0;
  for (let r = 0; r < height; r++) {
    rows[r] = 2 * Math.PI * (Math.cos((Math.PI * r) / height) - Math.cos((Math.PI * (r + 1)) / height));
    total += rows[r];
  }
  return { rowSolidAngles: rows, total };
}

/** 每像素立体角（同一行内各列相同）。 */
export function pixelSolidAngle(r, width, height) {
  return (2 * Math.PI / width) * (Math.cos((Math.PI * r) / height) - Math.cos((Math.PI * (r + 1)) / height));
}

export class BakeCancelledError extends Error {
  constructor() {
    super('烘焙已取消。');
    this.name = 'BakeCancelledError';
    this.code = 'BAKE_CANCELLED';
  }
}

/** 逐行积分的公共内核：同步与异步（可让出线程）两条路径共用。 */
function createIntegrator(values, width, height) {
  const { rowSolidAngles: rowOmega } = rowSolidAngles(height);
  const radiance = new Float64Array(COEFFICIENT_COUNT * 3);
  const rowContrib = new Float64Array(height * COEFFICIENT_COUNT * 3);
  const rowMeanLuminance = new Float64Array(height);
  const naiveSum = new Float64Array(3);
  const b = new Float64Array(COEFFICIENT_COUNT);
  const acc = new Float64Array(COEFFICIENT_COUNT * 3);

  function integrateRow(r) {
    const theta = (Math.PI * (r + 0.5)) / height;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    // values 已归一化为「逻辑行序、顶行 r=0 在前」（PFM 的底行优先在解析阶段已翻转），
    // 因此这里直接按 r 取行；theta 与 y 均随 r 增大而增大 / 由 +1 降到 −1。
    const rowOffset = r * width * 3;
    const omegaPx = rowOmega[r] / width;
    acc.fill(0);

    for (let c = 0; c < width; c++) {
      const phi = (2 * Math.PI * (c + 0.5)) / width;
      const x = sinT * Math.cos(phi);
      const z = sinT * Math.sin(phi);
      basisAt(x, cosT, z, b);
      const o = rowOffset + c * 3;
      const lr = values[o];
      const lg = values[o + 1];
      const lb = values[o + 2];
      naiveSum[0] += lr;
      naiveSum[1] += lg;
      naiveSum[2] += lb;
      for (let i = 0; i < COEFFICIENT_COUNT; i++) {
        const bi = b[i];
        const j = i * 3;
        acc[j] += bi * lr;
        acc[j + 1] += bi * lg;
        acc[j + 2] += bi * lb;
      }
    }

    const rowBase = r * COEFFICIENT_COUNT * 3;
    for (let j = 0; j < COEFFICIENT_COUNT * 3; j++) {
      const contribution = acc[j] * omegaPx;
      rowContrib[rowBase + j] = contribution;
      radiance[j] += contribution;
    }
    // 该行的立体角加权平均辐亮度（逐通道），供行表展示
    rowMeanLuminance[r] = 0;
    if (rowOmega[r] > 0) {
      const scale = 1 / (0.28209479177387814 * rowOmega[r]);
      const rowR = rowContrib[rowBase] * scale;
      const rowG = rowContrib[rowBase + 1] * scale;
      const rowB = rowContrib[rowBase + 2] * scale;
      rowMeanLuminance[r] = 0.2126 * rowR + 0.7152 * rowG + 0.0722 * rowB;
    }
  }

  function finish() {
    for (let i = 0; i < radiance.length; i++) {
      if (!Number.isFinite(radiance[i])) {
        const band = Math.floor(i / 3);
        const channel = 'RGB'[i % 3];
        throw new RangeError(`系数 C(${band}) ${channel} 在积分中溢出为非有限值。`);
      }
    }
    const pixels = width * height;
    const naiveMean = new Float64Array(3);
    for (let k = 0; k < 3; k++) naiveMean[k] = naiveSum[k] / pixels;
    // 立体角加权平均辐亮度：C0 / Y00 / (4π)
    const weightedMean = new Float64Array(3);
    for (let k = 0; k < 3; k++) weightedMean[k] = radiance[k] / (Y00 * FOUR_PI);
    return {
      radiance,
      rowContrib,
      rowSolidAngles: rowOmega,
      rowMeanLuminance,
      totalSolidAngle: sum(rowOmega),
      naiveMean,
      weightedMean,
      width,
      height,
    };
  }

  return { integrateRow, finish };
}

function validateBakeInput(values, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`无效尺寸：${width}×${height}`);
  }
  if (values.length !== width * height * 3) {
    throw new TypeError(`像素数据长度不符：${values.length}，应为 ${width * height * 3}`);
  }
}

/**
 * 对等距柱状 RGB 浮点数据积分，得到 9×3 的辐亮度系数（同步版）。
 *
 * @param {Float32Array|Float64Array} values 逻辑行序（顶行在前）、RGB 交错
 * @param {number} width
 * @param {number} height
 * @param {{onProgress?: (fraction:number, row:number)=>void,
 *          shouldCancel?: ()=>boolean, chunkRows?: number}} [options]
 */
export function bakeEquirect(values, width, height, options = {}) {
  const { onProgress, shouldCancel, chunkRows = 8 } = options;
  validateBakeInput(values, width, height);
  const { integrateRow, finish } = createIntegrator(values, width, height);
  for (let r = 0; r < height; r++) {
    if (shouldCancel && shouldCancel()) throw new BakeCancelledError();
    integrateRow(r);
    if (onProgress && (r % chunkRows === 0 || r === height - 1)) {
      onProgress((r + 1) / height, r);
    }
  }
  return finish();
}

/**
 * 同上，但每处理 chunkRows 行就让出线程一次（await yieldFn）。
 * 这样 Worker 能在烘焙过程中收到 cancel 消息，实现真正可取消。
 *
 * @param {{yieldFn?: () => Promise<void>}} [options]
 */
export async function bakeEquirectAsync(values, width, height, options = {}) {
  const {
    onProgress, shouldCancel, chunkRows = 8,
    yieldFn = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = options;
  validateBakeInput(values, width, height);
  const { integrateRow, finish } = createIntegrator(values, width, height);
  for (let r = 0; r < height; r++) {
    if (shouldCancel && shouldCancel()) throw new BakeCancelledError();
    integrateRow(r);
    const atChunk = r % chunkRows === 0;
    if (onProgress && (atChunk || r === height - 1)) onProgress((r + 1) / height, r);
    if (atChunk && r < height - 1) await yieldFn();
  }
  if (shouldCancel && shouldCancel()) throw new BakeCancelledError();
  return finish();
}

function sum(arr) {
  let t = 0;
  for (let i = 0; i < arr.length; i++) t += arr[i];
  return t;
}

/** 辐亮度系数 → 辐照度系数（逐项乘以 A_l）。 */
export function convolve(radiance) {
  const out = new Float64Array(radiance.length);
  for (let i = 0; i < radiance.length; i++) {
    out[i] = radiance[i] * CONVOLUTION_FACTORS[Math.floor(i / 3)];
  }
  return out;
}

/** 辐照度系数 → 辐亮度系数（除以 A_l）。 */
export function deconvolve(irradiance) {
  const out = new Float64Array(irradiance.length);
  for (let i = 0; i < irradiance.length; i++) {
    out[i] = irradiance[i] / CONVOLUTION_FACTORS[Math.floor(i / 3)];
  }
  return out;
}

/** 在方向 n 上求值（coeffs 为 9×3，按 RGB 交错）。 */
export function evaluate(coeffs, x, y, z, out = new Float64Array(3)) {
  const b = basisAt(x, y, z, TEMP_BASIS);
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    const bi = b[i];
    const j = i * 3;
    out[0] += coeffs[j] * bi;
    out[1] += coeffs[j + 1] * bi;
    out[2] += coeffs[j + 2] * bi;
  }
  return out;
}

const TEMP_BASIS = new Float64Array(COEFFICIENT_COUNT);

export const LUMINANCE_WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722]);

export function luminance(rgb) {
  return LUMINANCE_WEIGHTS[0] * rgb[0] + LUMINANCE_WEIGHTS[1] * rgb[1] + LUMINANCE_WEIGHTS[2] * rgb[2];
}

/**
 * 绕 +y 轴右手系旋转 θ，作用在 9×3 系数上。
 *
 * 与说明一致：Lr(n) = L(R⁻¹n)，+x 经 +90° 到 −z。
 * 记 f = Σ cᵢYᵢ，f'(n) = f(R⁻¹n)；把 Yᵢ(R⁻¹n) 展开回 Y 基即得 c' = M(θ)·c。
 * l=0 不变；l=1 的 (y, z, x) 与 l=2 的 (xy, yz, 3z²−1, xz, x²−y²) 各自成块，
 * 其中 l=2 各基的 SN3D 系数 D 不同，需按 D_i/D_j 换算。
 * 该实现已用「旋转后的环境重新数值积分」逐项交叉验证。
 */
export function rotateY(radiance, angleDeg) {
  const theta = (angleDeg * Math.PI) / 180;
  if (!Number.isFinite(theta)) throw new TypeError('旋转角无效。');
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const out = new Float64Array(radiance.length);
  const D = [K2XY, K2XY, K2Z2, K2XY, K2X2]; // l=2 的 SN3D 缩放

  for (let k = 0; k < 3; k++) {
    out[0 * 3 + k] = radiance[0 * 3 + k];

    const y = radiance[1 * 3 + k];
    const z = radiance[2 * 3 + k];
    const x = radiance[3 * 3 + k];
    out[1 * 3 + k] = y;
    out[2 * 3 + k] = c * z - s * x;
    out[3 * 3 + k] = s * z + c * x;

    const g4 = radiance[4 * 3 + k];
    const g5 = radiance[5 * 3 + k];
    const g6 = radiance[6 * 3 + k];
    const g7 = radiance[7 * 3 + k];
    const g8 = radiance[8 * 3 + k];

    // 与说明中的基顺序对应（l=2 块）：
    // c'_4 = c·c4 + s·c5
    // c'_5 = −s·c4 + c·c5
    // c'_6 = (c²−s²/2)·c6 + (D6/D7)·(−6sc)·c7 + (D6/D8)·(1.5s²)·c8
    // c'_7 = (D7/D6)·(sc/2)·c6 + (c²−s²)·c7 + (D7/D8)·(−sc/2)·c8
    // c'_8 = (D8/D6)·(s²/2)·c6 + (D8/D7)·(2sc)·c7 + ((c²+1)/2)·c8
    // D 为 l=2 各基的 SN3D 常数，块变换在 g 空间推导后按 D 换算回 Y 空间。
    out[4 * 3 + k] = c * g4 + s * g5;
    out[5 * 3 + k] = -s * g4 + c * g5;
    out[6 * 3 + k] = (c * c - (s * s) / 2) * g6 + (D[2] / D[3]) * (-6 * s * c) * g7
      + (D[2] / D[4]) * (1.5 * s * s) * g8;
    out[7 * 3 + k] = (D[3] / D[2]) * ((s * c) / 2) * g6 + (c * c - s * s) * g7
      + (D[3] / D[4]) * (-(s * c) / 2) * g8;
    out[8 * 3 + k] = (D[4] / D[2]) * ((s * s) / 2) * g6 + (D[4] / D[3]) * (2 * s * c) * g7
      + ((c * c + 1) / 2) * g8;
  }
  return out;
}

/** 由 l=1 三个系数求「最亮方向」（线性项方向），返回单位向量或 null。 */
export function l1Direction(radiance) {
  // C1 ∝ y，C2 ∝ z，C3 ∝ x
  const x = radiance[3 * 3];
  const y = radiance[1 * 3];
  const z = radiance[2 * 3];
  const n = Math.hypot(x, y, z);
  if (!(n > 0)) return null;
  return { x: x / n, y: y / n, z: z / n, magnitude: n };
}

/** 在球面上搜索亮度最大方向（粗搜 + 局部细化）。coeffs 为单位辐照度系数。 */
export function brightestDirection(coeffs, samples = 4096) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  let best = null;
  let bestVal = -Infinity;
  const rgb = new Float64Array(3);
  for (let i = 0; i < samples; i++) {
    const yy = 1 - (2 * (i + 0.5)) / samples;
    const r = Math.sqrt(Math.max(0, 1 - yy * yy));
    const phi = i * golden;
    const x = r * Math.cos(phi);
    const z = r * Math.sin(phi);
    evaluate(coeffs, x, yy, z, rgb);
    const v = luminance(rgb);
    if (v > bestVal) {
      bestVal = v;
      best = { x, y: yy, z };
    }
  }
  if (!best) return null;
  // 局部细化：在切平面内做小步长爬山
  let step = 0.2;
  for (let iter = 0; iter < 40; iter++) {
    let improved = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        // 以 best 为轴的切平面基
        const up = Math.abs(best.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        let t1 = {
          x: up.y * best.z - up.z * best.y,
          y: up.z * best.x - up.x * best.z,
          z: up.x * best.y - up.y * best.x,
        };
        const t1n = Math.hypot(t1.x, t1.y, t1.z) || 1;
        t1 = { x: t1.x / t1n, y: t1.y / t1n, z: t1.z / t1n };
        const t2 = {
          x: best.y * t1.z - best.z * t1.y,
          y: best.z * t1.x - best.x * t1.z,
          z: best.x * t1.y - best.y * t1.x,
        };
        let nx = best.x + step * (dx * t1.x + dy * t2.x);
        let ny = best.y + step * (dx * t1.y + dy * t2.y);
        let nz = best.z + step * (dx * t1.z + dy * t2.z);
        const nn = Math.hypot(nx, ny, nz);
        nx /= nn; ny /= nn; nz /= nn;
        evaluate(coeffs, nx, ny, nz, rgb);
        const v = luminance(rgb);
        if (v > bestVal) {
          bestVal = v;
          best = { x: nx, y: ny, z: nz };
          improved = true;
        }
      }
    }
    if (!improved) step *= 0.5;
  }
  return { ...best, value: bestVal };
}

/** 方向 → 球面角（度）。θ 自 +Y 起算，φ 自 +X 转向 +Z。 */
export function directionAngles(x, y, z) {
  const theta = (Math.acos(Math.min(1, Math.max(-1, y))) * 180) / Math.PI;
  let phi = (Math.atan2(z, x) * 180) / Math.PI;
  if (phi < 0) phi += 360;
  if (phi >= 360 - 1e-9) phi = 0;
  return { theta, phi };
}

export function normalizeDirection(x, y, z) {
  const n = Math.hypot(x, y, z);
  if (!(n > 0)) return null;
  return { x: x / n, y: y / n, z: z / n };
}
