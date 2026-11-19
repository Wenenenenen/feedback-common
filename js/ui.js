/* 面板 UI：接触列表、逐轴投影、全量对照、物体编辑、导入导出 */
(function () {
  'use strict';
  var engine = SCL.engine;

  function $(id) { return document.getElementById(id); }
  function fmt(v, digits) {
    if (!isFinite(v)) return '∞';
    digits = digits == null ? 4 : digits;
    return Number(v.toFixed(digits)).toString();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function UI(app, view) {
    this.app = app;
    this.view = view;
    this._bind();
    this.render();
  }

  UI.prototype._bind = function () {
    var self = this, app = this.app;

    $('btnPlay').addEventListener('click', function () {
      app.togglePlay();
      self.render();
    });
    $('btnPrev').addEventListener('click', function () { app.stepFrame(-1); self.render(); });
    $('btnNext').addEventListener('click', function () { app.stepFrame(1); self.render(); });
    $('btnFit').addEventListener('click', function () { view.fitToScene(); view.draw(); });
    $('timeInput').addEventListener('change', function () {
      app.setTime(parseFloat(this.value));
      self.render();
    });
    $('timeSlider').addEventListener('input', function () {
      app.setTime(parseFloat(this.value));
      self.render();
    });
    $('speedSelect').addEventListener('change', function () {
      app.playSpeed = parseFloat(this.value);
    });
    $('chkSwept').addEventListener('change', function () {
      app.showSweptBoxes = this.checked; view.draw();
    });
    $('chkTrails').addEventListener('change', function () {
      app.showTrails = this.checked; view.draw();
    });

    // 场景选择
    $('sceneSelect').addEventListener('change', function () {
      var idx = parseInt(this.value, 10);
      if (idx >= 0) {
        app.loadScene(SCL.BUILTIN_SCENES[idx], SCL.BUILTIN_SCENES[idx].name);
        view.fitToScene();
        self.render();
      }
    });

    $('btnAddBody').addEventListener('click', function () {
      var id = app.addBody();
      self.render();
      self.openEditor(id);
    });

    // 文件导入
    $('fileScene').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          app.loadScene(data, file.name.replace(/\.json$/i, ''));
          view.fitToScene();
          self.flash('场景已导入：' + file.name, false);
        } catch (err) {
          self.flash('场景导入失败：' + err.message, true);
        }
        self.render();
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    $('fileResult').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = app.importResult(reader.result);
          self.flash('检测结果已导入：' + data.contacts.length + ' 条', false);
        } catch (err) {
          self.flash('结果导入失败：' + err.message, true);
        }
        self.render();
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('btnExportScene').addEventListener('click', function () {
      self.download('scene.json', app.exportScene());
    });
    $('btnExportResult').addEventListener('click', function () {
      self.download('contacts.json', app.exportResult());
    });

    // 编辑器事件委托
    $('editorPanel').addEventListener('click', function (e) {
      var action = e.target.getAttribute('data-action');
      var id = e.target.getAttribute('data-body');
      if (action === 'edit' && id) self.openEditor(id);
      if (action === 'delete' && id) {
        app.removeBody(id);
        if ($('editorBodyId').value === id) $('editorPanel').hidden = true;
        self.render();
      }
      if (action === 'closeEditor') { $('editorPanel').hidden = true; }
    });
    $('editorForm').addEventListener('submit', function (e) {
      e.preventDefault();
      self.applyEditor();
    });

    // 接触列表与对照面板的事件委托
    $('contactList').addEventListener('click', function (e) {
      var row = e.target.closest('[data-pair]');
      if (!row) return;
      var pair = row.getAttribute('data-pair').split('|');
      app.selectedPair = pair;
      self.render();
    });
    $('comparePanel').addEventListener('click', function (e) {
      var row = e.target.closest('[data-pair]');
      if (!row) return;
      app.selectedPair = row.getAttribute('data-pair').split('|');
      self.render();
    });

    view.onPickBody = function (id) {
      // 点物体：若已有一个选中物体则组成对，否则只高亮
      var rec = self._findContactWith(id);
      if (rec) {
        app.selectedPair = [rec.a, rec.b];
      } else {
        self.openEditor(id);
      }
      self.render();
    };
  };

  UI.prototype._findContactWith = function (id) {
    if (!this.app.pipeline) return null;
    return this.app.pipeline.referenceContacts.find(function (r) {
      return r.a === id || r.b === id;
    }) || null;
  };

  UI.prototype.flash = function (msg, isError) {
    var el = $('flash');
    el.textContent = msg;
    el.className = isError ? 'flash error' : 'flash ok';
    el.hidden = false;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(function () { el.hidden = true; }, 3200);
  };

  UI.prototype.download = function (name, text) {
    // artifact 环境中 <a download> 可能失效，同时提供复制兜底
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      this.flash('已生成 ' + name + '（若浏览器未下载，可从复制框取走）', false);
    } catch (e) {
      this.flash('下载被环境拦截，请使用复制按钮', true);
    }
    var ta = $('exportBuffer');
    ta.value = text;
    ta.hidden = false;
  };

  UI.prototype.render = function () {
    this._renderTimeline();
    this._renderStatus();
    this._renderContactList();
    this._renderAxes();
    this._renderCompare();
    this._renderBodyList();
    this.view.draw();
    if (this.app.selectedPair) {
      var card = document.getElementById('axesCard');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  UI.prototype._renderTimeline = function () {
    var app = this.app;
    $('timeInput').value = fmt(app.time, 6);
    $('timeInput').max = app.scene.dt;
    $('timeInput').step = (app.scene.dt / 1000).toString();
    var slider = $('timeSlider');
    slider.min = 0;
    slider.max = app.scene.dt;
    slider.step = app.scene.dt / 1000;
    slider.value = app.time;
    $('btnPlay').textContent = app.playing ? '暂停' : '播放';
    $('dtLabel').textContent = 'dt = ' + fmt(app.scene.dt, 4) + ' s';
  };

  UI.prototype._renderStatus = function () {
    var app = this.app, v = app.validation;
    var el = $('statusBar');
    if (!v.ok) {
      el.className = 'status error';
      el.innerHTML = '场景校验未通过：' +
        v.errors.map(function (e) {
          return esc(e.bodyId ? e.bodyId + '：' + e.message : e.message);
        }).join('；');
      return;
    }
    var p = app.pipeline;
    el.className = 'status ok';
    el.innerHTML = '物体 <b>' + app.scene.bodies.length + '</b> · 合格对 <b>' +
      p.eligiblePairs.length + '</b> · 宽阶段候选 <b>' + p.broadPairs.length +
      '</b> · 接触 <b>' + p.referenceContacts.length + '</b> · 漏报 <b class="' +
      (p.falseNegatives.length ? 'bad' : 'good') + '">' + p.falseNegatives.length +
      '</b> · 宽阶段多报 <b>' + p.broadOnly.length + '</b>';
  };

  UI.prototype._renderContactList = function () {
    var app = this.app, wrap = $('contactList');
    if (!app.pipeline) { wrap.innerHTML = '<div class="empty">场景无效，无接触数据</div>'; return; }
    var recs = app.pipeline.referenceContacts;
    if (!recs.length) { wrap.innerHTML = '<div class="empty">本帧无接触记录</div>'; return; }
    var t = app.time;
    wrap.innerHTML = recs.map(function (r) {
      var active = t >= r.tEnter - 1e-9 && t <= r.tExit + 1e-9;
      var sel = app.selectedPair && r.a === app.selectedPair[0] && r.b === app.selectedPair[1];
      var cls = 'contact-row' + (active ? ' active' : '') + (sel ? ' selected' : '');
      return '<div class="' + cls + '" data-pair="' + esc(r.a) + '|' + esc(r.b) + '">' +
        '<div class="pair-head">' +
        '<span class="pair-name">' + esc(r.a) + ' ⇄ ' + esc(r.b) + '</span>' +
        (r.sensor ? '<span class="pill sensor-pill">传感器</span>' : '') +
        (r.startOverlap ? '<span class="pill overlap-pill">初始重叠</span>' : '') +
        (active ? '<span class="pill now-pill">接触中</span>' : '') +
        '</div>' +
        '<div class="pair-times">t∈[' + fmt(r.tEnter) + ', ' + fmt(r.tExit) + '] s ' +
        'n=(' + fmt(r.normal[0]) + ', ' + fmt(r.normal[1]) + ')</div>' +
        '</div>';
    }).join('');
  };

  UI.prototype._renderAxes = function () {
    var app = this.app, wrap = $('axesPanel');
    var rec = app.selectedRecord();
    if (!rec) {
      wrap.innerHTML = '<div class="empty">点选一对接触物体，查看逐轴投影区间与限制接触的轴</div>';
      return;
    }
    var bA = app.bodyById(rec.a), bB = app.bodyById(rec.b);
    var html = '<div class="axes-head">' +
      '<h3>' + esc(rec.a) + ' ⇄ ' + esc(rec.b) + '</h3>' +
      '<div class="kv"><span>接触区间</span><b>[' + fmt(rec.tEnter, 6) + ', ' +
      fmt(rec.tExit, 6) + '] s</b></div>' +
      '<div class="kv"><span>初始重叠</span><b>' + rec.startOverlap + '</b></div>' +
      '<div class="kv"><span>进入法线</span><b>(' + fmt(rec.normal[0], 6) + ', ' +
      fmt(rec.normal[1], 6) + ')</b></div>' +
      '<div class="kv"><span>传感器</span><b>' + rec.sensor + '</b></div>' +
      '</div>';

    // 投影条的统一量程
    var allVals = [];
    rec._axes.forEach(function (ax) {
      allVals.push(ax.projA0[0], ax.projA0[1], ax.projB0[0], ax.projB0[1]);
    });
    var vmin = Math.min.apply(null, allVals), vmax = Math.max.apply(null, allVals);
    var span = Math.max(vmax - vmin, 1e-9);
    vmin -= span * 0.08; vmax += span * 0.08;

    html += '<div class="axis-list">' + rec._axes.map(function (ax, idx) {
      var pr = engine.projectionAt(bA, bB, ax.u, app.time);
      var bar = this._projectionBar(ax, pr, vmin, vmax, idx === rec._enterAxis,
        idx === rec._exitAxis);
      var role = [];
      if (idx === rec._enterAxis) role.push('<span class="pill enter-pill">进入限制</span>');
      if (idx === rec._exitAxis) role.push('<span class="pill exit-pill">离开限制</span>');
      return '<div class="axis-row">' +
        '<div class="axis-meta"><span class="axis-name">#' + idx + ' ' + esc(ax.owner) +
        '·边' + ax.edge + '</span>' +
        '<span class="axis-u">u=(' + fmt(ax.u[0]) + ',' + fmt(ax.u[1]) + ')</span>' +
        role.join('') + '</div>' +
        bar +
        '<div class="axis-nums">t=0 深度 ' + fmt(ax.depth0) +
        ' · 相对速度投影 ' + fmt(ax.slope) +
        ' · 轴区间 [' + fmt(ax.lo) + ', ' + fmt(ax.hi) + ']</div>' +
        '</div>';
    }, this).join('') + '</div>';
    wrap.innerHTML = html;
  };

  UI.prototype._projectionBar = function (ax, pr, vmin, vmax, isEnter, isExit) {
    function pct(v) { return ((v - vmin) / (vmax - vmin)) * 100; }
    var a0 = pct(pr.a[0]), a1 = pct(pr.a[1]), b0 = pct(pr.b[0]), b1 = pct(pr.b[1]);
    var overlap = !(pr.b[0] > pr.a[1] || pr.b[1] < pr.a[0]);
    return '<div class="proj-bar' + (isEnter ? ' enter' : '') + (isExit ? ' exit' : '') +
      (overlap ? ' overlapping' : '') + '">' +
      '<div class="track">' +
      '<div class="seg seg-a" style="left:' + a0 + '%;width:' + Math.max(a1 - a0, 1.2) + '%"></div>' +
      '<div class="seg seg-b" style="left:' + b0 + '%;width:' + Math.max(b1 - b0, 1.2) + '%"></div>' +
      '</div>' +
      '<div class="proj-labels"><span>A [' + fmt(pr.a[0]) + ', ' + fmt(pr.a[1]) + ']</span>' +
      '<span>B [' + fmt(pr.b[0]) + ', ' + fmt(pr.b[1]) + ']</span>' +
      '<span class="' + (overlap ? 'good' : 'bad') + '">' + (overlap ? '重叠' : '分离') + '</span></div>' +
      '</div>';
  };

  UI.prototype._renderCompare = function () {
    var app = this.app, wrap = $('comparePanel');
    if (!app.pipeline) { wrap.innerHTML = ''; return; }
    var p = app.pipeline;
    var refMap = {};
    p.referenceContacts.forEach(function (r) { refMap[r.a + '|' + r.b] = r; });
    var broadMap = {};
    p.broadPairs.forEach(function (pair) { broadMap[pair[0] + '|' + pair[1]] = true; });

    var html = '<div class="compare-summary">' +
      '<div class="cmp-item"><span>全量精测（基准）</span><b>' + p.referenceContacts.length + '</b></div>' +
      '<div class="cmp-item"><span>宽阶段+精测</span><b>' + p.contacts.length + '</b></div>' +
      '<div class="cmp-item ' + (p.falseNegatives.length ? 'bad' : 'good') +
      '"><span>漏报（宽阶段漏掉）</span><b>' + p.falseNegatives.length + '</b></div>' +
      '<div class="cmp-item"><span>多报（候选但无接触）</span><b>' + p.broadOnly.length + '</b></div>' +
      '</div>';

    // 宽阶段多报列表
    if (p.broadOnly.length) {
      html += '<h4>宽阶段多报对（' + p.broadOnly.length + '）</h4><div class="cmp-list">';
      html += p.broadOnly.map(function (pair) {
        return '<div class="cmp-row warn-row" data-pair="' + esc(pair[0]) + '|' + esc(pair[1]) +
          '">' + esc(pair[0]) + ' ⇄ ' + esc(pair[1]) + ' <span class="tag">AABB 相交但 SAT 分离</span></div>';
      }).join('');
      html += '</div>';
    }
    if (p.falseNegatives.length) {
      html += '<h4>漏报对（' + p.falseNegatives.length + '）</h4><div class="cmp-list">';
      html += p.falseNegatives.map(function (pair) {
        return '<div class="cmp-row bad-row" data-pair="' + esc(pair[0]) + '|' + esc(pair[1]) +
          '">' + esc(pair[0]) + ' ⇄ ' + esc(pair[1]) + ' <span class="tag">宽阶段未报但真实接触</span></div>';
      }).join('');
      html += '</div>';
    }

    // 导入结果差异
    var diff = app.diffImported();
    if (diff) {
      html += '<h4>导入结果对照</h4><div class="cmp-list">';
      if (!diff.missing.length && !diff.extra.length && !diff.changed.length) {
        html += '<div class="cmp-row good-row">与导入结果完全一致 ✓</div>';
      } else {
        diff.missing.forEach(function (k) {
          html += '<div class="cmp-row bad-row" data-pair="' + esc(k) + '">' + esc(k) +
            ' <span class="tag">导入有、本台无（多报）</span></div>';
        });
        diff.extra.forEach(function (k) {
          html += '<div class="cmp-row bad-row" data-pair="' + esc(k) + '">' + esc(k) +
            ' <span class="tag">本台有、导入无（漏报）</span></div>';
        });
        diff.changed.forEach(function (k) {
          html += '<div class="cmp-row warn-row" data-pair="' + esc(k) + '">' + esc(k) +
            ' <span class="tag">字段值不一致</span></div>';
        });
      }
      html += '</div>';
    }

    // 全量精测清单（可折叠）
    html += '<details class="all-pairs"><summary>全量精测接触清单（' +
      p.referenceContacts.length + '）</summary><div class="cmp-list">';
    html += p.referenceContacts.map(function (r) {
      var inBroad = !!broadMap[r.a + '|' + r.b];
      var sel = app.selectedPair && r.a === app.selectedPair[0] && r.b === app.selectedPair[1];
      return '<div class="cmp-row' + (sel ? ' selected' : '') + '" data-pair="' +
        esc(r.a) + '|' + esc(r.b) + '">' + esc(r.a) + ' ⇄ ' + esc(r.b) +
        ' <span class="tag ' + (inBroad ? 'good' : 'bad') + '">' +
        (inBroad ? '宽阶段命中' : '宽阶段漏报') + '</span></div>';
    }).join('');
    html += '</div></details>';
    wrap.innerHTML = html;
  };

  UI.prototype._renderBodyList = function () {
    var app = this.app, wrap = $('bodyList');
    wrap.innerHTML = app.scene.bodies.map(function (b) {
      var inSel = app.selectedPair && app.selectedPair.indexOf(b.id) >= 0;
      return '<div class="body-row' + (inSel ? ' selected' : '') + '">' +
        '<span class="body-id">' + esc(b.id) + '</span>' +
        (b.sensor ? '<span class="pill sensor-pill">传感器</span>' : '') +
        '<span class="body-meta">L' + b.layer + ' M' + b.mask + ' · ' +
        b.vertices.length + ' 顶点</span>' +
        '<span class="body-actions">' +
        '<button data-action="edit" data-body="' + esc(b.id) + '">编辑</button>' +
        '<button data-action="delete" data-body="' + esc(b.id) + '" class="danger">删除</button>' +
        '</span></div>';
    }).join('');
  };

  UI.prototype.openEditor = function (id) {
    var b = this.app.bodyById(id);
    if (!b) return;
    $('editorPanel').hidden = false;
    $('editorBodyId').value = b.id;
    $('edId').value = b.id;
    $('edPosX').value = b.position[0];
    $('edPosY').value = b.position[1];
    $('edVelX').value = b.velocity[0];
    $('edVelY').value = b.velocity[1];
    $('edLayer').value = b.layer;
    $('edMask').value = b.mask;
    $('edSensor').checked = b.sensor;
    $('edVerts').value = b.vertices.map(function (v) { return v[0] + ',' + v[1]; }).join('\n');
  };

  UI.prototype.applyEditor = function () {
    var app = this.app;
    var origId = $('editorBodyId').value;
    var b = app.bodyById(origId);
    if (!b) return;
    var newId = $('edId').value.trim();
    if (!newId) { this.flash('id 不能为空', true); return; }
    if (newId !== origId && app.bodyById(newId)) {
      this.flash('id ' + newId + ' 已存在', true); return;
    }
    var vertLines = $('edVerts').value.trim().split(/\s*\n\s*/);
    var verts;
    try {
      verts = vertLines.map(function (line) {
        var parts = line.split(/[,\s]+/).filter(Boolean).map(Number);
        if (parts.length !== 2 || parts.some(function (x) { return !isFinite(x); })) {
          throw new Error('顶点格式错误：' + line);
        }
        return parts;
      });
    } catch (e) { this.flash(e.message, true); return; }

    var draft = {
      id: newId,
      position: [parseFloat($('edPosX').value), parseFloat($('edPosY').value)],
      velocity: [parseFloat($('edVelX').value), parseFloat($('edVelY').value)],
      vertices: verts,
      layer: parseInt($('edLayer').value, 10),
      mask: parseInt($('edMask').value, 10),
      sensor: $('edSensor').checked
    };
    app.mutate(function (scene) {
      var idx = scene.bodies.findIndex(function (x) { return x.id === origId; });
      scene.bodies[idx] = draft;
    });
    if (app.selectedPair) {
      app.selectedPair = app.selectedPair.map(function (x) {
        return x === origId ? newId : x;
      });
    }
    this.flash('物体 ' + newId + ' 已更新', false);
    this.render();
  };

  SCL.UI = UI;
})();
