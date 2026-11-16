import type { Mat4, Vec3 } from './types';
import { SceneError } from './types';

/** abs(det(3x3)) <= 1e-12 is treated as singular, per the task specification. */
export const SINGULAR_DET_EPS = 1e-12;
/** Numeric tolerance for validating the affine last row. */
export const AFFINE_ROW_EPS = 1e-12;

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function isFiniteMatrix(m: unknown): m is Mat4 {
  return Array.isArray(m) && m.length === 16 && m.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Checks the affine constraint: last row must be [0, 0, 0, 1]. */
export function isAffineMatrix(m: readonly number[]): boolean {
  for (let c = 0; c < 3; c += 1) {
    if (Math.abs(m[12 + c]) > AFFINE_ROW_EPS) return false;
  }
  return Math.abs(m[15] - 1) <= AFFINE_ROW_EPS;
}

export function assertAffineMatrix(m: unknown, message = '矩阵非法'): asserts m is Mat4 {
  if (!isFiniteMatrix(m)) {
    throw new SceneError('non-finite', `${message}：必须是 16 个有限数值`);
  }
  if (!isAffineMatrix(m)) {
    throw new SceneError('invalid-matrix', `${message}：末行必须为 [0, 0, 0, 1]`);
  }
}

export function determinant3(m: readonly number[]): number {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[4];
  const e = m[5];
  const f = m[6];
  const g = m[8];
  const h = m[9];
  const i = m[10];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function isSingular(m: readonly number[]): boolean {
  return Math.abs(determinant3(m)) <= SINGULAR_DET_EPS;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

/**
 * Inverts an affine matrix. Throws a singular-parent SceneError when the
 * 3x3 linear part is below the documented determinant epsilon.
 */
export function invertAffine(m: Mat4, message = '父节点世界矩阵奇异'): Mat4 {
  assertAffineMatrix(m, message);
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[4];
  const e = m[5];
  const f = m[6];
  const g = m[8];
  const h = m[9];
  const i = m[10];

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) <= SINGULAR_DET_EPS) {
    throw new SceneError('singular-parent', message);
  }
  const invDet = 1 / det;

  const ia = (e * i - f * h) * invDet;
  const ib = (c * h - b * i) * invDet;
  const ic = (b * f - c * e) * invDet;
  const id = (f * g - d * i) * invDet;
  const ie = (a * i - c * g) * invDet;
  const iff = (c * d - a * f) * invDet;
  const ig = (d * h - e * g) * invDet;
  const ih = (b * g - a * h) * invDet;
  const ii = (a * e - b * d) * invDet;

  const tx = m[3];
  const ty = m[7];
  const tz = m[11];
  const invTx = -(ia * tx + ib * ty + ic * tz);
  const invTy = -(id * tx + ie * ty + iff * tz);
  const invTz = -(ig * tx + ih * ty + ii * tz);

  return [ia, ib, ic, invTx, id, ie, iff, invTy, ig, ih, ii, invTz, 0, 0, 0, 1];
}

export function applyPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}

export function applyDirection(m: Mat4, v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
}

export function originOf(m: Mat4): Vec3 {
  return [m[3], m[7], m[11]];
}

/** World-space direction of the matrix's local X/Y/Z axis column. */
export function columnVector(m: Mat4, axisIndex: 0 | 1 | 2): Vec3 {
  return [m[axisIndex], m[4 + axisIndex], m[8 + axisIndex]];
}

export function length3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize3(v: Vec3): Vec3 {
  const len = length3(v);
  // The spec only rejects a zero-length axis; any finite non-zero length is normalized.
  if (!Number.isFinite(len) || len === 0) {
    throw new SceneError('zero-axis', '轴长为 0，无法确定操作轴');
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function translationMatrix(v: Vec3): Mat4 {
  return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1];
}

/** Right-handed rotation about a unit axis, row-major. */
export function rotationMatrix(axis: Vec3, radians: number): Mat4 {
  const [x, y, z] = normalize3(axis);
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    0,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    0,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** T(pivot) * linear * T(-pivot) */
export function pivotTransform(pivot: Vec3, linear: Mat4): Mat4 {
  return multiply(translationMatrix(pivot), multiply(linear, translationMatrix([-pivot[0], -pivot[1], -pivot[2]])));
}

export function averageOrigin(matrices: Mat4[]): Vec3 {
  if (matrices.length === 0) return [0, 0, 0];
  const sum: Vec3 = [0, 0, 0];
  for (const m of matrices) {
    sum[0] += m[3];
    sum[1] += m[7];
    sum[2] += m[11];
  }
  return [sum[0] / matrices.length, sum[1] / matrices.length, sum[2] / matrices.length];
}

export function cloneMatrix(m: Mat4): Mat4 {
  return m.slice();
}

export function matricesClose(a: Mat4, b: Mat4, eps = 1e-9): boolean {
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

export interface LinearInfo {
  det: number;
  singular: boolean;
  mirrored: boolean;
  sheared: boolean;
  uniformScale: boolean;
  scales: Vec3;
}

/** Informational decomposition; never used to write matrices back. */
export function linearInfo(m: Mat4): LinearInfo {
  const cols: Vec3[] = [columnVector(m, 0), columnVector(m, 1), columnVector(m, 2)];
  const scales: Vec3 = [length3(cols[0]), length3(cols[1]), length3(cols[2])];
  const det = determinant3(m);
  let orthogonal = true;
  for (let i = 0; i < 3 && orthogonal; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      const li = scales[i];
      const lj = scales[j];
      if (li <= SINGULAR_DET_EPS || lj <= SINGULAR_DET_EPS) {
        orthogonal = false;
        break;
      }
      const dot = (cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2]) / (li * lj);
      if (Math.abs(dot) > 1e-8) {
        orthogonal = false;
        break;
      }
    }
  }
  const positive = scales.every((s) => s > SINGULAR_DET_EPS);
  const uniformScale = positive && Math.max(...scales) - Math.min(...scales) <= 1e-8 * Math.max(...scales);
  return {
    det,
    singular: Math.abs(det) <= SINGULAR_DET_EPS,
    mirrored: det < 0,
    sheared: positive && !orthogonal,
    uniformScale,
    scales,
  };
}
