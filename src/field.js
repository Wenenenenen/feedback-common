/*
 * 周期双线性高度场。
 * height 为节点数组，height[j][i]，j 行（y 方向）i 列（x 方向），
 * 最多 128×128 个节点；XY 两个方向分别按 sx、sy 物理间距周期重复。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./math.js'));
  } else {
    global.ReliefField = factory(global.ReliefMath);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (M) {
  'use strict';

  const MAX_NODES = 128;

  function validateInput(input) {
    const errors = [];
    if (!input || typeof input !== 'object') {
      errors.push('输入不是对象');
      return errors;
    }
    const h = input.height;
    if (!Array.isArray(h) || h.length < 2) {
      errors.push('height 至少需要 2 行节点');
    } else {
      const rows = h.length;
      if (rows > MAX_NODES) errors.push(`height 行数 ${rows} 超过 ${MAX_NODES}`);
      const cols = Array.isArray(h[0]) ? h[0].length : 0;
      if (cols < 2) errors.push('height 每行至少需要 2 列节点');
      if (cols > MAX_NODES) errors.push(`height 列数 ${cols} 超过 ${MAX_NODES}`);
      for (let j = 0; j < rows; j++) {
        if (!Array.isArray(h[j]) || h[j].length !== cols) {
          errors.push(`height 第 ${j} 行列数不一致`);
          break;
        }
        for (let i = 0; i < cols; i++) {
          if (typeof h[j][i] !== 'number' || !Number.isFinite(h[j][i])) {
            errors.push(`height[${j}][${i}] 不是有限数值`);
          }
        }
      }
    }
    const sp = input.spacing;
    if (!Array.isArray(sp) || sp.length !== 2 ||
      !(sp[0] > 0) || !(sp[1] > 0)) {
      errors.push('spacing 必须是两个正数 [sx, sy]');
    }
    return errors;
  }

  class HeightField {
    constructor(input) {
      const errors = validateInput(input);
      if (errors.length) throw new Error('高度场数据无效：' + errors.join('；'));
      this.height = input.height.map((row) => row.slice());
      this.ny = this.height.length;
      this.nx = this.height[0].length;
      this.sx = input.spacing[0];
      this.sy = input.spacing[1];
      // 周期域的物理尺寸：nx 个节点横向跨 nx-1 个格子
      this.periodX = this.sx * (this.nx - 1);
      this.periodY = this.sy * (this.ny - 1);
    }

    // 周期回绕后的节点高度：全局节点号 k 按格子数回绕，
    // 周期末节点（k 为格子数的非零倍数）取数组末索引
    node(i, j) {
      const gx = this.nx - 1, gy = this.ny - 1;
      const ci = M.mod(i, gx);
      const cj = M.mod(j, gy);
      const ii = ci === 0 && i !== 0 ? this.nx - 1 : ci;
      const jj = cj === 0 && j !== 0 ? this.ny - 1 : cj;
      return this.height[jj][ii];
    }

    // 世界格坐标 (cx, cy)（可为任意整数，含负格）对应的四个节点高度。
    // 数据为行主序 height[j][i]：i 沿 u/x 方向，j 沿 v/y 方向。
    // h00 左下、h10 右下、h01 左上、h11 右上。
    //
    // 一个周期含 gx=nx-1 个格子，全局节点号 k 的物理位置是 mod(k,gx)*sx，
    // 数组索引与周期位置同名（余数 0 -> 索引 0）；唯一例外是周期末节点
    // （k 为 gx 的非零倍数），它与首节点同物理位置，数据存在数组末索引 nx-1。
    cellHeights(cx, cy) {
      const nodeCol = (k) => {
        if (M.mod(k, this.nx - 1) !== 0) return M.mod(k, this.nx - 1);
        return k === 0 ? 0 : this.nx - 1;
      };
      const nodeRow = (k) => {
        if (M.mod(k, this.ny - 1) !== 0) return M.mod(k, this.ny - 1);
        return k === 0 ? 0 : this.ny - 1;
      };
      const i0 = nodeCol(cx);
      const i1 = nodeCol(cx + 1);
      const j0 = nodeRow(cy);
      const j1 = nodeRow(cy + 1);
      return {
        h00: this.height[j0][i0],
        h10: this.height[j0][i1],
        h01: this.height[j1][i0],
        h11: this.height[j1][i1],
      };
    }

    cellCoeffs(cx, cy) {
      const h = this.cellHeights(cx, cy);
      return M.bilinearCoeffs(h.h00, h.h10, h.h01, h.h11);
    }

    // 世界点处的曲面高度（周期域内）
    heightAt(x, y) {
      const wx = M.mod(x, this.periodX);
      const wy = M.mod(y, this.periodY);
      const gx = wx / this.sx;
      const gy = wy / this.sy;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      const u = gx - cx;
      const v = gy - cy;
      return M.evalBilinear(this.cellCoeffs(cx, cy), u, v);
    }
  }

  return { HeightField, validateInput, MAX_NODES };
});
