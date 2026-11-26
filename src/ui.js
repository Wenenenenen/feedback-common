/* UI 绑定：文件导入、帧开关、视图/色彩模式、画布点击选像素、明细表、导出。 */
(function () {
  'use strict';
  var App = window.StokesApp;
  var Render = window.StokesRender;
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    fileInput: $('file-input'),
    exportBtn: $('export-btn'),
    statusDot: $('status-dot'),
    statusText: $('status-text'),
    progressBar: $('progress-bar'),
    projectInfo: $('project-info'),
    errorBox: $('error-box'),
    errorText: $('error-text'),
    frameList: $('frame-list'),
    viewTabs: $('view-tabs'),
    colorMode: $('color-mode'),
    canvas: $('view'),
    legend: $('legend'),
    cursorInfo: $('cursor-info'),
    detail: $('detail'),
  };

  /* ---------------- 导入 ---------------- */
  els.fileInput.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    hideError();
    setStatus('busy', '正在解析 ' + file.name + ' …');
    App.loadZipFile(file).then(function () {
      setStatus('ok', '项目已加载，计算中…');
    }).catch(function (err) {
      // 坏输入：指出文件/字段，保留当前项目
      showError(err.message || String(err));
      if (App.state.project) setStatus('ok', '导入失败，保留当前项目');
      else setStatus('err', '导入失败');
    }).finally(function () {
      els.fileInput.value = '';
    });
  });

  function showError(msg) {
    els.errorText.textContent = msg;
    els.errorBox.classList.add('show');
  }
  function hideError() { els.errorBox.classList.remove('show'); }

  function setStatus(kind, text) {
    els.statusDot.className = 'dot ' + (kind || '');
    els.statusText.textContent = text;
  }

  /* ---------------- 状态事件 ---------------- */
  App.on('project', function (project) {
    els.projectInfo.textContent = project.width + '×' + project.height + ' · ' +
      project.frames.length + ' 帧 · ' + (project.width * project.height) + ' 像素';
    els.exportBtn.disabled = true;
    renderFrameList();
    els.detail.innerHTML = '<div class="empty">在上方图像点击任意像素</div>';
  });

  App.on('status', function (s) {
    els.progressBar.style.width = Math.round(s.progress * 100) + '%';
    if (s.running) setStatus('busy', '重算中 ' + Math.round(s.progress * 100) + '%');
    else setStatus('ok', '结果已更新');
  });

  App.on('result', function () {
    els.exportBtn.disabled = false;
    renderView();
    if (App.state.selectedPx >= 0) renderDetail(App.state.selectedPx);
  });

  App.on('toggles', renderFrameList);
  App.on('view', renderView);
  App.on('colormode', renderView);
  App.on('select', function (px) { renderDetail(px); });

  /* ---------------- 帧清单 ---------------- */
  function renderFrameList() {
    var p = App.state.project;
    if (!p) { els.frameList.innerHTML = '<div class="empty">导入后显示帧清单</div>'; return; }
    els.frameList.innerHTML = '';
    p.frames.forEach(function (f, i) {
      var on = App.state.enabled[i];
      var item = document.createElement('div');
      item.className = 'frame-item' + (on ? '' : ' off');
      item.innerHTML =
        '<label class="switch"><input type="checkbox" ' + (on ? 'checked' : '') + ' data-i="' + i + '">' +
        '<span class="track"></span></label>' +
        '<div class="meta"><div class="dir">#' + String(i).padStart(2, '0') +
        ' 方向 (' + f.u + ',' + f.v + ')' + (f.maskData ? ' · 含掩膜' : '') + '</div>' +
        '<div class="cal">gain ' + f.gain + '（×' + (f.gain / 4).toFixed(2) +
        '）· offset ' + f.offset + ' · weight ' + f.weight + '</div></div>';
      els.frameList.appendChild(item);
    });
    els.frameList.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        App.toggleFrame(parseInt(cb.dataset.i, 10));
        els.exportBtn.disabled = true;
      });
    });
  }

  /* ---------------- 视图 ---------------- */
  els.viewTabs.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-view]');
    if (!btn) return;
    els.viewTabs.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
    App.setView(btn.dataset.view);
  });
  els.colorMode.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    els.colorMode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
    App.setColorMode(btn.dataset.mode);
  });

  function renderView() {
    var r = App.state.result;
    if (!r) return;
    var gray = App.state.colorMode === 'gray';
    var img = Render.render(App.state.view, r, gray);
    var display = Math.max(280, Math.min(560, r.width * 4));
    Render.drawToCanvas(els.canvas, img, display);
    renderLegend();
  }

  function rgbCss(a) { return 'rgb(' + a[0] + ',' + a[1] + ',' + a[2] + ')'; }
  function gradientCss(stops) {
    return 'linear-gradient(to right,' + stops.map(function (s, i) {
      return rgbCss(s) + ' ' + Math.round(i / (stops.length - 1) * 100) + '%';
    }).join(',') + ')';
  }

  function renderLegend() {
    var view = App.state.view;
    var gray = App.state.colorMode === 'gray';
    var html = '<span><span class="swatch" style="background:' + rgbCss(Render.NO_SOLUTION) + '"></span>无解</span>';
    if (view === 'intensity') {
      html += '<span>强度 s₀（暗→亮，平方根刻度）</span>';
    } else if (view === 'dolp') {
      var stops = Render.DOLP_STOPS.map(function (s) {
        if (!gray) return s;
        var g = Math.round(0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]);
        return [g, g, g];
      });
      html += '<span class="bar" style="background:' + gradientCss(stops) + '"></span><span>0</span><span>DoLP</span><span>1</span>';
    } else {
      var astops = Render.ANGLE_STOPS.map(function (s) {
        if (!gray) return s;
        var g = Math.round(0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]);
        return [g, g, g];
      });
      html += '<span class="bar" style="background:' + gradientCss(astops) + '"></span>' +
        '<span>0°</span><span>偏振角</span><span>180°</span>' +
        '<span class="muted">（分量模长 &lt;1 角度未定义，显中性灰）</span>';
    }
    els.legend.innerHTML = html;
  }

  /* ---------------- 画布选像素（最近邻反算） ---------------- */
  els.canvas.addEventListener('click', function (e) {
    var r = App.state.result;
    if (!r) return;
    var rect = els.canvas.getBoundingClientRect();
    var fx = (e.clientX - rect.left) / rect.width;
    var fy = (e.clientY - rect.top) / rect.height;
    var x = Math.max(0, Math.min(r.width - 1, Math.floor(fx * r.width)));
    var y = Math.max(0, Math.min(r.height - 1, Math.floor(fy * r.height)));
    App.selectPixel(y * r.width + x);
  });
  els.canvas.addEventListener('mousemove', function (e) {
    var r = App.state.result;
    if (!r) return;
    var rect = els.canvas.getBoundingClientRect();
    var fx = (e.clientX - rect.left) / rect.width;
    var fy = (e.clientY - rect.top) / rect.height;
    var x = Math.max(0, Math.min(r.width - 1, Math.floor(fx * r.width)));
    var y = Math.max(0, Math.min(r.height - 1, Math.floor(fy * r.height)));
    var d = App.pixelDetail(y * r.width + x);
    if (!d) return;
    if (d.solved) {
      els.cursorInfo.textContent = '(' + d.x + ',' + d.y + ')  s0=' + d.stokes[0].toFixed(2) +
        '  DoLP=' + (d.dolp === null ? '—' : d.dolp.toFixed(4)) +
        '  角度=' + (d.angle === null ? '未定义' : d.angle.toFixed(2) + '°');
    } else {
      els.cursorInfo.textContent = '(' + d.x + ',' + d.y + ')  无解（有效非饱和方向不足 3 个）';
    }
  });

  /* ---------------- 像素明细 ---------------- */
  function fmt(v, digits) {
    if (v === null || v === undefined) return '';
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }
  function statusBadge(status) {
    var cls = { '普通': 'normal', '上饱和': 'upper', '下饱和': 'lower', '掩膜排除': 'masked', '禁用': 'disabled' }[status];
    return '<span class="badge ' + cls + '">' + status + '</span>';
  }

  function renderDetail(px) {
    var d = App.pixelDetail(px);
    if (!d) { els.detail.innerHTML = '<div class="empty">在上方图像点击任意像素</div>'; return; }
    var html = '<div class="cursor-info" style="margin:0 0 8px">像素坐标 (' + d.x + ', ' + d.y + ')' +
      (d.solved ? '' : ' · <b style="color:var(--magenta)">无解</b>') + '</div>';
    if (d.solved) {
      html += '<div class="stokes-box">' +
        '<div class="cell"><div class="k">s0 强度</div><div class="v">' + fmt(d.stokes[0], 3) + '</div></div>' +
        '<div class="cell"><div class="k">s1</div><div class="v">' + fmt(d.stokes[1], 3) + '</div></div>' +
        '<div class="cell"><div class="k">s2</div><div class="v">' + fmt(d.stokes[2], 3) + '</div></div></div>';
      html += '<div class="hint" style="margin-bottom:8px">线偏振度 ' + fmt(d.dolp, 4) +
        ' · 偏振角 ' + (d.angle === null ? '未定义（分量模长 &lt;1）' : fmt(d.angle, 3) + '°') +
        ' · 锥约束 s0≥|(s1,s2)|：' + (d.stokes[0] >= Math.hypot(d.stokes[1], d.stokes[2]) - 1e-9 ? '满足' : '违反') + '</div>';
    }
    html += '<div class="scroll"><table class="detail"><thead><tr>' +
      '<th class="left">帧</th><th class="left">状态</th><th>实测码值</th><th>未截断预测</th><th>残差</th>' +
      '<th>gain</th><th>offset</th><th>weight</th></tr></thead><tbody>';
    d.rows.forEach(function (row) {
      html += '<tr class="' + (row.included ? '' : 'excluded') + '">' +
        '<td class="left nowrap">#' + String(row.index).padStart(2, '0') + ' (' + row.u + ',' + row.v + ')</td>' +
        '<td class="left">' + statusBadge(row.status) + '</td>' +
        '<td>' + row.measurement + '</td>' +
        '<td>' + (row.predict === null ? '—' : fmt(row.predict, 2)) + '</td>' +
        '<td>' + (row.residual === null ? '—' : fmt(row.residual, 2)) + '</td>' +
        '<td>' + row.gain + '</td><td>' + row.offset + '</td><td>' + row.weight + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="hint">残差仅对纳入拟合的帧显示；禁用与掩膜排除帧不参与。饱和帧残差为单边罚（下饱和 r=max(0,p)，上饱和 r=min(0,p−65535)）。</div>';
    els.detail.innerHTML = html;
  }

  /* ---------------- 导出 ---------------- */
  els.exportBtn.addEventListener('click', function () {
    var obj = App.buildExportJSON();
    if (!obj) return;
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (App.state.fileName.replace(/\.zip$/i, '') || 'stokes') + '-result.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
