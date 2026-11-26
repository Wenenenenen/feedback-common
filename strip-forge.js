/*
 * ordered-strip-forge
 *
 * 自研的有向三角形条带编码器/解码器。不使用任何现成 triangle-strip 生成器。
 * 同时支持浏览器经典脚本和 Node CommonJS。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StripForge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INF = Number.POSITIVE_INFINITY;
  const MAX_FACES = 100000;
  const MAX_VERTEX = 2147483647;
  const RESTART = -1;

  class PackError extends Error {
    constructor(message, details) {
      super(message);
      this.name = 'PackError';
      this.details = details || {};
    }
  }

  function isIntInRange(x, min, max) {
    return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
  }

  function uniqSorted(values) {
    return Array.from(new Set(values)).sort((a, b) => a - b);
  }

  /*
   * 校验并规范化输入。分组号一旦离开某个组，该组号不能在后面再次出现：
   * 格式约定要求每个 group 是连续同组号区间。
   */
  function validateDocument(doc) {
    if (typeof doc === 'string') {
      try {
        doc = JSON.parse(doc);
      } catch (e) {
        throw new PackError('JSON 解析失败：' + e.message);
      }
    }
    if (Array.isArray(doc)) doc = { faces: doc };
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.faces)) {
      throw new PackError('文件必须包含 faces 数组');
    }
    if (doc.faces.length === 0) return [];
    if (doc.faces.length > MAX_FACES) {
      throw new PackError('最多支持 ' + MAX_FACES + ' 个三角形，当前有 ' + doc.faces.length + ' 个');
    }

    const faces = new Array(doc.faces.length);
    const seenGroups = new Set();
    let currentGroup = null;

    for (let i = 0; i < doc.faces.length; i++) {
      const f = doc.faces[i];
      const where = '第 ' + (i + 1) + ' 个面';
      if (!f || typeof f !== 'object') {
        throw new PackError(where + ' 必须是对象', { faceIndex: i });
      }
      if (!Array.isArray(f.v) || f.v.length !== 3) {
        throw new PackError(where + ' 的 v 必须是三个整数', { faceIndex: i });
      }
      const v = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        if (!isIntInRange(f.v[k], 0, MAX_VERTEX)) {
          throw new PackError(where + ' 的 v[' + k + '] 必须是 0..2147483647 的整数', {
            faceIndex: i,
            vertexIndex: k
          });
        }
        v[k] = f.v[k];
      }
      if (v[0] === v[1] || v[0] === v[2] || v[1] === v[2]) {
        throw new PackError(where + ' 的三个顶点必须互异', { faceIndex: i });
      }

      if (!isIntInRange(f.group, 0, Number.MAX_SAFE_INTEGER)) {
        throw new PackError(where + ' 的 group 必须是非负整数', { faceIndex: i });
      }
      const group = f.group;
      if (group !== currentGroup) {
        if (seenGroups.has(group)) {
          throw new PackError('分组 ' + group + ' 不是连续区间；每个绘制组必须连续', {
            faceIndex: i,
            group
          });
        }
        seenGroups.add(group);
        currentGroup = group;
      }

      let last = f.last === undefined ? null : f.last;
      if (last !== null) {
        if (!isIntInRange(last, 0, MAX_VERTEX) || v.indexOf(last) < 0) {
          throw new PackError(where + ' 的 last 必须为 null 或该面顶点之一', {
            faceIndex: i
          });
        }
      }

      faces[i] = { v, group, last };
    }
    return faces;
  }

  function cyclicRotations(v) {
    return [
      [v[0], v[1], v[2]],
      [v[1], v[2], v[0]],
      [v[2], v[0], v[1]]
    ];
  }

  /*
   * 一个“面后状态”记录当前实面窗口之后的原始末两索引，以及下一个滑窗奇偶。
   *
   * 规范窗口 C：
   *   parity=0: C = raw
   *   parity=1: C = [raw[1], raw[0], raw[2]]
   *
   * 因此：
   *   p=0 时 raw=C，末两索引为 C[1],C[2]
   *   p=1 时 raw=[C[1],C[0],C[2]]，末两索引为 C[0],C[2]
   */
  function buildStates(face) {
    const out = [];
    const rotations = cyclicRotations(face.v);
    for (let r = 0; r < rotations.length; r++) {
      const c = rotations[r];
      if (face.last !== null && c[2] !== face.last) continue;
      for (let p = 0; p < 2; p++) {
        let x, y;
        if (p === 0) {
          x = c[1];
          y = c[2];
        } else {
          x = c[0];
          y = c[2];
        }
        out.push({
          idx: out.length,
          c,
          rotation: r,
          p,
          x,
          y,
          q: p ^ 1
        });
      }
    }
    return out;
  }

  function findStateIndex(states, x, y, q) {
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (s.x === x && s.y === y && s.q === q) return i;
    }
    return -1;
  }

  function canonicalMatchesFace(face, c) {
    const v = face.v;
    if (c[0] === v[0]) return c[1] === v[1] && c[2] === v[2];
    if (c[0] === v[1]) return c[1] === v[2] && c[2] === v[0];
    if (c[0] === v[2]) return c[1] === v[0] && c[2] === v[1];
    return false;
  }

  function createPlanner(faces, statesByFace, rem) {
    function headChoices(plan) {
      const j = plan.j;
      const k = plan.prefix.length;
      const prefix = plan.prefix;
      const byToken = new Map();

      for (const s of statesByFace[j]) {
        if (s.p !== 0) continue;
        let ok = true;
        for (let i = 0; i < k; i++) {
          if (s.c[i] !== prefix[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        const token = s.c[k];
        if (byToken.has(token)) continue;

        let next;
        if (k === 2) {
          next = { kind: 'boundary', i: j, s: s.idx };
        } else {
          const np = prefix.slice();
          np.push(token);
          next = { kind: 'head', j, prefix: np };
        }
        byToken.set(token, { token, next });
      }

      return Array.from(byToken.values()).sort((a, b) => a.token - b.token);
    }

    function continuationChoices(plan) {
      const face = faces[plan.j];
      const out = [];

      for (const token of plan.allowed) {
        const nx = plan.y;
        const ny = token;
        const nq = plan.q ^ 1;
        const duplicate =
          plan.x === plan.y || plan.x === token || plan.y === token;

        if (duplicate) {
          // 最多三个退化窗口；当前 d 是已经经过的退化窗数。
          if (plan.d >= 3) continue;
          out.push({
            token,
            next: {
              kind: 'cont',
              j: plan.j,
              x: nx,
              y: ny,
              q: nq,
              d: plan.d + 1,
              allowed: plan.allowed
            }
          });
          continue;
        }

        const raw = [plan.x, plan.y, token];
        const canonical =
          plan.q === 0 ? raw : [raw[1], raw[0], raw[2]];

        if (!canonicalMatchesFace(face, canonical)) continue;
        if (face.last !== null && token !== face.last) continue;

        const sidx = findStateIndex(statesByFace[plan.j], nx, ny, nq);
        if (sidx < 0) continue;

        out.push({
          token,
          next: { kind: 'boundary', i: plan.j, s: sidx }
        });
      }

      return out;
    }

    function bridgeChoices(plan) {
      const target = faces[plan.j];
      const out = [];

      // 跨组必须重启。同组也允许选择重启；-1 在字典序中小于所有顶点 ID。
      if (!plan.forced) {
        const src = statesByFace[plan.i][plan.s];
        const allowed = uniqSorted([src.x, src.y, target.v[0], target.v[1], target.v[2]]);
        const preliminary = {
          kind: 'cont',
          j: plan.j,
          x: src.x,
          y: src.y,
          q: src.q,
          d: 0,
          allowed
        };
        for (const ch of continuationChoices(preliminary)) {
          out.push(ch);
        }
      }

      out.push({ token: RESTART, next: { kind: 'head', j: plan.j, prefix: [] } });
      out.sort((a, b) => a.token - b.token);
      return out;
    }

    function choices(plan) {
      if (plan.kind === 'head') return headChoices(plan);
      if (plan.kind === 'cont') return continuationChoices(plan);
      if (plan.kind === 'bridge') return bridgeChoices(plan);
      return [];
    }

    function headCost(j, prefix) {
      const k = prefix.length;
      let best = INF;
      for (const s of statesByFace[j]) {
        if (s.p !== 0) continue;
        let ok = true;
        for (let i = 0; i < k; i++) {
          if (s.c[i] !== prefix[i]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          const value = (3 - k) + rem[j][s.idx];
          if (value < best) best = value;
        }
      }
      return best;
    }

    function continuationCost(j, x, y, q, d, allowed) {
      let best = INF;

      for (const token of allowed) {
        const duplicate = x === y || x === token || y === token;
        if (duplicate) {
          if (d < 3) {
            const value = 1 + continuationCost(j, y, token, q ^ 1, d + 1, allowed);
            if (value < best) best = value;
          }
          continue;
        }

        const raw = [x, y, token];
        const canonical = q === 0 ? raw : [raw[1], raw[0], raw[2]];
        const face = faces[j];
        if (!canonicalMatchesFace(face, canonical)) continue;
        if (face.last !== null && token !== face.last) continue;

        const sidx = findStateIndex(statesByFace[j], y, token, q ^ 1);
        if (sidx >= 0) {
          const value = 1 + rem[j][sidx];
          if (value < best) best = value;
        }
      }

      return best;
    }

    function allowedForBridge(plan) {
      const src = statesByFace[plan.i][plan.s];
      const target = faces[plan.j];
      // 不用 Set/排序热路径；最多五个值，手工去重。
      const rawAllowed = [src.x, src.y, target.v[0], target.v[1], target.v[2]];
      const allowed = [];
      for (const t of rawAllowed) {
        if (allowed.indexOf(t) < 0) allowed.push(t);
      }
      return allowed;
    }

    function shortest(plan) {
      if (plan.kind === 'boundary') {
        return rem[plan.i][plan.s];
      }
      if (plan.kind === 'head') {
        return headCost(plan.j, plan.prefix);
      }
      if (plan.kind === 'cont') {
        return continuationCost(
          plan.j,
          plan.x,
          plan.y,
          plan.q,
          plan.d,
          plan.allowed
        );
      }
      if (plan.kind === 'bridge') {
        // -1 本身一个索引，之后还需目标面的三个起始索引/后缀 DP。
        let best = 1 + headCost(plan.j, []);
        if (!plan.forced) {
          const src = statesByFace[plan.i][plan.s];
          const value = continuationCost(
            plan.j,
            src.x,
            src.y,
            src.q,
            0,
            allowedForBridge(plan)
          );
          if (value < best) best = value;
        }
        return best;
      }
      return INF;
    }

    return { choices, shortest, headCost, continuationCost };
  }

  function decodeIndices(indices) {
    const windows = [];
    const segments = [];
    let segment = -1;
    let raw = [];
    let positions = [];

    function startSegment(markerPosition) {
      segment += 1;
      segments.push({
        index: segment,
        marker: markerPosition,
        start: markerPosition < 0 ? 0 : markerPosition + 1,
        windows: 0,
        solid: 0,
        degenerate: 0
      });
      raw = [];
      positions = [];
    }

    startSegment(-1);

    for (let pos = 0; pos < indices.length; pos++) {
      const value = indices[pos];
      if (value === RESTART) {
        startSegment(pos);
        continue;
      }

      raw.push(value);
      positions.push(pos);

      if (raw.length < 3) continue;

      const windowIndex = raw.length - 3;
      const start = positions[windowIndex];
      const w0 = raw[windowIndex];
      const w1 = raw[windowIndex + 1];
      const w2 = raw[windowIndex + 2];
      const rawTriple = [w0, w1, w2];
      const parity = windowIndex & 1;
      const canonical = parity === 0 ? [w0, w1, w2] : [w1, w0, w2];
      const degenerate = w0 === w1 || w0 === w2 || w1 === w2;

      const record = {
        index: windows.length,
        segment,
        windowIndex,
        start,
        end: start + 2,
        parity,
        raw: rawTriple,
        canonical,
        last: w2,
        degenerate
      };
      windows.push(record);
      const seg = segments[segment];
      seg.windows += 1;
      if (degenerate) seg.degenerate += 1;
      else seg.solid += 1;
    }

    return { windows, segments };
  }

  function packDocument(doc) {
    const started = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    const faces = validateDocument(doc);
    const n = faces.length;
    const statesByFace = faces.map(buildStates);
    const remByFace = new Array(n);

    if (n > 0) {
      remByFace[n - 1] = new Array(statesByFace[n - 1].length).fill(0);
    }

    const planner = createPlanner(faces, statesByFace, remByFace);

    for (let i = n - 2; i >= 0; i--) {
      const states = statesByFace[i];
      remByFace[i] = new Array(states.length).fill(INF);
      const forced = faces[i].group !== faces[i + 1].group;

      for (let s = 0; s < states.length; s++) {
        remByFace[i][s] = planner.shortest({
          kind: 'bridge',
          i,
          j: i + 1,
          s,
          forced
        });
      }
    }

    const indices = [];
    if (n > 0) {
      let plan = { kind: 'head', j: 0, prefix: [] };

      while (true) {
        if (plan.kind === 'boundary') {
          if (plan.i === n - 1) break;
          plan = {
            kind: 'bridge',
            i: plan.i,
            j: plan.i + 1,
            s: plan.s,
            forced: faces[plan.i].group !== faces[plan.i + 1].group
          };
          continue;
        }

        const target = planner.shortest(plan);
        if (!Number.isFinite(target)) {
          throw new PackError('找不到合法条带编码', { plan });
        }
        const choices = planner.choices(plan);
        let selected = null;
        for (const ch of choices) {
          if (1 + planner.shortest(ch.next) === target) {
            selected = ch;
            break; // choices 已按 token 升序，第一个可行项即字典序最小。
          }
        }
        if (!selected) throw new PackError('字典序重建失败', { plan });

        indices.push(selected.token);
        plan = selected.next;
      }
    }

    const decoded = decodeIndices(indices);
    const solidWindows = decoded.windows.filter((w) => !w.degenerate);

    if (solidWindows.length !== n) {
      throw new PackError('内部校验失败：实面窗口数量不为 ' + n, {
        solid: solidWindows.length
      });
    }

    const mapping = solidWindows.map((w, i) => {
      const f = faces[i];
      w.faceIndex = i;
      if (!canonicalMatchesFace(f, w.canonical)) {
        throw new PackError('内部校验失败：解码绕序与原面不一致', { faceIndex: i });
      }
      if (f.last !== null && w.last !== f.last) {
        throw new PackError('内部校验失败：平面着色末顶点不一致', { faceIndex: i });
      }
      return {
        originalIndex: i,
        face: i,
        group: f.group,
        last: f.last,
        windowRecord: w.index,
        windowStart: w.start,
        windowIndex: w.windowIndex,
        parity: w.parity,
        segment: w.segment,
        raw: w.raw.slice(),
        canonical: w.canonical.slice()
      };
    });

    // 补充组内条带编号。
    let lastGroup = null;
    let groupStripOrdinal = -1;
    let lastSegment = -1;
    for (const m of mapping) {
      if (m.group !== lastGroup) {
        lastGroup = m.group;
        groupStripOrdinal = 0;
        lastSegment = m.segment;
      } else if (m.segment !== lastSegment) {
        groupStripOrdinal += 1;
        lastSegment = m.segment;
      }
      m.stripInGroup = groupStripOrdinal;
    }

    const finished = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    const restartCount = indices.reduce((acc, x) => acc + (x === RESTART ? 1 : 0), 0);
    const degenerateCount = decoded.windows.reduce((acc, w) => acc + (w.degenerate ? 1 : 0), 0);

    return {
      ok: true,
      indices,
      length: indices.length,
      faces,
      mapping,
      windows: decoded.windows,
      segments: decoded.segments,
      stats: {
        faceCount: n,
        indexCount: indices.length,
        restartCount,
        degenerateWindowCount: degenerateCount,
        solidWindowCount: solidWindows.length,
        windowCount: decoded.windows.length,
        packMs: finished - started
      }
    };
  }

  /*
   * 对外部结果做一次面向约定的完整校验。packDocument 自身已用同一套状态规则，
   * 这里额外从整数流独立扫描并检查组间重启、退化窗数量和连接索引集合。
   */
  function verifyResult(doc, result) {
    const faces = validateDocument(doc);
    const errors = [];
    const indices = result && result.indices;
    if (!Array.isArray(indices)) return { ok: false, errors: ['结果缺少 indices'] };

    const decoded = decodeIndices(indices);
    const solid = decoded.windows.filter((w) => !w.degenerate);
    if (solid.length !== faces.length) {
      errors.push('实面窗口数 ' + solid.length + ' != 原面数 ' + faces.length);
    }

    for (let i = 0; i < Math.min(solid.length, faces.length); i++) {
      const w = solid[i];
      const f = faces[i];
      if (!canonicalMatchesFace(f, w.canonical)) {
        errors.push('面 #' + i + ' 的还原绕序不一致');
      }
      if (f.last !== null && w.last !== f.last) {
        errors.push('面 #' + i + ' 的指定末顶点不一致');
      }
    }

    if (faces.length > 0) {
      if (!result.mapping || result.mapping[0].windowStart !== 0 || indices[0] === RESTART) {
        errors.push('首面必须从全流偏移 0 的三个索引开始，不能有前导重启或退化窗');
      }
      const lastMapping = result.mapping && result.mapping[faces.length - 1];
      if (lastMapping && lastMapping.windowStart + 2 !== indices.length - 1) {
        errors.push('最后一个实面窗口必须正好结束于整数流末尾，不能有尾部索引');
      }
    }

    // 按流位置检查相邻实面间结构。
    for (let i = 1; i < faces.length; i++) {
      const a = result.mapping && result.mapping[i - 1];
      const b = result.mapping && result.mapping[i];
      if (!a || !b) continue;

      const bridgeTokens = indices.slice(a.windowStart + 3, b.windowStart + 3);
      const groupChanged = faces[i - 1].group !== faces[i].group;
      const hasRestart = bridgeTokens.indexOf(RESTART) >= 0;

      if (groupChanged) {
        if (bridgeTokens.length !== 4 || bridgeTokens[0] !== RESTART) {
          errors.push('面 #' + i + ' 跨组必须正好有一个 -1 和下一面三个起始索引');
        }
      } else if (hasRestart) {
        if (bridgeTokens.length !== 4 || bridgeTokens[0] !== RESTART) {
          errors.push('面 #' + i + ' 同组重启段只能为 -1 加下一面三个索引');
        }
      } else {
        // d 个退化窗 + 一个实面窗 => d+1 个新索引，d<=3。
        const appended = bridgeTokens;
        const d = appended.length - 1;
        if (d < 0 || d > 3) {
          errors.push('面 #' + i + ' 间连接索引数量越界: ' + appended.length);
        }

        const allowed = new Set([a.raw[1], a.raw[2], ...faces[i].v]);
        for (const t of appended) {
          if (!allowed.has(t)) errors.push('面 #' + i + ' 使用了约定集合外的连接索引 ' + t);
        }
      }
    }

    return { ok: errors.length === 0, errors, decoded };
  }

  return {
    PackError,
    RESTART,
    MAX_FACES,
    validateDocument,
    packDocument,
    decodeIndices,
    verifyResult,
    // 导出内部辅助便于单元测试/穷举对照。
    _internal: {
      buildStates,
      canonicalMatchesFace,
      createPlanner,
      cyclicRotations
    }
  };
});
