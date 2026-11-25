/* 页面主控：导入/校验/求解状态机、分页配对表、帧核对、合成与下载、window.genlock */
(function () {
  'use strict';

  const E = window.GKEngine;
  const C = window.GKCodec;
  const Z = window.GKZip;

  const $ = (id) => document.getElementById(id);

  const state = {
    fileMap: null,          // 暂存的文件 Map<path, Uint8Array>
    stagedLabel: '',
    lastSuccess: null,      // {result, images:Map, mode, ms, source}
    busy: false,
    frame: 0,
    filter: 'all',
    page: 0,
    pageSize: 50,
    filteredIndices: [],
    revision: 0,        // 每次成功求解 +1，供自动化确定性等待
  };

  // ---------------- 通用工具 ----------------
  const tick = () => new Promise((r) => setTimeout(r, 30));

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showError(err) {
    const panel = $('errorPanel');
    panel.hidden = false;
    $('errorMessage').textContent = err && err.message ? err.message : String(err);
    const ul = $('errorList');
    ul.innerHTML = '';
    const details = (err && err.details) || [];
    for (const d of details.slice(0, 50)) {
      const li = document.createElement('li');
      if (d.channel && typeof d.inputPosition === 'number') {
        li.textContent =
          `${d.channel === 'fill' ? '填充' : '键'}通道 · 第 ${d.recordNumber} 条记录` +
          `（原始输入位置 ${d.inputPosition}）` +
          (d.image ? ` · 图像 ${d.image}` : '') +
          (d.reason ? ` · ${d.reason}` : '');
      } else if (d.kind === 'candidate_limit') {
        li.textContent = `候选上限 ${d.limit}：在填充排序位置 ${d.atFillSorted}（原始输入位置 ${d.atFillInput}）之后检测到第 ${d.limit + 1} 对`;
      } else if (d.reason) {
        li.textContent = d.reason;
      } else {
        li.textContent = JSON.stringify(d);
      }
      ul.appendChild(li);
    }
    if (details.length > 50) {
      const li = document.createElement('li');
      li.textContent = `……其余 ${details.length - 50} 条从略（window.genlock.getState().error.details 可取全量）`;
      ul.appendChild(li);
    }
    state.errorDetails = details;
  }

  function clearError() {
    $('errorPanel').hidden = true;
    state.errorDetails = null;
  }

  function downloadBytes(filename, bytes, mime) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function normalizePath(p) {
    p = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join('/');
  }

  // ---------------- 文件读入与工程定位 ----------------
  async function readFileList(fileList) {
    const map = new Map();
    const zips = [];
    const loose = [];
    for (const f of fileList) {
      const key = f.webkitRelativePath && f.webkitRelativePath.includes('/') ? f.webkitRelativePath : f.name;
      if (/\.zip$/i.test(f.name)) zips.push(f);
      else loose.push([key, f]);
    }
    for (const [key, f] of loose) {
      map.set(normalizePath(key), new Uint8Array(await f.arrayBuffer()));
    }
    for (const zf of zips) {
      const entries = await Z.unzip(new Uint8Array(await zf.arrayBuffer()));
      for (const en of entries) {
        if (en.name.endsWith('/')) continue;
        if (/__MACOSX\//.test(en.name) || /(^|\/)\.DS_Store$/.test(en.name)) continue;
        map.set(normalizePath(en.name), en.bytes);
      }
    }
    return map;
  }

  function locateProject(fileMap) {
    const keys = [...fileMap.keys()];
    let projKey =
      keys.find((k) => /(^|\/)project\.json$/i.test(k)) ||
      keys.filter((k) => /\.json$/i.test(k)).sort((a, b) => a.length - b.length)[0];
    if (!projKey) {
      throw new E.GenlockError('没有找到 project.json（可直接选择样例 zip，或同时选择 project.json 与图像文件）');
    }
    let project;
    try {
      project = JSON.parse(new TextDecoder('utf-8').decode(fileMap.get(projKey)));
    } catch (e) {
      throw new E.GenlockError('project.json 解析失败：' + e.message);
    }
    const baseDir = projKey.includes('/') ? projKey.slice(0, projKey.lastIndexOf('/') + 1) : '';
    return { project, baseDir, projKey };
  }

  function makeResolver(fileMap, baseDir) {
    const basenameIndex = new Map();
    for (const k of fileMap.keys()) {
      const b = k.split('/').pop();
      if (!basenameIndex.has(b)) basenameIndex.set(b, []);
      basenameIndex.get(b).push(k);
    }
    return function resolve(ref) {
      const norm = normalizePath(ref);
      const base = norm.split('/').pop();
      const candidates = [];
      if (baseDir) candidates.push(normalizePath(baseDir + norm));
      candidates.push(norm);
      for (const c of candidates) if (fileMap.has(c)) return c;
      const hits = basenameIndex.get(base) || [];
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const underBase = hits.find((h) => !baseDir || h.startsWith(baseDir));
        if (underBase) return underBase;
        return hits[0];
      }
      return null;
    };
  }

  /** 解析并解码全部图像；坏引用定位到具体输入记录。返回 Map<原始 image 字符串, 光栅>。 */
  async function resolveImages(project, vp, fileMap, baseDir) {
    const resolve = makeResolver(fileMap, baseDir);
    const missing = [];
    const refToKey = new Map();

    for (const channel of ['fill', 'key']) {
      project[channel].forEach((rec, idx) => {
        if (!rec || typeof rec.image !== 'string') return; // schema 错误已在 validate 阶段处理
        if (refToKey.has(channel + '::' + rec.image)) return;
        const key = resolve(rec.image);
        if (!key || !fileMap.has(key)) {
          missing.push({
            channel, inputPosition: idx, recordNumber: idx + 1, image: rec.image,
            reason: '图像文件不存在于提交的文件集合中',
          });
        } else {
          refToKey.set(channel + '::' + rec.image, key);
        }
      });
    }

    if (missing.length) {
      const first = missing[0];
      throw new E.GenlockError(
        `有 ${missing.length} 条输入记录引用了找不到的图像。\n` +
          `首个问题：${first.channel === 'fill' ? '填充' : '键'}通道第 ${first.recordNumber} 条记录` +
          `（原始输入位置 ${first.inputPosition}）引用路径 "${first.image}"，但提交内容中没有该文件。`,
        missing
      );
    }

    // 去重解码
    const keyToImg = new Map();
    const decodeErrors = [];
    for (const [chanRef, key] of refToKey.entries()) {
      if (keyToImg.has(key)) continue;
      try {
        const img = await C.decodeImage(fileMap.get(key), key);
        keyToImg.set(key, img);
      } catch (err) {
        decodeErrors.push({ key, message: err.message });
      }
    }
    if (decodeErrors.length) {
      const details = [];
      for (const [channel] of [['fill'], ['key']]) {
        project[channel].forEach((rec, idx) => {
          const k = refToKey.get(channel + '::' + rec.image);
          const de = k && decodeErrors.find((d) => d.key === k);
          if (de) details.push({ channel, inputPosition: idx, recordNumber: idx + 1, image: rec.image, reason: de.message });
        });
      }
      const d0 = details[0];
      throw new E.GenlockError(
        `有 ${details.length} 条记录引用的图像无法解码。\n` +
          (d0 ? `首个问题：${d0.channel === 'fill' ? '填充' : '键'}通道第 ${d0.recordNumber} 条记录（原始输入位置 ${d0.inputPosition}）的 "${d0.image}"：${d0.reason}` : ''),
        details
      );
    }

    // 尺寸核对
    const dimErrors = [];
    const refToImg = new Map();
    for (const channel of ['fill', 'key']) {
      project[channel].forEach((rec, idx) => {
        const key = refToKey.get(channel + '::' + rec.image);
        const img = keyToImg.get(key);
        refToImg.set(channel + '::' + rec.image, img);
        if (img.width !== vp.width || img.height !== vp.height) {
          dimErrors.push({
            channel, inputPosition: idx, recordNumber: idx + 1, image: rec.image,
            reason: `图像尺寸 ${img.width}×${img.height} 与 project 宽高 ${vp.width}×${vp.height} 不一致`,
          });
        }
      });
    }
    if (dimErrors.length) {
      const d0 = dimErrors[0];
      throw new E.GenlockError(
        `有 ${dimErrors.length} 条记录的图像尺寸与 project.json 不一致。\n` +
          `首个问题：${d0.channel === 'fill' ? '填充' : '键'}通道第 ${d0.recordNumber} 条记录（原始输入位置 ${d0.inputPosition}）"${d0.image}"：${d0.reason}`,
        dimErrors
      );
    }
    return refToImg;
  }

  // ---------------- 提交并求解（失败保留 lastSuccess） ----------------
  async function commitCase(opts) {
    if (state.busy) return { ok: false, error: 'busy' };
    state.busy = true;
    updateButtons();
    setStatus('正在校验记录、定位/解码图像并求解…', 'busy');
    await tick();

    try {
      let project, fileMap, baseDir = '';
      if (opts && opts.project) {
        project = opts.project;
        fileMap = opts.fileMap || new Map();
        baseDir = opts.baseDir || '';
      } else {
        if (!state.fileMap) throw new E.GenlockError('请先选择样例 zip、project.json 或图像文件，或点击“载入内置样例”。');
        fileMap = state.fileMap;
        const located = locateProject(fileMap);
        project = located.project;
        baseDir = located.baseDir;
      }

      const vp = E.validateProject(project);

      // 参数优先级：显式 opts >（来自 UI 时）输入框 > project.json
      let offset, tolerance;
      if (opts && Number.isInteger(opts.offset)) offset = opts.offset;
      else if (opts && opts.fromUI) offset = parseInt($('offsetInput').value, 10);
      else offset = vp.offset;
      if (opts && Number.isInteger(opts.tolerance)) tolerance = opts.tolerance;
      else if (opts && opts.fromUI) tolerance = parseInt($('toleranceInput').value, 10);
      else tolerance = vp.tolerance;

      if (!Number.isInteger(offset) || offset < -2147483648 || offset > 2147483647) {
        throw new E.GenlockError('时差校正 offset 必须是有符号 32 位整数（-2147483648..2147483647）。');
      }
      if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 4294967295) {
        throw new E.GenlockError('容差 tolerance 必须是 0..4294967295 的整数。');
      }

      // 同步回输入框
      $('offsetInput').value = offset;
      $('toleranceInput').value = tolerance;

      const images = opts && opts.images ? opts.images : await resolveImages(project, vp, fileMap, baseDir);

      const t0 = performance.now();
      const result = E.analyze(project, { offset, tolerance });
      const ms = performance.now() - t0;

      const mode = (opts && opts.mode) || $('modeSelect').value || vp.fillMode;
      state.lastSuccess = { result, images, mode, ms, source: (opts && opts.source) || state.stagedLabel || '提交的工程' };
      $('modeSelect').value = mode === 'straight' ? 'straight' : 'premult';

      clearError();
      $('staleBanner').hidden = true;
      state.revision++;
      afterNewResult();
      setStatus(
        `求解完成：${result.summary.pair_count.toLocaleString('en-US')} 对 / ` +
        `${result.summary.fill_count.toLocaleString('en-US')} 填充，候选 ${result.summary.candidate_count.toLocaleString('en-US')}，` +
        `总绝对时差 ${result.summary.total_abs_dt}，核心耗时 ${ms.toFixed(0)} ms。`,
        'success'
      );
      return { ok: true, summary: result.summary, solve_ms: ms };
    } catch (err) {
      showError(err);
      if (state.lastSuccess) {
        const p = state.lastSuccess.result.summary;
        const b = $('staleBanner');
        b.hidden = false;
        b.textContent =
          `本次${opts && opts.silentParam ? '重算' : '提交'}失败，下方与下载仍为上一次成功结果` +
          `（offset=${p.offset}, tolerance=${p.tolerance}, 配对 ${p.pair_count}）。可修正后再次提交。`;
        setStatus('本次求解失败；仍显示并可下载上一次成功结果。', '');
      } else {
        setStatus('提交失败：尚无成功结果。', '');
      }
      return { ok: false, error: err.message, details: err.details || [] };
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  function afterNewResult() {
    const r = state.lastSuccess.result;
    const s = r.summary;
    $('sumFill').textContent = s.fill_count.toLocaleString('en-US');
    $('sumKey').textContent = s.key_count.toLocaleString('en-US');
    $('sumCandidates').textContent = s.candidate_count.toLocaleString('en-US');
    $('pairCount').textContent = s.pair_count.toLocaleString('en-US');
    $('unpairedCount').textContent = s.unpaired_count.toLocaleString('en-US');
    $('totalAbsDt').textContent = s.total_abs_dt.toLocaleString('en-US');
    $('solveMs').textContent = state.lastSuccess.ms.toFixed(0) + ' ms';
    $('modulusLabel').textContent = String(s.modulus);
    $('dimLabel').textContent = s.width + '×' + s.height;
    $('projectModeLabel').textContent = s.fill_mode;

    const maxI = Math.max(0, s.fill_count - 1);
    $('frameSlider').max = String(maxI);
    $('frameJump').max = String(maxI);
    $('rangeStart').max = String(s.fill_count);
    $('rangeEnd').max = String(s.fill_count);
    if (state.frame > maxI) state.frame = 0;
    $('frameJump').value = String(state.frame);
    $('frameSlider').value = String(state.frame);
    $('rangeStart').value = String(state.frame);
    $('rangeEnd').value = String(Math.min(s.fill_count, state.frame + 1));

    state.page = 0;
    rebuildFiltered();
    renderTable();
    showFrame(state.frame);

    const has = !!state.lastSuccess;
    ['downloadTableJson', 'downloadTableCsv', 'downloadPngBtn', 'downloadRangeBtn'].forEach((id) => ($(id).disabled = !has));
    updateButtons();
  }

  function updateButtons() {
    const has = !!state.lastSuccess;
    const hasFrames = has && state.lastSuccess.result.rows.length > 0;
    $('solveBtn').disabled = state.busy;
    $('solveBtn').textContent = state.busy ? '计算中…' : '提交并求解';
    if (!state.busy) {
      $('downloadTableJson').disabled = !has;
      $('downloadTableCsv').disabled = !has;
      $('downloadRangeBtn').disabled = !has;
      $('downloadPngBtn').disabled = !hasFrames;
    }
  }

  // ---------------- 分页配对表 ----------------
  function rebuildFiltered() {
    const rows = state.lastSuccess.result.rows;
    const f = state.filter;
    const idx = [];
    for (let i = 0; i < rows.length; i++) {
      if (f === 'paired' && !rows[i].paired) continue;
      if (f === 'unpaired' && rows[i].paired) continue;
      idx.push(i);
    }
    state.filteredIndices = idx;
    const pages = Math.max(1, Math.ceil(idx.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
  }

  function renderTable() {
    const tbody = $('pairTableBody');
    tbody.innerHTML = '';
    if (!state.lastSuccess) {
      $('pageInfo').textContent = '–';
      return;
    }
    const rows = state.lastSuccess.result.rows;
    const idx = state.filteredIndices;
    const totalPages = Math.max(1, Math.ceil(idx.length / state.pageSize));
    if (state.page < 0) state.page = 0;
    if (state.page > totalPages - 1) state.page = totalPages - 1;
    const start = state.page * state.pageSize;
    const slice = idx.slice(start, start + state.pageSize);

    const frag = document.createDocumentFragment();
    for (const i of slice) {
      const r = rows[i];
      const tr = document.createElement('tr');
      tr.dataset.sorted = String(i);
      if (i === state.frame) tr.classList.add('current');
      if (!r.paired) tr.classList.add('unpaired');
      const td = (text, cls) => {
        const x = document.createElement('td');
        if (cls) x.className = cls;
        if (text === null || text === undefined) {
          x.innerHTML = '<span class="null">null</span>';
        } else x.textContent = String(text);
        return x;
      };
      tr.appendChild(td(r.fill_sorted_position));
      tr.appendChild(td(r.fill_original_position));
      tr.appendChild(td(r.fill_t));
      tr.appendChild(td(r.fill_id));
      tr.appendChild(td(r.key_sorted_position));
      tr.appendChild(td(r.key_original_position));
      tr.appendChild(td(r.key_t));
      tr.appendChild(td(r.key_id));
      if (r.paired) {
        const dtCls = 'dt ' + (Math.abs(r.dt) === 0 ? 'dt-ok' : '');
        tr.appendChild(td((r.dt > 0 ? '+' : '') + r.dt, dtCls));
        tr.appendChild(td(r.abs_dt));
      } else {
        tr.appendChild(td(null));
        tr.appendChild(td(null));
      }
      tr.addEventListener('click', () => {
        state.frame = i;
        syncFrameInputs();
        showFrame(i);
        highlightCurrentRow();
      });
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);

    const from = idx.length === 0 ? 0 : start + 1;
    const to = Math.min(idx.length, start + state.pageSize);
    $('pageInfo').textContent = `第 ${state.page + 1}/${totalPages} 页 · ${from}-${to} / ${idx.length.toLocaleString('en-US')} 个填充位置`;
    $('prevPage').disabled = state.page <= 0;
    $('firstPage').disabled = state.page <= 0;
    $('nextPage').disabled = state.page >= totalPages - 1;
    $('lastPage').disabled = state.page >= totalPages - 1;
  }

  function highlightCurrentRow() {
    document.querySelectorAll('#pairTableBody tr').forEach((tr) => {
      tr.classList.toggle('current', Number(tr.dataset.sorted) === state.frame);
    });
  }

  function revealInTable(sorted) {
    if (state.filter !== 'all') {
      state.filter = 'all';
      $('filterSelect').value = 'all';
      rebuildFiltered();
    }
    const pos = state.filteredIndices.indexOf(sorted);
    if (pos >= 0) {
      state.page = Math.floor(pos / state.pageSize);
      renderTable();
    }
    highlightCurrentRow();
  }

  // ---------------- 帧检查器与合成 ----------------
  function imageForRef(channel, ref) {
    return state.lastSuccess.images.get(channel + '::' + ref) || null;
  }

  function compositeForFrame(sorted, mode) {
    const ls = state.lastSuccess;
    const r = ls.result.rows[sorted];
    const s = ls.result.summary;
    const fillImg = imageForRef('fill', r.fill_image);
    let keyImg = null;
    if (r.paired) keyImg = imageForRef('key', r.key_image);
    return C.compositeFrame({
      width: s.width, height: s.height,
      fill: fillImg, key: keyImg,
      paired: r.paired && !!keyImg,
      mode: mode || $('modeSelect').value || ls.mode,
    });
  }

  function putRGBACanvas(canvas, w, h, rgba) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
  }

  function drawThumb(canvas, img, kind, w, h) {
    if (!img) { canvas.width = w; canvas.height = h; return; }
    let rgba = new Uint8ClampedArray(w * h * 4);
    if (img.kind === 'gray') {
      for (let i = 0; i < w * h; i++) {
        const v = img.gray[i];
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
      }
    } else if (img.kind === 'rgb') {
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = img.rgb[i * 3]; rgba[i * 4 + 1] = img.rgb[i * 3 + 1]; rgba[i * 4 + 2] = img.rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
      }
    } else if (img.rgba) {
      rgba = img.rgba.slice ? img.rgba.slice() : new Uint8ClampedArray(img.rgba);
    }
    putRGBACanvas(canvas, w, h, rgba);
  }

  function detailRow(th, content, mono) {
    const tr = document.createElement('tr');
    const h = document.createElement('th');
    h.textContent = th;
    const td = document.createElement('td');
    if (mono) td.className = 'mono';
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = String(content);
    tr.appendChild(h); tr.appendChild(td);
    return tr;
  }

  function showFrame(sorted) {
    if (!state.lastSuccess) return;
    const result = state.lastSuccess.result;
    const n = result.rows.length;
    const s = result.summary;

    if (n === 0) {
      state.frame = 0;
      $('frameJump').value = '0';
      $('frameSlider').value = '0';
      $('framePosLabel').textContent = '工程没有 fill 记录';
      const canvas = $('previewCanvas');
      canvas.width = s.width; canvas.height = s.height;
      canvas.getContext('2d').clearRect(0, 0, s.width, s.height);
      $('fillCanvas').width = s.width; $('fillCanvas').height = s.height;
      $('keyCanvas').width = s.width; $('keyCanvas').height = s.height;
      const tb = $('frameDetail').querySelector('tbody');
      tb.innerHTML = '';
      tb.appendChild(detailRow('状态', '本工程没有填充记录'));
      highlightCurrentRow();
      return;
    }

    sorted = Math.max(0, Math.min(n - 1, Number(sorted) || 0));
    state.frame = sorted;
    const r = result.rows[sorted];

    syncFrameInputs();

    // 主合成画布
    const rgba = compositeForFrame(sorted);
    putRGBACanvas($('previewCanvas'), s.width, s.height, rgba);

    // 缩略图
    drawThumb($('fillCanvas'), imageForRef('fill', r.fill_image), 'rgb', s.width, s.height);
    if (r.paired) drawThumb($('keyCanvas'), imageForRef('key', r.key_image), 'gray', s.width, s.height);
    else { const kc = $('keyCanvas'); kc.width = s.width; kc.height = s.height; const kx = kc.getContext('2d'); kx.clearRect(0, 0, s.width, s.height); }

    $('framePosLabel').textContent = `填充排序位置 ${sorted} / 共 ${n} 条`;

    const tb = $('frameDetail').querySelector('tbody');
    tb.innerHTML = '';
    const statusSpan = document.createElement('span');
    statusSpan.className = r.paired ? 'tag-paired' : 'tag-unpaired';
    statusSpan.textContent = r.paired ? '已配对' : '未配对（输出透明黑 RGBA=0）';
    tb.appendChild(detailRow('状态', statusSpan));
    tb.appendChild(detailRow('填充排序位置', r.fill_sorted_position, true));
    tb.appendChild(detailRow('填充原始输入位置', `${r.fill_original_position}（第 ${r.fill_record_number} 条记录）`, true));
    tb.appendChild(detailRow('填充 t / id', `t=${r.fill_t}, id=${r.fill_id}（id mod ${s.modulus} = ${r.fill_id % s.modulus}）`, true));
    tb.appendChild(detailRow('填充图像', r.fill_image, true));
    if (r.paired) {
      tb.appendChild(detailRow('键排序位置', r.key_sorted_position, true));
      tb.appendChild(detailRow('键原始输入位置', `${r.key_original_position}（第 ${r.key_record_number} 条记录）`, true));
      tb.appendChild(detailRow('键 t / id', `t=${r.key_t}, id=${r.key_id}（id mod ${s.modulus} = ${r.key_id % s.modulus}）`, true));
      tb.appendChild(detailRow('键图像', r.key_image, true));
      const sign = r.dt > 0 ? '+' : '';
      tb.appendChild(detailRow(
        '带符号时差 dt',
        `${sign}${r.dt}    [ key.t ${r.key_t} − fill.t ${r.fill_t} − offset ${s.offset} = ${r.dt} ]，|dt|=${r.abs_dt}，容差 ±${s.tolerance}`,
        true
      ));
    } else {
      tb.appendChild(detailRow('键排序位置', 'null'));
      tb.appendChild(detailRow('键原始输入位置', 'null'));
      tb.appendChild(detailRow('带符号时差 dt', 'null'));
    }
    tb.appendChild(detailRow('合成模式', $('modeSelect').value === 'premult' ? 'premult 预乘（a>0: 255c/a 半偶舍入；a=0: RGB=0）' : 'straight 直通（RGB 原样，a=灰度键）'));

    highlightCurrentRow();
  }

  function syncFrameInputs() {
    if (document.activeElement !== $('frameJump')) $('frameJump').value = String(state.frame);
    $('frameSlider').value = String(state.frame);
  }

  // ---------------- 导出 ----------------
  async function downloadCurrentPNG() {
    if (!state.lastSuccess) return;
    const i = state.frame;
    const rgba = compositeForFrame(i);
    const { width, height } = state.lastSuccess.result.summary;
    const bytes = await C.encodePNG(width, height, rgba);
    downloadBytes(`${i}.png`, bytes, 'image/png');
  }

  async function downloadRangeZip() {
    if (!state.lastSuccess) return;
    const n = state.lastSuccess.result.rows.length;
    const start = parseInt($('rangeStart').value, 10);
    const end = parseInt($('rangeEnd').value, 10);
    const hint = $('rangeHint');
    hint.style.color = '';
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start >= end) {
      hint.textContent = '区间非法：需要 0 ≤ start < end。';
      hint.style.color = 'var(--err)';
      return;
    }
    if (end > n) {
      hint.textContent = `终点 ${end} 超出填充数 ${n}。`;
      hint.style.color = 'var(--err)';
      return;
    }
    const count = end - start;
    if (count > E.MAX_PNG_FRAMES) {
      hint.textContent = `区间为 ${count} 帧，超过上限 ${E.MAX_PNG_FRAMES} 帧；请缩窄到 ≤120 帧（左闭右开）。`;
      hint.style.color = 'var(--err)';
      return;
    }
    const btn = $('downloadRangeBtn');
    btn.disabled = true;
    try {
      const files = [];
      for (let i = start; i < end; i++) {
        const rgba = compositeForFrame(i);
        const { width, height } = state.lastSuccess.result.summary;
        const png = await C.encodePNG(width, height, rgba);
        files.push({ name: `${i}.png`, bytes: png });
        if ((i - start) % 10 === 9) {
          hint.textContent = `编码中… ${i - start + 1}/${count}`;
          await tick();
        }
      }
      hint.textContent = `打包 ${count} 帧…`;
      await tick();
      const zip = Z.zipSync(files);
      downloadBytes('png-sequence.zip', zip, 'application/zip');
      hint.textContent = `已导出 ${count} 帧：${start}.png … ${end - 1}.png（左闭右开）。`;
      hint.style.color = 'var(--ok)';
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------- 内置样例 ----------------
  async function loadBuiltinSample() {
    setStatus('正在载入内置样例…', 'busy');
    let project, map;
    if (window.GK_EMBEDDED_SAMPLE && window.GK_EMBEDDED_SAMPLE['project.json']) {
      // 首选内嵌样例：file:// 或任意静态服务器下都可用
      const emb = window.GK_EMBEDDED_SAMPLE;
      project = emb['project.json'];
      map = new Map();
      map.set('project.json', new TextEncoder().encode(JSON.stringify(project)));
      for (const name of ['fill.ppm', 'key.pgm']) map.set(name, bytesFromAny(emb[name]));
    } else {
      // 回退：从 sample/ 目录 fetch
      const base = 'sample/';
      const names = ['project.json', 'fill.ppm', 'key.pgm'];
      map = new Map();
      for (const name of names) {
        const resp = await fetch(base + name);
        if (!resp.ok) throw new Error('内置样例缺失：' + name);
        map.set(name, new Uint8Array(await resp.arrayBuffer()));
      }
      project = JSON.parse(new TextDecoder().decode(map.get('project.json')));
    }
    state.fileMap = map;
    state.stagedLabel = '内置样例';
    $('offsetInput').value = project.offset;
    $('toleranceInput').value = project.tolerance;
    $('modeSelect').value = project.fill_mode;
    await commitCase({ project, fileMap: map, baseDir: '', source: '内置样例' });
  }

  // ---------------- window.genlock 程序化接口 ----------------
  function bytesFromAny(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (typeof data === 'string') {
      // 支持 data: URL 或 base64
      const comma = data.indexOf(',');
      if (data.startsWith('data:') && comma >= 0) data = data.slice(comma + 1);
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    throw new Error('不支持的图像数据类型');
  }

  window.genlock = {
    version: '1.0.0',
    constants: {
      MAX_CANDIDATES: E.MAX_CANDIDATES,
      MAX_PNG_FRAMES: E.MAX_PNG_FRAMES,
      MAX_RECORDS_PER_SIDE: E.MAX_RECORDS_PER_SIDE,
    },
    /** 可序列化状态快照 */
    getState() {
      const ls = state.lastSuccess;
      return {
        busy: state.busy,
        revision: state.revision,
        hasResult: !!ls,
        error: state.errorDetails ? { message: $('errorMessage').textContent, details: state.errorDetails } : null,
        params: ls ? { offset: ls.result.summary.offset, tolerance: ls.result.summary.tolerance, mode: $('modeSelect').value } : null,
        summary: ls ? ls.result.summary : null,
        frame: state.frame,
      };
    },
    getSummary() { return state.lastSuccess ? state.lastSuccess.result.summary : null; },
    /** 完整配对表：每个填充排序位置一行（未配键字段为 null） */
    getTable() { return state.lastSuccess ? state.lastSuccess.result.rows : null; },
    getRows() { return this.getTable(); },
    getResult() {
      if (!state.lastSuccess) return null;
      return { summary: state.lastSuccess.result.summary, rows: state.lastSuccess.result.rows };
    },
    /** 当前/指定帧的合成 RGBA（Uint8ClampedArray） */
    compositeRGBA(sorted, mode) {
      if (!state.lastSuccess) return null;
      const i = sorted === undefined ? state.frame : sorted;
      return compositeForFrame(i, mode);
    },
    /** 直接载入工程对象 + 图像映射 {name: Uint8Array|base64|number[]}，走与 UI 相同的校验/求解/状态保留路径 */
    async loadCase(input) {
      const project = input.project || input;
      const fileMap = new Map();
      if (input.images) {
        for (const [name, data] of Object.entries(input.images)) fileMap.set(name, bytesFromAny(data));
      }
      if (input.files) {
        for (const [name, data] of Object.entries(input.files)) fileMap.set(name, bytesFromAny(data));
      }
      if (input.offset !== undefined) $('offsetInput').value = input.offset;
      else $('offsetInput').value = project.offset;
      if (input.tolerance !== undefined) $('toleranceInput').value = input.tolerance;
      else $('toleranceInput').value = project.tolerance;
      if (input.mode) $('modeSelect').value = input.mode;
      state.fileMap = fileMap;
      state.stagedLabel = 'window.genlock.loadCase';
      const offset = Number.isInteger(input.offset) ? input.offset : project.offset;
      const tolerance = Number.isInteger(input.tolerance) ? input.tolerance : project.tolerance;
      return commitCase({
        project, fileMap, baseDir: '',
        offset, tolerance,
        mode: input.mode, source: 'API',
      });
    },
    showFrame,
    async currentPNGBytes() {
      const rgba = compositeForFrame(state.frame);
      const { width, height } = state.lastSuccess.result.summary;
      return C.encodePNG(width, height, rgba);
    },
  };

  // ---------------- 事件绑定 ----------------
  function bind() {
    $('fileInput').addEventListener('change', async (ev) => {
      try {
        const map = await readFileList(ev.target.files);
        state.fileMap = map;
        state.stagedLabel = ev.target.files[0] ? ev.target.files[0].name : '已选文件';
        // 尝试回填参数
        try {
          const { project } = locateProject(map);
          $('offsetInput').value = project.offset;
          $('toleranceInput').value = project.tolerance;
          $('modeSelect').value = project.fill_mode;
        } catch (_) { /* 提交时再报错 */ }
        setStatus(`已读入 ${map.size} 个文件：${state.stagedLabel}。点击“提交并求解”。`);
      } catch (err) {
        showError(err);
      }
    });

    $('folderInput').addEventListener('change', async (ev) => {
      try {
        const map = await readFileList(ev.target.files);
        state.fileMap = map;
        state.stagedLabel = '文件夹 ' + (ev.target.files[0] ? ev.target.files[0].webkitRelativePath.split('/')[0] : '');
        try {
          const { project } = locateProject(map);
          $('offsetInput').value = project.offset;
          $('toleranceInput').value = project.tolerance;
          $('modeSelect').value = project.fill_mode;
        } catch (_) {}
        setStatus(`已从文件夹读入 ${map.size} 个文件。点击“提交并求解”。`);
      } catch (err) { showError(err); }
    });

    $('loadSampleBtn').addEventListener('click', () => loadBuiltinSample().catch(showError));
    $('solveBtn').addEventListener('click', () => commitCase({ fromUI: true }));

    $('modeSelect').addEventListener('change', () => {
      if (state.lastSuccess) showFrame(state.frame);
    });

    $('jumpBtn').addEventListener('click', () => {
      const v = parseInt($('frameJump').value, 10);
      state.frame = v;
      showFrame(v);
      revealInTable(state.frame);
    });
    $('frameJump').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('jumpBtn').click(); });
    $('prevFrame').addEventListener('click', () => { state.frame = Math.max(0, state.frame - 1); showFrame(state.frame); revealInTable(state.frame); });
    $('nextFrame').addEventListener('click', () => {
      const max = state.lastSuccess ? state.lastSuccess.result.rows.length - 1 : 0;
      state.frame = Math.min(max, state.frame + 1); showFrame(state.frame); revealInTable(state.frame);
    });
    $('frameSlider').addEventListener('input', (e) => { state.frame = Number(e.target.value); showFrame(state.frame); highlightCurrentRow(); });

    $('filterSelect').addEventListener('change', (e) => { state.filter = e.target.value; state.page = 0; rebuildFiltered(); renderTable(); });
    $('pageSizeSelect').addEventListener('change', (e) => { state.pageSize = Number(e.target.value); state.page = 0; rebuildFiltered(); renderTable(); });
    $('firstPage').addEventListener('click', () => { state.page = 0; renderTable(); });
    $('prevPage').addEventListener('click', () => { state.page--; renderTable(); });
    $('nextPage').addEventListener('click', () => { state.page++; renderTable(); });
    $('lastPage').addEventListener('click', () => { state.page = 1e9; renderTable(); });

    $('downloadTableJson').addEventListener('click', () => {
      if (!state.lastSuccess) return;
      downloadBytes('pairing-table.json', JSON.stringify(state.lastSuccess.result.rows, null, 0), 'application/json');
    });
    $('downloadTableCsv').addEventListener('click', () => {
      if (!state.lastSuccess) return;
      downloadBytes('pairing-table.csv', '\uFEFF' + E.tableToCSV(state.lastSuccess.result.rows), 'text/csv;charset=utf-8');
    });
    $('downloadPngBtn').addEventListener('click', () => downloadCurrentPNG().catch((e) => showError(e)));
    $('downloadRangeBtn').addEventListener('click', () => downloadRangeZip().catch((e) => showError(e)));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
