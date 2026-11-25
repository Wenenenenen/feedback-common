/*
 * engine.js — 迁移匹配、整批原子校验、重叠冲突检测、撤销重做历史。
 * 依赖 layout.js（UMD 全局 RBLayout 或 Node require）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./layout.js'));
  } else {
    root.RBEngine = factory(root.RBLayout);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (L) {
  'use strict';

  const { SpecError, LIMITS, arrayCount, matCompOffset } = L;

  const NATIVE_LE = (() => {
    const b = new ArrayBuffer(2);
    new Uint16Array(b)[0] = 1;
    return new Uint8Array(b)[0] === 1;
  })();

  function nativeView(dump) {
    return new DataView(dump.buffer, dump.byteOffset, dump.byteLength);
  }

  /* ---------------------------------------------------------------- *
   * 形状兼容性（只比较逻辑类型与形状，不比较端序/布局）
   * ---------------------------------------------------------------- */
  function shapeError(pairLabel, p, msg) {
    return new SpecError(`迁移类型不匹配：${msg}`, { path: p, view: pairLabel });
  }

  function checkShape(a, b, path, label) {
    if (a.kind !== b.kind) {
      throw shapeError(label, path, `节点类别不一致（${kindName(a.kind)} vs ${kindName(b.kind)}）`);
    }
    switch (a.kind) {
      case 'scalar':
        if (a.scalar !== b.scalar) {
          throw shapeError(label, path, `标量类型不一致（${a.scalar} vs ${b.scalar}）`);
        }
        return;
      case 'vec':
        if (a.n !== b.n || a.scalar !== b.scalar) {
          throw shapeError(label, path, `向量形状/分量不一致（${a.scalar}×${a.n} vs ${b.scalar}×${b.n}）`);
        }
        return;
      case 'mat':
        // 只认逻辑行列；major 可以不同
        if (a.rows !== b.rows || a.cols !== b.cols) {
          throw shapeError(label, path, `矩阵逻辑行列不一致（${a.rows}×${a.cols} vs ${b.rows}×${b.cols}），即使分量总数相同也不可迁移`);
        }
        return;
      case 'array':
        // 无论有无共同索引，都必须检查元素配对形状
        checkShape(a.elem, b.elem, `${path}[]`, label);
        return;
      case 'struct': {
        const bm = new Map(b.members.map((m) => [m.name, m]));
        for (const ma of a.members) {
          const mb = bm.get(ma.name);
          if (mb) checkShape(ma.type, mb.type, path ? `${path}.${ma.name}` : ma.name, label);
          // 非共有成员略过
        }
        return;
      }
      default:
        throw shapeError(label, path, `未知节点类别 ${a.kind}`);
    }
  }

  function kindName(k) {
    return ({ scalar: '标量', vec: '向量', mat: '矩阵', array: '数组', struct: '结构' })[k] || k;
  }

  /** 匹配标量数（目标写入次数；重复配对重复计） */
  function countMatched(a, b) {
    switch (a.kind) {
      case 'scalar': return 1;
      case 'vec': return a.n;
      case 'mat': return a.rows * a.cols;
      case 'array': {
        const n = Math.min(arrayCount(a) || 0, arrayCount(b) || 0);
        return n * countMatched(a.elem, b.elem);
      }
      case 'struct': {
        const bm = new Map(b.members.map((m) => [m.name, m]));
        let n = 0;
        for (const ma of a.members) {
          const mb = bm.get(ma.name);
          if (mb) n += countMatched(ma.type, mb.type);
        }
        return n;
      }
      default: return 0;
    }
  }

  /* ---------------------------------------------------------------- *
   * 展开为标量提案
   * ---------------------------------------------------------------- */
  function emitMatched(a, absA, leA, b, absB, leB, dv, out, state) {
    switch (a.kind) {
      case 'scalar': {
        const k = state.k;
        out.dst[k] = absB;
        out.words[k] = dv.getUint32(absA, leA); // 按源端序取“位型”
        out.dstLE[k] = leB ? 1 : 0;
        state.k = k + 1;
        return;
      }
      case 'vec': {
        for (let i = 0; i < a.n; i++) {
          const k = state.k;
          out.dst[k] = absB + 4 * i;
          out.words[k] = dv.getUint32(absA + 4 * i, leA);
          out.dstLE[k] = leB ? 1 : 0;
          state.k = k + 1;
        }
        return;
      }
      case 'mat': {
        for (let r = 0; r < a.rows; r++) {
          for (let c = 0; c < a.cols; c++) {
            const oa = matCompOffset(a, r, c);
            const ob = matCompOffset(b, r, c); // 逻辑坐标相同，存储偏移各自计算
            const k = state.k;
            out.dst[k] = absB + ob;
            out.words[k] = dv.getUint32(absA + oa, leA);
            out.dstLE[k] = leB ? 1 : 0;
            state.k = k + 1;
          }
        }
        return;
      }
      case 'array': {
        const n = Math.min(arrayCount(a) || 0, arrayCount(b) || 0);
        for (let i = 0; i < n; i++) {
          emitMatched(
            a.elem, absA + i * a.stride, leA,
            b.elem, absB + i * b.stride, leB,
            dv, out, state,
          );
        }
        return;
      }
      case 'struct': {
        const bm = new Map(b.members.map((m) => [m.name, m]));
        for (const ma of a.members) {
          const mb = bm.get(ma.name);
          if (mb) {
            emitMatched(
              ma.type, absA + ma.rel, leA,
              mb.type, absB + mb.rel, leB,
              dv, out, state,
            );
          }
        }
        return;
      }
      default:
        throw new SpecError(`无法展开的节点：${a.kind}`);
    }
  }

  /** 把逻辑位型按目标端序拆成 4 个字节 */
  function wordBytes(w, dstLE, arr, at) {
    if (dstLE) {
      arr[at] = w & 0xff;
      arr[at + 1] = (w >>> 8) & 0xff;
      arr[at + 2] = (w >>> 16) & 0xff;
      arr[at + 3] = (w >>> 24) & 0xff;
    } else {
      arr[at] = (w >>> 24) & 0xff;
      arr[at + 1] = (w >>> 16) & 0xff;
      arr[at + 2] = (w >>> 8) & 0xff;
      arr[at + 3] = w & 0xff;
    }
  }

  /**
   * 规划整批：解析视图、形状校验、计数、展开、重叠冲突检测。
   * 完全不修改 dump。返回 {n, pairs, dst, words, dstLE, before, bytes}。
   */
  function planBatch(store, pairSpecs) {
    if (!store.views || !store.dump) throw new SpecError('尚未导入项目');
    if (!Array.isArray(pairSpecs) || pairSpecs.length === 0) {
      throw new SpecError('批次至少需要一对视图');
    }
    if (pairSpecs.length > LIMITS.MAX_PAIRS) {
      throw new SpecError(`迁移对最多 ${LIMITS.MAX_PAIRS} 对，当前 ${pairSpecs.length} 对，已拒绝整批`);
    }
    const byName = new Map(store.views.map((v) => [v.name, v]));
    const pairs = [];
    let total = 0;

    for (let i = 0; i < pairSpecs.length; i++) {
      const spec = pairSpecs[i];
      const srcName = Array.isArray(spec) ? spec[0] : spec.src;
      const dstName = Array.isArray(spec) ? spec[1] : spec.dst;
      const src = byName.get(srcName);
      const dst = byName.get(dstName);
      if (!src) throw new SpecError(`第 ${i + 1} 对的源视图不存在：${JSON.stringify(srcName)}`);
      if (!dst) throw new SpecError(`第 ${i + 1} 对的目标视图不存在：${JSON.stringify(dstName)}`);
      const label = `${src.name} → ${dst.name}`;
      checkShape(src.root, dst.root, '', label);
      const writes = countMatched(src.root, dst.root);
      total += writes;
      pairs.push({ src, dst, writes, label });
    }

    if (total > LIMITS.MAX_WRITES) {
      throw new SpecError(
        `目标标量写入累计 ${total.toLocaleString('en-US')} 次，超过每批 ${LIMITS.MAX_WRITES.toLocaleString('en-US')} 次上限，已拒绝整批且未改变转储`,
      );
    }

    const n = total;
    const dst = new Uint32Array(n);
    const words = new Uint32Array(n);
    const dstLE = new Uint8Array(n);
    const dv = nativeView(store.dump);
    const out = { dst, words, dstLE };
    const state = { k: 0 };

    for (const p of pairs) {
      emitMatched(
        p.src.root, p.src.offset, p.src.littleEndian,
        p.dst.root, p.dst.offset, p.dst.littleEndian,
        dv, out, state,
      );
    }
    if (state.k !== n) throw new SpecError('内部错误：展开数量与计数不一致');

    // 重叠逐字节冲突检测，同时捕获批前目标原值（native 位型，仅用于撤销）
    const bytesLen = store.dump.length;
    const seenBits = new Uint8Array((bytesLen + 7) >> 3);
    const firstVal = new Uint8Array(bytesLen);
    const before = new Uint32Array(n);
    const probe = new Uint8Array(4);

    for (let k = 0; k < n; k++) {
      const d = dst[k];
      before[k] = dv.getUint32(d, NATIVE_LE);
      wordBytes(words[k], dstLE[k], probe, 0);
      for (let j = 0; j < 4; j++) {
        const abs = d + j;
        const v = probe[j];
        const bi = abs >> 3;
        const mask = 1 << (abs & 7);
        if (!(seenBits[bi] & mask)) {
          seenBits[bi] |= mask;
          firstVal[abs] = v;
        } else if (firstVal[abs] !== v) {
          // 找另一个写入该字节的提案，便于错误定位
          let other = -1;
          for (let q = 0; q < n; q++) {
            if (q === k) continue;
            const o = dst[q];
            if (abs >= o && abs < o + 4) { other = q; break; }
          }
          const e = new SpecError(
            `目标重叠字节写入值冲突：绝对偏移 ${abs}（0x${abs.toString(16)}）处，提案 #${k + 1} 写入 0x${v.toString(16).padStart(2, '0')}` +
            (other >= 0 ? ` 与提案 #${other + 1} 的值不一致` : ' 与另一提案不一致') +
            '；整批无效，转储与历史均未改变',
            { offset: abs },
          );
          e.conflict = { offset: abs, proposal: k, other };
          throw e;
        }
      }
    }

    return { n, pairs, dst, words, dstLE, before };
  }

  /** 应用已校验的计划；返回历史项 */
  function applyPlan(store, plan, label) {
    const dv = nativeView(store.dump);
    const { n, dst, words, dstLE, before } = plan;
    for (let k = 0; k < n; k++) {
      dv.setUint32(dst[k], words[k], !!dstLE[k]);
    }
    const entry = {
      kind: 'batch',
      label: label || `整批迁移（${plan.pairs.length} 对 / ${n.toLocaleString('en-US')} 次写入）`,
      n,
      offs: dst,
      before,
      after: null,
      pairCount: plan.pairs.length,
    };
    return entry;
  }

  /** 执行整批迁移（成功才动历史） */
  function runBatch(store, pairSpecs) {
    const plan = planBatch(store, pairSpecs);
    const entry = applyPlan(store, plan);
    store.undoStack.push(entry);
    if (store.undoStack.length > 60) store.undoStack.shift();
    store.redoStack.length = 0; // 新成功动作清空重做链
    return { writes: plan.n, pairs: plan.pairs.map((p) => ({ src: p.src.name, dst: p.dst.name, writes: p.writes })), entry };
  }

  /** 标量十六进制原位值编辑（word 已按“视图端序解释的位型”给出） */
  function commitEdit(store, abs, word, viewLittleEndian, ctxInfo) {
    if (!store.dump) throw new SpecError('尚未导入转储');
    if (!Number.isInteger(abs) || abs < 0 || abs + 4 > store.dump.length) {
      throw new SpecError(`编辑偏移 ${abs} 越界`, ctxInfo || { offset: abs });
    }
    const dv = nativeView(store.dump);
    const offs = Uint32Array.of(abs);
    const before = Uint32Array.of(dv.getUint32(abs, NATIVE_LE));
    dv.setUint32(abs, word >>> 0, !!viewLittleEndian);
    const entry = {
      kind: 'edit',
      label: `编辑标量 ${ctxInfo && ctxInfo.path ? ctxInfo.path : '@' + abs}`,
      n: 1, offs, before, after: null,
      ctx: ctxInfo || null,
    };
    store.undoStack.push(entry);
    store.redoStack.length = 0;
    return entry;
  }

  /** 直接按转储地址顺序改写 4 个原始字节（与端序无关） */
  function commitRawBytes(store, abs, bytes4, ctxInfo) {
    if (!store.dump) throw new SpecError('尚未导入转储');
    if (!Number.isInteger(abs) || abs < 0 || abs + 4 > store.dump.length) {
      throw new SpecError(`编辑偏移 ${abs} 越界`, ctxInfo || { offset: abs });
    }
    const dv = nativeView(store.dump);
    const offs = Uint32Array.of(abs);
    const before = Uint32Array.of(dv.getUint32(abs, NATIVE_LE));
    for (let i = 0; i < 4; i++) store.dump[abs + i] = bytes4[i] & 0xff;
    const entry = {
      kind: 'edit',
      label: `编辑原始字节 ${ctxInfo && ctxInfo.path ? ctxInfo.path : '@' + abs}`,
      n: 1, offs, before, after: null, ctx: ctxInfo || null,
    };
    store.undoStack.push(entry);
    store.redoStack.length = 0;
    return entry;
  }

  function undo(store) {
    const entry = store.undoStack.pop();
    if (!entry) return null;
    const dv = nativeView(store.dump);
    if (!entry.after) {
      entry.after = new Uint32Array(entry.n);
      for (let k = 0; k < entry.n; k++) entry.after[k] = dv.getUint32(entry.offs[k], NATIVE_LE);
    }
    for (let k = 0; k < entry.n; k++) dv.setUint32(entry.offs[k], entry.before[k], NATIVE_LE);
    store.redoStack.push(entry);
    return entry;
  }

  function redo(store) {
    const entry = store.redoStack.pop();
    if (!entry) return null;
    if (!entry.after) throw new SpecError('重做数据缺失');
    const dv = nativeView(store.dump);
    for (let k = 0; k < entry.n; k++) dv.setUint32(entry.offs[k], entry.after[k], NATIVE_LE);
    store.undoStack.push(entry);
    return entry;
  }

  function createStore() {
    return {
      layoutJson: null,
      projectName: '',
      views: [],
      dump: null,
      undoStack: [],
      redoStack: [],
    };
  }

  /** 原子导入：编译+区间校验全部通过后才替换状态；成功清空历史 */
  function importProject(store, layoutJson, dump) {
    const project = L.compileRoot(layoutJson);
    if (!(dump instanceof Uint8Array)) {
      throw new SpecError('缺少 dump.bin 字节数据');
    }
    L.bindDump(project, dump.length);
    store.layoutJson = layoutJson;
    store.views = project.views;
    store.dump = dump;
    store.undoStack = [];
    store.redoStack = [];
    return project;
  }

  /** 仅替换转储（布局已存在时重新校验区间），失败保留旧 dump */
  function replaceDump(store, dump) {
    if (!store.views.length) throw new SpecError('请先导入 layout.json');
    L.bindDump({ views: store.views }, dump.length);
    const old = store.dump;
    store.dump = dump;
    store.undoStack = [];
    store.redoStack = [];
    return old;
  }

  return {
    NATIVE_LE,
    createStore,
    importProject,
    replaceDump,
    checkShape,
    countMatched,
    planBatch,
    applyPlan,
    runBatch,
    commitEdit,
    commitRawBytes,
    undo,
    redo,
    wordBytes,
    nativeView,
  };
});
