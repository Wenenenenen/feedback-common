/* paper-grid-evidence — 核心：解析、短边代价、求解编排、导出。
 *
 * 输入（一个样本）：
 *   scan.pgm  8 位 P5 灰度图（宽高 ≤ 512）
 *   mask.pgm  可选，同尺寸 8 位 P5；像素 0 表示该像素不参与统计
 *   grid.json { "xs": [...], "ys": [...], "locks": [...] }
 *     xs、ys 为递增整数像素坐标，相邻至少差 2；R = len(ys)-1，C = len(xs)-1；
 *     v(row,col) 在 xs[col] 上跨 ys[row]..ys[row+1]，h(row,col) 在 ys[row] 上跨 xs[col]..xs[col+1]；
 *     locks 项为 { axis:'v'|'h', row, col, keep:boolean }。
 *
 * 短边代价：只取格线上不含两端的像素；掩膜为 0 的像素不计。
 *   keep   = 这些像素灰度之和
 *   remove = 这些像素 (255 - 灰度) 之和
 * 若一条边的样本像素全被掩膜剔除（有效像素为 0），两种代价都记为 0，
 * 但有效像素数会单独保留，界面据此提示复核。
 *
 * 本文件不依赖任何第三方库，同时导出为浏览器全局 PaperGridCore 与 CommonJS。
 */
(function (root) {
  'use strict';

  var MAX_DIM = 512;
  var MAX_ROWS = 24;
  var MAX_COLS = 8;
  var CASE_FILES = { scan: 'scan.pgm', mask: 'mask.pgm', grid: 'grid.json' };

  // ---------------- 字节工具 ----------------
  function ascii(bytes, start, end) {
    var s = '';
    for (var i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') {
      var buf = Buffer.from(b64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    throw new Error('当前环境缺少 base64 解码能力');
  }

  // ---------------- ZIP 读取（store / deflate，无加密） ----------------
  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

  function findEOCD(b) {
    if (b.length < 22) return -1;
    var stop = Math.max(0, b.length - 65557);
    for (var i = b.length - 22; i >= stop; i--) {
      if (u32(b, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function readZip(bytes) {
    var eocd = findEOCD(bytes);
    if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录尾）');
    var count = u16(bytes, eocd + 10);
    var cdOff = u32(bytes, eocd + 16);
    var entries = {};
    var p = cdOff;
    for (var i = 0; i < count; i++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
      var method = u16(bytes, p + 10);
      var compSize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commLen = u16(bytes, p + 32);
      var localOff = u32(bytes, p + 42);
      var name = ascii(bytes, p + 46, p + 46 + nameLen);
      if (name.charAt(name.length - 1) !== '/') {
        entries[name] = { method: method, compSize: compSize, localOff: localOff };
      }
      p += 46 + nameLen + extraLen + commLen;
    }
    return entries;
  }

  function extractZipEntry(bytes, entry, inflateRaw) {
    var p = entry.localOff;
    if (u32(bytes, p) !== 0x04034b50) throw new Error('zip 本地文件头损坏');
    var nameLen = u16(bytes, p + 26);
    var extraLen = u16(bytes, p + 28);
    var start = p + 30 + nameLen + extraLen;
    var data = bytes.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method === 8) return Promise.resolve(inflateRaw(data));
    return Promise.reject(new Error('不支持的 zip 压缩方法 ' + entry.method));
  }

  // inflateRaw(data) 返回 Uint8Array 或其 Promise。浏览器用 DecompressionStream 注入。
  function readZipAsync(bytes, inflateRaw) {
    var entries = readZip(bytes);
    var names = Object.keys(entries);
    var result = {};
    var chain = Promise.resolve();
    names.forEach(function (name) {
      chain = chain.then(function () {
        return extractZipEntry(bytes, entries[name], inflateRaw).then(function (data) {
          result[name] = data;
        });
      });
    });
    return chain.then(function () { return result; });
  }

  // ---------------- PGM（P5）解析 ----------------
  function parsePGM(bytes) {
    if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x35) {
      throw new Error('仅支持 P5 二进制 PGM');
    }
    var pos = 2, fields = [];
    while (fields.length < 3) {
      while (pos < bytes.length) {
        var ch = bytes[pos];
        if (ch === 0x23) {
          while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
          continue;
        }
        if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) { pos++; continue; }
        break;
      }
      var start = pos;
      while (pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) pos++;
      if (pos === start) throw new Error('PGM 头部字段损坏');
      fields.push(parseInt(ascii(bytes, start, pos), 10));
    }
    if (fields[2] > 255) throw new Error('仅支持 8 位 PGM（最大灰度 ≤ 255）');
    if (pos >= bytes.length || !(bytes[pos] === 0x20 || bytes[pos] === 0x09 ||
        bytes[pos] === 0x0a || bytes[pos] === 0x0d)) {
      throw new Error('PGM 头部缺少分隔空白');
    }
    pos++;
    var w = fields[0], h = fields[1];
    if (w < 1 || h < 1) throw new Error('PGM 尺寸非法');
    if (w > MAX_DIM || h > MAX_DIM) throw new Error('图像尺寸超过 512×512');
    var need = w * h;
    if (bytes.length - pos < need) throw new Error('PGM 像素数据不足：需要 ' + need + ' 字节');
    var data = new Uint8Array(need);
    data.set(bytes.subarray(pos, pos + need));
    return { width: w, height: h, maxval: fields[2], data: data };
  }

  // ---------------- grid.json 校验 ----------------
  function validCoordList(arr, name) {
    if (!Array.isArray(arr)) throw new Error(name + ' 必须是数组');
    if (arr.length < 2) throw new Error(name + ' 至少需要 2 个坐标');
    for (var i = 0; i < arr.length; i++) {
      if (!Number.isInteger(arr[i]) || arr[i] < 0) throw new Error(name + ' 必须是非负整数');
      if (i > 0 && arr[i] - arr[i - 1] < 2) throw new Error(name + ' 相邻坐标至少相差 2');
    }
  }

  function parseGrid(gridObj) {
    if (!gridObj || typeof gridObj !== 'object') throw new Error('缺少 grid.json 内容');
    var xs = gridObj.xs, ys = gridObj.ys;
    validCoordList(xs, 'xs');
    validCoordList(ys, 'ys');
    var R = ys.length - 1, C = xs.length - 1;
    if (R > MAX_ROWS) throw new Error('基础网格最多 24 行（当前 ' + R + ' 行）');
    if (C > MAX_COLS) throw new Error('基础网格最多 8 列（当前 ' + C + ' 列）');
    var locks = [];
    if (gridObj.locks !== undefined) {
      if (!Array.isArray(gridObj.locks)) throw new Error('locks 必须是数组');
      for (var i = 0; i < gridObj.locks.length; i++) {
        var L = gridObj.locks[i];
        if (!L || (L.axis !== 'v' && L.axis !== 'h') || typeof L.keep !== 'boolean' ||
            !Number.isInteger(L.row) || !Number.isInteger(L.col)) {
          throw new Error('locks 第 ' + (i + 1) + ' 项字段非法');
        }
        var inRange = L.axis === 'v'
          ? (L.row >= 0 && L.row < R && L.col >= 1 && L.col < C)
          : (L.row >= 1 && L.row < R && L.col >= 0 && L.col < C);
        if (!inRange) throw new Error('locks 第 ' + (i + 1) + ' 项坐标越界');
        locks.push({ axis: L.axis, row: L.row, col: L.col, keep: L.keep });
      }
    }
    return { xs: xs.slice(), ys: ys.slice(), R: R, C: C, locks: locks };
  }

  function validateGridImage(grid, scan) {
    var i;
    for (i = 0; i < grid.xs.length; i++) {
      if (grid.xs[i] >= scan.width) throw new Error('xs[' + i + ']=' + grid.xs[i] + ' 超出图像宽度 ' + scan.width);
    }
    for (i = 0; i < grid.ys.length; i++) {
      if (grid.ys[i] >= scan.height) throw new Error('ys[' + i + ']=' + grid.ys[i] + ' 超出图像高度 ' + scan.height);
    }
  }

  // ---------------- 短边代价计算 ----------------
  function edgeCosts(scan, mask, grid) {
    var xs = grid.xs, ys = grid.ys, R = grid.R, C = grid.C;
    var W = scan.width, H = scan.height;
    var px = scan.data, mk = mask ? mask.data : null;
    var vKeep = new Float64Array(R * (C - 1));
    var vRem = new Float64Array(R * (C - 1));
    var vN = new Int32Array(R * (C - 1));
    var hKeep = new Float64Array((R - 1) * C);
    var hRem = new Float64Array((R - 1) * C);
    var hN = new Int32Array((R - 1) * C);
    var r, c, y, x, g, idx;
    for (r = 0; r < R; r++) {
      for (c = 1; c < C; c++) {
        var xLine = xs[c];
        var kSum = 0, rSum = 0, n = 0;
        for (y = ys[r] + 1; y < ys[r + 1]; y++) {
          if (y < 0 || y >= H) continue;
          idx = y * W + xLine;
          if (mk && mk[idx] === 0) continue;
          g = px[idx];
          kSum += g; rSum += 255 - g; n++;
        }
        var e = r * (C - 1) + (c - 1);
        vKeep[e] = kSum; vRem[e] = rSum; vN[e] = n;
      }
    }
    for (r = 1; r < R; r++) {
      for (c = 0; c < C; c++) {
        var yLine = ys[r];
        var kS = 0, rS = 0, m = 0;
        for (x = xs[c] + 1; x < xs[c + 1]; x++) {
          if (x < 0 || x >= W) continue;
          idx = yLine * W + x;
          if (mk && mk[idx] === 0) continue;
          g = px[idx];
          kS += g; rS += 255 - g; m++;
        }
        var e2 = (r - 1) * C + c;
        hKeep[e2] = kS; hRem[e2] = rS; hN[e2] = m;
      }
    }
    return { vKeep: vKeep, vRem: vRem, vN: vN, hKeep: hKeep, hRem: hRem, hN: hN };
  }

  function edgeId(axis, row, col) { return axis + ',' + row + ',' + col; }

  function solveCase(scan, mask, grid, solver, options) {
    if (!solver || typeof solver.solve !== 'function') throw new Error('缺少求解器');
    options = options || {};
    var costs = edgeCosts(scan, mask, grid);
    var locks = (options.locks || grid.locks || []).map(toSolverLock);
    var result = solver.solve({
      R: grid.R, C: grid.C,
      vKeep: costs.vKeep, vRem: costs.vRem,
      hKeep: costs.hKeep, hRem: costs.hRem,
      locks: locks,
      force: options.force || null
    });
    var edges = [];
    var r, c;
    for (r = 0; r < grid.R; r++) {
      for (c = 1; c < grid.C; c++) {
        var i = r * (grid.C - 1) + (c - 1);
        edges.push({
          axis: 'v', row: r, col: c,
          keep: costs.vKeep[i], remove: costs.vRem[i], samples: costs.vN[i]
        });
      }
    }
    for (r = 1; r < grid.R; r++) {
      for (c = 0; c < grid.C; c++) {
        var j = (r - 1) * grid.C + c;
        edges.push({
          axis: 'h', row: r, col: c,
          keep: costs.hKeep[j], remove: costs.hRem[j], samples: costs.hN[j]
        });
      }
    }
    var out = { costs: costs, result: result, edges: edges };
    if (result.feasible) {
      out.decisions = solver.decisionsFromRects(grid.R, grid.C, result.rects);
    }
    return out;
  }

  function toSolverLock(L) {
    return { axis: L.axis, row: L.row, col: L.col, keep: L.keep };
  }

  // ---------------- 样本文件发现与构建 ----------------
  // files: { path: Uint8Array }。按目录分组，每个含 scan.pgm/mask.pgm/grid.json 的目录是一个样本。
  function groupCaseFiles(files) {
    var groups = new Map();
    Object.keys(files).forEach(function (path) {
      var slash = path.lastIndexOf('/');
      var dir = slash >= 0 ? path.slice(0, slash) : '';
      var base = path.slice(slash + 1).toLowerCase();
      if (base !== CASE_FILES.scan && base !== CASE_FILES.mask && base !== CASE_FILES.grid) return;
      if (!groups.has(dir)) groups.set(dir, {});
      groups.get(dir)[base] = files[path];
    });
    return groups;
  }

  function buildCase(raw, name, prefix) {
    var label = name || raw.dir || prefix || '样本';
    if (!raw.scan) throw new Error('缺少 scan.pgm');
    if (!raw.grid) throw new Error('缺少 grid.json');
    var scan = parsePGM(raw.scan);
    var mask = raw.mask ? parsePGM(raw.mask) : null;
    if (mask && (mask.width !== scan.width || mask.height !== scan.height)) {
      throw new Error('掩膜尺寸 ' + mask.width + '×' + mask.height +
        ' 与原图 ' + scan.width + '×' + scan.height + ' 不一致');
    }
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw.grid);
    } catch (e) {
      throw new Error('grid.json 不是有效的 UTF-8 文本');
    }
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('grid.json 解析失败：' + e.message);
    }
    var grid = parseGrid(obj);
    validateGridImage(grid, scan);
    return { name: label, scan: scan, mask: mask, grid: grid };
  }

  // 从一组文件映射得到 { cases, errors }；prefix 用作根目录样本名。
  function casesFromFiles(files, prefix) {
    var groups = groupCaseFiles(files);
    var cases = [], errors = [];
    groups.forEach(function (raw, dir) {
      var name = dir ? dir.split('/').pop() : (prefix || '样本');
      try {
        cases.push(buildCase({ dir: dir, scan: raw['scan.pgm'], mask: raw['mask.pgm'], grid: raw['grid.json'] }, name, prefix));
      } catch (e) {
        errors.push({ name: name, message: e.message });
      }
    });
    if (!groups.size) throw new Error('没有找到 scan.pgm / mask.pgm / grid.json');
    if (!cases.length) {
      var first = errors[0];
      throw new Error(first ? first.name + '：' + first.message : '没有可用样本');
    }
    return { cases: cases, errors: errors };
  }

  // ---------------- 导出 JSON ----------------
  function decisionOfEdge(solved, grid, edge) {
    if (!solved.decisions) return null;
    var kept = edge.axis === 'v'
      ? solved.decisions.v[edge.row * (grid.C - 1) + (edge.col - 1)] === 1
      : solved.decisions.h[(edge.row - 1) * grid.C + edge.col] === 1;
    return kept ? 'keep' : 'remove';
  }

  function exportJSON(caseData) {
    var grid = caseData.grid, res = caseData.solved.result;
    var locks = (caseData.locks || grid.locks || []).map(function (L) {
      return { axis: L.axis, row: L.row, col: L.col, keep: L.keep };
    });
    var obj = {
      format: 'paper-grid-evidence/merge-review',
      version: 1,
      image: { width: caseData.scan.width, height: caseData.scan.height },
      grid: { xs: grid.xs.slice(), ys: grid.ys.slice(), rows: grid.R, cols: grid.C },
      hasMask: !!caseData.mask,
      feasible: res.feasible,
      totalLoss: res.feasible ? res.loss : null,
      rectangleCount: res.feasible ? res.count : null,
      rectangles: res.feasible ? res.rects.map(function (r) {
        return { top: r[0], left: r[1], bottom: r[2], right: r[3] };
      }) : [],
      edges: caseData.solved.edges.map(function (e) {
        var dec = decisionOfEdge(caseData.solved, grid, e);
        return {
          axis: e.axis, row: e.row, col: e.col,
          keepLoss: e.keep, removeLoss: e.remove, samples: e.samples,
          decision: dec
        };
      }),
      locks: locks
    };
    if (!res.feasible) obj.reason = res.reason;
    return obj;
  }

  var PaperGridCore = {
    MAX_DIM: MAX_DIM, MAX_ROWS: MAX_ROWS, MAX_COLS: MAX_COLS,
    readZip: readZip, readZipAsync: readZipAsync,
    parsePGM: parsePGM, parseGrid: parseGrid, validateGridImage: validateGridImage,
    edgeCosts: edgeCosts, solveCase: solveCase, exportJSON: exportJSON,
    b64ToBytes: b64ToBytes, edgeId: edgeId, decisionOfEdge: decisionOfEdge,
    groupCaseFiles: groupCaseFiles, buildCase: buildCase, casesFromFiles: casesFromFiles
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PaperGridCore;
  root.PaperGridCore = PaperGridCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
