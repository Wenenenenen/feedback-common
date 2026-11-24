/* Focus Voyager 焦点引擎 —— 纯逻辑，不依赖 DOM。
 * 浏览器（index.html）与 Node（压测脚本）共用。
 *
 * 语义（依据 samples/focus-voyager.json 的 rules）：
 * - 坐标为内容空间整数 x,y,w,h；下级坐标相对直属面板左上角；
 *   祖先 scroll 从内容坐标减去；裁剪用半开矩形 [x, x+w) × [y, y+h)。
 * - 方向按（各级裁剪后矩形的）中心严格比较，副轴用绝对差；
 *   正交投影只在有正长度重叠时计相交。
 * - 候选排序：投影相交优先 → 主轴中心差 → 副轴中心差 → 控件号。
 * - 滚动从 0 起并钳到 [0, limit]；没目标时沿方向滚动有余量的最近祖先一步，
 *   不自动再跳；原控件看不见才选活动层最小号可见可用控件，无则置空。
 * - 进入层（含初始层与 open）选该层最小号可见可用按钮；焦点为空时按方向键同规则。
 * - 弹窗可嵌套；close 恢复 open 前的滚动位置及焦点，焦点失效按同一规则兜底。
 * - 未给 enabled 时可用；enable 操作可改非活动层。
 */
(function (global) {
  'use strict';

  function createEngine(data) {
    const view = { x: data.view[0], y: data.view[1], w: data.view[2], h: data.view[3] };
    const layerIds = (data.layers || []).map(l => l.id);

    const panels = new Map();
    for (const p of data.panels || []) {
      panels.set(p.id, {
        id: p.id, layer: p.layer,
        parent: p.panel != null ? p.panel : null,
        x: p.rect[0], y: p.rect[1], w: p.rect[2], h: p.rect[3],
        lx: p.limit ? p.limit[0] : 0, ly: p.limit ? p.limit[1] : 0,
        tx: p.step ? p.step[0] : 0, ty: p.step ? p.step[1] : 0,
        sx: 0, sy: 0,
      });
    }

    const buttons = new Map();
    const layerButtons = new Map(); // layerId -> 按 id 升序
    for (const b of data.buttons || []) {
      const btn = {
        id: b.id, layer: b.layer,
        panel: b.panel != null ? b.panel : null,
        x: b.rect[0], y: b.rect[1], w: b.rect[2], h: b.rect[3],
        enabled: b.enabled !== false,
        chain: null,          // 祖先面板，外 -> 内
        cv: -1,               // 缓存的几何版本号
        ux0: 0, uy0: 0, ux1: 0, uy1: 0, // 未裁剪屏幕矩形
        cx0: 0, cy0: 0, cx1: 0, cy1: 0, // 裁剪后屏幕矩形
        cvis: false,
      };
      buttons.set(b.id, btn);
      let arr = layerButtons.get(b.layer);
      if (!arr) { arr = []; layerButtons.set(b.layer, arr); }
      arr.push(btn);
    }
    for (const arr of layerButtons.values()) arr.sort((a, b) => a.id - b.id);

    for (const btn of buttons.values()) {
      const inner = [];
      let p = btn.panel != null ? panels.get(btn.panel) : null;
      let guard = 0;
      while (p && guard++ < 4096) { inner.push(p); p = p.parent != null ? panels.get(p.parent) : null; }
      inner.reverse();
      btn.chain = inner;
    }

    const panelsByLayer = new Map();
    for (const p of panels.values()) {
      let arr = panelsByLayer.get(p.layer);
      if (!arr) { arr = []; panelsByLayer.set(p.layer, arr); }
      arr.push(p);
    }
    for (const arr of panelsByLayer.values()) arr.sort((a, b) => a.id - b.id);

    // ---- 可变状态 ----
    let geomVersion = 1;          // 任何滚动变化都会 +1，使裁剪缓存失效
    let layerStack = [];          // 底 -> 顶，栈顶为活动层
    let focus = null;             // 焦点按钮 id 或 null
    let savedCtx = [];            // open 时保存的 { focus, journalStart }
    let journal = [];             // 滚动日志 [panel, prevX, prevY]，close 时回滚
    let lastScrollChanges = [];   // 上一条 op 产生的 [[panelId, x, y], ...]

    // 计算按钮经各级裁剪后的屏幕矩形，结果缓存到按钮上；返回是否可见（半开矩形有正面积）
    function clipOf(btn) {
      if (btn.cv === geomVersion) return btn.cvis;
      let ox = view.x, oy = view.y; // 当前容器内容原点的屏幕坐标（已减滚动）
      let cl = view.x, ct = view.y, cr = view.x + view.w, cb = view.y + view.h;
      const ch = btn.chain;
      for (let i = 0; i < ch.length; i++) {
        const p = ch[i];
        const px = ox + p.x, py = oy + p.y; // 面板自身屏幕左上角
        if (px > cl) cl = px;
        if (py > ct) ct = py;
        if (px + p.w < cr) cr = px + p.w;
        if (py + p.h < cb) cb = py + p.h;
        ox = px - p.sx;
        oy = py - p.sy;
      }
      const x0 = ox + btn.x, y0 = oy + btn.y, x1 = x0 + btn.w, y1 = y0 + btn.h;
      btn.ux0 = x0; btn.uy0 = y0; btn.ux1 = x1; btn.uy1 = y1;
      const cx0 = x0 > cl ? x0 : cl, cy0 = y0 > ct ? y0 : ct;
      const cx1 = x1 < cr ? x1 : cr, cy1 = y1 < cb ? y1 : cb;
      btn.cx0 = cx0; btn.cy0 = cy0; btn.cx1 = cx1; btn.cy1 = cy1;
      btn.cvis = cx1 > cx0 && cy1 > cy0;
      btn.cv = geomVersion;
      return btn.cvis;
    }

    // 面板的屏幕矩形（被祖先与视口裁剪），供渲染用
    function panelRect(p) {
      const inner = [];
      let q = p.parent != null ? panels.get(p.parent) : null;
      let guard = 0;
      while (q && guard++ < 4096) { inner.push(q); q = q.parent != null ? panels.get(q.parent) : null; }
      inner.reverse();
      let ox = view.x, oy = view.y;
      let cl = view.x, ct = view.y, cr = view.x + view.w, cb = view.y + view.h;
      for (const a of inner) {
        const ax = ox + a.x, ay = oy + a.y;
        if (ax > cl) cl = ax;
        if (ay > ct) ct = ay;
        if (ax + a.w < cr) cr = ax + a.w;
        if (ay + a.h < cb) cb = ay + a.h;
        ox = ax - a.sx; oy = ay - a.sy;
      }
      const x0 = ox + p.x, y0 = oy + p.y, x1 = x0 + p.w, y1 = y0 + p.h;
      const cx0 = Math.max(x0, cl), cy0 = Math.max(y0, ct);
      const cx1 = Math.min(x1, cr), cy1 = Math.min(y1, cb);
      return { x0, y0, x1, y1, cx0, cy0, cx1, cy1, vis: cx1 > cx0 && cy1 > cy0 };
    }

    function activeLayer() {
      return layerStack.length ? layerStack[layerStack.length - 1] : undefined;
    }

    function minVisibleEnabled(layerId) {
      const arr = layerButtons.get(layerId);
      if (!arr) return null;
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        if (b.enabled && clipOf(b)) return b.id;
      }
      return null;
    }

    function focusValid() {
      if (focus == null) return false;
      const b = buttons.get(focus);
      return !!b && b.enabled && b.layer === activeLayer() && clipOf(b);
    }

    // dir: 0=left 1=right 2=up 3=down
    function dirOp(dir) {
      const layer = activeLayer();
      if (layer === undefined) { focus = null; return; }
      if (!focusValid()) { focus = minVisibleEnabled(layer); return; }
      const cur = buttons.get(focus);
      // 用中心的两倍做整数比较，避免浮点
      const ccx = cur.cx0 + cur.cx1, ccy = cur.cy0 + cur.cy1;
      const horizontal = dir === 0 || dir === 1;
      const arr = layerButtons.get(layer) || [];
      let best = null, bMain = 0, bSec = 0, bProj = false;
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        if (!b.enabled || b === cur) continue;
        if (!clipOf(b)) continue;
        const bx = b.cx0 + b.cx1, by = b.cy0 + b.cy1;
        let main, sec, proj;
        if (horizontal) {
          if (dir === 1) { if (bx <= ccx) continue; main = bx - ccx; }
          else { if (bx >= ccx) continue; main = ccx - bx; }
          sec = by > ccy ? by - ccy : ccy - by;
          proj = Math.min(b.cy1, cur.cy1) - Math.max(b.cy0, cur.cy0) > 0;
        } else {
          if (dir === 3) { if (by <= ccy) continue; main = by - ccy; }
          else { if (by >= ccy) continue; main = ccy - by; }
          sec = bx > ccx ? bx - ccx : ccx - bx;
          proj = Math.min(b.cx1, cur.cx1) - Math.max(b.cx0, cur.cx0) > 0;
        }
        if (!best) { best = b; bMain = main; bSec = sec; bProj = proj; continue; }
        if (proj !== bProj) { if (proj) { best = b; bMain = main; bSec = sec; bProj = proj; } continue; }
        if (main !== bMain) { if (main < bMain) { best = b; bMain = main; bSec = sec; } continue; }
        if (sec !== bSec) { if (sec < bSec) { best = b; bSec = sec; } continue; }
        if (b.id < best.id) best = b;
      }
      if (best) { focus = best.id; return; }
      // 没目标：沿方向滚动有余量的最近祖先一步（钳到 [0, limit]），不自动再跳
      const ch = cur.chain;
      for (let i = ch.length - 1; i >= 0; i--) {
        const p = ch[i];
        let nsx = p.sx, nsy = p.sy;
        if (dir === 1 && p.sx < p.lx) nsx = Math.min(p.lx, p.sx + p.tx);
        else if (dir === 0 && p.sx > 0) nsx = Math.max(0, p.sx - p.tx);
        else if (dir === 3 && p.sy < p.ly) nsy = Math.min(p.ly, p.sy + p.ty);
        else if (dir === 2 && p.sy > 0) nsy = Math.max(0, p.sy - p.ty);
        else continue;
        journal.push([p, p.sx, p.sy]);
        p.sx = nsx; p.sy = nsy;
        geomVersion++;
        lastScrollChanges.push([p.id, nsx, nsy]);
        break;
      }
      // 原控件看不见才兜底：选活动层最小号可见可用控件，无则置空
      if (!clipOf(cur)) focus = minVisibleEnabled(layer);
    }

    function openLayer(id) {
      if (!layerIds.includes(id)) return '未知层 ' + id;
      savedCtx.push({ focus, journalStart: journal.length });
      layerStack.push(id);
      focus = minVisibleEnabled(id);
      return null;
    }

    function closeLayer() {
      if (layerStack.length <= 1) return '已在最底层，无法关闭';
      const ctx = savedCtx.pop();
      layerStack.pop();
      // 恢复 open 前的滚动位置
      let changed = false;
      while (journal.length > ctx.journalStart) {
        const ent = journal.pop();
        const p = ent[0];
        if (p.sx !== ent[1] || p.sy !== ent[2]) {
          lastScrollChanges.push([p.id, ent[1], ent[2]]);
          p.sx = ent[1]; p.sy = ent[2];
          changed = true;
        }
      }
      if (changed) geomVersion++;
      // 恢复 open 前的焦点；失效则按同一规则兜底
      const layer = activeLayer();
      const b = ctx.focus != null ? buttons.get(ctx.focus) : null;
      if (b && b.enabled && b.layer === layer && clipOf(b)) focus = b.id;
      else focus = minVisibleEnabled(layer);
      return null;
    }

    function setEnabled(id, value) {
      const b = buttons.get(id);
      if (!b) return '未知控件 ' + id;
      b.enabled = !!value;
      return null;
    }

    function setFocus(id) {
      const b = buttons.get(id);
      if (!b) return '未知控件 ' + id;
      if (b.layer !== activeLayer()) return '控件 ' + id + ' 不在活动层';
      if (!b.enabled) return '控件 ' + id + ' 不可用';
      if (!clipOf(b)) return '控件 ' + id + ' 不可见';
      focus = id;
      return null;
    }

    function applyOp(op) {
      lastScrollChanges = [];
      let error = null;
      switch (op.op) {
        case 'left': dirOp(0); break;
        case 'right': dirOp(1); break;
        case 'up': dirOp(2); break;
        case 'down': dirOp(3); break;
        case 'open': error = openLayer(op.id); break;
        case 'close': error = closeLayer(); break;
        case 'enable': error = setEnabled(op.id, 'value' in op ? !!op.value : true); break;
        case 'focus': error = setFocus(op.id); break;
        default: error = '未知操作 ' + op.op;
      }
      return {
        op, focus,
        scrolls: lastScrollChanges.slice(),
        layers: layerStack.slice(),
        error,
      };
    }

    function reset() {
      for (const p of panels.values()) { p.sx = 0; p.sy = 0; }
      geomVersion++;
      layerStack = layerIds.length ? [layerIds[0]] : [];
      savedCtx = [];
      journal = [];
      lastScrollChanges = [];
      focus = layerStack.length ? minVisibleEnabled(layerStack[0]) : null;
    }

    function getScrolls() {
      const out = {};
      for (const p of panels.values()) if (p.sx !== 0 || p.sy !== 0) out[p.id] = [p.sx, p.sy];
      return out;
    }

    reset();

    return {
      view, layerIds, panels, buttons, layerButtons, panelsByLayer,
      clipOf, panelRect, minVisibleEnabled,
      applyOp, reset,
      get focus() { return focus; },
      get layerStack() { return layerStack.slice(); },
      activeLayer,
      getScrolls,
    };
  }

  const api = { createEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FocusEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
