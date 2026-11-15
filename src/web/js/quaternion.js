/*
 * 四元数与旋转矩阵。
 *
 * 约定（与 conventions.json 一致）：
 * - 四元数记为 [w, x, y, z]，作用于向量时为主动旋转 q * v * q⁻¹。
 * - 声场坐标是右手系：X 向前、Y 向左、Z 向上。
 * - 欧拉角以度输入，矩阵次序 Rz(yaw) * Ry(pitch) * Rx(roll)。
 *   等价四元数为 q = qz(yaw) ⊗ qy(pitch) ⊗ qx(roll)。
 * - W 分量不随旋转改变（一阶声场的 0 阶项是各向同性的）。
 *
 * 矩阵以 9 个数字的行主序数组表示：对列向量 (X, Y, Z)ᵀ，
 *   X' = m[0]X + m[1]Y + m[2]Z
 *   Y' = m[3]X + m[4]Y + m[5]Z
 *   Z' = m[6]X + m[7]Y + m[8]Z
 */

export const DEG = Math.PI / 180;

/** 四元数模长。 */
export function quatNorm(q) {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

/**
 * 归一化四元数；全零或含非有限数时返回 null（调用方必须拒绝）。
 */
export function normalizeQuat(q) {
  if (!Array.isArray(q) || q.length !== 4) return null;
  for (let i = 0; i < 4; i++) if (!Number.isFinite(q[i])) return null;
  const n = quatNorm(q);
  if (!(n > 0)) return null;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Hamilton 乘积 a ⊗ b。 */
export function quatMul(a, b) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** 由轴与角（弧度）构造单位四元数。 */
export function quatFromAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), ax * s, ay * s, az * s];
}

/**
 * 欧拉角（度）→ 四元数，次序 Rz(yaw) Ry(pitch) Rx(roll)。
 * 返回值已归一化。
 */
export function quatFromEulerDeg(yawDeg, pitchDeg, rollDeg) {
  const qz = quatFromAxisAngle(0, 0, 1, yawDeg * DEG);
  const qy = quatFromAxisAngle(0, 1, 0, pitchDeg * DEG);
  const qx = quatFromAxisAngle(1, 0, 0, rollDeg * DEG);
  return normalizeQuat(quatMul(quatMul(qz, qy), qx));
}

/** 欧拉角（度）→ 旋转矩阵（Rz Ry Rx，主动旋转）。 */
export function matrixFromEulerDeg(yawDeg, pitchDeg, rollDeg) {
  const q = quatFromEulerDeg(yawDeg, pitchDeg, rollDeg);
  return quatToMatrix(q);
}

/** 单位四元数 q 对应的主动旋转矩阵（行主序 9 元）。 */
export function quatToMatrix(q) {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * 对列向量 (X, Y, Z) 应用行主序矩阵，写入 out（长度 3）。
 * out 允许与输入同一数组。
 */
export function applyMatrix3(m, x, y, z, out) {
  const nx = m[0] * x + m[1] * y + m[2] * z;
  const ny = m[3] * x + m[4] * y + m[5] * z;
  const nz = m[6] * x + m[7] * y + m[8] * z;
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
  return out;
}

/**
 * 将相邻关键帧调整到同一半球（点积为负则翻转后一项），
 * 保证后续 SLERP 走最短弧。入参四元数须已归一化。
 */
export function alignShortestArc(quats) {
  const out = [];
  for (let i = 0; i < quats.length; i++) {
    let q = quats[i].slice();
    if (i > 0) {
      const prev = out[i - 1];
      const dot = prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3];
      if (dot < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    }
    out.push(q);
  }
  return out;
}

/**
 * 球面插值（a、b 需已同半球，即点积 ≥ 0）。
 * 近共线时退化为归一化线性插值，避免 sin θ → 0 的数值抖动。
 * @param {number[]} a 归一化四元数
 * @param {number[]} b 归一化四元数
 * @param {number} t [0,1]
 */
export function slerp(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;
  if (dot > 0.9999995) {
    const w = 1 - t;
    const q = [
      w * a[0] + t * b[0],
      w * a[1] + t * b[1],
      w * a[2] + t * b[2],
      w * a[3] + t * b[3],
    ];
    return normalizeQuat(q);
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [
    wa * a[0] + wb * b[0],
    wa * a[1] + wb * b[1],
    wa * a[2] + wb * b[2],
    wa * a[3] + wb * b[3],
  ];
}

/** 方位角（度，从 +X 转向 +Y）与仰角（度）→ 单位向量。 */
export function sphericalToVector(azDeg, elDeg) {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  const c = Math.cos(el);
  return [c * Math.cos(az), c * Math.sin(az), Math.sin(el)];
}

/** 单位向量 → { az, el }（度）。零向量返回 null。 */
export function vectorToSpherical(v) {
  const [x, y, z] = v;
  const r = Math.hypot(x, y, z);
  if (!(r > 0)) return null;
  let az = Math.atan2(y, x) / DEG;
  if (az <= -180) az += 360;
  const el = Math.asin(Math.max(-1, Math.min(1, z / r))) / DEG;
  return { az, el };
}

/**
 * 四元数 → { yaw, pitch, roll }（度），是 Rz(yaw)Ry(pitch)Rx(roll) 的反解。
 * 只用于显示；万向锁（|sin pitch| → 1）时 roll 固定为 0，全部角度并入 yaw。
 */
export function eulerDegFromQuat(q) {
  const m = quatToMatrix(q);
  const sy = Math.max(-1, Math.min(1, -m[6]));
  const pitch = Math.asin(sy) / DEG;
  if (Math.abs(sy) < 0.999999) {
    return {
      yaw: Math.atan2(m[3], m[0]) / DEG,
      pitch,
      roll: Math.atan2(m[7], m[8]) / DEG,
    };
  }
  return { yaw: Math.atan2(-m[1], m[4]) / DEG, pitch, roll: 0 };
}

/** 把角度折算到 (-180, 180]，用于展示。 */
export function wrapDeg(d) {
  let v = ((d + 180) % 360 + 360) % 360 - 180;
  if (v <= -180) v += 360;
  return v;
}
