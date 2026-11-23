/*
 * 满额基准数据生成器（页面与测试共用）
 *
 * 240 拍 / 4096 样本 / 60000 条有向边。
 * 骨干：240 个互不相同、双脚离地的样本串成一条链，保证全程可达；
 * 尾两拍改用同一世界落点的支撑脚，构成唯一合法支撑出口。
 * 用于核对容量与“尾段不被截断”。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FootlockLargeCase = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var T = 240, N = 4096, NE = 60000;

  function buildLargeCase(seed) {
    var s = (seed === undefined ? 424242 : seed) >>> 0;
    function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
    var angles = [0, 90, 180, 270];

    var samples = [];
    for (var i = 0; i < N; i++) {
      samples.push({
        id: i + 1,
        left: [(rnd() * 7 | 0) - 3, (rnd() * 7 | 0) - 3, rnd() < 0.08],
        right: [(rnd() * 7 | 0) - 3, (rnd() * 7 | 0) - 3, rnd() < 0.08]
      });
    }

    var backbone = [];
    for (var b = 0; b < T; b++) backbone.push(b); // 样本编号 b+1
    // 骨干样本双脚离地（无脚锁约束），左右脚各有局部偏移，便于在场地上区分左右脚
    for (var bi = 0; bi < T; bi++) {
      samples[backbone[bi]] = { id: backbone[bi] + 1, left: [2, 0, false], right: [-2, 0, false] };
    }
    samples[backbone[T - 1]] = { id: backbone[T - 1] + 1, left: [0, 0, true], right: [0, 0, false] };
    samples[backbone[T - 2]] = { id: backbone[T - 2] + 1, left: [0, 0, true], right: [0, 0, false] };

    var edges = [];
    for (var t = 0; t < T - 1; t++) {
      edges.push({ from: backbone[t] + 1, to: backbone[t + 1] + 1, fee: String(Math.floor(rnd() * 1e5)), jump: false });
    }
    var per = Math.floor((NE - edges.length) / N);
    for (var a = 1; a <= N && edges.length < NE; a++) {
      for (var k = 0; k < per && edges.length < NE; k++) {
        edges.push({ from: a, to: 1 + (rnd() * N | 0), fee: String(Math.floor(rnd() * 1e5)), jump: rnd() < 0.02 });
      }
    }
    while (edges.length < NE) {
      edges.push({ from: 1 + (rnd() * N | 0), to: 1 + (rnd() * N | 0), fee: String(Math.floor(rnd() * 1e5)), jump: rnd() < 0.02 });
    }
    edges.length = NE;

    var ticks = [];
    var rx = 0, ry = 0, curAng = 0;
    for (var t2 = 0; t2 < T; t2++) {
      if (t2 > 0) {
        rx += (rnd() * 3 | 0) - 1; ry += (rnd() * 3 | 0) - 1;
        if (rnd() < 0.15) curAng = angles[(rnd() * 4) | 0];
      }
      var costs = {};
      costs[String(backbone[t2] + 1)] = String(Math.floor(rnd() * 1e5) + 500);
      var cnt = 220 + (rnd() * 380 | 0);
      for (var c = 0; c < cnt; c++) {
        var id = 1 + (rnd() * N | 0);
        if (costs[String(id)] === undefined) costs[String(id)] = String(Math.floor(rnd() * 1e5));
      }
      ticks.push({ root: [rx, ry], angle: curAng, costs: costs });
    }

    // 尾段：唯一合法支撑出口
    ticks[T - 1] = { root: [0, 0], angle: 0, costs: {} };
    ticks[T - 1].costs[String(backbone[T - 1] + 1)] = '0';
    ticks[T - 2].root = [0, 0];
    ticks[T - 2].angle = 0;
    ticks[T - 2].costs[String(backbone[T - 2] + 1)] = String(Math.floor(rnd() * 1e5) + 500);

    return {
      samples: samples,
      edges: edges,
      ticks: ticks,
      rules: '满额基准：240 拍 / 4096 样本 / 60000 边；尾段为唯一合法支撑出口，用于核对容量与尾段完整求解。'
    };
  }

  return { buildLargeCase: buildLargeCase, TICKS: T, SAMPLES: N, EDGES: NE };
});
