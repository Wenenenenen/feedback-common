// 几何工具：四角投影、投影地平线检查、画布包围盒。
// 像素中心坐标：四角为 (0,0)、(w-1,0)、(w-1,h-1)、(0,h-1)。

import { matVec } from './linalg.js';

export function imageCorners(width, height) {
  return [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1],
  ];
}

// 用 H 把像素中心齐次点映到目标平面，返回 [x, y, w]
export function projectPoint(H, x, y) {
  return matVec(H, x, y, 1);
}

// 投影地平线检查：
// 对四角及四条边（按像素中心细分采样）检查齐次分母。
// 分母跨零或接近零（|w| <= eps*|h33|，或 w<=0）即拒绝。
// 返回 { ok, reason, badPoint }
export function checkHorizon(H, width, height) {
  const eps = 1e-6;
  const h33 = H[8];
  const threshold = eps * Math.abs(h33);
  const samples = [];
  const corners = imageCorners(width, height);
  for (const c of corners) samples.push(c);
  // 边按 1 像素步长补采样，捕捉边段内的分母过零
  const pushEdge = (p, q) => {
    const steps = Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      samples.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  };
  for (let e = 0; e < 4; e++) pushEdge(corners[e], corners[(e + 1) % 4]);

  for (const [x, y] of samples) {
    const [, , w] = projectPoint(H, x, y);
    if (!Number.isFinite(w) || w <= 0 || Math.abs(w) <= threshold) {
      return {
        ok: false,
        reason:
          `投影地平线穿过图像：点 (${x.toFixed(2)}, ${y.toFixed(2)}) 的齐次分母 w=${w}，` +
          '该单应会把有限像素映到无穷远，拒绝使用',
        badPoint: [x, y],
      };
    }
  }
  return { ok: true };
}

// 计算一张图经 H 映到参考平面后的包围盒（像素中心坐标）
export function warpedBounds(H, width, height) {
  const corners = imageCorners(width, height);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    const [X, Y, w] = projectPoint(H, x, y);
    const u = X / w, v = Y / w;
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      throw new Error('投影后包围盒出现非有限坐标（地平线退化）');
    }
    minX = Math.min(minX, u); maxX = Math.max(maxX, u);
    minY = Math.min(minY, v); maxY = Math.max(maxY, v);
  }
  return { minX, minY, maxX, maxY };
}

// 画布规则：最小坐标 floor(min)，最大坐标 ceil(max)，两端均包含，offset = -min。
// 像素中心 c 落在画布像素索引 c - min（整数）。
export function computeCanvas(allBounds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of allBounds) {
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  const originX = Math.floor(minX);
  const originY = Math.floor(minY);
  const farX = Math.ceil(maxX);
  const farY = Math.ceil(maxY);
  const width = farX - originX + 1;
  const height = farY - originY + 1;
  return {
    originX, originY, width, height,
    offsetX: -originX,
    offsetY: -originY,
  };
}
