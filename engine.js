// engine.js — 分块合成重绘校验引擎（纯函数，无 DOM 依赖）
// 坐标系：所有节点在组的局部整数坐标中工作；叶子色块、盒模糊窗口、裁框均按整数像素对齐。
// 像素一律用 Float32 存储线性、预乘 RGBA。
// 浏览器下挂到 window.RTEngine；Node 下走 module.exports。
(function (global) {
  'use strict';

  var TILE = 16;
  var MAX_NODES = 128;
  var MAX_SIZE = 1024;
  var MAX_RADIUS = 8;

  // ---------- 基础工具 ----------

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function cloneJson(v) { return JSON.parse(JSON.stringify(v)); }

  // 整数矩形 [x, y, w, h]，空矩形用 null
  function rectValid(r) { return !!r && r[2] > 0 && r[3] > 0; }
  function rectIntersect(a, b) {
    if (!a || !b) return null;
    var x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
    var x1 = Math.min(a[0] + a[2], b[0] + b[2]);
    var y1 = Math.min(a[1] + a[3], b[1] + b[3]);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1 - x0, y1 - y0];
  }
  function rectUnion(a, b) {
    if (!a) return b ? [b[0], b[1], b[2], b[3]] : null;
    if (!b) return [a[0], a[1], a[2], a[3]];
    var x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
    var x1 = Math.max(a[0] + a[2], b[0] + b[2]);
    var y1 = Math.max(a[1] + a[3], b[1] + b[3]);
    return [x0, y0, x1 - x0, y1 - y0];
  }
  function rectExpand(r, n) {
    if (!r) return null;
    return [r[0] - n, r[1] - n, r[2] + 2 * n, r[3] + 2 * n];
  }
  function rectTranslate(r, dx, dy) {
    if (!r) return null;
    return [r[0] + dx, r[1] + dy, r[2], r[3]];
  }
  function rectContainsPoint(r, x, y) {
    return !!r && x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
  }

  // ---------- 模型 ----------

  // 标准化 + 校验。返回 { nodes: Map<id, node>, rootId, size:[w,h], tile }
  function buildModel(scene) {
    if (!scene || typeof scene !== 'object') throw new Error('场景不是对象');
    var size = scene.size;
    if (!Array.isArray(size) || size.length !== 2 || !isInt(size[0]) || !isInt(size[1]) ||
        size[0] <= 0 || size[1] <= 0 || size[0] > MAX_SIZE || size[1] > MAX_SIZE) {
      throw new Error('画布 size 必须是 1..1024 的整数 [宽, 高]');
    }
    var tile = scene.tile || TILE;
    if (!isInt(tile) || tile <= 0 || size[0] % tile !== 0 || size[1] % tile !== 0) {
      throw new Error('tile 边长必须整除画布宽高');
    }
    if (!scene.root || typeof scene.root !== 'object') throw new Error('缺少 root 节点');

    var nodes = new Map();
    var count = 0;
    var seen = new Set();

    function walk(n, parentId, depth) {
      if (!n || typeof n !== 'object') throw new Error('节点格式错误');
      if (typeof n.id !== 'string' || !n.id) throw new Error('节点缺少字符串 id');
      if (seen.has(n.id)) throw new Error('节点 id 重复: ' + n.id);
      seen.add(n.id);
      count++;
      if (count > MAX_NODES) throw new Error('图层节点超过 ' + MAX_NODES + ' 个上限');
      var node = { id: n.id, parentId: parentId, depth: depth };
      var isLeaf = Array.isArray(n.box);
      if (isLeaf) {
        var b = n.box;
        if (b.length !== 4 || !b.every(isInt) || b[2] <= 0 || b[3] <= 0) {
          throw new Error('叶子 ' + n.id + ' 的 box 必须是 [x,y,w,h] 正整数');
        }
        var c = n.rgba;
        if (!Array.isArray(c) || c.length !== 4 ||
            c.some(function (v) { return typeof v !== 'number' || v < 0 || v > 1; })) {
          throw new Error('叶子 ' + n.id + ' 的 rgba 必须是 0..1 的四通道数组');
        }
        node.type = 'leaf';
        node.box = [b[0], b[1], b[2], b[3]];
        node.rgba = [c[0], c[1], c[2], c[3]];
        node.offset = [0, 0]; // 叶子不参与平移，统一字段方便沿树处理
      } else {
        if (!Array.isArray(n.children)) throw new Error('组 ' + n.id + ' 缺少 children');
        node.type = 'group';
        node.children = n.children.map(function (ch) {
          if (!ch || typeof ch.id !== 'string') throw new Error('组 ' + n.id + ' 的子节点引用无效');
          return ch.id;
        });
        node.r = n.r || 0;
        if (!isInt(node.r) || node.r < 0 || node.r > MAX_RADIUS) {
          throw new Error('组 ' + n.id + ' 的模糊半径 r 必须是 0..8 的整数');
        }
        node.opacity = n.opacity === undefined ? 1 : n.opacity;
        if (typeof node.opacity !== 'number' || node.opacity < 0 || node.opacity > 1) {
          throw new Error('组 ' + n.id + ' 的 opacity 必须在 0..1');
        }
        node.clip = normalizeClip(n.clip, n.id);
        node.offset = normalizeOffset(n.offset, n.id, parentId === null);
      }
      nodes.set(node.id, node);
      if (node.type === 'group') {
        node.children.forEach(function (cid, i) {
          if (!n.children[i] || typeof n.children[i] !== 'object') return;
          walk(n.children[i], node.id, depth + 1);
        });
        // 子 id 必须都存在且无重复
        var dup = new Set();
        node.children.forEach(function (cid) {
          if (dup.has(cid)) throw new Error('组 ' + n.id + ' 中出现重复子节点 ' + cid);
          dup.add(cid);
        });
      }
    }
    walk(scene.root, null, 0);

    // 引用完整性
    nodes.forEach(function (n) {
      if (n.type === 'group') {
        n.children.forEach(function (cid) {
          if (!nodes.has(cid)) throw new Error('组 ' + n.id + ' 引用了不存在的子节点 ' + cid);
          if (nodes.get(cid).parentId !== n.id) throw new Error('节点 ' + cid + ' 只能有一个父节点');
        });
      }
    });
    if (!nodes.has(scene.root.id)) throw new Error('根节点未注册');

    return { nodes: nodes, rootId: scene.root.id, size: [size[0], size[1]], tile: tile };
  }

  function normalizeClip(clip, id) {
    if (clip === null || clip === undefined) return null;
    if (!Array.isArray(clip) || clip.length !== 4 || !clip.every(isInt) || clip[2] <= 0 || clip[3] <= 0) {
      throw new Error('组 ' + id + ' 的 clip 必须是 null 或 [x,y,w,h] 正整数');
    }
    return [clip[0], clip[1], clip[2], clip[3]];
  }
  function normalizeOffset(offset, id, isRoot) {
    if (offset === undefined || offset === null) offset = [0, 0];
    if (!Array.isArray(offset) || offset.length !== 2 || !isInt(offset[0]) || !isInt(offset[1])) {
      throw new Error('组 ' + id + ' 的 offset 必须是整数 [dx, dy]');
    }
    if (isRoot && (offset[0] !== 0 || offset[1] !== 0)) {
      throw new Error('根节点不能平移');
    }
    return [offset[0], offset[1]];
  }

  // 校验一组补丁（不应用）。同一节点允许出现多次，应用时按顺序合并。
  function validatePatches(model, patches) {
    if (!Array.isArray(patches)) throw new Error('批次必须是补丁数组');
    patches.forEach(function (p) {
      var node = model.nodes.get(p.id);
      if (!node) throw new Error('补丁引用了不存在的节点 ' + p.id);
      var keys = Object.keys(p).filter(function (k) { return k !== 'id'; });
      keys.forEach(function (k) {
        if (node.type === 'leaf') {
          if (k === 'box') {
            if (!Array.isArray(p.box) || p.box.length !== 4 || !p.box.every(isInt) || p.box[2] <= 0 || p.box[3] <= 0) {
              throw new Error('叶子 ' + p.id + ' 的 box 补丁无效');
            }
          } else if (k === 'rgba') {
            if (!Array.isArray(p.rgba) || p.rgba.length !== 4 ||
                p.rgba.some(function (v) { return typeof v !== 'number' || v < 0 || v > 1; })) {
              throw new Error('叶子 ' + p.id + ' 的 rgba 补丁无效');
            }
          } else throw new Error('叶子 ' + p.id + ' 不支持修改 ' + k);
        } else {
          if (k === 'offset') normalizeOffset(p.offset, p.id, node.parentId === null);
          else if (k === 'clip') normalizeClip(p.clip, p.id);
          else if (k === 'opacity') {
            if (typeof p.opacity !== 'number' || p.opacity < 0 || p.opacity > 1) {
              throw new Error('组 ' + p.id + ' 的 opacity 补丁无效');
            }
          } else if (k === 'r') {
            if (!isInt(p.r) || p.r < 0 || p.r > MAX_RADIUS) throw new Error('组 ' + p.id + ' 的 r 补丁无效');
          } else if (k === 'children') {
            if (!Array.isArray(p.children) || p.children.length !== node.children.length ||
                p.children.some(function (c) { return typeof c !== 'string'; })) {
              throw new Error('组 ' + p.id + ' 的 children 必须是包含全部子 id 的重排列表');
            }
            var want = node.children.slice().sort().join(',');
            var got = p.children.slice().sort().join(',');
            if (want !== got) throw new Error('组 ' + p.id + ' 的 children 重排必须包含完全相同的子 id 集合');
          } else throw new Error('组 ' + p.id + ' 不支持修改 ' + k);
        }
      });
    });
  }

  // ---------- 全量参考渲染（独立代码路径，不用任何缓存） ----------

  function fullRender(model) {
    var W = model.size[0], H = model.size[1];
    var root = model.nodes.get(model.rootId);
    // 独立参考路径：整画布缓冲，每个节点只渲染一次，不使用任何瓦片缓存
    var rendered = renderNodeFull(model, root, [0, 0, W, H]);
    return rendered.buf;
  }

  // 参考渲染：返回节点在请求 region 内的输出。
  // 为避免嵌套层对同一子树按区域重复递归，组节点一次性渲染覆盖其全部内容的包围盒，
  // 再从结果中裁出 region（叶子本身是纯色，直接填充即可）。
  function renderNodeFull(model, node, region) {
    if (node.type === 'leaf') {
      var buf = new Float32Array(region[2] * region[3] * 4);
      fillLeaf(buf, region, node);
      return { buf: buf, bounds: region };
    }
    // 组：求该组在自身局部坐标下的完整内容包围盒，与请求区取交
    var ownBox = outputBox(model, node);
    var renderRegion = ownBox ? rectIntersect(
      rectExpand(ownBox, 0), rectExpand(region, 0)) : null;
    if (!renderRegion) {
      return { buf: new Float32Array(region[2] * region[3] * 4), bounds: region };
    }
    var r = node.r;
    var contentRegion = rectExpand(renderRegion, r);
    var content = new Float32Array(contentRegion[2] * contentRegion[3] * 4);
    node.children.forEach(function (cid) {
      var child = model.nodes.get(cid);
      var localRegion = [
        contentRegion[0] - child.offset[0],
        contentRegion[1] - child.offset[1],
        contentRegion[2], contentRegion[3]
      ];
      var rendered = renderNodeFull(model, child, localRegion);
      var placed = [
        localRegion[0] + child.offset[0], localRegion[1] + child.offset[1],
        localRegion[2], localRegion[3]
      ];
      blitOver(rendered.buf, localRegion[2], localRegion[3], placed,
               content, contentRegion[2], contentRegion[3],
               [contentRegion[0], contentRegion[1]], null);
    });
    if (r > 0) boxBlurInPlace(content, contentRegion[2], contentRegion[3], r);
    // 收回 renderRegion，再裁/缩放，最后拷入调用方请求的 region 缓冲
    var stage = new Float32Array(renderRegion[2] * renderRegion[3] * 4);
    blitOver(content, contentRegion[2], contentRegion[3],
             [contentRegion[0], contentRegion[1], contentRegion[2], contentRegion[3]],
             stage, renderRegion[2], renderRegion[3],
             [renderRegion[0], renderRegion[1]], renderRegion);
    if (node.clip) applyClip(stage, renderRegion, node.clip);
    if (node.opacity !== 1) scaleBy(stage, node.opacity);
    var out = new Float32Array(region[2] * region[3] * 4);
    blitOver(stage, renderRegion[2], renderRegion[3],
             [renderRegion[0], renderRegion[1], renderRegion[2], renderRegion[3]],
             out, region[2], region[3], [region[0], region[1]], region);
    return { buf: out, bounds: region };
  }

  // 在尺寸等于 region 的本地缓冲中填满叶子色（缓冲像素 0,0 即 region 左上角）
  function fillLeaf(buf, region, leaf) {
    var overlap = rectIntersect(region, leaf.box);
    if (!overlap) return;
    var r = leaf.rgba;
    var pr = r[0] * r[3], pg = r[1] * r[3], pb = r[2] * r[3], pa = r[3];
    for (var y = overlap[1]; y < overlap[1] + overlap[3]; y++) {
      for (var x = overlap[0]; x < overlap[0] + overlap[2]; x++) {
        var i = ((y - region[1]) * region[2] + (x - region[0])) * 4;
        // 源覆盖到空缓冲即取叶子自身的预乘值
        buf[i] = pr; buf[i + 1] = pg; buf[i + 2] = pb; buf[i + 3] = pa;
      }
    }
  }

  // 线性预乘源覆盖。
  // 约定：src 是 srcW×srcH 缓冲，像素 (0,0) 位于几何盒 srcBox 左上角，
  //       即几何点 g 对应源本地坐标 (g - srcBox.xy)；srcBox 尺寸等于缓冲尺寸。
  //       dst 像素 (0,0) 位于 dstOrigin；clipRect 为可选几何裁剪。
  function blitOver(src, srcW, srcH, srcBox,
                    dst, dstW, dstH, dstOrigin, clipRect) {
    var x0 = Math.max(srcBox[0], dstOrigin[0]);
    var y0 = Math.max(srcBox[1], dstOrigin[1]);
    var x1 = Math.min(srcBox[0] + srcW, dstOrigin[0] + dstW);
    var y1 = Math.min(srcBox[1] + srcH, dstOrigin[1] + dstH);
    if (clipRect) {
      x0 = Math.max(x0, clipRect[0]); y0 = Math.max(y0, clipRect[1]);
      x1 = Math.min(x1, clipRect[0] + clipRect[2]);
      y1 = Math.min(y1, clipRect[1] + clipRect[3]);
    }
    if (x1 <= x0 || y1 <= y0) return;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var lx = x - srcBox[0], ly = y - srcBox[1];
        var si = (ly * srcW + lx) * 4;
        var di = ((y - dstOrigin[1]) * dstW + (x - dstOrigin[0])) * 4;
        var sa = src[si + 3];
        if (sa <= 0) continue;
        var da = dst[di + 3];
        var inv = 1 - sa;
        dst[di] = src[si] + dst[di] * inv;
        dst[di + 1] = src[si + 1] + dst[di + 1] * inv;
        dst[di + 2] = src[si + 2] + dst[di + 2] * inv;
        dst[di + 3] = sa + da * inv;
      }
    }
  }

  // 可分离盒模糊：两遍一维滑动窗口，窗口长 2r+1，固定面积 (2r+1)^2。
  // 越界位置按透明 0 计入求和，但除数恒为 span（窗口面积不缩）。
  function boxBlur1D(src, dst, w, h, r, horizontal) {
    var span = 2 * r + 1;
    var len = horizontal ? w : h;
    var lineCount = horizontal ? h : w;
    for (var lineIdx = 0; lineIdx < lineCount; lineIdx++) {
      var sr = 0, sg = 0, sb = 0, sa = 0;
      // 预填中心 0 的窗口 [-r, r]（越界元素按 0，跳过即可）
      for (var init = -r; init <= r; init++) {
        if (init < 0 || init >= len) continue;
        var ax = horizontal ? init : lineIdx;
        var ay = horizontal ? lineIdx : init;
        var ai = (ay * w + ax) * 4;
        sr += src[ai]; sg += src[ai + 1]; sb += src[ai + 2]; sa += src[ai + 3];
      }
      for (var pos = 0; pos < len; pos++) {
        var ox = horizontal ? pos : lineIdx;
        var oy = horizontal ? lineIdx : pos;
        var oi = (oy * w + ox) * 4;
        dst[oi] = sr / span; dst[oi + 1] = sg / span;
        dst[oi + 2] = sb / span; dst[oi + 3] = sa / span;
        // 窗口整体右移一格：离开 pos-r，进入 pos+r+1（越界按 0）
        var leave = pos - r, enter = pos + r + 1;
        if (leave >= 0) {
          var jx = horizontal ? leave : lineIdx;
          var jy = horizontal ? lineIdx : leave;
          var jj = (jy * w + jx) * 4;
          sr -= src[jj]; sg -= src[jj + 1]; sb -= src[jj + 2]; sa -= src[jj + 3];
        }
        if (enter < len) {
          var ix = horizontal ? enter : lineIdx;
          var iy = horizontal ? lineIdx : enter;
          var ii = (iy * w + ix) * 4;
          sr += src[ii]; sg += src[ii + 1]; sb += src[ii + 2]; sa += src[ii + 3];
        }
      }
    }
  }
  function boxBlurInPlace(buf, w, h, r) {
    var tmp = new Float32Array(buf.length);
    boxBlur1D(buf, tmp, w, h, r, true);
    boxBlur1D(tmp, buf, w, h, r, false);
  }

  function applyClip(buf, region, clip) {
    for (var y = 0; y < region[3]; y++) {
      for (var x = 0; x < region[2]; x++) {
        var gx = region[0] + x, gy = region[1] + y;
        if (!rectContainsPoint(clip, gx, gy)) {
          var i = (y * region[2] + x) * 4;
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
        }
      }
    }
  }

  function scaleBy(buf, k) {
    for (var i = 0; i < buf.length; i++) buf[i] *= k;
  }

  // ---------- 增量保留瓦片渲染器 ----------
  //
  // 每个组维护局部坐标下的瓦片缓存：key "tx,ty" -> { data:Float32Array(T*T*4), valid:bool }
  // 叶子没有缓存。根组缓存即画布瓦片。
  // 每次批次：
  //   1) 算出每个受影响组的失效瓦片集合（模糊扩张，覆盖旧位置与新位置）
  //   2) 沿根的脏矩形，按需重算缺失/失效瓦片（递归拉取子组缓存，未失效的直接复用）
  //   3) 根脏矩形先整体清零再贴回，杜绝旧位置亮边

  function createRetained(model) {
    return {
      model: model,
      caches: new Map(),       // groupId -> Map(key -> entry)
      recomputed: new Map(),   // 本次批次每组重算瓦片 key 集合（日志用）
      damaged: new Map(),      // 本次批次每组失效瓦片 key 集合（日志用）
      rootDamage: null,        // 画布坐标脏矩形
      canvas: new Float32Array(model.size[0] * model.size[1] * 4),
      seq: 0
    };
  }

  function tileKey(tx, ty) { return tx + ',' + ty; }
  function parseKey(k) { var p = k.split(','); return [parseInt(p[0], 10), parseInt(p[1], 10)]; }

  function groupCache(rt, groupId) {
    var c = rt.caches.get(groupId);
    if (!c) { c = new Map(); rt.caches.set(groupId, c); }
    return c;
  }

  // 节点在“父组局部坐标”中的输出覆盖盒（保守盒，用于脏区传播）
  function outputBox(model, node) {
    if (node.type === 'leaf') return [node.box[0], node.box[1], node.box[2], node.box[3]];
    var box = null;
    node.children.forEach(function (cid) {
      var ch = model.nodes.get(cid);
      var cb = outputBox(model, ch);
      cb = rectTranslate(cb, ch.offset[0], ch.offset[1]);
      box = rectUnion(box, cb);
    });
    if (node.r > 0) box = rectExpand(box, node.r);
    if (node.clip) box = rectIntersect(box, node.clip);
    return box; // 可能为 null（空组）
  }

  // 组在“自身局部坐标”下、模糊与裁剪之前的内容包围盒（子输出按子 offset 放置后的并集）
  function groupContentBox(model, group) {
    var box = null;
    group.children.forEach(function (cid) {
      var ch = model.nodes.get(cid);
      var cb = outputBox(model, ch);
      cb = rectTranslate(cb, ch.offset[0], ch.offset[1]);
      box = rectUnion(box, cb);
    });
    return box;
  }

  // 瓦片矩形覆盖的像素盒
  function tilePixelBox(tx, ty, tile) { return [tx * tile, ty * tile, tile, tile]; }

  function tilesOverlappingRect(rect, tile) {
    var keys = [];
    if (!rect) return keys;
    var tx0 = Math.floor(rect[0] / tile), ty0 = Math.floor(rect[1] / tile);
    var tx1 = Math.floor((rect[0] + rect[2] - 1) / tile);
    var ty1 = Math.floor((rect[1] + rect[3] - 1) / tile);
    for (var ty = ty0; ty <= ty1; ty++)
      for (var tx = tx0; tx <= tx1; tx++) keys.push(tileKey(tx, ty));
    return keys;
  }

  // 计算并应用一次批次。patches 已通过 validatePatches。
  // 返回结构化日志对象。
  function applyBatch(rt, patches, meta) {
    var model = rt.model;
    var tile = model.tile;
    rt.seq++;
    var log = {
      seq: rt.seq,
      meta: meta || {},
      patches: cloneJson(patches),
      damagedTiles: {},       // groupId -> key[]
      recomputedTiles: {},    // groupId -> key[]
      rootDamage: null,
      stats: { damaged: 0, recomputed: 0, reused: 0 },
      diff: null
    };
    rt.recomputed = new Map();
    rt.damaged = new Map();

    // 1) 快照旧值 + 旧输出盒：补丁节点、其子节点，以及全部祖先
    var oldVals = new Map(), oldBoxes = new Map();
    function snapshot(id) {
      if (oldVals.has(id)) return;
      var n = model.nodes.get(id);
      oldVals.set(id, {
        offset: n.type === 'group' ? n.offset.slice() : (n.offset ? n.offset.slice() : [0, 0]),
        clip: n.clip ? n.clip.slice() : null,
        opacity: n.opacity, r: n.r,
        children: n.type === 'group' ? n.children.slice() : null,
        box: n.type === 'leaf' ? n.box.slice() : null,
        rgba: n.type === 'leaf' ? n.rgba.slice() : null
      });
      oldBoxes.set(id, outputBox(model, n));
    }
    patches.forEach(function (p) {
      snapshot(p.id);
      var n = model.nodes.get(p.id);
      if (n.type === 'group') n.children.forEach(snapshot);
      // 祖先链：父级 offset 的旧值是旧位置轨迹所必需的
      var cur = n;
      while (cur.parentId !== null) {
        snapshot(cur.parentId);
        cur = model.nodes.get(cur.parentId);
      }
    });

    // 2) 应用补丁
    patches.forEach(function (p) {
      var n = model.nodes.get(p.id);
      if ('offset' in p) n.offset = normalizeOffset(p.offset, n.id, n.parentId === null);
      if ('clip' in p) n.clip = normalizeClip(p.clip, n.id);
      if ('opacity' in p) n.opacity = p.opacity;
      if ('r' in p) n.r = p.r;
      if ('children' in p) n.children = p.children.slice();
      if ('box' in p) n.box = p.box.slice();
      if ('rgba' in p) n.rgba = p.rgba.slice();
    });

    // 3) 对每个被补丁直接命中的节点，先失效自身瓦片，再沿祖先链传播脏矩形。
    // 关键：旧/新两条位置轨迹都要追踪，平移后父级必须同时覆盖旧位置和新位置。
    patches.forEach(function (p) {
      var n = model.nodes.get(p.id);
      var oldSelfBox = oldBoxes.get(p.id);
      var newSelfBox = outputBox(model, n);
      var oldOffset = oldVals.get(p.id).offset || [0, 0];
      var newOffset = n.offset || [0, 0];

      // 几何盒不变但像素变了（透明度 / 顺序 / 颜色 / 模糊 / 裁剪）
      var pixelDirty = ('opacity' in p) || ('children' in p) || ('rgba' in p) ||
                       ('r' in p) || ('clip' in p) || ('box' in p);

      // 3a) 节点自身（仅组有瓦片缓存，根组也是）：局部坐标里失效
      if (n.type === 'group') {
        var selfDamage = rectUnion(oldSelfBox, newSelfBox);
        if (pixelDirty && !selfDamage) selfDamage = newSelfBox;
        if (selfDamage) invalidateTiles(rt, n.id, selfDamage, tile, log);
      }

      // 3b) 向上传播：每一层都分别维护旧轨迹盒与新轨迹盒（父局部坐标）
      var oldPlaced = rectTranslate(oldSelfBox, oldOffset[0], oldOffset[1]);
      var newPlaced = rectTranslate(newSelfBox, newOffset[0], newOffset[1]);
      if (pixelDirty) {
        if (!oldPlaced) oldPlaced = oldSelfBox;
        if (!newPlaced) newPlaced = newSelfBox;
      }
      var cur = n;
      while (cur.parentId !== null) {
        var parent = model.nodes.get(cur.parentId);
        var layerDamage = rectUnion(oldPlaced, newPlaced);
        if (!layerDamage) layerDamage = newPlaced || oldPlaced;
        if (layerDamage) {
          var expanded = rectExpand(layerDamage, parent.r);
          invalidateTiles(rt, parent.id, expanded, tile, log);
          // 升到再上一层：父组自身也可能改了 offset，旧轨迹用旧值
          var pOldOffset = oldVals.has(parent.id) && oldVals.get(parent.id).offset
            ? oldVals.get(parent.id).offset : parent.offset;
          oldPlaced = rectTranslate(rectExpand(oldPlaced, parent.r), pOldOffset[0], pOldOffset[1]);
          newPlaced = rectTranslate(rectExpand(newPlaced, parent.r), parent.offset[0], parent.offset[1]);
        }
        cur = parent;
      }
    });

    // 根脏矩形 = 根组所有失效瓦片的并集（保留完整瓦片，可能超出画布，先不裁）
    var rootDamaged = rt.damaged.get(model.rootId) || new Set();
    var rootDamage = null;
    rootDamaged.forEach(function (k) {
      var p = parseKey(k);
      rootDamage = rectUnion(rootDamage, tilePixelBox(p[0], p[1], tile));
    });
    rt.rootDamage = rootDamage;
    log.rootDamage = rootDamage ? rootDamage.slice() : null;

    // 4) 重算根所需瓦片：根失效集合里的每个瓦片都重建（递归拉动子组缓存）
    var canvasClip = [0, 0, model.size[0], model.size[1]];
    var paintDamage = rootDamage ? rectIntersect(rootDamage, canvasClip) : null;
    rootDamaged.forEach(function (k) {
      var p = parseKey(k);
      ensureGroupTile(rt, model.nodes.get(model.rootId), p[0], p[1], log);
    });

    // 5) 根脏区清零后整体贴回（替换而非覆盖，修亮边）
    if (paintDamage) {
      var W = model.size[0], H = model.size[1];
      for (var y = paintDamage[1]; y < paintDamage[1] + paintDamage[3]; y++) {
        for (var x = paintDamage[0]; x < paintDamage[0] + paintDamage[2]; x++) {
          var ci = (y * W + x) * 4;
          rt.canvas[ci] = 0; rt.canvas[ci + 1] = 0;
          rt.canvas[ci + 2] = 0; rt.canvas[ci + 3] = 0;
        }
      }
      var rootCache = groupCache(rt, model.rootId);
      rootCache.forEach(function (entry, k) {
        var p = parseKey(k);
        var tb = tilePixelBox(p[0], p[1], tile);
        var ov = rectIntersect(tb, paintDamage);
        if (!ov) return;
        for (var yy = ov[1]; yy < ov[1] + ov[3]; yy++) {
          for (var xx = ov[0]; xx < ov[0] + ov[2]; xx++) {
            var si = ((yy - tb[1]) * tile + (xx - tb[0])) * 4;
            var di = (yy * W + xx) * 4;
            rt.canvas[di] = entry.data[si];
            rt.canvas[di + 1] = entry.data[si + 1];
            rt.canvas[di + 2] = entry.data[si + 2];
            rt.canvas[di + 3] = entry.data[si + 3];
          }
        }
      });
    }

    // 统计
    rt.damaged.forEach(function (set) { log.stats.damaged += set.size; });
    rt.recomputed.forEach(function (set) { log.stats.recomputed += set.size; });
    rt.caches.forEach(function (cache) {
      cache.forEach(function (e) { if (e.valid) log.stats.reused++; });
    });
    log.damagedTiles = stringifyMap(rt.damaged);
    log.recomputedTiles = stringifyMap(rt.recomputed);
    return log;
  }

  function stringifyMap(m) {
    var out = {};
    m.forEach(function (set, id) { out[id] = Array.from(set); });
    return out;
  }

  function markDamaged(rt, groupId, key, log) {
    var cache = groupCache(rt, groupId);
    var dset = rt.damaged.get(groupId);
    if (!dset) { dset = new Set(); rt.damaged.set(groupId, dset); }
    if (!dset.has(key)) {
      dset.add(key);
      var entry = cache.get(key);
      if (entry) entry.valid = false;
    }
  }

  function invalidateTiles(rt, groupId, rect, tile, log) {
    var keys = tilesOverlappingRect(rect, tile);
    keys.forEach(function (k) { markDamaged(rt, groupId, k, log); });
  }

  function markRecomputed(rt, groupId, key) {
    var set = rt.recomputed.get(groupId);
    if (!set) { set = new Set(); rt.recomputed.set(groupId, set); }
    set.add(key);
  }

  // 确保组 group 的瓦片 (tx,ty) 有效，必要时重算。重算会递归拉取子组瓦片。
  function ensureGroupTile(rt, group, tx, ty, log) {
    var model = rt.model, tile = model.tile;
    var cache = groupCache(rt, group.id);
    var entry = cache.get(tileKey(tx, ty));
    if (entry && entry.valid) return;
    if (!entry) {
      entry = { data: new Float32Array(tile * tile * 4), valid: false };
      cache.set(tileKey(tx, ty), entry);
    }
    computeGroupTile(rt, group, tx, ty, entry.data);
    entry.valid = true;
    markRecomputed(rt, group.id, tileKey(tx, ty));
  }

  // 重算单个组瓦片（组局部坐标）
  function computeGroupTile(rt, group, tx, ty, out) {
    var model = rt.model, tile = model.tile;
    var r = group.r;
    var tileBox = tilePixelBox(tx, ty, tile);
    // 工作区 = 瓦片向外扩 r（模糊采样需要）
    var workBox = rectExpand(tileBox, r);

    // 空瓦片快速路径：组内容包围盒（已含子组平移与本层模糊扩张）不碰工作区，
    // 或裁剪后与瓦片无缘 —— 直接产出全零，省去缓冲分配、合成与模糊。
    var contentBox = groupContentBox(model, group);
    if (group.clip) contentBox = contentBox ? rectIntersect(contentBox, group.clip) : null;
    if (!contentBox || !rectIntersect(workBox, contentBox)) {
      out.fill(0);
      return;
    }

    var work = new Float32Array(workBox[2] * workBox[3] * 4);

    // 从底到顶合成子节点
    group.children.forEach(function (cid) {
      var child = model.nodes.get(cid);
      if (child.type === 'leaf') {
        // 叶子坐标就是组局部坐标（叶子不携带平移）
        var leafRegion = rectIntersect(workBox, child.box);
        if (leafRegion) {
          var tmp = new Float32Array(leafRegion[2] * leafRegion[3] * 4);
          fillLeaf(tmp, leafRegion, child);
          // tmp 像素 (0,0) 对应几何 leafRegion 原点，放置盒即 leafRegion
          blitOver(tmp, leafRegion[2], leafRegion[3], leafRegion,
                   work, workBox[2], workBox[3],
                   [workBox[0], workBox[1]], null);
        }
      } else {
        // 子组：组局部工作区映射到子组局部坐标（减去子组平移）
        var localBox = [
          workBox[0] - child.offset[0], workBox[1] - child.offset[1],
          workBox[2], workBox[3]
        ];
        var childKeys = tilesOverlappingRect(localBox, tile);
        childKeys.forEach(function (k) {
          var p = parseKey(k);
          ensureGroupTile(rt, child, p[0], p[1], null);
          var centry = groupCache(rt, child.id).get(k);
          var cb = tilePixelBox(p[0], p[1], tile);
          // 瓦片缓冲原点是 cb，几何放置盒 = cb + 子组平移
          var placed = rectTranslate(cb, child.offset[0], child.offset[1]);
          blitOver(centry.data, tile, tile, placed,
                   work, workBox[2], workBox[3],
                   [workBox[0], workBox[1]], null);
        });
      }
    });

    if (r > 0) boxBlurInPlace(work, workBox[2], workBox[3], r);
    // 收回瓦片：work 本地像素对应 workBox 几何，裁到 tileBox 写入 tileTmp
    var tileTmp = new Float32Array(tile * tile * 4);
    blitOver(work, workBox[2], workBox[3],
             [workBox[0], workBox[1], workBox[2], workBox[3]],
             tileTmp, tile, tile, [tileBox[0], tileBox[1]], tileBox);
    if (group.clip) applyClip(tileTmp, tileBox, group.clip);
    if (group.opacity !== 1) scaleBy(tileTmp, group.opacity);
    out.set(tileTmp);
  }

  // 初次全量建立缓存（等价于对根全部瓦片做一次 ensure）
  function prime(rt) {
    var model = rt.model, tile = model.tile;
    var log = {
      seq: 0, meta: { prime: true }, patches: [],
      damagedTiles: {}, recomputedTiles: {}, rootDamage: [0, 0, model.size[0], model.size[1]],
      stats: { damaged: 0, recomputed: 0, reused: 0 }, diff: null
    };
    rt.recomputed = new Map();
    rt.damaged = new Map();
    var ntx = model.size[0] / tile, nty = model.size[1] / tile;
    var root = model.nodes.get(model.rootId);
    for (var ty = 0; ty < nty; ty++)
      for (var tx = 0; tx < ntx; tx++) ensureGroupTile(rt, root, tx, ty, log);
    // 填画布
    var W = model.size[0];
    var rootCache = groupCache(rt, model.rootId);
    rootCache.forEach(function (e, k) {
      var p = parseKey(k);
      var tb = tilePixelBox(p[0], p[1], tile);
      for (var y = 0; y < tile; y++)
        for (var x = 0; x < tile; x++) {
          var si = (y * tile + x) * 4;
          var gx = tb[0] + x, gy = tb[1] + y;
          var di = (gy * W + gx) * 4;
          rt.canvas[di] = e.data[si]; rt.canvas[di + 1] = e.data[si + 1];
          rt.canvas[di + 2] = e.data[si + 2]; rt.canvas[di + 3] = e.data[si + 3];
        }
    });
    log.recomputedTiles = stringifyMap(rt.recomputed);
    rt.recomputed.forEach(function (set) { log.stats.recomputed += set.size; });
    return log;
  }

  // ---------- 差异比对 ----------

  function diffBuffers(a, b, tol) {
    tol = tol || 2e-3;
    var mismatches = [];
    var n = a.length / 4;
    var maxAbs = 0;
    for (var i = 0; i < n; i++) {
      var d0 = Math.abs(a[i * 4] - b[i * 4]);
      var d1 = Math.abs(a[i * 4 + 1] - b[i * 4 + 1]);
      var d2 = Math.abs(a[i * 4 + 2] - b[i * 4 + 2]);
      var d3 = Math.abs(a[i * 4 + 3] - b[i * 4 + 3]);
      // NaN 不参与正常比较，单独记为无穷大差异，避免静默漏检
      if ([d0, d1, d2, d3].some(Number.isNaN)) {
        mismatches.push({ index: i, maxDiff: Infinity, nan: true });
        maxAbs = Infinity;
        continue;
      }
      var m = Math.max(d0, d1, d2, d3);
      if (m > maxAbs) maxAbs = m;
      if (m > tol) mismatches.push({ index: i, maxDiff: m });
    }
    return { count: mismatches.length, maxAbs: maxAbs, pixels: mismatches };
  }

  // ---------- 像素探针：返回画布某像素沿祖先链各组的输出 ----------

  function probePixel(model, x, y) {
    var chain = [];
    // 从根沿“包含该点”的路径下行（考虑各组 offset / clip）
    function findPath(node, lx, ly, path) {
      path.push({ node: node, x: lx, y: ly });
      if (node.type === 'leaf') return path;
      for (var i = 0; i < node.children.length; i++) {
        var ch = model.nodes.get(node.children[i]);
        if (!ch) continue;
        var off = ch.offset || [0, 0];
        var clx = lx - off[0], cly = ly - off[1];
        if (ch.type === 'leaf') {
          if (rectContainsPoint(ch.box, clx, cly)) return findPath(ch, clx, cly, path);
        } else {
          if (ch.clip && !rectContainsPoint(ch.clip, clx, cly)) continue;
          var box = outputBox(model, ch);
          if (box && clx >= box[0] && cly >= box[1] &&
              clx < box[0] + box[2] && cly < box[1] + box[3]) {
            return findPath(ch, clx, cly, path);
          }
        }
      }
      return path;
    }
    var root = model.nodes.get(model.rootId);
    findPath(root, x, y, chain);

    return chain.map(function (item) {
      var n = item.node;
      var region = [item.x, item.y, 1, 1];
      var rendered = renderNodeFull(model, n, region);
      var v = rendered.buf;
      var a = v[3];
      var unp = [
        a > 0 ? v[0] / a : 0,
        a > 0 ? v[1] / a : 0,
        a > 0 ? v[2] / a : 0,
        a
      ];
      return {
        id: n.id, type: n.type, x: item.x, y: item.y,
        premult: [v[0], v[1], v[2], v[3]],
        unpremult: unp
      };
    });
  }

  // ---------- 导出 ----------

  // 线性预乘 -> sRGB 8-bit（画布合成结果先反预乘）
  function toSrgbBytes(buf) {
    var out = new Uint8ClampedArray(buf.length);
    for (var i = 0; i < buf.length; i += 4) {
      var a = buf[i + 3];
      var lr = a > 0 ? buf[i] / a : 0;
      var lg = a > 0 ? buf[i + 1] / a : 0;
      var lb = a > 0 ? buf[i + 2] / a : 0;
      out[i] = linToSrgb(lr) * 255;
      out[i + 1] = linToSrgb(lg) * 255;
      out[i + 2] = linToSrgb(lb) * 255;
      out[i + 3] = clamp(a, 0, 1) * 255;
    }
    return out;
  }
  function linToSrgb(c) {
    c = clamp(c, 0, 1);
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  var api = {
    TILE: TILE, MAX_NODES: MAX_NODES, MAX_SIZE: MAX_SIZE, MAX_RADIUS: MAX_RADIUS,
    buildModel: buildModel,
    validatePatches: validatePatches,
    fullRender: fullRender,
    createRetained: createRetained,
    prime: prime,
    applyBatch: applyBatch,
    diffBuffers: diffBuffers,
    probePixel: probePixel,
    toSrgbBytes: toSrgbBytes,
    linToSrgb: linToSrgb,
    outputBox: outputBox,
    rect: {
      intersect: rectIntersect, union: rectUnion, expand: rectExpand,
      translate: rectTranslate, contains: rectContainsPoint, valid: rectValid
    },
    // 供测试 / 重置
    _tileKey: tileKey, _parseKey: parseKey, _tilesOverlappingRect: tilesOverlappingRect,
    _boxBlurInPlace: boxBlurInPlace, _fillLeaf: fillLeaf, _blitOver: blitOver,
    _renderNodeFull: renderNodeFull, _computeGroupTile: computeGroupTile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RTEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
