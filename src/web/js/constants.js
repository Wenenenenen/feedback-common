/*
 * 本页遵循的全局约定（与 samples 包内的 说明.txt / expected.json 一致）。
 *
 * 坐标系：y 向上；theta 从 +y 量起，phi 从 +x 向 +z 量起：
 *   dir(theta, phi) = (sinθ·cosφ, cosθ, sinθ·sinφ)
 *
 * 实球谐基（归一化实 SH，ACN 顺序，y 向上）：
 *   0  l=0 m=0   0.28209479177387814
 *   1  l=1 m=-1  0.4886025119029199·y
 *   2  l=1 m=0   0.4886025119029199·z
 *   3  l=1 m=1   0.4886025119029199·x
 *   4  l=2 m=-2  1.0925484305920792·xy
 *   5  l=2 m=-1  1.0925484305920792·yz
 *   6  l=2 m=0   0.31539156525252005·(3z²−1)
 *   7  l=2 m=1   1.0925484305920792·xz
 *   8  l=2 m=2   0.5462742152960396·(x²−y²)
 *
 * 系数定义：C_i = ∫ L(ω)·Y_i(ω) dω（环境辐亮度系数，W/(m²·sr)）
 * 余弦卷积：E_i = C_i · A_l，A_0 = π，A_1 = 2π/3，A_2 = π/4
 * 辐照度：E(n) = Σ E_i·Y_i(n)（W/m²）
 */

export const BASIS_ID = 'irradiance-sh-baker.real-sh-acn-l2-yup';
export const BASIS_ALIASES = Object.freeze(['acn-sn3d-real-l2-yup']);

export const SCHEMA_ID = 'irradiance-sh-baker/coefficients';
export const SCHEMA_VERSION = 1;

export const COEFFICIENT_COUNT = 9;
export const CHANNEL_NAMES = Object.freeze(['R', 'G', 'B']);

export const BASIS_FUNCTIONS = Object.freeze([
  '0.28209479177387814',
  '0.4886025119029199*y',
  '0.4886025119029199*z',
  '0.4886025119029199*x',
  '1.0925484305920792*x*y',
  '1.0925484305920792*y*z',
  '0.31539156525252005*(3*z*z-1)',
  '1.0925484305920792*x*z',
  '0.5462742152960396*(x*x-y*y)',
]);

export const BASIS_LABELS = Object.freeze([
  'Y00', 'Y1-1', 'Y10', 'Y11', 'Y2-2', 'Y2-1', 'Y20', 'Y21', 'Y22',
]);

export const BASIS_LONG_LABELS = Object.freeze([
  'l=0, m=0', 'l=1, m=−1', 'l=1, m=0', 'l=1, m=1',
  'l=2, m=−2', 'l=2, m=−1', 'l=2, m=0', 'l=2, m=1', 'l=2, m=2',
]);

export const BASIS_AXIS_HINTS = Object.freeze([
  '常数', '∝ y', '∝ z', '∝ x', '∝ xy', '∝ yz', '∝ 3z²−1', '∝ xz', '∝ x²−y²',
]);

export const BASIS_DEGREES = Object.freeze([0, 1, 1, 1, 2, 2, 2, 2, 2]);

export const BASIS_NORMALIZATION = 'SN3D 实球谐，整球正交归一，ACN 顺序（y, z, x）';
export const BASIS_AXES_NOTE = '右手系，+Y 向上；θ 从 +Y 起算，φ 从 +X 转向 +Z';

/** 每个系数对应的余弦卷积因子 A_l。 */
export const CONVOLUTION_FACTORS = Object.freeze([
  Math.PI,
  2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3,
  Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4,
]);

export const MAX_WIDTH = 1024;
export const MAX_HEIGHT = 512;

export const KIND_UNITS = Object.freeze({
  radiance: 'W/(m^2 sr)',
  irradiance: 'W/m^2',
});

export const KIND_LABELS = Object.freeze({
  radiance: '环境辐亮度系数',
  irradiance: '辐照度系数（余弦卷积）',
});

export const KIND_SYMBOLS = Object.freeze({
  radiance: 'C',
  irradiance: 'E',
});

export const KIND_FORMAL = Object.freeze({
  radiance: 'Cᵢ = ∫ L(ω)·Yᵢ(ω) dω',
  irradiance: 'Eᵢ = Cᵢ·A_l',
});

export const FOUR_PI = 4 * Math.PI;

export const ROTATION_CONVENTION =
  '绕 +y 右手系正旋转：θ 为正时 +x → −z（+90° 时 x 轴指向 −z）；' +
  '旋转后的环境为 Lr(n) = L(R⁻¹n)，系数按同一角度预先烘焙。';
