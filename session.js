/*
 * 校片会话：持有最近一次有效场景与渲染结果。
 *
 * 关键行为（对应需求“无效凸孔径要指出问题，并保留上一次结果”）：
 *   · loadScene() 校验失败时不改动任何现有状态，调用方仍可继续点查/导出旧结果；
 *   · setFocusOffset()/setStop() 参数非法时同样不改动状态；
 *   · 只有校验通过的场景才会替换 prepared 并在 render() 时产生新结果。
 */
(function (root, factory) {
  const M = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (root) root.PupilSession = M;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const Engine = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : root.PupilEngine;

  function finitePair(p) {
    return Array.isArray(p) && p.length === 2 &&
      Number.isFinite(p[0]) && Number.isFinite(p[1]);
  }

  function copyStop(stop) {
    return { offset: [stop.offset[0], stop.offset[1]], slope: [stop.slope[0], stop.slope[1]] };
  }

  class Session {
    constructor() {
      this.scene = null;
      this.prepared = null;
      this.focusOffset = 0;
      this.stop = null;
      this.result = null;
      this.renderCount = 0;
    }

    // 载入场景。成功返回 {ok:true}；失败返回 {ok:false, errors, keptResult}。
    loadScene(scene) {
      const { errors, prepared } = Engine.prepare(scene);
      if (errors.length) {
        return { ok: false, errors, keptResult: !!this.result };
      }
      this.scene = scene;
      this.prepared = prepared;
      // 新场景从它的光阑与 f = 0 起步；校验失败时不会走到这里，旧状态原样保留。
      this.stop = copyStop(prepared.stop);
      this.focusOffset = 0;
      return { ok: true, errors: [], keptResult: false };
    }

    setFocusOffset(f) {
      if (typeof f !== 'number' || !Number.isFinite(f)) {
        return { ok: false, errors: ['焦面偏移系数须为有限数'] };
      }
      this.focusOffset = f;
      return { ok: true, errors: [] };
    }

    setStop(offset, slope) {
      const errors = [];
      if (!finitePair(offset)) errors.push('光阑 offset 须为两个有限数 [x, y]');
      if (!finitePair(slope)) errors.push('光阑 slope 须为两个有限数 [x, y]');
      if (errors.length) return { ok: false, errors };
      this.stop = { offset: [offset[0], offset[1]], slope: [slope[0], slope[1]] };
      return { ok: true, errors: [] };
    }

    resetStopToScene() {
      if (!this.prepared) return false;
      this.stop = copyStop(this.prepared.stop);
      return true;
    }

    opts() {
      return {
        focusOffset: this.focusOffset,
        stop: this.stop || (this.prepared && this.prepared.stop),
      };
    }

    // 全帧渲染。返回 {width, height, pixels, elapsedMs, pupilArea, shareResidualMax}。
    render() {
      if (!this.prepared) throw new Error('尚未载入有效场景');
      const p = this.prepared;
      const opts = this.opts();
      const w = p.width, h = p.height;
      const pixels = new Array(w * h);
      let residual = 0;
      const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const rec = Engine.computePixelShares(p, x, y, opts);
          const r = Math.abs(rec.shareSum - 1);
          if (r > residual) residual = r;
          pixels[y * w + x] = rec;
        }
      }
      const t1 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      this.renderCount++;
      this.result = {
        width: w, height: h,
        pixels,
        elapsedMs: t1 - t0,
        pupilArea: p.pupilArea,
        shareResidualMax: residual,
        // 渲染时的光学参数快照：之后即使 UI 再改参数，检查与导出仍对应当前像素。
        focusOffset: this.focusOffset,
        stop: copyStop(opts.stop),
        opts: { focusOffset: this.focusOffset, stop: copyStop(opts.stop) },
        triCount: p.triangles.length,
      };
      return this.result;
    }

    // 点击检查：返回该像素的占比明细与孔径平面可见多边形。
    inspect(px, py) {
      if (!this.result || !this.prepared) return null;
      const { width, height } = this.result;
      if (!Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0 || px >= width || py >= height) {
        return null;
      }
      const rec = this.result.pixels[py * width + px];
      const opts = this.result.opts || this.opts();
      const regions = Engine.computePixelRegions(this.prepared, px, py, opts);
      return {
        pixel: rec,
        regions,
        pupilArea: this.result.pupilArea,
        focusOffset: opts.focusOffset,
        stop: copyStop(opts.stop),
      };
    }

    // 导出数据：线性 RGB 与相对原始孔径面积的占比。
    exportObject() {
      if (!this.result) return null;
      const res = this.result;
      const pixels = res.pixels.map(rec => {
        const tri = {};
        for (let i = 0; i < rec.tri.length; i++) tri[String(rec.tri[i].id)] = rec.tri[i].share;
        return {
          x: rec.x, y: rec.y,
          rgb: [rec.rgb[0], rec.rgb[1], rec.rgb[2]],
          tri,
          bg: rec.bg.share,
          black: rec.black.share,
        };
      });
      return {
        format: 'pupil-coverage-export/1',
        note: 'rgb 为线性 RGB；tri 以三角形 id 为键、bg、black 均为相对原始孔径面积的占比，' +
          '每个像素的 tri 之和 + bg + black = 1；black 是光阑外的孔径份额。像素按行优先排列。',
        width: res.width,
        height: res.height,
        focusOffset: res.focusOffset,
        stop: res.stop,
        pupilArea: res.pupilArea,
        triCount: res.triCount,
        shareResidualMax: res.shareResidualMax,
        pixels,
      };
    }

    exportJSON(pretty) {
      const obj = this.exportObject();
      return obj ? JSON.stringify(obj, null, pretty ? 2 : 0) : null;
    }
  }

  return { Session };
});
