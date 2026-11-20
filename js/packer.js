/*
 * lightmap-mask-packer 核心引擎
 * 纯逻辑、无 DOM 依赖，浏览器与 Node 均可使用。
 * 所有遍历顺序均为显式确定顺序，不使用 Date/Math.random，
 * 同一输入与同一锁定条件必然产生相同结果。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LMP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_CHARTS = 64;
  var MAX_MASK_SIDE = 32;
  var MAX_ATLAS = 512;
  var DEFAULT_NODE_BUDGET = 100000;
  var REPORT_CELL_CAP = 24;

  function err(msg) { return new Error(msg); }

  // ---------- 解析与校验 ----------

  function parseInput(raw) {
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (!raw || typeof raw !== 'object') throw err('输入不是 JSON 对象');
    var atlasSize = raw.atlasSize;
    if (!Number.isInteger(atlasSize) || atlasSize < 1 || atlasSize > MAX_ATLAS)
      throw err('atlasSize 必须是 1..' + MAX_ATLAS + ' 的整数');
    var padding = raw.padding;
    if (!Number.isInteger(padding) || padding < 0 || padding > 4)
      throw err('padding 必须是 0..4 的整数');
    if (!Array.isArray(raw.charts) || raw.charts.length === 0)
      throw err('charts 为空');
    if (raw.charts.length > MAX_CHARTS)
      throw err('图块数量不能超过 ' + MAX_CHARTS + ' 块');

    var seenIds = Object.create(null);
    var charts = raw.charts.map(function (c, idx) {
      if (!c || typeof c !== 'object') throw err('第 ' + idx + ' 个图块不是对象');
      var id = String(c.id);
      if (seenIds[id]) throw err('图块 id 重复: ' + id);
      seenIds[id] = 1;
      if (!Array.isArray(c.mask) || c.mask.length === 0)
        throw err(id + ': mask 为空');
      var h = c.mask.length;
      var w = c.mask[0].length;
      if (w > MAX_MASK_SIDE || h > MAX_MASK_SIDE)
        throw err(id + ': 掩膜边长不能超过 ' + MAX_MASK_SIDE);
      var occ = [];
      for (var y = 0; y < h; y++) {
        var row = c.mask[y];
        if (typeof row !== 'string' || row.length !== w)
          throw err(id + ': 第 ' + y + ' 行掩膜长度不一致');
        for (var x = 0; x < w; x++) {
          var ch = row.charAt(x);
          if (ch === '#') occ.push([x, y]);
          else if (ch !== '.') throw err(id + ': 掩膜只能包含 # 与 .');
        }
      }
      if (occ.length === 0) throw err(id + ': 掩膜没有任何占用格');

      if (!Array.isArray(c.vertices) || c.vertices.length === 0)
        throw err(id + ': vertices 为空');
      var vertices = c.vertices.map(function (v, vi) {
        if (!Array.isArray(v) || v.length < 2 ||
          typeof v[0] !== 'number' || typeof v[1] !== 'number')
          throw err(id + ': 顶点 ' + vi + ' 不是二维数');
        return [v[0], v[1]];
      });
      if (!Array.isArray(c.triangles) || c.triangles.length === 0)
        throw err(id + ': triangles 为空');
      var triangles = c.triangles.map(function (t, ti) {
        if (!Array.isArray(t) || t.length !== 3 ||
          !Number.isInteger(t[0]) || !Number.isInteger(t[1]) || !Number.isInteger(t[2]))
          throw err(id + ': 三角形 ' + ti + ' 不是 3 个整数索引');
        t.forEach(function (vi) {
          if (vi < 0 || vi >= vertices.length)
            throw err(id + ': 三角形 ' + ti + ' 引用了不存在的顶点 ' + vi);
        });
        return [t[0], t[1], t[2]];
      });

      var placement = null;
      if (c.placement) {
        var p = c.placement;
        if (!Number.isInteger(p.x) || !Number.isInteger(p.y) ||
          (p.rotation !== 0 && p.rotation !== 90))
          throw err(id + ': placement 需要整数 x,y 且 rotation 为 0 或 90');
        placement = { x: p.x, y: p.y, rotation: p.rotation };
      }
      var locked = !!c.locked;
      if (locked && !placement) throw err(id + ': locked 图块必须提供 placement');

      return {
        index: idx, id: id, w: w, h: h, occ: occ,
        vertices: vertices, triangles: triangles,
        locked: locked, given: placement
      };
    });

    return { atlasSize: atlasSize, padding: padding, charts: charts };
  }

  // ---------- 几何变换 ----------

  // 旋转 90°（y 向下坐标系中的顺时针）：
  // 格子 (x,y) -> (h-1-y, x)；连续顶点 (x,y) -> (h-y, x)
  function rotateCell(x, y, h) { return [h - 1 - y, x]; }
  function rotatePoint(x, y, h) { return [h - y, x]; }

  // 计算某图块在 rotation(0/90) 下的占用格与补边格（相对旋转后包围框左上角）
  function buildVariant(chart, rotation, padding) {
    var r = rotation === 90 ? 1 : 0;
    var rw = r ? chart.h : chart.w;
    var rh = r ? chart.w : chart.h;
    var rotOcc = chart.occ.map(function (cell) {
      return r ? rotateCell(cell[0], cell[1], chart.h) : [cell[0], cell[1]];
    });
    // 切比雪夫距离 <= padding 的整数格膨胀（对占用格，而非包围框）
    var claimMap = Object.create(null);
    var claim = [];
    for (var i = 0; i < rotOcc.length; i++) {
      var cx = rotOcc[i][0], cy = rotOcc[i][1];
      for (var dy = -padding; dy <= padding; dy++) {
        for (var dx = -padding; dx <= padding; dx++) {
          var nx = cx + dx, ny = cy + dy;
          var key = nx + ',' + ny;
          if (!claimMap[key]) {
            claimMap[key] = true;
            claim.push([nx, ny]);
          }
        }
      }
    }
    claim.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    return {
      rotation: rotation, r: r, rw: rw, rh: rh,
      occ: rotOcc, claim: claim, claimCount: claim.length
    };
  }

  function buildVariants(chart, padding) {
    var v0 = buildVariant(chart, 0, padding);
    var v90 = buildVariant(chart, 90, padding);
    var variants = [v0];
    // 旋转后形状完全相同则去重，保证确定性且避免重复搜索
    var sig0 = signature(v0.claim);
    if (signature(v90.claim) !== sig0) variants.push(v90);
    return variants;
  }

  function signature(cells) {
    return cells.map(function (c) { return c[0] + ',' + c[1]; }).sort().join(';');
  }

  // 连续顶点变换：先旋转再平移；UV = 变换后坐标 / atlasSize，v 保持向下
  function transformGeometry(chart, placement, atlasSize) {
    var r = placement.rotation === 90 ? 1 : 0;
    var px = placement.x, py = placement.y;
    var positions = chart.vertices.map(function (v) {
      var t = r ? rotatePoint(v[0], v[1], chart.h) : [v[0], v[1]];
      return [t[0] + px, t[1] + py];
    });
    var uvs = positions.map(function (p) {
      return [p[0] / atlasSize, p[1] / atlasSize];
    });
    return { positions: positions, uvs: uvs };
  }

  // ---------- 布局计算与校验 ----------

  // 根据 placements（id -> {x,y,rotation}）计算完整布局：
  // 占用/补边归属网格、冲突、越界与统计。不修改入参。
  function computeLayout(parsed, placements) {
    var size = parsed.atlasSize;
    var n = size * size;
    var claimGrid = new Int32Array(n).fill(-1);
    var occGrid = new Int32Array(n).fill(-1);
    var conflicts = [];
    var placedCharts = [];

    parsed.charts.forEach(function (chart) {
      var pl = placements[chart.id];
      if (!pl) return;
      var variant = buildVariant(chart, pl.rotation, parsed.padding);
      var absClaim = variant.claim.map(function (c) {
        return [c[0] + pl.x, c[1] + pl.y];
      });
      var absOcc = variant.occ.map(function (c) {
        return [c[0] + pl.x, c[1] + pl.y];
      });

      var oob = [];
      var overlapMap = Object.create(null);
      absClaim.forEach(function (cell) {
        var x = cell[0], y = cell[1];
        if (x < 0 || y < 0 || x >= size || y >= size) {
          if (oob.length < REPORT_CELL_CAP) oob.push([x, y]);
          return;
        }
        var idx = y * size + x;
        var owner = claimGrid[idx];
        if (owner >= 0 && owner !== chart.index) {
          var key = owner;
          if (!overlapMap[key]) overlapMap[key] = { cells: [], count: 0 };
          overlapMap[key].count++;
          if (overlapMap[key].cells.length < REPORT_CELL_CAP)
            overlapMap[key].cells.push([x, y]);
        }
      });
      if (oob.length)
        conflicts.push({ kind: 'out-of-bounds', chart: chart.id, cells: oob });
      Object.keys(overlapMap).sort(function (a, b) { return a - b; }).forEach(function (k) {
        var ownerIdx = +k;
        conflicts.push({
          kind: 'claim-overlap',
          a: chart.id, b: parsed.charts[ownerIdx].id,
          cells: overlapMap[k].cells, cellCount: overlapMap[k].count
        });
      });

      // 登记到网格（越界格跳过；冲突格后者保留，用于继续暴露更多问题）
      absClaim.forEach(function (cell) {
        var x = cell[0], y = cell[1];
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        claimGrid[y * size + x] = chart.index;
      });
      absOcc.forEach(function (cell) {
        var x = cell[0], y = cell[1];
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        occGrid[y * size + x] = chart.index;
      });
      placedCharts.push({
        chart: chart, placement: { x: pl.x, y: pl.y, rotation: pl.rotation },
        variant: variant, absClaim: absClaim, absOcc: absOcc
      });
    });

    var occupiedCells = 0, paddingCells = 0;
    for (var i = 0; i < n; i++) {
      if (claimGrid[i] >= 0) {
        if (occGrid[i] >= 0) occupiedCells++;
        else paddingCells++;
      }
    }
    var usedCells = occupiedCells + paddingCells;
    return {
      claimGrid: claimGrid, occGrid: occGrid,
      conflicts: conflicts, placedCharts: placedCharts,
      stats: {
        occupiedCells: occupiedCells,
        paddingCells: paddingCells,
        usedCells: usedCells,
        freeCells: n - usedCells,
        totalCells: n,
        utilization: usedCells / n
      }
    };
  }

  // 仅校验给定布局（如导入的 layout JSON），返回冲突与统计
  function validateLayout(parsed, placements) {
    var layout = computeLayout(parsed, placements);
    var missing = parsed.charts
      .filter(function (c) { return !placements[c.id]; })
      .map(function (c) { return c.id; });
    return {
      valid: layout.conflicts.length === 0,
      conflicts: layout.conflicts,
      missing: missing,
      stats: layout.stats
    };
  }

  // ---------- 排布（确定性 DFS） ----------

  function pack(parsed, opts) {
    opts = opts || {};
    var budget = opts.nodeBudget || DEFAULT_NODE_BUDGET;
    var size = parsed.atlasSize;
    var padding = parsed.padding;
    var grid = new Int32Array(size * size).fill(-1);

    // 预计算变体与固定排序
    var variants = parsed.charts.map(function (c) { return buildVariants(c, padding); });
    var totalClaim = parsed.charts.reduce(function (s, c) {
      return s + variants[c.index][0].claimCount;
    }, 0);

    // 1) 锁定图块先行，逐格记录冲突（优先级最高：用户给的约束必须先核对）
    var lockedPlacements = {};
    for (var li = 0; li < parsed.charts.length; li++) {
      var chart = parsed.charts[li];
      if (!chart.locked) continue;
      var pl = chart.given;
      var variant = buildVariant(chart, pl.rotation, padding);
      var fit = diagnosePlacement(grid, size, parsed, chart, variant, pl.x, pl.y);
      if (!fit.ok) {
        return {
          status: 'locked-conflict',
          reason: fit.reason,
          conflicts: fit.conflicts,
          lockedChart: chart.id,
          message: formatLockedFailure(chart.id, fit),
          placements: [], nodes: 0
        };
      }
      commit(grid, variant, pl.x, pl.y, chart.index);
      lockedPlacements[chart.id] = { x: pl.x, y: pl.y, rotation: pl.rotation };
    }

    // 2) 面积下界：所有补边格互斥且必须在画布内（锁定约束核对通过后才谈容量）
    if (totalClaim > size * size) {
      return {
        status: 'impossible',
        reason: 'area-lower-bound',
        message: '补边后总需求 ' + totalClaim + ' 格 > 画布容量 ' + (size * size) +
          ' 格（原占用合计 ' + parsed.charts.reduce(function (s, c) { return s + c.occ.length; }, 0) +
          ' 格），可证明无解。不会缩放任何图块。',
        totalClaim: totalClaim, capacity: size * size,
        placements: [], nodes: 0
      };
    }

    // 3) 单块可行性（任何旋转下补边包围框都超出画布 => 可证明无解）
    for (var si = 0; si < parsed.charts.length; si++) {
      var ch = parsed.charts[si];
      if (ch.locked) continue;
      var anyFits = variants[ch.index].some(function (v) {
        // 补边后的实际包围框尺寸能否放进画布（相对坐标可为负，平移后即可入画）
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        v.claim.forEach(function (c) {
          if (c[0] < minX) minX = c[0];
          if (c[1] < minY) minY = c[1];
          if (c[0] > maxX) maxX = c[0];
          if (c[1] > maxY) maxY = c[1];
        });
        return (maxX - minX + 1) <= size && (maxY - minY + 1) <= size;
      });
      if (!anyFits) {
        return {
          status: 'impossible',
          reason: 'chart-too-large',
          message: '图块 ' + ch.id + ' 的补边包围框在任何旋转下都超出 ' +
            size + 'x' + size + ' 画布，可证明无解。',
          placements: [], nodes: 0
        };
      }
    }

    // 4) 待排图块固定顺序：补边格数降序、占用格数降序、输入顺序
    var order = parsed.charts.filter(function (c) { return !c.locked; });
    order.sort(function (a, b) {
      var ca = variants[a.index][0].claimCount;
      var cb = variants[b.index][0].claimCount;
      if (ca !== cb) return cb - ca;
      if (a.occ.length !== b.occ.length) return b.occ.length - a.occ.length;
      return a.index - b.index;
    });

    // ---- 阶段一：确定性贪心，候选空间完备（前沿+边界锚点） ----
    var frontier = createFrontier(size, grid);
    var greedyMap = greedyScan(grid, size, order, variants, frontier);
    if (greedyMap) {
      var all0 = Object.assign({}, lockedPlacements, greedyMap);
      var layout0 = computeLayout(parsed, all0);
      return {
        status: 'ok', reason: null, phase: 'greedy',
        message: '全部 ' + parsed.charts.length + ' 块排布完成（贪心确定性扫描，无回溯）。',
        nodes: 0, budget: budget,
        placements: mapToPlacementList(all0, parsed),
        stats: layout0.stats
      };
    }

    // 贪心未成功 => 重建网格与前沿，进入固定预算的回溯
    grid.fill(-1);
    var lockedCharts = parsed.charts.filter(function (c) { return c.locked; });
    lockedCharts.forEach(function (chart) {
      var pl = chart.given;
      var v = buildVariant(chart, pl.rotation, padding);
      commit(grid, v, pl.x, pl.y, chart.index);
    });
    frontier = createFrontier(size, grid);

    var nodes = 0, budgetHit = false, backResult = {};
    function dfs(depth) {
      if (nodes >= budget) { budgetHit = true; return false; }
      nodes++;
      if (depth === order.length) return true;
      var cur = order[depth];
      var vs = variants[cur.index];
      for (var vi = 0; vi < vs.length; vi++) {
        var v = vs[vi];
        var candidates = fitCandidates(grid, size, cur.index, v, frontier);
        for (var ci = 0; ci < candidates.length; ci++) {
          var c = candidates[ci];
          var undo = commitTracked(grid, size, frontier, v, c.x, c.y, cur.index);
          if (dfs(depth + 1)) {
            backResult[cur.id] = { x: c.x, y: c.y, rotation: v.rotation };
            return true;
          }
          rollbackTracked(grid, size, frontier, v, c.x, c.y, cur.index, undo);
        }
      }
      return false;
    }
    var ok = dfs(0);

    if (!ok) {
      var unplaced = order.map(function (c) { return c.id; });
      if (budgetHit) {
        return {
          status: 'not-found',
          reason: 'budget-reached',
          phase: 'backtrack',
          message: '贪心失败后启动回溯，搜索节点预算 ' + budget +
            ' 用尽仍未找到可行布局，标记为未找到（不能证明无解）。未放置 ' +
            unplaced.length + ' 块：' + unplaced.join(', ') + '。不会缩放任何图块。',
          unplaced: unplaced, nodes: nodes, budget: budget,
          placements: mapToPlacementList(lockedPlacements, parsed)
        };
      }
      return {
        status: 'not-found',
        reason: 'exhausted-within-budget',
        phase: 'backtrack',
        message: '贪心失败后启动回溯，在节点预算 ' + budget +
          ' 内枚举完全部候选位置仍未找到可行布局，标记为未找到（不能证明无解）。未放置 ' +
          unplaced.length + ' 块。不会缩放任何图块。',
        unplaced: unplaced, nodes: nodes, budget: budget,
        placements: mapToPlacementList(lockedPlacements, parsed)
      };
    }

    var all = Object.assign({}, lockedPlacements, backResult);
    var layout = computeLayout(parsed, all);
    return {
      status: 'ok', reason: null, phase: 'backtrack',
      message: '全部 ' + parsed.charts.length + ' 块排布完成（回溯搜索，节点数 ' + nodes + '）。',
      nodes: nodes, budget: budget,
      placements: mapToPlacementList(all, parsed),
      stats: layout.stats
    };
  }

  function mapToPlacementList(map, parsed) {
    return parsed.charts
      .filter(function (c) { return map[c.id]; })
      .map(function (c) {
        var p = map[c.id];
        return { id: c.id, x: p.x, y: p.y, rotation: p.rotation };
      });
  }

  // ---------- 前沿空闲格 ----------
  // 锚点 = 画布边界格（含原点）∪ 与已占格四邻接的空闲格。
  // 完备性：任何合法放置向上再向左滑动，终止时其某个补边格要么落在边界，
  // 要么与已占格四邻接，故锚点对齐生成的候选集包含最优位置，回溯不丢解。
  function createFrontier(size, grid) {
    var mark = new Uint8Array(size * size); // 1=锚点（边界格或前沿格）
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1)
          mark[y * size + x] = 1;
      }
    }
    for (var i = 0; i < grid.length; i++) {
      if (grid[i] < 0) continue;
      var cx = i % size, cy = (i / size) | 0;
      var ns = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (var k = 0; k < 4; k++) {
        var nx = ns[k][0], ny = ns[k][1];
        if (nx >= 0 && ny >= 0 && nx < size && ny < size && grid[ny * size + nx] < 0)
          mark[ny * size + nx] = 1;
      }
    }
    return { mark: mark };
  }

  function isAnchor(frontier, idx) { return frontier.mark[idx] === 1; }

  // 带撤销日志的提交：记录锚点增删，供回溯恢复
  function commitTracked(grid, size, frontier, variant, px, py, idx) {
    var removed = [];
    var added = [];
    for (var i = 0; i < variant.claim.length; i++) {
      var x = variant.claim[i][0] + px, y = variant.claim[i][1] + py;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      var k = y * size + x;
      if (grid[k] < 0 && frontier.mark[k]) { removed.push(k); frontier.mark[k] = 0; }
      grid[k] = idx;
    }
    for (var j = 0; j < variant.claim.length; j++) {
      var cx = variant.claim[j][0] + px, cy = variant.claim[j][1] + py;
      var nbs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (var m = 0; m < 4; m++) {
        var nx = nbs[m][0], ny = nbs[m][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        var nk = ny * size + nx;
        if (grid[nk] < 0 && frontier.mark[nk] === 0) {
          frontier.mark[nk] = 1;
          added.push(nk);
        }
      }
    }
    return { removed: removed, added: added };
  }

  function rollbackTracked(grid, size, frontier, variant, px, py, idx, undo) {
    undo.added.forEach(function (k) { frontier.mark[k] = 0; });
    undo.removed.forEach(function (k) { frontier.mark[k] = 1; });
    rollback(grid, variant, px, py, idx);
  }

  function claimBounds(claim) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < claim.length; i++) {
      var x = claim[i][0], y = claim[i][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // 完备候选：让每个补边格依次对齐每个锚点（边界格或前沿空闲格）。
  // 结果按 (y,x) 确定性排序；整数键去重，越界位置用包围框先行剪枝。
  function fitCandidates(grid, size, selfIdx, variant, frontier) {
    var seen = new Set();
    var out = [];
    var claim = variant.claim;
    var b = variant._bounds || (variant._bounds = claimBounds(claim));
    var keyBase = size * 4; // 平移范围 [-size, size-1]，加偏移后非负
    function consider(px, py) {
      if (px + b.minX < 0 || py + b.minY < 0 ||
        px + b.maxX >= size || py + b.maxY >= size) return;
      var key = (py + size) * keyBase + (px + size);
      if (seen.has(key)) return;
      seen.add(key);
      if (tryPlace(grid, size, selfIdx, variant, px, py)) out.push(px, py);
    }
    // 空画布首块：原点放置（边界锚点对齐不必然生成它）
    consider(0, 0);
    for (var i = 0; i < grid.length; i++) {
      if (!isAnchor(frontier, i)) continue;
      var fx = i % size, fy = (i / size) | 0;
      for (var j = 0; j < claim.length; j++) {
        consider(fx - claim[j][0], fy - claim[j][1]);
      }
    }
    var res = [];
    for (var k = 0; k < out.length; k += 2) res.push({ x: out[k], y: out[k + 1] });
    res.sort(function (a, c) { return a.y - c.y || a.x - c.x; });
    return res;
  }

  // 贪心：按固定图块顺序，每块在完备候选中选最靠下、再靠左（变体按既定顺序，0 度优先）
  function greedyScan(grid, size, order, variants, frontier) {
    var result = {};
    for (var i = 0; i < order.length; i++) {
      var cur = order[i];
      var best = null;
      for (var vi = 0; vi < variants[cur.index].length; vi++) {
        var v = variants[cur.index][vi];
        var candidates = fitCandidates(grid, size, cur.index, v, frontier);
        if (candidates.length && (!best ||
          candidates[0].y < best.y ||
          (candidates[0].y === best.y && candidates[0].x < best.x))) {
          best = { x: candidates[0].x, y: candidates[0].y, variant: v };
        }
      }
      if (!best) return null;
      commitTracked(grid, size, frontier, best.variant, best.x, best.y, cur.index);
      result[cur.id] = { x: best.x, y: best.y, rotation: best.variant.rotation };
    }
    return result;
  }

  // 热路径：仅判断该放置是否合法（越界或与他块补边冲突即失败）
  function tryPlace(grid, size, selfIdx, variant, px, py) {
    var claim = variant.claim;
    for (var i = 0; i < claim.length; i++) {
      var x = claim[i][0] + px;
      var y = claim[i][1] + py;
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      var owner = grid[y * size + x];
      if (owner >= 0 && owner !== selfIdx) return false;
    }
    return true;
  }

  // 锁定图块专用：收集逐格越界/冲突信息用于报告
  function diagnosePlacement(grid, size, parsed, chart, variant, px, py) {
    var oob = [];
    var overlapMap = Object.create(null);
    for (var i = 0; i < variant.claim.length; i++) {
      var x = variant.claim[i][0] + px;
      var y = variant.claim[i][1] + py;
      if (x < 0 || y < 0 || x >= size || y >= size) {
        if (oob.length < REPORT_CELL_CAP) oob.push([x, y]);
        continue;
      }
      var owner = grid[y * size + x];
      if (owner >= 0 && owner !== chart.index) {
        if (!overlapMap[owner]) overlapMap[owner] = { cells: [], count: 0 };
        overlapMap[owner].count++;
        if (overlapMap[owner].cells.length < REPORT_CELL_CAP)
          overlapMap[owner].cells.push([x, y]);
      }
    }
    if (!oob.length && !Object.keys(overlapMap).length) return { ok: true };
    var conflicts = [];
    if (oob.length) conflicts.push({ kind: 'out-of-bounds', chart: chart.id, cells: oob });
    Object.keys(overlapMap).sort(function (a, b) { return a - b; }).forEach(function (k) {
      conflicts.push({
        kind: 'claim-overlap',
        a: chart.id, b: parsed.charts[+k].id,
        cells: overlapMap[k].cells, cellCount: overlapMap[k].count
      });
    });
    return {
      ok: false,
      reason: oob.length ? 'out-of-bounds' : 'overlap',
      conflicts: conflicts
    };
  }

  function commit(grid, variant, px, py, idx) {
    var size = Math.round(Math.sqrt(grid.length));
    for (var j = 0; j < variant.claim.length; j++) {
      var cx = variant.claim[j][0] + px, cy = variant.claim[j][1] + py;
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
      grid[cy * size + cx] = idx;
    }
  }

  function rollback(grid, variant, px, py, idx) {
    var size = Math.round(Math.sqrt(grid.length));
    for (var j = 0; j < variant.claim.length; j++) {
      var cx = variant.claim[j][0] + px, cy = variant.claim[j][1] + py;
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
      var k = cy * size + cx;
      if (grid[k] === idx) grid[k] = -1;
    }
  }

  function formatLockedFailure(id, fit) {
    var parts = ['锁定图块 ' + id + ' 无法放置：'];
    fit.conflicts.forEach(function (c) {
      if (c.kind === 'out-of-bounds')
        parts.push('补边格越界 ' + c.cells.length + ' 处，例如 ' + formatCells(c.cells));
      else
        parts.push('与 ' + c.b + ' 补边冲突 ' + c.cellCount + ' 格，例如 ' + formatCells(c.cells));
    });
    parts.push('请调整该图块的锁定位置或补边大小，不会缩放任何图块。');
    return parts.join('；');
  }

  function formatCells(cells) {
    return cells.map(function (c) { return '(' + c[0] + ',' + c[1] + ')'; }).join(' ');
  }

  // ---------- 导出 ----------

  function buildLayoutJSON(parsed, placementList) {
    var map = {};
    placementList.forEach(function (p) { map[p.id] = p; });
    var layout = computeLayout(parsed, map);
    return {
      atlasSize: parsed.atlasSize,
      padding: parsed.padding,
      placements: placementList,
      stats: {
        occupiedCells: layout.stats.occupiedCells,
        paddingCells: layout.stats.paddingCells,
        freeCells: layout.stats.freeCells,
        utilization: Number(layout.stats.utilization.toFixed(6))
      }
    };
  }

  function buildCornerUV(parsed, placementList) {
    var map = {};
    placementList.forEach(function (p) { map[p.id] = p; });
    return {
      atlasSize: parsed.atlasSize,
      padding: parsed.padding,
      charts: parsed.charts.filter(function (c) { return map[c.id]; }).map(function (chart) {
        var pl = map[chart.id];
        var geo = transformGeometry(chart, pl, parsed.atlasSize);
        return {
          id: chart.id,
          placement: { x: pl.x, y: pl.y, rotation: pl.rotation },
          vertices: chart.vertices.map(function (v, i) {
            return {
              index: i,
              original: [v[0], v[1]],
              position: [round6(geo.positions[i][0]), round6(geo.positions[i][1])],
              uv: [round6(geo.uvs[i][0]), round6(geo.uvs[i][1])]
            };
          }),
          triangles: chart.triangles.map(function (t) {
            return {
              indices: [t[0], t[1], t[2]],
              corners: t.map(function (vi) {
                return {
                  vertex: vi,
                  position: [round6(geo.positions[vi][0]), round6(geo.positions[vi][1])],
                  uv: [round6(geo.uvs[vi][0]), round6(geo.uvs[vi][1])]
                };
              })
            };
          })
        };
      })
    };
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  // 确定性调色板：按图块输入索引取色
  function chartColor(index) {
    var hue = (index * 137.508) % 360;
    return {
      occ: 'hsl(' + hue.toFixed(2) + ', 68%, 52%)',
      pad: 'hsl(' + hue.toFixed(2) + ', 60%, 78%)'
    };
  }

  return {
    parseInput: parseInput,
    buildVariant: buildVariant,
    buildVariants: buildVariants,
    transformGeometry: transformGeometry,
    computeLayout: computeLayout,
    validateLayout: validateLayout,
    pack: pack,
    buildLayoutJSON: buildLayoutJSON,
    buildCornerUV: buildCornerUV,
    chartColor: chartColor,
    rotateCell: rotateCell,
    rotatePoint: rotatePoint,
    formatCells: formatCells
  };
});
