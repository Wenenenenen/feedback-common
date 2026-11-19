/* Canvas 场景渲染：世界坐标变换、物体/扫掠盒/轨迹/接触绘制、拾取 */
(function () {
  'use strict';
  var engine = SCL.engine;
  var broad = SCL.broadphase;

  function SceneView(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.scale = 40;       // 像素/世界单位
    this.centerX = 0;      // 视图中心（世界坐标）
    this.centerY = 0;
    this.hoverId = null;
    this._bind();
    this.fitToScene();
  }

  SceneView.prototype._bind = function () {
    var self = this;
    var dragging = false, lastX = 0, lastY = 0, moved = false;
    this.canvas.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      lastX = e.clientX; lastY = e.clientY;
      self.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', function (e) {
      var rect = self.canvas.getBoundingClientRect();
      if (dragging) {
        var dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        self.centerX -= dx / self.scale;
        self.centerY += dy / self.scale;
        lastX = e.clientX; lastY = e.clientY;
        self.draw();
      } else {
        var wp = self.toWorld(e.clientX - rect.left, e.clientY - rect.top);
        self.hoverId = self.pick(wp);
        self.draw();
      }
    });
    this.canvas.addEventListener('pointerup', function (e) {
      if (dragging && !moved) {
        var rect = self.canvas.getBoundingClientRect();
        var wp = self.toWorld(e.clientX - rect.left, e.clientY - rect.top);
        var id = self.pick(wp);
        if (id) self.onPickBody && self.onPickBody(id);
      }
      dragging = false;
    });
    this.canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      self.scale = Math.max(4, Math.min(400, self.scale * factor));
      self.draw();
    }, { passive: false });
  };

  SceneView.prototype.fitToScene = function () {
    var app = this.app;
    if (!app.scene.bodies.length) { this.scale = 40; this.centerX = 0; this.centerY = 0; return; }
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    app.scene.bodies.forEach(function (b) {
      var box = broad.sweptAABB(b, app.scene.dt);
      minX = Math.min(minX, box.minX); maxX = Math.max(maxX, box.maxX);
      minY = Math.min(minY, box.minY); maxY = Math.max(maxY, box.maxY);
    });
    var w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 500;
    var spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
    this.scale = Math.min((w - 80) / spanX, (h - 80) / spanY);
    this.scale = Math.max(4, Math.min(400, this.scale));
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
  };

  SceneView.prototype.toScreen = function (x, y) {
    var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [w / 2 + (x - this.centerX) * this.scale,
            h / 2 - (y - this.centerY) * this.scale];
  };

  SceneView.prototype.toWorld = function (sx, sy) {
    var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [this.centerX + (sx - w / 2) / this.scale,
            this.centerY - (sy - h / 2) / this.scale];
  };

  SceneView.prototype.pick = function (wp) {
    var app = this.app;
    // 逆序拾取（后画的在上）
    for (var i = app.scene.bodies.length - 1; i >= 0; i--) {
      var b = app.scene.bodies[i];
      var verts = engine.worldVertsAt(b, app.time);
      if (pointInPoly(wp, verts)) return b.id;
    }
    return null;
  };

  function pointInPoly(p, vs) {
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      var xi = vs[i][0], yi = vs[i][1], xj = vs[j][0], yj = vs[j][1];
      if (((yi > p[1]) !== (yj > p[1])) &&
          (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  SceneView.prototype.draw = function () {
    var ctx = this.ctx, app = this.app;
    var dpr = window.devicePixelRatio || 1;
    var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var styles = getComputedStyle(document.documentElement);
    var c = function (name) { return styles.getPropertyValue(name).trim(); };
    var bg = c('--canvas-bg'), grid = c('--grid'), fg = c('--fg');
    var accent = c('--accent'), warn = c('--warn'), sensor = c('--sensor');
    var bodyStroke = c('--body-stroke'), bodyFill = c('--body-fill');
    var sweptCol = c('--swept'), trailCol = c('--trail'), contactCol = c('--contact');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    this._drawGrid(ctx, w, h, grid);

    var selected = app.selectedPair;
    var activePairIds = {};
    if (selected) { activePairIds[selected[0]] = true; activePairIds[selected[1]] = true; }

    // 扫掠 AABB
    if (app.showSweptBoxes && app.validation.ok) {
      app.scene.bodies.forEach(function (b) {
        var box = broad.sweptAABB(b, app.scene.dt);
        var p0 = this.toScreen(box.minX, box.maxY);
        var p1 = this.toScreen(box.maxX, box.minY);
        ctx.save();
        ctx.strokeStyle = sweptCol;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
        ctx.restore();
      }, this);
    }

    // 轨迹（t=0 → dt 的质心线）
    if (app.showTrails) {
      app.scene.bodies.forEach(function (b) {
        var c0 = engine.bodyCenter(b);
        var c1 = [c0[0] + b.velocity[0] * app.scene.dt,
                  c0[1] + b.velocity[1] * app.scene.dt];
        var s0 = this.toScreen(c0[0], c0[1]), s1 = this.toScreen(c1[0], c1[1]);
        ctx.save();
        ctx.strokeStyle = trailCol;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(s0[0], s0[1]);
        ctx.lineTo(s1[0], s1[1]);
        // 终点箭头
        var ang = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]);
        if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) > 6) {
          ctx.moveTo(s1[0], s1[1]);
          ctx.lineTo(s1[0] - 7 * Math.cos(ang - 0.4), s1[1] - 7 * Math.sin(ang - 0.4));
          ctx.moveTo(s1[0], s1[1]);
          ctx.lineTo(s1[0] - 7 * Math.cos(ang + 0.4), s1[1] - 7 * Math.sin(ang + 0.4));
        }
        ctx.stroke();
        ctx.restore();
      }, this);
    }

    // 当前时刻的接触区间标记（接触中的对高亮）
    if (app.pipeline) {
      app.pipeline.referenceContacts.forEach(function (r) {
        var inContact = app.time >= r.tEnter - 1e-9 && app.time <= r.tExit + 1e-9;
        var isSel = selected && r.a === selected[0] && r.b === selected[1];
        if (!inContact && !isSel) return;
        var bA = app.bodyById(r.a), bB = app.bodyById(r.b);
        var cA = engine.bodyCenter(bA), cB = engine.bodyCenter(bB);
        var pA = this.toScreen(cA[0] + bA.velocity[0] * app.time, cA[1] + bA.velocity[1] * app.time);
        var pB = this.toScreen(cB[0] + bB.velocity[0] * app.time, cB[1] + bB.velocity[1] * app.time);
        ctx.save();
        ctx.strokeStyle = isSel ? accent : (r.sensor ? sensor : contactCol);
        ctx.lineWidth = isSel ? 2.2 : 1.4;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(pA[0], pA[1]);
        ctx.lineTo(pB[0], pB[1]);
        ctx.stroke();
        ctx.restore();
      }, this);
    }

    // 物体
    var self = this;
    app.scene.bodies.forEach(function (b) {
      var verts = engine.worldVertsAt(b, app.time);
      var pts = verts.map(function (v) { return self.toScreen(v[0], v[1]); });
      var isSelected = activePairIds[b.id];
      var isHover = self.hoverId === b.id;
      ctx.save();
      ctx.beginPath();
      pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath();
      ctx.fillStyle = b.sensor ? sensor : (isSelected ? accent : bodyFill);
      ctx.globalAlpha = b.sensor ? 0.3 : (isSelected ? 0.45 : 0.3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = b.sensor ? sensor : (isSelected ? accent : (isHover ? warn : bodyStroke));
      ctx.lineWidth = isSelected ? 2.4 : (isHover ? 2 : 1.4);
      if (b.sensor) ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // id 标签
      var ctr = engine.bodyCenter(b);
      var lab = this.toScreen(
        ctr[0] + b.velocity[0] * app.time,
        ctr[1] + b.velocity[1] * app.time);
      ctx.fillStyle = fg;
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.id, lab[0], lab[1]);
      ctx.restore();
    }, this);

    // 选中对的进入法线（在 A 中心处绘制）
    var rec = app.selectedRecord();
    if (rec) {
      var bA = app.bodyById(rec.a);
      var cA = engine.bodyCenter(bA);
      var base = this.toScreen(cA[0] + bA.velocity[0] * app.time,
                                cA[1] + bA.velocity[1] * app.time);
      var nLen = 1.4;
      var tip = this.toScreen(
        cA[0] + bA.velocity[0] * app.time + rec.normal[0] * nLen,
        cA[1] + bA.velocity[1] * app.time + rec.normal[1] * nLen);
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.stroke();
      var ang = Math.atan2(tip[1] - base[1], tip[0] - base[0]);
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(tip[0] - 9 * Math.cos(ang - 0.4), tip[1] - 9 * Math.sin(ang - 0.4));
      ctx.lineTo(tip[0] - 9 * Math.cos(ang + 0.4), tip[1] - 9 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  };

  SceneView.prototype._drawGrid = function (ctx, w, h, color) {
    var step = this.scale; // 每世界单位像素
    if (step < 12) step = step * Math.ceil(12 / step);
    var ox = (w / 2 - this.centerX * this.scale) % step;
    var oy = (h / 2 + this.centerY * this.scale) % step;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = ox; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (var y = oy; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // 世界原点轴线
    var zero = this.toScreen(0, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, zero[1]); ctx.lineTo(w, zero[1]);
    ctx.moveTo(zero[0], 0); ctx.lineTo(zero[0], h);
    ctx.stroke();
    ctx.restore();
  };

  SCL.SceneView = SceneView;
})();
