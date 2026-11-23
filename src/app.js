// 争地地图版本校验 —— 网页应用层（依赖 engine.js 的 window.FrontierEngine）
'use strict';

(function () {
  const E = window.FrontierEngine;

  // -------------------------------------------------------------------------
  // 应用状态
  // -------------------------------------------------------------------------
  const state = {
    project: null,          // {rows, edits, queries}
    currentVersion: 0,
    selectedCell: null,     // {x,y}
    highlightCells: null,   // Int32Array | null
    queryDraft: [],         // 待批查询（可在导入 queries 之外手工增删）
    useImportedQueries: true,
    charToCode: null,
    codeToChar: null,
    palette: null,
    fileName: '',
  };

  // 阵营字符 -> 稳定颜色（空地固定中性色）
  function buildPalette(project) {
    const chars = new Set();
    for (const row of project.rows) for (const ch of row) if (ch !== '.') chars.add(ch);
    for (const e of project.edits) if (e.value !== '.') chars.add(e.value);
    const hues = [214, 27, 142, 38, 168, 280, 95, 330, 200, 60, 0, 120];
    const map = new Map();
    let i = 0;
    for (const ch of chars) {
      const hue = hues[i % hues.length];
      map.set(ch, {
        light: `hsl(${hue} 62% 58%)`,
        dark: `hsl(${hue} 58% 52%)`,
        soft: `hsl(${hue} 70% 92%)`,
        softDark: `hsl(${hue} 40% 24%)`,
      });
      i++;
    }
    return map;
  }

  function buildCodeMaps(project) {
    const c2m = new Map([['.', 0]]);
    let code = 1;
    const seen = new Set();
    for (const row of project.rows) for (const ch of row) {
      if (ch !== '.' && !seen.has(ch)) { seen.add(ch); c2m.set(ch, code++); }
    }
    for (const e of project.edits) {
      if (e.value !== '.' && !c2m.has(e.value)) c2m.set(e.value, code++);
    }
    const m2c = new Array(code);
    for (const [ch, c] of c2m) m2c[c] = ch;
    return { charToCode: (ch) => c2m.get(ch), codeToChar: m2c };
  }

  function loadProject(input, fileName) {
    const result = E.validateProject(input);
    if (!result.ok) return result;
    state.project = result.project;
    state.fileName = fileName || '';
    state.currentVersion = 0;
    state.selectedCell = null;
    state.highlightCells = null;
    state.queryDraft = result.project.queries.map((q) => ({ ...q }));
    state.useImportedQueries = true;
    const maps = buildCodeMaps(result.project);
    state.charToCode = maps.charToCode;
    state.codeToChar = maps.codeToChar;
    state.palette = buildPalette(result.project);
    return { ok: true };
  }

  function gridAt(version) {
    return E.materializeGrid(state.project, version, state.charToCode);
  }

  function dims() {
    return { w: state.project.rows[0].length, h: state.project.rows.length };
  }

  // -------------------------------------------------------------------------
  // 版本树：父子关系与祖先链
  // -------------------------------------------------------------------------
  function versionTree() {
    const V = state.project.edits.length + 1;
    const children = Array.from({ length: V }, () => []);
    state.project.edits.forEach((e, i) => children[e.parent].push(i + 1));
    return children;
  }

  function ancestorChain(version) {
    const chain = [];
    let v = version;
    while (v > 0) { chain.push(v); v = state.project.edits[v - 1].parent; }
    chain.push(0);
    return chain.reverse();
  }

  /** 在当前版本改一格，产生新版本（挂在 currentVersion 下） */
  function editCell(x, y, value) {
    const p = state.project;
    const newVersion = p.edits.length + 1;
    p.edits.push({ parent: state.currentVersion, x, y, value });
    // 新字符可能引入新阵营码/颜色
    if (value !== '.' && !state.palette.has(value)) {
      const hues = [214, 27, 142, 38, 168, 280, 95, 330, 200, 60, 0, 120];
      const hue = hues[state.palette.size % hues.length];
      state.palette.set(value, {
        light: `hsl(${hue} 62% 58%)`, dark: `hsl(${hue} 58% 52%)`,
        soft: `hsl(${hue} 70% 92%)`, softDark: `hsl(${hue} 40% 24%)`,
      });
    }
    const maps = buildCodeMaps(p);
    state.charToCode = maps.charToCode;
    state.codeToChar = maps.codeToChar;
    state.currentVersion = newVersion;
    return newVersion;
  }

  function addQuery(q) {
    state.queryDraft.push({ version: q.version, x: q.x, y: q.y });
  }
  function removeQuery(index) {
    state.queryDraft.splice(index, 1);
  }

  /** 跑批查询，返回结果（按提交顺序） */
  function runQueries() {
    const p = state.project;
    const snapshot = {
      rows: p.rows,
      edits: p.edits.map((e) => ({ ...e })),
      queries: state.queryDraft.map((q) => ({ ...q })),
    };
    const valid = E.validateProject(snapshot);
    if (!valid.ok) return valid;
    return { ok: true, results: E.runBatch(valid.project) };
  }

  /** 点格：取所在整块用于高亮，并返回详情 */
  function inspectCell(x, y) {
    const version = state.currentVersion;
    const grid = gridAt(version);
    const cell = y * dims().w + x;
    const isEmpty = grid[cell] === 0;
    const block = E.floodBlock(
      state.project, version, x, y, isEmpty ? 8 : 4, state.charToCode
    );
    state.selectedCell = { x, y };
    state.highlightCells = block.cells;
    return {
      isEmpty,
      value: state.codeToChar[grid[cell]],
      area: block.area,
      perimeter: block.perimeter,
      enclave: block.enclave,
      touchesBoundary: block.touchesBoundary,
      ownerCodes: block.ownerCodes,
    };
  }

  /**
   * 飞地溯源：沿当前版本祖先链回退，找出最早让该空地分量成为飞地的版本。
   * 飞地取决于分量是否接触"全局"地图边界，远处改格堵住出口也会改变它，
   * 因此不能用局部邻接跳过，每个相关版本都要真实泛洪。
   * 加速：回退中一旦遇到非飞地版本即停止（该版本就是成因边界）；
   * 并设检查上限避免极端深链长时间阻塞，超限会在结果里标注 truncated。
   */
  const TRACE_MAX_VERSIONS = 600;
  function traceEnclave(x, y) {
    const p = state.project;
    const chain = ancestorChain(state.currentVersion); // 含版本0，自底向上
    const trace = [];
    let becameEnclaveAt = null;
    let truncated = false;
    let checked = 0;

    for (let i = chain.length - 1; i >= 0; i--) {
      if (checked >= TRACE_MAX_VERSIONS) { truncated = true; break; }
      const ver = chain[i];
      const edit = ver > 0 ? p.edits[ver - 1] : null;
      const grid = E.materializeGrid(p, ver, state.charToCode);

      if (grid[y * dims().w + x] !== 0) {
        trace.push({ version: ver, status: 'not-empty', edit });
        checked++;
        continue;
      }

      const blk = E.floodBlock(p, ver, x, y, 8, state.charToCode);
      checked++;
      trace.push({ version: ver, area: blk.area, enclave: blk.enclave, reused: false, edit });
      if (blk.enclave) {
        if (becameEnclaveAt === null) becameEnclaveAt = ver;
      } else if (i < chain.length - 1) {
        break; // 回退中首次非飞地：成因边界已确定
      }
    }
    return { trace: trace.reverse(), becameEnclaveAt, truncated, checked };
  }

  window.FrontierApp = {
    state,
    loadProject,
    gridAt,
    dims,
    versionTree,
    ancestorChain,
    editCell,
    addQuery,
    removeQuery,
    runQueries,
    inspectCell,
    traceEnclave,
  };
})();
