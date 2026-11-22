/*
 * 无边界植被投放内核
 * ==================
 *
 * 任意窗口的烘焙结果只由配置与坐标决定，与先打开哪个区无关。
 * 把整窗拆成分块分别烘焙再合并，必须与整窗一次烘焙完全一致。
 *
 * 世界约定（samples/biome-spawn.json 的 rules）：
 *  - 窗口 [x,y,w,h] 为半开格区；起点在正负 100 万格内，单边最多 1024 格。
 *  - 每格边长 256 个定点单位，坐标可为负。每层每格最多一个候选。
 *  - 层：树 = 0，草 = 1。每层最多 8 种物种，权重为 0..65535 的整数。
 *  - patches 为最多 64 个半开矩形，后项覆盖前项，其余格用 base。
 *  - h(seed,x,y,layer,salt) 为 32 位无符号哈希：
 *      v = seed ^ imul(x,73856093) ^ imul(y,19349663)
 *            ^ imul(layer+1,83492791) ^ imul(salt+1,2654435761)
 *      v = imul(v ^ (v>>>16), 2246822507)
 *      v = imul(v ^ (v>>>13), 3266489909)
 *      h = (v ^ (v>>>16)) >>> 0
 *  - salt 0：对总权重取余，按 species 顺序落入半开权重段；总权重 0 则无候选。
 *  - salt 1 / 2：对 256 取余，得到格内定点偏移。
 *  - salt 3：排序键，较大者排前；同值按格 y、x 较小者排前。
 *  - 半径单位为 1/256 格，范围 1..8192。
 *  - 淘汰判定：距离平方严格小于两者较大半径的平方。距离恰等半径时保留。
 *  - 树层：候选只要遇到任意“更高排序”的树即淘汰——即便那棵树本身也被淘汰。
 *  - 草层：先避开已保留的树；未避开树的草再在“剩余草候选”之间按同样规则
 *    竞争（被淘汰者仍能挡住更低者）。
 *  - 只导出请求窗口内的幸存者；窗口外的候选仍参与判断。
 *
 * 结构说明：本文件定义工厂函数 VegetationModule，调用后返回 API 对象。
 * 页面会用 VegetationModule.toString() 把同一份源码注入 Worker，
 * 因此函数体内不得引用外部变量，也不得依赖 DOM 或 Node API。
 */
function VegetationModule() {
  'use strict';

  var LAYER_TREE = 0;
  var LAYER_GRASS = 1;
  var LAYER_COUNT = 2;
  var FIXED = 256;

  var MAX_WINDOW_SIDE = 1024;
  var MAX_COORD = 1000000;
  var MAX_PATCHES = 64;
  var MAX_SPECIES = 8;
  var MAX_RADIUS = 8192;      // 1/256 格
  var MAX_WEIGHT = 65535;

  /* ============================== 哈希 ============================== */

  function hash(seed, x, y, layer, salt) {
    var v = (seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^
             Math.imul(layer + 1, 83492791) ^ Math.imul(salt + 1, 2654435761)) >>> 0;
    v = Math.imul(v ^ (v >>> 16), 2246822507) >>> 0;
    v = Math.imul(v ^ (v >>> 13), 3266489909) >>> 0;
    return (v ^ (v >>> 16)) >>> 0;
  }

  /* ============================== 校验 ============================== */

  function isInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  function configError(errs) {
    var e = new Error('配置无效：\n' + errs.join('\n'));
    e.name = 'ConfigError';
    e.validation = errs;
    return e;
  }

  function checkWeights(arr, n, label, fail) {
    var out = new Array(n).fill(0);
    if (!Array.isArray(arr)) { fail(label + ' 必须是权重数组'); return out; }
    if (arr.length !== n) fail(label + ' 的权重项数应为 ' + n + '，实际 ' + arr.length);
    for (var i = 0; i < Math.min(n, arr.length); i++) {
      var w = arr[i];
      if (!isInt(w) || w < 0 || w > MAX_WEIGHT) {
        fail(label + '[' + i + '] 必须是 0..' + MAX_WEIGHT + ' 的整数');
      } else {
        out[i] = w;
      }
    }
    return out;
  }

  function validateWindow(w, fail) {
    if (!Array.isArray(w) || w.length !== 4 || !w.every(isInt)) {
      fail('window 必须是 [x,y,w,h] 整数数组');
      return;
    }
    if (w[2] <= 0 || w[3] <= 0 || w[2] > MAX_WINDOW_SIDE || w[3] > MAX_WINDOW_SIDE) {
      fail('window 的宽高必须在 1..' + MAX_WINDOW_SIDE + ' 格之间');
    }
    if (Math.abs(w[0]) > MAX_COORD || Math.abs(w[1]) > MAX_COORD) {
      fail('window 的起点必须在正负 ' + MAX_COORD + ' 格以内');
    }
  }

  function normalizeConfig(raw) {
    if (!raw || typeof raw !== 'object') throw configError(['配置必须是一个对象']);
    var errs = [];
    function fail(m) { errs.push(m); }

    if (!isInt(raw.seed)) fail('seed 必须是整数');
    if (raw.rules !== undefined && !Array.isArray(raw.rules)) fail('rules 必须是字符串数组');

    var species = raw.species;
    if (!Array.isArray(species)) { fail('species 必须是按层的数组'); species = []; }
    var specByLayer = [];
    for (var L = 0; L < LAYER_COUNT; L++) {
      var arr = species[L];
      if (!Array.isArray(arr)) { fail('species[' + L + '] 必须是数组'); arr = []; }
      if (arr.length > MAX_SPECIES) fail('species[' + L + '] 最多 ' + MAX_SPECIES + ' 种');
      var list = [];
      for (var i = 0; i < arr.length; i++) {
        var sp = arr[i];
        var path = 'species[' + L + '][' + i + ']';
        if (!sp || typeof sp !== 'object') { fail(path + ' 必须是对象'); continue; }
        if (typeof sp.id !== 'string' || sp.id.length === 0) {
          fail(path + '.id 必须是非空字符串');
        }
        if (!isInt(sp.radius) || sp.radius < 1 || sp.radius > MAX_RADIUS) {
          fail(path + '.radius 必须是 1..' + MAX_RADIUS + ' 的整数（1/256 格）');
        }
        list.push({ id: typeof sp.id === 'string' ? sp.id : String(sp.id), radius: sp.radius });
      }
      specByLayer.push(list);
    }

    var base = raw.base;
    if (!Array.isArray(base)) { fail('base 必须是按层的权重数组'); base = []; }
    var baseByLayer = [];
    for (var Lb = 0; Lb < LAYER_COUNT; Lb++) {
      baseByLayer.push(checkWeights(base[Lb], specByLayer[Lb].length, 'base[' + Lb + ']', fail));
    }

    var patches = raw.patches === undefined ? [] : raw.patches;
    if (!Array.isArray(patches)) { fail('patches 必须是数组'); patches = []; }
    if (patches.length > MAX_PATCHES) fail('patches 最多 ' + MAX_PATCHES + ' 项');
    var normPatches = [];
    for (var p = 0; p < patches.length; p++) {
      var pt = patches[p];
      var pp = 'patches[' + p + ']';
      if (!pt || typeof pt !== 'object') { fail(pp + ' 必须是对象'); continue; }
      var rect = pt.rect;
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(isInt)) {
        fail(pp + '.rect 必须是 [x,y,w,h] 整数数组');
        continue;
      }
      if (rect[2] <= 0 || rect[3] <= 0) fail(pp + '.rect 的宽高必须为正');
      if (pt.weights !== undefined && !Array.isArray(pt.weights)) {
        fail(pp + '.weights 必须是按层的权重数组');
        continue;
      }
      var pw = [];
      for (var Lp = 0; Lp < LAYER_COUNT; Lp++) {
        var lw = pt.weights === undefined ? undefined : pt.weights[Lp];
        if (lw === undefined || lw === null) {
          pw.push(null);
        } else {
          pw.push(checkWeights(lw, specByLayer[Lp].length, pp + '.weights[' + Lp + ']', fail));
        }
      }
      normPatches.push({ rect: rect.slice(), weights: pw });
    }

    if (raw.window !== undefined) validateWindow(raw.window, fail);

    if (errs.length) throw configError(errs);

    return {
      seed: raw.seed,
      rules: Array.isArray(raw.rules) ? raw.rules.slice() : [],
      species: specByLayer,
      base: baseByLayer,
      patches: normPatches,
      window: raw.window ? raw.window.slice() : [0, 0, 1, 1]
    };
  }

  /* ======================= 权重与单格候选 ======================= */

  // patches 后项覆盖前项；未给出该层权重的 patch 不影响该层
  function weightsAt(cfg, layer, x, y) {
    var ps = cfg.patches;
    for (var i = ps.length - 1; i >= 0; i--) {
      var p = ps[i], r = p.rect;
      if (x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]) {
        var w = p.weights[layer];
        if (w) return w;
      }
    }
    return cfg.base[layer];
  }

  // 返回 null 或 {layer,x,y,px,py,species,speciesId,radius,rank}
  function candidateAt(cfg, layer, x, y) {
    var weights = weightsAt(cfg, layer, x, y);
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return null;
    var pick = hash(cfg.seed, x, y, layer, 0) % total;
    var acc = 0, si = -1;
    for (i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (pick < acc) { si = i; break; }
    }
    if (si < 0) return null;
    var sp = cfg.species[layer][si];
    if (!sp) return null;
    return {
      layer: layer, x: x, y: y,
      px: x * FIXED + (hash(cfg.seed, x, y, layer, 1) % FIXED),
      py: y * FIXED + (hash(cfg.seed, x, y, layer, 2) % FIXED),
      species: si, speciesId: sp.id, radius: sp.radius,
      rank: hash(cfg.seed, x, y, layer, 3)
    };
  }

  // rank 大者排前；同 rank 按 y、x 小者排前。负数表示 a 在前。
  function compareRank(a, b) {
    if (a.rank !== b.rank) return a.rank > b.rank ? -1 : 1;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  }

  // 距离平方严格小于较大半径平方 → 冲突
  function conflicts(a, b) {
    var r = a.radius > b.radius ? a.radius : b.radius;
    var dx = a.px - b.px, dy = a.py - b.py;
    return dx * dx + dy * dy < r * r;
  }

  function maxRadiusUnits(cfg, layer) {
    var m = 0, sp = cfg.species[layer];
    for (var i = 0; i < sp.length; i++) if (sp[i].radius > m) m = sp[i].radius;
    return m;
  }

  /* ================= 区间候选（类型数组） ================= */

  function Region(x0, y0, x1, y1) {
    this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
    this.w = x1 - x0; this.h = y1 - y0;
  }

  /*
   * 生成区间内全部候选。tidx 为相对区域左上角的扁平格号（行优先）。
   * 返回 {n, tidx, px, py, rad, sp, rank, reg, layer}
   */
  function buildLayer(cfg, layer, reg) {
    var w = reg.w, h = reg.h, cap = w * h;
    var tidx = new Int32Array(cap);
    var px = new Int32Array(cap);
    var py = new Int32Array(cap);
    var rad = new Int32Array(cap);
    var sp = new Int16Array(cap);
    var rank = new Uint32Array(cap);
    var n = 0;
    var seed = cfg.seed;
    var specs = cfg.species[layer];
    var ps = cfg.patches;
    var baseW = cfg.base[layer];
    for (var yy = 0; yy < h; yy++) {
      var ty = reg.y0 + yy;
      var rowOff = yy * w;
      for (var xx = 0; xx < w; xx++) {
        var tx = reg.x0 + xx;
        var weights = baseW;
        for (var pi = ps.length - 1; pi >= 0; pi--) {
          var pr = ps[pi].rect;
          if (tx >= pr[0] && ty >= pr[1] && tx < pr[0] + pr[2] && ty < pr[1] + pr[3]) {
            var pw = ps[pi].weights[layer];
            if (pw) { weights = pw; break; }
          }
        }
        var total = 0, k;
        for (k = 0; k < weights.length; k++) total += weights[k];
        if (total <= 0) continue;
        var pick = hash(seed, tx, ty, layer, 0) % total;
        var acc = 0, si = -1;
        for (k = 0; k < weights.length; k++) {
          acc += weights[k];
          if (pick < acc) { si = k; break; }
        }
        if (si < 0) continue;
        tidx[n] = rowOff + xx;
        px[n] = tx * FIXED + (hash(seed, tx, ty, layer, 1) % FIXED);
        py[n] = ty * FIXED + (hash(seed, tx, ty, layer, 2) % FIXED);
        rad[n] = specs[si].radius;
        sp[n] = si;
        rank[n] = hash(seed, tx, ty, layer, 3);
        n++;
      }
    }
    return { n: n, tidx: tidx, px: px, py: py, rad: rad, sp: sp, rank: rank, reg: reg, layer: layer };
  }

  /*
   * 稳定 LSD 基数排序，按 ~rank 升序（即 rank 降序）。
   * 输入顺序为 y 升、x 升，稳定排序保留同 rank 的 y/x 次序。
   */
  function sortDescending(lyr) {
    var n = lyr.n;
    var ord = new Int32Array(n);
    var i;
    for (i = 0; i < n; i++) ord[i] = i;
    if (n < 2) return ord;
    var dst = new Int32Array(n);
    var rank = lyr.rank;
    var count = new Int32Array(257);
    for (var shift = 0; shift < 32; shift += 8) {
      count.fill(0);
      var a, v, key;
      for (a = 0; a < n; a++) {
        key = (~rank[ord[a]]) >>> 0;
        count[((key >>> shift) & 255) + 1]++;
      }
      for (var b = 1; b < 257; b++) count[b] += count[b - 1];
      for (var c = 0; c < n; c++) {
        v = ord[c];
        key = (~rank[v]) >>> 0;
        dst[count[(key >>> shift) & 255]++] = v;
      }
      var t = ord; ord = dst; dst = t;
    }
    return ord;
  }

  /* ------------------- 空间索引（绝对格坐标） ------------------- */

  /*
   * 以绝对格坐标为键的桶索引，桶边长 C 格。
   * 查询时扫描候选所在桶及其 3×3 邻居：只要冲突阈值 ≤ C 格，
   * 任何可能冲突的对方都落在 3×3 之内。
   */
  function SpatialIndex(ox, oy, wTiles, hTiles, C) {
    this.ox = ox; this.oy = oy;
    this.C = Math.max(1, C | 0);
    this.gw = Math.ceil(wTiles / this.C) + 1;
    this.gh = Math.ceil(hTiles / this.C) + 1;
    this.head = new Int32Array(this.gw * this.gh).fill(-1);
    this.next = null;
  }

  SpatialIndex.prototype.alloc = function (n) {
    this.next = new Int32Array(n).fill(-1);
    return this;
  };

  SpatialIndex.prototype.cx = function (ax) {
    return ((ax - this.ox) / this.C) | 0;
  };
  SpatialIndex.prototype.cy = function (ay) {
    return ((ay - this.oy) / this.C) | 0;
  };

  SpatialIndex.prototype.insert = function (idx, ax, ay) {
    var bx = this.cx(ax), by = this.cy(ay);
    if (bx < 0 || by < 0 || bx >= this.gw || by >= this.gh) return;
    var b = by * this.gw + bx;
    this.next[idx] = this.head[b];
    this.head[b] = idx;
  };

  /*
   * 查找与查询候选冲突的已插入项。
   *   ax, ay  查询候选的绝对格坐标
   *   x, y, r 查询候选的定点位置与半径（1/256 格）
   *   src     被索引的层数组（提供 px/py/rad/rank/tidx）；索引下标指向它
   * 返回冲突项的索引下标，或 -1。
   * wantBest 为真时返回排序最高者（rank 大者优先，同 rank 取绝对格号小者）。
   */
  function findConflict(index, ax, ay, x, y, r, src, wantBest) {
    var bx = index.cx(ax), by = index.cy(ay);
    var gw = index.gw, gh = index.gh;
    var best = -1, bestRank = 0, bestTidx = 0;
    for (var oy = -1; oy <= 1; oy++) {
      var ny = by + oy;
      if (ny < 0 || ny >= gh) continue;
      for (var ox = -1; ox <= 1; ox++) {
        var nx = bx + ox;
        if (nx < 0 || nx >= gw) continue;
        var j = index.head[ny * gw + nx];
        while (j !== -1) {
          var jr2 = src.rad[j];
          var rr = r > jr2 ? r : jr2;
          var dx = x - src.px[j], dy = y - src.py[j];
          if (dx * dx + dy * dy < rr * rr) {
            if (!wantBest) return j;
            var jr = src.rank[j], jt = src.tidx[j];
            if (best === -1 || jr > bestRank || (jr === bestRank && jt < bestTidx)) {
              best = j; bestRank = jr; bestTidx = jt;
            }
          }
          j = index.next[j];
        }
      }
    }
    return best;
  }

  // 走查某层候选 i 的绝对格坐标
  function absTile(lyr, i) {
    var reg = lyr.reg, w = reg.w, t = lyr.tidx[i];
    return { x: reg.x0 + (t % w), y: reg.y0 + ((t / w) | 0) };
  }

  /* ============================ 烘焙 ============================ */

  function normalizeWindow(w) {
    return { x: w[0], y: w[1], w: w[2], h: w[3] };
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function inside(x, y, win) {
    return x >= win.x && y >= win.y && x < win.x + win.w && y < win.y + win.h;
  }

  /*
   * 外扩量推导（tile）：
   *  Rt = ceil(树最大半径/256)，Rg = ceil(草最大半径/256)，Rb = max(Rt,Rg)。
   *  候选只在冲突阈值内互相影响，半径单位换算成格后，逐轴位移不超过该格数。
   *  - 窗口内草需要 Rb 内的“保留树”；这些草（窗口外扩 Rg 内）也需要正确判定
   *    是否被树挡住，故需要 Rb 内的保留树。保留树的 kept 只取决于 Rt 内更高
   *    排序的树（无论对方是否 kept）。故草的判定需要候选树覆盖到
   *    Rg（草竞争）+ Rb（树挡草）+ Rt（树判定）= Rt+Rg+Rb。
   *  - 草彼此竞争只需 Rg 内的草。
   *  - 树的判定本身只需 Rt，已被上式覆盖。
   *  因此 treePad = Rt+Rg+Rb+1，grassPad = Rg+1。
   */
  function padFor(cfg) {
    var Rt = Math.ceil(maxRadiusUnits(cfg, LAYER_TREE) / FIXED);
    var Rg = Math.ceil(maxRadiusUnits(cfg, LAYER_GRASS) / FIXED);
    var Rb = Rt > Rg ? Rt : Rg;
    return {
      Rt: Rt, Rg: Rg, Rb: Rb,
      tree: Rt + Rg + Rb + 1,
      grass: Rg + 1,
      treeCell: Math.max(1, Rt),
      grassCell: Math.max(1, Rg),
      blockCell: Math.max(1, Rb)
    };
  }

  function survivorObj(lyr, i) {
    var reg = lyr.reg, w = reg.w, t = lyr.tidx[i];
    return {
      layer: lyr.layer,
      x: reg.x0 + (t % w),
      y: reg.y0 + ((t / w) | 0),
      px: lyr.px[i], py: lyr.py[i],
      species: lyr.sp[i], radius: lyr.rad[i], rank: lyr.rank[i]
    };
  }

  function compareSurvivor(p, q) {
    if (p.layer !== q.layer) return p.layer - q.layer;
    if (p.y !== q.y) return p.y - q.y;
    return p.x - q.x;
  }

  function expand(win, pad) {
    return [win.x - pad, win.y - pad, win.w + pad * 2, win.h + pad * 2];
  }

  /*
   * 烘焙窗口。
   * opts:
   *   details       记录窗口内候选的去留，返回 Map<"layer:y:x", detail>
   *   shouldCancel  返回真则中止，抛出 name==='Cancelled'
   * 返回 {window, survivors, stats, details, elapsedMs}
   */
  function bake(cfg, win, opts) {
    opts = opts || {};
    var t0 = nowMs();
    var window = normalizeWindow(win || cfg.window);
    var pad = padFor(cfg);
    var shouldCancel = opts.shouldCancel || null;
    var wantDetails = !!opts.details;
    var details = wantDetails ? new Map() : null;

    function checkCancel() {
      if (shouldCancel && shouldCancel()) {
        var e = new Error('已取消');
        e.name = 'Cancelled';
        throw e;
      }
    }

    /* ---- 树层 ---- */
    var treeWin = expand(window, pad.tree);
    var treeReg = new Region(treeWin[0], treeWin[1], treeWin[0] + treeWin[2], treeWin[1] + treeWin[3]);
    var trees = buildLayer(cfg, LAYER_TREE, treeReg);
    checkCancel();
    var treeOrder = sortDescending(trees);
    var treeIdx = new SpatialIndex(treeReg.x0, treeReg.y0, treeReg.w, treeReg.h, pad.treeCell).alloc(trees.n);
    var keptTrees = new Int32Array(trees.n);
    var keptTreeCount = 0;
    var treeEliminated = 0;
    var treeEvicted = wantDetails ? new Int32Array(trees.n).fill(-1) : null;

    for (var oi = 0; oi < trees.n; oi++) {
      var i = treeOrder[oi];
      var ti0 = absTile(trees, i);
      var hit = findConflict(treeIdx, ti0.x, ti0.y, trees.px[i], trees.py[i], trees.rad[i], trees, wantDetails);
      if (hit === -1) {
        keptTrees[keptTreeCount++] = i;
      } else {
        treeEliminated++;
        if (treeEvicted) treeEvicted[i] = hit;
      }
      // 淘汰者仍进索引：更低排序的树也可能被它挡住
      treeIdx.insert(i, ti0.x, ti0.y);
      if ((oi & 16383) === 0) checkCancel();
    }
    checkCancel();
    if (wantDetails) {
      for (var di = 0; di < trees.n; di++) {
        var dt = absTile(trees, di);
        if (!inside(dt.x, dt.y, window)) continue;
        var dd = detailOf(trees, di);
        dd.kept = treeEvicted[di] === -1;
        dd.reason = dd.kept ? null : 'tree';
        dd.blocker = dd.kept ? null : coincidentDet(trees, treeEvicted[di]);
        details.set('0:' + dt.y + ':' + dt.x, dd);
      }
    }

    /* ---- 草层 ---- */
    var grassWin = expand(window, pad.grass);
    var grassReg = new Region(grassWin[0], grassWin[1], grassWin[0] + grassWin[2], grassWin[1] + grassWin[3]);
    var grass = buildLayer(cfg, LAYER_GRASS, grassReg);
    checkCancel();

    // 已保留的树建立阻断索引：以树的绝对格坐标插入。
    // 网格覆盖树区域（含草区域），确保靠近草区域边缘、但在草区域外的树不会漏掉。
    var treeBlock = new SpatialIndex(treeReg.x0, treeReg.y0, treeReg.w, treeReg.h, pad.blockCell).alloc(trees.n);
    for (var kt = 0; kt < keptTreeCount; kt++) {
      var ti = keptTrees[kt];
      var tt = absTile(trees, ti);
      treeBlock.insert(ti, tt.x, tt.y);
    }

    var grassOrder = sortDescending(grass);
    var grassIdx = new SpatialIndex(grassReg.x0, grassReg.y0, grassReg.w, grassReg.h, pad.grassCell).alloc(grass.n);
    var keptGrass = new Int32Array(grass.n);
    var keptGrassCount = 0;
    var grassEliminated = 0;
    var grassTreeBlocked = 0;
    var grassEvicted = wantDetails ? new Int32Array(grass.n).fill(-1) : null;
    var grassByTree = wantDetails ? new Int32Array(grass.n).fill(-1) : null;

    for (var gj = 0; gj < grass.n; gj++) {
      var g = grassOrder[gj];
      var gt0 = absTile(grass, g);
      var tb = findConflict(treeBlock, gt0.x, gt0.y, grass.px[g], grass.py[g], grass.rad[g], trees, wantDetails);
      if (tb !== -1) {
        grassTreeBlocked++;
        if (grassByTree) grassByTree[g] = tb;
      } else {
        var gh = findConflict(grassIdx, gt0.x, gt0.y, grass.px[g], grass.py[g], grass.rad[g], grass, wantDetails);
        if (gh === -1) keptGrass[keptGrassCount++] = g;
        else { grassEliminated++; if (grassEvicted) grassEvicted[g] = gh; }
        // 未被树挡住的草都进索引，即便自身被淘汰，仍可挡住更低者
        grassIdx.insert(g, gt0.x, gt0.y);
      }
      if ((gj & 16383) === 0) checkCancel();
    }
    checkCancel();
    if (wantDetails) {
      for (var di2 = 0; di2 < grass.n; di2++) {
        var gt = absTile(grass, di2);
        if (!inside(gt.x, gt.y, window)) continue;
        var gd = detailOf(grass, di2);
        if (grassByTree[di2] !== -1) {
          gd.kept = false; gd.reason = 'tree';
          gd.blocker = coincidentDet(trees, grassByTree[di2]);
        } else if (grassEvicted[di2] !== -1) {
          gd.kept = false; gd.reason = 'grass';
          gd.blocker = coincidentDet(grass, grassEvicted[di2]);
        } else {
          gd.kept = true; gd.reason = null; gd.blocker = null;
        }
        details.set('1:' + gt.y + ':' + gt.x, gd);
      }
    }

    /* ---- 汇出窗口内幸存者 ---- */
    var out = [];
    for (var a = 0; a < keptTreeCount; a++) {
      var ca = keptTrees[a];
      var ta = absTile(trees, ca);
      if (inside(ta.x, ta.y, window)) out.push(survivorObj(trees, ca));
    }
    for (var b = 0; b < keptGrassCount; b++) {
      var cb = keptGrass[b];
      var tbx = absTile(grass, cb);
      if (inside(tbx.x, tbx.y, window)) out.push(survivorObj(grass, cb));
    }
    out.sort(compareSurvivor);

    return {
      window: [window.x, window.y, window.w, window.h],
      survivors: out,
      stats: {
        treeCandidates: trees.n,
        treeKeptTotal: keptTreeCount,
        treeEliminated: treeEliminated,
        grassCandidates: grass.n,
        grassKeptTotal: keptGrassCount,
        grassEliminated: grassEliminated,
        grassTreeBlocked: grassTreeBlocked,
        pad: pad
      },
      details: details,
      elapsedMs: nowMs() - t0
    };
  }

  function detailOf(lyr, i) {
    var t = absTile(lyr, i);
    return {
      layer: lyr.layer, x: t.x, y: t.y,
      px: lyr.px[i], py: lyr.py[i], radius: lyr.rad[i],
      species: lyr.sp[i], rank: lyr.rank[i]
    };
  }

  function coincidentDet(lyr, i) {
    return detailOf(lyr, i);
  }

  /* 点格查询：对 1×1 窗口烘焙并取出该格两层详情 */
  function queryTile(cfg, tx, ty) {
    var res = bake(cfg, [tx, ty, 1, 1], { details: true });
    return {
      x: tx, y: ty,
      tree: res.details.get('0:' + ty + ':' + tx) || null,
      grass: res.details.get('1:' + ty + ':' + tx) || null,
      weights: {
        tree: weightsAt(cfg, LAYER_TREE, tx, ty),
        grass: weightsAt(cfg, LAYER_GRASS, tx, ty)
      },
      elapsedMs: res.elapsedMs
    };
  }

  /* ============================ 导出 ============================ */

  var EXPORT_COLUMNS = ['layer', 'gx', 'gy', 'px', 'py', 'species'];

  function exportText(result, opts) {
    opts = opts || {};
    var delim = opts.delimiter === ',' ? ',' : '\t';
    var rows = result.survivors.slice().sort(compareSurvivor);
    var lines = [];
    if (opts.header) lines.push(EXPORT_COLUMNS.join(delim));
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      lines.push([c.layer, c.x, c.y, c.px, c.py, c.species].join(delim));
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  /* ============================ 合并分块 ============================ */

  // 合并多个窗口结果（如分块烘焙），按层/格去重后排序
  function mergeResults(parts) {
    var map = new Map();
    for (var p = 0; p < parts.length; p++) {
      var s = parts[p].survivors;
      for (var i = 0; i < s.length; i++) {
        var c = s[i];
        map.set(c.layer + ':' + c.y + ':' + c.x, c);
      }
    }
    var out = [];
    map.forEach(function (c) { out.push(c); });
    out.sort(compareSurvivor);
    var treeKept = 0, grassKept = 0;
    for (var k = 0; k < out.length; k++) {
      if (out[k].layer === LAYER_TREE) treeKept++; else grassKept++;
    }
    return { survivors: out, stats: { treeKept: treeKept, grassKept: grassKept } };
  }

  /* ============================ API ============================ */

  return {
    LAYER_TREE: LAYER_TREE, LAYER_GRASS: LAYER_GRASS, LAYER_COUNT: LAYER_COUNT,
    FIXED: FIXED,
    MAX_WINDOW_SIDE: MAX_WINDOW_SIDE, MAX_COORD: MAX_COORD,
    MAX_PATCHES: MAX_PATCHES, MAX_SPECIES: MAX_SPECIES,
    MAX_RADIUS: MAX_RADIUS, MAX_WEIGHT: MAX_WEIGHT,
    EXPORT_COLUMNS: EXPORT_COLUMNS,
    hash: hash,
    normalizeConfig: normalizeConfig,
    weightsAt: weightsAt,
    candidateAt: candidateAt,
    compareRank: compareRank,
    conflicts: conflicts,
    maxRadiusUnits: maxRadiusUnits,
    padFor: padFor,
    bake: bake,
    queryTile: queryTile,
    exportText: exportText,
    mergeResults: mergeResults,
    compareSurvivor: compareSurvivor
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = VegetationModule;
if (typeof self !== 'undefined') self.VegetationModule = VegetationModule;
