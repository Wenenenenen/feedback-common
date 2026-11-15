// CPU 侧图像采样（sRGB 解码为线性，双线性）与幕布探针。
(function (global) {
  'use strict';

  class ImageSampler {
    constructor(image) {
      const w = image.width || image.naturalWidth;
      const h = image.height || image.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      this.data = ctx.getImageData(0, 0, w, h).data;
      this.width = w;
      this.height = h;
    }

    // 帧缓冲坐标（浮点，像素中心体系），双线性采样，返回 sRGB 字节 [r,g,b]
    sampleSrgb(x, y) {
      const { width: w, height: h, data } = this;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
      function px(xx, yy) {
        const i = (yy * w + xx) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      }
      const p00 = px(cx0, cy0), p10 = px(x1, cy0), p01 = px(cx0, y1), p11 = px(x1, y1);
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const top = p00[c] * (1 - fx) + p10[c] * fx;
        const bot = p01[c] * (1 - fx) + p11[c] * fx;
        out[c] = top * (1 - fy) + bot * fy;
      }
      return out;
    }

    // 返回线性 RGB
    sampleLinear(x, y) {
      const s = this.sampleSrgb(x, y);
      return ColorUtil.srgbBytesToLinear(s[0], s[1], s[2]);
    }
  }

  // 幕布某点的完整探针信息
  function probeAt(state, sampler, sx, sy) {
    const result = {
      surface: [sx, sy],
      perProjector: [],
      weights: [],
      coveredCount: 0,
      compositeLinear: [0, 0, 0],
      covered: false
    };
    const cover = [], raws = [], frame = [];
    state.projectors.forEach((p, i) => {
      // 非法四边形不参与覆盖、采样与融合
      if (p.invalidReason) {
        cover.push(false);
        raws.push(0);
        result.perProjector.push({
          id: p.id, inside: false, minDistance: 0,
          framebuffer: null, linear: null
        });
        return;
      }
      const [w, h] = p.size;
      const H = Geo.homography(Geo.frameCorners(w, h), p.quad);
      const inv = Geo.invert3(H);
      const info = Geo.pointInsideQuad(p.quad, sx, sy);
      cover.push(info.inside);
      raws.push(info.minDistance);
      let fb = null, linear = null;
      if (info.inside) {
        const v = Geo.applyH(inv, sx, sy);
        fb = v;
        if (sampler && v[0] >= -0.5 && v[0] <= sampler.width - 0.5 &&
            v[1] >= -0.5 && v[1] <= sampler.height - 0.5) {
          linear = sampler.sampleLinear(v[0], v[1]);
        } else {
          linear = [0, 0, 0];
        }
        result.coveredCount += 1;
      }
      frame.push(fb);
      result.perProjector.push({
        id: p.id,
        inside: info.inside,
        minDistance: info.inside ? info.minDistance : 0,
        framebuffer: fb,
        linear
      });
    });
    result.covered = result.coveredCount > 0;
    result.weights = Geo.blendWeights(cover, raws, state.feather);
    for (let i = 0; i < state.projectors.length; i++) {
      if (result.weights[i] > 0 && result.perProjector[i].linear) {
        for (let c = 0; c < 3; c++) {
          result.compositeLinear[c] += result.perProjector[i].linear[c] * result.weights[i];
        }
      }
    }
    return result;
  }

  global.Sampler = { ImageSampler, probeAt };
})(typeof window !== 'undefined' ? window : globalThis);
