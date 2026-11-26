/*
 * 三张结果图的伪彩渲染。
 * 强度：感知灰度；线偏振度：单色感知顺序带（0..1）；角度：循环色带（0..180°）；
 * 无解像素统一品红标记（任何模式下都标出）。全部输出 ImageData。
 */
(function (global) {
  'use strict';

  var NO_SOLUTION = [214, 0, 204]; // 品红，专用于无解标记

  function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(c) {
    c = Math.max(0, Math.min(1, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 0.4166667) - 0.055;
  }

  // DoLP 顺序带锚点（sRGB），由浅到深的蓝青单色带
  var DOLP_STOPS = [
    [238, 244, 250], [202, 222, 238], [152, 193, 226], [96, 158, 209],
    [44, 123, 186], [18, 92, 150], [8, 57, 104],
  ];
  // 循环角度带（6 段，首尾同色以闭合 0/180°）
  var ANGLE_STOPS = [
    [202, 70, 75],    // 0° 红
    [230, 150, 60],   // 30° 橙
    [226, 214, 84],   // 60° 黄
    [96, 184, 110],   // 90° 绿
    [70, 140, 210],   // 120° 蓝
    [150, 90, 190],   // 150° 紫
    [202, 70, 75],    // 180° 回到红
  ];

  function interpStops(stops, t) {
    t = Math.max(0, Math.min(1, t));
    var scaled = t * (stops.length - 1);
    var i = Math.floor(scaled);
    if (i >= stops.length - 1) return stops[stops.length - 1].slice();
    var f = scaled - i;
    var a = stops[i], b = stops[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }

  function grayOf(rgb) {
    // Rec.709 亮度
    return Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
  }

  function makeImageData(width, height) {
    return new ImageData(width, height);
  }

  /**
   * 渲染结果图。
   * kind: 'intensity' | 'dolp' | 'angle'
   * result: {width,height,s0,s1,s2,solved}
   * grayMode: true 时把彩色带映射为灰度（无解仍用品红，靠图例+图案区分）
   */
  function render(kind, result, grayMode) {
    var w = result.width, h = result.height;
    var img = makeImageData(w, h);
    var data = img.data;
    // 强度归一化范围（固定用 s0 的分位，避免单帧重算导致色标跳动）
    var s0max = 0;
    for (var i = 0; i < w * h; i++) if (result.solved[i] && result.s0[i] > s0max) s0max = result.s0[i];
    if (s0max <= 0) s0max = 1;

    for (var px = 0; px < w * h; px++) {
      var o = px * 4;
      if (!result.solved[px]) {
        data[o] = NO_SOLUTION[0]; data[o + 1] = NO_SOLUTION[1]; data[o + 2] = NO_SOLUTION[2];
        data[o + 3] = 255;
        continue;
      }
      var rgb;
      if (kind === 'intensity') {
        var t = Math.sqrt(result.s0[px] / s0max); // 平方根压缩，兼顾暗部
        var g = Math.round(linearToSrgb(t) * 255);
        rgb = [g, g, g];
      } else if (kind === 'dolp') {
        var pol = Math.hypot(result.s1[px], result.s2[px]);
        var d = result.s0[px] > 0 ? pol / result.s0[px] : 0;
        d = Math.max(0, Math.min(1, d));
        rgb = interpStops(DOLP_STOPS, d);
        if (grayMode) { var gg = grayOf(rgb); rgb = [gg, gg, gg]; }
      } else {
        var mag = Math.hypot(result.s1[px], result.s2[px]);
        if (mag < 1) {
          // 角度未定义：中性灰斜纹感（这里用固定中性灰，图例说明）
          rgb = [120, 120, 120];
          if (!grayMode) rgb = [176, 176, 176];
        } else {
          var deg = 0.5 * Math.atan2(result.s2[px], result.s1[px]) * 180 / Math.PI;
          if (deg < 0) deg += 180;
          rgb = interpStops(ANGLE_STOPS, deg / 180);
          if (grayMode) { var ag = grayOf(rgb); rgb = [ag, ag, ag]; }
        }
      }
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
    }
    return img;
  }

  // 画布最近邻缩放绘制（保持像素边界，图像 <=256 放大显示）
  function drawToCanvas(canvas, imgData, displaySize) {
    var w = imgData.width, h = imgData.height;
    canvas.width = displaySize;
    canvas.height = Math.round(displaySize * h / w);
    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d').putImageData(imgData, 0, 0);
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  global.StokesRender = {
    render: render,
    drawToCanvas: drawToCanvas,
    NO_SOLUTION: NO_SOLUTION,
    DOLP_STOPS: DOLP_STOPS,
    ANGLE_STOPS: ANGLE_STOPS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
