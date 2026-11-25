/*!
 * genlock-key-fill 核心引擎（纯逻辑，无 DOM 依赖）
 *
 * 三级优化目标（按字典优先级）：
 *   1) 配对数最大
 *   2) 总绝对校正时差最小
 *   3) “按排序后填充位置排列的键排序位置序列”字典序最小，空位(null)比任何整数都大（排最后）
 *
 * 约束：模帧号相同；|key.t - fill.t - offset| <= tolerance（含端点）；
 *       一键最多用一次；填充/键的排序位置都严格递增（不可逆序）。
 *
 * UMD：浏览器挂 window.GKEngine；Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GKEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_RECORDS_PER_SIDE = 180000;
  const MAX_CANDIDATES = 1000000;
  const MAX_PNG_FRAMES = 120;
  const MAX_IMAGE_FILES_PER_SIDE = 32;

  class GenlockError extends Error {
    constructor(message, details) {
      super(message);
      this.name = 'GenlockError';
      // details: [{channel, inputPosition, recordNumber, image, reason, ...}]
      this.details = details || [];
    }
  }

  // ---------- 小工具 ----------
  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  function chooseBetter(c1, cost1, c2, cost2) {
    // 返回更优的 (count 大, cost 小)
    if (c2 > c1) return [c2, cost2];
    if (c2 === c1 && cost2 < cost1) return [c2, cost2];
    return [c1, cost1];
  }

  // ---------- 工程校验 ----------
  /**
   * 校验并规范化 project.json。
   * 返回 {width,height,modulus,fillMode,offset,tolerance,fill:[raw],key:[raw]}
   * 只做结构/取值校验，不碰图像字节。
   */
  function validateProject(input) {
    const errors = [];
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new GenlockError('project.json 顶层必须是对象');
    }
    const p = input;

    function intField(name, lo, hi) {
      const v = p[name];
      if (!isInt(v) || v < lo || v > hi) {
        errors.push({ field: name, reason: `${name} 必须是 [${lo}, ${hi}] 内的整数，实际为 ${JSON.stringify(v)}` });
      }
      return v;
    }

    const width = intField('width', 1, 640);
    const height = intField('height', 1, 360);
    const modulus = intField('modulus', 2, 65536);
    const offset = intField('offset', -2147483648, 2147483647);
    const tolerance = intField('tolerance', 0, 4294967295);

    let fillMode = p.fill_mode;
    if (fillMode === 'premultiplied') fillMode = 'premult';
    if (fillMode !== 'straight' && fillMode !== 'premult') {
      errors.push({ field: 'fill_mode', reason: `fill_mode 必须是 "straight" 或 "premult"，实际为 ${JSON.stringify(fillMode)}` });
      fillMode = undefined;
    }

    function checkRecords(name) {
      const arr = p[name];
      if (!Array.isArray(arr)) {
        errors.push({ field: name, reason: `${name} 必须是数组` });
        return [];
      }
      // 约定规模为每路至多 180000 条、32 个不同图像；这里不把规模上限作为硬拒绝条件，
      // 真正的硬保护是候选对上限 MAX_CANDIDATES，超出约定规模的合法结构仍尽量求解。
      arr.forEach((r, idx) => {
        const where = {
          channel: name,
          inputPosition: idx,
          recordNumber: idx + 1,
        };
        if (r === null || typeof r !== 'object' || Array.isArray(r)) {
          errors.push({ ...where, reason: '记录必须是对象' });
          return;
        }
        if (!isInt(r.t) || r.t < 0 || r.t > 1e12) {
          errors.push({ ...where, image: r.image, reason: `t 必须是 0..10^12 的整数，实际 ${JSON.stringify(r.t)}` });
        }
        if (!isInt(r.id) || r.id < 0 || r.id > 4294967295) {
          errors.push({ ...where, image: r.image, reason: `id 必须是 u32 整数(0..4294967295)，实际 ${JSON.stringify(r.id)}` });
        }
        if (typeof r.image !== 'string' || r.image.length === 0) {
          errors.push({ ...where, reason: 'image 必须是非空字符串路径' });
        }
      });
      return arr;
    }

    const fill = checkRecords('fill');
    const key = checkRecords('key');

    if (errors.length) {
      const e = new GenlockError(
        `工程校验失败，共 ${errors.length} 个问题：\n` +
          errors.slice(0, 20).map((x) => '· ' + x.reason).join('\n') +
          (errors.length > 20 ? `\n……另有 ${errors.length - 20} 个问题` : ''),
        errors
      );
      throw e;
    }

    return { width, height, modulus, fillMode, offset, tolerance, fill, key };
  }

  // ---------- 排序：(t, 原始输入位置) ----------
  function sortRecords(raw) {
    const recs = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      recs[i] = {
        t: raw[i].t,
        id: raw[i].id,
        image: raw[i].image,
        inputPosition: i,
        sortedPosition: -1,
      };
    }
    recs.sort((a, b) => (a.t - b.t) || (a.inputPosition - b.inputPosition));
    for (let i = 0; i < recs.length; i++) recs[i].sortedPosition = i;
    return recs;
  }

  // ---------- 候选边生成 ----------
  /**
   * 边按 fill 排序位置连续存放，同一 fill 内 key 排序位置升序。
   * 返回 {edgeKey:Uint32Array(容量MAX), edgeDt:Float64Array, fillStart:Uint32Array(n+1), count}
   * 候选数一旦 > MAX_CANDIDATES 立即抛 CANDIDATE_LIMIT。
   */
  function generateCandidates(fills, keys, modulus, offset, tolerance) {
    const n = fills.length;
    const m = keys.length;
    const fillStart = new Uint32Array(n + 1);

    // 按模帧号余数分组，组内是递增的 key 排序位置（构造时按 j 顺序 push）
    const groups = new Map();
    for (let j = 0; j < m; j++) {
      const r = keys[j].id % modulus;
      let g = groups.get(r);
      if (!g) {
        g = [];
        groups.set(r, g);
      }
      g.push(j);
    }

    // 恰好允许 MAX_CANDIDATES 条；第 MAX+1 条出现即失败
    const edgeKey = new Uint32Array(MAX_CANDIDATES);
    const edgeDt = new Float64Array(MAX_CANDIDATES);
    let E = 0;

    for (let i = 0; i < n; i++) {
      fillStart[i] = E;
      const f = fills[i];
      const r = f.id % modulus;
      const g = groups.get(r);
      if (!g || g.length === 0) continue;

      const loT = f.t + offset - tolerance;
      const hiT = f.t + offset + tolerance;

      // lower_bound key.t >= loT
      let lo = 0;
      let hi = g.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keys[g[mid]].t < loT) lo = mid + 1;
        else hi = mid;
      }
      // upper_bound key.t <= hiT  => first > hiT
      let up = lo;
      hi = g.length;
      while (up < hi) {
        const mid = (up + hi) >> 1;
        if (keys[g[mid]].t <= hiT) up = mid + 1;
        else hi = mid;
      }

      for (let q = lo; q < up; q++) {
        if (E >= MAX_CANDIDATES) {
          throw new GenlockError(
            `可配候选对数量超过上限：最多允许 100 万对（MAX_CANDIDATES=${MAX_CANDIDATES}，即 1,000,000），` +
              `但在填充排序位置 ${i}（原始输入位置 ${f.inputPosition}）处已经要产生第 ${MAX_CANDIDATES + 1} 对（1000001）。` +
              `请收窄容差后重试；本次求解已取消，仍显示上一次成功结果。`,
            [{ kind: 'candidate_limit', limit: MAX_CANDIDATES, limitText: '100万', atFillSorted: i, atFillInput: f.inputPosition }]
          );
        }
        const j = g[q];
        edgeKey[E] = j;
        edgeDt[E] = keys[j].t - f.t - offset;
        E++;
      }
    }
    fillStart[n] = E;

    return { edgeKey, edgeDt, fillStart, count: E };
  }

  // ---------- 后缀 DP + 字典序重建 ----------
  /**
   * 在候选 DAG（i 严格增、j 严格增）上求：
   *   最大对数 -> 最小总 |dt| -> 最小键位置序列。
   * 返回 {pairEdge:Int32Array(n) (-1 表示空), pairCount, totalAbsDt, tailCnt, tailCost}
   */
  function solveMatching(fills, keys, cand) {
    const n = fills.length;
    const m = keys.length;
    const { edgeKey, edgeDt, fillStart, count: E } = cand;

    // Fenwick（反坐标 x = m - j，把 j'>j 的后缀查询变成 x-1 前缀查询）
    const bitCnt = new Uint32Array(m + 1);
    const bitCost = new Float64Array(m + 1);

    // 每条边作为“第一对”之后的最优尾部（不含本边）
    const tailCnt = new Uint32Array(E);
    const tailCost = new Float64Array(E);

    let globalCnt = 0;
    let globalCost = 0;

    for (let i = n - 1; i >= 0; i--) {
      const a = fillStart[i];
      const b = fillStart[i + 1];

      // 1) 先查询：树中只有 i'>i 的边，保证填充严格递增
      for (let e = a; e < b; e++) {
        const j = edgeKey[e];
        const x = m - j; // 1..m
        let bc = 0;
        let bcost = 0;
        for (let p = x - 1; p > 0; p -= p & -p) {
          const [c2, cost2] = chooseBetter(bc, bcost, bitCnt[p], bitCost[p]);
          bc = c2;
          bcost = cost2;
        }
        tailCnt[e] = bc;
        tailCost[e] = bcost;
      }

      // 2) 整组查询完再插入，避免同一 fill 的边互为后继
      for (let e = a; e < b; e++) {
        const j = edgeKey[e];
        const cnt = tailCnt[e] + 1;
        const cost = tailCost[e] + Math.abs(edgeDt[e]);

        const x = m - j;
        for (let p = x; p <= m; p += p & -p) {
          if (cnt > bitCnt[p] || (cnt === bitCnt[p] && cost < bitCost[p])) {
            bitCnt[p] = cnt;
            bitCost[p] = cost;
          }
        }
        [globalCnt, globalCost] = chooseBetter(globalCnt, globalCost, cnt, cost);
      }
    }

    // 3) 从左到右贪心重建字典序最小序列
    const pairEdge = new Int32Array(n);
    for (let i = 0; i < n; i++) pairEdge[i] = -1;

    let jLast = -1;
    let remCnt = globalCnt;
    let remCost = globalCost;
    let pairCount = 0;

    for (let i = 0; i < n; i++) {
      const a = fillStart[i];
      const b = fillStart[i + 1];
      let pick = -1;

      // 同 fill 内 j 升序；第一个“能接出最优后缀”的最小 j 即字典序最优当前位
      for (let e = a; e < b; e++) {
        const j = edgeKey[e];
        if (j <= jLast) continue; // 键严格递增、不可复用
        const c = Math.abs(edgeDt[e]);
        if (tailCnt[e] === remCnt - 1 && tailCost[e] === remCost - c) {
          pick = e;
          break;
        }
      }

      if (pick >= 0) {
        pairEdge[i] = pick;
        jLast = edgeKey[pick];
        remCnt -= 1;
        remCost -= Math.abs(edgeDt[pick]);
        pairCount++;
      }
      // 否则该 fill 必须留空（任何最优方案都不在此配对），remCnt/remCost 不变
    }

    return { pairEdge, pairCount, totalAbsDt: globalCost, optimalCount: globalCnt };
  }

  // ---------- 完整配对表（每个填充排序位置一行） ----------
  function buildTable(fills, keys, cand, matching, params) {
    const { edgeKey, edgeDt } = cand;
    const { pairEdge } = matching;
    const rows = new Array(fills.length);

    for (let i = 0; i < fills.length; i++) {
      const f = fills[i];
      const e = pairEdge[i];
      if (e >= 0) {
        const j = edgeKey[e];
        const k = keys[j];
        const dt = edgeDt[e];
        rows[i] = {
          fill_sorted_position: i,
          fill_original_position: f.inputPosition,
          fill_record_number: f.inputPosition + 1,
          fill_t: f.t,
          fill_id: f.id,
          fill_image: f.image,
          key_sorted_position: j,
          key_original_position: k.inputPosition,
          key_record_number: k.inputPosition + 1,
          key_t: k.t,
          key_id: k.id,
          key_image: k.image,
          dt: dt,
          abs_dt: Math.abs(dt),
          paired: true,
        };
      } else {
        rows[i] = {
          fill_sorted_position: i,
          fill_original_position: f.inputPosition,
          fill_record_number: f.inputPosition + 1,
          fill_t: f.t,
          fill_id: f.id,
          fill_image: f.image,
          key_sorted_position: null,
          key_original_position: null,
          key_record_number: null,
          key_t: null,
          key_id: null,
          key_image: null,
          dt: null,
          abs_dt: null,
          paired: false,
        };
      }
    }
    return rows;
  }

  /**
   * 高层入口：校验已规范化参数 + 求解。
   * project: 已 JSON.parse 的 project 对象（或 validateProject 的返回）
   * overrides: 可选 {offset, tolerance}
   * 返回可序列化 result（含 rows / summary / 排序后的记录）。
   */
  function analyze(project, overrides) {
    const validated = validateProject(project);
    const offset = overrides && Number.isInteger(overrides.offset) ? overrides.offset : validated.offset;
    const tolerance =
      overrides && Number.isInteger(overrides.tolerance) ? overrides.tolerance : validated.tolerance;

    if (offset < -2147483648 || offset > 2147483647) {
      throw new GenlockError('时差校正 offset 必须是有符号 32 位整数');
    }
    if (tolerance < 0 || tolerance > 4294967295) {
      throw new GenlockError('容差 tolerance 必须是 0..4294967295 的整数');
    }

    const fills = sortRecords(validated.fill);
    const keys = sortRecords(validated.key);
    const cand = generateCandidates(fills, keys, validated.modulus, offset, tolerance);
    const matching = solveMatching(fills, keys, cand);
    const rows = buildTable(fills, keys, cand, matching, { offset, tolerance });

    const unpaired = fills.length - matching.pairCount;
    const summary = {
      fill_count: fills.length,
      key_count: keys.length,
      candidate_count: cand.count,
      pair_count: matching.pairCount,
      unpaired_count: unpaired,
      total_abs_dt: matching.totalAbsDt,
      modulus: validated.modulus,
      offset,
      tolerance,
      fill_mode: validated.fillMode,
      width: validated.width,
      height: validated.height,
    };

    return {
      summary,
      rows,
      fills,
      keys,
      // 合成时按 fill sorted i 取 key sorted j；未配为 -1
      keyForFill: Array.from(matching.pairEdge, (e) => (e < 0 ? -1 : cand.edgeKey[e])),
      _cand: cand,
      _matching: matching,
    };
  }

  /** 把配对表转成 CSV 字符串（null -> 空字段）。 */
  function tableToCSV(rows) {
    const cols = [
      'fill_sorted_position',
      'fill_original_position',
      'fill_record_number',
      'fill_t',
      'fill_id',
      'fill_image',
      'key_sorted_position',
      'key_original_position',
      'key_record_number',
      'key_t',
      'key_id',
      'key_image',
      'dt',
      'abs_dt',
      'paired',
    ];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    return lines.join('\r\n');
  }

  return {
    MAX_RECORDS_PER_SIDE,
    MAX_CANDIDATES,
    MAX_PNG_FRAMES,
    MAX_IMAGE_FILES_PER_SIDE,
    GenlockError,
    validateProject,
    sortRecords,
    generateCandidates,
    solveMatching,
    buildTable,
    analyze,
    tableToCSV,
    // 导出给测试
    _chooseBetter: chooseBetter,
  };
});
