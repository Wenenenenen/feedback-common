/*
 * studio.js — 有状态编辑器：当前曲线 + 撤销/重做 + 导入导出。
 * 不依赖 DOM，可直接在 Node 中测试。
 *
 * 历史不变量：
 *  - 任何成功编辑：旧快照进 undo 栈，清空 redo 栈；
 *  - 任何失败操作：当前曲线、undo、redo 均原封不动（失败不吞掉重做）；
 *  - undo/redo 互逆。
 */
(function () {
  'use strict';

  let E;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    E = Object.assign({}, require('./frac.js'), require('./engine.js'), require('./tessellate.js'));
  } else {
    E = globalThis.RKS;
  }
  const { parseCurveObject, curveToObject, cloneCurve } = E;

  const DEFAULT_FORMAT_TEXT =
    'degree为次数p；points各为[X,Y,W]，投影坐标为[X/W,Y/W]。' +
    'knots非降，数目为控制点数+p+1，两端各重复p+1次，内部重数最多p。' +
    '分量和节点用整数字符串或分数字符串，输出分母正且约分，整数不带分母。';

  class Studio {
    constructor(input) {
      this.undoStack = [];
      this.redoStack = [];
      this.listeners = [];
      this.formatText = DEFAULT_FORMAT_TEXT;
      this.lastError = null;
      this.gestureBase = null;
      if (input) this.load(input, { reset: true });
      else this.curve = null;
    }

    onChange(fn) { this.listeners.push(fn); return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    }; }
    emit(report) { for (const fn of this.listeners) { try { fn(report); } catch (_) { /* noop */ } } }

    /* ---------------- 导入 ---------------- */

    load(input, opts) {
      opts = opts || {};
      let obj = input;
      if (typeof input === 'string') {
        try { obj = JSON.parse(input); }
        catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message }; }
      }
      const res = parseCurveObject(obj);
      if (!res.ok) {
        this.lastError = res.errors.join('；');
        return { ok: false, error: this.lastError, errors: res.errors };
      }
      if (obj && typeof obj.format === 'string') this.formatText = obj.format;
      this.curve = res.curve;
      if (opts.reset !== false) {
        this.undoStack = [];
        this.redoStack = [];
      }
      this.lastError = null;
      this.emit({ type: 'load' });
      return { ok: true };
    }

    /* ---------------- 快照 ---------------- */

    snapshot(curve) {
      return JSON.stringify(curveToObject(curve || this.curve));
    }
    restore(text) {
      const obj = JSON.parse(text);
      const res = parseCurveObject(obj);
      if (!res.ok) throw new Error('快照无法恢复: ' + res.errors.join('；'));
      this.curve = res.curve;
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    /**
     * 提交一个纯操作结果。成功才写历史；失败原样返回且不动任何栈。
     */
    commit(result, label) {
      if (!result || !result.ok) {
        this.lastError = result ? result.error : '未知失败';
        this.emit({ type: 'failed', error: this.lastError, label });
        return { ok: false, error: this.lastError };
      }
      this.undoStack.push(this.snapshot(this.curve));
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.curve = result.curve;
      this.redoStack.length = 0;
      this.lastError = null;
      this.emit({ type: 'edit', label });
      return { ok: true };
    }

    undo() {
      if (!this.undoStack.length) {
        return { ok: false, error: '没有可撤销的编辑' };
      }
      this.redoStack.push(this.snapshot(this.curve));
      this.restore(this.undoStack.pop());
      this.lastError = null;
      this.emit({ type: 'undo' });
      return { ok: true };
    }

    redo() {
      if (!this.redoStack.length) {
        return { ok: false, error: '没有可重做的编辑' };
      }
      this.undoStack.push(this.snapshot(this.curve));
      this.restore(this.redoStack.pop());
      this.lastError = null;
      this.emit({ type: 'redo' });
      return { ok: true };
    }

    /* ---------------- 拖拽手势（一次拖拽 = 一次历史） ---------------- */

    beginGesture() { this.gestureBase = this.snapshot(); }
    liveMovePoint(i, x, y) {
      const res = E.moveProjectedPoint(this.curve, i, x, y);
      if (res.ok) { this.curve = res.curve; this.emit({ type: 'live' }); }
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    endGesture(label) {
      if (this.gestureBase == null) return { ok: false };
      const now = this.snapshot();
      const base = this.gestureBase;
      this.gestureBase = null;
      if (now !== base) {
        this.undoStack.push(base);
        if (this.undoStack.length > 300) this.undoStack.shift();
        this.redoStack.length = 0;
        this.emit({ type: 'edit', label: label || 'drag' });
      }
      return { ok: true, changed: now !== base };
    }
    cancelGesture() {
      if (this.gestureBase != null) {
        this.restore(this.gestureBase);
        this.gestureBase = null;
        this.emit({ type: 'cancel' });
      }
      return { ok: true };
    }

    /* ---------------- 编辑操作 ---------------- */

    insertKnot(u) {
      return this.commit(E.insertKnot(this.curve, u), 'insert-knot');
    }
    addKnot(u) { return this.insertKnot(u); }
    removeKnotAt(r) {
      return this.commit(E.removeKnotAt(this.curve, r), 'remove-knot');
    }
    /** 数字=下标；字符串/Frac=节点值。 */
    removeKnot(x, occ) {
      return typeof x === 'number' ? this.removeKnotAt(x) : this.removeKnotValue(x, occ);
    }
    /**
     * 按节点“值”删除一次出现（同值节点等价，删第一个内部出现位置）。
     * occurrence 可选：0 基选择第几个同值内部出现。
     */
    removeKnotValue(uInput, occurrence) {
      let u;
      try { u = E.Frac.parse(uInput); }
      catch (e) { return { ok: false, error: '节点值无法解析: ' + e.message }; }
      const c = this.curve;
      const { first, last } = E.interiorOccurrenceRange(c);
      const idxs = [];
      for (let i = first; i <= last; i++) if (c.knots[i].eq(u)) idxs.push(i);
      if (!idxs.length) return { ok: false, error: '内部节点中找不到值为 ' + u.toString() + ' 的出现位置' };
      const r = idxs[Number.isInteger(occurrence) ? Math.max(0, Math.min(occurrence, idxs.length - 1)) : 0];
      return this.removeKnotAt(r);
    }
    movePoint(i, x, y) {
      return this.commit(E.moveProjectedPoint(this.curve, i, x, y), 'move-point');
    }
    setWeight(i, w) {
      return this.commit(E.setWeight(this.curve, i, w), 'set-weight');
    }
    setHomogeneousPoint(i, X, Y, W) {
      return this.commit(E.setHomogeneousPoint(this.curve, i, X, Y, W), 'set-homogeneous');
    }

    query(u) { return E.queryAt(this.curve, u); }

    /** 查询的纯字符串/数字版本（可直接 JSON 序列化，供自动化检查）。 */
    queryPlain(u) {
      const r = E.queryAt(this.curve, u);
      if (!r.ok) return { ok: false, error: r.error };
      const side = (d) => d ? {
        dx: d.dx.toString(), dy: d.dy.toString(),
        dxDecimal: d.dx.toDecimal(10), dyDecimal: d.dy.toDecimal(10),
      } : null;
      return {
        ok: true,
        u: r.u.toString(),
        atStart: r.atStart,
        atEnd: r.atEnd,
        point: {
          x: r.point.x.toString(), y: r.point.y.toString(),
          xDecimal: r.point.x.toDecimal(10), yDecimal: r.point.y.toDecimal(10),
        },
        homogeneous: { X: r.point.X.toString(), Y: r.point.Y.toString(), W: r.point.W.toString() },
        left: side(r.left),
        right: side(r.right),
      };
    }

    /** 导出段的纯数据（参数与端点均为十进制字符串/数字）。 */
    segmentsData() {
      const built = E.buildExportSVG(this.curve);
      return {
        count: built.segmentCount,
        maxDeviation: built.maxDeviation,
        limit: built.limit,
        segments: built.segments.map((s) => ({
          u0: s.u0.toDecimal(12),
          u1: s.u1.toDecimal(12),
          maxDev: s.maxDev,
        })),
        svg: built.svg,
      };
    }

    /* ---------------- 导出 ---------------- */

    exportObject(withFormat) {
      const obj = curveToObject(this.curve);
      if (withFormat !== false) obj.format = this.formatText || DEFAULT_FORMAT_TEXT;
      // 调整键顺序，与样例一致：format, degree, knots, points
      if (withFormat !== false) {
        return { format: obj.format, degree: obj.degree, knots: obj.knots, points: obj.points };
      }
      return { degree: obj.degree, knots: obj.knots, points: obj.points };
    }
    exportJSON(indent) { return JSON.stringify(this.exportObject(true), null, indent || 0); }

    exportSVG(opts) { return E.buildExportSVG(this.curve, opts); }
  }

  const api = { Studio, DEFAULT_FORMAT_TEXT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') {
    globalThis.RKS = globalThis.RKS || {};
    globalThis.RKS.Studio = Studio;
    globalThis.RKS.DEFAULT_FORMAT_TEXT = DEFAULT_FORMAT_TEXT;
    globalThis.RKS.studio = null; // app 启动后赋值单例
  }
})();
