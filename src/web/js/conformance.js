/*
 * 期望值核对。
 *
 * 读取样例包内的 expected.json（经 /api/expected），对当前烘焙结果做断言。
 * 这里只依赖纯函数模块，便于 Node 测试直接调用。
 */

import { convolve, evaluate, l1Direction, rotateY } from './sh.js';

/**
 * 与 rotateY 相同的旋转约定作用于一个方向向量。
 * Lr(n) = L(R⁻¹n) 等价于「环境内容按 R 正向转」：角度为 +90° 时 (1,0,0) → (0,0,−1)。
 */
export function rotateAxisY(angleDeg, x, y, z) {
  const t = (angleDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: s * z + c * x, y, z: -s * x + c * z };
}

const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));

function fmt(v, digits = 6) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(3);
  return v.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

/**
 * @param {object} exp expected.json 内容
 * @param {string} sampleId 样例 id
 * @param {{radiance:Float64Array, totalSolidAngle:number,
 *          naiveMean:Float64Array, weightedMean:Float64Array}} result 未旋转的烘焙结果
 * @returns {{name:string,pass:boolean,detail:string}[]}
 */
export function expectedChecks(exp, sampleId, result) {
  const checks = [];
  if (!exp || !result) return checks;
  const c = result.radiance;
  const e = convolve(c);

  if (sampleId === 'constant-le' || sampleId === 'constant-be-scale2') {
    const rgb = exp.constant_rgb;
    const C0 = 4 * Math.PI * 0.28209479177387814;
    const okC0 = [0, 1, 2].every((k) => rel(c[k], C0 * rgb[k]) < 1e-5);
    checks.push({
      name: 'C₀ = 4π·Y00·L',
      pass: okC0,
      detail: `C₀ = ${[0, 1, 2].map((k) => fmt(c[k], 7)).join(' / ')}`,
    });
    const okE0 = [0, 1, 2].every((k) => rel(e[k], Math.PI * c[k]) < 1e-9);
    checks.push({
      name: 'E₀ = π·C₀',
      pass: okE0,
      detail: `E₀ = ${[0, 1, 2].map((k) => fmt(e[k], 7)).join(' / ')}`,
    });
    const constantE = [0, 1, 2].map((k) => e[k] / (4 * Math.PI * 0.28209479177387814));
    const okConst = constantE.every((v, k) => rel(v, Math.PI * rgb[k]) < 1e-5);
    checks.push({
      name: 'E(n) 各向同性 = π·L',
      pass: okConst,
      detail: `E(n) = ${constantE.map((v) => fmt(v, 6)).join(' / ')}`,
    });
    if (Array.isArray(exp.constant_irradiance)) {
      // 该字段即 π·L（E(n) 的常数项）
      const okExp = exp.constant_irradiance.every((v, k) => rel(v, Math.PI * rgb[k]) < 1e-9);
      checks.push({
        name: 'expected.constant_irradiance = π·L',
        pass: okExp,
        detail: exp.constant_irradiance.map((v) => fmt(v, 6)).join(' / '),
      });
    }
  }

  if (sampleId === 'linear') {
    const dirs = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let maxErr = 0;
    const got = new Float64Array(3);
    for (const [x, y, z] of dirs) {
      evaluate(e, x, y, z, got);
      const base = 1 + (2 / 3) * (0.6 * x + 0.2 * y);
      const want = [Math.PI * 1 * base, Math.PI * 2 * base, Math.PI * 0.5 * base];
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, rel(got[k], want[k]));
    }
    // 128×64 中点求积对 l=1 不是严格精确，固有相对误差 ~1e-4，故用 1e-3 容差。
    checks.push({
      name: 'E(n) 符合 π·C·(1 + ⅔(0.6nx + 0.2ny))',
      pass: maxErr < 1e-3,
      detail: `6 方向最大相对误差 ${maxErr.toExponential(2)}（容差 1e-3）`,
    });
    // +x 方向（该环境的水平主亮瓣）在 +90° 后应指向 −z
    const axis = rotateAxisY(90, 1, 0, 0);
    const target = exp.rotation_90_bright_direction || [0, 0, -1];
    const okAxis = Math.abs(axis.x - target[0]) < 1e-9
      && Math.abs(axis.y - target[1]) < 1e-9
      && Math.abs(axis.z - target[2]) < 1e-9;
    checks.push({
      name: '旋转 +90°：+x → (0, 0, −1)（右手系，+x 转向 −z）',
      pass: okAxis,
      detail: `(${fmt(axis.x, 6)}, ${fmt(axis.y, 6)}, ${fmt(axis.z, 6)})`,
    });
    // 旋转后亮部应只在 (y 仰角, −z) 平面内：x≈0、z<0
    const bright = l1Direction(rotateY(c, 90));
    const okDir = bright && Math.abs(bright.x) < 2e-3 && bright.z < -0.9;
    checks.push({
      name: '旋转 +90°：亮瓣离开 +x，转到 −z 一侧（x≈0、z<0）',
      pass: Boolean(okDir),
      detail: bright ? `(${fmt(bright.x, 4)}, ${fmt(bright.y, 4)}, ${fmt(bright.z, 4)})` : '无 l=1',
    });
  }

  if (sampleId === 'polar') {
    checks.push({
      name: 'l=1 亮部指向 +y（顶部亮环）',
      pass: Boolean(l1Direction(c)) && l1Direction(c).y > 0.99,
      detail: l1Direction(c) ? `y = ${fmt(l1Direction(c).y, 6)}` : '无 l=1',
    });
    const naive = result.naiveMean[0];
    const weighted = result.weightedMean[0];
    checks.push({
      name: '直接平均 ≠ 立体角加权（极区权重）',
      pass: Math.abs(naive - weighted) > 1e-3,
      detail: `直接 ${fmt(naive)} · 加权 ${fmt(weighted)}`,
    });
  }

  if (Number.isFinite(exp.solid_angle)) {
    checks.push({
      name: 'ΣΩ_r = 4π',
      pass: rel(result.totalSolidAngle, exp.solid_angle) < 1e-6,
      detail: `${fmt(result.totalSolidAngle, 9)} vs ${fmt(exp.solid_angle, 9)}`,
    });
  }

  return checks;
}
