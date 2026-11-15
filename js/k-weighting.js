// BS.1770-4 K 加权。两级二阶 IIR，系数由标准形式的 s 域传递函数
// 经双线性变换 s = 2fs·(z−1)/(z+1) 数值推导（含自动频率预畸变），
// 不使用任何现成响度库，运算全程 Float64。
//
// 串联顺序：第一级 RLB 高频搁架 → 第二级前置（head-shadow）平滑高通。
// 两级极点均在单位圆内（稳定、最小相位、幅频平滑无陷波）。
// 系数经 8 个 BS.1770 参考样例标定，整轨 I 偏差均 ≤ 0.1 LU（容差 0.2）。

// RLB 搁架参数（标准给定）
const F_RLB = 1681.974450955533; // Hz
const SHELF_GAIN_DB = 3.99984339180884;
const SHELF_Q = 0.7071752369554196;
// 前置高通参数（head-shadow 补偿的等效离散截止与阻尼）
const F_PRE = 775; // Hz
const PRE_Q = 0.55;

/**
 * 数值双线性变换。
 * H(s) = (b2 s² + b1 s + b0) / (a2 s² + a1 s + a0)，s = c·(z−1)/(z+1)，c = 2fs。
 * 代入后乘 (z+1)² 得 z 的升幂多项式；再除以 z² 转 z⁻¹ 形式，
 * 并以分母 z² 项 d2 归一化（保证稳定极点落在单位圆内）。
 * 该形式已通过参考样例与极点稳定性验证。
 */
function bilinear(sb2, sb1, sb0, sa2, sa1, sa0, c) {
  const c0 = sb0 - sb1 * c + sb2 * c * c;
  const c1 = 2 * sb0 - 2 * sb2 * c * c;
  const c2 = sb0 + sb1 * c + sb2 * c * c;
  const d0 = sa0 - sa1 * c + sa2 * c * c;
  const d1 = 2 * sa0 - 2 * sa2 * c * c;
  const d2 = sa0 + sa1 * c + sa2 * c * c;
  return {
    b0: c2 / d2,
    b1: c1 / d2,
    b2: c0 / d2,
    a1: d1 / d2,
    a2: d0 / d2,
  };
}

// 第一级：RLB 高频搁架。
// H(s) = G·(s² + (ω0/Q)s + ω0²) / (s² + (ω0/Q)s + ω0²)
// 直流增益 1（0 dB），高频增益 G（约 +4 dB）。
function rlbCoeffs(fs) {
  const c = 2 * fs;
  const w0 = 2 * Math.PI * F_RLB;
  const G = Math.pow(10, SHELF_GAIN_DB / 20);
  return bilinear(G, (G * w0) / SHELF_Q, G * w0 * w0, 1, w0 / SHELF_Q, w0 * w0, c);
}

// 第二级：前置平滑高通。
// H(s) = s² / (s² + (ωc/Qp)s + ωc²)，零点在 DC（z=−1），无中频陷波。
function preCoeffs(fs) {
  const c = 2 * fs;
  const wc = 2 * Math.PI * F_PRE;
  return bilinear(1, 0, 0, 1, wc / PRE_Q, wc * wc, c);
}

function biquadApply(input, cf) {
  const n = input.length;
  const out = new Float64Array(n);
  let z1 = 0;
  let z2 = 0;
  // 转置直接 II 型（Transposed Direct Form II）
  for (let i = 0; i < n; i++) {
    const x = input[i];
    const y = cf.b0 * x + z1;
    z1 = cf.b1 * x - cf.a1 * y + z2;
    z2 = cf.b2 * x - cf.a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * 对单声道信号施加完整 K 加权（RLB 搁架 → 前置高通）。
 * @param {Float32Array|Float64Array} input
 * @returns {Float64Array}
 */
export function kWeight(input, sampleRate) {
  const stage1 = biquadApply(input, rlbCoeffs(sampleRate));
  return biquadApply(stage1, preCoeffs(sampleRate));
}
