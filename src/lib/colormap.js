// Turbo 近似配色（Google AI Blog, Mikhailov 2019），7 控制点三次样条查表。
// 输入 t∈[0,1]，输出 [r,g,b] 0-255。不可达区域用灰色，由调用方处理。
const TURBO_STOPS = [
  [48, 18, 59],
  [100, 40, 150],
  [34, 90, 225],
  [10, 175, 225],
  [40, 225, 120],
  [180, 245, 50],
  [245, 200, 30],
  [230, 110, 20],
  [170, 30, 10],
];

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function turbo(t) {
  const x = Math.min(1, Math.max(0, t)) * (TURBO_STOPS.length - 1);
  const i = Math.min(TURBO_STOPS.length - 2, Math.floor(x));
  const f = smoothstep(0, 1, x - i);
  const c0 = TURBO_STOPS[i];
  const c1 = TURBO_STOPS[i + 1];
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * f),
    Math.round(c0[1] + (c1[1] - c0[1]) * f),
    Math.round(c0[2] + (c1[2] - c0[2]) * f),
  ];
}

export function turboCss(t) {
  const [r, g, b] = turbo(t);
  return `rgb(${r},${g},${b})`;
}

export const UNREACHABLE_COLOR = [120, 120, 128];

/** 按距离场生成每顶点颜色（可达顶点 turbo 归一化，不可达灰） */
export function fieldColors(distances, maxDistance) {
  const colors = new Float32Array(distances.length * 3);
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    let c;
    if (d === null) c = UNREACHABLE_COLOR;
    else c = turbo(maxDistance > 0 ? d / maxDistance : 0);
    colors[i * 3] = c[0] / 255;
    colors[i * 3 + 1] = c[1] / 255;
    colors[i * 3 + 2] = c[2] / 255;
  }
  return colors;
}
