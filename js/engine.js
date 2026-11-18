/*
 * 漫反射路径追踪参考引擎(纯计算,无 DOM 依赖,可在 Node 中加载测试)
 *
 * 规则(与 samples 包内《格式说明.md》一致):
 *  - BRDF = rho/pi,余弦半球采样 PDF = cos/pi
 *  - 灯面权重 = 面积 * (0.2126R+0.7152G+0.0722B),按权重选灯,三角形内均匀采样
 *  - 面积 PDF 转立体角 PDF:乘 distance^2 / |cos_light|;灯背面贡献 0
 *  - 纯 BRDF:只弹射并累计灯命中;纯灯光:每个漫反射顶点显式采样灯,
 *    只累计相机直接灯命中,不累计 BRDF 碰灯;MIS:两者都采样,权重 p^2/(p^2+q^2),
 *    相机直接碰灯权重 1
 *  - max_depth = 最多漫反射散射次数(0 只看灯);第 3 次散射后俄罗斯轮盘,
 *    存活率 clamp(max(throughput), 0.05, 0.95),存活则除以概率;最多 8 次
 *  - 新射线起点沿出射方向偏移 1e-5
 *  - 漫反射法线朝向入射射线来源一侧;发光只向绕序法线正半球;灯面吸收路径
 *  - 环境黑色;零面积面忽略并计数
 */
(function (g) {
  'use strict';

  var PI = Math.PI;
  var RAY_OFFSET = 1e-5;
  var MIN_AREA = 1e-12;
  var MAX_TRIANGLES = 2000;
  var MAX_LIGHTS = 16;
  var MAX_DEPTH_LIMIT = 8;

  /* ---------------- 随机数:按 (seed, pixel, sample) 独立定流 ----------------
   * 每条路径的随机流只取决于 (seed, pixelIndex, sampleIndex),
   * 与分批、暂停/续算无关,保证固定种子下续算与一次算完逐比特一致。 */
  function hash32(a) {
    a >>>= 0;
    a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
    a ^= a >>> 13;
    a = Math.imul(a, 0xc2b2ae35);
    a ^= a >>> 16;
    return a >>> 0;
  }

  function makeRng(seed, pixelIndex, sampleIndex) {
    var s0 = hash32((seed >>> 0) ^ 0x9e3779b9);
    var s1 = hash32((pixelIndex >>> 0) ^ 0x85ebca6b);
    var s2 = hash32((sampleIndex >>> 0) ^ 0xc2b2ae35);
    var counter = 0;
    return function () {
      var h = hash32(s0 ^ hash32((s1 + counter) >>> 0) ^ hash32(s2 ^ (counter >>> 0)));
      counter++;
      return h / 4294967296; // [0, 1)
    };
  }

  /* ---------------- 向量 ---------------- */
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vlen(a) { return Math.sqrt(vdot(a, a)); }
  function vnorm(a) {
    var l = vlen(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  }
  function luminance(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function finite3(c) {
    return Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]);
  }

  /* ---------------- 场景构建 ---------------- */
  function buildScene(input) {
    if (!input || !Array.isArray(input.positions) || !Array.isArray(input.faces)) {
      throw new Error('JSON 需含 positions 与 faces 数组');
    }
    var positions = input.positions.map(function (p) {
      if (!Array.isArray(p) || p.length !== 3) throw new Error('positions 元素须为 [x,y,z]');
      return [+p[0], +p[1], +p[2]];
    });
    if (input.faces.length > MAX_TRIANGLES) {
      throw new Error('三角形数量超过上限 ' + MAX_TRIANGLES);
    }

    var faces = [];
    var lights = []; // 面索引
    var lightWeights = [];
    var ignoredZeroArea = 0;
    var emissiveCount = 0;

    input.faces.forEach(function (f, fi) {
      if (!Array.isArray(f.v) || f.v.length !== 3) throw new Error('face #' + fi + ' 的 v 须为 3 个顶点索引');
      var rho = f.rho || [0, 0, 0];
      var emission = f.emission || [0, 0, 0];
      for (var k = 0; k < 3; k++) {
        if (!(rho[k] >= 0 && rho[k] <= 1)) throw new Error('face #' + fi + ' 的 rho 分量须在 [0,1]');
        if (!(emission[k] >= 0)) throw new Error('face #' + fi + ' 的 emission 须非负');
      }
      var v0 = positions[f.v[0]], v1 = positions[f.v[1]], v2 = positions[f.v[2]];
      if (!v0 || !v1 || !v2) throw new Error('face #' + fi + ' 顶点索引越界');
      var e1 = vsub(v1, v0), e2 = vsub(v2, v0);
      var cr = vcross(e1, e2);
      var area = 0.5 * vlen(cr);
      var lum = luminance(emission);
      if (lum > 0) emissiveCount++;
      if (area < MIN_AREA) {
        ignoredZeroArea++; // 零面积面:不参与求交与灯采样,只计数
        return;
      }
      var face = {
        v0: v0, e1: e1, e2: e2,
        normal: vnorm(cr), // 绕序法线(不翻转),发光只向该侧
        area: area,
        rho: [rho[0], rho[1], rho[2]],
        emission: [emission[0], emission[1], emission[2]],
        isLight: lum > 0,
        selectProb: 0
      };
      if (face.isLight) {
        lights.push(faces.length);
        lightWeights.push(area * lum);
      }
      faces.push(face);
    });

    if (emissiveCount > MAX_LIGHTS) {
      throw new Error('发光面数量超过上限 ' + MAX_LIGHTS);
    }

    var totalW = 0;
    lightWeights.forEach(function (w) { totalW += w; });
    var cdf = [];
    lights.forEach(function (fi, i) {
      var p = totalW > 0 ? lightWeights[i] / totalW : 0;
      faces[fi].selectProb = p;
      cdf.push((i > 0 ? cdf[i - 1] : 0) + p);
    });

    var scene = {
      faces: faces,
      lights: lights,
      lightCdf: cdf,
      ignoredZeroArea: ignoredZeroArea,
      bvh: buildBvh(faces),
      camera: input.camera || null,
      width: input.width || 64,
      height: input.height || 64,
      probe: input.probe || null
    };
    return scene;
  }

  /* ---------------- BVH(自实现,2000 三角形足够) ---------------- */
  function faceBounds(f) {
    var p0 = f.v0, p1 = vadd(f.v0, f.e1), p2 = vadd(f.v0, f.e2);
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    [p0, p1, p2].forEach(function (p) {
      for (var k = 0; k < 3; k++) {
        if (p[k] < mn[k]) mn[k] = p[k];
        if (p[k] > mx[k]) mx[k] = p[k];
      }
    });
    return { mn: mn, mx: mx };
  }

  function buildBvh(faces) {
    if (faces.length === 0) return null;
    var bounds = faces.map(faceBounds);
    var indices = faces.map(function (_, i) { return i; });
    var nodes = [];
    function build(list) {
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      list.forEach(function (i) {
        for (var k = 0; k < 3; k++) {
          if (bounds[i].mn[k] < mn[k]) mn[k] = bounds[i].mn[k];
          if (bounds[i].mx[k] > mx[k]) mx[k] = bounds[i].mx[k];
        }
      });
      var node = { mn: mn, mx: mx, left: -1, right: -1, items: null };
      var id = nodes.length;
      nodes.push(node);
      if (list.length <= 4) {
        node.items = list;
        return id;
      }
      var ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
      var axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : (ext[1] >= ext[2] ? 1 : 2);
      list.sort(function (a, b) {
        var ca = 0.5 * (bounds[a].mn[axis] + bounds[a].mx[axis]);
        var cb = 0.5 * (bounds[b].mn[axis] + bounds[b].mx[axis]);
        return ca - cb;
      });
      var mid = list.length >> 1;
      node.left = build(list.slice(0, mid));
      node.right = build(list.slice(mid));
      return id;
    }
    build(indices);
    return { nodes: nodes, root: 0 };
  }

  function aabbHit(mn, mx, ro, invD, tMax) {
    for (var k = 0; k < 3; k++) {
      var t0 = (mn[k] - ro[k]) * invD[k];
      var t1 = (mx[k] - ro[k]) * invD[k];
      if (t0 > t1) { var tmp = t0; t0 = t1; t1 = tmp; }
      if (t1 < tMax) tMax = t1;
      if (t0 > 0 && t0 > tMax) return false;
      if (tMax < 0) return false;
    }
    return true;
  }

  /* Möller–Trumbore */
  function triHit(f, ro, rd, tMin, tMax) {
    var p = vcross(rd, f.e2);
    var det = vdot(f.e1, p);
    if (det > -1e-15 && det < 1e-15) return -1;
    var inv = 1 / det;
    var s = vsub(ro, f.v0);
    var u = vdot(s, p) * inv;
    if (u < -1e-12 || u > 1 + 1e-12) return -1;
    var q = vcross(s, f.e1);
    var v = vdot(rd, q) * inv;
    if (v < -1e-12 || u + v > 1 + 1e-12) return -1;
    var t = vdot(f.e2, q) * inv;
    return (t > tMin && t < tMax) ? t : -1;
  }

  function intersect(scene, ro, rd, tMax) {
    tMax = tMax === undefined ? Infinity : tMax;
    var bvh = scene.bvh;
    if (!bvh) return null;
    var invD = [1 / rd[0], 1 / rd[1], 1 / rd[2]];
    var best = tMax, bestFace = -1;
    var stack = [bvh.root];
    while (stack.length) {
      var node = bvh.nodes[stack.pop()];
      if (!aabbHit(node.mn, node.mx, ro, invD, best)) continue;
      if (node.items) {
        for (var i = 0; i < node.items.length; i++) {
          var fi = node.items[i];
          var t = triHit(scene.faces[fi], ro, rd, 1e-9, best);
          if (t > 0) { best = t; bestFace = fi; }
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return bestFace >= 0 ? { t: best, fi: bestFace } : null;
  }

  function occluded(scene, ro, rd, maxDist) {
    return intersect(scene, ro, rd, maxDist) !== null;
  }

  /* ---------------- 采样 ---------------- */
  function cosineSample(n, r1, r2) {
    // 构造正交基
    var a = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    var t1 = vnorm(vcross(a, n));
    var t2 = vcross(n, t1);
    var r = Math.sqrt(r1);
    var phi = 2 * PI * r2;
    var x = r * Math.cos(phi), y = r * Math.sin(phi);
    var z = Math.sqrt(Math.max(0, 1 - r1));
    return {
      dir: [
        t1[0] * x + t2[0] * y + n[0] * z,
        t1[1] * x + t2[1] * y + n[1] * z,
        t1[2] * x + t2[2] * y + n[2] * z
      ],
      cos: z
    };
  }

  function pickLight(scene, r) {
    var cdf = scene.lightCdf;
    var lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* 在指定点上对灯做一次直接采样,返回贡献(不含 throughput),
   * 或返回 null(背面/零距离/被遮挡)。mode 为 'mis' 时套用幂启发式。 */
  function sampleLightContrib(scene, P, n, rho, rng, mode, stats) {
    var rPick = rng(), r1 = rng(), r2 = rng();
    var li = pickLight(scene, rPick);
    if (stats) stats.lightPicks[li]++;
    var lf = scene.faces[scene.lights[li]];
    var su = Math.sqrt(r1);
    var b1 = su * (1 - r2), b2 = su * r2;
    var lp = [
      lf.v0[0] + lf.e1[0] * b1 + lf.e2[0] * b2,
      lf.v0[1] + lf.e1[1] * b1 + lf.e2[1] * b2,
      lf.v0[2] + lf.e1[2] * b1 + lf.e2[2] * b2
    ];
    var d = vsub(lp, P);
    var dist2 = vdot(d, d);
    if (dist2 <= 0) return null;
    var dist = Math.sqrt(dist2);
    var wi = [d[0] / dist, d[1] / dist, d[2] / dist];
    var cosS = vdot(n, wi);
    var cosL = -vdot(wi, lf.normal); // 绕序法线一侧才发光
    if (cosS <= 0 || cosL <= 0) return null;
    var pdfSA = (lf.selectProb / lf.area) * dist2 / cosL; // 面积 PDF → 立体角 PDF
    if (!(pdfSA > 0) || !Number.isFinite(pdfSA)) return null;
    var w = 1;
    if (mode === 'mis') {
      var q = cosS / PI; // 该方向的余弦半球 PDF(立体角)
      w = (pdfSA * pdfSA) / (pdfSA * pdfSA + q * q);
    }
    // 阴影射线:起点偏移 1e-5,终点前留同样裕量
    var ro = vadd(P, vscale(wi, RAY_OFFSET));
    if (occluded(scene, ro, wi, dist - 2 * RAY_OFFSET)) return null;
    var g = cosS / pdfSA; // = cosS * cosL / dist2 / (selectProb/area)
    return [
      rho[0] / PI * lf.emission[0] * g * w,
      rho[1] / PI * lf.emission[1] * g * w,
      rho[2] / PI * lf.emission[2] * g * w
    ];
  }

  /* ---------------- 路径追踪 ----------------
   * mode: 'brdf' | 'light' | 'mis'
   * maxDepth: 最多漫反射散射次数(0 只看灯),上限 8 */
  function tracePath(scene, ro, rd, rng, mode, maxDepth, stats) {
    var L = [0, 0, 0];
    var T = [1, 1, 1];
    var prevBrdfPdf = 0; // 上一顶点处 BRDF 方向 PDF(立体角)
    var scatters = 0;
    var firstHit = true;
    var rayO = ro, rayD = rd;

    for (var iter = 0; iter < 64; iter++) {
      var hit = intersect(scene, rayO, rayD);
      if (!hit) break; // 环境黑色
      var f = scene.faces[hit.fi];

      if (f.isLight) {
        var cosLhit = -vdot(rayD, f.normal);
        if (cosLhit > 0) { // 只向绕序法线正半球发光
          if (firstHit || mode === 'brdf') {
            L[0] += T[0] * f.emission[0];
            L[1] += T[1] * f.emission[1];
            L[2] += T[2] * f.emission[2];
          } else if (mode === 'mis') {
            var p = prevBrdfPdf;
            var q = f.selectProb * (1 / f.area) * (hit.t * hit.t) / cosLhit;
            var w = (p * p) / (p * p + q * q);
            L[0] += T[0] * f.emission[0] * w;
            L[1] += T[1] * f.emission[1] * w;
            L[2] += T[2] * f.emission[2] * w;
          }
          // mode === 'light':BRDF 碰灯不累计
        }
        break; // 灯面吸收路径
      }

      // 漫反射面:法线朝向入射射线来源一侧
      var n = f.normal;
      if (vdot(rayD, n) > 0) n = [-n[0], -n[1], -n[2]];
      if (scatters >= maxDepth) break;
      var P = [rayO[0] + rayD[0] * hit.t, rayO[1] + rayD[1] * hit.t, rayO[2] + rayD[2] * hit.t];

      // 直接光采样(纯灯光与 MIS 模式)
      if (mode !== 'brdf' && scene.lights.length > 0) {
        var c = sampleLightContrib(scene, P, n, f.rho, rng, mode, stats);
        if (c) {
          L[0] += T[0] * c[0];
          L[1] += T[1] * c[1];
          L[2] += T[2] * c[2];
        }
      }

      // BRDF 散射
      scatters++;
      if (scatters > 3) { // 第 3 次散射后进入俄罗斯轮盘
        var surv = Math.max(T[0], T[1], T[2]);
        surv = surv < 0.05 ? 0.05 : (surv > 0.95 ? 0.95 : surv);
        if (rng() >= surv) break;
        T[0] /= surv; T[1] /= surv; T[2] /= surv;
      }
      var s = cosineSample(n, rng(), rng());
      var pdf = s.cos / PI;
      // throughput *= (rho/pi)*cos/pdf = rho
      T[0] *= f.rho[0]; T[1] *= f.rho[1]; T[2] *= f.rho[2];
      prevBrdfPdf = pdf;
      rayO = vadd(P, vscale(s.dir, RAY_OFFSET));
      rayD = s.dir;
      firstHit = false;
    }

    if (!finite3(L)) return [0, 0, 0]; // 黑场景/零面积等异常路径不产生非法值
    return L;
  }

  /* ---------------- 相机 ---------------- */
  function makeCamera(cam, width, height) {
    var origin = cam.origin.slice();
    var fwd = vnorm(vsub(cam.look_at, origin));
    var right = vnorm(vcross(fwd, cam.up));
    var up = vcross(right, fwd); // 右手系
    var halfH = Math.tan((cam.fov_y * PI / 180) / 2);
    var halfW = halfH * (width / height);
    return { origin: origin, fwd: fwd, right: right, up: up, halfW: halfW, halfH: halfH };
  }

  function cameraRay(camera, width, height, px, py, rj1, rj2) {
    var x = ((px + rj1) / width) * 2 - 1;
    var y = 1 - ((py + rj2) / height) * 2; // 行优先,首行为顶部
    var d = vadd(camera.fwd,
      vadd(vscale(camera.right, x * camera.halfW), vscale(camera.up, y * camera.halfH)));
    return vnorm(d);
  }

  /* ---------------- 渲染器(可分批、可暂停续算) ----------------
   * 状态与分批无关:样本 (pixel, sample) 的随机流固定,
   * 任意切分批次累加结果与一次算完逐比特一致。 */
  function createRender(scene, opts) {
    var width = scene.width, height = scene.height;
    var npix = width * height;
    return {
      scene: scene,
      mode: opts.mode,
      maxDepth: Math.min(opts.maxDepth === undefined ? MAX_DEPTH_LIMIT : opts.maxDepth, MAX_DEPTH_LIMIT),
      seed: opts.seed >>> 0,
      targetSpp: opts.spp,
      width: width,
      height: height,
      sum: new Float64Array(npix * 3),
      sumSq: new Float64Array(npix), // 每像素样本亮度平方和(方差用)
      count: new Float64Array(npix),
      nextSample: 0, // 下一个待渲染样本序号(全图逐样本推进)
      nextPixel: 0,
      stats: {
        lightPicks: scene.lights.map(function () { return 0; }),
        completedPaths: 0,
        ignoredZeroArea: scene.ignoredZeroArea
      },
      done: false
    };
  }

  /* 渲染一个样本;供 UI 分批调用与 Node 测试调用 */
  function renderSample(state, pixelIndex, sampleIndex) {
    var scene = state.scene;
    var width = state.width, height = state.height;
    var px = pixelIndex % width;
    var py = (pixelIndex / width) | 0;
    var rng = makeRng(state.seed, pixelIndex, sampleIndex);
    var cam = state._camera || (state._camera = makeCamera(scene.camera, width, height));
    var dir = cameraRay(cam, width, height, px, py, rng(), rng());
    var L = tracePath(scene, cam.origin, dir, rng, state.mode, state.maxDepth, state.stats);
    if (!finite3(L)) L = [0, 0, 0];
    var o = pixelIndex * 3;
    state.sum[o] += L[0]; state.sum[o + 1] += L[1]; state.sum[o + 2] += L[2];
    var lum = luminance(L);
    state.sumSq[pixelIndex] += lum * lum;
    state.count[pixelIndex] += 1;
    state.stats.completedPaths++;
  }

  /* 推进渲染,最多耗时 budgetMs;返回是否完成 */
  function renderBatch(state, budgetMs) {
    var deadline = Date.now() + (budgetMs || 50);
    var npix = state.width * state.height;
    var sinceCheck = 0;
    while (state.nextSample < state.targetSpp) {
      renderSample(state, state.nextPixel, state.nextSample);
      state.nextPixel++;
      if (state.nextPixel >= npix) {
        state.nextPixel = 0;
        state.nextSample++;
      }
      if (++sinceCheck >= 256) {
        sinceCheck = 0;
        if (Date.now() >= deadline) break;
      }
    }
    state.done = state.nextSample >= state.targetSpp;
    return state.done;
  }

  /* 当前均值与方差(亮度样本方差,n>1 时用无偏估计) */
  function resultArrays(state) {
    var npix = state.width * state.height;
    var rgb = new Float64Array(npix * 3);
    var variance = new Float64Array(npix);
    for (var i = 0; i < npix; i++) {
      var n = state.count[i];
      if (n > 0) {
        rgb[i * 3] = state.sum[i * 3] / n;
        rgb[i * 3 + 1] = state.sum[i * 3 + 1] / n;
        rgb[i * 3 + 2] = state.sum[i * 3 + 2] / n;
      }
      if (n > 1) {
        var mean = 0;
        // 由 sum/sumSq 推亮度均值
        var lumMean = (0.2126 * state.sum[i * 3] + 0.7152 * state.sum[i * 3 + 1] + 0.0722 * state.sum[i * 3 + 2]) / n;
        mean = lumMean;
        var v = (state.sumSq[i] - n * mean * mean) / (n - 1);
        variance[i] = v > 0 && Number.isFinite(v) ? v : 0;
      }
    }
    return { rgb: rgb, variance: variance };
  }

  /* ---------------- 直接光探针 ----------------
   * 只估计无额外反弹的直接光;样本数与种子可指定,流独立于渲染。 */
  function probeDirect(scene, point, normal, rho, nSamples, seed, stats) {
    var n = vnorm(normal);
    var acc = [0, 0, 0];
    if (scene.lights.length === 0 || nSamples <= 0) {
      return { rgb: acc, samples: 0 };
    }
    for (var i = 0; i < nSamples; i++) {
      var rng = makeRng((seed >>> 0) ^ 0x51ed270b, 0, i);
      var c = sampleLightContrib(scene, point, n, rho, rng, 'light', stats);
      if (c && finite3(c)) {
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
    }
    return {
      rgb: [acc[0] / nSamples, acc[1] / nSamples, acc[2] / nSamples],
      samples: nSamples
    };
  }

  /* ---------------- 色调映射与 sRGB(PNG 用) ---------------- */
  function tonemapChannel(l) {
    var x = l / (1 + l); // L/(1+L),不做其他色调映射
    x = clamp01(x);
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }

  function rgbToSrgb8(rgb, width, height) {
    var out = new Uint8ClampedArray(width * height * 4);
    for (var i = 0; i < width * height; i++) {
      for (var k = 0; k < 3; k++) {
        var v = rgb[i * 3 + k];
        if (!Number.isFinite(v)) v = 0;
        out[i * 4 + k] = Math.round(clamp01(tonemapChannel(v)) * 255);
      }
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  var API = {
    RAY_OFFSET: RAY_OFFSET,
    MAX_DEPTH_LIMIT: MAX_DEPTH_LIMIT,
    MAX_TRIANGLES: MAX_TRIANGLES,
    MAX_LIGHTS: MAX_LIGHTS,
    makeRng: makeRng,
    buildScene: buildScene,
    intersect: intersect,
    tracePath: tracePath,
    createRender: createRender,
    renderSample: renderSample,
    renderBatch: renderBatch,
    resultArrays: resultArrays,
    probeDirect: probeDirect,
    makeCamera: makeCamera,
    cameraRay: cameraRay,
    luminance: luminance,
    rgbToSrgb8: rgbToSrgb8,
    tonemapChannel: tonemapChannel
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  g.MisEngine = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
