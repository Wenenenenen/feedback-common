/*
 * app.js — UI 控制器 + window.Rebinder 脚本接口。
 * 依赖 layout.js / zip.js / engine.js（经典脚本，顺序加载）。
 */
(function () {
  'use strict';
  const L = window.RBLayout;
  const Zip = window.RBZip;
  const E = window.RBEngine;

  const HEX_PAGE = 4096;
  const TREE_INLINE_ARRAY = 16; // 小数组直接展开每个下标

  const store = E.createStore();
  const ui = {
    activeView: null,
    pathView: null,
    tab: 'tree',
    hexStart: 0,
    queryAbs: null,
    sel: null, // {viewName,path,abs,scalar}
    pairs: [],
  };

  const $ = (id) => document.getElementById(id);
  const els = {};

  /* ============================ 工具 ============================ */

  function describeErr(e) {
    if (!e) return '未知错误';
    if (typeof e.describe === 'function') return e.describe();
    return e.message || String(e);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function setStatus(kind, html) {
    const s = $('status');
    s.className = kind || 'idle';
    if (html !== undefined) s.innerHTML = html;
  }
  function setError(e) {
    const msg = describeErr(e);
    window.__lastError = msg;
    setStatus('error', '✗ ' + escapeHtml(msg));
    console.error(e);
  }
  function setOk(msg) {
    window.__lastError = null;
    setStatus('ok', '✓ ' + escapeHtml(msg));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function parseOffset(text) {
    const s = String(text).trim().toLowerCase();
    if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) return parseInt(s, 16);
    return NaN;
  }

  function getView(name) {
    return store.views.find((v) => v.name === name) || null;
  }

  /* ============================ 导入 ============================ */

  function u8FromAny(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('不支持的转储字节类型');
  }

  /** 原子加载：任何编译/区间错误都不会替换当前项目 */
  function loadObjects(layoutObj, dumpAny, projectName) {
    let dump = dumpAny == null ? null : u8FromAny(dumpAny);
    // 仅给 layout 无 dump 时，构造覆盖全部视图区间的零转储
    if (!dump) {
      const probe = L.compileRoot(layoutObj);
      let maxEnd = 0;
      for (const v of probe.views) maxEnd = Math.max(maxEnd, v.offset + v.length);
      dump = new Uint8Array(Math.max(maxEnd, 1));
    }
    E.importProject(store, layoutObj, dump); // 成功才替换
    ui.activeView = store.views[0].name;
    ui.pathView = store.views[0].name;
    ui.sel = null;
    ui.queryAbs = null;
    ui.pairs = [];
    ui.hexStart = 0;
    window.__lastError = null;
    setOk(`已导入 ${projectName || '项目'}：${store.views.length} 个视图 / ${store.dump.length.toLocaleString('en-US')} 字节`);
    renderAll();
    return summary();
  }

  async function loadZipBuffer(buf, name) {
    const entries = await Zip.unzip(buf);
    const lj = Zip.pickNamed(entries, 'layout.json');
    const db = Zip.pickNamed(entries, 'dump.bin');
    if (!lj) throw new Error('归档中找不到 layout.json');
    if (!db) throw new Error('归档中找不到 dump.bin');
    const text = new TextDecoder('utf-8').decode(lj.bytes);
    const layoutObj = JSON.parse(text);
    return loadObjects(layoutObj, db.bytes, name || 'ZIP 归档');
  }

  async function handleFileList(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setStatus('busy', '正在读取文件…');
    try {
      const zip = files.find((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip');
      if (zip) {
        const buf = await zip.arrayBuffer();
        await loadZipBuffer(buf, zip.name);
        return;
      }
      const jsonFile = files.find((f) => /layout.*\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
      const binFile = files.find((f) => /dump.*\.bin$/i.test(f.name)) || files.find((f) => /\.(bin|raw)$/i.test(f.name));
      let layoutObj = store.layoutJson;
      if (jsonFile) layoutObj = JSON.parse(await jsonFile.text());
      let dump = null;
      if (binFile) dump = new Uint8Array(await binFile.arrayBuffer());
      if (!jsonFile && binFile) {
        // 只换 dump
        E.replaceDump(store, dump);
        setOk(`已载入转储 ${binFile.name}：${dump.length} 字节`);
        renderAll();
        return;
      }
      if (!layoutObj) throw new Error('请提供 layout.json（或包含 layout.json 与 dump.bin 的 ZIP）');
      loadObjects(layoutObj, dump, jsonFile ? jsonFile.name : '项目');
    } catch (e) {
      setError(e);
      toast('导入失败：' + describeErr(e), true);
    }
  }

  /* ============================ 渲染：视图 ============================ */

  function renderViews() {
    const wrap = $('view-list');
    $('view-count').textContent = store.views.length ? `${store.views.length}/64` : '';
    $('project-meta').textContent = store.dump
      ? `转储 ${store.dump.length.toLocaleString('en-US')} 字节（上限 64 MiB）`
      : '';
    if (!store.views.length) {
      wrap.innerHTML = '<div class="empty">导入后在此列出 1–64 个视图</div>';
    } else {
      wrap.innerHTML = '';
      for (const v of store.views) {
        const div = document.createElement('div');
        div.className = 'view-item' + (v.name === ui.activeView ? ' active' : '');
        div.dataset.view = v.name;
        div.innerHTML = `
          <div class="row1">
            <span class="vname">${escapeHtml(v.name)}</span>
            <span class="badges">
              <span class="badge ${v.std === 'std140' ? 's140' : 's430'}">${v.std}</span>
              <span class="badge">${v.major === 'row' ? '行主' : '列主'}</span>
              <span class="badge ${v.littleEndian ? 'le' : 'be'}">${v.littleEndian ? 'LE' : 'BE'}</span>
            </span>
          </div>
          <div class="vmeta">off=${v.offset} len=${v.length} · ${v.declCount} 声明${v.dynamic ? ` · 动态 ${v.dynamic.count} 项` : ''}</div>
          <div class="pick">
            <button type="button" data-act="src">设为源</button>
            <button type="button" data-act="dst">设为目标</button>
            <button type="button" data-act="path">用于路径</button>
          </div>`;
        div.addEventListener('click', (e) => {
          const act = e.target && e.target.dataset && e.target.dataset.act;
          if (act === 'src') { $('pair-src').value = v.name; return; }
          if (act === 'dst') { $('pair-dst').value = v.name; return; }
          if (act === 'path') { ui.pathView = v.name; $('path-view').value = v.name; renderTree(); return; }
          ui.activeView = v.name;
          if (!ui.pathView) ui.pathView = v.name;
          renderViews(); renderTree(); renderHex();
        });
        wrap.appendChild(div);
      }
    }
    // selects
    for (const id of ['pair-src', 'pair-dst', 'path-view']) {
      const sel = $(id);
      const keep = sel.value || (id === 'path-view' ? ui.pathView : null);
      sel.innerHTML = store.views.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join('');
      if (keep && getView(keep)) sel.value = keep;
      else if (store.views[0]) sel.selectedIndex = 0;
    }
    $('path-view').value = ui.pathView && getView(ui.pathView) ? ui.pathView : (store.views[0] && store.views[0].name) || '';
  }

  /* ============================ 结构树 ============================ */

  function typeLabel(node) {
    switch (node.kind) {
      case 'scalar': return node.scalar;
      case 'vec': return `vec${node.n}<${node.scalar}>`;
      case 'mat': return `mat${node.rows}×${node.cols}`;
      case 'array': return node.fixed === null ? `dynamic[${node.count}]` : `[${node.fixed}]`;
      case 'struct': return `struct{${node.members.length}}`;
      default: return node.kind;
    }
  }

  function renderTree() {
    const wrap = $('tree');
    const v = getView(ui.pathView) || getView(ui.activeView) || store.views[0];
    if (!v) { wrap.innerHTML = '<div class="empty">暂无结构</div>'; return; }
    ui.pathView = v.name;
    $('path-view').value = v.name;
    wrap.innerHTML = '';
    const root = buildStructChildren(v.root.members, 0, '', v);
    wrap.appendChild(root);
    markSelectedTree();
  }

  function offsetText(rel) { return `@${rel}`; }

  /** 构造一个结构的成员集合 */
  function buildStructChildren(members, baseRel, pathPrefix, view) {
    const box = document.createElement('div');
    box.className = 't-children';
    for (const m of members) {
      box.appendChild(buildMember(m, baseRel + m.rel, pathPrefix ? `${pathPrefix}.${m.name}` : m.name, view));
    }
    return box;
  }

  function buildMember(m, rel, path, view) {
    const holder = document.createElement('div');
    holder.className = 't-node';
    const row = document.createElement('div');
    row.className = 't-row';
    const hasKids = memberHasKids(m.type);
    row.innerHTML = `
      <span class="t-toggle">${hasKids ? '▸' : ''}</span>
      <span class="t-name">${escapeHtml(m.name)}</span>
      <span class="t-type">${escapeHtml(typeLabel(m.type))}</span>
      <span class="t-off" title="相对视图起点 / 绝对偏移">rel${offsetText(rel)} · abs${view.offset + rel}</span>
      <span class="t-size">${m.type.size != null ? m.type.size + 'B' : (m.dynamic ? '动态' : '')}</span>
      ${m.explicitAlign ? `<span class="badge">align ${m.explicitAlign}</span>` : ''}
      ${m.explicitOffset != null ? `<span class="badge">offset ${m.explicitOffset}</span>` : ''}`;
    holder.appendChild(row);

    let kidBox = null;
    if (hasKids) {
      kidBox = document.createElement('div');
      kidBox.className = 't-children hidden-kids';
      kidBox.style.display = 'none';
      holder.appendChild(kidBox);
      row.querySelector('.t-toggle').textContent = '▸';
      row.addEventListener('click', () => {
        const open = kidBox.style.display !== 'none';
        kidBox.style.display = open ? 'none' : 'block';
        row.querySelector('.t-toggle').textContent = open ? '▸' : '▾';
        if (!open && kidBox.dataset.built !== '1') {
          kidBox.innerHTML = '';
          buildTypeKids(m.type, rel, path, view, kidBox);
          kidBox.dataset.built = '1';
          markSelectedTree();
        }
      });
    }
    return holder;
  }

  function memberHasKids(node) {
    return node.kind === 'struct' || node.kind === 'array' || node.kind === 'mat' || node.kind === 'vec';
  }

  /** 在容器中构造某类型节点的子内容（不含该节点自身的成员行） */
  function buildTypeKids(node, rel, path, view, box) {
    if (node.kind === 'struct') {
      for (const m of node.members) box.appendChild(buildMember(m, rel + m.rel, `${path}.${m.name}`, view));
      return;
    }
    if (node.kind === 'vec') {
      for (let i = 0; i < node.n; i++) {
        box.appendChild(leafRow(`${path}.v[${i}]`, rel + 4 * i, node.scalar, view, `v[${i}]`));
      }
      return;
    }
    if (node.kind === 'mat') {
      for (let r = 0; r < node.rows; r++) {
        for (let c = 0; c < node.cols; c++) {
          const off = L.matCompOffset(node, r, c);
          box.appendChild(leafRow(`${path}.m[${r}][${c}]`, rel + off, 'f32', view, `m[${r}][${c}]`));
        }
      }
      return;
    }
    if (node.kind === 'array') {
      const count = L.arrayCount(node) || 0;
      if (count <= TREE_INLINE_ARRAY) {
        for (let i = 0; i < count; i++) box.appendChild(buildArrayElement(node, i, rel + i * node.stride, `${path}[${i}]`, view));
      } else {
        const jump = document.createElement('div');
        jump.className = 't-row';
        jump.innerHTML = `<span class="t-toggle"></span><span class="t-idxjump">下标 0..${count - 1}：<input type="text" inputmode="numeric" placeholder="i"><button class="btn mini" type="button">查看</button></span>`;
        const input = jump.querySelector('input');
        const btn = jump.querySelector('button');
        const show = () => {
          const i = parseInt(input.value, 10);
          if (!Number.isInteger(i) || i < 0 || i >= count) { toast('下标越界', true); return; }
          box.querySelectorAll('.idx-single').forEach((n) => n.remove());
          const single = document.createElement('div');
          single.className = 'idx-single';
          single.appendChild(buildArrayElement(node, i, rel + i * node.stride, `${path}[${i}]`, view));
          box.appendChild(single);
          setTimeout(markSelectedTree, 0);
        };
        btn.addEventListener('click', show);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(); });
        box.appendChild(jump);
        // 默认展示第 0 项
        box.appendChild(buildArrayElement(node, 0, rel, `${path}[0]`, view));
      }
    }
  }

  function buildArrayElement(arrNode, i, rel, path, view) {
    const holder = document.createElement('div');
    if (arrNode.elem.kind === 'scalar' || arrNode.elem.kind === 'vec' || arrNode.elem.kind === 'mat') {
      // 直接给出元素入口；复合叶子继续可展开
      if (arrNode.elem.kind === 'scalar') {
        holder.appendChild(leafRow(path, rel, arrNode.elem.scalar, view, `[${i}]`));
      } else {
        const fake = { name: `[${i}]`, type: arrNode.elem, rel: 0 };
        holder.appendChild(buildMember(fake, rel, path, view));
      }
    } else {
      const fake = { name: `[${i}]`, type: arrNode.elem, rel: 0 };
      holder.appendChild(buildMember(fake, rel, path, view));
    }
    return holder;
  }

  function leafRow(path, rel, scalar, view, label) {
    const row = document.createElement('div');
    row.className = 't-row leaf';
    row.dataset.path = path;
    row.dataset.view = view.name;
    row.dataset.abs = String(view.offset + rel);
    row.title = `规范路径 ${path}；矩阵也可简写为连续下标`;
    row.innerHTML = `
      <span class="t-toggle"></span>
      <span class="t-name">${escapeHtml(label || path)}</span>
      <span class="t-type">${scalar}</span>
      <span class="t-off">abs${view.offset + rel}</span>`;
    row.addEventListener('click', () => selectScalar(view.name, path));
    return row;
  }

  function markSelectedTree() {
    document.querySelectorAll('#tree .t-row.selected').forEach((n) => n.classList.remove('selected'));
    if (!ui.sel) return;
    const el = document.querySelector(`#tree .t-row.leaf[data-view="${cssQ(ui.sel.viewName)}"][data-path="${cssQ(ui.sel.path)}"]`);
    if (el) {
      el.classList.add('selected');
      // 展开所有祖先 details-like kids
      let p = el.parentElement;
      while (p && p.id !== 'tree') {
        if (p.classList && p.classList.contains('hidden-kids')) {
          p.style.display = 'block';
          p.dataset.built = '1';
          const toggle = p.parentElement && p.parentElement.querySelector(':scope > .t-row .t-toggle');
          if (toggle) toggle.textContent = '▾';
        }
        p = p.parentElement;
      }
      el.scrollIntoView({ block: 'nearest' });
    }
  }
  function cssQ(s) { return String(s).replace(/"/g, '\\"'); }

  /* ============================ 选择 / 检查器 ============================ */

  function selectScalar(viewName, path) {
    const v = getView(viewName);
    if (!v) return;
    const r = L.resolvePath(v, path);
    if (!r.ok || !r.scalar) { setError(new L.SpecError(r.error)); return; }
    ui.sel = { viewName: v.name, path: r.path, abs: r.abs, scalar: r.scalar };
    ui.activeView = v.name;
    // hex 翻到所在页
    const pageStart = Math.floor(r.abs / HEX_PAGE) * HEX_PAGE;
    if (r.abs < ui.hexStart || r.abs + 4 > ui.hexStart + HEX_PAGE) ui.hexStart = pageStart;
    renderViews();
    renderInspector();
    renderHex();
    markSelectedTree();
    // 同步反查面板到该偏移
    ui.queryAbs = r.abs;
    renderQuery();
  }

  function renderInspector() {
    const box = $('inspector');
    if (!ui.sel || !store.dump) {
      box.innerHTML = '<div class="empty">在结构树中点选标量，或在反查结果中选择分量</div>';
      updateEditButtons();
      return;
    }
    const v = getView(ui.sel.viewName);
    const r = L.resolvePath(v, ui.sel.path);
    if (!r.ok || !r.scalar) { box.innerHTML = '<div class="empty">选择已失效</div>'; return; }
    const abs = r.abs;
    const dv = new DataView(store.dump.buffer, store.dump.byteOffset, store.dump.byteLength);
    const wordView = dv.getUint32(abs, v.littleEndian) >>> 0;
    const bytes = [];
    for (let i = 0; i < 4; i++) bytes.push(store.dump[abs + i].toString(16).padStart(2, '0'));
    const hexWord = wordView.toString(16).padStart(8, '0');
    const i32 = dv.getInt32(abs, v.littleEndian);
    const u32 = dv.getUint32(abs, v.littleEndian) >>> 0;
    const f32 = dv.getFloat32(abs, v.littleEndian);
    const f32str = Number.isFinite(f32) ? (Object.is(f32, -0) ? '-0' : String(+f32.toPrecision(8))) : (f32 > 0 ? 'NaN-ish' : 'NaN');
    box.innerHTML = `
      <dl class="kv">
        <dt>视图</dt><dd>${escapeHtml(v.name)}（${v.endian}）</dd>
        <dt>路径</dt><dd>${escapeHtml(r.path)}</dd>
        <dt>绝对偏移</dt><dd>${abs} / 0x${abs.toString(16)} · 字节范围 ${abs}–${abs + 3}</dd>
        <dt>相对偏移</dt><dd>${r.rel}（视图起点 ${v.offset}）</dd>
        <dt>类型</dt><dd>${r.scalar} · 4 字节</dd>
        <dt>转储字节序</dt><dd class="rawbytes">${bytes.join(' ')}</dd>
      </dl>
      <label class="hint" for="hex-word">32 位十六进制原位值（按视图端序解释，写回时保持该端序）</label>
      <div class="hex-edit-row">
        <input id="hex-word" type="text" maxlength="8" spellcheck="false" value="${hexWord}" aria-label="32位十六进制值">
        <button class="btn primary" id="btn-edit-hex" type="button">原位改写</button>
      </div>
      <label class="hint" for="raw-bytes">转储原始 4 字节（按绝对地址顺序，不经端序转换）</label>
      <div class="hex-edit-row">
        <input id="raw-bytes" type="text" maxlength="11" spellcheck="false" value="${bytes.join(' ')}" aria-label="原始四字节">
        <button class="btn" id="btn-edit-raw" type="button">改字节</button>
      </div>
      <div class="value-grid">
        <div class="value-cell"><div class="k">f32</div><div class="v" title="${f32}">${escapeHtml(f32str)}</div></div>
        <div class="value-cell"><div class="k">i32</div><div class="v">${i32}</div></div>
        <div class="value-cell"><div class="k">u32</div><div class="v">${u32}</div></div>
        <div class="value-cell"><div class="k">hex 位型</div><div class="v">0x${hexWord}</div></div>
      </div>`;
    $('btn-edit-hex').addEventListener('click', applyHexEdit);
    $('hex-word').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyHexEdit(); });
    $('btn-edit-raw').addEventListener('click', applyRawEdit);
    $('raw-bytes').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRawEdit(); });
    updateEditButtons();
  }

  function applyRawEdit() {
    if (!ui.sel) return;
    const raw = ($('raw-bytes').value || '').trim().split(/[\s,]+/).filter(Boolean);
    if (raw.length !== 4 || raw.some((b) => !/^[0-9a-fA-F]{1,2}$/.test(b))) {
      setError(new L.SpecError('原始字节需要 4 个十六进制字节，如 00 00 50 41', { path: ui.sel.path, offset: ui.sel.abs }));
      return;
    }
    const bytes = raw.map((b) => parseInt(b, 16));
    const v = getView(ui.sel.viewName);
    try {
      E.commitRawBytes(store, ui.sel.abs, bytes, { view: v.name, path: ui.sel.path, offset: ui.sel.abs });
      setOk(`已按地址顺序改写 ${ui.sel.path} @${ui.sel.abs} 的 4 个字节`);
      afterMutation();
    } catch (e) { setError(e); }
  }

  function applyHexEdit() {
    if (!ui.sel) return;
    const input = $('hex-word');
    const raw = (input.value || '').trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{1,8}$/.test(raw)) {
      setError(new L.SpecError(`十六进制值非法："${input.value}"，需要 1–8 位十六进制数字`, { path: ui.sel.path, offset: ui.sel.abs }));
      toast('HEX 输入非法', true);
      return;
    }
    const word = parseInt(raw, 16) >>> 0;
    const v = getView(ui.sel.viewName);
    try {
      E.commitEdit(store, ui.sel.abs, word, v.littleEndian, { view: v.name, path: ui.sel.path, offset: ui.sel.abs });
      setOk(`已改写 ${ui.sel.path} @${ui.sel.abs} 为 0x${word.toString(16).padStart(8, '0')}`);
      afterMutation();
    } catch (e) { setError(e); }
  }

  /* ============================ 反查 ============================ */

  function runOffsetQuery(abs) {
    if (!Number.isInteger(abs) || abs < 0 || abs >= store.dump.length) {
      setError(new L.SpecError(`绝对偏移 ${abs} 超出转储 0..${store.dump.length - 1}`));
      return;
    }
    ui.queryAbs = abs;
    // 翻 hex 页
    ui.hexStart = Math.floor(abs / HEX_PAGE) * HEX_PAGE;
    const covers = L.queryAbsolute(store.views, abs);
    const firstComp = covers.find((c) => !c.padding);
    if (firstComp) {
      ui.activeView = firstComp.view;
      ui.sel = { viewName: firstComp.view, path: firstComp.path, abs, scalar: firstComp.scalar };
    } else {
      ui.sel = null;
      const first = covers[0];
      if (first) ui.activeView = first.view;
    }
    renderAll();
  }

  function renderQuery() {
    const box = $('query-results');
    if (ui.queryAbs == null || !store.views.length) {
      box.innerHTML = '<div class="empty">在 Hex 中点击字节，或输入绝对偏移查询</div>';
      return;
    }
    const abs = ui.queryAbs;
    const covers = L.queryAbsolute(store.views, abs);
    if (!covers.length) {
      box.innerHTML = `<div class="empty">绝对偏移 ${abs}（0x${abs.toString(16)}）不被任何视图覆盖</div>`;
      return;
    }
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'hint';
    head.style.marginBottom = '4px';
    head.textContent = `绝对偏移 ${abs} / 0x${abs.toString(16)} · ${covers.length} 个覆盖视图`;
    box.appendChild(head);
    for (const c of covers) {
      const card = document.createElement('div');
      card.className = 'q-card' + (ui.sel && ui.sel.viewName === c.view && ui.sel.path === c.path ? ' active' : '');
      if (c.padding) {
        card.innerHTML = `<div class="qv"><span>${escapeHtml(c.view)}</span><span class="tag-pad">填充</span></div>
          <div class="qp">rel=${c.rel} · ${escapeHtml(c.detail || 'padding')}${c.path ? ' · ' + escapeHtml(c.path) : ''}</div>`;
      } else {
        card.innerHTML = `<div class="qv"><span>${escapeHtml(c.view)}</span><span class="tag-comp">分量 +${c.byteIndex}</span></div>
          <div class="qp">${escapeHtml(c.path)}<br>分量内零基字节偏移 ${c.byteIndex}（rel ${c.rel}，${c.scalar}）</div>`;
        card.addEventListener('click', () => selectScalar(c.view, c.path));
      }
      box.appendChild(card);
    }
  }

  /* ============================ Hex ============================ */

  function renderHex() {
    const hex = $('hex');
    if (!store.dump) { hex.innerHTML = ''; $('hex-page').textContent = ''; return; }
    const len = store.dump.length;
    const maxStart = Math.max(0, Math.ceil(len / HEX_PAGE) - 1) * HEX_PAGE;
    ui.hexStart = Math.max(0, Math.min(ui.hexStart, maxStart));
    const start = ui.hexStart;
    const end = Math.min(len, start + HEX_PAGE);
    const v = getView(ui.activeView);
    const frag = document.createDocumentFragment();

    for (let rowStart = start; rowStart < end; rowStart += 16) {
      const row = document.createElement('div');
      row.className = 'hx-row';
      const off = document.createElement('div');
      off.className = 'hx-off';
      off.textContent = rowStart.toString(16).padStart(8, '0');
      const bytes = document.createElement('div');
      bytes.className = 'hx-bytes';
      const ascii = document.createElement('div');
      ascii.className = 'hx-ascii';
      let asciiText = '';
      for (let i = 0; i < 16; i++) {
        const abs = rowStart + i;
        if (abs >= end) {
          const sp = document.createElement('span');
          sp.className = 'hx-byte';
          sp.textContent = '  ';
          bytes.appendChild(sp);
          asciiText += ' ';
          continue;
        }
        const b = store.dump[abs];
        const sp = document.createElement('span');
        sp.className = 'hx-byte' + ((i === 7) ? ' space8' : '');
        sp.dataset.off = String(abs);
        sp.textContent = b.toString(16).padStart(2, '0');
        let cls = '';
        let title = `abs ${abs}`;
        if (v && abs >= v.offset && abs < v.offset + v.length) {
          const loc = L.locateRel(v, abs - v.offset);
          if (loc.padding) { cls = 'pad'; title += `\n[${v.name}] 填充 ${loc.detail || ''}`; }
          else { cls = 'comp'; title += `\n[${v.name}] ${loc.path} +${loc.byteIndex}`; }
        }
        if (ui.sel && abs >= ui.sel.abs && abs < ui.sel.abs + 4) cls += ' sel';
        if (cls) sp.classList.add(...cls.trim().split(/\s+/));
        sp.title = title;
        bytes.appendChild(sp);
        asciiText += b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
      }
      ascii.textContent = asciiText;
      row.appendChild(off); row.appendChild(bytes); row.appendChild(ascii);
      frag.appendChild(row);
    }
    hex.innerHTML = '';
    hex.appendChild(frag);
    const pageIdx = Math.floor(start / HEX_PAGE) + 1;
    const pageCount = Math.ceil(len / HEX_PAGE);
    $('hex-page').textContent = `第 ${pageIdx}/${pageCount} 页 · ${start}..${end - 1}`;
    $('hex-prev').disabled = start === 0;
    $('hex-next').disabled = end >= len;
  }

  /* ============================ 批次 ============================ */

  function renderPairs() {
    const wrap = $('pair-list');
    $('btn-run-batch').disabled = !store.views.length || ui.pairs.length === 0;
    if (!ui.pairs.length) {
      wrap.innerHTML = '<div class="empty">还没有迁移对</div>';
      return;
    }
    wrap.innerHTML = '';
    ui.pairs.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'pair-row';
      row.innerHTML = `<span class="idx">${i + 1}</span>
        <span class="names">${escapeHtml(p[0])}<span class="arrow">→</span>${escapeHtml(p[1])}</span>
        <button type="button" title="移除">✕</button>`;
      row.querySelector('button').addEventListener('click', () => { ui.pairs.splice(i, 1); renderPairs(); });
      wrap.appendChild(row);
    });
  }

  function addPair(src, dst) {
    const s = src || $('pair-src').value;
    const d = dst || $('pair-dst').value;
    if (!getView(s) || !getView(d)) { toast('请先导入并选择两个视图', true); return; }
    if (ui.pairs.length >= 256) { toast('批次过大', true); return; }
    ui.pairs.push([s, d]);
    renderPairs();
  }

  function applyPairsJson() {
    try {
      const arr = JSON.parse($('pairs-json').value);
      if (!Array.isArray(arr)) throw new Error('需要 [["源","目标"], ...] 数组');
      const norm = arr.map((p) => {
        if (Array.isArray(p) && p.length === 2) return [String(p[0]), String(p[1])];
        if (p && p.src && p.dst) return [String(p.src), String(p.dst)];
        throw new Error('每一项必须是 [源, 目标]');
      });
      for (const [s, d] of norm) {
        if (!getView(s)) throw new Error(`源视图不存在：${s}`);
        if (!getView(d)) throw new Error(`目标视图不存在：${d}`);
      }
      ui.pairs = norm;
      renderPairs();
      setOk(`已设置 ${norm.length} 对迁移`);
    } catch (e) { setError(e); }
  }

  function doRun(pairsArg) {
    if (pairsArg) {
      ui.pairs = pairsArg.map((p) => Array.isArray(p) ? [String(p[0]), String(p[1])] : [String(p.src), String(p.dst)]);
      renderPairs();
    }
    if (!ui.pairs.length) { toast('请先添加至少一对视图', true); return null; }
    const t0 = performance.now();
    try {
      const result = E.runBatch(store, ui.pairs);
      const t1 = performance.now();
      // 刷新可查结果（重新渲染当前所有面板）
      renderAll();
      const t2 = performance.now();
      const ms = t2 - t0;
      $('timing').textContent = `迁移 ${result.writes.toLocaleString('en-US')} 次写入 · 引擎+刷新 ${ms.toFixed(0)} ms`;
      const bs = $('batch-summary');
      bs.innerHTML = `<div class="ok-line">✓ 整批成功：${result.pairs.length} 对 / ${result.writes.toLocaleString('en-US')} 次标量写入</div>` +
        result.pairs.map((p) => `<div>${escapeHtml(p.src)} → ${escapeHtml(p.dst)}：${p.writes.toLocaleString('en-US')}</div>`).join('');
      setOk(`整批迁移成功：${result.writes} 次写入，用时 ${ms.toFixed(0)} ms（含刷新）`);
      return { writes: result.writes, pairs: result.pairs, elapsedMs: ms };
    } catch (e) {
      setError(e);
      const bs = $('batch-summary');
      bs.innerHTML = `<div class="err-line">✗ ${escapeHtml(describeErr(e))}</div>`;
      toast('整批无效，转储与历史未改变', true);
      renderAll();
      throw e;
    }
  }

  /* ============================ 历史 ============================ */

  function afterMutation() {
    renderAll();
  }

  function renderHistory() {
    const wrap = $('history-list');
    $('btn-undo').disabled = store.undoStack.length === 0;
    $('btn-redo').disabled = store.redoStack.length === 0;
    if (!store.undoStack.length && !store.redoStack.length) {
      wrap.innerHTML = '<div class="empty">暂无历史项</div>';
      return;
    }
    wrap.innerHTML = '';
    for (let i = store.undoStack.length - 1; i >= 0; i--) {
      const h = store.undoStack[i];
      wrap.appendChild(historyItem(h, false));
    }
    for (let i = store.redoStack.length - 1; i >= 0; i--) {
      wrap.appendChild(historyItem(store.redoStack[i], true));
    }
  }
  function historyItem(h, redo) {
    const d = document.createElement('div');
    d.className = 'h-item' + (redo ? ' redo' : '');
    d.innerHTML = `<span class="dot"></span><span class="label" title="${escapeHtml(h.label)}">${escapeHtml(h.label)}</span><span class="cnt">${h.n.toLocaleString('en-US')}</span>`;
    return d;
  }

  function doUndo() {
    const h = E.undo(store);
    if (h) { setOk(`已撤销：${h.label}`); renderAll(); }
  }
  function doRedo() {
    const h = E.redo(store);
    if (h) { setOk(`已重做：${h.label}`); renderAll(); }
  }
  function updateEditButtons() {
    $('btn-undo').disabled = store.undoStack.length === 0;
    $('btn-redo').disabled = store.redoStack.length === 0;
    $('btn-export').disabled = !store.dump;
  }

  /* ============================ 总渲染 ============================ */

  function renderAll() {
    renderViews();
    renderTree();
    renderPairs();
    renderInspector();
    renderQuery();
    renderHex();
    renderHistory();
    updateEditButtons();
    document.body.dataset.ready = store.views.length ? '1' : '0';
  }

  function summary() {
    return {
      views: store.views.map((v) => ({ name: v.name, offset: v.offset, length: v.length, std: v.std, major: v.major, endian: v.endian, dynamic: v.dynamic && v.dynamic.count })),
      dumpLength: store.dump ? store.dump.length : 0,
      pairs: ui.pairs.slice(),
      canUndo: store.undoStack.length > 0,
      canRedo: store.redoStack.length > 0,
    };
  }

  /* ============================ 事件绑定 ============================ */

  function bind() {
    $('file-import').addEventListener('change', (e) => handleFileList(e.target.files));
    $('file-archive').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { setStatus('busy', '正在解压…'); await loadZipBuffer(await f.arrayBuffer(), f.name); }
      catch (err) { setError(err); }
    });
    $('file-layout').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        loadObjects(obj, store.dump, f.name);
      } catch (err) { setError(err); }
    });
    $('file-dump').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { E.replaceDump(store, new Uint8Array(await f.arrayBuffer())); setOk(`已载入 ${f.name}`); renderAll(); }
      catch (err) { setError(err); }
    });

    $('btn-sample').addEventListener('click', loadBundledSample);
    $('btn-export').addEventListener('click', exportDump);
    $('btn-undo').addEventListener('click', doUndo);
    $('btn-redo').addEventListener('click', doRedo);

    $('btn-add-pair').addEventListener('click', () => addPair());
    $('btn-swap-pair').addEventListener('click', () => {
      const a = $('pair-src').value;
      $('pair-src').value = $('pair-dst').value;
      $('pair-dst').value = a;
    });
    $('btn-apply-json').addEventListener('click', applyPairsJson);
    $('btn-run-batch').addEventListener('click', () => { try { doRun(); } catch (_) {} });

    $('btn-path-locate').addEventListener('click', pathLocate);
    $('path-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') pathLocate(); });
    $('path-view').addEventListener('change', () => { ui.pathView = $('path-view').value; renderTree(); });

    $('btn-offset-query').addEventListener('click', () => {
      const abs = parseOffset($('offset-input').value);
      if (!Number.isInteger(abs)) { setError(new L.SpecError(`偏移无法解析：${$('offset-input').value}（用十进制或 0x 十六进制）`)); return; }
      runOffsetQuery(abs);
    });
    $('offset-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-offset-query').click(); });
    $('hex-prev').addEventListener('click', () => { ui.hexStart = Math.max(0, ui.hexStart - HEX_PAGE); renderHex(); });
    $('hex-next').addEventListener('click', () => { ui.hexStart += HEX_PAGE; renderHex(); });
    $('hex-goto').addEventListener('click', () => {
      const abs = parseOffset($('hex-jump').value);
      if (Number.isInteger(abs)) { ui.hexStart = Math.floor(abs / HEX_PAGE) * HEX_PAGE; renderHex(); }
    });
    $('hex-jump').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('hex-goto').click(); });

    $('hex').addEventListener('click', (e) => {
      const sp = e.target.closest('.hx-byte[data-off]');
      if (!sp) return;
      const abs = parseInt(sp.dataset.off, 10);
      $('offset-input').value = String(abs);
      runOffsetQuery(abs);
    });

    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      ui.tab = t.dataset.tab;
      $('panel-tree').classList.toggle('hidden', ui.tab !== 'tree');
      $('panel-hex').classList.toggle('hidden', ui.tab !== 'hex');
      if (ui.tab === 'hex') renderHex();
    }));

    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    });
  }

  function pathLocate() {
    const v = getView($('path-view').value) || store.views[0];
    if (!v) { toast('请先导入项目', true); return; }
    ui.pathView = v.name;
    const text = $('path-input').value.trim();
    const r = L.resolvePath(v, text);
    const out = $('path-result');
    if (!r.ok) {
      out.innerHTML = `<span class="err">✗ ${escapeHtml(r.error)}</span>`;
      setError(new L.SpecError(r.error, r.specError || {}));
      return;
    }
    if (r.scalar) {
      out.innerHTML = `<span class="ok">✓</span> <span class="chip">${escapeHtml(r.path)}</span> → 绝对偏移 <span class="chip">${r.abs} / 0x${r.abs.toString(16)}</span>，字节范围 ${r.abs}–${r.abs + 3}（相对 ${r.rel}，4 字节，${r.scalar}）`;
      selectScalar(v.name, r.path);
    } else {
      out.innerHTML = `<span class="ok">✓ 复合节点</span> <span class="chip">${escapeHtml(r.path)}</span> → 绝对偏移 <span class="chip">${r.abs}</span>，大小 ${r.size} 字节`;
      ui.hexStart = Math.floor(r.abs / HEX_PAGE) * HEX_PAGE;
      ui.activeView = v.name;
      renderHex();
    }
    setOk(`路径定位：${r.path} @${r.abs}`);
  }

  function exportDump() {
    if (!store.dump) return;
    const blob = new Blob([store.dump], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dump.bin';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    setOk(`已导出整个原始转储 dump.bin（${store.dump.length} 字节）`);
  }

  async function loadBundledSample() {
    try {
      const resp = await fetch('samples/shader-block-cases.zip', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      await loadZipBuffer(await resp.arrayBuffer(), 'shader-block-cases.zip');
    } catch (e) {
      setError(new Error('无法通过 fetch 载入内置样例（请经 HTTP 访问，或直接用“导入归档”选择 samples/shader-block-cases.zip）：' + e.message));
    }
  }

  /* ============================ window.Rebinder API ============================ */

  window.Rebinder = {
    LIMITS: L.LIMITS,
    store,
    ui,
    loadObjects,
    async loadZipBuffer(buf, name) { return loadZipBuffer(buf, name); },
    async loadSample() { return loadBundledSample(); },
    views: () => summary().views,
    summary,
    dumpBytes: () => store.dump,
    dumpHex: (off, len) => Array.from(store.dump.subarray(off, off + len)).map((b) => b.toString(16).padStart(2, '0')).join(''),
    exportDump: () => store.dump,
    queryOffset: (abs) => L.queryAbsolute(store.views, abs),
    resolvePath: (viewName, p) => {
      const v = getView(viewName);
      if (!v) throw new Error('no view ' + viewName);
      return L.resolvePath(v, p);
    },
    selectPath: (viewName, p) => selectScalar(viewName, p),
    editHex: (viewName, p, hex) => {
      const r = L.resolvePath(getView(viewName), p);
      if (!r.ok) throw new L.SpecError(r.error);
      const word = typeof hex === 'number' ? hex >>> 0 : parseInt(String(hex).replace(/^0x/i, ''), 16) >>> 0;
      E.commitEdit(store, r.abs, word, getView(viewName).littleEndian, { view: viewName, path: r.path, offset: r.abs });
      renderAll();
      return r.abs;
    },
    editRawBytes: (viewName, p, bytes) => {
      const r = L.resolvePath(getView(viewName), p);
      if (!r.ok) throw new L.SpecError(r.error);
      E.commitRawBytes(store, r.abs, bytes, { view: viewName, path: r.path, offset: r.abs });
      renderAll();
      return r.abs;
    },
    setPairs: (arr) => { ui.pairs = arr.map((p) => Array.isArray(p) ? [p[0], p[1]] : [p.src, p.dst]); renderPairs(); },
    getPairs: () => ui.pairs.slice(),
    addPair,
    runBatch: (pairs) => doRun(pairs),
    planBatch: (pairs) => E.planBatch(store, pairs || ui.pairs),
    undo: () => { doUndo(); return summary(); },
    redo: () => { doRedo(); return summary(); },
    history: () => ({ undo: store.undoStack.map((h) => ({ label: h.label, n: h.n })), redo: store.redoStack.map((h) => ({ label: h.label, n: h.n })) }),
    setOffsetQuery: (abs) => { $('offset-input').value = String(abs); runOffsetQuery(abs); return L.queryAbsolute(store.views, abs); },
    lastError: () => window.__lastError,
  };

  /* ============================ 启动 ============================ */
  bind();
  renderAll();
  // 经 HTTP 打开时自动载入样例；file:// 下 fetch 可能失败，忽略并提示手动导入
  if (location.protocol.startsWith('http')) loadBundledSample().catch(() => {});
})();
