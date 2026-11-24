/*
 * 裁幅取样：输出像素 (x,y) → 源坐标 (x + (W−cropW)/2 + ux, y + (H−cropH)/2 + uy)，
 * 三通道独立双线性插值，按 floor(v + 0.5) 取整。越界邻项夹取到边缘（约束保证通常不触发）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAPCrop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 输出像素 → 源浮点坐标。 */
  function sourceCoord(x, y, W, H, cropW, cropH, ux, uy) {
    return [x + (W - cropW) / 2 + ux, y + (H - cropH) / 2 + uy];
  }

  /** 逐通道双线性并取整（floor(v+0.5)）。 */
  function bilinear(src, W, H, sx, sy, out) {
    let x0 = Math.floor(sx);
    let y0 = Math.floor(sy);
    let fx = sx - x0;
    let fy = sy - y0;
    // 夹取到图像范围
    if (x0 < 0) { x0 = 0; fx = 0; }
    if (y0 < 0) { y0 = 0; fy = 0; }
    if (x0 > W - 1) { x0 = W - 1; fx = 0; }
    if (y0 > H - 1) { y0 = H - 1; fy = 0; }
    const x1 = Math.min(x0 + 1, W - 1);
    const y1 = Math.min(y0 + 1, H - 1);
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const i00 = (y0 * W + x0) * 3;
    const i10 = (y0 * W + x1) * 3;
    const i01 = (y1 * W + x0) * 3;
    const i11 = (y1 * W + x1) * 3;
    for (let c = 0; c < 3; c++) {
      const v = src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
      let q = Math.floor(v + 0.5);
      if (q < 0) q = 0;
      else if (q > 255) q = 255;
      out[c] = q;
    }
    return out;
  }

  /** 单像素精确取样（含插值细节，供检视器）。 */
  function samplePixel(src, W, H, cropW, cropH, x, y, ux, uy) {
    const [sx, sy] = sourceCoord(x, y, W, H, cropW, cropH, ux, uy);
    const out = [0, 0, 0];
    bilinear(src, W, H, sx, sy, out);
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    return {
      x, y, sx, sy, rgb: [out[0], out[1], out[2]],
      x0, y0, fx: sx - x0, fy: sy - y0,
      x1: Math.min(x0 + 1, W - 1), y1: Math.min(y0 + 1, H - 1),
    };
  }

  /** 整幅渲染：返回 Uint8Array(cropW*cropH*3)。 */
  function renderCrop(src, W, H, cropW, cropH, ux, uy) {
    const out = new Uint8Array(cropW * cropH * 3);
    const baseX = (W - cropW) / 2 + ux;
    const baseY = (H - cropH) / 2 + uy;
    const tmp = [0, 0, 0];
    let o = 0;
    for (let y = 0; y < cropH; y++) {
      const sy = y + baseY;
      for (let x = 0; x < cropW; x++) {
        bilinear(src, W, H, x + baseX, sy, tmp);
        out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2];
        o += 3;
      }
    }
    return out;
  }

  /**
   * 按显示分辨率抽稀预览：每个显示像素仍走同一双线性公式，从输出像素最近邻取。
   * 与 renderCrop 是同一映射的精确子采样（dst 与 crop 同尺寸时逐字节一致）。
   */
  function renderCropPreview(src, W, H, cropW, cropH, ux, uy, dstW, dstH) {
    const out = new Uint8Array(dstW * dstH * 3);
    const baseX = (W - cropW) / 2 + ux;
    const baseY = (H - cropH) / 2 + uy;
    const tmp = [0, 0, 0];
    let o = 0;
    for (let dy = 0; dy < dstH; dy++) {
      const oy = Math.min(cropH - 1, Math.floor((dy + 0.5) * cropH / dstH));
      const sy = oy + baseY;
      for (let dx = 0; dx < dstW; dx++) {
        const ox = Math.min(cropW - 1, Math.floor((dx + 0.5) * cropW / dstW));
        bilinear(src, W, H, ox + baseX, sy, tmp);
        out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2];
        o += 3;
      }
    }
    return out;
  }

  return { sourceCoord, samplePixel, renderCrop, renderCropPreview };
});
