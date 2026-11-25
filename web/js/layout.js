/*
 * layout.js — std140 / std430 子集布局引擎（无着色器反射库）
 * 同时用于浏览器经典 <script> 与 Node CJS 测试。
 *
 * 约定来源：samples/shader-block-cases.zip 内 format.txt
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RBLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = {
    MAX_DUMP: 64 * 1024 * 1024,
    MAX_VIEWS: 64,
    MAX_PAIRS: 64,
    MAX_WRITES: 5000000,
    MAX_DEPTH: 16,
    MAX_DECLS: 4096,
  };

  const SCALAR_SIZE = 4;
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  class SpecError extends Error {
    constructor(message, ctx) {
      super(message);
      this.name = 'SpecError';
      if (ctx) {
        this.view = ctx.view;
        this.path = ctx.path;
        this.offset = ctx.offset;
      }
    }
    /** 带路径/偏移的完整中文描述 */
    describe() {
      let s = this.message;
      if (this.view) s += `（视图：${this.view}）`;
      if (this.path) s += `（路径：${this.path}）`;
      if (this.offset !== undefined && this.offset !== null) {
        s += `（绝对偏移：${this.offset} / 0x${this.offset.toString(16)}）`;
      }
      return s;
    }
  }

  function fail(msg, ctx) {
    throw new SpecError(msg, ctx);
  }

  function roundUp(v, a) {
    const r = v % a;
    return r === 0 ? v : v + (a - r);
  }

  function safeMul(a, b) {
    const v = a * b;
    if (!Number.isSafeInteger(v) || v < 0) {
      fail(`布局大小溢出：${a} × ${b} 无法表示为安全整数`);
    }
    return v;
  }

  function safeAdd(a, b) {
    const v = a + b;
    if (!Number.isSafeInteger(v) || v < 0) {
      fail(`布局偏移溢出：${a} + ${b}`);
    }
    return v;
  }

  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  function isPow2Align(v) {
    return isInt(v) && v >= 4 && v <= 256 && (v & (v - 1)) === 0;
  }

  /* ------------------------------------------------------------------ *
   * 类型编译
   * node 种类：scalar | vec | mat | array | struct
   * ------------------------------------------------------------------ */

  function scalarNode(name) {
    return { kind: 'scalar', scalar: name, size: 4, align: 4 };
  }

  function vecAlign(n) {
    return n === 2 ? 8 : 16; // n 为 3 或 4
  }

  /**
   * 编译类型。ctx = { std:'std140'|'std430', view?:string }
   * depth 从 1 起（叶子为 1 层）。
   */
  function compileType(raw, ctx, depth) {
    if (depth > LIMITS.MAX_DEPTH) {
      fail(`类型深度超过 ${LIMITS.MAX_DEPTH} 层`, { view: ctx.view });
    }
    if (raw === null || raw === undefined) {
      fail('类型不能为空', { view: ctx.view });
    }

    // 标量字符串
    if (typeof raw === 'string') {
      if (raw === 'i32' || raw === 'u32' || raw === 'f32') return scalarNode(raw);
      fail(`未知标量类型：${JSON.stringify(raw)}`, { view: ctx.view });
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      fail(`非法类型声明：${JSON.stringify(raw)}`, { view: ctx.view });
    }

    // {vec:n, of:scalar}
    if (Object.prototype.hasOwnProperty.call(raw, 'vec')) {
      const n = raw.vec;
      if (!isInt(n) || n < 2 || n > 4) fail(`向量长度必须为 2..4 的整数，得到 ${JSON.stringify(n)}`, { view: ctx.view });
      const of = raw.of;
      if (of !== 'i32' && of !== 'u32' && of !== 'f32') {
        fail(`向量分量只能是 i32/u32/f32，得到 ${JSON.stringify(of)}`, { view: ctx.view });
      }
      return { kind: 'vec', n, scalar: of, size: 4 * n, align: vecAlign(n) };
    }

    // {mat:[R,C]} 或 {mat:{rows,cols}}
    if (Object.prototype.hasOwnProperty.call(raw, 'mat')) {
      let rc = raw.mat;
      let R, C;
      if (Array.isArray(rc) && rc.length === 2) {
        R = rc[0]; C = rc[1];
      } else if (rc && typeof rc === 'object') {
        R = rc.rows ?? rc[0]; C = rc.cols ?? rc[1];
      }
      if (!isInt(R) || !isInt(C) || R < 2 || R > 4 || C < 2 || C > 4) {
        fail(`矩阵行列必须各为 2..4，得到 ${JSON.stringify(rc)}`, { view: ctx.view });
      }
      const matNode = { kind: 'mat', rows: R, cols: C, scalar: 'f32', size: null, align: null };
      finalizeMat(matNode, ctx.std, ctx.major);
      return matNode;
    }

    // {array:n, of:type}  n 为 null 表示动态
    if (Object.prototype.hasOwnProperty.call(raw, 'array')) {
      const n = raw.array;
      if (n !== null && (!isInt(n) || n <= 0)) {
        fail(`定长数组长度必须为正整数，得到 ${JSON.stringify(n)}（动态数组请用 null）`, { view: ctx.view });
      }
      if (!Object.prototype.hasOwnProperty.call(raw, 'of')) {
        fail('数组类型缺少 of', { view: ctx.view });
      }
      const elem = compileType(raw.of, ctx, depth + 1);
      const align = ctx.std === 'std140' ? roundUp(elem.align, 16) : elem.align;
      const stride = roundUp(elem.size, align);
      if (!Number.isSafeInteger(stride) || stride <= 0) fail('数组步幅非法', { view: ctx.view });
      const node = { kind: 'array', fixed: n === null ? null : n, elem, align, stride };
      if (n !== null) {
        node.count = n;
        node.size = safeMul(stride, n);
      } else {
        node.count = null; // 由视图长度解析
        node.size = null;
      }
      return node;
    }

    // {struct: members} 的多种合法写法
    if (Object.prototype.hasOwnProperty.call(raw, 'struct')) {
      let members = raw.struct;
      if (members && !Array.isArray(members) && Array.isArray(members.members)) members = members.members;
      if (members && !Array.isArray(members) && Array.isArray(members.fields)) members = members.fields;
      return compileStruct(members, ctx, depth + 1, false);
    }

    // 宽容：{type:'struct', members|fields:[...]} / {kind:'struct', members}
    if ((raw.type === 'struct' || raw.kind === 'struct')) {
      const ms = Array.isArray(raw.members) ? raw.members : raw.fields;
      if (Array.isArray(ms)) return compileStruct(ms, ctx, depth + 1, false);
    }

    fail(`无法识别的类型形式：${JSON.stringify(raw)}`, { view: ctx.view });
  }

  /** 矩阵 = 向量数组；行主=R 个 C 分量向量，列主=C 个 R 分量向量 */
  function compileMat(R, C, std) {
    // major 在视图级决定，这里先保留 R/C，align/size 依赖 major，
    // 因此真正的布局在 finalizeMat 中按视图 major 计算。
    return { kind: 'mat', rows: R, cols: C, scalar: 'f32', size: null, align: null };
  }

  function finalizeMat(node, std, major) {
    if (node.size !== null) return node;
    const vecN = major === 'row' ? node.cols : node.rows;
    const vecCount = major === 'row' ? node.rows : node.cols;
    const elemSize = 4 * vecN;
    const elemAlign = vecAlign(vecN);
    const arrAlign = std === 'std140' ? roundUp(elemAlign, 16) : elemAlign;
    const stride = roundUp(elemSize, arrAlign);
    node.major = major;
    node.vecN = vecN;
    node.vecCount = vecCount;
    node.stride = stride;
    node.align = arrAlign;
    node.size = safeMul(stride, vecCount);
    return node;
  }

  /**
   * 编译结构。root=true 时允许成员带 align/offset。
   */
  function compileStruct(membersRaw, ctx, depth, root) {
    if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
      fail('members 必须是非空数组', { view: ctx.view });
    }
    if (depth > LIMITS.MAX_DEPTH) fail(`类型深度超过 ${LIMITS.MAX_DEPTH} 层`, { view: ctx.view });

    const names = new Set();
    const members = [];
    let cur = 0;
    let alignMax = 1;

    for (let idx = 0; idx < membersRaw.length; idx++) {
      const m = membersRaw[idx];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        fail(`第 ${idx + 1} 个成员声明非法`, { view: ctx.view });
      }
      const name = m.name;
      if (typeof name !== 'string' || !IDENT_RE.test(name)) {
        fail(`成员名必须是 ASCII 标识符，得到 ${JSON.stringify(name)}`, { view: ctx.view, path: name });
      }
      if (names.has(name)) fail(`同级成员名重复：${name}`, { view: ctx.view, path: name });
      names.add(name);

      if (!root && (Object.prototype.hasOwnProperty.call(m, 'align') || Object.prototype.hasOwnProperty.call(m, 'offset'))) {
        fail(`align/offset 只允许出现在根 members：${name}`, { view: ctx.view, path: name });
      }

      let type = compileType(m.type, ctx, depth);
      // 视图级 major 此时可知，补全矩阵布局
      finalizeTreeMat(type, ctx.std, ctx.major);

      let effectiveAlign = type.align;
      let explicitAlign = null;
      let explicitOffset = null;

      if (m.align !== undefined && m.align !== null) {
        if (!isPow2Align(m.align)) fail(`align 必须是 4..256 的二次幂：成员 ${name} 得到 ${m.align}`, { view: ctx.view, path: name });
        explicitAlign = m.align;
        effectiveAlign = Math.max(effectiveAlign, m.align);
      }

      let rel;
      if (m.offset !== undefined && m.offset !== null) {
        const off = m.offset;
        if (!isInt(off) || off < 0) fail(`offset 必须是非负整数：成员 ${name} 得到 ${off}`, { view: ctx.view, path: name });
        if (off % effectiveAlign !== 0) {
          fail(`offset ${off} 不是成员 ${name} 有效对齐 ${effectiveAlign} 的倍数（对齐错误）`, { view: ctx.view, path: name });
        }
        if (off < cur) {
          fail(`显式 offset ${off} 与前一成员占用末端 ${cur} 重叠：成员 ${name}`, { view: ctx.view, path: name, offset: off });
        }
        explicitOffset = off;
        rel = off;
      } else {
        rel = roundUp(cur, effectiveAlign);
      }

      const size = type.size;
      if (size === null) {
        // 动态类型只能是根最后一个直接成员，compileView 再严格校验；
        // 布局阶段先把它放在 rel，cur 无法继续，直接记录。
        members.push({ name, type, rel, effectiveAlign, explicitAlign, explicitOffset, dynamic: true });
        alignMax = Math.max(alignMax, effectiveAlign);
        cur = rel; // 动态成员之后不应再有成员（由 compileView 保证）
      } else {
        const end = safeAdd(rel, size);
        members.push({ name, type, rel, effectiveAlign, explicitAlign, explicitOffset, dynamic: false, end });
        cur = end;
        alignMax = Math.max(alignMax, effectiveAlign);
      }
    }

    const align = ctx.std === 'std140' ? roundUp(alignMax, 16) : alignMax;
    const size = roundUp(cur, align);
    return { kind: 'struct', members, align, size, root: !!root };
  }

  /** 递归补全矩阵（major 为视图级） */
  function finalizeTreeMat(node, std, major) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'mat') finalizeMat(node, std, major);
    else if (node.kind === 'array') finalizeTreeMat(node.elem, std, major);
    else if (node.kind === 'struct') {
      for (const m of node.members) finalizeTreeMat(m.type, std, major);
    } else if (node.kind === 'vec' || node.kind === 'scalar') {
      /* nothing */
    }
  }

  /** 类型深度：标量/向量/矩阵=1，array=1+of，struct=1+最深成员 */
  function typeDepth(raw) {
    if (raw == null) return 1;
    if (typeof raw === 'string') return 1;
    if (Object.prototype.hasOwnProperty.call(raw, 'vec')) return 1;
    if (Object.prototype.hasOwnProperty.call(raw, 'mat')) return 1;
    if (Object.prototype.hasOwnProperty.call(raw, 'array')) return 1 + typeDepth(raw.of);
    if (Object.prototype.hasOwnProperty.call(raw, 'struct')) {
      let ms = raw.struct;
      if (ms && !Array.isArray(ms) && Array.isArray(ms.members)) ms = ms.members;
      if (ms && !Array.isArray(ms) && Array.isArray(ms.fields)) ms = ms.fields;
      if (!Array.isArray(ms) || !ms.length) return 1;
      return 1 + Math.max(...ms.map((m) => typeDepth(m && m.type)));
    }
    if (raw.type === 'struct' || raw.kind === 'struct') {
      const ms = Array.isArray(raw.members) ? raw.members : raw.fields;
      if (Array.isArray(ms) && ms.length) return 1 + Math.max(...ms.map((m) => typeDepth(m && m.type)));
    }
    return 1;
  }

  /** 统计未展开成员声明数 */
  function countDecls(node) {    if (!node) return 0;
    if (node.kind === 'struct') {
      let n = node.members.length;
      for (const m of node.members) n += countDecls(m.type);
      return n;
    }
    if (node.kind === 'array') return countDecls(node.elem);
    return 0;
  }

  /** 找到类型树中的动态数组节点（若有）及其路径段 */
  function findDynamicArray(node) {
    if (!node) return null;
    if (node.kind === 'array' && node.fixed === null) return node;
    if (node.kind === 'array') return findDynamicArray(node.elem);
    if (node.kind === 'struct') {
      for (const m of node.members) {
        const r = findDynamicArray(m.type);
        if (r) return r;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 视图编译
   * ------------------------------------------------------------------ */

  function compileView(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('视图必须是对象');
    if (typeof v.name !== 'string' || v.name.length === 0) fail('每个视图必须有非空字符串 name');
    const viewName = v.name;
    const ctx = { std: v.layout, major: v.major, view: viewName };

    if (v.layout !== 'std140' && v.layout !== 'std430') {
      fail(`layout 必须是 std140 或 std430，得到 ${JSON.stringify(v.layout)}`, { view: viewName });
    }
    if (v.major !== 'row' && v.major !== 'column') {
      fail(`major 必须是 row 或 column，得到 ${JSON.stringify(v.major)}`, { view: viewName });
    }
    if (v.endian !== 'little' && v.endian !== 'big') {
      fail(`endian 必须是 little 或 big，得到 ${JSON.stringify(v.endian)}`, { view: viewName });
    }
    if (!isInt(v.offset) || v.offset < 0) fail(`offset 必须是非负整数`, { view: viewName });
    if (!isInt(v.length) || v.length < 0) fail(`length 必须是非负整数`, { view: viewName });
    if (!Array.isArray(v.members) || v.members.length === 0) {
      fail('members 必须是非空数组', { view: viewName });
    }

    // 根结构（允许 align/offset）
    for (const m of v.members) {
      if (m && typeDepth(m.type) > LIMITS.MAX_DEPTH) {
        fail(`成员 ${JSON.stringify(m.name)} 的类型深度超过 ${LIMITS.MAX_DEPTH} 层`, { view: viewName, path: m.name });
      }
    }
    const root = compileStruct(v.members, ctx, 1, true);
    finalizeTreeMat(root, v.layout, v.major);

    const declCount = countDecls(root);
    if (declCount > LIMITS.MAX_DECLS) {
      fail(`未展开成员声明 ${declCount} 个，超过每视图 ${LIMITS.MAX_DECLS} 个的上限`, { view: viewName });
    }

    // 动态数组只能是最后一个直接根成员的 array
    let dynamic = null;
    const lastMember = root.members[root.members.length - 1];
    for (const m of root.members) {
      const dyn = findDynamicArray(m.type);
      if (dyn) {
        if (m !== lastMember || m.type.kind !== 'array' || m.type.fixed !== null) {
          fail('动态长度数组（array:null）只能出现在视图最后一个直接成员上', { view: viewName, path: m.name });
        }
        dynamic = { member: m, node: m.type, name: m.name };
      }
    }

    let usedSize;
    if (dynamic) {
      const start = dynamic.member.rel;
      const stride = dynamic.node.stride;
      const length = v.length;
      if (length < start) {
        fail(`视图长度 ${length} 小于动态数组 ${dynamic.name} 起点 ${start}`, {
          view: viewName, path: dynamic.name, offset: v.offset + start,
        });
      }
      const rem = length - start;
      if (rem % stride !== 0) {
        fail(`elems 长度非法：剩余 ${rem} 字节不能整除数组步幅 ${stride}（成员 ${dynamic.name}）`, {
          view: viewName, path: dynamic.name, offset: v.offset + start,
        });
      }
      const count = rem / stride;
      dynamic.node.count = count;
      dynamic.node.size = rem;
      dynamic.count = count;
      dynamic.start = start;
      dynamic.stride = stride;
      usedSize = start + rem; // 不追加整体尾垫
    } else {
      usedSize = root.size;
      if (v.length !== root.size) {
        // 检查是否有成员溢出，给出更精确的错误
        for (const m of root.members) {
          if (m.type.size !== null && m.rel + m.type.size > v.length) {
            fail(`成员 ${m.name} 布局溢出：末端 ${m.rel + m.type.size} 超过视图长度 ${v.length}`, {
              view: viewName, path: m.name, offset: v.offset + m.rel,
            });
          }
        }
        fail(`定长根结构补齐大小为 ${root.size} 字节，与视图 length=${v.length} 不一致`, { view: viewName });
      }
    }

    if (usedSize > v.length) {
      fail(`布局溢出：需要 ${usedSize} 字节，视图长度仅 ${v.length}`, { view: viewName });
    }

    return {
      name: viewName,
      offset: v.offset,
      length: v.length,
      std: v.layout,
      major: v.major,
      endian: v.endian,
      littleEndian: v.endian === 'little',
      root,
      dynamic,
      usedSize,
      declCount,
      raw: v,
    };
  }

  function compileRoot(json) {
    let root = json;
    if (typeof json === 'string') {
      try { root = JSON.parse(json); } catch (e) { fail(`layout.json 不是合法 JSON：${e.message}`); }
    }
    let rawViews;
    if (Array.isArray(root)) rawViews = root;
    else if (root && Array.isArray(root.views)) rawViews = root.views;
    else if (root && Array.isArray(root.buffers)) rawViews = root.buffers;
    else if (root && Array.isArray(root.layouts)) rawViews = root.layouts;
    else fail('layout.json 根对象必须包含 views 数组');

    if (rawViews.length < 1 || rawViews.length > LIMITS.MAX_VIEWS) {
      fail(`视图数量必须为 1..${LIMITS.MAX_VIEWS}，当前 ${rawViews.length}`);
    }
    const names = new Set();
    const views = [];
    for (let i = 0; i < rawViews.length; i++) {
      const v = rawViews[i];
      const view = compileView(v);
      if (names.has(view.name)) fail(`视图名不唯一：${view.name}`);
      names.add(view.name);
      views.push(view);
    }
    return { views };
  }

  /** 检查所有视图区间都落在 dump 内 */
  function bindDump(project, dumpLength) {
    if (dumpLength > LIMITS.MAX_DUMP) {
      fail(`转储为 ${dumpLength} 字节，超过 ${LIMITS.MAX_DUMP} 字节（64MiB）上限`);
    }
    for (const v of project.views) {
      const end = v.offset + v.length;
      if (!Number.isSafeInteger(end)) fail(`视图 ${v.name} 区间溢出`);
      if (end > dumpLength) {
        fail(`视图 ${v.name} 区间 [${v.offset}, ${end}) 超出转储长度 ${dumpLength}`, {
          view: v.name, offset: end,
        });
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 矩阵逻辑坐标 -> 相对字节
   * ------------------------------------------------------------------ */
  function matCompOffset(node, r, c) {
    if (r < 0 || r >= node.rows || c < 0 || c >= node.cols) {
      fail(`矩阵下标越界 m[${r}][${c}]，形状为 ${node.rows}×${node.cols}`);
    }
    if (node.major === 'column') return c * node.stride + 4 * r;
    return r * node.stride + 4 * c;
  }

  function arrayCount(node) {
    return node.fixed === null ? node.count : node.fixed;
  }
  function nodeSize(node) {
    if (node.kind === 'array' && node.fixed === null) return node.size || 0;
    return node.size;
  }

  /** 结构内二分：找到 rel <= p 的最后一个成员 */
  function memberAt(st, p) {
    const ms = st.members;
    let lo = 0, hi = ms.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ms[mid].rel <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans < 0 ? null : ms[ans];
  }

  /**
   * 视图相对偏移 -> 分量定位。
   * 返回 {padding:true, path, detail} 或
   *      {padding:false, path, scalar, rel, byteIndex, size:4}
   */
  function locateRel(view, rel) {
    if (!Number.isInteger(rel) || rel < 0 || rel >= view.length) {
      fail(`相对偏移 ${rel} 不在视图 ${view.name} 长度 ${view.length} 内`, { view: view.name, offset: view.offset + rel });
    }
    const loc = locateNode(view.root, rel, '');
    // 统一：rel 始终是“视图相对的被查询偏移”，scalarRel 为分量起点
    loc.rel = rel;
    if (!loc.padding && Number.isInteger(loc.byteIndex)) loc.scalarRel = rel - loc.byteIndex;
    return loc;
  }

  function locateNode(node, p, path) {
    switch (node.kind) {
      case 'scalar': {
        if (p < 0 || p >= 4) return { padding: true, path, detail: '标量外' };
        return { padding: false, path, scalar: node.scalar, rel: p, byteIndex: p, size: 4 };
      }
      case 'vec': {
        if (p >= node.size) return { padding: true, path, detail: '向量外' };
        const i = Math.floor(p / 4);
        return {
          padding: false,
          path: `${path}.v[${i}]`,
          scalar: node.scalar,
          rel: i * 4,
          byteIndex: p % 4,
          size: 4,
        };
      }
      case 'mat': {
        // 逻辑 m[r][c]
        const vecIndex = Math.floor(p / node.stride);
        const within = p - vecIndex * node.stride;
        if (node.major === 'column') {
          const c = vecIndex;
          if (c >= node.cols || p >= node.size) return { padding: true, path: `${path}.m`, detail: '矩阵外' };
          if (within >= 4 * node.rows) {
            return { padding: true, path: `${path}.m[*][${c}]`, detail: '列步幅填充' };
          }
          const r = Math.floor(within / 4);
          return {
            padding: false,
            path: `${path}.m[${r}][${c}]`,
            scalar: 'f32',
            rel: c * node.stride + r * 4,
            byteIndex: within % 4,
            size: 4,
          };
        } else {
          const r = vecIndex;
          if (r >= node.rows || p >= node.size) return { padding: true, path: `${path}.m`, detail: '矩阵外' };
          if (within >= 4 * node.cols) {
            return { padding: true, path: `${path}.m[${r}][*]`, detail: '行步幅填充' };
          }
          const c = Math.floor(within / 4);
          return {
            padding: false,
            path: `${path}.m[${r}][${c}]`,
            scalar: 'f32',
            rel: r * node.stride + c * 4,
            byteIndex: within % 4,
            size: 4,
          };
        }
      }
      case 'array': {
        const count = arrayCount(node) || 0;
        if (count === 0) return { padding: true, path: `${path}[]`, detail: '零长度动态数组' };
        const i = Math.floor(p / node.stride);
        if (i >= count) return { padding: true, path: `${path}[${count}]`, detail: '数组外' };
        const q = p - i * node.stride;
        const basePath = `${path}[${i}]`;
        if (q >= node.elem.size) {
          return { padding: true, path: basePath, detail: '数组步幅尾垫' };
        }
        return locateNode(node.elem, q, basePath);
      }
      case 'struct': {
        const m = memberAt(node, p);
        if (!m || p >= m.rel + nodeSize(m.type)) {
          return { padding: true, path: path || '(root)', detail: '结构成员间填充' };
        }
        return locateNode(m.type, p - m.rel, path ? `${path}.${m.name}` : m.name);
      }
      default:
        return { padding: true, path, detail: '未知节点' };
    }
  }

  /* ------------------------------------------------------------------ *
   * 路径解析（宽容多种写法）
   * 规范：name.child[i].v[j].m[r][c]
   * 也接受：name.child[i][j]（向量简写）、[r][c]（矩阵简写）、去掉点
   * ------------------------------------------------------------------ */
  function tokenizePath(input) {
    const tokens = [];
    const re = /[A-Za-z_][A-Za-z0-9_]*|\d+/g;
    let m;
    while ((m = re.exec(input)) !== null) {
      if (/^\d+$/.test(m[0])) tokens.push({ t: 'num', v: parseInt(m[0], 10) });
      else tokens.push({ t: 'id', v: m[0] });
    }
    return tokens;
  }

  /**
   * 返回 {ok, abs, rel, size, node, scalar, path} 或 {ok:false,error}
   */
  function resolvePath(view, input) {
    try {
      if (typeof input !== 'string' || !input.trim()) fail('路径为空');
      const toks = tokenizePath(input);
      if (toks.length === 0 || toks[0].t !== 'id') fail(`路径必须以成员名开头：${input}`);
      const name = toks[0].v;
      const m = view.root.members.find((x) => x.name === name);
      if (!m) fail(`视图 ${view.name} 没有根成员 ${name}`, { view: view.name, path: input });
      const r = walkNode(m.type, toks, 1, m.rel, name, view);
      return { ok: true, view: view.name, ...r, abs: view.offset + r.rel };
    } catch (e) {
      if (e instanceof SpecError) return { ok: false, error: e.message, specError: e };
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function expectNum(toks, i, what) {
    if (i >= toks.length || toks[i].t !== 'num') fail(`路径缺少${what}下标`);
    return [toks[i].v, i + 1];
  }

  function walkNode(node, toks, i, rel, path, view) {
    if (i >= toks.length) {
      return { rel, size: nodeSize(node), node, path, scalar: node.kind === 'scalar' ? node.scalar : null };
    }
    const tk = toks[i];

    if (node.kind === 'struct') {
      if (tk.t !== 'id') fail(`结构路径需要成员名，得到下标`);
      const m = node.members.find((x) => x.name === tk.v);
      if (!m) fail(`结构中不存在成员 ${tk.v}（路径 ${path}.${tk.v}）`, { view: view && view.name, path });
      return walkNode(m.type, toks, i + 1, rel + m.rel, `${path}.${m.name}`, view);
    }

    if (node.kind === 'array') {
      const [idx, ni] = expectNum(toks, i, '数组');
      const count = arrayCount(node) || 0;
      if (idx < 0 || idx >= count) fail(`数组下标 ${idx} 越界（${path} 共 ${count} 项）`, { view: view && view.name, path });
      return walkNode(node.elem, toks, ni, rel + idx * node.stride, `${path}[${idx}]`, view);
    }

    if (node.kind === 'vec') {
      let idx, ni;
      const ALIAS = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
      if (tk.t === 'id' && tk.v === 'v') {
        [idx, ni] = expectNum(toks, i + 1, '向量分量');
      } else if (tk.t === 'num') {
        [idx, ni] = [tk.v, i + 1];
      } else if (tk.t === 'id' && Object.prototype.hasOwnProperty.call(ALIAS, tk.v)) {
        idx = ALIAS[tk.v]; ni = i + 1;
      } else {
        fail(`向量分量应使用 v[i]（或 x/y/z/w）：${path}`);
      }
      if (idx < 0 || idx >= node.n) fail(`向量分量下标 ${idx} 越界（${path} 宽度 ${node.n}）`, { view: view && view.name, path });
      return walkScalarEnd(toks, ni, rel + 4 * idx, `${path}.v[${idx}]`, node.scalar, view);
    }

    if (node.kind === 'mat') {
      let r, c, ni;
      if (tk.t === 'id' && tk.v === 'm') {
        [r, ni] = expectNum(toks, i + 1, '矩阵行');
        [c, ni] = expectNum(toks, ni, '矩阵列');
      } else if (tk.t === 'num') {
        [r, ni] = [tk.v, i + 1];
        [c, ni] = expectNum(toks, ni, '矩阵列');
      } else {
        fail(`矩阵分量应使用 m[r][c]：${path}`);
      }
      const off = matCompOffset(node, r, c);
      return walkScalarEnd(toks, ni, rel + off, `${path}.m[${r}][${c}]`, 'f32', view);
    }

    if (node.kind === 'scalar') {
      fail(`标量 ${path} 之后不能再有路径段`);
    }
    fail(`无法继续解析路径：${path}`);
  }

  function walkScalarEnd(toks, i, rel, path, scalar, view) {
    if (i < toks.length) fail(`标量路径后仍有多余段：${path}`, { view: view && view.name, path });
    return { rel, size: 4, node: scalarNode(scalar), path, scalar };
  }

  /** 绝对偏移 -> 所有覆盖视图的定位结果 */
  function queryAbsolute(views, abs) {
    const out = [];
    for (const v of views) {
      if (abs >= v.offset && abs < v.offset + v.length) {
        const rel = abs - v.offset;
        let loc;
        try {
          loc = locateRel(v, rel);
        } catch (e) {
          loc = { padding: true, path: '(无法定位)', detail: e.message };
        }
        out.push({ view: v.name, rel, abs, ...loc });
      }
    }
    return out;
  }

  return {
    LIMITS,
    SpecError,
    IDENT_RE,
    roundUp,
    compileRoot,
    compileView,
    compileType,
    bindDump,
    locateRel,
    resolvePath,
    queryAbsolute,
    matCompOffset,
    arrayCount,
    nodeSize,
    tokenizePath,
    finalizeMat,
  };
});
